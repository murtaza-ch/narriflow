"use client";

import { Stack, Text } from "@chakra-ui/react";
import {
  type ApiError,
  describeApiFailure,
  isApiError,
  sessionKey,
  shouldRetryQuery,
  type WorkspaceScope,
} from "@narriflow/api-client";
import { selectWorkspaceMutation, sessionBootstrapQuery } from "@narriflow/api-client/session";
import { seedWorkspaceBootstrapFromSession, workspaceBootstrapQuery } from "@narriflow/api-client/workspace";
import { Button } from "@narriflow/ui/components/button";
import { type SessionBootstrap, workspaceCapabilities } from "@narriflow/validators/api/session";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import {
  type FetchQueryOptions,
  hashKey,
  skipToken,
  type UseQueryOptions,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
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
  AdmittedWorkspaceScope,
  ApiProvider,
  type ApiProviderProps,
  useApiRuntime,
  useIdentityScope,
  useRuntimeScope,
} from "./api-provider";

/**
 * The session and Workspace gates every authenticated screen renders inside.
 *
 * Adoption runs the identity-only bootstrap (it provisions a first-time user
 * and lists memberships without looking at any Workspace's billing state),
 * then adopts the effective Workspace into the API scope BEFORE any scoped
 * query can start: the saved hint may name a Workspace the person no longer
 * belongs to, and the API refuses scoped calls for one (409
 * `workspace_selection_changed`) rather than falling back. Whenever that
 * refusal arrives later, adoption takes the bootstrap again and adopts what it
 * reports; the refused command is never replayed in the other Workspace.
 *
 * Two gates share it. `SessionGate` blocks: standalone pages that need the
 * session render once it is adopted. `WorkspaceGateProvider` never blocks: the
 * app shell's chrome and page always render, and the gate admits a Workspace
 * through `useWorkspaceScope()` only once it is a viewable membership and its
 * Workspace bootstrap (seeded by the identity bootstrap, so usually no second
 * request) is present. A Workspace the person cannot view (a member of a
 * paused one) is sent to the page outside the shell that always offers a way out.
 */

const SIGNED_OUT: { userId: string } = { userId: "" };
/** The bootstrap read's key while no Workspace is a candidate; it never runs. */
const IDLE_BOOTSTRAP_KEY = ["nf", "workspace-gate", "idle"] as const;

export const WORKSPACE_UNAVAILABLE_PATH = "/workspace-unavailable";

const refusalListeners = new Set<() => void>();

function onWorkspaceSelectionRefused(listener: () => void): () => void {
  refusalListeners.add(listener);
  return () => {
    refusalListeners.delete(listener);
  };
}

/**
 * `ApiProvider` for screens inside a session gate. The transport reports a
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

/** A bootstrap that could not be read, with what `GateFailure` needs. */
interface GateFailed {
  status: "failed";
  error: unknown;
  message: string;
  retry(): void;
}

type SessionAdoption = { status: "pending" } | GateFailed | ({ status: "adopted" } & SessionGateValue);

const PENDING = { status: "pending" } as const;

/** Per-identity adoption state; anything recorded for an earlier identity reads as initial. */
interface AdoptionState {
  identityVersion: number;
  adopted: boolean;
  selectionChanged: boolean;
  /**
   * After a refused selection only a bootstrap read after the refusal may be adopted:
   * React Query keeps the last successful data through a failed refresh, and that data
   * still names the Workspace the API just rejected. `refusal` is the query's
   * `dataUpdateCount` when the refusal arrived, read from the cache itself (a success
   * may have landed there before React rendered it); only a later success is fresh.
   */
  refusal: number | null;
}

/**
 * The hint each successful session bootstrap read was sent with, by query, and the
 * `dataUpdateCount` that success produced. Adoption compares it with the current
 * selection: another tab may have chosen a Workspace while the read was in flight,
 * and adopting the older answer would overwrite that choice.
 */
const answeredHints = new WeakMap<object, { hint: string | null; count: number }>();

function initialAdoption(identityVersion: number): AdoptionState {
  return { identityVersion, adopted: false, selectionChanged: false, refusal: null };
}

