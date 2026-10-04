import { z } from "zod";
import { publishingTimingSchema } from "./assisted-publishing";
import {
	socialDeliveryModeSchema,
	socialPlatformSchema,
	socialThumbnailSelectionSchema,
} from "./social";

export const publishingDraftSchema = z.object({
	caption: z.string(),
	title: z.string(),
	variantId: z.string().uuid().nullable(),
	deliveryMode: socialDeliveryModeSchema,
	settings: z.record(z.string(), z.unknown()),
	thumbnail: socialThumbnailSelectionSchema.nullable(),
	revision: z.number().int().nonnegative(),
	edited: z.boolean(),
	generated: z.boolean(),
	editVersion: z.number().int().nonnegative(),
	reviewedRevision: z.number().int().nonnegative(),
});

export const savedPublishingSchema = z.object({
	drafts: z.record(z.string(), publishingDraftSchema),
	accountIds: z.array(z.string().uuid()),
	timing: publishingTimingSchema,
});

export const publishingGeneratedCopySchema = z.object({
	id: z.string().uuid(),
	platform: socialPlatformSchema,
	caption: z.string(),
	hashtags: z.array(z.string()),
	title: z.string().nullable(),
});

export const savedPublishingCopiesSchema = z.record(
	z.string(),
	publishingGeneratedCopySchema,
);

export const publishingGenerationRequestSchema = z.object({
	key: z.string().uuid(),
	signature: z.string().min(1),
});

export const savedPublishingGenerationRequestsSchema = z.record(
	z.string(),
	publishingGenerationRequestSchema,
);

export const bulkSocialScheduleOutcomeSchema = z.object({
	status: z.enum(["running", "completed", "partial", "failed"]),
	items: z.array(z.object({
		clipId: z.string().uuid(),
		accountId: z.string().uuid(),
		status: z.enum(["pending", "processing", "succeeded", "ineligible", "failed"]),
		socialPostId: z.string().uuid().nullable(),
		errorCode: z.string().min(1).nullable(),
		retryable: z.boolean(),
	})).min(1).max(500),
	counts: z.object({
		succeeded: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
		ineligible: z.number().int().nonnegative(),
	}),
}).superRefine((value, context) => {
	const pairs = new Set<string>();
	const counts = { succeeded: 0, failed: 0, ineligible: 0 };
	value.items.forEach((item, index) => {
		const pair = `${item.clipId}:${item.accountId}`;
		if (pairs.has(pair)) context.addIssue({
			code: "custom", path: ["items", index], message: "Each clip/account pair must be unique",
		});
		pairs.add(pair);
		if (item.status === "succeeded") {
			counts.succeeded += 1;
			if (item.socialPostId === null) context.addIssue({
				code: "custom", path: ["items", index, "socialPostId"], message: "An accepted item requires its Social Post identity",
			});
		} else if (item.status === "failed") counts.failed += 1;
		else if (item.status === "ineligible") counts.ineligible += 1;
		else if (value.status !== "running") context.addIssue({
			code: "custom", path: ["items", index, "status"], message: "A terminal outcome cannot contain unfinished items",
		});
	});
	for (const status of ["succeeded", "failed", "ineligible"] as const) {
		if (value.counts[status] !== counts[status]) context.addIssue({
			code: "custom", path: ["counts", status], message: "Outcome counts must match its items",
		});
	}
});

export type PublishingDraft = z.infer<typeof publishingDraftSchema>;
export type SavedPublishingComposition = z.infer<typeof savedPublishingSchema>;
export type PublishingGeneratedCopy = z.infer<typeof publishingGeneratedCopySchema>;
export type PublishingGenerationRequest = z.infer<typeof publishingGenerationRequestSchema>;
export type BulkSocialScheduleOutcome = z.infer<typeof bulkSocialScheduleOutcomeSchema>;
