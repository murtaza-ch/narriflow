import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { assertIsolatedDatabaseGateTarget } from "./db-gate-target";

/** Prisma cannot express the HNSW index, so it always proposes this one line. */
const ALLOWED = new Set(['DROP INDEX "TranscriptPassage_embedding_idx";']);

const configuredUrl = process.env.SERVERLESS_TEST_DATABASE_URL;
if (!configuredUrl) throw new Error("SERVERLESS_TEST_DATABASE_URL must name an isolated database");
assertIsolatedDatabaseGateTarget(configuredUrl);
const schema = `schema_drift_test_${randomUUID().replaceAll("-", "")}`;
const migrationUrl = new URL(configuredUrl);
migrationUrl.searchParams.set("schema", schema);
const environment = { ...process.env, DATABASE_URL: migrationUrl.toString(), DIRECT_URL: migrationUrl.toString() };
const cwd = new URL("../../db", import.meta.url).pathname;

async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}`);
  return output;
}

const pool = new Pool({ connectionString: configuredUrl, max: 1 });
try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await run(["bun", "run", "prisma:migrate:deploy"]);
  const diff = await run(["bunx", "--no-install", "prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"]);
  const drift = diff.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("--") && !ALLOWED.has(line));
  if (drift.length > 0) throw new Error(`The migrations and schema.prisma disagree:\n${drift.join("\n")}`);
  console.log("schema.prisma matches the migrations");
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
}