/**
 * The adoption state machine both gates share. Its state belongs to one
 * identity session (`identityVersion`): signing out, switching account, or
 * restoring a user after a failed sign-out starts adoption over, without
 * remounting anything, because the app shell's page stays mounted across them.
 */
function useSessionAdoption(): SessionAdoption {
  const runtime = useApiRuntime();
  const { userId, workspaceId: hint, identityVersion } = useRuntimeScope();
  const identity = useMemo(() => (userId === null ? null : { userId }), [userId]);
  const options = sessionBootstrapQuery(runtime.transport, identity ?? SIGNED_OUT, hint);
  const query = useQuery({
    ...options,
    queryFn: async (context) => {
      const { queryFn } = options;
      if (typeof queryFn !== "function") throw new Error("The session bootstrap has no fetcher.");
      const data = await queryFn(context);
      const entry = context.client.getQueryCache().find({ queryKey: context.queryKey, exact: true });
      if (entry) answeredHints.set(entry, { hint, count: entry.state.dataUpdateCount + 1 });
      return data;
    },
    enabled: identity !== null,
  });
  // Read from the cache, not the rendered result: a refusal can arrive before React renders a success.
  const cached = runtime.queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true });
  const updateCount = cached?.state.dataUpdateCount ?? 0;
  const answered = cached ? answeredHints.get(cached) : undefined;
  // Undefined when the cached data was not written by this gate's read (or not by its latest success).
  const answeredHint = answered && answered.count === updateCount ? answered.hint : undefined;

  const [stored, setStored] = useState(() => initialAdoption(identityVersion));
  const state = stored.identityVersion === identityVersion ? stored : initialAdoption(identityVersion);
  const update = useCallback(
    (patch: Partial<Omit<AdoptionState, "identityVersion">>) =>
      setStored((previous) => ({
        ...(previous.identityVersion === identityVersion ? previous : initialAdoption(identityVersion)),
        ...patch,
      })),
    [identityVersion],
  );
  // Whether the effective Workspace of the latest bootstrap is in force for this identity.
  // A ref, not state: adoption and revalidation must each happen once per read.
  const adoptedFor = useRef<number | null>(null);

  const data = query.data;
  const settled = !query.isFetching;
  const fresh = state.refusal === null || updateCount > state.refusal;
  const { isError, refetch } = query;
  useEffect(() => {
    if (!identity || !data || !settled || !fresh || adoptedFor.current === identityVersion) return;
    // The selection can move between this render and its effect (another tab): the render that follows decides.
    if (runtime.scope.snapshot().workspaceId !== hint) return;
    if (answeredHint !== hint) {
      // The selection moved since this read was sent (another tab chose a Workspace):
      // read again with the current one rather than adopt an answer to the old one.
      // A failed re-read shows the retry instead of looping.
      if (!isError) void refetch();
      return;
    }
    adoptedFor.current = identityVersion;
    // The identity bootstrap carries the Workspace bootstrap's data for the
    // effective Workspace: seed it so the shell opens without a second request.
    // Seeding is not a scoped request, so it may precede the adoption.
    seedWorkspaceBootstrapFromSession(
      runtime.queryClient,
      { userId: identity.userId, workspaceId: data.selection.workspaceId },
      data,
    );
    runtime.selectWorkspace(data.selection.workspaceId);
    update({ adopted: true, selectionChanged: data.selection.workspaceSelectionChanged });
  }, [data, settled, fresh, answeredHint, hint, isError, refetch, runtime, identity, identityVersion, update]);

  const revalidate = useCallback(() => {
    if (userId === null || adoptedFor.current !== identityVersion) return;
    adoptedFor.current = null;
    const queryKey = sessionKey({ userId }, "bootstrap");
    const refusal = runtime.queryClient.getQueryCache().find({ queryKey, exact: true })?.state.dataUpdateCount ?? 0;
    update({ refusal, adopted: false });
    void runtime.queryClient.invalidateQueries({ queryKey, exact: true });
  }, [runtime, userId, identityVersion, update]);

  // The API refused the explicit selection: it was removed since it was made.
  useEffect(() => onWorkspaceSelectionRefused(revalidate), [revalidate]);

  const dismissSelectionChanged = useCallback(() => update({ selectionChanged: false }), [update]);
  // Before adoption any failed read is a failure (a refusal resets adoption); after it,
  // a failed background refresh keeps the adopted session.
  const failed = identity !== null && isError && settled && (!data || !state.adopted);
  const refused = state.refusal !== null;
  const { error } = query;
  return useMemo<SessionAdoption>(() => {
    if (identity === null) return PENDING;
    if (failed) {
      return {
        status: "failed",
        error,
        message: refused
          ? "Your access to that workspace changed. Try again to open the right one."
          : "You’re signed in. Try opening your workspace again.",
        retry: () => void refetch(),
      };
    }
    if (!data || !state.adopted) return PENDING;
    return {
      status: "adopted",
      session: data,
      selectionChanged: state.selectionChanged,
      dismissSelectionChanged,
      revalidate,
    };
  }, [identity, failed, error, refused, refetch, data, state.adopted, state.selectionChanged, dismissSelectionChanged, revalidate]);
}

