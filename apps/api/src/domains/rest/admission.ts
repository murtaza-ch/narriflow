import type { IntegrationCommand } from "@narriflow/services";
import type { AdmissionTable } from "../platform/admission-table";

/** REST is outside the first-party inventory; its complete API-key command table is below. */
export const restAdmission = {} as const satisfies AdmissionTable;

/** Every REST endpoint admits exactly one integration command, so its scope
 * and Workspace capability match MCP and the browser peer. */
export const REST_ENDPOINT_COMMANDS = {
  "GET /workspace": "get_workspace_usage",
  "GET /brand-profiles": "list_brand_profiles",
  "GET /recipes": "list_recipes",
  "GET /recipes/{id}": "list_recipes",
  "POST /uploads": "open_upload",
  "GET /uploads/{id}": "open_upload",
  "POST /uploads/{id}/grants": "open_upload",
  "POST /uploads/{id}/finalize": "open_upload",
  "DELETE /uploads/{id}": "open_upload",
  "POST /projects": "submit_video",
  "POST /captioned-videos": "create_captioned_video",
  "GET /projects": "list_projects",
  "GET /projects/{id}": "get_project",
  "GET /library/search": "search_library",
  "POST /projects/{id}/generations": "generate_clips",
  "GET /projects/{id}/clips": "list_clips",
  "GET /clips/{id}": "get_clip",
  "GET /clips/{id}/timeline": "get_clip_timeline",
  "POST /clips/{id}/exports": "create_clip_export",
  "GET /exports/{id}": "get_clip_export",
  "GET /exports/{id}/download": "get_export_download",
  "GET /operations/{id}": "get_operation",
  "GET /social-accounts": "list_social_accounts",
  "POST /social-posts/proposals": "propose_social_post",
  "GET /events": "list_events",
  "GET /webhooks": "list_webhooks",
  "POST /webhooks": "manage_webhooks",
  "DELETE /webhooks/{id}": "manage_webhooks",
  "POST /webhooks/{id}/enable": "manage_webhooks",
  "POST /webhooks/{id}/test": "manage_webhooks",
  "POST /operations/{id}/callback/redeliver": "redeliver_callback",
} as const satisfies Record<string, IntegrationCommand>;
export type RestEndpoint = keyof typeof REST_ENDPOINT_COMMANDS;
