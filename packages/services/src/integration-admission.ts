import type { WorkspaceApiKeyScope, WorkspaceCapability } from "@narriflow/validators";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";
import { hasFeature, type PlanFeature } from "./plan-features";
import type { WorkspaceService } from "./workspace.service";

/** A credential calling Narriflow from outside the browser. API keys are bound
 * to one Workspace; OAuth tokens act wherever their user is a member. */
export type IntegrationPrincipal =
  /** `expiresAt` is the access token's expiration in epoch seconds. */
  | { kind: "oauth"; userId: string; clientId: string; scopes: string[]; expiresAt?: number }
  | { kind: "api_key"; userId: string; clientId: string; apiKeyId: string; workspaceId: string; scopes: string[] };

export type IntegrationSurface = "mcp" | "rest";

/** One admission table for every integration transport: each canonical
 * command requires the same Workspace capability as its browser peer and one
 * application scope. MCP tools and REST endpoints map onto these commands. */
export const INTEGRATION_COMMANDS = {
  get_workspace_usage: { capability: "content.view", scope: "usage:read" },
  list_projects: { capability: "content.view", scope: "projects:read" },
  get_project: { capability: "content.view", scope: "projects:read" },
  list_brand_profiles: { capability: "content.view", scope: "projects:read" },
  submit_video: { capability: "processing.consume", scope: "processing:write" },
  /** Also admits the Upload Session's status, grants, finalize, and discard. */
  open_upload: { capability: "processing.consume", scope: "processing:write" },
  generate_clips: { capability: "processing.consume", scope: "processing:write" },
  list_clips: { capability: "content.view", scope: "projects:read" },
  get_clip: { capability: "content.view", scope: "projects:read" },
  create_clip_export: { capability: "processing.consume", scope: "exports:write" },
  get_clip_export: { capability: "content.download", scope: "exports:read" },
  get_export_download: { capability: "content.download", scope: "exports:read" },
  /** Reads use the scope of the work they describe; see `operationReadScope`. */
  get_operation: { capability: "content.view", scope: "projects:read" },
  /** Redelivery uses the scope of the original mutation; see `operationWriteScope`. */
  redeliver_callback: { capability: "processing.consume", scope: "processing:write" },
  create_review_handoff: { capability: "content.view", scope: "exports:read" },
  list_review_rounds: { capability: "content.view", scope: "exports:read" },
  get_review_round: { capability: "content.view", scope: "exports:read" },
  list_social_accounts: { capability: "content.view", scope: "publishing:read" },
  get_publishing_options: { capability: "content.view", scope: "publishing:read" },
  prepare_social_post: { capability: "publishing.manage", scope: "publishing:write" },
  schedule_social_post: { capability: "publishing.manage", scope: "publishing:write" },
  list_social_publications: { capability: "content.view", scope: "publishing:read" },
  get_social_publication: { capability: "content.view", scope: "publishing:read" },
  recheck_social_publication: { capability: "publishing.manage", scope: "publishing:write" },
  confirm_social_publication: { capability: "publishing.manage", scope: "publishing:write" },
  publish_social_publication_again: { capability: "publishing.manage", scope: "publishing:write" },
  list_autopilot_rules: { capability: "content.view", scope: "autopilot:read" },
  create_rss_autopilot_rule: { capability: "content.edit", scope: "autopilot:write" },
  run_autopilot_rule_now: { capability: "processing.consume", scope: "autopilot:write" },
} as const satisfies Record<string, { capability: WorkspaceCapability; scope: WorkspaceApiKeyScope }>;

export type IntegrationCommand = keyof typeof INTEGRATION_COMMANDS;

/** Both surfaces are Business features. */
export const INTEGRATION_SURFACE_FEATURES = {
  mcp: "integrations.mcp",
  rest: "integrations.api",
} as const satisfies Record<IntegrationSurface, PlanFeature>;

/** Names the requirement only. Assistant directories forbid upgrade prompts
 * and checkout links in connector responses. */
export const INTEGRATION_ACCESS_MESSAGES = {
  mcp: "This workspace needs active Business access to use the Narriflow connector",
  rest: "This workspace needs active Business access to use the Narriflow API",
} as const satisfies Record<IntegrationSurface, string>;

export function operationReadScope(kind: unknown): WorkspaceApiKeyScope {
  return kind === "export" ? "exports:read" : "projects:read";
}

export function operationWriteScope(kind: unknown): WorkspaceApiKeyScope {
  return kind === "export" ? "exports:write" : "processing:write";
}

const admissionFailureKinds = {
  scope_required: "forbidden",
  workspace_boundary_violation: "forbidden",
  integration_access_unavailable: "payment_required",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type IntegrationAdmissionFailureCode = keyof typeof admissionFailureKinds;

export class IntegrationAdmissionError extends ExpectedDomainFailureError<
  IntegrationAdmissionFailureCode,
  { scope: string }
> {
  constructor(code: IntegrationAdmissionFailureCode, message: string, details?: { scope: string }) {
    super({ code, kind: admissionFailureKinds[code], message, details });
    this.name = "IntegrationAdmissionError";
  }
}

type WorkspaceAdmission = Pick<WorkspaceService, "requireActor" | "getPersonalWorkspaceId">;

export class IntegrationAdmission {
  constructor(private readonly workspace: WorkspaceAdmission) {}

  /** Admits one command: application scope first, then the key's Workspace
   * boundary, then the user's current membership, role, and plan. `scope`
   * replaces the command's scope when the subject decides it. */
  async requireWorkspace(
    command: IntegrationCommand,
    principal: IntegrationPrincipal,
    options: { surface: IntegrationSurface; workspaceId?: string; scope?: WorkspaceApiKeyScope },
  ) {
    const policy = INTEGRATION_COMMANDS[command];
    const scope = options.scope ?? policy.scope;
    if (!principal.scopes.includes(scope)) {
      throw new IntegrationAdmissionError("scope_required", `This credential requires the ${scope} scope`, { scope });
    }
    if (principal.kind === "api_key" && options.workspaceId && options.workspaceId !== principal.workspaceId) {
      throw new IntegrationAdmissionError("workspace_boundary_violation", "This API key is bound to a different workspace");
    }
    const workspaceId = principal.kind === "api_key"
      ? principal.workspaceId
      : options.workspaceId ?? await this.workspace.getPersonalWorkspaceId(principal.userId);
    const actor = await this.workspace.requireActor(principal.userId, workspaceId, policy.capability);
    if (actor.status !== "active" || !hasFeature(actor.pricingTier, INTEGRATION_SURFACE_FEATURES[options.surface])) {
      throw new IntegrationAdmissionError("integration_access_unavailable", INTEGRATION_ACCESS_MESSAGES[options.surface]);
    }
    return actor;
  }
}
