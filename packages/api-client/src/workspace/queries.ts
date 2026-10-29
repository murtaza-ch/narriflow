import type { QueryClient } from "@tanstack/query-core";
import type { SessionBootstrap } from "@narriflow/validators/api/session";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import { queryOptions } from "@tanstack/react-query";
import {
  type ApiTransport,
  invalidateScoped,
  invalidateSession,
  scopedKey,
  STALE_TIME,
  type WorkspaceScope,
} from "../core";
import { createWorkspaceClient } from "./client";

const key = (scope: WorkspaceScope, resource: string) => scopedKey(scope, "workspace", resource);

/**
 * What the app shell needs: profile, memberships, capabilities and usage in one
 * request. It seeds the usage query, which has the same shape, so the credits
 * chip does not fetch a second time.
 */
export function workspaceBootstrapQuery(transport: ApiTransport, scope: WorkspaceScope) {
  const client = createWorkspaceClient(transport.scoped(scope));
  return queryOptions({
    queryKey: key(scope, "bootstrap"),
    queryFn: async ({ signal, client: queryClient }) => {
      const response = await client.workspace.bootstrap.$get({}, { init: { signal } });
      const bootstrap = await response.json();
      queryClient.setQueryData(key(scope, "usage"), bootstrap.usage);
      return bootstrap;
    },
    staleTime: STALE_TIME.default,
  });
}

/**
 * The identity bootstrap already carries everything the Workspace bootstrap
 * does for the effective Workspace. Adopting that Workspace seeds the same
 * cache entries, so the shell needs no second request. Returns false (and
 * seeds nothing) when the session lacks the Workspace or its usage, for
 * instance a Workspace the member cannot view; the bootstrap request then
 * runs and reports why.
 */
export function seedWorkspaceBootstrapFromSession(
  queryClient: QueryClient,
  scope: WorkspaceScope,
  session: SessionBootstrap,
): boolean {
  const workspace = session.memberships.find((entry) => entry.id === scope.workspaceId);
  if (!workspace || !session.usage || session.selection.workspaceId !== scope.workspaceId) return false;
  const bootstrap: WorkspaceBootstrap = {
    user: session.user,
    workspace,
    memberships: session.memberships,
    capabilities: session.capabilities,
    usage: session.usage,
  };
  queryClient.setQueryData(key(scope, "bootstrap"), bootstrap);
  queryClient.setQueryData(key(scope, "usage"), bootstrap.usage);
  return true;
}

export function workspaceProfileQuery(transport: ApiTransport, scope: WorkspaceScope) {
  const client = createWorkspaceClient(transport.scoped(scope));
  return queryOptions({
    queryKey: key(scope, "profile"),
    queryFn: async ({ signal }) => (await client.workspace.$get({}, { init: { signal } })).json(),
    staleTime: STALE_TIME.default,
  });
}

export function workspaceUsageQuery(transport: ApiTransport, scope: WorkspaceScope) {
  const client = createWorkspaceClient(transport.scoped(scope));
  return queryOptions({
    queryKey: key(scope, "usage"),
    queryFn: async ({ signal }) => (await client.workspace.usage.$get({}, { init: { signal } })).json(),
    staleTime: STALE_TIME.default,
  });
}

/** Members and pending invitations. */
export function workspaceMembersQuery(transport: ApiTransport, scope: WorkspaceScope) {
  const client = createWorkspaceClient(transport.scoped(scope));
  return queryOptions({
    queryKey: key(scope, "members"),
    queryFn: async ({ signal }) => (await client.workspace.members.$get({}, { init: { signal } })).json(),
    staleTime: STALE_TIME.default,
  });
}

/** The Workspace's censored words (the built-in defaults until edited). Settings and the Studio share this key. */
export function workspaceCensorWordsQuery(transport: ApiTransport, scope: WorkspaceScope) {
  const client = createWorkspaceClient(transport.scoped(scope));
  return queryOptions({
    queryKey: key(scope, "censor-words"),
    queryFn: async ({ signal }) => (await client.workspace["censor-words"].$get({}, { init: { signal } })).json(),
    staleTime: STALE_TIME.config,
  });
}

/** Profile or avatar changed: the profile, the shell bootstrap and the identity memberships (workspace chip). */
export async function invalidateWorkspaceProfile(queryClient: QueryClient, scope: WorkspaceScope): Promise<void> {
  await Promise.all([
    invalidateScoped(queryClient, scope, "workspace", "profile"),
    invalidateScoped(queryClient, scope, "workspace", "bootstrap"),
    invalidateSession(queryClient, scope, "bootstrap"),
  ]);
}

/**
 * Credits were reserved, spent or released (an accepted render, generation,
 * intake or deletion). The shell, Billing and Usage read the allowance embedded in
 * the Workspace bootstrap, so refresh both it and the usage read it seeds.
 */
export async function invalidateWorkspaceUsage(queryClient: QueryClient, scope: WorkspaceScope): Promise<void> {
  await Promise.all([
    invalidateScoped(queryClient, scope, "workspace", "usage"),
    invalidateScoped(queryClient, scope, "workspace", "bootstrap"),
  ]);
}

/** Members or invitations changed: the lists, and seat billing. */
export async function invalidateWorkspaceMembers(queryClient: QueryClient, scope: WorkspaceScope): Promise<void> {
  await Promise.all([
    invalidateScoped(queryClient, scope, "workspace", "members"),
    invalidateScoped(queryClient, scope, "billing"),
  ]);
}
