import {
	createPublicationWebhookPlatform,
	createFetchPublicationWebhookTransport,
} from "./publication-webhook";
import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	publicationInputEnvelopeSchema,
	publicationInputPayloadSchema,
} from "@narriflow/validators/publication-input";
import {
	publicationEphemeralSchema,
	publicationNativeReplySchema,
	publicationNativeCommandSchema,
	type PublicationNativeCommand,
	type PublicationEphemeral,
	type PublicationNativeReply,
} from "@narriflow/validators/publication-execution";
import { openPublicationPayload } from "@narriflow/services/publication-checkpoint-blob";
import {
	createSocialPublicationAttempt,
	PublicationClaimLostError,
	PublicationProviderCallBudgetError,
	type LoadedPublicationAttempt,
	type SocialPublicationAttemptStore,
	type PublicationAttemptExecutionResult,
} from "@narriflow/services/social-publication-driver";
import type { PublicationProviderOperation } from "@narriflow/services/social-publication-platform";
import { createNativePublicationPlatformRegistry } from "./publication-platforms";
import { createPublicationCheckpointCodec } from "./publication-checkpoint-codec";
import { createPublicationProviderTransport } from "./publication-provider-transport";
export interface PublicationLocalControl {
	command(value: PublicationNativeCommand): Promise<unknown>;
	instructions(value: {
		path: string;
		byteLength: number;
		sha256: string;
	}): Promise<{ artifactId: string }>;
}
function hydrate(
	value: ReturnType<typeof publicationInputPayloadSchema.parse>,
	operation: PublicationProviderOperation | null,
): LoadedPublicationAttempt {
	const loaded = value.loaded;
	return {
		...loaded,
		socialPost: {
			...loaded.socialPost,
			scheduledFor: new Date(loaded.socialPost.scheduledFor),
			nextAttemptAt: loaded.socialPost.nextAttemptAt
				? new Date(loaded.socialPost.nextAttemptAt)
				: null,
		},
		frozen: {
			...loaded.frozen,
			scheduledFor: new Date(loaded.frozen.scheduledFor),
		},
		attempt: {
			...loaded.attempt,
			nextActionAt: new Date(loaded.attempt.nextActionAt),
			startedAt: new Date(loaded.attempt.startedAt),
			phaseStartedAt: loaded.attempt.phaseStartedAt
				? new Date(loaded.attempt.phaseStartedAt)
				: undefined,
			processingDeadline: new Date(loaded.attempt.processingDeadline),
			reconciliationDeadline: new Date(loaded.attempt.reconciliationDeadline),
		},
		claim: {
			...loaded.claim,
			leaseExpiresAt: new Date(loaded.claim.leaseExpiresAt),
			heartbeatAt: new Date(loaded.claim.heartbeatAt),
		},
		sealedCheckpoint: operation ? JSON.stringify(operation.state) : null,
		checkpointKind: operation?.kind ?? null,
	};
}
function result(
	reply: PublicationNativeReply,
): PublicationAttemptExecutionResult {
	if (reply.kind !== "settled") throw new PublicationClaimLostError();
	const identity = {
		attemptId: reply.attemptId,
		socialPostId: reply.socialPostId,
	};
	if (reply.outcome === "posted" || reply.outcome === "inbox_delivered")
		return { ...identity, kind: reply.outcome, externalUrl: null };
	if (reply.outcome === "processing" || reply.outcome === "reconciling")
		return {
			...identity,
			kind: reply.outcome,
			nextActionAt: new Date(reply.nextActionAt!),
		};
	if (reply.outcome === "retry_scheduled")
		return {
			...identity,
			kind: reply.outcome,
			nextAttemptId: reply.nextAttemptId!,
			nextActionAt: new Date(reply.nextActionAt!),
		};
	if (reply.outcome === "interrupted")
		return { ...identity, kind: reply.outcome };
	return {
		...identity,
		kind: reply.outcome,
		code: reply.code ?? "publication_unconfirmed",
	};
}
/** Sole native publication entry. It has no SQL, account-refresh, coordinator
 * loop, master signing/encryption key or authority fallback. */
