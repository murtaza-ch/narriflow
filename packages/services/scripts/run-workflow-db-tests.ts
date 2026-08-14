import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

function configuredDatabaseUrl() {
  const configured =
    process.env.WORKFLOW_TEST_DATABASE_URL ??
    process.env.DIRECT_URL ??
    process.env.DATABASE_URL;
  if (configured) return configured;

  const envPath = resolve(import.meta.dir, "../../db/.env");
  if (!existsSync(envPath)) return null;
  const values = new Map<string, string>();
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) values.set(key, value);
  }
  return values.get("DIRECT_URL") ?? values.get("DATABASE_URL") ?? null;
}

const databaseUrl = configuredDatabaseUrl();

if (!databaseUrl) {
  throw new Error("DIRECT_URL or DATABASE_URL is required");
}

const requestedSchema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const schema =
  requestedSchema ?? `workflow_lifecycle_test_${randomUUID().replaceAll("-", "")}`;
const keepSchema = process.env.WORKFLOW_TEST_KEEP_SCHEMA === "1";
const skipSchemaPush = process.env.WORKFLOW_TEST_SKIP_SCHEMA_PUSH === "1";

if (!/^workflow_lifecycle_test_[a-z0-9_]+$/.test(schema)) {
  throw new Error("Unsafe workflow test schema name");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

async function run(command: string[], env: Record<string, string>) {
  const child = Bun.spawn(command, {
    cwd: new URL("../../..", import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${exitCode}`);
  }
}

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

  const migrationUrl = new URL(databaseUrl);
  migrationUrl.searchParams.set("schema", schema);
  const testUrl = new URL(databaseUrl);
  // Neon rejects search_path as a startup option on pooled endpoints. The
  // equivalent unpooled endpoint accepts it, which keeps raw SQL and Prisma
  // queries inside the disposable test schema.
  if (testUrl.hostname.includes("-pooler.")) {
    testUrl.hostname = testUrl.hostname.replace("-pooler.", ".");
  }
  testUrl.searchParams.set("options", `-csearch_path=${schema}`);

  const testPool = new Pool({ connectionString: testUrl.toString(), max: 1 });
  try {
    const current = await testPool.query<Array<{ currentSchema: string }>>(
      'SELECT current_schema() AS "currentSchema"',
    );
    if (current.rows[0]?.currentSchema !== schema) {
      throw new Error("Workflow test connection did not select its isolated schema");
    }
  } finally {
    await testPool.end();
  }

  if (!skipSchemaPush) {
    await run(["bun", "run", "--cwd", "packages/db", "prisma:push:test"], {
      DATABASE_URL: migrationUrl.toString(),
      DIRECT_URL: migrationUrl.toString(),
    });
  }
  const testCommand = [
    "bun",
    "test",
    "packages/services/src/workflow-run-lifecycle.db.test.ts",
  ];
  if (process.env.WORKFLOW_TEST_NAME) {
    testCommand.push("--test-name-pattern", process.env.WORKFLOW_TEST_NAME);
  }
  await run(
    testCommand,
    {
      ALLOW_WORKFLOW_DB_TESTS: "1",
      DATABASE_URL: testUrl.toString(),
      DIRECT_URL: testUrl.toString(),
      WORKFLOW_TEST_DATABASE_URL: testUrl.toString(),
      WORKFLOW_TEST_DATABASE_SCHEMA: schema,
    },
  );
} finally {
  if (!keepSchema) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await pool.end();
}
