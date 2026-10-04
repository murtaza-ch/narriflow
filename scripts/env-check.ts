import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv as parseDotEnv } from "node:util";

export type EnvironmentValues = Record<string, string>;

export interface EnvironmentCheckIssue {
  message: string;
}

function parseEnv(text: string): EnvironmentValues {
  return parseDotEnv(text);
}

export function readEnvFile(path: string): EnvironmentValues {
  return parseEnv(readFileSync(path, "utf8"));
}

function required(values: EnvironmentValues, key: string, label: string, issues: EnvironmentCheckIssue[]) {
  if (!values[key]?.trim()) issues.push({ message: `${label} is missing ${key}` });
  return values[key]?.trim() ?? "";
}

function databaseIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    const isNeonHost = url.hostname.toLowerCase().endsWith(".neon.tech");
    const host = isNeonHost ? url.hostname.toLowerCase().replace(/-pooler(?=\.)/, "") : url.hostname.toLowerCase();
    const port = url.port || "5432";
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const schema = url.searchParams.get("schema") || "public";
    if (!host || !database) return null;
    return `${host}|${port}|${database}|${schema}`;
  } catch {
    return null;
  }
}

function redisEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["redis:", "rediss:"].includes(url.protocol)) return null;
    return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || "6379"}${url.pathname || "/"}`;
  } catch {
    return null;
  }
}

export function checkEnvironmentValues(
  web: EnvironmentValues,
  worker: EnvironmentValues,
  db: EnvironmentValues,
): EnvironmentCheckIssue[] {
  const issues: EnvironmentCheckIssue[] = [];
  const webDatabase = required(web, "DATABASE_URL", "web", issues);
  const workerDatabase = required(worker, "DATABASE_URL", "worker", issues);
  const dbDatabase = required(db, "DATABASE_URL", "db", issues);
  const directDatabase = required(db, "DIRECT_URL", "db", issues);
  const databaseIdentities: [string, string | null][] = [
    ["web DATABASE_URL", databaseIdentity(webDatabase)],
    ["worker DATABASE_URL", databaseIdentity(workerDatabase)],
    ["db DATABASE_URL", databaseIdentity(dbDatabase)],
    ["db DIRECT_URL", databaseIdentity(directDatabase)],
  ];
  for (const [label, values] of [["web", web], ["worker", worker]] as const) {
    if (values.DIRECT_URL?.trim()) {
      databaseIdentities.push([`${label} DIRECT_URL`, databaseIdentity(values.DIRECT_URL.trim())]);
    }
  }
  for (const [label, identity] of databaseIdentities) {
    if (!identity) issues.push({ message: `${label} is not a valid PostgreSQL URL` });
  }
  const validDatabaseIdentities = databaseIdentities.map(([, identity]) => identity).filter(Boolean);
  if (validDatabaseIdentities.length === databaseIdentities.length && new Set(validDatabaseIdentities).size !== 1) {
    issues.push({ message: "web, worker, and db PostgreSQL identities do not agree" });
  }

  const webAccount = required(web, "R2_ACCOUNT_ID", "web", issues);
  const workerAccount = required(worker, "R2_ACCOUNT_ID", "worker", issues);
  if (webAccount && workerAccount && webAccount !== workerAccount) {
    issues.push({ message: "web and worker R2_ACCOUNT_ID values do not agree" });
  }
  const webBucket = required(web, "R2_BUCKET", "web", issues);
  const workerBucket = required(worker, "R2_BUCKET", "worker", issues);
  if (webBucket && workerBucket && webBucket !== workerBucket) {
    issues.push({ message: "web and worker R2_BUCKET values do not agree" });
  }

  const webRedis = web.UPSTASH_REDIS_URL?.trim() ?? "";
  const workerRedis = worker.UPSTASH_REDIS_URL?.trim() ?? "";
  if (Boolean(webRedis) !== Boolean(workerRedis)) {
    issues.push({ message: "web and worker UPSTASH_REDIS_URL must both be present or both be absent" });
  }
  if (!webRedis && !workerRedis) return issues;
  const webRedisEndpoint = redisEndpoint(webRedis);
  const workerRedisEndpoint = redisEndpoint(workerRedis);
  if (!webRedisEndpoint) issues.push({ message: "web UPSTASH_REDIS_URL is not a valid Redis URL" });
  if (!workerRedisEndpoint) issues.push({ message: "worker UPSTASH_REDIS_URL is not a valid Redis URL" });
  if (webRedisEndpoint && workerRedisEndpoint && webRedisEndpoint !== workerRedisEndpoint) {
    issues.push({ message: "web and worker Redis endpoints do not agree" });
  }
  return issues;
}

export function runEnvironmentCheck(root = process.cwd()): EnvironmentCheckIssue[] {
  const paths = {
    web: resolve(root, "apps/web/.env.local"),
    worker: resolve(root, "apps/worker/.env"),
    db: resolve(root, "packages/db/.env"),
  } as const;
  const issues: EnvironmentCheckIssue[] = [];
  for (const [label, path] of Object.entries(paths)) {
    if (!existsSync(path)) issues.push({ message: `${label} env file is missing` });
  }
  if (issues.length > 0) return issues;
  return checkEnvironmentValues(readEnvFile(paths.web), readEnvFile(paths.worker), readEnvFile(paths.db));
}

if (import.meta.main) {
  const issues = runEnvironmentCheck();
  if (issues.length > 0) {
    console.error("Environment check failed:");
    for (const issue of issues) console.error(`- ${issue.message}`);
    process.exitCode = 1;
  } else {
    console.log("Environment check passed: database, R2 account/bucket, and Redis identities agree.");
  }
}
