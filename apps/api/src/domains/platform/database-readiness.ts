import migrations from "../../generated/database-migrations.json";

/** Generated at build time. A Worker never reads the host filesystem. */
export function expectedDatabaseMigrations(): string[] {
  return [...migrations];
}

/** Each probe reads through its own invocation scope. No pending query or
 * startup timer can retain another invocation's client. */
export function createDatabaseReadiness(options: {
  expectedMigrations: readonly string[];
  appliedMigrations(): Promise<readonly string[]>;
  log(entry: Record<string, unknown>): void;
}): () => Promise<void> {
  return async () => {
    let applied: readonly string[];
    try {
      applied = await options.appliedMigrations();
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
  };
}