export async function executePublication(options: {
	envelope: unknown;
	context: PublicationEphemeral;
	work: string;
	mediaPath: string;
	thumbnailPath?: string;
	priorInstructionsPath?: string;
	control: PublicationLocalControl;
	signal: AbortSignal;
	providerFetch?: typeof fetch;
}) {
	const envelope = publicationInputEnvelopeSchema.parse(options.envelope),
		access = publicationEphemeralSchema.parse(options.context);
	if (
		JSON.stringify(envelope.scope) !== JSON.stringify(access.inputKey.scope) ||
		JSON.stringify(access.inputKey.scope) !==
			JSON.stringify(access.checkpointKey.scope)
	)
		throw Error("publication_input_scope_invalid");
	const ciphertext = Buffer.from(envelope.payload, "base64url");
	if (ciphertext.toString("base64url") !== envelope.payload)
		throw Error("publication_input_invalid");
	const payload = publicationInputPayloadSchema.parse(
		await openPublicationPayload(
			ciphertext,
			access.inputKey.key,
			envelope.scope,
			"input_state",
		),
	);
	if (
		payload.loaded.socialPost.id !== envelope.scope.socialPostId ||
		payload.loaded.attempt.id !== envelope.scope.attemptId ||
		payload.loaded.claim.id !== envelope.scope.claimId ||
		payload.loaded.frozen.socialAccountId !== (access.account?.id ?? null) ||
		(access.account &&
			access.account.platform !== payload.loaded.frozen.platform)
	)
		throw Error("publication_input_scope_invalid");
	let instructionSequence = 0;
	const codec = await createPublicationCheckpointCodec({
		context: access,
		totalBytes: payload.loaded.frozen.sizeBytes!,
		operation: payload.operation,
		priorInstructions: options.priorInstructionsPath
			? await readFile(options.priorInstructionsPath)
			: undefined,
		upload: async (bytes) => {
			const path = join(
				options.work,
				`publication-instructions-${instructionSequence++}.bin`,
			);
			await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
			const proof = await options.control.instructions({
				path,
				byteLength: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			});
			return proof.artifactId;
		},
	});
	const loaded = hydrate(payload, codec.initial);
	const command = async (value: unknown) => {
		const request = publicationNativeCommandSchema.parse(value);
		const reply = (await options.control.command(request)) as {
			disposition?: unknown;
			result?: unknown;
		};
		if (reply?.disposition !== "publication_recorded")
			throw new PublicationClaimLostError();
		return publicationNativeReplySchema.parse(reply.result);
	};
	const transport = createPublicationProviderTransport({
		platform: loaded.frozen.platform,
		command,
		fetch: options.providerFetch,
	});
	let webhookStatus: number | null = null;
	const providerRejected = () => {
		const status = loaded.frozen.socialAccountId
			? transport.lastStatus
			: webhookStatus;
		return status !== null && status >= 400 && status < 500;
	};
	let localCalls = loaded.attempt.providerCallCount;
	const operation = (
		kind: string,
		state: string,
	): PublicationProviderOperation => ({ kind, state: JSON.parse(state) });
	const store: SocialPublicationAttemptStore = {
		loadOwned: async () => loaded,
		recordProviderCall: async (input) => {
			if (++localCalls > input.maximum)
				throw new PublicationProviderCallBudgetError();
		},
		checkpoint: async (input) => {
			const op = await codec.encode(
				operation(input.operationKind, input.sealedState),
			);
			const reply = await command({
				kind: "checkpoint",
				operation: op,
				operationLookupHash: input.operationLookupHash,
			});
			if (reply.kind !== "recorded") throw new PublicationClaimLostError();
		},
		settleAccepted: async (input) =>
			result(
				await command({ kind: "accepted", receipt: input.result.receipt }),
			),
		settlePending: async (input) =>
			result(
				await command({
					...input.result,
					kind: "pending",
					operation: await codec.encode(input.result.operation),
					nextCheckAt: input.result.nextCheckAt.toISOString(),
				}),
			),
		settleUnknown: async (input) =>
			result(
				await command({
					kind: "unknown",
					code: input.code,
					operation: input.operation
						? await codec.encode(input.operation)
						: null,
					retryAfterMs: input.nextActionAt
						? Math.max(0, input.nextActionAt.getTime() - Date.now())
						: null,
				}),
			),
		settleFailed: async (input) =>
			result(
				await command({
					kind: "failed",
					failure: {
						code: input.code,
						phase: input.phase,
						disposition: input.disposition,
						retryAfterMs: input.retryAfterMs,
						...(input.failureEvidence
							? {
									evidence:
										input.failureEvidence as PublicationProviderOperation["state"],
								}
							: {}),
						safeToRepublishAfterSubmission:
							input.definitiveNonPublication === true ||
							(!input.submissionMayHaveStarted && providerRejected()),
					},
				}),
			),
		releaseInterrupted: async () =>
			result(await command({ kind: "interrupted" })),
	};
	const media = async (
		path: string,
		fileName: string,
		expected: number,
		contentType: string,
	) => {
		if ((await stat(path)).size !== expected)
			throw Error("publication_source_changed");
		return {
			fileName,
			sizeBytes: expected,
			contentType,
			blob: async (start = 0, end = expected) =>
				(
					globalThis as unknown as { Bun: { file(path: string): Blob } }
				).Bun.file(path).slice(start, end, contentType),
			cleanup: async () => {
				await rm(path, { force: true });
			},
		};
	};
	const platforms = createNativePublicationPlatformRegistry({
		fetch: transport.fetch,
		media: {
			materialize: (input) =>
				media(
					options.mediaPath,
					input.fileName,
					input.sizeBytes,
					input.contentType,
				),
			createScopedAccess: async () => {
				if (!access.media) throw Error("publication_provider_grant_missing");
				return access.media.url;
			},
		},
		thumbnails: {
			materialize: async (input) => {
				if (!options.thumbnailPath || !access.thumbnail)
					throw Error("publication_thumbnail_missing");
				const type = access.thumbnail.contentType,
					extension =
						type === "image/png"
							? "png"
							: type === "image/webp"
								? "webp"
								: "jpg";
				return media(
					options.thumbnailPath,
					`${input.assetId}.${extension}`,
					(await stat(options.thumbnailPath)).size,
					type,
				);
			},
			createScopedAccess: async () => {
				if (!access.thumbnail)
					throw Error("publication_provider_grant_missing");
				return access.thumbnail.url;
			},
		},
		clock: { now: () => new Date() },
		config: payload.config,
	});
	const webhookAccess = access.webhook;
	const webhook = webhookAccess
		? createPublicationWebhookPlatform({
				config: {
					url: webhookAccess.receiverUrl,
					deadlineMs: webhookAccess.deadlineMs,
					maxResponseBytes: webhookAccess.maxResponseBytes,
					reconciliationMaxMs: webhookAccess.reconciliationMaxMs,
					redirectPolicy: "error",
				},
				sign: (body) => {
					if (
						createHash("sha256").update(body).digest("hex") !==
						webhookAccess.bodySha256
					)
						throw Error("publication_webhook_body_changed");
					return webhookAccess.signature;
				},
				media: {
					createScopedAccess: async () => {
						if (!access.media)
							throw Error("publication_provider_grant_missing");
						return {
							url: access.media.url,
							expiresAt: new Date(access.media.expiresAt),
						};
					},
				},
				clock: { now: () => new Date() },
				transport: {
					send: async (request, context) => {
						const decision = await command({
							kind: "provider_call",
							operation: request.method === "POST" ? "submit" : "read",
							purpose: "primary_media",
						});
						if (decision.kind !== "recorded")
							throw new PublicationClaimLostError();
						webhookStatus = null;
						const response =
							await createFetchPublicationWebhookTransport().send(
								request,
								context,
							);
						webhookStatus = response.status;
						return response;
					},
				},
			})
		: null;
	const driver = createSocialPublicationAttempt({
		store,
		platforms: {
			get(platform, channel) {
				if (channel === "webhook") {
					if (!webhook) throw Error("publication_webhook_unconfigured");
					return webhook;
				}
				return platforms.get(platform);
			},
		},
		credentials: {
			load: async (accountId) =>
				access.account?.id === accountId ? access.account : null,
		},
		planEligibility: {
			refusal: async () => {
				await command({ kind: "preflight" });
				return null;
			},
		},
		checkpointCodec: { encode: JSON.stringify, decode: JSON.parse },
		clock: { now: () => new Date() },
		diagnostics: { record: (event) => console.warn(JSON.stringify(event)) },
		retry: { ...payload.retry, random: Math.random },
		providerCallBudget: payload.providerCallCeiling,
		processingDeadlineMs: Math.max(
			1,
			new Date(payload.loaded.attempt.processingDeadline).getTime() -
				Date.now(),
		),
		reconciliationDeadlineMs: Math.max(
			1,
			new Date(payload.loaded.attempt.reconciliationDeadline).getTime() -
				Date.now(),
		),
	});
	return driver.execute({
		attempt: { attemptId: loaded.attempt.id, claimId: loaded.claim!.id },
		signal: options.signal,
	});
}
