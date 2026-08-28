import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

function envValue(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== key) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

const repositoryRoot = resolve(import.meta.dir, "../../..");
const databaseUrl =
  process.env.WORKSPACE_BILLING_TEST_DATABASE_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  envValue(resolve(repositoryRoot, "packages/db/.env"), "DIRECT_URL") ??
  envValue(resolve(repositoryRoot, "packages/db/.env"), "DATABASE_URL") ??
  envValue(resolve(repositoryRoot, "apps/web/.env.local"), "DIRECT_URL") ??
  envValue(resolve(repositoryRoot, "apps/web/.env.local"), "DATABASE_URL");

if (!databaseUrl) throw new Error("DIRECT_URL or DATABASE_URL is required");

const schema =
  process.env.WORKSPACE_BILLING_TEST_DATABASE_SCHEMA ??
  `workspace_billing_test_${randomUUID().replaceAll("-", "")}`;
if (!/^workspace_billing_test_[a-z0-9_]+$/.test(schema)) {
  throw new Error("Unsafe Workspace Billing test schema name");
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

async function run(command: string[], env: Record<string, string>) {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
}

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  const migrationUrl = new URL(databaseUrl);
  const testUrl = new URL(databaseUrl);
  for (const url of [migrationUrl, testUrl]) {
    if (url.hostname.includes("-pooler.")) {
      url.hostname = url.hostname.replace("-pooler.", ".");
    }
  }
  migrationUrl.searchParams.set("schema", schema);
  testUrl.searchParams.set("options", `-csearch_path=${schema}`);

  await run(["bun", "run", "--cwd", "packages/db", "prisma:migrate:deploy"], {
    DATABASE_URL: migrationUrl.toString(),
    DIRECT_URL: migrationUrl.toString(),
  });
  await run(["bun", "test", "packages/services/src/workspace-billing.db.test.ts"], {
    ALLOW_WORKSPACE_BILLING_DB_TESTS: "1",
    DATABASE_URL: testUrl.toString(),
    DIRECT_URL: testUrl.toString(),
    WORKSPACE_BILLING_TEST_DATABASE_URL: testUrl.toString(),
    WORKSPACE_BILLING_TEST_DATABASE_SCHEMA: schema,
  });
} finally {
  if (process.env.WORKSPACE_BILLING_TEST_KEEP_SCHEMA !== "1") {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await pool.end();
}
