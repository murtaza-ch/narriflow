import { describe, expect, test } from "bun:test";
import {
  clearCheckoutKey,
  getOrCreateCheckoutKey,
  pollBillingActivation,
} from "./billing-browser";

describe("billing browser adapter", () => {
  test("stores the Checkout key before the first request and reuses it", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    let generated = 0;
    const first = getOrCreateCheckoutKey({
      storage,
      workspaceId: "workspace-a",
      tier: "pro",
      interval: "annual",
      createKey: () => `key-${++generated}`,
    });
    const replay = getOrCreateCheckoutKey({
      storage,
      workspaceId: "workspace-a",
      tier: "pro",
      interval: "annual",
      createKey: () => `key-${++generated}`,
    });

    expect(first).toBe("key-1");
    expect(replay).toBe(first);
    expect(generated).toBe(1);

    clearCheckoutKey({
      storage: { ...storage, removeItem: (key) => values.delete(key) },
      workspaceId: "workspace-a",
      tier: "pro",
      interval: "annual",
    });
    expect(
      getOrCreateCheckoutKey({
        storage,
        workspaceId: "workspace-a",
        tier: "pro",
        interval: "annual",
        createKey: () => `key-${++generated}`,
      }),
    ).toBe("key-2");
  });

  test("polls through one network failure and stops after verified activation", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await pollBillingActivation({
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        if (calls === 2) {
          return {
            view: { health: "activating" as const },
            retryAfterSeconds: 3,
          };
        }
        return { view: { health: "current" as const } };
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      random: () => 0,
      maxAttempts: 4,
    });

    expect(result.view.health).toBe("current");
    expect(waits).toEqual([2_000, 3_000]);
  });
});
