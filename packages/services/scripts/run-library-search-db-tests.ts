import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

// Library search needs pgvector, so this gate applies every migration to a
// disposable schema and fails when the server cannot provide the extension.
// The extension belongs to the database, not the schema: it is installed in
// `public` (idempotently, as the migration does) and never dropped here.
const databaseUrl =
  process.env.LIBRARY_SEARCH_TEST_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("LIBRARY_SEARCH_TEST_DATABASE_URL, DIRECT_URL, or DATABASE_URL is required");

const root = resolve(import.meta.dir, "../../..");
const schema = `library_search_test_${randomUUID().replaceAll("-", "")}`;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const available = await pool.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`);
  if (available.rowCount === 0) {
    const message = "pgvector is not installed on this PostgreSQL server; install it (for example `brew install pgvector`) to run the library search gate";
    if (process.env.CI) throw new Error(message);
    console.warn(`library search DB gate skipped: ${message}`);
    process.exit(0);
  }

  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const migrations = readdirSync(resolve(root, "packages/db/prisma/migrations"))
    .filter((entry) => existsSync(resolve(root, "packages/db/prisma/migrations", entry, "migration.sql")))
    .sort();
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}", public`);
    for (const migration of migrations) {
      await client.query(readFileSync(resolve(root, "packages/db/prisma/migrations", migration, "migration.sql"), "utf8"));
    }
  } finally {
    client.release();
  }

  const testUrl = new URL(databaseUrl);
  testUrl.searchParams.set("options", `-csearch_path=${schema},public`);
  const child = Bun.spawn([process.execPath, "test", "packages/services/src/library-search.db.test.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ALLOW_LIBRARY_SEARCH_DB_TESTS: "1",
      DATABASE_URL: testUrl.toString(),
      LIBRARY_SEARCH_TEST_DATABASE_URL: testUrl.toString(),
      LIBRARY_SEARCH_TEST_DATABASE_SCHEMA: schema,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Library search DB tests failed with exit code ${exitCode}`);
} finally {
  if (process.env.LIBRARY_SEARCH_TEST_KEEP_SCHEMA !== "1") {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await pool.end();
}
