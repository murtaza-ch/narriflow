import { describe, expect, test } from "bun:test";

import {
  assistedCopyViewSchema,
  bulkScheduleResultSchema,
  bulkScheduleAutomationSchema,
  bulkScheduleSchema,
  confirmAssistedCopySchema,
  generateAssistedCopySchema,
  listThumbnailExtractionsSchema,
  requestThumbnailExtractionSchema,
  thumbnailExtractionViewSchema,
} from "./publishing-preparation";

const uuid = (suffix: string) => `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("publishing preparation contracts", () => {
  test("accepts only complete assisted-copy views from a successful response", () => {
    const view = {
      id: uuid("01"),
      clipId: uuid("02"),
      platform: "tiktok",
      sourceDraftId: null,
      status: "completed",
      revision: 1,
      content: { caption: "Launch day", hashtags: ["launch"], title: null },
      confirmed: false,
      moderationOutcome: "accepted",
      modelAlias: "configured-copy-alias",
      promptVersion: "assisted-copy-v1",
      guidanceSkipped: false,
      errorCode: null,
      replayed: false,
    };

    expect(assistedCopyViewSchema.safeParse(view).success).toBe(true);
    const { replayed: _replayed, ...incomplete } = view;
    expect(assistedCopyViewSchema.safeParse(incomplete).success).toBe(false);
  });

  test("rejects inconsistent bulk scheduling results", () => {
    const result = {
      operationId: uuid("03"),
      status: "completed",
      counts: { scheduled: 1, failed: 0 },
      items: [
        {
          itemKey: uuid("04"),
          clipId: uuid("05"),
          accountId: uuid("06"),
          status: "scheduled",
          postId: uuid("07"),
          scheduledFor: "2026-09-01T09:00:00.000Z",
          errorCode: null,
        },
      ],
      replayed: false,
    };

    expect(bulkScheduleResultSchema.safeParse(result).success).toBe(true);
    expect(
      bulkScheduleResultSchema.safeParse({
        ...result,
        counts: { scheduled: 0, failed: 1 },
      }).success,
    ).toBe(false);
  });

  test("accepts only complete thumbnail extraction views", () => {
    const view = {
      id: uuid("30"),
      status: "completed",
      attempts: 1,
      platform: "tiktok",
      exportVariantId: uuid("31"),
      sourceTimeMs: 1_000,
      errorCode: null,
      asset: {
        id: uuid("32"),
        workspaceId: uuid("33"),
        createdByUserId: uuid("34"),
        title: "Opening frame",
        kind: "image",
        contentType: "image/jpeg",
        sizeBytes: 1_024,
        width: 1_080,
        height: 1_920,
        fingerprint: "a".repeat(64),
        provenance: "extracted",
        sourceExportVariantId: uuid("31"),
        sourceTimeMs: 1_000,
        createdAt: "2026-08-31T12:00:00.000Z",
      },
      replayed: false,
    };

    expect(thumbnailExtractionViewSchema.safeParse(view).success).toBe(true);
    expect(
      thumbnailExtractionViewSchema.safeParse({ ...view, attempts: -1 }).success,
    ).toBe(false);
  });

  test("keeps assisted-copy generation bounded and idempotent", () => {
    expect(
      generateAssistedCopySchema.parse({
        idempotencyKey: uuid("1"),
        clipId: uuid("2"),
        platform: "instagram_reels",
        campaignNote: "Keep the proof point concrete.",
      }),
    ).toMatchObject({ lockedTerms: [] });
    expect(
      generateAssistedCopySchema.safeParse({
        idempotencyKey: "not-a-key",
        clipId: uuid("2"),
        platform: "instagram_reels",
        campaignNote: "x",
      }).success,
    ).toBe(false);
  });

  test("normalizes confirmed hashtags without accepting empty copy", () => {
    expect(
      confirmAssistedCopySchema.parse({
        expectedRevision: 1,
        content: { caption: "Proof.", hashtags: ["#editing"], title: null },
      }).content.hashtags,
    ).toEqual(["editing"]);
    expect(
      confirmAssistedCopySchema.safeParse({
        expectedRevision: 1,
        content: { caption: " ", hashtags: [], title: null },
      }).success,
    ).toBe(false);
  });

  test("bounds frame extraction and bulk scheduling payloads", () => {
    expect(
      requestThumbnailExtractionSchema.safeParse({
        idempotencyKey: uuid("1"),
        platform: "youtube_shorts",
        exportVariantId: uuid("3"),
        sourceTimeSec: -1,
        title: "Frame",
      }).success,
    ).toBe(false);
    expect(
      bulkScheduleSchema.safeParse({
        idempotencyKey: uuid("4"),
        timezone: "UTC",
        startDate: "2026-09-01",
        postingWindow: { startTime: "09:00", endTime: "11:00", frequencyMinutes: 60 },
        items: [],
      }).success,
    ).toBe(false);
  });

  test("parses a bounded, unique exact-export list for thumbnail hydration", () => {
    expect(
      listThumbnailExtractionsSchema.parse({
        platform: "tiktok",
        exportVariantIds: `${uuid("1")},${uuid("2")},${uuid("1")}`,
      }),
    ).toEqual({
      platform: "tiktok",
      exportVariantIds: [uuid("1"), uuid("2")],
    });
    expect(
      listThumbnailExtractionsSchema.safeParse({
        platform: "tiktok",
        exportVariantIds: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  test("keeps approval overrides out of the public automation contract", () => {
    const item = {
      itemKey: uuid("10"),
      occurrenceIndex: 0,
      clipId: uuid("11"),
      expectedEditorRevision: 1,
      exportVariantId: uuid("12"),
      accountId: uuid("13"),
      platform: "linkedin",
      assistedCopyDraftId: uuid("14"),
      assistedCopyRevision: 1,
      aspectRatio: "9:16",
      resolution: "1080p",
      durationSec: 30,
      thumbnailAssetId: null,
    };
    const request = {
      idempotencyKey: uuid("15"),
      timezone: "UTC",
      startDate: "2026-09-01",
      postingWindow: {
        startTime: "09:00",
        endTime: "11:00",
        frequencyMinutes: 60,
      },
      items: [item],
    };

    expect(bulkScheduleAutomationSchema.safeParse(request).success).toBe(true);
    expect(
      bulkScheduleAutomationSchema.safeParse({
        ...request,
        items: [{ ...item, occurrenceIndex: 100 }],
      }).success,
    ).toBe(false);
    expect(
      bulkScheduleAutomationSchema.safeParse({
        ...request,
        items: [item, { ...item, itemKey: uuid("16") }],
      }).success,
    ).toBe(false);
    expect(
      bulkScheduleAutomationSchema.safeParse({
        ...request,
        items: [{ ...item, approvalOverrideReason: "Bypass client review" }],
      }).success,
    ).toBe(false);
    expect(
      bulkScheduleSchema.safeParse({
        ...request,
        items: [{ ...item, approvalOverrideReason: "Owner browser override" }],
      }).success,
    ).toBe(true);
  });
});
