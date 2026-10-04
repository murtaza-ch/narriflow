import { describe, expect, test } from "bun:test";
import {
  ExpectedDomainFailureError,
  SocialPublicationRecoveryError,
  WorkspaceOperationError,
  type WorkspaceActorContext,
} from "@narriflow/services";
import { workspaceAllowsCapability, type WorkspaceCapability } from "@narriflow/validators";
import { MCP_TOOL_ADMISSIONS, McpToolAdmission, mcpToolFailure, type NarriflowMcpPrincipal, type NarriflowMcpToolName } from "./mcp-tool-admission";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const oauth: NarriflowMcpPrincipal = { kind: "oauth", userId: USER_ID, clientId: "oauth-client",
  scopes: ["projects:read", "exports:read", "usage:read", "autopilot:read", "autopilot:write", "publishing:read", "publishing:write", "processing:write", "exports:write"] };
const key: NarriflowMcpPrincipal = { kind: "api_key", userId: USER_ID, clientId: "key-client",
  apiKeyId: "key-id", workspaceId: WORKSPACE_ID, scopes: [] };

function fixture() {
  const actor: WorkspaceActorContext = { actorUserId: USER_ID, workspaceId: WORKSPACE_ID,
    workspaceName: "Team", workspaceOwnerUserId: "another-user", isPersonalWorkspace: false,
    role: "editor", status: "active", pricingTier: "business" };
  let member = true;
  const calls: Array<{ userId: string; workspaceId: string; capability: WorkspaceCapability }> = [];
  const reads: string[] = [];
  const admission = new McpToolAdmission({
    requireActor: async (userId, workspaceId, capability = "content.view") => {
      calls.push({ userId, workspaceId, capability });
      if (!member || userId !== USER_ID || workspaceId !== WORKSPACE_ID || !workspaceAllowsCapability(actor, capability)) {
        throw new WorkspaceOperationError("workspace_access_denied", "Current membership refuses this action");
      }
      return { ...actor };
    },
    getPersonalWorkspaceId: async (userId) => { reads.push(`personal:${userId}`); return WORKSPACE_ID; },
    getWorkspace: async (_userId, workspaceId) => {
      reads.push(`workspace:${workspaceId}`);
      return { id: WORKSPACE_ID, name: "Team", status: actor.status, pricingTier: actor.pricingTier,
        personalOwnerUserId: null, avatarStorageKey: null, timezone: "UTC", billingAccount: null, createdAt: new Date(0) };
    },
    listAccessibleWorkspaces: async (userId) => {
      reads.push(`memberships:${userId}`);
      return member ? [{ role: actor.role, workspace: { id: WORKSPACE_ID, name: "Team", status: actor.status,
        pricingTier: actor.pricingTier, personalOwnerUserId: null } }] : [];
    },
  });
  return { admission, actor, calls, reads, removeMembership: () => { member = false; } };
}

