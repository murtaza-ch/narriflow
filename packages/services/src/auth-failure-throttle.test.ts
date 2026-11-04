import { describe, expect, test } from "bun:test";
import { authFailureThrottle } from "./auth-failure-throttle";

function limiter(budget: number) {
  const used = new Map<string, number>();
  const result = (key: string) => ({ allowed: (used.get(key) ?? 0) < budget, availability: "available" as const, remaining: 0, limit: budget });
  return {
    keys: used,
    read: async (key: string) => result(key),
    check: async (key: string) => { used.set(key, (used.get(key) ?? 0) + 1); return result(key); },
  };
}

describe("authFailureThrottle", () => {
  test("peeks without spending and counts only recorded failures, per scope and address", async () => {
    const io = limiter(2);
    const throttle = authFailureThrottle("mcp", "203.0.113.9", io);
    expect(await throttle.exhausted()).toBe(false);
    expect(io.keys.size).toBe(0);
    await throttle.recordFailure();
    await throttle.recordFailure();
    expect(await throttle.exhausted()).toBe(true);
    expect([...io.keys.keys()]).toEqual(["mcp:authfail:203.0.113.9"]);
    expect(await authFailureThrottle("rest", "203.0.113.9", io).exhausted()).toBe(false);
    expect(await authFailureThrottle("mcp", "203.0.113.10", io).exhausted()).toBe(false);
  });
});
