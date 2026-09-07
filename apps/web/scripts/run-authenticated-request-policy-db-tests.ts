import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    )
      value = value.slice(1, -1);
    return value || null;
  }
  return null;
}

const repositoryRoot = resolve(import.meta.dir, "../../..");
const databaseUrl =
  process.env.AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  envValue(resolve(repositoryRoot, "packages/db/.env"), "DIRECT_URL") ??
  envValue(resolve(repositoryRoot, "packages/db/.env"), "DATABASE_URL") ??
  envValue(resolve(repositoryRoot, "apps/web/.env.local"), "DIRECT_URL") ??
  envValue(resolve(repositoryRoot, "apps/web/.env.local"), "DATABASE_URL");
if (!databaseUrl) throw new Error("DIRECT_URL or DATABASE_URL is required");

const schema =
  process.env.AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_SCHEMA ??
  `authenticated_request_policy_test_${randomUUID().replaceAll("-", "")}`;
if (!/^authenticated_request_policy_test_[a-z0-9_]+$/.test(schema)) {
  throw new Error("Unsafe Authenticated Request Policy test schema name");
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
  if (exitCode !== 0)
    throw new Error(`${command.join(" ")} exited with ${exitCode}`);
}

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  const testUrl = new URL(databaseUrl);
  if (testUrl.hostname.includes("-pooler.")) {
    testUrl.hostname = testUrl.hostname.replace("-pooler.", ".");
  }
  testUrl.searchParams.set("options", `-csearch_path=${schema}`);
  const migrationsRoot = resolve(
    repositoryRoot,
    "packages/db/prisma/migrations",
  );
  const migrationDirectories = readdirSync(migrationsRoot)
    .filter((entry) => /^\d+_/.test(entry))
    .sort();
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    for (const directory of migrationDirectories) {
      await client.query(
        readFileSync(
          resolve(migrationsRoot, directory, "migration.sql"),
          "utf8",
        ),
      );
    }
  } finally {
    client.release();
  }
  await run(
    ["bun", "test", "apps/web/lib/authenticated-request-policy.db.test.ts"],
    {
      ALLOW_AUTHENTICATED_REQUEST_POLICY_DB_TESTS: "1",
      AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_URL: testUrl.toString(),
      AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_SCHEMA: schema,
    },
  );
} finally {
  if (process.env.AUTHENTICATED_REQUEST_POLICY_TEST_KEEP_SCHEMA !== "1") {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await pool.end();
}
