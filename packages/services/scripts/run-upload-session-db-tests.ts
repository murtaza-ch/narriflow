import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

function configuredDatabaseUrl() {
  const configured =
    process.env.UPLOAD_SESSION_TEST_DATABASE_URL ??
    process.env.DIRECT_URL ??
    process.env.DATABASE_URL;
  if (configured) return configured;

  const envPath = resolve(import.meta.dir, "../../../apps/web/.env.local");
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
  return values.get("DATABASE_URL") ?? values.get("DIRECT_URL") ?? null;
}

const databaseUrl = configuredDatabaseUrl();
if (!databaseUrl) throw new Error("DIRECT_URL or DATABASE_URL is required");

const schema =
  process.env.UPLOAD_SESSION_TEST_DATABASE_SCHEMA ??
  `upload_session_test_${randomUUID().replaceAll("-", "")}`;
if (!/^upload_session_test_[a-z0-9_]+$/.test(schema)) {
  throw new Error("Unsafe Upload Session test schema name");
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
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
}

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  const migrationUrl = new URL(databaseUrl);
  const testUrl = new URL(databaseUrl);
  if (migrationUrl.hostname.includes("-pooler.")) {
    migrationUrl.hostname = migrationUrl.hostname.replace("-pooler.", ".");
  }
  if (testUrl.hostname.includes("-pooler.")) {
    testUrl.hostname = testUrl.hostname.replace("-pooler.", ".");
  }
  migrationUrl.searchParams.set("schema", schema);
  testUrl.searchParams.set("options", `-csearch_path=${schema}`);

  await run(["bun", "run", "--cwd", "packages/db", "prisma:migrate:deploy"], {
    DATABASE_URL: migrationUrl.toString(),
    DIRECT_URL: migrationUrl.toString(),
  });
  await run(["bun", "test", "packages/services/src/upload-session.db.test.ts"], {
    ALLOW_UPLOAD_SESSION_DB_TESTS: "1",
    DATABASE_URL: testUrl.toString(),
    DIRECT_URL: testUrl.toString(),
    UPLOAD_SESSION_TEST_DATABASE_URL: testUrl.toString(),
    UPLOAD_SESSION_TEST_DATABASE_SCHEMA: schema,
  });
} finally {
  if (process.env.UPLOAD_SESSION_TEST_KEEP_SCHEMA !== "1") {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await pool.end();
}
