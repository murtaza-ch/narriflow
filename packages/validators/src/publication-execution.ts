import { z } from "zod";
const code = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[a-z][a-z0-9_]*$/);
const operation = z.strictObject({
	kind: z
		.string()
		.min(1)
		.max(80)
		.regex(/^[a-z][a-z0-9_]*$/),
	state: z.record(z.string(), z.json()),
	lookupKey: z.string().min(1).max(2048).optional(),
});
const receipt = z.strictObject({
	receiptId: z.string().min(1).max(2048),
	deliveryMode: z.enum(["direct", "tiktok_inbox"]).optional(),
	platformPostIds: z.array(z.string().min(1).max(2048)).max(100).optional(),
	platformPostId: z.string().min(1).max(2048).nullable(),
	externalUrl: z.string().url().max(2048).nullable(),
	providerProcessingStatus: z
		.enum(["processing", "succeeded", "failed"])
		.nullable()
		.optional(),
	providerProcessingFailureCode: code.nullable().optional(),
	providerVisibility: z.string().min(1).max(100).nullable().optional(),
});
export const publicationNativeCommandSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("preflight") }),
		z.strictObject({
			kind: z.literal("checkpoint"),
			operation,
			operationLookupHash: z
				.string()
				.regex(/^[a-f0-9]{64}$/)
				.nullable()
				.optional(),
		}),
		z.strictObject({
			kind: z.literal("provider_call"),
			operation: z.enum(["initialize", "upload", "submit", "read", "cleanup"]),
			purpose: z.enum(["primary_media", "thumbnail"]).optional(),
		}),
		z.strictObject({ kind: z.literal("accepted"), receipt }),
		z.strictObject({
			kind: z.literal("pending"),
			receiptId: z.string().min(1).max(2048),
			operation,
			nextCheckAt: z.iso.datetime(),
			submissionStarted: z.boolean().optional(),
		}),
		z.strictObject({
			kind: z.literal("unknown"),
			code,
			operation: operation.nullable(),
			retryAfterMs: z
				.number()
				.int()
				.nonnegative()
				.max(86400000)
				.nullable()
				.optional(),
		}),
		z.strictObject({
			kind: z.literal("failed"),
			failure: z.strictObject({
				code,
				phase: z.enum([
					"preparation",
					"upload",
					"submission",
					"reconciliation",
					"cleanup",
				]),
				disposition: z.enum(["safe_retry", "permanent", "attention"]),
				retryAfterMs: z.number().int().nonnegative().max(86400000).nullable(),
				safeToRepublishAfterSubmission: z.boolean().optional(),
				evidence: z.record(z.string(), z.json()).optional(),
			}),
		}),
		z.strictObject({ kind: z.literal("interrupted") }),
	])
	.refine(
		(value) =>
			new TextEncoder().encode(JSON.stringify(value)).byteLength <= 48 * 1024,
		"Publication metadata exceeds48KiB",
	);
/** Inbox replies contain outcome metadata only. Credentials and scoped URLs
 * are returned by the separately authorized work-package transport. */
export const publicationNativeReplySchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("recorded") }),
	z.strictObject({
		kind: z.literal("settled"),
		outcome: z.enum([
			"posted",
			"inbox_delivered",
			"failed",
			"needs_attention",
			"processing",
			"reconciling",
			"retry_scheduled",
			"interrupted",
		]),
		attemptId: z.string().uuid(),
		socialPostId: z.string().uuid(),
		nextActionAt: z.iso.datetime().optional(),
		nextAttemptId: z.string().uuid().optional(),
		code: code.optional(),
	}),
]);
export type PublicationNativeCommand = z.infer<
	typeof publicationNativeCommandSchema
>;
export type PublicationNativeReply = z.infer<
	typeof publicationNativeReplySchema
>;