describe("MCP tool admission", () => {
  test("every workspace tool admits explicitly scoped OAuth with its current capability and real actor", async () => {
    const current = fixture();
    for (const tool of Object.keys(MCP_TOOL_ADMISSIONS) as NarriflowMcpToolName[]) {
      if (tool === "narriflow_list_workspaces") continue;
      const admitted = await current.admission.requireWorkspace(tool, oauth, WORKSPACE_ID);
      expect(admitted).toMatchObject({ actorUserId: USER_ID, workspaceId: WORKSPACE_ID, workspaceOwnerUserId: "another-user" });
      expect(current.calls.at(-1)).toEqual({ userId: USER_ID, workspaceId: WORKSPACE_ID, capability: MCP_TOOL_ADMISSIONS[tool].capability });
    }
    expect(current.calls.find((call) => call.capability === "processing.consume")).toBeDefined();
  });

  test("every scoped tool rejects a key before Workspace access when its application scope is absent", async () => {
    const current = fixture();
    for (const tool of Object.keys(MCP_TOOL_ADMISSIONS) as NarriflowMcpToolName[]) {
      if (tool === "narriflow_list_workspaces") continue;
      await expect(current.admission.requireWorkspace(tool, key)).rejects.toMatchObject({ code: "mcp_scope_required", kind: "forbidden" });
    }
    expect(current.calls).toEqual([]);
    expect(current.reads).toEqual([]);
  });

  test("each explicitly scoped key passes only its bound Workspace and never falls back to the owner's Workspace", async () => {
    const current = fixture();
    for (const tool of Object.keys(MCP_TOOL_ADMISSIONS) as NarriflowMcpToolName[]) {
      if (tool === "narriflow_list_workspaces") continue;
      const scopedKey = { ...key, scopes: [MCP_TOOL_ADMISSIONS[tool].apiKeyScope] };
      expect((await current.admission.requireWorkspace(tool, scopedKey)).workspaceId).toBe(WORKSPACE_ID);
      const calls = current.calls.length;
      await expect(current.admission.requireWorkspace(tool, scopedKey, "foreign-workspace")).rejects.toMatchObject({ code: "mcp_workspace_boundary_violation", kind: "forbidden" });
      expect(current.calls).toHaveLength(calls);
    }
    expect(current.reads).toEqual([]);
  });

  test("rechecks membership and role between calls instead of trusting an earlier admission", async () => {
    const current = fixture();
    await current.admission.requireWorkspace("narriflow_run_autopilot_rule_now", oauth, WORKSPACE_ID);
    current.actor.role = "viewer";
    await expect(current.admission.requireWorkspace("narriflow_run_autopilot_rule_now", oauth, WORKSPACE_ID)).rejects.toMatchObject({ code: "workspace_access_denied", kind: "forbidden" });
    expect((await current.admission.requireWorkspace("narriflow_get_project", oauth, WORKSPACE_ID)).role).toBe("viewer");
    current.removeMembership();
    await expect(current.admission.requireWorkspace("narriflow_get_project", oauth, WORKSPACE_ID)).rejects.toMatchObject({ code: "workspace_access_denied" });
    expect(current.calls).toHaveLength(4);
  });

  test("rechecks active Business entitlement and retains status capability denials", async () => {
    const current = fixture();
    await current.admission.requireWorkspace("narriflow_get_project", oauth, WORKSPACE_ID);
    current.actor.pricingTier = "pro";
    await expect(current.admission.requireWorkspace("narriflow_get_project", oauth, WORKSPACE_ID)).rejects.toMatchObject({ code: "mcp_workspace_access_unavailable", kind: "payment_required" });
    current.actor.pricingTier = "business";
    current.actor.role = "owner";
    current.actor.status = "restricted";
    await expect(current.admission.requireWorkspace("narriflow_get_project", oauth, WORKSPACE_ID)).rejects.toMatchObject({ code: "mcp_workspace_access_unavailable", kind: "payment_required" });
    await expect(current.admission.requireWorkspace("narriflow_run_autopilot_rule_now", oauth, WORKSPACE_ID)).rejects.toMatchObject({ code: "workspace_access_denied", kind: "forbidden" });
    current.actor.status = "active";
    expect((await current.admission.requireWorkspace("narriflow_get_project", oauth, WORKSPACE_ID)).status).toBe("active");
  });

  test("OAuth without a requested Workspace resolves its personal Workspace for that call", async () => {
    const current = fixture();
    await current.admission.requireWorkspace("narriflow_get_project", oauth);
    expect(current.reads).toEqual([`personal:${USER_ID}`]);
    expect(current.calls[0]!.userId).toBe(USER_ID);
  });

  test("OAuth discovery lists current memberships without Business and removal disappears on the next call", async () => {
    const current = fixture();
    current.actor.pricingTier = "free";
    current.actor.status = "pending_payment";
    const workspaces = await current.admission.listWorkspaces(oauth);
    expect(workspaces).toMatchObject([{ workspaceId: WORKSPACE_ID, status: "pending_payment", mcpEnabled: false }]);
    expect(current.calls).toEqual([]);
    current.removeMembership();
    expect(await current.admission.listWorkspaces(oauth)).toEqual([]);
    expect(current.reads).toEqual([`memberships:${USER_ID}`, `memberships:${USER_ID}`]);
  });

  test("key discovery needs no application scope or Business but preserves the content.view role/status check", async () => {
    const current = fixture();
    current.actor.pricingTier = "free";
    expect(await current.admission.listWorkspaces(key)).toMatchObject([{ workspaceId: WORKSPACE_ID, mcpEnabled: false }]);
    expect(current.calls).toEqual([{ userId: USER_ID, workspaceId: WORKSPACE_ID, capability: "content.view" }]);
    current.actor.status = "restricted";
    await expect(current.admission.listWorkspaces(key)).rejects.toMatchObject({ code: "workspace_access_denied" });
    expect(current.reads).toEqual([`workspace:${WORKSPACE_ID}`]);
    current.actor.role = "owner";
    expect(await current.admission.listWorkspaces(key)).toMatchObject([{ status: "restricted", mcpEnabled: false }]);
    current.removeMembership();
    await expect(current.admission.listWorkspaces(key)).rejects.toMatchObject({ code: "workspace_access_denied" });
    expect(current.reads).toHaveLength(2);
  });
});

