import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimDueSocialPublicationAttempts,
	createSocialPublicationAttempt,
	heartbeatSocialPublicationClaim,
	prismaSocialPublicationAttemptStore,
	type OwnedPublicationAttempt,
} from "./social-publication-attempt";
import { createPublicationCheckpointCipher } from "./social-publication-checkpoint-cipher";
import { parseSocialPublicationConfig } from "./social-publication-config";
import { createNativePublicationPlatformRegistry } from "./social-publication-native-platforms";
import {
	PublicationPlatformExecutionError,
	type PublicationPlatformInput,
} from "./social-publication-platform";
import {
	createFetchPublicationWebhookTransport,
	createPublicationWebhookPlatform,
	type PublicationWebhookMedia,
} from "./social-publication-webhook";
import {
	downloadObjectToFile,
	headObject,
	presignDownloadUrl,
} from "./r2-storage";
import { socialOAuthService } from "./social-oauth.service";

async function materializeMedia(input: PublicationPlatformInput["media"]) {
	const directory = await mkdtemp(join(tmpdir(), "narriflow-publication-"));
	const path = join(directory, input.fileName);
	try {
		await downloadObjectToFile({ key: input.storageKey, filePath: path });
		const facts = await stat(path);
		if (facts.size !== input.sizeBytes) {
			throw new Error(
				"Frozen Publication State byte length does not match stored media",
			);
		}
		return {
			sizeBytes: facts.size,
			fileName: input.fileName,
			async blob(start = 0, endExclusive = facts.size) {
				const bun = (
					globalThis as unknown as {
						Bun: { file(filePath: string): Blob };
					}
				).Bun;
				return bun.file(path).slice(start, endExclusive, input.contentType);
			},
			async cleanup() {
				await rm(directory, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true }).catch(
			() => undefined,
		);
		throw error;
	}
}

export function createVerifiedPublicationWebhookMedia(dependencies: {
	head: typeof headObject;
	presign: typeof presignDownloadUrl;
	deadlineMs: number;
	clock: { now(): Date };
}): PublicationWebhookMedia {
	return {
		async createScopedAccess(input) {
			try {
				const object = await dependencies.head(input.storageKey);
				if (object.sizeBytes !== input.sizeBytes) {
					throw new PublicationPlatformExecutionError(
						"publication_frozen_media_missing",
						"preparation",
						"The exact frozen publication media is unavailable",
					);
				}
			} catch (error) {
				if (error instanceof PublicationPlatformExecutionError) throw error;
				const code =
					error !== null && typeof error === "object" && "name" in error
						? String(error.name)
						: "";
				if (code === "NoSuchKey" || code === "NotFound") {
					throw new PublicationPlatformExecutionError(
						"publication_frozen_media_missing",
						"preparation",
						"The exact frozen publication media is unavailable",
					);
				}
				throw error;
			}
			const expiresInSeconds = Math.ceil(
				dependencies.deadlineMs / 1000 + 15 * 60,
			);
			return {
				url: await dependencies.presign({
					key: input.storageKey,
					fileName: input.fileName,
					expiresIn: expiresInSeconds,
				}),
				expiresAt: new Date(
					dependencies.clock.now().getTime() + expiresInSeconds * 1000,
				),
			};
		},
	};
}

export function createProductionSocialPublicationRuntime(
	environment: Record<string, string | undefined> = process.env,
) {
	const config = parseSocialPublicationConfig(environment);
	const native = createNativePublicationPlatformRegistry({
		fetch,
		media: {
			materialize: materializeMedia,
			createScopedAccess: (media) =>
				presignDownloadUrl({
					key: media.storageKey,
					fileName: media.fileName,
					expiresIn: 2 * 60 * 60,
				}),
		},
		clock: { now: () => new Date() },
		config: {
			youtubeChunkBytes: 8 * 1024 * 1024,
			metaGraphVersion: config.providers.metaGraphVersion,
			linkedInVersion: config.providers.linkedInVersion,
			instagramPollAttempts: 30,
			instagramPollIntervalMs: 5_000,
			tiktokPollIntervalMs: 5_000,
			tiktokChunkBytes: 64 * 1024 * 1024,
			xChunkBytes: 4 * 1024 * 1024,
		},
	});
	const webhook = config.webhook
		? createPublicationWebhookPlatform({
				config: config.webhook,
				transport: createFetchPublicationWebhookTransport(),
				media: createVerifiedPublicationWebhookMedia({
					head: headObject,
					presign: presignDownloadUrl,
					deadlineMs: config.webhook.deadlineMs,
					clock: { now: () => new Date() },
				}),
				clock: { now: () => new Date() },
			})
		: null;
	const platforms = {
		get(
			platform: PublicationPlatformInput["platform"],
			channel: "native" | "webhook" = "native",
		) {
			if (channel === "webhook") {
				if (!webhook) {
					throw new Error("Publication webhook is not configured");
				}
				return webhook;
			}
			return native.get(platform);
		},
	};
	const attempt = createSocialPublicationAttempt({
		store: prismaSocialPublicationAttemptStore,
		platforms,
		credentials: {
			load: (accountId) => socialOAuthService.getPublishAccount(accountId),
		},
		checkpointCipher: createPublicationCheckpointCipher(config.checkpointKey),
		clock: { now: () => new Date() },
		diagnostics: {
			record(event) {
				console.warn(
					JSON.stringify({ ...event, ts: new Date().toISOString() }),
				);
			},
		},
		retry: { ...config.retry, random: Math.random },
		providerCallBudget: config.worker.providerCallBudget,
		processingDeadlineMs: config.worker.processingDeadlineMs,
		reconciliationDeadlineMs: config.worker.reconciliationDeadlineMs,
	});
	return {
		config,
		attempt,
		claimDue(claimantId: string, now = new Date()) {
			return claimDueSocialPublicationAttempts({
				claimantId,
				now,
				config: {
					batchSize: config.worker.batchSize,
					leaseMs: config.worker.leaseMs,
					processingDeadlineMs: config.worker.processingDeadlineMs,
					reconciliationDeadlineMs: config.worker.reconciliationDeadlineMs,
					providerCallBudget: config.worker.providerCallBudget,
				},
			});
		},
		heartbeat(owned: OwnedPublicationAttempt, now = new Date()) {
			return heartbeatSocialPublicationClaim({
				owned,
				now,
				leaseMs: config.worker.leaseMs,
			});
		},
	};
}

let productionRuntime:
	| ReturnType<typeof createProductionSocialPublicationRuntime>
	| undefined;

export function getSocialPublicationRuntime() {
	productionRuntime ??= createProductionSocialPublicationRuntime();
	return productionRuntime;
}
