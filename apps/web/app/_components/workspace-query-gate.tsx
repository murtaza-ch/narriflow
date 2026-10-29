"use client";

import { Stack, Text } from "@chakra-ui/react";
import {
  type ApiError,
  describeApiFailure,
  isApiError,
  sessionKey,
  type WorkspaceScope,
} from "@narriflow/api-client";
import { selectWorkspaceMutation, sessionBootstrapQuery } from "@narriflow/api-client/session";
import { workspaceBootstrapQuery } from "@narriflow/api-client/workspace";
import { Button } from "@narriflow/ui/components/button";
import { type SessionBootstrap, workspaceCapabilities } from "@narriflow/validators/api/session";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiErrorMessage, apiErrorSupportId } from "./query-mutation-form";
import {
  ApiProvider,
  type ApiProviderProps,
  useApiRuntime,
  useApiScope,
  useIdentityScope,
  useWorkspaceScope,
} from "./api-provider";

/**
 * The session and Workspace gates every authenticated screen renders inside.
 *
 * `SessionGate` runs the identity-only bootstrap (it provisions a first-time
 * user and lists memberships without looking at any Workspace's billing state),
 * then adopts the effective Workspace into the API scope BEFORE any scoped query
 * can start: the saved hint may name a Workspace the person no longer belongs
 * to, and the API refuses scoped calls for one (409 `workspace_selection_changed`)
 * rather than falling back. Whenever that refusal arrives later, the gate takes
 * the bootstrap again and adopts what it reports; the refused command is never
 * replayed in the other Workspace.
 *
 * `WorkspaceQueryGate` then reads the Workspace bootstrap. A Workspace the
 * person cannot view (a member of a paused one) is sent to the page outside the
 * shell that always offers a way out.
 */

const SIGNED_OUT: { userId: string } = { userId: "" };

export const WORKSPACE_UNAVAILABLE_PATH = "/workspace-unavailable";

const refusalListeners = new Set<() => void>();

function onWorkspaceSelectionRefused(listener: () => void): () => void {
  refusalListeners.add(listener);
  return () => {
    refusalListeners.delete(listener);
  };
}

/**
 * `ApiProvider` for screens inside `SessionGate`. The transport reports a
 * refused selection (409 `workspace_selection_changed`) for every request,
 * query, mutation or raw call alike; the gate answers by taking the identity
 * bootstrap again. The refused request itself is never retried.
 */
export function SessionApiProvider(props: Omit<ApiProviderProps, "onWorkspaceSelectionChanged">) {
  return (
    <ApiProvider
      {...props}
      onWorkspaceSelectionChanged={(_error: ApiError) => {
        for (const listener of [...refusalListeners]) listener();
      }}
    />
  );
}

interface SessionGateValue {
  session: SessionBootstrap;
  /** The saved Workspace was gone, so the personal one opened instead. */
  selectionChanged: boolean;
  dismissSelectionChanged(): void;
  /** Take the identity bootstrap again and adopt the effective Workspace it reports. */
  revalidate(): void;
}

const SessionGateContext = createContext<SessionGateValue | null>(null);

/** The identity bootstrap of the open session. Throws outside `SessionGate`. */
export function useSessionGate(): SessionGateValue {
  const value = useContext(SessionGateContext);
  if (!value) throw new Error("useSessionGate must be used inside SessionGate");
  return value;
}

/** A full-page notice with a retry, for a bootstrap that could not be read. */
export function GateFailure({
  title,
  error,
  fallback,
  onRetry,
}: {
  title: string;
  error: unknown;
  fallback: string;
  onRetry: () => void;
}) {
  const message = apiErrorMessage(error, fallback) ?? fallback;
  const supportId = apiErrorSupportId(error);
  return (
    <Stack minH="100dvh" align="center" justify="center" p="6" gap="4" bg="bg.sidebar" role="alert">
      <Text as="h1" fontSize="xl" fontWeight="600">
        {title}
      </Text>
      <Text color="fg.muted" textAlign="center">
        {message}
      </Text>
      {supportId ? (
        <Text fontSize="xs" color="fg.subtle">
          Support ID: {supportId}
        </Text>
      ) : null}
      <Button onClick={onRetry}>Try again</Button>
    </Stack>
  );
}

