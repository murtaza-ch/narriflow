import { describe, expect, test } from "bun:test";

import { createProductionAssistedCopyAuthorization } from "./assisted-copy.prisma";

const scope = {
  actorUserId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  projectId: "10000000-0000-4000-8000-000000000003",
};

describe("production assisted-copy authorization", () => {
  test("reads saved drafts with content-view access after downgrade or restriction", async () => {
    const capabilities: string[] = [];
    let writeGateChecks = 0;
    const authorization = createProductionAssistedCopyAuthorization({
      async requireActor(_actorUserId, _workspaceId, capability) {
        capabilities.push(capability);
        return { pricingTier: "free" };
      },
      assertWriteEnabled() {
        writeGateChecks += 1;
      },
    });

    await expect(authorization.authorizeRead(scope)).resolves.toBeUndefined();
    expect(capabilities).toEqual(["content.view"]);
    expect(writeGateChecks).toBe(0);
  });

  test("keeps generation behind rollout, publishing permission, and plan entitlement", async () => {
    const capabilities: string[] = [];
    let writeGateChecks = 0;
    const authorization = createProductionAssistedCopyAuthorization({
      async requireActor(_actorUserId, _workspaceId, capability) {
        capabilities.push(capability);
        return { pricingTier: "free" };
      },
      assertWriteEnabled() {
        writeGateChecks += 1;
      },
    });

    await expect(authorization.authorize(scope)).rejects.toMatchObject({
      code: "assisted_copy_feature_unavailable",
    });
    expect(writeGateChecks).toBe(1);
    expect(capabilities).toEqual(["publishing.manage"]);
  });

  test("admits generation when rollout, publishing permission, and entitlement pass", async () => {
    const capabilities: string[] = [];
    let writeGateChecks = 0;
    const authorization = createProductionAssistedCopyAuthorization({
      async requireActor(_actorUserId, _workspaceId, capability) {
        capabilities.push(capability);
        return { pricingTier: "creator" };
      },
      assertWriteEnabled() {
        writeGateChecks += 1;
      },
    });

    await expect(authorization.authorize(scope)).resolves.toBeUndefined();
    expect(writeGateChecks).toBe(1);
    expect(capabilities).toEqual(["publishing.manage"]);
  });
});
