import type { QueryClient } from "@tanstack/query-core";
import { queryOptions } from "@tanstack/react-query";
import { type ApiTransport, invalidateScoped, scopedKey, STALE_TIME, type WorkspaceScope } from "../core";
import { createDeveloperClient } from "./client";

const key = (scope: WorkspaceScope, resource: string) => scopedKey(scope, "developer", resource);

/**
 * Everything the Developer access page shows: keys, signing status and webhooks
 * in one request. The page's readers hold `api.manage`; others get a refusal.
 */
export function developerSettingsQuery(transport: ApiTransport, scope: WorkspaceScope) {
  const client = createDeveloperClient(transport.scoped(scope));
  return queryOptions({
    queryKey: key(scope, "settings"),
    queryFn: async ({ signal }) => (await client.developer.settings.$get({}, { init: { signal } })).json(),
    staleTime: STALE_TIME.default,
  });
}

/**
 * The Integrations page: connected accounts, plus a key count and the signing
 * status only for a member who may manage the API (otherwise `null`; nothing
 * private was read). It seeds the publishing accounts query, which has the same
 * shape, so Social accounts opens without a second fetch.
 */
export function integrationsOverviewQuery(transport: ApiTransport, scope: WorkspaceScope) {
  const client = createDeveloperClient(transport.scoped(scope));
  return queryOptions({
    queryKey: key(scope, "overview"),
    queryFn: async ({ signal, client: queryClient }) => {
      const overview = await (await client.integrations.$get({}, { init: { signal } })).json();
      // Same key as the publishing domain's accounts read, and the same `{ accounts }` shape.
      queryClient.setQueryData(scopedKey(scope, "publishing", "accounts"), { accounts: overview.accounts });
      return overview;
    },
    staleTime: STALE_TIME.default,
  });
}

/**
 * A key, secret or webhook changed: the settings read and the overview badges.
 * One-time plaintext is never in these reads.
 */
export function invalidateDeveloper(queryClient: QueryClient, scope: WorkspaceScope): Promise<void> {
  return invalidateScoped(queryClient, scope, "developer");
}
