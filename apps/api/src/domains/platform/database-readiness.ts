import { existsSync, readdirSync } from "node:fs";

/** The image contains the migration tree, so readiness checks exactly its revision. */
export function expectedDatabaseMigrations(): string[] {
  const directory = new URL("../../../../../packages/db/prisma/migrations/", import.meta.url);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/migration.sql`, directory)))
    .map((entry) => entry.name)
    .sort();
}

/** Read-only startup barrier. The caller caches probes; a failed startup exits
 * rather than waiting forever for a worker migration that may have failed. */
export function createDatabaseReadiness(options: {
  expectedMigrations: readonly string[];
  appliedMigrations(): Promise<readonly string[]>;
  startupTimeoutMs?: number;
  onStartupTimeout(): void;
  log(entry: Record<string, unknown>): void;
}): () => Promise<void> {
  let readyOnce = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let appliedQuery: Promise<readonly string[]> | undefined;

  return async () => {
    // Local development may have no health-check caller. Only a probe starts
    // the startup deadline; Railway probes immediately during deployment.
    if (!readyOnce && !watchdog) {
      watchdog = setTimeout(() => {
        options.log({ level: "error", message: "api_database_startup_deadline_exceeded", timeoutMs: options.startupTimeoutMs ?? 180_000 });
        options.onStartupTimeout();
      }, options.startupTimeoutMs ?? 180_000);
      watchdog.unref();
    }
    let applied: readonly string[];
    try {
      // A timed-out HTTP response must not start overlapping database queries.
      appliedQuery ??= options.appliedMigrations().finally(() => { appliedQuery = undefined; });
      applied = await appliedQuery;
    } catch {
      options.log({ level: "warn", message: "api_database_readiness_unavailable" });
      throw new Error("database_readiness_unavailable");
    }
    const names = new Set(applied);
    const pending = options.expectedMigrations.filter((name) => !names.has(name));
    if (pending.length) {
      options.log({ level: "warn", message: "api_database_migrations_pending", pending });
      throw new Error("database_migrations_pending");
    }
    if (!readyOnce) {
      readyOnce = true;
      clearTimeout(watchdog);
      options.log({ level: "info", message: "api_database_migrations_ready", migrationCount: options.expectedMigrations.length });
    }
  };
}
