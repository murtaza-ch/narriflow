import { z } from "zod";
import { clipAspectRatioSchema } from "./clip";
import { postingScheduleSchema } from "./posting-schedule";
import { SOCIAL_PROVIDER_CAPABILITIES, socialCaptionLength } from "./social-provider-capabilities";

export const socialPlatformSchema = z.enum([
	"tiktok",
	"youtube_shorts",
	"instagram_reels",
	"facebook_reels",
	"linkedin",
	"x",
]);

export const socialDeliveryModeSchema = z.enum(["direct", "tiktok_inbox"]);
export type SocialDeliveryMode = z.infer<typeof socialDeliveryModeSchema>;

export const socialPostStatusSchema = z.enum([
	"draft",
	"inbox_delivered",
	"preparing_video",
	"scheduled",
	"publishing",
	"processing",
	"reconciling",
	"posted",
	"failed",
	"needs_attention",
	"cancelled",
]);

export const publicationFailureDispositionSchema = z.enum([
	"safe_retry",
	"permanent",
	"attention",
]);

export const socialPublicationActionSchema = z.enum([
	"cancel",
	"recheck",
	"confirm_published",
	"publish_again",
	"retry",
	"reconnect_account",
	"schedule_again",
]);

export const publicationEvidenceKindSchema = z.enum([
	"provider_reference",
	"platform_url",
	"manual_unvalidated",
]);

export const recheckSocialPublicationSchema = z.strictObject({
	reason: z.string().trim().min(1).max(500),
});

export const confirmSocialPublicationSchema = z
	.strictObject({
		reason: z.string().trim().min(1).max(500),
		evidenceKind: publicationEvidenceKindSchema,
		providerReference: z.string().trim().min(1).max(500).nullable().optional(),
		externalUrl: z.string().url().max(2_048).nullable().optional(),
	})
	.superRefine((value, context) => {
		if (value.evidenceKind === "platform_url" && !value.externalUrl) {
			context.addIssue({
				code: "custom",
				path: ["externalUrl"],
				message: "A platform URL is required for platform URL evidence",
			});
		}
		if (
			value.evidenceKind === "provider_reference" &&
			!value.providerReference
		) {
			context.addIssue({
				code: "custom",
				path: ["providerReference"],
				message:
					"A provider reference is required for provider reference evidence",
			});
		}
	});

export const republishSocialPublicationSchema = z.strictObject({
	reason: z.string().trim().min(1).max(500),
	duplicateRiskAcknowledged: z.literal(true),
});

export const socialAccountStatusSchema = z.enum([
	"active",
	"expired",
	"revoked",
]);

export const socialThumbnailSelectionSchema = z
	.strictObject({
		assetId: z.string().uuid(),
		fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
		source: z.enum(["uploaded", "generated", "extracted_frame"]),
		sourceTimeMs: z.number().int().nonnegative().nullable(),
	})
	.superRefine((value, context) => {
		if (value.source === "extracted_frame" && value.sourceTimeMs === null) {
			context.addIssue({
				code: "custom",
				path: ["sourceTimeMs"],
				message: "Extracted frames require a source time",
			});
		}
		if (value.source !== "extracted_frame" && value.sourceTimeMs !== null) {
			context.addIssue({
				code: "custom",
				path: ["sourceTimeMs"],
				message: "Only extracted frames have a source time",
			});
		}
	});

