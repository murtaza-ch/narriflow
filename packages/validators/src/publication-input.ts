import { z } from "zod";
import { publicationKeyScopeSchema } from "./publication-execution";
import { socialPlatformSchema } from "./social";
const date = z.iso.datetime(),
	id = z.string().uuid(),
	object = z.record(z.string(), z.json());
const phase = z.enum([
	"claimed",
	"preparing",
	"uploading",
	"submission_started",
	"processing",
	"reconciling",
	"retry_scheduled",
	"succeeded",
	"failed",
	"needs_attention",
]);
/** The private object contains only one claim's encrypted immutable snapshot.
 * OAuth and purpose keys are present solely in the fresh work package. */
export const publicationInputEnvelopeSchema = z.strictObject({
	version: z.literal(1),
	kind: z.literal("publication"),
	scope: publicationKeyScopeSchema,
	payload: z
		.string()
		.min(40)
		.max(22369624)
		.regex(/^[A-Za-z0-9_-]+$/),
});
export const publicationInputPayloadSchema = z.strictObject({
	mode: z.enum(["publish", "resume", "reconcile"]),
	loaded: z.strictObject({
		socialPost: z.strictObject({
			id,
			workspaceId: id,
			projectId: id,
			status: z.enum([
				"scheduled",
				"publishing",
				"processing",
				"reconciling",
				"inbox_delivered",
				"posted",
				"failed",
				"needs_attention",
				"cancelled",
			]),
			scheduledFor: date,
			nextAttemptAt: date.nullable().optional(),
			externalUrl: z.string().nullable().optional(),
			errorCode: z.string().nullable().optional(),
		}),
		frozen: z.strictObject({
			deliveryMode: z.enum(["direct", "tiktok_inbox"]).optional(),
			clipExportId: id,
			clipExportVariantId: id,
			editorRevision: z.number().int().nonnegative(),
			exportFingerprint: z.string().min(1).max(2048),
			storageKey: z.string().nullable(),
			sizeBytes: z
				.number()
				.int()
				.positive()
				.max(10 * 1024 ** 3)
				.nullable(),
			durationSec: z.number().positive().nullable(),
			aspectRatio: z.enum(["9:16", "1:1", "16:9", "4:5"]),
			caption: z.string().max(100000),
			providerSettings: object,
			socialAccountId: id.nullable(),
			platform: socialPlatformSchema,
			capabilityVersion: z.string().min(1).max(200),
			scheduledFor: date,
		}),
		attempt: z.strictObject({
			id,
			attemptNumber: z.number().int().positive(),
			priorAttemptId: id.nullable(),
			idempotencyKey: z.string().min(1).max(1024),
			phase,
			outcome: z.enum(["accepted", "pending", "failed", "unknown"]).nullable(),
			nextActionAt: date,
			providerCallCount: z.number().int().nonnegative(),
			startedAt: date,
			phaseStartedAt: date.optional(),
			processingDeadline: date,
			reconciliationDeadline: date,
			reconciliationOnly: z.boolean().optional(),
			failureCode: z.string().nullable().optional(),
			failureEvidence: z.json().nullable().optional(),
			failureDisposition: z
				.enum(["safe_retry", "permanent", "attention"])
				.nullable()
				.optional(),
		}),
		claim: z.strictObject({
			id,
			claimantId: z.string().max(200),
			leaseExpiresAt: date,
			heartbeatAt: date,
		}),
		checkpointKind: z.string().nullable(),
		sealedCheckpoint: z.null(),
		terminalResult: z.null(),
	}),
	operation: z
		.strictObject({ kind: z.string().min(1).max(80), state: object })
		.nullable(),
	config: z.strictObject({
		youtubeApiVersion: z.string().max(100),
		youtubeChunkBytes: z
			.number()
			.int()
			.positive()
			.max(256 * 1024 ** 2),
		metaGraphVersion: z.string().max(100),
		linkedInVersion: z.string().max(100),
		instagramPollAttempts: z.number().int().positive().max(60),
		instagramPollIntervalMs: z.number().int().positive().max(60000),
		facebookReelsPublishingEnabled: z.boolean(),
		tiktokPollIntervalMs: z.number().int().positive().max(60000),
		tiktokChunkBytes: z
			.number()
			.int()
			.positive()
			.max(64 * 1024 ** 2),
		tiktokApiVersion: z.string().max(100),
		xApiVersion: z.string().max(100),
		xChunkBytes: z
			.number()
			.int()
			.positive()
			.max(5 * 1024 ** 2),
		xMaxMediaBytes: z
			.number()
			.int()
			.positive()
			.max(512 * 1024 ** 2),
		xRateLimitRetryFloorMs: z.number().int().nonnegative(),
		xReconciliationMaxPages: z.number().int().positive().max(100),
	}),
	retry: z.strictObject({
		maxAttempts: z.number().int().positive().max(10),
		maxElapsedMs: z.number().int().positive(),
		baseDelayMs: z.number().int().positive(),
		maxDelayMs: z.number().int().positive(),
		jitterRatio: z.number().min(0).max(1),
	}),
	providerCallCeiling: z.number().int().positive().max(100),
});
export type PublicationInputPayload = z.infer<
	typeof publicationInputPayloadSchema
>;
