import { describe, expect, mock, test } from "bun:test";
import { createDatabaseReadiness, expectedDatabaseMigrations } from "./database-readiness";
import { createHealthRoutes } from "./health";

describe("migration-aware readiness", () => {
  test("manifest includes shipped SQL migrations and excludes lock files", () => {
    const names = expectedDatabaseMigrations();
    expect(names).toContain("20261030120000_clip_render_caption_diagnostics");
    expect(names).not.toContain("migration_lock.toml");
  });

  test("pending migrations return cached 503, then recover after worker applies them", async () => {
    let now = 0;
    let applied = ["first"];
    const appliedMigrations = mock(async () => applied);
    const log = mock(() => {});
    const onStartupTimeout = mock(() => {});
    const checkDatabase = createDatabaseReadiness({ expectedMigrations: ["first", "second"], appliedMigrations, log, onStartupTimeout });
    const routes = createHealthRoutes({ version: "test", isDraining: () => false, now: () => now, checkDatabase });
    expect((await routes.request("/ready")).status).toBe(503);
    applied = ["first", "second"];
    expect((await routes.request("/ready")).status).toBe(503);
    expect(appliedMigrations).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ level: "warn", message: "api_database_migrations_pending", pending: ["second"] });
    now = 5_001;
    expect((await routes.request("/ready")).status).toBe(200);
    expect(appliedMigrations).toHaveBeenCalledTimes(2);
    expect(onStartupTimeout).not.toHaveBeenCalled();
  });

  test("concurrent probes share a query and cache healthy results too; drain bypasses cache", async () => {
    let draining = false;
    let release!: () => void;
    const checkDatabase = mock(() => new Promise<void>((resolve) => { release = resolve; }));
    const routes = createHealthRoutes({ version: "test", isDraining: () => draining, checkDatabase });
    const requests = Array.from({ length: 20 }, () => routes.request("/ready"));
    await Promise.resolve();
    release();
    expect((await Promise.all(requests)).every((response) => response.status === 200)).toBe(true);
    expect((await routes.request("/ready")).status).toBe(200);
    expect(checkDatabase).toHaveBeenCalledTimes(1);
    draining = true;
    expect((await routes.request("/ready")).status).toBe(503);
  });

  test("a timed-out database query is shared across later cache windows", async () => {
    let now = 0;
    let release!: (names: string[]) => void;
    const appliedMigrations = mock(() => new Promise<string[]>((resolve) => { release = resolve; }));
    const checkDatabase = createDatabaseReadiness({ expectedMigrations: ["first"], appliedMigrations, log: () => {}, onStartupTimeout: () => {} });
    const routes = createHealthRoutes({ version: "test", isDraining: () => false, now: () => now, databaseTimeoutMs: 5, checkDatabase });
    expect((await routes.request("/ready")).status).toBe(503);
    now = 5_001;
    const laterProbe = routes.request("/ready");
    release(["first"]);
    expect((await laterProbe).status).toBe(200);
    expect(appliedMigrations).toHaveBeenCalledTimes(1);
  });

  test("a hung query times out and the failure is cached", async () => {
    const checkDatabase = mock(() => new Promise<void>(() => {}));
    const routes = createHealthRoutes({ version: "test", isDraining: () => false, databaseTimeoutMs: 5, checkDatabase });
    expect((await routes.request("/ready")).status).toBe(503);
    expect((await routes.request("/ready")).status).toBe(503);
    expect(checkDatabase).toHaveBeenCalledTimes(1);
  });

  test("a failed startup has a bounded watchdog and sanitized logs", async () => {
    const onStartupTimeout = mock(() => {});
    const log = mock(() => {});
    const check = createDatabaseReadiness({ expectedMigrations: ["first"], appliedMigrations: async () => { throw new Error("secret connection URL"); }, log, onStartupTimeout, startupTimeoutMs: 5 });
    await expect(check()).rejects.toThrow("database_readiness_unavailable");
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(onStartupTimeout).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret connection URL");
  });

  test("a successful startup cancels its watchdog", async () => {
    const onStartupTimeout = mock(() => {});
    const check = createDatabaseReadiness({ expectedMigrations: [], appliedMigrations: async () => [], log: () => {}, onStartupTimeout, startupTimeoutMs: 5 });
    await check();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(onStartupTimeout).not.toHaveBeenCalled();
  });
});