export const scheduleSocialPostSchema = z
	.object({
		deliveryMode: socialDeliveryModeSchema.default("direct"),
		clientIdempotencyKey: z.string().uuid(),
		clipId: z.string().uuid(),
		expectedEditorRevision: z.number().int().nonnegative(),
		clipExportId: z.string().uuid().optional(),
		clipExportVariantId: z.string().uuid().optional(),
		accountId: z.string().uuid().nullable(),
		platform: socialPlatformSchema,
		caption: z.string().trim().max(5_000),
		aspectRatio: clipAspectRatioSchema,
		resolution: z.enum(["720p", "1080p"]),
		scheduledFor: z.string().datetime(),
		immediate: z.boolean().optional(),
		providerSettings: z.record(z.string(), z.unknown()).default({}),
		assistedCopyVariantId: z.string().uuid().nullable().optional(),
		thumbnail: socialThumbnailSelectionSchema.nullable().optional(),
		reviewOverrideReason: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.nullable()
			.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (Boolean(value.clipExportId) !== Boolean(value.clipExportVariantId)) {
			context.addIssue({
				code: "custom",
				path: [value.clipExportId ? "clipExportVariantId" : "clipExportId"],
				message: "The exact export and variant must be selected together",
			});
		}
		if (value.deliveryMode === "tiktok_inbox") {
			if (
				value.platform !== "tiktok" ||
				!value.accountId ||
				value.thumbnail ||
				Object.keys(value.providerSettings).length
			) {
				context.addIssue({
					code: "custom",
					path: ["deliveryMode"],
					message:
						"Inbox delivery accepts a TikTok video without publication settings",
				});
			}
		} else if (!value.caption)
			context.addIssue({
				code: "custom",
				path: ["caption"],
				message: "Write a description",
			});
		const capability = SOCIAL_PROVIDER_CAPABILITIES[value.platform];
		if (!capability.aspectRatios.some((ratio) => ratio === value.aspectRatio)) {
			context.addIssue({
				code: "custom",
				path: ["aspectRatio"],
				message: "Aspect ratio is not supported by this provider",
			});
		}
		if (socialCaptionLength(value.platform, value.caption) > capability.textLimit) {
			context.addIssue({
				code: "custom",
				path: ["caption"],
				message: `Caption exceeds the ${capability.textLimit}-${value.platform === "x" ? "unit" : "character"} provider limit`,
			});
		}
		const thumbnailType = value.providerSettings.thumbnailType;
		if (
			typeof thumbnailType === "string" &&
			!capability.thumbnailTypes.some(
				(candidate) => candidate === thumbnailType,
			)
		) {
			context.addIssue({
				code: "custom",
				path: ["providerSettings", "thumbnailType"],
				message: "Thumbnail type is not supported by this provider",
			});
		}
		if (
			["thumbnailAssetId", "thumbnailFingerprint", "thumbnailSource"].some(
				(key) => key in value.providerSettings,
			)
		) {
			context.addIssue({
				code: "custom",
				path: ["providerSettings"],
				message: "Thumbnail references must use the thumbnail field",
			});
		}
	});

