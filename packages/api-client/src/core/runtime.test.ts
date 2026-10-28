import { describe, expect, test } from "bun:test";
import { ApiError, CLIENT_ERROR_CODES } from "./error";
import { scopedKey, sessionKey } from "./keys";
import { createApiRuntime } from "./runtime";
import type { HintStorage } from "./scope";
import {
  deferred,
  errorResponse,
  fakeFetch,
  jsonResponse,
  USER,
  WORKSPACE_A,
  WORKSPACE_B,
} from "./test-helpers";

function memoryStorage(): HintStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function runtime(handlers: Parameters<typeof fakeFetch>, storage = memoryStorage()) {
  const { fetch, calls } = fakeFetch(...handlers);
  const failures: string[] = [];
  const rt = createApiRuntime({
    baseUrl: "https://api.example.test",
    getToken: async () => "token",
    hintStorage: storage,
    fetch,
    onWorkspaceSelectionChanged: (e) => failures.push(e.code),
  });
  return { rt, calls, storage, failures };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("identity and hint", () => {
  test("setIdentity restores the saved hint for that user only", () => {
    const storage = memoryStorage();
    const first = runtime([() => jsonResponse({})], storage).rt;
    first.setIdentity(USER);
    first.selectWorkspace(WORKSPACE_A);
    expect(storage.data.get(first.hints.keyFor(USER))).toBe(WORKSPACE_A);

    const second = runtime([() => jsonResponse({})], storage).rt;
    second.setIdentity(USER);
    expect(second.scope.snapshot()).toMatchObject({ userId: USER, workspaceId: WORKSPACE_A });
    second.setIdentity("another-user");
    expect(second.scope.snapshot()).toMatchObject({ userId: "another-user", workspaceId: null });
  });

  test("the effective selection is remembered; only the Workspace id is stored", () => {
    const { rt, storage } = runtime([() => jsonResponse({})]);
    rt.setIdentity(USER);
    rt.selectWorkspace(WORKSPACE_B);
    expect([...storage.data.entries()]).toEqual([[`narriflow:workspace:${USER}`, WORKSPACE_B]]);
  });

  test("another tab's selection is followed after a storage event", () => {
    const { rt, storage } = runtime([() => jsonResponse({})]);
    rt.setIdentity(USER);
    rt.selectWorkspace(WORKSPACE_A);
    storage.data.set(rt.hints.keyFor(USER), WORKSPACE_B);
    rt.syncHintFromStorage();
    expect(rt.scope.snapshot().workspaceId).toBe(WORKSPACE_B);
    storage.data.set(rt.hints.keyFor(USER), "garbage");
    rt.syncHintFromStorage();
    expect(rt.scope.snapshot().workspaceId).toBe(WORKSPACE_B);
  });

  test("sign-out clears the cache and forgets the scope but keeps the hint for next sign-in", async () => {
    const { rt, storage } = runtime([() => jsonResponse({})]);
    rt.setIdentity(USER);
    rt.selectWorkspace(WORKSPACE_A);
    rt.queryClient.setQueryData(
      scopedKey({ userId: USER, workspaceId: WORKSPACE_A }, "projects", "list") as unknown[],
      [1],
    );
    rt.setIdentity(null);
    expect(rt.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(rt.scope.snapshot()).toMatchObject({ userId: null, workspaceId: null });
    expect(storage.data.get(rt.hints.keyFor(USER))).toBe(WORKSPACE_A);
  });
});

describe("end-to-end scope behaviour", () => {
  test("a query in flight for Workspace A never lands in B's view after a switch", async () => {
    const gate = deferred<Response>();
    const { rt } = runtime([() => gate.promise]);
    rt.setIdentity(USER);
    rt.selectWorkspace(WORKSPACE_A);
    const scopeA = { userId: USER, workspaceId: WORKSPACE_A };
    const keyA = scopedKey(scopeA, "projects", "list") as unknown[];
    const pending = rt.queryClient.fetchQuery({
      queryKey: keyA,
      queryFn: ({ signal }) =>
        rt.transport.scoped(scopeA).json("/api/projects", { signal }),
      retry: false,
    });
    await flush();
    rt.selectWorkspace(WORKSPACE_B);
    gate.resolve(jsonResponse({ projects: ["secret-of-A"] }));
    await pending.catch(() => undefined);
    expect(rt.queryClient.getQueryData(keyA)).toBeUndefined();
    const keyB = scopedKey({ userId: USER, workspaceId: WORKSPACE_B }, "projects", "list") as unknown[];
    expect(rt.queryClient.getQueryData(keyB)).toBeUndefined();
  });

  test("a click in Workspace A is never silently replayed in B", async () => {
    const gate = deferred<Response>();
    const { rt, calls } = runtime([() => gate.promise, () => jsonResponse({ created: true })]);
    rt.setIdentity(USER);
    rt.selectWorkspace(WORKSPACE_A);
    const scopeA = { userId: USER, workspaceId: WORKSPACE_A };
    const intent = rt.createIntent<{ name: string }>();
    const input = { name: "folder" };
    const submit = () =>
      rt.transport
        .scoped(scopeA)
        .json("/api/library/folders", { json: input, idempotencyKey: intent.keyFor(input) });
    const first = submit();
    await flush();
    rt.selectWorkspace(WORKSPACE_B);
    const error = (await first.catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
    // The retry a UI might attempt with the old scope is refused locally.
    const retry = (await submit().catch((e: unknown) => e)) as ApiError;
    expect(retry.code).toBe(CLIENT_ERROR_CODES.scopeChanged);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("X-Workspace-Id")).toBe(WORKSPACE_A);
  });

  test("mutations use the shared defaults: no automatic retry", async () => {
    const { rt, calls } = runtime([() => errorResponse(500, "internal_error")]);
    rt.setIdentity(USER);
    rt.selectWorkspace(WORKSPACE_A);
    const scopeA = { userId: USER, workspaceId: WORKSPACE_A };
    const mutation = rt.queryClient.getMutationCache().build(rt.queryClient, {
      mutationFn: () => rt.transport.scoped(scopeA).json("/api/x", { method: "POST", json: {} }),
    });
    await mutation.execute(undefined).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  test("session queries survive a Workspace switch", () => {
    const { rt } = runtime([() => jsonResponse({})]);
    rt.setIdentity(USER);
    const key = sessionKey({ userId: USER }, "bootstrap") as unknown[];
    rt.queryClient.setQueryData(key, { memberships: [] });
    rt.selectWorkspace(WORKSPACE_A);
    rt.selectWorkspace(WORKSPACE_B);
    expect(rt.queryClient.getQueryData(key)).toBeDefined();
  });

  test("a 409 selection refusal is surfaced through the hook, not retried or replayed", async () => {
    const { rt, calls, failures } = runtime([() => errorResponse(409, "workspace_selection_changed")]);
    rt.setIdentity(USER);
    rt.selectWorkspace(WORKSPACE_A);
    const scopeA = { userId: USER, workspaceId: WORKSPACE_A };
    const error = (await rt.queryClient
      .fetchQuery({
        queryKey: scopedKey(scopeA, "projects", "list") as unknown[],
        queryFn: () => rt.transport.scoped(scopeA).json("/api/projects"),
      })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("workspace_selection_changed");
    expect(calls).toHaveLength(1);
    expect(failures).toEqual(["workspace_selection_changed"]);
  });
});