export function SessionGate({
  children,
  fallback,
  title = "Your workspace couldn’t open",
}: {
  children: ReactNode;
  fallback: ReactNode;
  title?: string;
}) {
  const runtime = useApiRuntime();
  const identity = useIdentityScope();
  const { workspaceId: hint } = useApiScope();
  const query = useQuery({
    ...sessionBootstrapQuery(runtime.transport, identity ?? SIGNED_OUT, hint),
    enabled: identity !== null,
  });

  // True until the effective Workspace of the latest bootstrap is in force.
  const needsAdoption = useRef(true);
  const [adopted, setAdopted] = useState(false);
  const [selectionChanged, setSelectionChanged] = useState(false);

  const data = query.data;
  const settled = !query.isFetching;
  useEffect(() => {
    if (!data || !settled || !needsAdoption.current) return;
    needsAdoption.current = false;
    runtime.selectWorkspace(data.selection.workspaceId);
    setSelectionChanged(data.selection.workspaceSelectionChanged);
    setAdopted(true);
  }, [data, settled, runtime]);

  const userId = identity?.userId ?? null;
  const revalidate = useCallback(() => {
    if (userId === null || needsAdoption.current) return;
    needsAdoption.current = true;
    void runtime.queryClient.invalidateQueries({
      queryKey: sessionKey({ userId }, "bootstrap"),
      exact: true,
    });
    setAdopted(false);
  }, [runtime, userId]);

  // The API refused the explicit selection: it was removed since it was made.
  useEffect(() => onWorkspaceSelectionRefused(revalidate), [revalidate]);

  const value = useMemo<SessionGateValue | null>(
    () =>
      data
        ? {
            session: data,
            selectionChanged,
            dismissSelectionChanged: () => setSelectionChanged(false),
            revalidate,
          }
        : null,
    [data, selectionChanged, revalidate],
  );

  if (identity === null) return <>{fallback}</>;
  if (!data && query.isError) {
    return (
      <GateFailure
        title={title}
        error={query.error}
        fallback="You’re signed in. Try opening your workspace again."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!value || !adopted) return <>{fallback}</>;
  return <SessionGateContext.Provider value={value}>{children}</SessionGateContext.Provider>;
}

/**
 * Renders `children` with the Workspace bootstrap of the selected Workspace.
 * Children are remounted when the Workspace changes, so no screen state from
 * one Workspace survives into another.
 */
export function WorkspaceQueryGate({
  children,
  fallback,
}: {
  children: (bootstrap: WorkspaceBootstrap, scope: WorkspaceScope) => ReactNode;
  fallback: ReactNode;
}) {
  const scope = useWorkspaceScope();
  const router = useRouter();
  const { session, revalidate } = useSessionGate();
  const membership = scope ? session.memberships.find((entry) => entry.id === scope.workspaceId) : undefined;
  const canView = membership ? workspaceCapabilities(membership)["content.view"] : false;

  // A selection that is not among the memberships is stale: take the bootstrap again.
  useEffect(() => {
    if (scope && !membership) revalidate();
  }, [scope, membership, revalidate]);
  useEffect(() => {
    if (membership && !canView) router.replace(WORKSPACE_UNAVAILABLE_PATH);
  }, [membership, canView, router]);

  if (!scope || !membership || !canView) return <>{fallback}</>;
  return (
    <WorkspaceBootstrapView key={scope.workspaceId} scope={scope} fallback={fallback}>
      {children}
    </WorkspaceBootstrapView>
  );
}

/** A paused Workspace: the owner repairs billing, anyone else leaves for the page outside the shell. */
function restrictedDestination(error: unknown): string {
  return isApiError(error) && error.details?.ownerCanResolve === true ? "/settings/billing" : WORKSPACE_UNAVAILABLE_PATH;
}

function WorkspaceBootstrapView({
  scope,
  fallback,
  children,
}: {
  scope: WorkspaceScope;
  fallback: ReactNode;
  children: (bootstrap: WorkspaceBootstrap, scope: WorkspaceScope) => ReactNode;
}) {
  const runtime = useApiRuntime();
  const router = useRouter();
  const query = useQuery(workspaceBootstrapQuery(runtime.transport, scope));
  const failure = query.isError ? describeApiFailure(query.error) : null;
  const restricted = failure?.kind === "workspace_restricted";

  // The status changed since the bootstrap: the owner repairs billing, anyone else leaves.
  useEffect(() => {
    if (restricted) router.replace(restrictedDestination(query.error));
  }, [restricted, query.error, router]);

  // The same answer to any other read of this Workspace (Home, Projects, search): the
  // bootstrap is cached, so no screen would otherwise leave, and retrying could not help.
  useEffect(() => {
    return runtime.queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      if (event.query.queryKey[2] !== scope.workspaceId) return;
      if (describeApiFailure(event.action.error).kind !== "workspace_restricted") return;
      router.replace(restrictedDestination(event.action.error));
    });
  }, [runtime, scope.workspaceId, router]);

  if (query.data) return <>{children(query.data, scope)}</>;
  // Superseded: the Workspace changed under this request; the remounted gate reads the new one.
  if (!failure || restricted || failure.kind === "superseded") return <>{fallback}</>;
  return (
    <GateFailure
      title="Your workspace couldn’t open"
      error={query.error}
      fallback="Try opening your workspace again."
      onRetry={() => void query.refetch()}
    />
  );
}

/**
 * Switches the selected Workspace. The API checks membership only, so a member
 * of a paused Workspace can still leave it. On success the runtime cancels and
 * clears the old Workspace's requests and queries and adopts the new one; the
 * caller decides where to navigate.
 */
export function useWorkspaceSwitch() {
  const runtime = useApiRuntime();
  const identity = useIdentityScope();
  const mutation = useMutation(selectWorkspaceMutation(runtime, identity ?? SIGNED_OUT));
  const { mutateAsync, reset } = mutation;
  const switchTo = useCallback(
    async (workspaceId: string): Promise<boolean> => {
      try {
        await mutateAsync(workspaceId);
        return true;
      } catch {
        return false;
      }
    },
    [mutateAsync],
  );
  return {
    switchTo,
    pending: mutation.isPending,
    /** The Workspace being opened while a switch runs. */
    pendingId: mutation.isPending ? mutation.variables : null,
    error: mutation.error,
    reset,
  };
}
