import { describe, expect, test } from "bun:test";
import { ApiScope, createWorkspaceHintStore, type HintStorage, type ScopeTransition } from "./scope";
import { USER, WORKSPACE_A, WORKSPACE_B } from "./test-helpers";

function memoryStorage(): HintStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("ApiScope", () => {
  test("starts signed out and versions every change", () => {
    const scope = new ApiScope();
    expect(scope.snapshot()).toEqual({ userId: null, workspaceId: null, version: 0 });
    expect(scope.setUser(USER)).toBe(true);
    expect(scope.setUser(USER)).toBe(false);
    expect(scope.selectWorkspace(WORKSPACE_A)).toBe(true);
    expect(scope.selectWorkspace(WORKSPACE_A)).toBe(false);
    expect(scope.snapshot().version).toBe(2);
    const before = scope.snapshot();
    expect(scope.snapshot()).toBe(before);
  });

  test("a Workspace needs a user", () => {
    const scope = new ApiScope();
    expect(scope.selectWorkspace(WORKSPACE_A)).toBe(false);
    expect(scope.snapshot().workspaceId).toBeNull();
  });

  test("changing the user resets the Workspace", () => {
    const scope = new ApiScope();
    scope.setUser(USER);
    scope.selectWorkspace(WORKSPACE_A);
    scope.setUser("other");
    expect(scope.snapshot()).toMatchObject({ userId: "other", workspaceId: null });
  });

  test("isCurrent compares identity and, for scoped targets, the Workspace", () => {
    const scope = new ApiScope();
    scope.setUser(USER);
    scope.selectWorkspace(WORKSPACE_A);
    expect(scope.isCurrent({ userId: USER, workspaceId: WORKSPACE_A })).toBe(true);
    expect(scope.isCurrent({ userId: USER, workspaceId: WORKSPACE_B })).toBe(false);
    expect(scope.isCurrent({ userId: USER, workspaceId: null })).toBe(true);
    expect(scope.isCurrent({ userId: "x", workspaceId: null })).toBe(false);
  });

  test("order: abort in-flight, run before-change handlers, then move, then notify", () => {
    const scope = new ApiScope();
    scope.setUser(USER);
    scope.selectWorkspace(WORKSPACE_A);
    const events: string[] = [];
    const request = scope.track({ userId: USER, workspaceId: WORKSPACE_A });
    request.signal.addEventListener("abort", () => events.push("aborted"));
    scope.onBeforeChange(() => {
      events.push(`before:${scope.snapshot().workspaceId}`);
    });
    scope.subscribe((snapshot) => events.push(`after:${snapshot.workspaceId}`));
    scope.selectWorkspace(WORKSPACE_B);
    expect(events).toEqual(["aborted", `before:${WORKSPACE_A}`, `after:${WORKSPACE_B}`]);
    expect(request.scopeAborted).toBe(true);
  });

  test("a Workspace change leaves identity-only requests alone; a user change aborts everything", () => {
    const scope = new ApiScope();
    scope.setUser(USER);
    scope.selectWorkspace(WORKSPACE_A);
    const scoped = scope.track({ userId: USER, workspaceId: WORKSPACE_A });
    const identity = scope.track({ userId: USER, workspaceId: null });
    scope.selectWorkspace(WORKSPACE_B);
    expect(scoped.signal.aborted).toBe(true);
    expect(identity.signal.aborted).toBe(false);
    scope.setUser(null);
    expect(identity.signal.aborted).toBe(true);
    expect(identity.scopeAborted).toBe(true);
  });

  test("a caller abort is not a scope abort, and released requests are not touched", () => {
    const scope = new ApiScope();
    scope.setUser(USER);
    const caller = new AbortController();
    const request = scope.track({ userId: USER, workspaceId: null }, caller.signal);
    caller.abort(new Error("user cancelled"));
    expect(request.signal.aborted).toBe(true);
    expect(request.scopeAborted).toBe(false);
    const done = scope.track({ userId: USER, workspaceId: null });
    done.release();
    scope.setUser("other");
    expect(done.signal.aborted).toBe(false);
  });

  test("a throwing handler cannot stop the transition", () => {
    const scope = new ApiScope();
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      scope.onBeforeChange(() => {
        throw new Error("boom");
      });
      scope.subscribe(() => {
        throw new Error("boom");
      });
      expect(scope.setUser(USER)).toBe(true);
      expect(scope.snapshot().userId).toBe(USER);
    } finally {
      console.warn = warn;
    }
  });

  test("reports the transition kind and previous scope", () => {
    const scope = new ApiScope();
    const seen: ScopeTransition[] = [];
    scope.onBeforeChange((transition) => seen.push(transition));
    scope.setUser(USER);
    scope.selectWorkspace(WORKSPACE_A);
    expect(seen.map((transition) => transition.kind)).toEqual(["user", "workspace"]);
    expect(seen[1]?.previous).toMatchObject({ userId: USER, workspaceId: null });
    expect(seen[1]?.next).toMatchObject({ userId: USER, workspaceId: WORKSPACE_A });
  });
});

describe("workspace hint store", () => {
  test("keys by Clerk user and only returns well-formed Workspace ids", () => {
    const storage = memoryStorage();
    const store = createWorkspaceHintStore(storage);
    store.write(USER, WORKSPACE_A);
    expect(store.read(USER)).toBe(WORKSPACE_A);
    expect(store.read("other")).toBeNull();
    storage.data.set(store.keyFor(USER), "<script>");
    expect(store.read(USER)).toBeNull();
    store.write(USER, null);
    expect(storage.data.size).toBe(0);
  });

  test("storage failures and absent storage are non-fatal", () => {
    const broken: HintStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("full");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    const store = createWorkspaceHintStore(broken);
    expect(store.read(USER)).toBeNull();
    expect(() => store.write(USER, WORKSPACE_A)).not.toThrow();
    const none = createWorkspaceHintStore(null);
    expect(none.read(USER)).toBeNull();
    expect(() => none.write(USER, WORKSPACE_A)).not.toThrow();
  });

  test("persists only the Workspace id, nothing credential-like", () => {
    const storage = memoryStorage();
    createWorkspaceHintStore(storage).write(USER, WORKSPACE_A);
    expect([...storage.data.values()]).toEqual([WORKSPACE_A]);
  });
});
