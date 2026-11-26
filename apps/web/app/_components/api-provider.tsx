"use client";

import { useAuth } from "@clerk/nextjs";
import {
  type ApiError,
  type ApiRuntime,
  createApiRuntime,
  type IdentityScope,
  type ScopeSnapshot,
  type WorkspaceScope,
} from "@narriflow/api-client";
import { QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { authEntryHref } from "../../lib/auth-entry";
import { browserStorage } from "./browser-storage";

/**
 * Data layer for authenticated UI (app shell, continuations, review pages).
 * Marketing pages stay outside it. It owns one `ApiRuntime` for the tab:
 *
 * - `runtime.transport.scoped(scope)` / `.identity(scope)` for requests,
 * - `runtime.queryClient` (React Query) for ordinary remote state,
 * - `runtime.scope` for the signed-in Clerk user and selected Workspace.
 *
 * The identity is ready once Clerk has loaded and the runtime's identity
 * matches it. Until then the hooks below report no identity and no Workspace
 * on every render, so no query can start under a stale or missing user, even
 * from a child effect that runs before the provider applies the new identity.
 * By default children render only once it is ready; the app shell renders them
 * at once so its chrome never waits. Tokens come from `useAuth().getToken()` at
 * request time and are never stored or keyed. Only the selected-Workspace hint
 * (per Clerk user) is persisted, in localStorage; other tabs follow it through
 * the `storage` event.
 *
 * `useWorkspaceScope()` is the admitted Workspace: null until a gate has
 * validated the selection (see `workspace-query-gate.tsx`). The raw runtime
 * scope, which holds the unvalidated hint, is `useRuntimeScope()`.
 */

export interface ApiProviderProps {
  children: ReactNode;
  /** Shown until Clerk has loaded and identity is applied. */
  fallback?: ReactNode;
  /**
   * Render children while the identity is pending instead of `fallback`. The
   * hooks report no identity until it is ready, so nothing scoped can start.
   */
  renderWhilePending?: boolean;
  /**
   * An unrecoverable 401 (no session, or rejected after one forced refresh).
   * Defaults to the existing sign-in entry carrying the current path.
   */
  onAuthenticationFailed?: (error: ApiError) => void;
  /**
   * 409 `workspace_selection_changed`: the explicit selection is no longer
   * valid. Run identity bootstrap and require a fresh choice; the refused
   * command is never replayed.
   */
  onWorkspaceSelectionChanged?: (error: ApiError) => void;
}

/**
 * The runtime scope plus the scope version at which the current identity took
 * effect. It moves on every sign-in, sign-out or account switch, including a
 * sign-out that is undone, so per-identity state can tell two sessions apart
 * even when they belong to the same user.
 */
export interface RuntimeScope extends ScopeSnapshot {
  readonly identityVersion: number;
}

interface RuntimeScopeStore {
  get(): RuntimeScope;
  subscribe(notify: () => void): () => void;
}

/**
 * Subscribed when the runtime is created, before any component, so the view
 * is current by the time React reads it and no identity transition is missed.
 */
function runtimeScopeStore(runtime: ApiRuntime): RuntimeScopeStore {
  let current: RuntimeScope = { ...runtime.scope.snapshot(), identityVersion: runtime.scope.snapshot().version };
  runtime.scope.subscribe((snapshot, transition) => {
    current = {
      ...snapshot,
      identityVersion: transition.kind === "user" ? snapshot.version : current.identityVersion,
    };
  });
  return {
    get: () => current,
    subscribe: (notify) => runtime.scope.subscribe(notify),
  };
}

interface ApiContextValue {
  runtime: ApiRuntime;
  scope: RuntimeScopeStore;
  /** Clerk's user, `undefined` until Clerk has loaded. */
  clerkUserId: string | null | undefined;
}

const ApiContext = createContext<ApiContextValue | null>(null);
const AdmittedWorkspaceContext = createContext<WorkspaceScope | null>(null);

interface ApiRuntimeHandle {
  runtime: ApiRuntime;
  scope: RuntimeScopeStore;
}

function createRuntimeHandle(options: Parameters<typeof createApiRuntime>[0]): ApiRuntimeHandle {
  const runtime = createApiRuntime(options);
  return { runtime, scope: runtimeScopeStore(runtime) };
}

const Devtools =
  process.env.NODE_ENV === "development"
    ? lazy(() =>
        import("@tanstack/react-query-devtools").then((module) => ({
          default: module.ReactQueryDevtools,
        })),
      )
    : null;

function apiBaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!value) throw new Error("NEXT_PUBLIC_API_URL is required for authenticated pages");
  return value;
}

