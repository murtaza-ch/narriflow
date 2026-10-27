import {
  boundedExpectedDomainFailureDetails,
  hasFeature,
  INTEGRATION_ACCESS_MESSAGES,
  INTEGRATION_COMMANDS,
  IntegrationAdmission,
  isExpectedDomainFailure,
  operationReadScope,
  type ExpectedDomainFailureKind,
  type IntegrationCommand,
  type IntegrationPrincipal,
  type WorkspaceService,
} from "@narriflow/services";
import type { WorkspaceApiKeyScope } from "@narriflow/validators";

export type NarriflowMcpPrincipal = IntegrationPrincipal & {
  /** Server-only evidence for continuation revalidation. The verifier makes
   * this non-enumerable; only encrypted evidence enters signed state. */
  oauthAccessToken?: string;
};

export const MCP_WORKSPACE_ACCESS_MESSAGE = INTEGRATION_ACCESS_MESSAGES.mcp;

/** Each workspace tool is one integration command; discovery is MCP-only. */
export const MCP_TOOL_COMMANDS = {
  narriflow_confirm_social_publication: "confirm_social_publication",
  narriflow_create_rss_autopilot_rule: "create_rss_autopilot_rule",
  narriflow_get_project: "get_project",
  narriflow_get_social_publication: "get_social_publication",
  narriflow_get_workspace_usage: "get_workspace_usage",
  narriflow_list_autopilot_rules: "list_autopilot_rules",
  narriflow_list_projects: "list_projects",
  narriflow_list_workspaces: null,
  narriflow_run_autopilot_rule_now: "run_autopilot_rule_now",
  narriflow_publish_social_publication_again: "publish_social_publication_again",
  narriflow_recheck_social_publication: "recheck_social_publication",
  narriflow_submit_video: "submit_video",
  narriflow_create_captioned_video: "create_captioned_video",
  narriflow_upload_video: "open_upload",
  narriflow_generate_clips: "generate_clips",
  narriflow_search_library: "search_library",
  narriflow_list_clips: "list_clips",
  narriflow_get_clip: "get_clip",
  narriflow_create_clip_export: "create_clip_export",
  narriflow_get_clip_export: "get_clip_export",
  narriflow_list_social_accounts: "list_social_accounts",
  narriflow_get_publishing_options: "get_publishing_options",
  narriflow_prepare_social_post: "prepare_social_post",
  narriflow_propose_social_post: "propose_social_post",
  narriflow_schedule_social_post: "schedule_social_post",
  narriflow_list_social_publications: "list_social_publications",
  narriflow_get_operation: "get_operation",
  narriflow_list_events: "list_events",
  narriflow_get_export_download: "get_export_download",
  narriflow_get_clip_timeline: "get_clip_timeline",
  narriflow_list_brand_profiles: "list_brand_profiles",
  narriflow_list_recipes: "list_recipes",
  narriflow_create_review_handoff: "create_review_handoff",
  narriflow_list_review_rounds: "list_review_rounds",
  narriflow_get_review_round: "get_review_round",
} as const satisfies Record<string, IntegrationCommand | null>;

export type NarriflowMcpToolName = keyof typeof MCP_TOOL_COMMANDS;
type WorkspaceToolName = Exclude<NarriflowMcpToolName, "narriflow_list_workspaces">;

/** Operation Status reads use the scope of the work they describe. */
export const mcpOperationReadScope = operationReadScope;
/** Embedded transfer actions use the same grants as their owning public tool. */
export function mcpToolRequiredScope(name: string, args?: unknown): WorkspaceApiKeyScope | null {
  if (["narriflow_upload_open", "narriflow_upload_status", "narriflow_upload_grants", "narriflow_upload_finalize", "narriflow_upload_discard"].includes(name)) return "processing:write";
  if (name === "narriflow_accept_social_post_intent") return "publishing:write";
  if (name === "narriflow_get_operation") {
    const operation = args && typeof args === "object" ? (args as { operation?: unknown }).operation : undefined;
    return operationReadScope(operation && typeof operation === "object" ? (operation as { kind?: unknown }).kind : undefined);
  }
  const command = MCP_TOOL_COMMANDS[name as NarriflowMcpToolName];
  return command ? INTEGRATION_COMMANDS[command].scope : null;
}

type WorkspaceAdmission = Pick<WorkspaceService,
  "requireActor" | "getPersonalWorkspaceId" | "getWorkspace" | "listAccessibleWorkspaces"
>;

export class McpToolAdmission {
  private readonly integration: IntegrationAdmission;
  constructor(private readonly workspace: WorkspaceAdmission) {
    this.integration = new IntegrationAdmission(workspace);
  }

  /** `scope` replaces the tool's scope for a tool whose subject decides it. */
  async requireWorkspace(tool: WorkspaceToolName, principal: NarriflowMcpPrincipal, requestedWorkspaceId?: string, scope?: WorkspaceApiKeyScope) {
    return this.integration.requireWorkspace(MCP_TOOL_COMMANDS[tool], principal, { surface: "mcp", workspaceId: requestedWorkspaceId, scope });
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
  if (error.code === "credits_exhausted") {
    const renewal = typeof details.renewsAt === "string" ? ` Credits renew on ${details.renewsAt.slice(0, 10)} (UTC).` : "";
    return typeof details.requestedCredits === "number" && typeof details.remainingCredits === "number" && details.remainingCredits > 0
      ? `This video needs ${details.requestedCredits} credits, but the workspace has ${details.remainingCredits} of ${details.limitCredits} left this month.${renewal}`
      : `The workspace has used its ${details.limitCredits ?? "monthly"} credits for this month.${renewal}`;
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
