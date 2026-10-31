import { createHash, createHmac } from "node:crypto";
import { publicationWebhookBody } from "./publication-webhook-body";
import { renderArtifactBindingHash } from "./render-artifact";
import { getPrismaClient } from "@narriflow/db/client";
import {
	Prisma,
	type PrismaClient,
	type ExecutionArtifact,
} from "@prisma/client";
import {
	publicationInputPayloadSchema,
	publicationInputEnvelopeSchema,
} from "@narriflow/validators/publication-input";
import {
	publicationEphemeralSchema,
	type PublicationKeyScope,
} from "@narriflow/validators/publication-execution";
import {
	PublicationExecution,
	PublicationExecutionError,
	type PublicationInputSnapshot,
	type PublicationSource,
} from "./publication-execution";
import { publicationExecutionInputHash } from "./publication-dispatch";
import {
	derivePublicationPurposeKey,
	sealPublicationPayload,
} from "./publication-checkpoint-blob";
import { createPublicationCheckpointCipher } from "./social-publication-checkpoint-cipher";
import {
	isSocialProviderPublishingEnabled,
	parseSocialPublicationConfig,
} from "./social-publication-config";
import {
	hasCustomThumbnail,
	publicationPlanRefusal,
} from "./social-account-eligibility";
import { socialOAuthService } from "./social-oauth.service";
import { createPrivateJsonStorage } from "./private-json-storage";
import { readServiceEnvironment } from "./runtime-environment";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";

export function publicationKeyScope(
	snapshot: Pick<PublicationInputSnapshot, "post" | "attempt" | "claim">,
): PublicationKeyScope {
	return {
		deploymentEpoch: snapshot.post.deploymentEpoch,
		socialPostId: snapshot.post.id,
		attemptId: snapshot.attempt.id,
		claimId: snapshot.claim.id,
		bindingHash: publicationExecutionInputHash(snapshot.post),
	};
}

function source(artifact: ExecutionArtifact, name: string): PublicationSource {
	if (
		!artifact.committedAt ||
		!artifact.checksumSha256 ||
		!artifact.etag ||
		!artifact.byteLength ||
		artifact.byteLength > 10n * 1024n ** 3n
	)
		throw new PublicationExecutionError("publication_frozen_media_unsealed");
	return {
		name,
		storageKey: artifact.storageKey,
		etag: artifact.etag,
		byteLength: Number(artifact.byteLength),
		sha256: artifact.checksumSha256,
	};
}
/** This reads exact SQL-sealed artifacts. It never chooses a newer export or
 * trusts HEAD metadata as evidence for a former, unsealed media path. */
