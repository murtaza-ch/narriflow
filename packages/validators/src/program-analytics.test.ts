import { describe, expect, test } from "bun:test";
import {
  brandProgramAnalyticsEventSchema,
  campaignCompletionIntervalReportSchema,
  recordAnalyticsEventSchema,
} from "./analytics";

describe("program analytics metadata", () => {
  test.each([
    "assisted_copy_generated",
    "assisted_copy_confirmed",
    "thumbnail_prepared",
  ] as const)("accepts the content-free publishing preparation event %s", (type) => {
    expect(
      recordAnalyticsEventSchema.parse({
        type,
        clipId: crypto.randomUUID(),
        platform: "youtube_shorts",
        metadata: {
          outcome: "succeeded",
          featureVersion: "publishing-preparation-v1",
          modelAlias: "configured-copy-alias",
          moderationOutcome: "accepted",
          usageUnits: 42,
        },
      }).type,
    ).toBe(type);
  });

  test("accepts the approved campaign interval and bounded guardrail metadata", () => {
    expect(
      recordAnalyticsEventSchema.parse({
        type: "campaign_scheduled",
        metadata: {
          workspaceId: "4d119c8d-acde-4d95-82a4-0e61210e61db",
          selectedCount: 8,
          platform: "instagram_reels",
          outcome: "approved",
          durationBucket: "under_24h",
          featureVersion: 1,
          guardrails: { revisionCount: 2, approvalOverrides: 0 },
        },
      }).type,
    ).toBe("campaign_scheduled");
  });

  test("accepts exhaustive lifecycle counts and a content-free completion report", () => {
    expect(
      recordAnalyticsEventSchema.parse({
        type: "campaign_operation_completed",
        metadata: {
          campaignOperationId: crypto.randomUUID(),
          kind: "bulk_schedule",
          selectedCount: 5,
          requestedCount: 5,
          succeededCount: 3,
          unchangedCount: 0,
          staleCount: 0,
          ineligibleCount: 1,
          failedCount: 1,
          scheduledCount: 3,
          approvalOverrides: 1,
          outcome: "partial",
          featureVersion: "approved-campaign-v1",
        },
      }).type,
    ).toBe("campaign_operation_completed");

    expect(
      campaignCompletionIntervalReportSchema.parse({
        windowStart: "2026-08-01T00:00:00.000Z",
        windowEnd: "2026-09-01T00:00:00.000Z",
        eligibleProjects: 4,
        scheduledProjects: 3,
        completionRate: 0.75,
        scheduledDeliverables: 8,
        approvalOverrides: 1,
        overriddenProjects: 1,
        approvalOverrideProjectRate: 1 / 3,
        durationSeconds: { median: 3600, p90: 7200 },
        reviewRevisions: { projectsWithRounds: 3, median: 2, p90: 3 },
        publicationAttempts: {
          terminal: 10,
          succeeded: 8,
          failed: 1,
          needsAttention: 1,
          failureRate: 0.2,
          byPlatform: [
            {
              platform: "instagram_reels",
              terminal: 10,
              succeeded: 8,
              failed: 1,
              needsAttention: 1,
              failureRate: 0.2,
            },
          ],
        },
        generatedProviderOutcomes: {
          terminal: 5,
          completed: 3,
          failed: 1,
          rejected: 1,
          failureRate: 0.2,
          rejectionRate: 0.2,
          byProviderKind: [
            {
              providerAlias: "openai-image",
              kind: "image",
              terminal: 5,
              completed: 3,
              failed: 1,
              rejected: 1,
              failureRate: 0.2,
              rejectionRate: 0.2,
            },
          ],
        },
      }),
    ).toEqual(
      expect.objectContaining({
        eligibleProjects: 4,
        scheduledProjects: 3,
        completionRate: 0.75,
      }),
    );
  });

  test("keeps the completion report aggregate-only", () => {
    expect(() =>
      campaignCompletionIntervalReportSchema.parse({
        windowStart: "2026-08-01T00:00:00.000Z",
        windowEnd: "2026-09-01T00:00:00.000Z",
        eligibleProjects: 1,
        scheduledProjects: 1,
        completionRate: 1,
        scheduledDeliverables: 1,
        approvalOverrides: 0,
        overriddenProjects: 0,
        approvalOverrideProjectRate: 0,
        durationSeconds: { median: 60, p90: 60 },
        reviewRevisions: { projectsWithRounds: 1, median: 1, p90: 1 },
        publicationAttempts: {
          terminal: 1,
          succeeded: 1,
          failed: 0,
          needsAttention: 0,
          failureRate: 0,
          byPlatform: [],
        },
        generatedProviderOutcomes: {
          terminal: 0,
          completed: 0,
          failed: 0,
          rejected: 0,
          failureRate: 0,
          rejectionRate: 0,
          byProviderKind: [],
        },
        projectIds: [crypto.randomUUID()],
      }),
    ).toThrow();
  });

  test.each([
    "transcript",
    "prompt",
    "comment",
    "reviewerEmail",
    "reviewerIdentity",
    "token",
    "passcode",
    "signedUrl",
  ])("rejects sensitive metadata key recursively: %s", (key) => {
    expect(() =>
      recordAnalyticsEventSchema.parse({
        type: "review_opened",
        metadata: { safe: { nested: { [key]: "secret" } } },
      }),
    ).toThrow();
  });

  test("rejects metadata outside the approved recursive allowlist", () => {
    expect(() =>
      recordAnalyticsEventSchema.parse({
        type: "campaign_scheduled",
        metadata: { workspaceId: crypto.randomUUID(), arbitraryPayload: true },
      }),
    ).toThrow();
  });

  test("rejects publishing preparation content and URLs", () => {
    expect(() =>
      recordAnalyticsEventSchema.parse({
        type: "assisted_copy_generated",
        metadata: { prompt: "private campaign note" },
      }),
    ).toThrow();
    expect(() =>
      recordAnalyticsEventSchema.parse({
        type: "thumbnail_prepared",
        metadata: { asset: "https://signed.example.test/private.jpg" },
      }),
    ).toThrow();
  });

  test("rejects URL content even when placed under an allowed metadata key", () => {
    expect(() =>
      recordAnalyticsEventSchema.parse({
        type: "review_opened",
        metadata: { outcome: "https://review.example/secret-token" },
      }),
    ).toThrow();
  });

  test("limits brand-program metadata to identifiers, kind, plan, and outcome", () => {
    expect(
      brandProgramAnalyticsEventSchema.parse({
        type: "brand_profile_applied",
        workspaceId: crypto.randomUUID(),
        actorUserId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        metadata: {
          profileId: crypto.randomUUID(),
          assetKind: "profile",
          planTier: "business",
          outcome: "succeeded",
        },
      }).type,
    ).toBe("brand_profile_applied");
    expect(() =>
      brandProgramAnalyticsEventSchema.parse({
        type: "brand_profile_applied",
        workspaceId: crypto.randomUUID(),
        actorUserId: crypto.randomUUID(),
        metadata: { profileId: crypto.randomUUID(), profileName: "secret" },
      }),
    ).toThrow();
  });
});
