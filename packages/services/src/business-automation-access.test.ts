import { describe, expect, test } from "bun:test";

import {
  authorizeBusinessAutomation,
  BusinessAutomationAccessError,
  type BusinessAutomationPrincipal,
} from "./business-automation-access";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "10000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000003";

const principal: BusinessAutomationPrincipal = {
  kind: "api_key",
  apiKeyId: "10000000-0000-4000-8000-000000000004",
  userId,
  workspaceId,
  scopes: ["brand:read"],
};

function actor(overrides: Partial<{
  status: "active" | "pending_payment" | "restricted";
  pricingTier: "free" | "creator" | "pro" | "business";
}> = {}) {
  return {
    userId,
    workspaceId,
    workspaceName: "Editorial",
    workspaceOwnerUserId: userId,
    role: "owner" as const,
    status: overrides.status ?? "active",
    pricingTier: overrides.pricingTier ?? "business",
    isPersonalWorkspace: false,
  };
}

describe("Business automation access", () => {
  test("rejects least-privilege scope misses before workspace access", async () => {
    let workspaceReads = 0;
    await expect(
      authorizeBusinessAutomation(
        principal,
        {
          requestedWorkspaceId: workspaceId,
          requiredScope: "brand:write",
          capability: "brand.manage",
          integration: "api",
        },
        {
          async requireActor() {
            workspaceReads += 1;
            return actor();
          },
          async getPersonalWorkspaceId() {
            return workspaceId;
          },
        },
      ),
    ).rejects.toEqual(
      new BusinessAutomationAccessError(
        "api_key_scope_required",
        "This API key requires the brand:write scope",
      ),
    );
    expect(workspaceReads).toBe(0);
  });

  test("rejects a workspace mismatch before workspace access", async () => {
    let workspaceReads = 0;
    await expect(
      authorizeBusinessAutomation(
        principal,
        {
          requestedWorkspaceId: otherWorkspaceId,
          requiredScope: "brand:read",
          capability: "content.view",
          integration: "api",
        },
        {
          async requireActor() {
            workspaceReads += 1;
            return actor();
          },
          async getPersonalWorkspaceId() {
            return workspaceId;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "workspace_boundary_violation" });
    expect(workspaceReads).toBe(0);
  });

  test.each([
    ["downgraded", actor({ pricingTier: "pro" })],
    ["restricted", actor({ status: "restricted" })],
  ])("blocks %s workspaces after current membership is checked", async (_name, current) => {
    await expect(
      authorizeBusinessAutomation(
        principal,
        {
          requestedWorkspaceId: workspaceId,
          requiredScope: "brand:read",
          capability: "content.view",
          integration: "api",
        },
        {
          async requireActor() {
            return current;
          },
          async getPersonalWorkspaceId() {
            return workspaceId;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "workspace_access_unavailable" });
  });

  test("keeps OAuth scope handling unchanged while enforcing Business MCP access", async () => {
    const current = await authorizeBusinessAutomation(
      {
        kind: "oauth",
        userId,
        clientId: "oauth-client",
        scopes: ["openid"],
      },
      {
        requestedWorkspaceId: workspaceId,
        requiredScope: "generated-media:submit",
        capability: "content.edit",
        integration: "mcp",
      },
      {
        async requireActor() {
          return actor();
        },
        async getPersonalWorkspaceId() {
          return workspaceId;
        },
      },
    );
    expect(current.workspaceId).toBe(workspaceId);
    expect(current.automationPrincipal).toEqual({
      kind: "oauth",
      clientId: "oauth-client",
    });
  });

  test("preserves an API-key principal after current workspace authorization", async () => {
    const current = await authorizeBusinessAutomation(
      principal,
      {
        requestedWorkspaceId: workspaceId,
        requiredScope: "brand:read",
        capability: "content.view",
        integration: "api",
      },
      {
        async requireActor() {
          return actor();
        },
        async getPersonalWorkspaceId() {
          return workspaceId;
        },
      },
    );

    expect(current.automationPrincipal).toEqual({
      kind: "api_key",
      apiKeyId: principal.apiKeyId,
    });
  });
});
