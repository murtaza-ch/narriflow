import { describe, expect, test } from "bun:test";
import { clearSignedInBrowserState } from "./sign-out-storage";

function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("clearSignedInBrowserState", () => {
  test("removes per-user hints, checkout intents, leases and return state", () => {
    const local = memoryStorage({
      "narriflow:workspace:user_1": "w",
      "narriflow.checkout.v1:w:creator:annual": "key",
      "narriflow:studio-lease:p:c": "{}",
      "narriflow:studio-lease:p:c:generation": "3",
      "narriflow:recent-searches:w": "[]",
    });
    const session = memoryStorage({
      "narriflow.settings-return": "{}",
      "narriflow:campaign-clip-selection:v1": "{}",
    });
    clearSignedInBrowserState(local, session);
    expect(local.map.size).toBe(0);
    expect(session.map.size).toBe(0);
  });

  test("keeps unsaved work, appearance and review credentials", () => {
    const local = memoryStorage({
      "narriflow:publishing:u:w:p": "draft",
      "narriflow-color-mode": "dark",
    });
    const session = memoryStorage({ "nf-review-session:abc": "{}" });
    clearSignedInBrowserState(local, session);
    expect([...local.map.keys()].sort()).toEqual(["narriflow-color-mode", "narriflow:publishing:u:w:p"]);
    expect(session.map.size).toBe(1);
  });

  test("tolerates blocked storage", () => {
    const blocked = {
      get length(): number {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => clearSignedInBrowserState(blocked, blocked)).not.toThrow();
  });
});
