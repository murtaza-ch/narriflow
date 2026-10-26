import { describe, expect, test } from "bun:test";
import { generatedImageCapability, generatedImagePolicy } from "./generation-usage";

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
  test("Free meters the lifetime image sample; paid plans meter by month", () => {
    expect(generatedImagePolicy("free")).toBe("trial_metered");
    expect(generatedImagePolicy("creator")).toBe("metered");
    expect(generatedImagePolicy("business")).toBe("metered");
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
