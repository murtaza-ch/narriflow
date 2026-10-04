import {
  boundedExpectedDomainFailureDetails,
  ExpectedDomainFailureError,
  hasFeature,
  isExpectedDomainFailure,
  type ExpectedDomainFailureCatalog,
  type ExpectedDomainFailureKind,
  type WorkspaceService,
} from "@narriflow/services";
import type { WorkspaceApiKeyScope, WorkspaceCapability } from "@narriflow/validators";

export type NarriflowMcpPrincipal =
  | { kind: "oauth"; userId: string; clientId: string; scopes: string[] }
  | { kind: "api_key"; userId: string; clientId: string; apiKeyId: string; workspaceId: string; scopes: string[] };

type McpToolAdmissionPolicy =
  | { admission: "workspace"; capability: WorkspaceCapability; apiKeyScope: WorkspaceApiKeyScope }
  | { admission: "discovery"; capability: null; apiKeyScope: null };

export const MCP_TOOL_ADMISSIONS = {
  narriflow_confirm_social_publication: { admission: "workspace", capability: "publishing.manage", apiKeyScope: "publishing:write" },
  narriflow_create_rss_autopilot_rule: { admission: "workspace", capability: "content.edit", apiKeyScope: "autopilot:write" },
  narriflow_get_project: { admission: "workspace", capability: "content.view", apiKeyScope: "projects:read" },
  narriflow_get_social_publication: { admission: "workspace", capability: "content.view", apiKeyScope: "publishing:read" },
  narriflow_get_workspace_usage: { admission: "workspace", capability: "content.view", apiKeyScope: "usage:read" },
  narriflow_list_autopilot_rules: { admission: "workspace", capability: "content.view", apiKeyScope: "autopilot:read" },
  narriflow_list_projects: { admission: "workspace", capability: "content.view", apiKeyScope: "projects:read" },
  narriflow_list_workspaces: { admission: "discovery", capability: null, apiKeyScope: null },
  narriflow_run_autopilot_rule_now: { admission: "workspace", capability: "processing.consume", apiKeyScope: "autopilot:write" },
  narriflow_publish_social_publication_again: { admission: "workspace", capability: "publishing.manage", apiKeyScope: "publishing:write" },
  narriflow_recheck_social_publication: { admission: "workspace", capability: "publishing.manage", apiKeyScope: "publishing:write" },
} as const satisfies Record<string, McpToolAdmissionPolicy>;

export type NarriflowMcpToolName = keyof typeof MCP_TOOL_ADMISSIONS;
type WorkspaceToolName = Exclude<NarriflowMcpToolName, "narriflow_list_workspaces">;

const admissionFailureKinds = {
  mcp_api_key_scope_required: "forbidden",
  mcp_workspace_boundary_violation: "forbidden",
  mcp_workspace_access_unavailable: "payment_required",
} as const satisfies ExpectedDomainFailureCatalog<string>;

class McpAdmissionFailure extends ExpectedDomainFailureError<keyof typeof admissionFailureKinds> {
  constructor(code: keyof typeof admissionFailureKinds, message: string) {
    super({ code, kind: admissionFailureKinds[code], message });
  }
}

type WorkspaceAdmission = Pick<WorkspaceService,
  "requireActor" | "getPersonalWorkspaceId" | "getWorkspace" | "listAccessibleWorkspaces"
>;

export class McpToolAdmission {
  constructor(private readonly workspace: WorkspaceAdmission) {}

  async requireWorkspace(tool: WorkspaceToolName, principal: NarriflowMcpPrincipal, requestedWorkspaceId?: string) {
    const policy = MCP_TOOL_ADMISSIONS[tool];
    if (principal.kind === "api_key") {
      if (!principal.scopes.includes(policy.apiKeyScope)) {
        throw new McpAdmissionFailure("mcp_api_key_scope_required", `This API key requires the ${policy.apiKeyScope} scope`);
      }
      if (requestedWorkspaceId && requestedWorkspaceId !== principal.workspaceId) {
        throw new McpAdmissionFailure("mcp_workspace_boundary_violation", "This API key is bound to a different workspace");
      }
    }
    const workspaceId = principal.kind === "api_key"
      ? principal.workspaceId
      : requestedWorkspaceId ?? await this.workspace.getPersonalWorkspaceId(principal.userId);
    const actor = await this.workspace.requireActor(principal.userId, workspaceId, policy.capability);
    if (actor.status !== "active" || !hasFeature(actor.pricingTier, "integrations.mcp")) {
      throw new McpAdmissionFailure("mcp_workspace_access_unavailable", "Narriflow MCP workspace access requires an active Business plan");
    }
    return actor;
  }

  async listWorkspaces(principal: NarriflowMcpPrincipal) {
    if (principal.kind === "api_key") {
      // Discovery has no application scope or plan gate. Keep the existing
      // key-bound content.view role/status check before reading Workspace facts.
      const actor = await this.workspace.requireActor(principal.userId, principal.workspaceId, "content.view");
      const workspace = await this.workspace.getWorkspace(principal.userId, principal.workspaceId);
      return workspace ? [{ ...workspace, role: actor.role,
        mcpEnabled: actor.status === "active" && hasFeature(actor.pricingTier, "integrations.mcp") }] : [];
    }
    const memberships = await this.workspace.listAccessibleWorkspaces(principal.userId);
    return memberships.map(({ role, workspace }) => ({
      id: workspace.id, name: workspace.name, role, status: workspace.status, pricingTier: workspace.pricingTier,
      isPersonal: workspace.personalOwnerUserId === principal.userId,
      mcpEnabled: workspace.status === "active" && hasFeature(workspace.pricingTier, "integrations.mcp"),
    }));
  }
}

const failureRetryGuidance = {
  invalid: "correct_request",
  unprocessable: "correct_request",
  forbidden: "request_access",
  payment_required: "review_billing",
  missing: "refresh_resource",
  conflict: "refresh_state",
  rate_limited: "retry_later",
  unavailable: "retry_later",
} as const satisfies Record<ExpectedDomainFailureKind, string>;

export function mcpToolFailure(error: unknown) {
  const details = isExpectedDomainFailure(error) ? boundedExpectedDomainFailureDetails(error.details) : undefined;
  const payload = isExpectedDomainFailure(error)
    ? { error: error.code, kind: error.kind, message: error.message, retryGuidance: failureRetryGuidance[error.kind],
        ...(details ? { details } : {}),
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }
    : { error: "narriflow_tool_failed", message: "Narriflow tool failed without exposing internal details" };
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: { data: payload } };
}
