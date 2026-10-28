import { describe, expect, test } from "bun:test";
import { applyApiPoolDefaults } from "./runtime";

describe("applyApiPoolDefaults", () => {
  test("supplies the API's pool sizing when nothing is configured", () => {
    const env: Record<string, string | undefined> = {};
    applyApiPoolDefaults(env);
    expect(env).toEqual({
      DATABASE_POOL_MAX: "10",
      DATABASE_POOL_IDLE_TIMEOUT_MS: "30000",
      DATABASE_POOL_CONNECTION_TIMEOUT_MS: "10000",
    });
  });

  test("an explicit setting always wins", () => {
    const env: Record<string, string | undefined> = { DATABASE_POOL_MAX: "4" };
    applyApiPoolDefaults(env);
    expect(env.DATABASE_POOL_MAX).toBe("4");
  });
});
