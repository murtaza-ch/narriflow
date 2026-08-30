import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

function envValue(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== key) continue;
    return line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "") || null;
  }
  return null;
}

const root = resolve(import.meta.dir, "../../..");
const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? envValue(resolve(root, "packages/db/.env"), "DIRECT_URL") ?? envValue(resolve(root, "packages/db/.env"), "DATABASE_URL");
if (!databaseUrl) throw new Error("DIRECT_URL or DATABASE_URL is required");
const schema = `brand_profile_test_${randomUUID().replaceAll("-", "")}`;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const migrations = readdirSync(resolve(root, "packages/db/prisma/migrations")).filter((entry) => /^\d+_/.test(entry)).sort();
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    for (const migration of migrations) {
      await client.query(readFileSync(resolve(root, "packages/db/prisma/migrations", migration, "migration.sql"), "utf8"));
    }
  } finally {
    client.release();
  }
  const child = Bun.spawn([process.execPath, "test", "packages/services/src/brand-profile.db.test.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ALLOW_BRAND_PROFILE_DB_TESTS: "1",
      DATABASE_URL: databaseUrl,
      BRAND_PROFILE_TEST_DATABASE_URL: databaseUrl,
      BRAND_PROFILE_TEST_DATABASE_SCHEMA: schema,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Brand Profile DB tests failed with exit code ${exitCode}`);
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
}
