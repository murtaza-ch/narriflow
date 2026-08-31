import { describe, expect, test } from "bun:test";

import {
  businessAutomationAssistedCopyStatusSchema,
  businessAutomationBulkScheduleStatusSchema,
  businessAutomationCampaignOperationStatusSchema,
  businessAutomationCampaignPreviewSchema,
  businessAutomationGeneratedMediaStatusSchema,
  businessAutomationReviewRoundCreatedSchema,
  businessAutomationReviewRoundListSchema,
  businessAutomationReviewRoundStatusSchema,
  businessAutomationThumbnailStatusSchema,
} from "./business-automation-contract";

function reviewRoundWithItem(item: {
  itemId: string | null;
  clipId: string | null;
  exportId: string | null;
}) {
  return {
    roundId: "10000000-0000-4000-8000-000000000003",
    revision: 1,
    status: "open",
    approvalRequired: true,
    allowDownloads: false,
    sentAt: null,
    expiresAt: null,
    revokedAt: null,
    supersededAt: null,
    decision: null,
    decidedAt: null,
    newerWorkAvailable: false,
    items: [{
      ...item,
      editorRevision: 1,
      required: true,
      currentDecision: null,
      newerWorkAvailable: false,
    }],
    notificationStatus: [],
    createdAt: null,
    updatedAt: null,
  };
}

function bulkScheduleWithItem(item: {
  itemKey: string | null;
  clipId: string | null;
  accountId: string | null;
}) {
  return {
    operationId: "10000000-0000-4000-8000-000000000004",
    status: "failed",
    counts: { scheduled: 0, failed: 1 },
    items: [{
      ...item,
      status: "failed",
      postId: null,
      scheduledFor: null,
      errorCode: "publication_failed",
    }],
    replayed: false,
  };
}

function generatedMediaStatus(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "10000000-0000-4000-8000-000000000005",
    projectId: "10000000-0000-4000-8000-000000000006",
    clipId: null,
    kind: "image",
    status: "queued",
    aspectRatio: "9:16",
    style: "editorial",
    durationSec: null,
    resultAssetId: null,
    insertionCount: 0,
    lastInsertionKind: null,
    lastInsertedAt: null,
    errorCode: null,
    moderationOutcome: "pending",
    createdAt: null,
    updatedAt: null,
    replayed: false,
    ...overrides,
  };
}

