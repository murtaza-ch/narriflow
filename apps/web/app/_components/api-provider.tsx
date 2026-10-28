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

/**
 * Data layer for authenticated UI (app shell, continuations, review pages).
 * Marketing pages stay outside it. It owns one `ApiRuntime` for the tab:
 *
 * - `runtime.transport.scoped(scope)` / `.identity(scope)` for requests,
 * - `runtime.queryClient` (React Query) for ordinary remote state,
 * - `runtime.scope` for the signed-in Clerk user and selected Workspace.
 *
 * Children render only once Clerk has loaded and the runtime's identity
 * matches it, so no query can start under a stale or missing user. Tokens come
 * from `useAuth().getToken()` at request time and are never stored or keyed.
 * Only the selected-Workspace hint (per Clerk user) is persisted, in
 * localStorage; other tabs follow it through the `storage` event.
 */

export interface ApiProviderProps {
  children: ReactNode;
  /** Shown until Clerk has loaded and identity is applied. */
  fallback?: ReactNode;
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

const ApiRuntimeContext = createContext<ApiRuntime | null>(null);

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

  const [runtime] = useState(() =>
    createApiRuntime({
      baseUrl: apiBaseUrl(),
      getToken: (options) => getTokenRef.current(options),
      hintStorage: typeof window === "undefined" ? null : window.localStorage,
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

  useEffect(() => {
    if (isLoaded) runtime.setIdentity(userId ?? null);
  }, [isLoaded, userId, runtime]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const current = runtime.scope.snapshot().userId;
      if (
        current !== null &&
        event.storageArea === window.localStorage &&
        event.key === runtime.hints.keyFor(current)
      ) {
        runtime.syncHintFromStorage();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [runtime]);

  const scope = useScopeSnapshot(runtime);
  const ready = isLoaded && scope.userId === (userId ?? null);

  return (
    <ApiRuntimeContext.Provider value={runtime}>
      <QueryClientProvider client={runtime.queryClient}>
        {ready ? children : fallback}
        {Devtools ? (
          <Suspense fallback={null}>
            <Devtools initialIsOpen={false} />
          </Suspense>
        ) : null}
      </QueryClientProvider>
    </ApiRuntimeContext.Provider>
  );
}

function useScopeSnapshot(runtime: ApiRuntime): ScopeSnapshot {
  return useSyncExternalStore(
    (notify) => runtime.scope.subscribe(notify),
    () => runtime.scope.snapshot(),
    () => runtime.scope.snapshot(),
  );
}

/** The runtime for requests and cache access. Throws outside `ApiProvider`. */
export function useApiRuntime(): ApiRuntime {
  const runtime = useContext(ApiRuntimeContext);
  if (!runtime) throw new Error("useApiRuntime must be used inside ApiProvider");
  return runtime;
}

/** Live user/Workspace selection. Re-renders on every scope change. */
export function useApiScope(): ScopeSnapshot {
  return useScopeSnapshot(useApiRuntime());
}

/** The signed-in identity, or null when signed out. Stable between scope changes. */
export function useIdentityScope(): IdentityScope | null {
  const { userId } = useApiScope();
  return useMemo(() => (userId === null ? null : { userId }), [userId]);
}

/**
 * Identity plus selected Workspace, or null until both are known. Pass it to
 * every `queryOptions`/mutation factory so keys and the `X-Workspace-Id` header
 * come from the same captured value.
 */
export function useWorkspaceScope(): WorkspaceScope | null {
  const { userId, workspaceId } = useApiScope();
  return useMemo(
    () => (userId === null || workspaceId === null ? null : { userId, workspaceId }),
    [userId, workspaceId],
  );
}