export const socialAccountSnapshotSchema = z.object({
	id: z.string().uuid(),
	platform: socialPlatformSchema,
	providerAccountId: z.string(),
	displayName: z.string(),
	handle: z.string().nullable(),
	avatarUrl: z.string().nullable(),
	scopes: z.array(z.string()),
	expiresAt: z.string().datetime().nullable(),
	status: socialAccountStatusSchema,
	postingSchedule: postingScheduleSchema.nullable().default(null),
	/** Whether the Workspace's plan lets this account publish: the oldest accounts up to the plan's count. */
	publishingEligible: z.boolean(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});

const publicCount = z.number().int().nonnegative().nullable();

/** The latest reading of a post's public counts. A null count means the
 *  platform doesn't report it, which is different from zero. */
export const socialPostMetricsSnapshotSchema = z.object({
	views: publicCount,
	likes: publicCount,
	comments: publicCount,
	shares: publicCount,
	saves: publicCount,
	watchTimeSeconds: publicCount,
	capturedAt: z.string().datetime(),
});

export const socialPostSnapshotSchema = z.object({
	deliveryMode: socialDeliveryModeSchema.default("direct"),
	publishedVideos: z
		.array(
			z.object({
				platformPostId: z.string(),
				externalUrl: z.string().nullable(),
			}),
		)
		.default([]),
	id: z.string().uuid(),
	projectId: z.string().uuid(),
	clipId: z.string().uuid().nullable(),
	accountId: z.string().uuid().nullable(),
	accountDisplayName: z.string().nullable(),
	accountHandle: z.string().nullable(),
	platform: socialPlatformSchema,
	status: socialPostStatusSchema,
	caption: z.string(),
	aspectRatio: clipAspectRatioSchema.nullable(),
	scheduledFor: z.string().datetime().nullable(),
	postedAt: z.string().datetime().nullable(),
	externalUrl: z.string().nullable(),
	errorCode: z.string().nullable(),
	errorDisposition: publicationFailureDispositionSchema.nullable(),
	nextAttemptAt: z.string().datetime().nullable(),
	providerProcessingStatus: z
		.enum(["processing", "succeeded", "failed", "unknown"])
		.nullable(),
	providerProcessingFailureCode: z.string().nullable(),
	providerVisibility: z.string().nullable(),
	allowedActions: z.array(socialPublicationActionSchema).default([]),
	/** The account must be reconnected; `allowedActions` lists reconnect only for members who may do it. */
	reconnectRequired: z.boolean().default(false),
	latestMetrics: socialPostMetricsSnapshotSchema.nullable(),
	createdAt: z.string().datetime(),
});

/** Statuses that mean a clip already reached, or is still on its way to, an account. */
export const SOCIAL_CLIP_HISTORY_STATUSES = [
	"posted",
	"inbox_delivered",
	"preparing_video",
	"scheduled",
	"publishing",
	"processing",
	"reconciling",
	"needs_attention",
] as const satisfies ReadonlyArray<z.infer<typeof socialPostStatusSchema>>;

/** The most clips one clip-history read covers; the composer's selection stays under it. */
export const SOCIAL_CLIP_HISTORY_MAX_CLIPS = 50;

export const socialClipHistoryQuerySchema = z.object({
	/** Comma-separated clip ids, at most `SOCIAL_CLIP_HISTORY_MAX_CLIPS`. */
	clipIds: z
		.string()
		.transform((value) => [...new Set(value.split(",").filter(Boolean))])
		.pipe(z.array(z.string().uuid()).min(1).max(SOCIAL_CLIP_HISTORY_MAX_CLIPS)),
});

/**
 * Every post of the given clips that is published, sent to the TikTok inbox,
 * still on its way, or uncertain, so the composer can warn before a repeat.
 * Failed, cancelled and draft posts never reached a provider and are left out.
 */
export const socialClipHistoryResponseSchema = z.object({
	items: z.array(
		z.object({
			postId: z.string().uuid(),
			clipId: z.string().uuid(),
			accountId: z.string().uuid(),
			platform: socialPlatformSchema,
			status: z.enum(SOCIAL_CLIP_HISTORY_STATUSES),
			scheduledFor: z.string().datetime().nullable(),
			postedAt: z.string().datetime().nullable(),
		}),
	),
});

export type SocialClipHistory = z.infer<typeof socialClipHistoryResponseSchema>;
export type SocialClipHistoryItem = SocialClipHistory["items"][number];
export type SocialPlatform = z.infer<typeof socialPlatformSchema>;
export type SocialPostStatus = z.infer<typeof socialPostStatusSchema>;
export type SocialAccountStatus = z.infer<typeof socialAccountStatusSchema>;
export type ScheduleSocialPostInput = z.infer<typeof scheduleSocialPostSchema>;
export type SocialThumbnailSelection = z.infer<
	typeof socialThumbnailSelectionSchema
>;
export type SocialAccountSnapshot = z.infer<typeof socialAccountSnapshotSchema>;
export type SocialPostMetricsSnapshot = z.infer<typeof socialPostMetricsSnapshotSchema>;
export type SocialPostSnapshot = z.infer<typeof socialPostSnapshotSchema>;
export type SocialPublicationAction = z.infer<
	typeof socialPublicationActionSchema
>;
export type PublicationEvidenceKind = z.infer<
	typeof publicationEvidenceKindSchema
>;
export type RecheckSocialPublicationInput = z.infer<
	typeof recheckSocialPublicationSchema
>;
export type ConfirmSocialPublicationInput = z.infer<
	typeof confirmSocialPublicationSchema
>;
export type RepublishSocialPublicationInput = z.infer<
	typeof republishSocialPublicationSchema
>;
