import { describe, expect, test } from "bun:test";
import { generatedImageCapability, generationAccessForTier } from "./generation-usage";

const scope = {
  actorUserId: "user-1",
  workspaceId: "workspace-1",
  workspaceOwnerUserId: "user-1",
  role: "owner" as const,
  status: "active" as const,
  pricingTier: "creator",
  isPersonalWorkspace: true,
};

describe("generation access", () => {
  test("separates entitlement from metered usage settlement", () => {
    expect(generationAccessForTier("free", "image")).toEqual({
      entitled: true,
      usage: "trial_metered",
    });
    expect(generationAccessForTier("creator", "image")).toEqual({
      entitled: true,
      usage: "metered",
    });
    expect(generationAccessForTier("creator", "video")).toEqual({
      entitled: false,
      usage: "metered",
    });
    expect(generationAccessForTier("pro", "video")).toEqual({
      entitled: true,
      usage: "metered",
    });
  });

  test("admits entitled plans when the production write group is enabled", () => {
    expect(generatedImageCapability(scope, { NARRIFLOW_WRITES_GENERATED_MEDIA: "1" })).toMatchObject({
      available: true,
      reason: "available",
    });
    expect(generatedImageCapability(
      { ...scope, pricingTier: "free" },
      { NARRIFLOW_WRITES_GENERATED_MEDIA: "1" },
    )).toMatchObject({ available: true, reason: "available", usage: "trial_metered" });
    expect(generatedImageCapability(scope, {
      NARRIFLOW_WRITES_GENERATED_MEDIA: "0",
    })).toMatchObject({ available: false, reason: "rollout_disabled" });
  });
});
