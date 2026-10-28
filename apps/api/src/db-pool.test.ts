import { describe, expect, test } from "bun:test";
import { databasePoolOptions } from "@narriflow/db/client";

describe("databasePoolOptions", () => {
  test("a process without pool settings keeps the driver defaults", () => {
    expect(databasePoolOptions({})).toEqual({});
  });

  test("maps the three settings to the pool's option names", () => {
    expect(
      databasePoolOptions({
        DATABASE_POOL_MAX: "10",
        DATABASE_POOL_IDLE_TIMEOUT_MS: "30000",
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: "10000",
      }),
    ).toEqual({ max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  });

  test.each(["0", "-1", "1.5", "ten", ""])("ignores the invalid value %p", (value) => {
    expect(databasePoolOptions({ DATABASE_POOL_MAX: value })).toEqual({});
  });
});
