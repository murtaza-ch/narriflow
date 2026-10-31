import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { assertExecutionDatabaseTestTarget } from "../src/execution-db-test-support";

const configuredUrl = process.env.SERVERLESS_TEST_DATABASE_URL;
if (!configuredUrl) throw new Error("SERVERLESS_TEST_DATABASE_URL must name an isolated database branch");
const target = new URL(configuredUrl);
if (target.hostname.includes("ep-rough-hill-b57kvyah")) {
  throw new Error("Serverless gates cannot run against shared narriflow-dev");
}
if (target.hostname.includes("-pooler.")) throw new Error("Serverless gates require a direct TLS connection");
const schema = `serverless_execution_test_${randomUUID().replaceAll("-", "")}`;
assertExecutionDatabaseTestTarget(configuredUrl, schema);
const pool = new Pool({ connectionString: configuredUrl, max: 1 });
const migrationUrl = new URL(configuredUrl);
migrationUrl.searchParams.delete("options");
migrationUrl.searchParams.set("schema", schema);
const testUrl = new URL(configuredUrl);
testUrl.searchParams.delete("schema");
testUrl.searchParams.set("options", `-csearch_path=${schema},public`);
const requestedTests = Bun.argv.slice(2);
const tests = requestedTests.length ? requestedTests : [
  "execution-ledger", "execution-dispatch", "executor-control", "execution-transfer", "source-audio-admission",
  "targeted-execution", "targeted-ingest-execution", "targeted-workflow-execution", "clip-preparation", "clip-preparation-ledger", "clip-selection", "clip-selection-window", "clip-selection-preparation", "clip-selection-hyperdrive-gate", "native-validation", "thumbnail-frame-execution", "generated-media-execution",
  "outbound-probe", "outbound-delivery", "webhook-subscription", "notification-dispatch", "modal-dispatch", "progress-outbox",
].map(name => `packages/services/src/${name}.db.test.ts`);
if (tests.some(path => !/^packages\/services\/src\/[a-z0-9-]+\.db\.test\.ts$/.test(path))) throw new Error("Only named execution database test files are allowed");

async function run(args: string[], env: Record<string, string>) {
  const child = Bun.spawn(args, {
    cwd: new URL("../../..", import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Serverless database gate command failed with exit ${code}`);
}

try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await run(["bun", "run", "--cwd", "packages/db", "prisma:migrate:deploy"], {
    DATABASE_URL: migrationUrl.toString(), DIRECT_URL: migrationUrl.toString(),
  });
  await run(["bun", "test", ...tests], {
    ALLOW_SERVERLESS_DB_TESTS: "1", ALLOW_EXECUTION_CONTROL_DB_TESTS: "1", ALLOW_EXECUTION_TRANSFER_DB_TESTS: "1", ALLOW_SOURCE_AUDIO_DB_TESTS: "1",
    SERVERLESS_TEST_DATABASE_URL: testUrl.toString(),
    SERVERLESS_TEST_DATABASE_SCHEMA: schema,
    ...(tests.includes("packages/services/src/generation-usage.db.test.ts") ? {
      ALLOW_VIZARD_EXPANSION_DB_TESTS: "1",
      VIZARD_EXPANSION_TEST_DATABASE_URL: testUrl.toString(),
      VIZARD_EXPANSION_TEST_DATABASE_SCHEMA: schema,
    } : {}),
  });
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
}