describe("MCP expected failure translation", () => {
  test.each([
    ["invalid", "correct_request"], ["unprocessable", "correct_request"], ["forbidden", "request_access"],
    ["payment_required", "review_billing"], ["missing", "refresh_resource"], ["conflict", "refresh_state"],
    ["rate_limited", "retry_later"], ["unavailable", "retry_later"],
  ] as const)("maps %s with safe code and retry guidance", (kind, retryGuidance) => {
    const result = mcpToolFailure(new ExpectedDomainFailureError({ code: `fixture_${kind}`, kind,
      message: "A safe domain explanation", details: { workspaceId: WORKSPACE_ID }, retryAfterSeconds: 2.2 }));
    const payload = { error: `fixture_${kind}`, kind, message: "A safe domain explanation", retryGuidance,
      details: { workspaceId: WORKSPACE_ID }, retryAfterSeconds: 3 };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ data: payload });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(payload) }]);
  });

  test("bounds domain details and retry delays before the MCP response", () => {
    const result = mcpToolFailure(new ExpectedDomainFailureError({ code: "bounded", kind: "rate_limited", message: "Wait",
      details: { ...Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`field${index}`, "x".repeat(1_000)])) },
      retryAfterSeconds: 1_000_000 }));
    const payload = result.structuredContent.data;
    expect("details" in payload && Object.keys(payload.details!).length).toBe(16);
    expect("details" in payload && payload.details!.field0).toBe("x".repeat(240));
    expect("retryAfterSeconds" in payload && payload.retryAfterSeconds).toBe(86_400);
  });

  test("social recovery participates through the shared typed contract", () => {
    expect(mcpToolFailure(new SocialPublicationRecoveryError("social_publication_transition_conflict", "Refresh the publication")).structuredContent.data)
      .toEqual({ error: "social_publication_transition_conflict", kind: "conflict", message: "Refresh the publication", retryGuidance: "refresh_state" });
  });

  test.each([
    new Error("This API key requires leaked_database_secret scope"),
    new Error("This API key is bound to a different workspace"),
    new Error("Narriflow MCP internal connection password=secret"),
    { code: "forged", kind: "forbidden", message: "untrusted detail" },
    "secret stack trace",
  ])("unknown failures cannot acquire safe status by message or fields", (error) => {
    const result = mcpToolFailure(error);
    expect(result.structuredContent.data).toEqual({ error: "narriflow_tool_failed", message: "Narriflow tool failed without exposing internal details" });
    expect(result.content[0]!.text).not.toContain("secret");
  });
});
