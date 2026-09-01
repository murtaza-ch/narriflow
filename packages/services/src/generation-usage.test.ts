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

  test("keeps rollout closed until an internal user or tier is explicitly enabled", () => {
    expect(generatedImageCapability(scope, { NARRIFLOW_WRITES_GENERATED_MEDIA: "1" })).toMatchObject({
      available: false,
      reason: "tier_not_enabled",
    });
    expect(generatedImageCapability(scope, {
      NARRIFLOW_WRITES_GENERATED_MEDIA: "1",
      GENERATED_IMAGE_INTERNAL_USER_IDS: "user-1",
    })).toMatchObject({ available: true, reason: "available" });
    expect(generatedImageCapability(scope, {
      NARRIFLOW_WRITES_GENERATED_MEDIA: "1",
      GENERATED_IMAGE_ALLOWED_TIERS: "creator",
    })).toMatchObject({ available: true, reason: "available" });
    expect(generatedImageCapability(scope, {
      NARRIFLOW_WRITES_GENERATED_MEDIA: "0",
      GENERATED_IMAGE_ALLOWED_TIERS: "creator",
    })).toMatchObject({ available: false, reason: "rollout_disabled" });
  });
});
