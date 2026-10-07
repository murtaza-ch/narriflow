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
  /** `expiresAt` is the access token's expiration in epoch seconds. */
  | { kind: "oauth"; userId: string; clientId: string; scopes: string[]; expiresAt?: number }
  | { kind: "api_key"; userId: string; clientId: string; apiKeyId: string; workspaceId: string; scopes: string[] };

/** Names the requirement only. Assistant directories forbid upgrade prompts
 * and checkout links in connector responses. */
export const MCP_WORKSPACE_ACCESS_MESSAGE = "This workspace needs active Business access to use the Narriflow connector";

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
  narriflow_submit_video: { admission: "workspace", capability: "processing.consume", apiKeyScope: "processing:write" },
  narriflow_upload_video: { admission: "workspace", capability: "processing.consume", apiKeyScope: "processing:write" },
  narriflow_generate_clips: { admission: "workspace", capability: "processing.consume", apiKeyScope: "processing:write" },
  narriflow_list_clips: { admission: "workspace", capability: "content.view", apiKeyScope: "projects:read" },
  narriflow_get_clip: { admission: "workspace", capability: "content.view", apiKeyScope: "projects:read" },
  narriflow_create_clip_export: { admission: "workspace", capability: "processing.consume", apiKeyScope: "exports:write" },
  narriflow_get_clip_export: { admission: "workspace", capability: "content.download", apiKeyScope: "exports:read" },
  narriflow_list_social_accounts: { admission: "workspace", capability: "content.view", apiKeyScope: "publishing:read" },
  narriflow_get_publishing_options: { admission: "workspace", capability: "content.view", apiKeyScope: "publishing:read" },
  narriflow_prepare_social_post: { admission: "workspace", capability: "publishing.manage", apiKeyScope: "publishing:write" },
  narriflow_schedule_social_post: { admission: "workspace", capability: "publishing.manage", apiKeyScope: "publishing:write" },
  narriflow_list_social_publications: { admission: "workspace", capability: "content.view", apiKeyScope: "publishing:read" },
  /** Export operations require `exports:read` instead; see `requireWorkspace`'s scope override. */
  narriflow_get_operation: { admission: "workspace", capability: "content.view", apiKeyScope: "projects:read" },
  narriflow_get_export_download: { admission: "workspace", capability: "content.download", apiKeyScope: "exports:read" },
  narriflow_list_brand_profiles: { admission: "workspace", capability: "content.view", apiKeyScope: "projects:read" },
  narriflow_create_review_handoff: { admission: "workspace", capability: "content.view", apiKeyScope: "exports:read" },
  narriflow_list_review_rounds: { admission: "workspace", capability: "content.view", apiKeyScope: "exports:read" },
  narriflow_get_review_round: { admission: "workspace", capability: "content.view", apiKeyScope: "exports:read" },
} as const satisfies Record<string, McpToolAdmissionPolicy>;

export type NarriflowMcpToolName = keyof typeof MCP_TOOL_ADMISSIONS;
/** Operation Status reads use the scope of the work they describe. */
export function mcpOperationReadScope(kind: unknown): WorkspaceApiKeyScope {
  return kind === "export" ? "exports:read" : "projects:read";
}
/** Embedded transfer actions use the same grants as their owning public tool. */
export function mcpToolRequiredScope(name: string, args?: unknown): WorkspaceApiKeyScope | null {
  if (["narriflow_upload_open", "narriflow_upload_status", "narriflow_upload_grants", "narriflow_upload_finalize", "narriflow_upload_discard"].includes(name)) return "processing:write";
  if (name === "narriflow_accept_social_post_intent") return "publishing:write";
  if (name === "narriflow_get_operation") {
    const operation = args && typeof args === "object" ? (args as { operation?: unknown }).operation : undefined;
    return mcpOperationReadScope(operation && typeof operation === "object" ? (operation as { kind?: unknown }).kind : undefined);
  }
  return MCP_TOOL_ADMISSIONS[name as NarriflowMcpToolName]?.apiKeyScope ?? null;
}
type WorkspaceToolName = Exclude<NarriflowMcpToolName, "narriflow_list_workspaces">;