export function ApiProvider({
  children,
  fallback = null,
  renderWhilePending = false,
  onAuthenticationFailed,
  onWorkspaceSelectionChanged,
}: ApiProviderProps) {
  const { isLoaded, userId, getToken } = useAuth();
  const router = useRouter();

  // Latest-value refs: the runtime is created once, but must always see the
  // current Clerk `getToken` and callbacks (children's effects run first).
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const handlers = useRef({ onAuthenticationFailed, onWorkspaceSelectionChanged });
  handlers.current = { onAuthenticationFailed, onWorkspaceSelectionChanged };
  const routerRef = useRef(router);
  routerRef.current = router;

  const [handle] = useState(() =>
    createRuntimeHandle({
      baseUrl: apiBaseUrl(),
      getToken: (options) => getTokenRef.current(options),
      hintStorage: browserStorage(),
      onAuthenticationFailed: (error) => {
        if (handlers.current.onAuthenticationFailed) {
          handlers.current.onAuthenticationFailed(error);
          return;
        }
        const { pathname, search } = window.location;
        routerRef.current.replace(authEntryHref("sign-in", `${pathname}${search}`));
      },
      onWorkspaceSelectionChanged: (error) => handlers.current.onWorkspaceSelectionChanged?.(error),
    }),
  );
  const { runtime } = handle;

  useEffect(() => {
    if (isLoaded) runtime.setIdentity(userId ?? null);
  }, [isLoaded, userId, runtime]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const current = runtime.scope.snapshot().userId;
      if (
        current !== null &&
        event.storageArea === browserStorage() &&
        event.key === runtime.hints.keyFor(current)
      ) {
        runtime.syncHintFromStorage();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [runtime]);

  const scope = useSyncExternalStore(handle.scope.subscribe, handle.scope.get, handle.scope.get);
  const ready = isLoaded && scope.userId === (userId ?? null);
  const clerkUserId = isLoaded ? (userId ?? null) : undefined;
  const value = useMemo<ApiContextValue>(() => ({ ...handle, clerkUserId }), [handle, clerkUserId]);

  return (
    <ApiContext.Provider value={value}>
      <QueryClientProvider client={runtime.queryClient}>
        {ready || renderWhilePending ? children : fallback}
        {Devtools ? (
          <Suspense fallback={null}>
            <Devtools initialIsOpen={false} />
          </Suspense>
        ) : null}
      </QueryClientProvider>
    </ApiContext.Provider>
  );
}

function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (!value) throw new Error("useApiRuntime must be used inside ApiProvider");
  return value;
}

/** The runtime for requests and cache access. Throws outside `ApiProvider`. */
export function useApiRuntime(): ApiRuntime {
  return useApiContext().runtime;
}

/**
 * The raw runtime scope: the signed-in user and the selected Workspace as the
 * runtime holds it, which before adoption is the unvalidated hint from storage
 * and afterwards follows another tab's hint with no validation. Reports no
 * identity and no Workspace until the identity is ready. Only the gates and
 * code that must act before validation read it; screens use
 * `useWorkspaceScope()`.
 */
export function useRuntimeScope(): RuntimeScope {
  const { scope, clerkUserId } = useApiContext();
  const current = useSyncExternalStore(scope.subscribe, scope.get, scope.get);
  // Derived on every render: Clerk may already answer for a new user while
  // the runtime still holds the previous one.
  const ready = clerkUserId !== undefined && current.userId === clerkUserId;
  return useMemo(() => (ready ? current : { ...current, userId: null, workspaceId: null }), [ready, current]);
}

/**
 * Clears the session before Clerk's sign-out, so nothing in flight can fail
 * into a sign-in redirect and nothing cached outlives it. Returns the undo for
 * a sign-out that fails. The undo applies only while the runtime is still at
 * the transition this sign-out made: if Clerk has meanwhile switched account
 * and the provider applied it, putting the old user back would leave the
 * runtime disagreeing with Clerk, and nothing would correct it.
 */
export function beginSignOut(runtime: ApiRuntime): () => void {
  const previous = runtime.scope.snapshot().userId;
  runtime.setIdentity(null);
  const signedOut = runtime.scope.snapshot().version;
  return () => {
    if (runtime.scope.snapshot().version === signedOut) runtime.setIdentity(previous);
  };
}

/** The signed-in identity, or null when signed out or not ready. Stable between scope changes. */
export function useIdentityScope(): IdentityScope | null {
  const { userId } = useRuntimeScope();
  return useMemo(() => (userId === null ? null : { userId }), [userId]);
}

/**
 * Provides the admitted Workspace to `useWorkspaceScope()`. Only a gate that
 * has validated the selection renders it (tests stand in for one).
 */
export function AdmittedWorkspaceScope({ scope, children }: { scope: WorkspaceScope | null; children: ReactNode }) {
  return <AdmittedWorkspaceContext.Provider value={scope}>{children}</AdmittedWorkspaceContext.Provider>;
}

/**
 * Identity plus the admitted Workspace, or null until a gate has validated the
 * selection and read its bootstrap. Pass it to every `queryOptions`/mutation
 * factory so keys and the `X-Workspace-Id` header come from the same captured
 * value.
 */
export function useWorkspaceScope(): WorkspaceScope | null {
  return useContext(AdmittedWorkspaceContext);
}