const SessionGateContext = createContext<SessionGateValue | null>(null);

/** The identity bootstrap of the open session. Throws outside `SessionGate`. */
export function useSessionGate(): SessionGateValue {
  const value = useContext(SessionGateContext);
  if (!value) throw new Error("useSessionGate must be used inside SessionGate");
  return value;
}

/**
 * A notice with a retry, for a bootstrap that could not be read. Full page for
 * the standalone pages; `panel` fills the app shell's content panel, so the
 * chrome stays.
 */
export function GateFailure({
  title,
  error,
  fallback,
  onRetry,
  variant = "page",
}: {
  title: string;
  error: unknown;
  fallback: string;
  onRetry: () => void;
  variant?: "page" | "panel";
}) {
  const message = apiErrorMessage(error, fallback) ?? fallback;
  const supportId = apiErrorSupportId(error);
  return (
    <Stack
      minH={variant === "page" ? "100dvh" : "60dvh"}
      align="center"
      justify="center"
      p="6"
      gap="4"
      bg={variant === "page" ? "bg.sidebar" : undefined}
      role="alert"
    >
      <Text as={variant === "page" ? "h1" : "h2"} fontSize="xl" fontWeight="600">
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

/** Renders `children` once the session is adopted, for standalone pages outside the app shell. */
export function SessionGate({
  children,
  fallback,
  title = "Your workspace couldn’t open",
}: {
  children: ReactNode;
  fallback: ReactNode;
  title?: string;
}) {
  const adoption = useSessionAdoption();
  if (adoption.status === "failed") {
    return <GateFailure title={title} error={adoption.error} fallback={adoption.message} onRetry={adoption.retry} />;
  }
  if (adoption.status === "pending") return <>{fallback}</>;
  return <SessionGateContext.Provider value={adoption}>{children}</SessionGateContext.Provider>;
}

/** What the app shell's gate knows: still opening, failed, or a Workspace in force. */
export type WorkspaceGateValue =
  | { status: "pending" }
  | (GateFailed & { title: string })
  | ({ status: "ready"; bootstrap: WorkspaceBootstrap; scope: WorkspaceScope } & SessionGateValue);

const WorkspaceGateContext = createContext<WorkspaceGateValue>(PENDING);

/** The app shell's gate. Pending outside `WorkspaceGateProvider`. */
export function useWorkspaceGate(): WorkspaceGateValue {
  return useContext(WorkspaceGateContext);
}

/** A paused Workspace: the owner repairs billing, anyone else leaves for the page outside the shell. */
function restrictedDestination(error: unknown): string {
  return isApiError(error) && error.details?.ownerCanResolve === true ? "/settings/billing" : WORKSPACE_UNAVAILABLE_PATH;
}

/**
 * The one place the app shell's readiness is derived, never stored: ready is
 * adopted ∧ fresh ∧ the selected Workspace is a membership ∧ the person can
 * view it ∧ the Workspace bootstrap read for that same scope has data.
 */
function useWorkspaceGateValue(): WorkspaceGateValue {
  const runtime = useApiRuntime();
  const router = useRouter();
  const adoption = useSessionAdoption();
  const { userId, workspaceId } = useRuntimeScope();
  const session = adoption.status === "adopted" ? adoption : null;
  // The selection as the runtime holds it. After adoption it is the adopted
  // Workspace, or another tab's choice, which is admitted only once it passes
  // the same membership, view and bootstrap checks.
  const membership =
    session && userId !== null && workspaceId !== null
      ? session.session.memberships.find((entry) => entry.id === workspaceId)
      : undefined;
  const canView = membership ? workspaceCapabilities(membership)["content.view"] : false;
  const revalidate = session?.revalidate;

  // A selection that is not among the memberships is stale: take the bootstrap again.
  useEffect(() => {
    if (revalidate && workspaceId !== null && !membership) revalidate();
  }, [revalidate, workspaceId, membership]);
  useEffect(() => {
    if (membership && !canView) router.replace(WORKSPACE_UNAVAILABLE_PATH);
  }, [membership, canView, router]);

  const candidate = useMemo(
    () => (canView && userId !== null && workspaceId !== null ? { userId, workspaceId } : null),
    [canView, userId, workspaceId],
  );
  // The factory binds a scoped transport, which needs a Workspace; with none the read stays idle.
  const bootstrap = useQuery(
    (candidate
      ? workspaceBootstrapQuery(runtime.transport, candidate)
      : { queryKey: IDLE_BOOTSTRAP_KEY, queryFn: skipToken }) as UseQueryOptions<WorkspaceBootstrap>,
  );
  const failure = candidate && bootstrap.isError ? describeApiFailure(bootstrap.error) : null;
  const restricted = failure?.kind === "workspace_restricted";

  // The status changed since the bootstrap: the owner repairs billing, anyone else leaves.
  useEffect(() => {
    if (restricted) router.replace(restrictedDestination(bootstrap.error));
  }, [restricted, bootstrap.error, router]);

  // Never pair one Workspace's bootstrap with another's scope.
  const data = candidate && bootstrap.data?.workspace.id === candidate.workspaceId ? bootstrap.data : null;
  const admitted = session && candidate && data ? candidate : null;

  // The same answer to any other read of the admitted Workspace (Home, Projects, search): the
  // bootstrap is cached, so no screen would otherwise leave, and retrying could not help.
  // The bootstrap's own error is the effect's above, so it redirects once.
  useEffect(() => {
    if (!admitted) return;
    const bootstrapHash = hashKey(workspaceBootstrapQuery(runtime.transport, admitted).queryKey);
    return runtime.queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      if (event.query.queryHash === bootstrapHash) return;
      if (event.query.queryKey[1] !== admitted.userId || event.query.queryKey[2] !== admitted.workspaceId) return;
      if (describeApiFailure(event.action.error).kind !== "workspace_restricted") return;
      router.replace(restrictedDestination(event.action.error));
    });
  }, [runtime, admitted, router]);

  const { refetch } = bootstrap;
  return useMemo<WorkspaceGateValue>(() => {
    if (adoption.status === "failed") return { ...adoption, title: "Your workspace couldn’t open" };
    if (!session) return PENDING;
    if (admitted && data) {
      return { status: "ready", bootstrap: data, scope: admitted, ...pickSession(session) };
    }
    // Superseded: the Workspace changed under this request; the next one reads the new one.
    if (!failure || restricted || failure.kind === "superseded") return PENDING;
    return {
      status: "failed",
      title: "Your workspace couldn’t open",
      error: bootstrap.error,
      message: "Try opening your workspace again.",
      retry: () => void refetch(),
    };
  }, [adoption, session, admitted, data, failure, restricted, bootstrap.error, refetch]);
}

