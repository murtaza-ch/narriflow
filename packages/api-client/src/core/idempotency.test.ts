import { describe, expect, test } from "bun:test";
import { createIntent } from "./idempotency";
import { ApiScope } from "./scope";
import { USER, WORKSPACE_A, WORKSPACE_B } from "./test-helpers";

function counter() {
  let n = 0;
  return () => `key-${++n}`;
}

describe("createIntent", () => {
  test("the same input keeps its key across retries until completed", () => {
    const intent = createIntent<{ name: string }>({ randomUUID: counter() });
    expect(intent.keyFor({ name: "a" })).toBe("key-1");
    expect(intent.keyFor({ name: "a" })).toBe("key-1");
    intent.complete();
    expect(intent.keyFor({ name: "a" })).toBe("key-2");
  });

  test("a changed payload mints a new key, regardless of property order", () => {
    const intent = createIntent<Record<string, unknown>>({ randomUUID: counter() });
    expect(intent.keyFor({ a: 1, b: 2 })).toBe("key-1");
    expect(intent.keyFor({ b: 2, a: 1 })).toBe("key-1");
    expect(intent.keyFor({ a: 1, b: 3 })).toBe("key-2");
    expect(intent.keyFor({ a: 1, b: 2 })).toBe("key-3");
  });

  test("a user or Workspace change never carries a key into the new scope", () => {
    const scope = new ApiScope();
    scope.setUser(USER);
    scope.selectWorkspace(WORKSPACE_A);
    const intent = createIntent<{ n: number }>({ randomUUID: counter(), scope });
    expect(intent.keyFor({ n: 1 })).toBe("key-1");
    scope.selectWorkspace(WORKSPACE_B);
    expect(intent.keyFor({ n: 1 })).toBe("key-2");
    scope.setUser("someone-else");
    expect(intent.keyFor({ n: 1 })).toBe("key-3");
  });

  test("default keys are unique UUIDs", () => {
    const first = createIntent<number>();
    const second = createIntent<number>();
    const a = first.keyFor(1);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.keyFor(1)).not.toBe(a);
    expect(a.length).toBeLessThanOrEqual(128);
  });

  test("non-serializable inputs fail loudly instead of sharing a key", () => {
    const intent = createIntent<unknown>({ randomUUID: counter() });
    expect(() => intent.keyFor({ at: new Date() })).toThrow(TypeError);
  });
});
