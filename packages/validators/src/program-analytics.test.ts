import { describe, expect, test } from "bun:test";
import {
  brandProgramAnalyticsEventSchema,
  recordAnalyticsEventSchema,
} from "./analytics";

describe("program analytics metadata", () => {
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
