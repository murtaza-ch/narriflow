import { expect, test } from "bun:test";
import {
	bulkSocialScheduleOutcomeSchema,
	publishingDraftSchema,
	savedPublishingSchema,
	savedPublishingCopiesSchema,
	savedPublishingGenerationRequestsSchema,
} from "./publishing-composition";

const clipId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const postId = "00000000-0000-4000-8000-000000000003";
const draft = {
	caption: "My editable description", title: "My title", variantId: null,
	deliveryMode: "direct", settings: { youtubePrivacyStatus: "public" }, thumbnail: null,
	revision: 4, edited: true, generated: false, editVersion: 1, reviewedRevision: 4,
};
const saved = {
	drafts: { [`${clipId}:${accountId}`]: draft }, accountIds: [accountId],
	timing: { scheduleMode: "now", startDate: "2026-10-04", timeZone: "Asia/Karachi", postingWindow: { start: "09:00", end: "17:00" }, frequency: { unit: "days", value: 1 }, dstDisambiguation: null },
};
const accepted = {
	clipId, accountId, status: "succeeded", socialPostId: postId, errorCode: null, retryable: false,
};
const outcome = { status: "completed", items: [accepted], counts: { succeeded: 1, failed: 0, ineligible: 0 } };

test("validates an editable Publishing Draft independently of its submission request", () => {
	expect(savedPublishingSchema.parse(saved)).toEqual(saved);
	// Unfinished copy may exceed a provider's admission limit without losing the draft.
	expect(publishingDraftSchema.parse({ ...draft, caption: "x".repeat(6_000), title: "" }).caption).toHaveLength(6_000);
	expect(publishingDraftSchema.safeParse({ ...draft, revision: -1 }).success).toBe(false);
	expect(publishingDraftSchema.safeParse({ ...draft, variantId: "not-a-variant-id" }).success).toBe(false);
});

test("validates persisted copy and generation records separately from the draft", () => {
	const copy = { id: postId, platform: "youtube_shorts", caption: "Generated description", hashtags: ["#Narriflow"], title: null };
	const copies = { [`${clipId}:4:youtube_shorts`]: copy };
	const generations = { [`${clipId}:4:youtube_shorts`]: { key: accountId, signature: '{"editorRevision":4}' } };
	expect(savedPublishingCopiesSchema.parse(copies)).toEqual(copies);
	expect(savedPublishingGenerationRequestsSchema.parse(generations)).toEqual(generations);
	expect(savedPublishingCopiesSchema.safeParse({ corrupt: { ...copy, hashtags: [12] } }).success).toBe(false);
	expect(savedPublishingGenerationRequestsSchema.safeParse({ corrupt: { key: accountId, signature: 12 } }).success).toBe(false);
	expect(savedPublishingSchema.safeParse(saved).success).toBe(true);
});

test("reads the current bulk transport projection without changing its server metadata", () => {
	const wire = { ...outcome, id: postId, workspaceId: accountId, replayed: true, createdAt: "2026-10-04T00:00:00Z", items: [{ ...accepted, id: accountId, requestKey: "hash", expectedEditorRevision: 4 }] };
	expect(bulkSocialScheduleOutcomeSchema.parse(wire)).toEqual(outcome);
	expect(wire.replayed).toBe(true);
});

test("rejects false acceptance from missing identities, duplicate pairs, or unsupported statuses", () => {
	expect(bulkSocialScheduleOutcomeSchema.safeParse({ ...outcome, items: [{ ...accepted, socialPostId: null }] }).success).toBe(false);
	expect(bulkSocialScheduleOutcomeSchema.safeParse({ ...outcome, items: [accepted, accepted], counts: { succeeded: 2, failed: 0, ineligible: 0 } }).success).toBe(false);
	expect(bulkSocialScheduleOutcomeSchema.safeParse({ ...outcome, items: [{ ...accepted, status: "unchanged" }] }).success).toBe(false);
	expect(bulkSocialScheduleOutcomeSchema.safeParse({ ...outcome, items: [{ ...accepted, socialPostId: "unknown-post" }] }).success).toBe(false);
});

test("accepts running partial progress and rejects unfinished terminal outcomes", () => {
	const progress = { status: "running", items: [accepted, { ...accepted, accountId: postId, status: "processing", socialPostId: null }], counts: { succeeded: 1, failed: 0, ineligible: 0 } };
	expect(bulkSocialScheduleOutcomeSchema.safeParse(progress).success).toBe(true);
	expect(bulkSocialScheduleOutcomeSchema.safeParse({ ...progress, status: "completed" }).success).toBe(false);
});

test("validates response counts against the actual outcome items", () => {
	expect(bulkSocialScheduleOutcomeSchema.safeParse({ ...outcome, counts: { succeeded: 0, failed: 0, ineligible: 0 } }).success).toBe(false);
	expect(bulkSocialScheduleOutcomeSchema.safeParse({ ...outcome, counts: { succeeded: 1, failed: -1, ineligible: 0 } }).success).toBe(false);
	const failure = { ...accepted, status: "ineligible", socialPostId: null, errorCode: "review_approval_required" };
	expect(bulkSocialScheduleOutcomeSchema.safeParse({ status: "partial", items: [accepted, { ...failure, accountId: postId }], counts: { succeeded: 1, failed: 0, ineligible: 1 } }).success).toBe(true);
});