function pickSession({ session, selectionChanged, dismissSelectionChanged, revalidate }: SessionGateValue): SessionGateValue {
  return { session, selectionChanged, dismissSelectionChanged, revalidate };
}

/**
 * A read a route starts as soon as it can: the same options its screen passes to
 * `useQuery`. `any` lets entries of different data and key types share one list.
 */
export type RouteRead = FetchQueryOptions<any, any, any, any>;

/**
 * On a hard load, starts the current route's reads beside the session bootstrap
 * instead of after it, under the saved hint, once per identity. This is the one
 * scoped request made under the raw runtime scope, and it is safe because no
 * screen can read the result before the gate admits that same scope: keys carry
 * user and Workspace, a Workspace move aborts the request as `scope_changed`
 * (never reported) and drops its keys, a 409 before adoption is ignored because
 * adoption is pending, and a refusal as paused only redirects once admitted.
 * The API checks membership on every request either way.
 *
 * Rules: no hint, nothing; no retries (a stale hint is refused, and retrying
 * cannot help); a read that failed is removed so the screen starts clean, or,
 * when a screen already joined it, read again with the screen's own retries if
 * that failure is one they would retry; never the Workspace bootstrap.
 */
/**
 * Runs a read without handing it React Query's abort signal. React Query cancels
 * a read that used its signal as soon as the last observer leaves, and in
 * development (StrictMode) a mounting screen's observer leaves and returns once:
 * that would throw away the request the screen was meant to join. A Workspace
 * move or sign-out still aborts the request in the transport.
 */
