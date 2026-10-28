import type { QueryClient } from "@tanstack/query-core";
import { queryOptions } from "@tanstack/react-query";
import { type ApiTransport, type IdentityScope, invalidateSession, sessionKey, STALE_TIME } from "../core";
import { createSessionClient } from "./client";

/**
 * Identity bootstrap. The effective Workspace comes from the hint the browser
 * kept for this user; a removed one falls back to the personal Workspace and is
 * reported as `selection.workspaceSelectionChanged`. The hint travels as a query
 * parameter because identity-only requests never carry `X-Workspace-Id`; the
 * server validates it against live membership either way.
 */
export function sessionBootstrapQuery(
  transport: ApiTransport,
  scope: IdentityScope,
  selectedWorkspaceId?: string | null,
) {
  const client = createSessionClient(transport.identity(scope));
  return queryOptions({
    queryKey: sessionKey(scope, "bootstrap"),
    queryFn: async ({ signal }) => {
      const response = await client.session.bootstrap.$get(
        { query: selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {} },
        { init: { signal } },
      );
      return response.json();
    },
    staleTime: STALE_TIME.default,
  });
}

/**
 * An invitation preview. The raw token is a credential, so the key carries only
 * its digest: compute it once with `sha256Hex(token)` and pass both.
 */
export function inviteQuery(
  transport: ApiTransport,
  scope: IdentityScope,
  invite: { token: string; digest: string },
) {
  const client = createSessionClient(transport.identity(scope));
  return queryOptions({
    queryKey: sessionKey(scope, "invite", invite.digest),
    queryFn: async ({ signal }) => {
      const response = await client.invites[":token"].$get(
        { param: { token: invite.token } },
        { init: { signal } },
      );
      return response.json();
    },
    // A single-use link: do not refetch it behind the person's back.
    staleTime: STALE_TIME.default,
    retry: false,
  });
}

export function invalidateSessionBootstrap(queryClient: QueryClient, scope: IdentityScope): Promise<void> {
  return invalidateSession(queryClient, scope, "bootstrap");
}
