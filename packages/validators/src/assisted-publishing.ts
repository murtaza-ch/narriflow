import { z } from "zod";
import { clipAspectRatioSchema, clipRenderResolutionSchema } from "./clip";
import {
	socialDeliveryModeSchema,
	socialPlatformSchema,
	socialThumbnailSelectionSchema,
} from "./social";

const idSchema = z.string().uuid();
const hashtagSchema = z
	.string()
	.trim()
	.regex(/^#[^\s#]{1,99}$/u);

export const generateAssistedCopySchema = z
	.strictObject({
		clipId: idSchema,
		idempotencyKey: idSchema,
		platforms: z.array(socialPlatformSchema).min(1).max(6),
		campaignNote: z.string().trim().max(2_000).default(""),
		revisionInstruction: z.string().trim().max(1_000).optional(),
		lockedPhrases: z
			.array(z.string().trim().min(1).max(120))
			.max(50)
			.default([]),
		lockedHashtags: z.array(hashtagSchema).max(50).default([]),
	})
	.superRefine((value, context) => {
		if (new Set(value.platforms).size !== value.platforms.length) {
			context.addIssue({
				code: "custom",
				path: ["platforms"],
				message: "Platforms must be unique",
			});
		}
	});

export const thumbnailSelectionSchema = socialThumbnailSelectionSchema;

export const requestThumbnailFrameSchema = z.strictObject({
	clipId: idSchema,
	exportVariantId: idSchema,
	sourceTimeMs: z.number().int().nonnegative(),
	idempotencyKey: idSchema,
});

export const publishingCopySchema = z.strictObject({
	variantId: idSchema.nullable().default(null),
	caption: z.string().trim().max(5_000),
	hashtags: z.array(hashtagSchema).max(30).default([]),
	title: z.string().trim().max(100).nullable().default(null),
});

export const publishingTimingSchema = z.strictObject({
	scheduleMode: z.enum(["now", "scheduled", "spread"]),
	startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	timeZone: z.string().trim().min(1).max(100),
	postingWindow: z.strictObject({
		start: z.string().regex(/^\d{2}:\d{2}$/),
		end: z.string().regex(/^\d{2}:\d{2}$/),
	}),
	frequency: z.discriminatedUnion("unit", [
		z.strictObject({
			unit: z.literal("hours"),
			value: z.number().int().min(1).max(24),
		}),
		z.strictObject({
			unit: z.literal("days"),
			value: z.number().int().min(1).max(30),
		}),
	]),
	dstDisambiguation: z.enum(["earlier", "later"]).nullable().default(null),
});

export const publishingPreviewSchema = publishingTimingSchema.extend({
	clipIds: z.array(idSchema).min(1).max(100),
});

export const bulkSocialScheduleSchema = publishingTimingSchema
	.extend({
		idempotencyKey: idSchema,
		items: z
			.array(
				z.strictObject({
					clipId: idSchema,
					accountId: idSchema,
					platform: socialPlatformSchema,
					deliveryMode: socialDeliveryModeSchema.default("direct"),
					expectedEditorRevision: z.number().int().nonnegative(),
					exportId: idSchema,
					exportVariantId: idSchema,
					aspectRatio: clipAspectRatioSchema,
					resolution: clipRenderResolutionSchema,
					copy: publishingCopySchema,
					providerSettings: z.record(z.string(), z.unknown()).default({}),
					thumbnail: thumbnailSelectionSchema.nullable().default(null),
				}),
			)
			.min(1)
			.max(500),
		reviewOverrideReason: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.nullable()
			.optional(),
	})
	.superRefine((value, context) => {
		const pairs = value.items.map((item) => `${item.clipId}:${item.accountId}`);
		if (new Set(pairs).size !== pairs.length)
			context.addIssue({
				code: "custom",
				path: ["items"],
				message: "Each clip/account pair must be unique",
			});
		if (
			new Set(value.items.map((item) => item.clipId)).size > 100 ||
			new Set(value.items.map((item) => item.accountId)).size > 20
		)
			context.addIssue({
				code: "custom",
				path: ["items"],
				message: "Select at most 100 clips and 20 accounts",
			});
		value.items.forEach((item, index) => {
			if (
				item.deliveryMode === "tiktok_inbox" &&
				(item.platform !== "tiktok" ||
					item.thumbnail !== null ||
					Object.keys(item.providerSettings).length > 0)
			)
				context.addIssue({
					code: "custom",
					path: ["items", index],
					message:
						"Inbox delivery accepts a TikTok video without publication settings or a cover",
				});
			if (item.deliveryMode === "direct" && !item.copy.caption)
				context.addIssue({
					code: "custom",
					path: ["items", index, "copy", "caption"],
					message: "Write a description",
				});
		});
	});

export type GenerateAssistedCopyRequest = z.infer<
	typeof generateAssistedCopySchema
>;
export type ThumbnailSelectionInput = z.infer<typeof thumbnailSelectionSchema>;
export type RequestThumbnailFrameInput = z.infer<
	typeof requestThumbnailFrameSchema
>;
export type BulkSocialScheduleRequest = z.infer<
	typeof bulkSocialScheduleSchema
>;
export type PublishingPreviewRequest = z.infer<typeof publishingPreviewSchema>;