function detachedQueryFn(queryFn: RouteRead["queryFn"]): RouteRead["queryFn"] {
  if (typeof queryFn !== "function") return queryFn;
  return ({ client, queryKey, meta }) => queryFn({ client, queryKey, meta, signal: new AbortController().signal });
}

function usePrefetchUnderSavedHint(prefetch: ((scope: WorkspaceScope) => readonly RouteRead[]) | undefined) {
  const runtime = useApiRuntime();
  const { userId, workspaceId, identityVersion } = useRuntimeScope();
  const doneFor = useRef<number | null>(null);
  useEffect(() => {
    if (!prefetch || userId === null || doneFor.current === identityVersion) return;
    doneFor.current = identityVersion;
    if (workspaceId === null) return;
    const { queryClient } = runtime;
    const scope = { userId, workspaceId };
    const bootstrapHash = hashKey(workspaceBootstrapQuery(runtime.transport, scope).queryKey);
    let reads: readonly RouteRead[];
    try {
      reads = prefetch(scope);
    } catch {
      // A URL the route cannot read (an invalid filter) is the screen's to report, not the shell's to fail on.
      return;
    }
    for (const read of reads) {
      if (hashKey(read.queryKey) === bootstrapHash) continue;
      void queryClient.prefetchQuery({ ...read, queryFn: detachedQueryFn(read.queryFn), retry: false }).then(() => {
        const query = queryClient.getQueryCache().find({ queryKey: read.queryKey, exact: true });
        if (query?.state.status !== "error") return;
        if (query.getObserversCount() === 0) queryClient.removeQueries({ queryKey: read.queryKey, exact: true });
        else if (shouldRetryQuery(0, query.state.error)) void queryClient.resetQueries({ queryKey: read.queryKey, exact: true });
      });
    }
  }, [prefetch, runtime, userId, workspaceId, identityVersion]);
}

/**
 * The app shell's gate. It always renders its children: the chrome reads
 * `useWorkspaceGate()` and fills in when ready, and every screen reads
 * `useWorkspaceScope()`, which is null until the gate is ready. That, not
 * unmounting, keeps every scoped request behind a validated Workspace.
 * `prefetchUnderHint` names the current route's reads (see `usePrefetchUnderSavedHint`).
 */
export function WorkspaceGateProvider({
  children,
  prefetchUnderHint,
}: {
  children: ReactNode;
  prefetchUnderHint?: (scope: WorkspaceScope) => readonly RouteRead[];
}) {
  usePrefetchUnderSavedHint(prefetchUnderHint);
  const value = useWorkspaceGateValue();
  return (
    <WorkspaceGateContext.Provider value={value}>
      <AdmittedWorkspaceScope scope={value.status === "ready" ? value.scope : null}>{children}</AdmittedWorkspaceScope>
    </WorkspaceGateContext.Provider>
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
