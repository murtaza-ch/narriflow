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
const schema = `vizard_expansion_test_${randomUUID().replaceAll("-", "")}`;
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
  const testEnv = {
      ...process.env,
      ALLOW_VIZARD_EXPANSION_DB_TESTS: "1",
      DATABASE_URL: databaseUrl,
      VIZARD_EXPANSION_TEST_DATABASE_URL: databaseUrl,
      VIZARD_EXPANSION_TEST_DATABASE_SCHEMA: schema,
      NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS: "1",
      NARRIFLOW_WRITES_CAMPAIGN_RENDER: "1",
      NARRIFLOW_WRITES_CAMPAIGN_EXPORTS: "1",
      NARRIFLOW_WRITES_CAMPAIGN_CREATIVE: "1",
      NARRIFLOW_WRITES_CAMPAIGN_DELIVERY: "1",
      NARRIFLOW_MOTION_SHADOW_LEGACY_TRANSITIONS: "1",
      NARRIFLOW_WRITES_MOTION_CROSS_DISSOLVE: "1",
      NARRIFLOW_WRITES_MOTION_DIRECTIONAL_WIPE: "1",
      NARRIFLOW_WRITES_MOTION_DIRECTIONAL_SLIDE: "1",
      NARRIFLOW_WRITES_MOTION_ZOOM: "1",
      NARRIFLOW_WRITES_MOTION_MEDIA_FADE_SCALE: "1",
      NARRIFLOW_WRITES_MOTION_PAN_KEN_BURNS: "1",
      NARRIFLOW_WRITES_MOTION_CAMPAIGN_APPLY: "1",
      NARRIFLOW_WRITES_CENSOR_SCAN: "1",
      NARRIFLOW_WRITES_CENSOR_CAPTION_MASK: "1",
      NARRIFLOW_WRITES_CENSOR_MUTE: "1",
      NARRIFLOW_WRITES_CENSOR_BEEP: "1",
      NARRIFLOW_WRITES_REVIEW_ROOMS: "1",
      NARRIFLOW_READS_REVIEW_GUEST: "1",
      NARRIFLOW_WRITES_REVIEW_FEEDBACK: "1",
      NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS: "1",
      NARRIFLOW_WRITES_BRAND_PROFILES: "1",
      NARRIFLOW_WRITES_BRAND_KIT_PROJECTION: "1",
      NARRIFLOW_WRITES_SCENE_TEMPLATES: "1",
			NARRIFLOW_WRITES_ASSISTED_COPY: "1",
			NARRIFLOW_WRITES_THUMBNAIL_EXTRACTION: "1",
			NARRIFLOW_WRITES_BULK_SCHEDULING: "1",
			SOCIAL_TOKEN_ENCRYPTION_KEY: "vizard-expansion-test-encryption-key-not-a-secret",
			META_CLIENT_ID: "vizard-meta-client",
			META_CLIENT_SECRET: "vizard-meta-secret",
  };
  const requestedTestFiles = process.argv.slice(2);
  const testFiles = requestedTestFiles.length > 0
    ? requestedTestFiles
    : [
        "packages/services/src/vizard-expansion.db.test.ts",
        "packages/services/src/export-bundle-cleanup.db.test.ts",
        "packages/services/src/stable-brand-ownership-migration.db.test.ts",
				"packages/services/src/stable-brand-ownership.db.test.ts",
        "packages/services/src/project-owned-evidence-migration.db.test.ts",
      ];
  for (const testFile of testFiles) {
    const child = Bun.spawn([process.execPath, "test", testFile], {
      cwd: root,
      env: testEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(
        `Vizard expansion DB test ${testFile} failed with exit code ${exitCode}`,
      );
    }
  }
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
}
