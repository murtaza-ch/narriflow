import { describe, expect, test } from "bun:test";

import { generatedMediaAnalyticsEventSchema } from "./analytics";

const completion = {
  type: "generated_asset_completed" as const,
  projectId: "00000000-0000-4000-8000-000000000001",
  clipId: "00000000-0000-4000-8000-000000000002",
  metadata: {
    kind: "image" as const,
    providerAlias: "openai-image",
    modelAlias: "configured-image-alias",
    status: "completed" as const,
    latencyBucket: "under_1m" as const,
    retryCount: 0,
    moderationOutcome: "passed" as const,
    usageUnits: 1,
    outcome: "succeeded" as const,
    planTier: "creator" as const,
  },
};

describe("generated media analytics", () => {
  test("accepts only the approved non-content completion dimensions", () => {
    expect(generatedMediaAnalyticsEventSchema.parse(completion)).toEqual(completion);
  });

  test("requires insertion action only on insertion events", () => {
    expect(
      generatedMediaAnalyticsEventSchema.safeParse({
        ...completion,
        type: "generated_asset_inserted",
      }).success,
    ).toBe(false);
    expect(
      generatedMediaAnalyticsEventSchema.safeParse({
        ...completion,
        type: "generated_asset_inserted",
        metadata: { ...completion.metadata, insertionAction: "scene_block" },
      }).success,
    ).toBe(true);
  });

  test.each([
    ["prompt", "Generate a private portrait"],
    ["sourceTranscript", "The full source transcript"],
    ["resultUrl", "https://signed.example.test/result.png?token=secret"],
    ["providerPayload", { raw: "provider response" }],
  ])("rejects prohibited generated-media metadata field %s", (key, value) => {
    expect(
      generatedMediaAnalyticsEventSchema.safeParse({
        ...completion,
        metadata: { ...completion.metadata, [key]: value },
      }).success,
    ).toBe(false);
  });

  test("rejects URLs even when placed in an otherwise approved field", () => {
    expect(
      generatedMediaAnalyticsEventSchema.safeParse({
        ...completion,
        metadata: {
          ...completion.metadata,
          modelAlias: "https://signed.example.test/model?token=secret",
        },
      }).success,
    ).toBe(false);
  });
});
