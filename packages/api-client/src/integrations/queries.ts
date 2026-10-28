import { queryOptions } from "@tanstack/react-query";
import { type ApiTransport, type IdentityScope, type WorkspaceScope, scopedKey, sessionKey, sha256Hex, STALE_TIME } from "../core";
import { createIntegrationsClient } from "./client";

export { sha256Hex as mcpContinuationDigest };

export function mcpStatusQueryOptions(input: { transport: ApiTransport; scope: WorkspaceScope }) {
  return queryOptions({
    queryKey: scopedKey(input.scope, "integrations", "mcp-status"),
    queryFn: async ({ signal }) => (await createIntegrationsClient(input.transport.scoped(input.scope)).integrations.mcp.status.$get(undefined, { init: { signal } })).json(),
    staleTime: STALE_TIME.config,
  });
}

/** Only the SHA-256 digest of the signed continuation belongs in a cache key. */
export function mcpPreparationQueryOptions(input: { transport: ApiTransport; scope: IdentityScope; token: string; digest: string }) {
  return queryOptions({
    queryKey: sessionKey(input.scope, "mcp-preparation", input.digest),
    queryFn: async ({ signal }) => (await createIntegrationsClient(input.transport.identity(input.scope)).integrations.mcp.preparations.$get({ query: { token: input.token } }, { init: { signal } })).json(),
    staleTime: 0, gcTime: 0, retry: false,
  });
}

export function mcpUploadHandoffQueryOptions(input: { transport: ApiTransport; scope: IdentityScope; intent: string; digest: string }) {
  return queryOptions({
    queryKey: sessionKey(input.scope, "mcp-upload-handoff", input.digest),
    queryFn: async ({ signal }) => (await createIntegrationsClient(input.transport.identity(input.scope)).integrations.mcp["upload-handoff"].$get({ query: { intent: input.intent } }, { init: { signal } })).json(),
    staleTime: 0, gcTime: 0, retry: false,
  });
}
