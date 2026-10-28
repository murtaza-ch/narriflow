import { QueryClient } from "@tanstack/query-core";
import { CLIENT_ERROR_CODES, isApiError } from "./error";
import { isWorkspaceKey } from "./keys";
import type { ApiScope, ScopeTransition } from "./scope";

/** Freshness windows (ms). Most reads use `default`; see spec "Web data layer". */
export const STALE_TIME = {
  default: 30_000,
  /** Brand and other configuration lists. */
  config: 60_000,
  /** Billing activation and active job status: always refetch, poll on `POLL_INTERVAL_MS`. */
  live: 0,
} as const;

export const GC_TIME = 300_000;

/** Bounded polling cadence for active jobs and billing activation. */
export const POLL_INTERVAL_MS = { min: 2_000, max: 5_000 } as const;

/** Reads give up after two retries; a `Retry-After` longer than this ends retrying instead. */
export const MAX_READ_RETRIES = 2;
export const MAX_RETRY_AFTER_SECONDS = 30;

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 4_000;

/**
 * Whether a failed read should be retried. Transport failures, 5xx (except
 * 501/505) and 429 are retried up to twice; every other 4xx, scope changes and
 * non-API errors (aborts, programming errors) are not.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_READ_RETRIES || !isApiError(error)) return false;
  if (
    error.retryAfterSeconds !== undefined &&
    error.retryAfterSeconds > MAX_RETRY_AFTER_SECONDS
  ) {
    return false;
  }
  if (error.code === CLIENT_ERROR_CODES.network) return true;
  if (error.status === 429) return true;
  return error.status >= 500 && error.status !== 501 && error.status !== 505;
}

/** Milliseconds before retry `attempt` (0-based): the server's `Retry-After`, else jittered backoff. */
export function queryRetryDelay(
  attempt: number,
  error: unknown,
  random: () => number = Math.random,
): number {
  if (isApiError(error) && error.retryAfterSeconds !== undefined) {
    return Math.min(error.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) * 1000;
  }
  const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return Math.round(ceiling * (0.5 + random() / 2));
}

/**
 * The shared QueryClient. Reads: 30s fresh, 5 min cached, refetch stale data
 * on focus/reconnect, retry per `shouldRetryQuery`. Mutations never retry on
 * their own (a retry is a deliberate user action reusing its idempotency key).
 * Nothing is dehydrated, so grants and personal data cannot reach any
 * persister or SSR payload by accident.
 */
export function createApiQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME.default,
        gcTime: GC_TIME,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: shouldRetryQuery,
        retryDelay: (attempt, error) => queryRetryDelay(attempt, error),
      },
      mutations: { retry: false },
      dehydrate: {
        shouldDehydrateQuery: () => false,
        shouldDehydrateMutation: () => false,
      },
    },
  });
}

function dropProtected(queryClient: QueryClient, transition: ScopeTransition): void {
  const { previous } = transition;
  if (transition.kind === "user") {
    // Sign-out or account switch: nothing from the old identity survives.
    void queryClient.cancelQueries();
    queryClient.clear();
    return;
  }
  if (previous.userId === null) return;
  const userId = previous.userId;
  const workspaceId = previous.workspaceId ?? undefined;
  const isOld = (key: readonly unknown[]) =>
    workspaceId !== undefined && isWorkspaceKey(key, userId, workspaceId);
  void queryClient.cancelQueries({ predicate: (query) => isOld(query.queryKey) });
  queryClient.removeQueries({ predicate: (query) => isOld(query.queryKey) });
  // A pending command from the old Workspace must not be observed, or retried, in the new one.
  queryClient.getMutationCache().clear();
}

/**
 * Cancels and clears cache state on every scope change. Runs after in-flight
 * transport requests are aborted and before the new scope is visible, so no
 * old-scope result can land in a new-scope view. Identity-only (`session`)
 * queries survive a Workspace switch. Returns an unsubscribe function.
 */
export function bindQueryClientToScope(queryClient: QueryClient, scope: ApiScope): () => void {
  return scope.onBeforeChange((transition) => dropProtected(queryClient, transition));
}