export async function publicationSources(
	database: PrismaClient,
	snapshot: PublicationInputSnapshot,
) {
	const frozen = snapshot.post.frozenState!;
	const media = frozen.storageKey
		? await database.executionArtifact.findUnique({
				where: { storageKey: frozen.storageKey },
				include: { attempt: { include: { dispatch: true } } },
			})
		: null;
	if (
		!media ||
		media.role !== "render_variant" ||
		media.contentType !== "video/mp4" ||
		media.byteLength !== frozen.sizeBytes
	)
		throw new PublicationExecutionError("publication_frozen_media_unsealed");
	const variant = await database.clipExportVariant.findUnique({
		where: { id: frozen.clipExportVariantId },
		include: { export: true, render: true },
	});
	if (
		!variant ||
		variant.exportId !== frozen.clipExportId ||
		variant.export.projectId !== snapshot.post.projectId ||
		variant.export.workspaceId !== snapshot.post.workspaceId ||
		variant.export.fingerprint !== frozen.exportFingerprint ||
		variant.export.editorRevision !== frozen.editorRevision ||
		variant.aspectRatio !== frozen.aspectRatio ||
		variant.status !== "completed" ||
		variant.storageKey !== frozen.storageKey ||
		variant.sizeBytes !== frozen.sizeBytes ||
		!variant.render ||
		variant.render.status !== "completed" ||
		variant.render.exportVariantId !== variant.id ||
		variant.render.storageKey !== frozen.storageKey ||
		media.attempt.dispatch.subjectKind !== "render_group" ||
		media.bindingHash !==
			(await renderArtifactBindingHash({
				inputHash: media.attempt.inputHash,
				renderId: variant.render.id,
				role: "render_variant",
			}))
	)
		throw new PublicationExecutionError("publication_frozen_media_unsealed");
	const sources = [source(media, "publication_media")];
	const settings = frozen.providerSettings as Prisma.JsonObject;
	if (settings.thumbnailType==="custom_image"&&typeof settings.thumbnailAssetId === "string") {
		const workspace = await database.workspace.findUniqueOrThrow({
			where: { id: snapshot.post.workspaceId! },
			select: { personalOwnerUserId: true },
		});
		const asset = await database.visualAsset.findFirst({
			where: {
				id: settings.thumbnailAssetId,
				fingerprint:
					typeof settings.thumbnailFingerprint === "string"
						? settings.thumbnailFingerprint
						: "",
				kind: "image",
				deletedAt: null,
				...(workspace.personalOwnerUserId
					? { userId: workspace.personalOwnerUserId, workspaceId: null }
					: { workspaceId: snapshot.post.workspaceId, userId: null }),
			},
		});
		const artifact = asset
			? await database.executionArtifact.findUnique({
					where: { storageKey: asset.storageKey },
				})
			: null;
		if (
			!asset ||
			!artifact ||
			!["validated_asset", "thumbnail"].includes(artifact.role) ||
			artifact.byteLength !== asset.sizeBytes ||
			artifact.contentType !== asset.contentType
		)
			throw new PublicationExecutionError("publication_thumbnail_unsealed");
		sources.push(source(artifact, "publication_thumbnail"));
	}
	return sources;
}
export function createPublicationInputBuilder(
	database: PrismaClient,
	environment: Record<string, string | undefined>,
) {
	const config = parseSocialPublicationConfig(environment),
		cipher = createPublicationCheckpointCipher(config.checkpointKey);
	return async (snapshot: PublicationInputSnapshot) => {
		const scope = publicationKeyScope(snapshot),
			sources = await publicationSources(database, snapshot);
		const checkpoint = snapshot.attempt.checkpointEncrypted
			? cipher.open(snapshot.attempt.checkpointEncrypted)
			: null;
		if (
			checkpoint &&
			snapshot.attempt.operationKind === "linkedin_video_upload"
		) {
			const ref = checkpoint.uploadInstructionsRef as
				| Prisma.JsonObject
				| undefined;
			if (typeof ref?.artifactId !== "string")
				throw new PublicationExecutionError("publication_checkpoint_invalid");
			const artifact = await database.executionArtifact.findUnique({
				where: { id: ref.artifactId },
				include: { attempt: { include: { dispatch: true } } },
			});
			const original = artifact
				? await database.publicationClaim.findUnique({
						where: { id: artifact.attemptToken },
					})
				: null;
			if (
				!artifact ||
				!original ||
				original.attemptId !== snapshot.attempt.id ||
				artifact.role !== "publication_checkpoint" ||
				artifact.attempt.dispatch.subjectKind !== "social_publication" ||
				artifact.attempt.dispatch.subjectId !== snapshot.post.id
			)
				throw new PublicationExecutionError("publication_checkpoint_invalid");
			sources.push(source(artifact, "publication_instructions"));
		}
		const { linkedInVersionSunsetAt: _sunset, ...providers } = config.providers;
		const loaded = JSON.parse(
			JSON.stringify({
				...snapshot.loaded,
				sealedCheckpoint: null,
				terminalResult: null,
			}),
		);
		const payload = publicationInputPayloadSchema.parse({
			mode: snapshot.claim.executionMode,
			loaded,
			operation:
				checkpoint && snapshot.attempt.operationKind
					? { kind: snapshot.attempt.operationKind, state: checkpoint }
					: null,
			config: {
				...providers,
				facebookReelsPublishingEnabled:
					isSocialProviderPublishingEnabled("facebook_reels"),
			},
			retry: config.retry,
			providerCallCeiling: snapshot.attempt.providerCallCeiling,
		});
		const nonce = Buffer.from(
			(snapshot.claim.workState as { nonce: string }).nonce,
			"base64url",
		);
		if (nonce.length !== 12)
			throw new PublicationExecutionError("publication_input_invalid");
		const encrypted = await sealPublicationPayload(
			payload,
			await derivePublicationPurposeKey(
				config.checkpointKey,
				scope,
				"input_state",
			),
			scope,
			"input_state",
			nonce,
		);
		const envelope = publicationInputEnvelopeSchema.parse({
			version: 1,
			kind: "publication",
			scope,
			payload: Buffer.from(encrypted).toString("base64url"),
		});
		return {
			bytes: new TextEncoder().encode(JSON.stringify(envelope)),
			sources,
		};
	};
}
/** Fresh request/step factory. No credential or client survives its scope. */
export function getPublicationExecution() {
	const database = getPrismaClient(),
		environment = readServiceEnvironment();
	if (!database)
		throw new PublicationExecutionError("publication_database_unavailable");
	const config = parseSocialPublicationConfig(environment),
		storage = createPrivateJsonStorage({
			accountId: environment.R2_ACCOUNT_ID ?? "",
			bucket: environment.R2_BUCKET ?? "",
			accessKeyId: environment.R2_ACCESS_KEY_ID ?? "",
			secretAccessKey: environment.R2_SECRET_ACCESS_KEY ?? "",
		});
	return new PublicationExecution(database, {
		config: {
			operationDeadlineMs: config.execution.providerDeadlineMs,
			providerCallBudget: config.execution.providerCallBudget,
			processingDeadlineMs: config.execution.processingDeadlineMs,
			reconciliationDeadlineMs: config.execution.reconciliationDeadlineMs,
			retry: { ...config.retry, random: Math.random },
		},
		checkpointCipher: createPublicationCheckpointCipher(config.checkpointKey),
		planRefusal: (tx, post) =>
			publicationPlanRefusal(tx, {
				workspaceId: post.workspaceId!,
				socialAccountId: post.socialAccountId,
				customThumbnail: hasCustomThumbnail(
					post.frozenState!.providerSettings as Prisma.JsonObject,
				),
			}),
		buildInput: createPublicationInputBuilder(database, environment),
		inputStorage: {
			put: async (plan, bytes) => {
				await storage.write(plan.storageKey, bytes);
			},
			head: storage.inspect,
		},
		register: deliverExecutionDispatches,
	});
}
export async function publicationEphemeralContext(
	database: PrismaClient,
	snapshot: PublicationInputSnapshot,
	environment: Record<string, string | undefined>,
	pulls: {
		media?: { url: string; expiresAt: string };
		thumbnail?: {
			url: string;
			expiresAt: string;
			contentType: "image/png" | "image/jpeg" | "image/webp";
		};
	},
) {
	const master = parseSocialPublicationConfig(environment).checkpointKey,
		scope = publicationKeyScope(snapshot);
	const account = snapshot.post.socialAccountId
		? await socialOAuthService.getPublishAccount(snapshot.post.socialAccountId)
		: null;
	const metadata = account?.metadata as Prisma.JsonObject | null;
	const projected = metadata
		? Object.fromEntries(
				Object.entries(metadata).filter(
					([key, value]) =>
						(["ownerUrn", "igUserId"].includes(key) &&
							typeof value === "string") ||
						(["auditEnforcedPrivate", "forcePrivateUploads"].includes(key) &&
							typeof value === "boolean"),
				),
			)
		: null;
	let priorCheckpointKey;
	if (
		snapshot.attempt.operationKind === "linkedin_video_upload" &&
		snapshot.attempt.checkpointEncrypted
	) {
		const checkpoint = createPublicationCheckpointCipher(master).open(
				snapshot.attempt.checkpointEncrypted,
			),
			ref = checkpoint.uploadInstructionsRef as Prisma.JsonObject | undefined;
		if (typeof ref?.artifactId !== "string")
			throw new PublicationExecutionError("publication_checkpoint_invalid");
		const artifact = await database.executionArtifact.findUnique({
				where: { id: ref.artifactId },
				include: { attempt: { include: { dispatch: true } } },
			}),
			claim = artifact
				? await database.publicationClaim.findUnique({
						where: { id: artifact.attemptToken },
					})
				: null;
		if (
			!artifact ||
			!claim ||
			claim.attemptId !== snapshot.attempt.id ||
			artifact.role !== "publication_checkpoint" ||
			artifact.attempt.dispatch.subjectId !== snapshot.post.id ||
			artifact.attempt.dispatch.subjectKind !== "social_publication"
		)
			throw new PublicationExecutionError("publication_checkpoint_invalid");
		const priorScope = {
			...scope,
			claimId: claim.id,
			bindingHash: artifact.attempt.inputHash,
		};
		priorCheckpointKey = {
			artifactId: artifact.id,
			key: await derivePublicationPurposeKey(
				master,
				priorScope,
				"linkedin_instructions",
			),
			scope: priorScope,
		};
	}
	let webhook;
	if (!snapshot.post.socialAccountId) {
		const configured = parseSocialPublicationConfig(environment).webhook,
			frozen = snapshot.loaded.frozen;
		if (
			!configured ||
			!pulls.media ||
			!frozen.storageKey ||
			!frozen.sizeBytes ||
			!frozen.durationSec
		)
			throw new PublicationExecutionError("publication_webhook_unconfigured");
		const body = publicationWebhookBody(
			{
				attemptId: snapshot.attempt.id,
				idempotencyKey: snapshot.attempt.idempotencyKey,
				socialPostId: snapshot.post.id,
				projectId: snapshot.post.projectId,
				platform: frozen.platform,
				caption: frozen.caption,
				scheduledFor: snapshot.loaded.socialPost.scheduledFor,
				providerSettings: frozen.providerSettings,
				media: {
					storageKey: frozen.storageKey,
					fileName: `social-${frozen.clipExportVariantId}.mp4`,
					contentType: "video/mp4",
					sizeBytes: frozen.sizeBytes,
					durationSec: frozen.durationSec,
					aspectRatio: frozen.aspectRatio,
				},
			},
			{ url: pulls.media.url, expiresAt: new Date(pulls.media.expiresAt) },
		);
		webhook = {
			receiverUrl: configured.url,
			deadlineMs: configured.deadlineMs,
			maxResponseBytes: configured.maxResponseBytes,
			reconciliationMaxMs: configured.reconciliationMaxMs,
			bodySha256: createHash("sha256").update(body).digest("hex"),
			signature: `sha256=${createHmac("sha256", configured.signingSecret).update(body).digest("hex")}`,
		};
	}
	return publicationEphemeralSchema.parse({
		version: 1,
		...pulls,
		...(webhook ? { webhook } : {}),
		inputKey: {
			key: await derivePublicationPurposeKey(master, scope, "input_state"),
			scope,
		},
		checkpointKey: {
			key: await derivePublicationPurposeKey(
				master,
				scope,
				"linkedin_instructions",
			),
			scope,
		},
		...(priorCheckpointKey ? { priorCheckpointKey } : {}),
		account: account ? { ...account, metadata: projected } : null,
	});
}