describe("business automation public status contracts", () => {
  const operationId = "10000000-0000-4000-8000-000000000001";
  const clipId = "10000000-0000-4000-8000-000000000002";

  test("rejects invented campaign and item states", () => {
    const base = {
      operationId,
      action: "create_review",
      status: "completed",
      requestedCount: 1,
      counts: { succeeded: 1, unchanged: 0, stale: 0, ineligible: 0, failed: 0 },
      items: [{
        clipId,
        expectedEditorRevision: 1,
        status: "succeeded",
        errorCode: null,
        settledAt: null,
      }],
      createdAt: null,
      completedAt: null,
      replayed: false,
    };
    expect(businessAutomationCampaignOperationStatusSchema.parse(base)).toEqual(base);
    expect(businessAutomationCampaignOperationStatusSchema.safeParse({
      ...base,
      status: "mystery",
    }).success).toBe(false);
    expect(businessAutomationCampaignOperationStatusSchema.safeParse({
      ...base,
      items: [{ ...base.items[0], status: "mystery" }],
    }).success).toBe(false);
  });

  test("rejects a null Campaign Operation identity", () => {
    const result = businessAutomationCampaignOperationStatusSchema.safeParse({
      operationId: null,
      action: "apply_motion",
      status: "completed",
      requestedCount: 0,
      counts: { succeeded: 0, unchanged: 0, stale: 0, ineligible: 0, failed: 0 },
      items: [],
      createdAt: null,
      completedAt: null,
      replayed: false,
    });

    expect(result.success).toBe(false);
  });

  test.each([
    ["Review Round mutation", businessAutomationReviewRoundCreatedSchema, {
      roundId: null,
      revision: 1,
      createdAt: null,
      replayed: false,
    }],
    ["Review Round resource", businessAutomationReviewRoundStatusSchema, {
      roundId: null,
      revision: 1,
      status: "open",
      approvalRequired: true,
      allowDownloads: false,
      sentAt: null,
      expiresAt: null,
      revokedAt: null,
      supersededAt: null,
      decision: null,
      decidedAt: null,
      newerWorkAvailable: false,
      items: [],
      notificationStatus: [],
      createdAt: null,
      updatedAt: null,
    }],
    ["assisted-copy draft", businessAutomationAssistedCopyStatusSchema, {
      draftId: null,
      clipId,
      platform: "youtube_shorts",
      status: "completed",
      revision: 1,
      content: null,
      confirmed: false,
      moderationOutcome: "accepted",
      modelAlias: null,
      promptVersion: null,
      guidanceSkipped: false,
      errorCode: null,
      replayed: false,
    }],
    ["Thumbnail Extraction job", businessAutomationThumbnailStatusSchema, {
      jobId: null,
      status: "queued",
      attempts: 0,
      platform: null,
      exportVariantId: operationId,
      sourceTimeMs: 0,
      errorCode: null,
      asset: null,
      replayed: false,
    }],
    ["Generated Media job", businessAutomationGeneratedMediaStatusSchema, {
      jobId: null,
      projectId: operationId,
      clipId: null,
      kind: "image",
      status: "queued",
      aspectRatio: "9:16",
      style: "editorial",
      durationSec: null,
      resultAssetId: null,
      insertionCount: 0,
      lastInsertionKind: null,
      lastInsertedAt: null,
      errorCode: null,
      moderationOutcome: "pending",
      createdAt: null,
      updatedAt: null,
      replayed: false,
    }],
    ["bulk-schedule operation", businessAutomationBulkScheduleStatusSchema, {
      operationId: null,
      status: "completed",
      counts: { scheduled: 0, failed: 0 },
      items: [],
      replayed: false,
    }],
  ])("rejects a null %s identity", (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  test.each([
    ["Campaign Operation item Clip", businessAutomationCampaignOperationStatusSchema, {
      operationId,
      action: "apply_motion",
      status: "completed",
      requestedCount: 1,
      counts: { succeeded: 1, unchanged: 0, stale: 0, ineligible: 0, failed: 0 },
      items: [{
        clipId: null,
        expectedEditorRevision: 1,
        status: "succeeded",
        errorCode: null,
        settledAt: null,
      }],
      createdAt: null,
      completedAt: null,
      replayed: false,
    }],
    ["campaign preview Clip", businessAutomationCampaignPreviewSchema, {
      action: "apply_style",
      requestedCount: 1,
      counts: { eligible: 1, unchanged: 0, stale: 0, ineligible: 0 },
      items: [{
        clipId: null,
        expectedEditorRevision: 1,
        currentEditorRevision: 1,
        status: "eligible",
        code: null,
      }],
    }],
    ["Review project", businessAutomationReviewRoundListSchema, {
      projectId: null,
      rounds: [],
    }],
    ["Review item", businessAutomationReviewRoundStatusSchema, reviewRoundWithItem({
      itemId: null,
      clipId,
      exportId: operationId,
    })],
    ["Review item Clip", businessAutomationReviewRoundStatusSchema, reviewRoundWithItem({
      itemId: operationId,
      clipId: null,
      exportId: operationId,
    })],
    ["Review item Export", businessAutomationReviewRoundStatusSchema, reviewRoundWithItem({
      itemId: operationId,
      clipId,
      exportId: null,
    })],
    ["assisted-copy Clip", businessAutomationAssistedCopyStatusSchema, {
      draftId: operationId,
      clipId: null,
      platform: "youtube_shorts",
      status: "completed",
      revision: 1,
      content: null,
      confirmed: false,
      moderationOutcome: "accepted",
      modelAlias: null,
      promptVersion: null,
      guidanceSkipped: false,
      errorCode: null,
      replayed: false,
    }],
    ["Thumbnail Export", businessAutomationThumbnailStatusSchema, {
      jobId: operationId,
      status: "queued",
      attempts: 0,
      platform: null,
      exportVariantId: null,
      sourceTimeMs: 0,
      errorCode: null,
      asset: null,
      replayed: false,
    }],
    ["Thumbnail asset", businessAutomationThumbnailStatusSchema, {
      jobId: operationId,
      status: "completed",
      attempts: 1,
      platform: "youtube_shorts",
      exportVariantId: operationId,
      sourceTimeMs: 0,
      errorCode: null,
      asset: {
        id: null,
        title: "Thumbnail",
        kind: "image",
        width: 1080,
        height: 1920,
        sizeBytes: 2048,
        fingerprint: "a".repeat(64),
      },
      replayed: false,
    }],
    ["Generated Media project", businessAutomationGeneratedMediaStatusSchema, {
      jobId: operationId,
      projectId: null,
      clipId: null,
      kind: "image",
      status: "queued",
      aspectRatio: "9:16",
      style: "editorial",
      durationSec: null,
      resultAssetId: null,
      insertionCount: 0,
      lastInsertionKind: null,
      lastInsertedAt: null,
      errorCode: null,
      moderationOutcome: "pending",
      createdAt: null,
      updatedAt: null,
      replayed: false,
    }],
    ["bulk-schedule item", businessAutomationBulkScheduleStatusSchema, bulkScheduleWithItem({
      itemKey: null,
      clipId,
      accountId: operationId,
    })],
    ["bulk-schedule item Clip", businessAutomationBulkScheduleStatusSchema, bulkScheduleWithItem({
      itemKey: operationId,
      clipId: null,
      accountId: operationId,
    })],
    ["bulk-schedule item account", businessAutomationBulkScheduleStatusSchema, bulkScheduleWithItem({
      itemKey: operationId,
      clipId,
      accountId: null,
    })],
  ])("rejects a null %s identity", (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  test("keeps optional relationship and outcome identities nullable", () => {
    const generatedMedia = businessAutomationGeneratedMediaStatusSchema.safeParse({
      jobId: operationId,
      projectId: operationId,
      clipId: null,
      kind: "image",
      status: "queued",
      aspectRatio: "9:16",
      style: "editorial",
      durationSec: null,
      resultAssetId: null,
      insertionCount: 0,
      lastInsertionKind: null,
      lastInsertedAt: null,
      errorCode: null,
      moderationOutcome: "pending",
      createdAt: null,
      updatedAt: null,
      replayed: false,
    });
    const failedBulkItem = businessAutomationBulkScheduleStatusSchema.safeParse(
      bulkScheduleWithItem({ itemKey: operationId, clipId, accountId: operationId }),
    );

    expect(generatedMedia.success).toBe(true);
    expect(failedBulkItem.success).toBe(true);
  });

  test.each([
    ["Campaign Operation action", businessAutomationCampaignOperationStatusSchema, {
      operationId,
      action: null,
      status: "completed",
      requestedCount: 0,
      counts: { succeeded: 0, unchanged: 0, stale: 0, ineligible: 0, failed: 0 },
      items: [],
      createdAt: null,
      completedAt: null,
      replayed: false,
    }],
    ["campaign preview action", businessAutomationCampaignPreviewSchema, {
      action: null,
      requestedCount: 0,
      counts: { eligible: 0, unchanged: 0, stale: 0, ineligible: 0 },
      items: [],
    }],
    ["assisted-copy platform", businessAutomationAssistedCopyStatusSchema, {
      draftId: operationId,
      clipId,
      platform: null,
      status: "completed",
      revision: 1,
      content: null,
      confirmed: false,
      moderationOutcome: "accepted",
      modelAlias: null,
      promptVersion: null,
      guidanceSkipped: false,
      errorCode: null,
      replayed: false,
    }],
    ["Thumbnail Extraction platform", businessAutomationThumbnailStatusSchema, {
      jobId: operationId,
      status: "queued",
      attempts: 0,
      platform: null,
      exportVariantId: operationId,
      sourceTimeMs: 0,
      errorCode: null,
      asset: null,
      replayed: false,
    }],
    ["Generated Media kind", businessAutomationGeneratedMediaStatusSchema,
      generatedMediaStatus({ kind: null })],
    ["Generated Media aspect ratio", businessAutomationGeneratedMediaStatusSchema,
      generatedMediaStatus({ aspectRatio: null })],
    ["Generated Media style", businessAutomationGeneratedMediaStatusSchema,
      generatedMediaStatus({ style: null })],
    ["Review notification kind", businessAutomationReviewRoundStatusSchema, {
      ...reviewRoundWithItem({ itemId: operationId, clipId, exportId: operationId }),
      notificationStatus: [{
        kind: null,
        status: "pending",
        attemptCount: 0,
        failureCode: null,
        sentAt: null,
      }],
    }],
  ])("rejects a null %s discriminator", (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  test("rejects invented review and generated-media lifecycle states", () => {
    expect(businessAutomationReviewRoundStatusSchema.safeParse({
      roundId: operationId,
      revision: 1,
      status: "mystery",
      approvalRequired: true,
      allowDownloads: false,
      sentAt: null,
      expiresAt: null,
      revokedAt: null,
      supersededAt: null,
      decision: null,
      decidedAt: null,
      newerWorkAvailable: false,
      items: [],
      notificationStatus: [],
      createdAt: null,
      updatedAt: null,
    }).success).toBe(false);
    expect(businessAutomationReviewRoundStatusSchema.safeParse({
      ...reviewRoundWithItem({
        itemId: operationId,
        clipId,
        exportId: operationId,
      }),
      notificationStatus: [{
        kind: "invented_notification",
        status: "pending",
        attemptCount: 0,
        failureCode: null,
        sentAt: null,
      }],
    }).success).toBe(false);
    expect(businessAutomationGeneratedMediaStatusSchema.safeParse({
      jobId: operationId,
      projectId: operationId,
      clipId: null,
      kind: "image",
      status: "mystery",
      aspectRatio: "9:16",
      style: "editorial",
      durationSec: null,
      resultAssetId: null,
      insertionCount: 0,
      lastInsertionKind: null,
      lastInsertedAt: null,
      errorCode: null,
      moderationOutcome: "pending",
      createdAt: null,
      updatedAt: null,
      replayed: false,
    }).success).toBe(false);
  });
});