const admissionFailureKinds = {
  mcp_scope_required: "forbidden",
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

  /** `scope` replaces the tool's scope for a tool whose subject decides it. */
  async requireWorkspace(tool: WorkspaceToolName, principal: NarriflowMcpPrincipal, requestedWorkspaceId?: string, scope: WorkspaceApiKeyScope = MCP_TOOL_ADMISSIONS[tool].apiKeyScope) {
    const policy = MCP_TOOL_ADMISSIONS[tool];
    if (!principal.scopes.includes(scope)) {
      throw new McpAdmissionFailure("mcp_scope_required", `This credential requires the ${scope} scope`);
    }
    if (principal.kind === "api_key") {
      if (requestedWorkspaceId && requestedWorkspaceId !== principal.workspaceId) {
        throw new McpAdmissionFailure("mcp_workspace_boundary_violation", "This API key is bound to a different workspace");
      }
    }
    const workspaceId = principal.kind === "api_key"
      ? principal.workspaceId
      : requestedWorkspaceId ?? await this.workspace.getPersonalWorkspaceId(principal.userId);
    const actor = await this.workspace.requireActor(principal.userId, workspaceId, policy.capability);
    if (actor.status !== "active" || !hasFeature(actor.pricingTier, "integrations.mcp")) {
      throw new McpAdmissionFailure("mcp_workspace_access_unavailable", MCP_WORKSPACE_ACCESS_MESSAGE);
    }
    return actor;
  }

  async listWorkspaces(principal: NarriflowMcpPrincipal) {
    if (principal.kind === "api_key") {
      // Discovery has no application scope or plan gate. Keep the existing
      // key-bound content.view role/status check before reading Workspace facts.
      const actor = await this.workspace.requireActor(principal.userId, principal.workspaceId, "content.view");
      const workspace = await this.workspace.getWorkspace(principal.userId, principal.workspaceId);
      return workspace ? [{ workspaceId: workspace.id, name: workspace.name, role: actor.role,
        status: workspace.status, pricingTier: workspace.pricingTier,
        isPersonal: workspace.personalOwnerUserId === principal.userId,
        mcpEnabled: actor.status === "active" && hasFeature(actor.pricingTier, "integrations.mcp") }] : [];
    }
    const memberships = await this.workspace.listAccessibleWorkspaces(principal.userId);
    return memberships.map(({ role, workspace }) => ({
      workspaceId: workspace.id, name: workspace.name, role, status: workspace.status, pricingTier: workspace.pricingTier,
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

/** Assistant directories forbid sales prompts in connector responses. Domain
 * failures written for the web app are restated as the requirement alone; the
 * code and limit details still travel with the failure. */
export function mcpFailureMessage(error: { code: string; message: string; details?: unknown }) {
  const details = (error.details && typeof error.details === "object" ? error.details : {}) as Record<string, unknown>;
  if (error.code === "processing_quota_exhausted") {
    return typeof details.requestedMinutes === "number" && typeof details.remainingMinutes === "number" && details.remainingMinutes > 0
      ? `This video needs ${details.requestedMinutes} processing minutes, but the workspace has ${details.remainingMinutes} of ${details.limitMinutes} left this month.`
      : `The workspace has used its ${details.limitMinutes ?? "monthly"} processing minutes for this month. Minutes renew next month.`;
  }
  if (error.code === "upload_too_long" && typeof details.maxSeconds === "number") {
    return `This video is longer than the workspace's ${Math.round(details.maxSeconds / 60)}-minute per-video limit.`;
  }
  return error.message;
}

export function mcpToolFailure(error: unknown) {
  const details = isExpectedDomainFailure(error) ? boundedExpectedDomainFailureDetails(error.details) : undefined;
  const payload = isExpectedDomainFailure(error)
    ? { error: error.code, kind: error.kind, message: mcpFailureMessage(error), retryGuidance: failureRetryGuidance[error.kind],
        ...(details ? { details } : {}),
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }
    : { error: "narriflow_tool_failed", message: "Narriflow tool failed without exposing internal details" };
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: { data: payload } };
}