/** Native callers never choose a storage key or a signing mode. Only the exact
 * committed frozen video/thumbnail already selected for this claim can receive
 * a URL-only provider grant. These assignment keys are immutable after commit. */
export async function publicationProviderPullReads(
	database: PrismaClient,
	snapshot: PublicationInputSnapshot,
	storage: Pick<
		ReturnType<typeof import("./execution-storage").createExecutionStorage>,
		"signProviderPullRead"
	>,
	window: { leaseExpiresAt: Date; operationDeadlineAt: Date },
) {
	const frozen = await publicationSources(database, snapshot);
	const result: {
		media?: { url: string; expiresAt: string };
		thumbnail?: {
			url: string;
			expiresAt: string;
			contentType: "image/png" | "image/jpeg" | "image/webp";
		};
	} = {};
	for (const selected of frozen) {
		const artifact = await database.executionArtifact.findUnique({
			where: { storageKey: selected.storageKey },
		});
		if (
			!artifact ||
			!artifact.committedAt ||
			artifact.etag !== selected.etag ||
			artifact.byteLength !== BigInt(selected.byteLength) ||
			artifact.checksumSha256 !== selected.sha256 ||
			!artifact.storageKey.startsWith("execution/")
		)
			throw new PublicationExecutionError("publication_frozen_media_unsealed");
		const grant = await storage.signProviderPullRead(
			{
				artifactId: artifact.id,
				storageKey: artifact.storageKey,
				bindingHash: artifact.bindingHash,
				contentType: artifact.contentType,
				byteLength: selected.byteLength,
				etag: selected.etag,
			},
			window,
		);
		if (selected.name === "publication_media")
			result.media = {
				url: grant.url,
				expiresAt: grant.expiresAt.toISOString(),
			};
		else {
			if (
				!["image/png", "image/jpeg", "image/webp"].includes(
					artifact.contentType,
				)
			)
				throw new PublicationExecutionError("publication_thumbnail_unsealed");
			result.thumbnail = {
				url: grant.url,
				expiresAt: grant.expiresAt.toISOString(),
				contentType: artifact.contentType as
					| "image/png"
					| "image/jpeg"
					| "image/webp",
			};
		}
	}
	return result;
}