export const publicationKeyScopeSchema = z.strictObject({
	deploymentEpoch: z.number().int().positive(),
	socialPostId: z.string().uuid(),
	attemptId: z.string().uuid(),
	claimId: z.string().uuid(),
	bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const scopedKey = z.strictObject({
	key: z
		.string()
		.regex(/^[A-Za-z0-9_-]{43}$/)
		.refine((value) => {
			try {
				return (
					btoa(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "="))
						.replaceAll("+", "-")
						.replaceAll("/", "_")
						.replace(/=+$/, "") === value
				);
			} catch {
				return false;
			}
		}, "Invalid canonical purpose key"),
	scope: publicationKeyScopeSchema,
});
export const publicationEphemeralSchema = z
	.strictObject({
		version: z.literal(1),
		webhook: z
			.strictObject({
				receiverUrl: z.string().url().max(8192),
				bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
				signature: z.string().regex(/^sha256=[a-f0-9]{64}$/),
				deadlineMs: z.number().int().min(1000).max(60000),
				maxResponseBytes: z.number().int().min(1024).max(1048576),
				reconciliationMaxMs: z
					.number()
					.int()
					.min(60000)
					.max(7 * 86400000),
			})
			.optional(),
		media: z
			.strictObject({
				url: z.string().url().max(8192),
				expiresAt: z.iso.datetime(),
			})
			.optional(),
		thumbnail: z
			.strictObject({
				url: z.string().url().max(8192),
				expiresAt: z.iso.datetime(),
				contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
			})
			.optional(),
		inputKey: scopedKey,
		checkpointKey: scopedKey,
		priorCheckpointKey: scopedKey
			.extend({ artifactId: z.string().uuid() })
			.optional(),
		account: z
			.strictObject({
				id: z.string().uuid(),
				userId: z.string().uuid(),
				platform: z.enum([
					"youtube_shorts",
					"instagram_reels",
					"facebook_reels",
					"tiktok",
					"linkedin",
					"x",
				]),
				providerAccountId: z.string().min(1).max(2048),
				displayName: z.string().max(512),
				handle: z.string().max(512).nullable(),
				accessToken: z.string().min(1).max(16384),
				scopes: z.array(z.string().max(512)).max(100),
				metadata: z
					.strictObject({
						ownerUrn: z.string().max(2048).optional(),
						igUserId: z.string().max(2048).optional(),
						auditEnforcedPrivate: z.boolean().optional(),
						forcePrivateUploads: z.boolean().optional(),
					})
					.nullable(),
			})
			.nullable(),
	})
	.refine(
		(value) =>
			new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32 * 1024,
		"Publication context exceeds32KiB",
	);
export const linkedInInstructionBlobSchema = z
	.strictObject({
		version: z.literal(1),
		kind: z.literal("linkedin_upload_instructions"),
		owner: z.string().min(1).max(2048),
		videoUrn: z
			.string()
			.regex(/^urn:li:video:[A-Za-z0-9_-]+$/)
			.max(2048),
		uploadToken: z.string().max(8192),
		totalBytes: z
			.number()
			.int()
			.positive()
			.max(10 * 1024 ** 3),
		uploadInstructions: z
			.array(
				z.strictObject({
					uploadUrl: z
						.string()
						.url()
						.max(8192)
						.refine((raw) => {
							const u = new URL(raw);
							return (
								u.protocol === "https:" &&
								!u.username &&
								!u.password &&
								!u.hash &&
								(!u.port || u.port === "443") &&
								(u.hostname === "www.linkedin.com" ||
									u.hostname.endsWith(".licdn.com"))
							);
						}, "Invalid LinkedIn upload origin"),
					firstByte: z.number().int().nonnegative(),
					lastByte: z.number().int().nonnegative(),
				}),
			)
			.min(1)
			.max(2560),
	})
	.superRefine((value, context) => {
		let cursor = 0;
		for (const part of value.uploadInstructions) {
			if (
				part.firstByte !== cursor ||
				part.lastByte < part.firstByte ||
				part.lastByte >= value.totalBytes
			) {
				context.addIssue({
					code: "custom",
					path: ["uploadInstructions"],
					message: "Instructions must cover contiguous exact byte ranges",
				});
				return;
			}
			cursor = part.lastByte + 1;
		}
		if (cursor !== value.totalBytes)
			context.addIssue({
				code: "custom",
				path: ["uploadInstructions"],
				message: "Incomplete instruction byte coverage",
			});
	});
export type PublicationKeyScope = z.infer<typeof publicationKeyScopeSchema>;
export type PublicationEphemeral = z.infer<typeof publicationEphemeralSchema>;
export type LinkedInInstructionBlob = z.infer<
	typeof linkedInInstructionBlobSchema
>;
