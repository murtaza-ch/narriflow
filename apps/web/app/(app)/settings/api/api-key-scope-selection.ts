import type { WorkspaceApiKeyScope } from "@narriflow/validators";

export const DEFAULT_WORKSPACE_API_KEY_SCOPES = [
  "projects:read",
  "exports:read",
  "usage:read",
  "autopilot:read",
] as const satisfies readonly WorkspaceApiKeyScope[];

export function resolveWorkspaceApiKeyScopes(
  selected: Iterable<WorkspaceApiKeyScope>,
): WorkspaceApiKeyScope[] {
  return [...new Set([...DEFAULT_WORKSPACE_API_KEY_SCOPES, ...selected])];
}
