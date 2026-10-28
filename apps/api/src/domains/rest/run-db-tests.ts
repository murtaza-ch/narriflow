import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";

const databaseUrl = process.env.INTEGRATION_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Run through .scratch/api-extraction/db-gate.sh");
const url = new URL(databaseUrl);
if (url.hostname !== "localhost" || url.port !== "55432") throw new Error("REST gate requires throwaway local PostgreSQL");
const schema = `integration_test_rest_${randomUUID().replaceAll("-", "")}`;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const root = new URL("../../../../../", import.meta.url).pathname;
async function run(command: string[], env: Record<string, string>) {
  const child = spawnSync(command[0]!, command.slice(1), { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" });
  if (child.status !== 0) throw new Error(`REST gate failed: ${command.join(" ")}`);
}
try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const migration = new URL(databaseUrl);
  migration.searchParams.set("schema", schema);
  await run(["bun", "run", "--cwd", "packages/db", "prisma:migrate:deploy"], { DATABASE_URL: migration.href, DIRECT_URL: migration.href });
  const testUrl = new URL(databaseUrl);
  testUrl.searchParams.set("options", `-csearch_path=${schema}`);
  await run(["bun", "test", "apps/api/src/domains/rest/events.db.test.ts"], {
    DATABASE_URL: testUrl.href, DIRECT_URL: testUrl.href,
    INTEGRATION_TEST_DATABASE_URL: testUrl.href,
    INTEGRATION_TEST_DATABASE_SCHEMA: schema,
    ALLOW_INTEGRATION_DB_TESTS: "1",
  });
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
}
