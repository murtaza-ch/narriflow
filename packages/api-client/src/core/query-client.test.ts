import { describe, expect, test } from "bun:test";
import { dehydrate, QueryClient } from "@tanstack/query-core";
import { ApiError, CLIENT_ERROR_CODES } from "./error";
import { scopedKey, sessionKey } from "./keys";
import {
  bindQueryClientToScope,
  createApiQueryClient,
  GC_TIME,
  queryRetryDelay,
  shouldRetryQuery,
  STALE_TIME,
} from "./query-client";
import { ApiScope } from "./scope";
import { USER, WORKSPACE_A, WORKSPACE_B } from "./test-helpers";

const apiError = (status: number, code = "x", retryAfterSeconds?: number) =>
  new ApiError({ code, message: "m", status, retryAfterSeconds });

describe("defaults", () => {
  test("spec timings, focus/reconnect refetch, no mutation retries", () => {
    const client = createApiQueryClient();
    const queries = client.getDefaultOptions().queries;
    expect(queries?.staleTime).toBe(30_000);
    expect(queries?.gcTime).toBe(300_000);
    expect(STALE_TIME).toEqual({ default: 30_000, config: 60_000, live: 0 });
    expect(GC_TIME).toBe(300_000);
    expect(queries?.refetchOnWindowFocus).toBe(true);
    expect(queries?.refetchOnReconnect).toBe(true);
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
  });

  test("nothing is dehydrated, so grants and personal data are never persisted", () => {
    const client = createApiQueryClient();
    client.setQueryData(scopedKey({ userId: USER, workspaceId: WORKSPACE_A }, "exports", "grant"), {
      url: "https://signed.example/secret",
    });
    expect(dehydrate(client).queries).toEqual([]);
  });
});

describe("shouldRetryQuery", () => {
  test("retries network failures and 5xx at most twice", () => {
    const network = apiError(0, CLIENT_ERROR_CODES.network);
    expect(shouldRetryQuery(0, network)).toBe(true);
    expect(shouldRetryQuery(1, network)).toBe(true);
    expect(shouldRetryQuery(2, network)).toBe(false);
    for (const status of [500, 502, 503, 504]) expect(shouldRetryQuery(0, apiError(status))).toBe(true);
    expect(shouldRetryQuery(0, apiError(501))).toBe(false);
  });

  test("never retries client errors blindly", () => {
    for (const status of [400, 401, 402, 403, 404, 409, 422]) {
      expect(shouldRetryQuery(0, apiError(status))).toBe(false);
    }
  });

  test("retries 429, but not when Retry-After is longer than the bound", () => {
    expect(shouldRetryQuery(0, apiError(429, "rate_limited"))).toBe(true);
    expect(shouldRetryQuery(0, apiError(429, "rate_limited", 10))).toBe(true);
    expect(shouldRetryQuery(0, apiError(429, "rate_limited", 31))).toBe(false);
    expect(shouldRetryQuery(0, apiError(503, "mutations_unavailable", 600))).toBe(false);
  });

  test("never retries scope changes, aborts or programming errors", () => {
    expect(shouldRetryQuery(0, apiError(0, CLIENT_ERROR_CODES.scopeChanged))).toBe(false);
    expect(shouldRetryQuery(0, new DOMException("a", "AbortError"))).toBe(false);
    expect(shouldRetryQuery(0, new TypeError("bug"))).toBe(false);
  });
});

describe("queryRetryDelay", () => {
  test("honours Retry-After, capped", () => {
    expect(queryRetryDelay(0, apiError(503, "x", 5))).toBe(5_000);
    expect(queryRetryDelay(0, apiError(503, "x", 600))).toBe(30_000);
  });

  test("otherwise exponential backoff with jitter inside [50%, 100%]", () => {
    expect(queryRetryDelay(0, apiError(500), () => 1)).toBe(500);
    expect(queryRetryDelay(0, apiError(500), () => 0)).toBe(250);
    expect(queryRetryDelay(1, apiError(500), () => 1)).toBe(1_000);
    expect(queryRetryDelay(10, apiError(500), () => 1)).toBe(4_000);
  });

  test("a failing read really is retried twice and then surfaces the error", async () => {
    const client = createApiQueryClient();
    let calls = 0;
    const result = client.fetchQuery({
      queryKey: ["nf", "t"],
      queryFn: () => {
        calls += 1;
        throw apiError(500, "internal_error", 1);
      },
      retryDelay: 1,
    });
    await expect(result).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(3);
  });

  test("a 404 read is attempted once", async () => {
    const client = createApiQueryClient();
    let calls = 0;
    await expect(
      client.fetchQuery({
        queryKey: ["nf", "t"],
        queryFn: () => {
          calls += 1;
          throw apiError(404, "project_not_found");
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });
});

describe("scope binding", () => {
  function seeded() {
    const scope = new ApiScope();
    const queryClient = createApiQueryClient();
    bindQueryClientToScope(queryClient, scope);
    scope.setUser(USER);
    scope.selectWorkspace(WORKSPACE_A);
    const keys = {
      session: sessionKey({ userId: USER }, "bootstrap"),
      projectsA: scopedKey({ userId: USER, workspaceId: WORKSPACE_A }, "projects", "list"),
      billingA: scopedKey({ userId: USER, workspaceId: WORKSPACE_A }, "billing", "state"),
      guest: ["nf-guest", "a".repeat(64), "room"],
    };
    for (const key of Object.values(keys)) queryClient.setQueryData(key as unknown[], { data: 1 });
    return { scope, queryClient, keys };
  }

  test("switching Workspace removes the old Workspace's queries but keeps identity and guest state", () => {
    const { scope, queryClient, keys } = seeded();
    scope.selectWorkspace(WORKSPACE_B);
    expect(queryClient.getQueryData(keys.projectsA as unknown[])).toBeUndefined();
    expect(queryClient.getQueryData(keys.billingA as unknown[])).toBeUndefined();
    expect(queryClient.getQueryData(keys.session as unknown[])).toBeDefined();
    expect(queryClient.getQueryData(keys.guest as unknown[])).toBeDefined();
  });

  test("an in-flight read for the old Workspace is cancelled", async () => {
    const { scope, queryClient, keys } = seeded();
    let cancelled = false;
    const pending = queryClient.fetchQuery({
      queryKey: keys.projectsA as unknown[],
      staleTime: 0,
      queryFn: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            cancelled = true;
            reject(new Error("cancelled"));
          });
        }),
    });
    scope.selectWorkspace(WORKSPACE_B);
    await pending.catch(() => undefined);
    expect(cancelled).toBe(true);
  });

  test("pending mutations are cleared on a Workspace switch", async () => {
    const { scope, queryClient } = seeded();
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => new Promise(() => undefined),
    });
    void mutation.execute(undefined).catch(() => undefined);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);
    scope.selectWorkspace(WORKSPACE_B);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  test("sign-out and user change clear everything, including identity queries", () => {
    const { scope, queryClient, keys } = seeded();
    scope.setUser(null);
    for (const key of Object.values(keys)) {
      expect(queryClient.getQueryData(key as unknown[])).toBeUndefined();
    }
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  test("the first Workspace selection after bootstrap does not discard the session", () => {
    const scope = new ApiScope();
    const queryClient = new QueryClient();
    bindQueryClientToScope(queryClient, scope);
    scope.setUser(USER);
    const session = sessionKey({ userId: USER }, "bootstrap");
    queryClient.setQueryData(session as unknown[], { memberships: [] });
    scope.selectWorkspace(WORKSPACE_A);
    expect(queryClient.getQueryData(session as unknown[])).toBeDefined();
  });
});
