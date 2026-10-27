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

  test("admits included image generation without deployment switches", () => {
    expect(generatedImageCapability(scope)).toMatchObject({ available: true, reason: "available", usage: "metered" });
    expect(generatedImageCapability({ ...scope, pricingTier: "free" })).toMatchObject({ available: true, reason: "available", usage: "trial_metered" });
  });
});
