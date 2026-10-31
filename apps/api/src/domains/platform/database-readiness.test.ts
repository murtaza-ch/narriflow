import { expect, test } from "bun:test";
import { createDatabaseReadiness, expectedDatabaseMigrations } from "./database-readiness";

test("readiness uses the generated migration manifest", () => {
  const names = expectedDatabaseMigrations();
  expect(names.length).toBeGreaterThan(0);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toEqual([...names].sort());
});

test("each invocation checks its own database and never reuses a successful probe", async () => {
  let applied: string[] = [];
  const check = createDatabaseReadiness({ expectedMigrations: ["one"], appliedMigrations: async () => applied, log: () => {} });
  await expect(check()).rejects.toThrow("database_migrations_pending");
  applied = ["one"];
  await expect(check()).resolves.toBeUndefined();
  applied = [];
  await expect(check()).rejects.toThrow("database_migrations_pending");
});

test("database errors report only a bounded diagnostic", async () => {
  const entries: Record<string, unknown>[] = [];
  const check = createDatabaseReadiness({ expectedMigrations: [], appliedMigrations: async () => { throw new Error("private database URL"); }, log: (entry) => { entries.push(entry); } });
  await expect(check()).rejects.toThrow("database_readiness_unavailable");
  expect(JSON.stringify(entries)).not.toContain("private database URL");
});
