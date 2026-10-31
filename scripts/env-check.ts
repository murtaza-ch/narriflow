import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv as parseDotEnv } from "node:util";
import ts from "typescript";

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

export interface EnvironmentFiles {
  api: EnvironmentValues;
  web: EnvironmentValues;
  db: EnvironmentValues;
}

/** Variable name prefixes that belong to the API: a web file should not carry them. */
const BACKEND_NAME_PREFIXES = [
  "DATABASE_", "DIRECT_URL", "R2_", "UPSTASH_", "STRIPE_", "NEXT_PUBLIC_STRIPE_", "OPENAI_", "ELEVENLABS_", "RESEND_",
  "SOCIAL_", "TIKTOK_", "GOOGLE_CLIENT_", "META_", "LINKEDIN_", "X_CLIENT_", "ZOOM_", "REVIEW_", "CLERK_WEBHOOK_",
  "CLERK_OAUTH_", "MCP_", "PEXELS_", "GENERATED_", "NARRIFLOW_EMAIL_", "PLATFORM_STAFF_",
] as const;

/** Names (never values) of backend settings present in the web file. Vercel must not hold them either. */
export function webBackendVariables(web: EnvironmentValues): string[] {
  return Object.keys(web)
    .filter((name) => !name.startsWith("NEXT_PUBLIC_") || name.startsWith("NEXT_PUBLIC_STRIPE_"))
    .filter((name) => BACKEND_NAME_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort();
}

function originOf(value: string | undefined): string | null {
  try {
    return value?.trim() ? new URL(value.trim()).origin : null;
  } catch {
    return null;
  }
}

function originList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => originOf(entry))
    .filter((entry): entry is string => entry !== null);
}

function sameWhenEither(a: EnvironmentValues, aKey: string, b: EnvironmentValues, bKey: string, message: string, issues: EnvironmentCheckIssue[]) {
  if ((a[aKey]?.trim() ?? "") !== (b[bKey]?.trim() ?? "")) issues.push({ message });
}

export function checkEnvironmentValues({ api, web, db }: EnvironmentFiles): EnvironmentCheckIssue[] {
  const issues: EnvironmentCheckIssue[] = [];
  const apiDatabase = required(api, "DATABASE_URL", "api", issues);
  const dbDatabase = required(db, "DATABASE_URL", "db", issues);
  const directDatabase = required(db, "DIRECT_URL", "db", issues);
  const databaseIdentities: [string, string | null][] = [
    ["api DATABASE_URL", databaseIdentity(apiDatabase)],
    ["db DATABASE_URL", databaseIdentity(dbDatabase)],
    ["db DIRECT_URL", databaseIdentity(directDatabase)],
  ];
  for (const [label, values] of [["api", api]] as const) {
    if (values.DIRECT_URL?.trim()) {
      databaseIdentities.push([`${label} DIRECT_URL`, databaseIdentity(values.DIRECT_URL.trim())]);
    }
  }
  for (const [label, identity] of databaseIdentities) {
    if (!identity) issues.push({ message: `${label} is not a valid PostgreSQL URL` });
  }
  const validDatabaseIdentities = databaseIdentities.map(([, identity]) => identity).filter(Boolean);
  if (validDatabaseIdentities.length === databaseIdentities.length && new Set(validDatabaseIdentities).size !== 1) {
    issues.push({ message: "api and db PostgreSQL identities do not agree" });
  }

  // Origins: the browser calls the API directly; humans are sent to the web app.
  const apiOrigin = required(api, "API_ORIGIN", "api", issues);
  const webOrigin = required(api, "WEB_ORIGIN", "api", issues);
  required(api, "CLERK_AUTHORIZED_PARTIES", "api", issues);
  const publicApiUrl = required(web, "NEXT_PUBLIC_API_URL", "web", issues);
  const publicAppUrl = required(web, "NEXT_PUBLIC_APP_URL", "web", issues);
  if (apiOrigin && publicApiUrl && originOf(apiOrigin) !== originOf(publicApiUrl)) {
    issues.push({ message: "web NEXT_PUBLIC_API_URL and api API_ORIGIN are not the same origin" });
  }
  if (webOrigin && publicAppUrl && originOf(webOrigin) !== originOf(publicAppUrl)) {
    issues.push({ message: "web NEXT_PUBLIC_APP_URL and api WEB_ORIGIN are not the same origin" });
  }
  const webOriginValue = originOf(webOrigin);
  if (webOriginValue) {
    const cors = originList(api.CORS_ALLOWED_ORIGINS);
    if (cors.length > 0 && !cors.includes(webOriginValue)) {
      issues.push({ message: "api CORS_ALLOWED_ORIGINS does not include WEB_ORIGIN" });
    }
    if (!originList(api.CLERK_AUTHORIZED_PARTIES).includes(webOriginValue)) {
      issues.push({ message: "api CLERK_AUTHORIZED_PARTIES does not include WEB_ORIGIN" });
    }
  }

  // Clerk: the API verifies the tokens that the web app's Clerk instance issues.
  required(web, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "web", issues);
  required(web, "CLERK_SECRET_KEY", "web", issues);
  required(api, "CLERK_SECRET_KEY", "api", issues);
  required(api, "CLERK_PUBLISHABLE_KEY", "api", issues);
  sameWhenEither(api, "CLERK_PUBLISHABLE_KEY", web, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "api CLERK_PUBLISHABLE_KEY and web NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY do not agree", issues);
  sameWhenEither(api, "CLERK_SECRET_KEY", web, "CLERK_SECRET_KEY", "api and web CLERK_SECRET_KEY values do not agree", issues);
  sameWhenEither(api, "NEXT_PUBLIC_GOOGLE_CLIENT_ID", web, "NEXT_PUBLIC_GOOGLE_CLIENT_ID", "api and web NEXT_PUBLIC_GOOGLE_CLIENT_ID values do not agree", issues);

  required(api, "R2_ACCOUNT_ID", "api", issues);
  required(api, "R2_BUCKET", "api", issues);
  for (const name of Object.keys(api)) {
    if ((name.startsWith("UPSTASH_") || name.startsWith("WORKER_HEALTH_") || name === "WORKER_URL" || name === "WORKER_APP_BASE_URL") && api[name]?.trim()) {
      issues.push({ message: `api still configures obsolete ${name}` });
    }
  }
  return issues;
}

/** Bucket/account bindings and signing credentials must select one resource. */
export function checkStorageBindings(api: EnvironmentValues, config: { account_id?: string; r2_buckets?: Array<{ binding?: string; bucket_name?: string }> }): EnvironmentCheckIssue[] {
  const issues: EnvironmentCheckIssue[] = [];
  if (!config.account_id || config.account_id !== api.R2_ACCOUNT_ID) issues.push({ message: "api R2_ACCOUNT_ID and Wrangler account_id do not agree" });
  const bucket = config.r2_buckets?.filter(value => value.binding === "MEDIA_BUCKET");
  if (bucket?.length !== 1 || bucket[0]?.bucket_name !== api.R2_BUCKET) issues.push({ message: "api R2_BUCKET and Wrangler MEDIA_BUCKET do not agree" });
  return issues;
}

export const ENVIRONMENT_FILES = {
  api: "apps/api/.dev.vars",
  web: "apps/web/.env.local",
  db: "packages/db/.env",
} as const;

export function runEnvironmentCheck(root = process.cwd()): { issues: EnvironmentCheckIssue[]; warnings: string[] } {
  const issues: EnvironmentCheckIssue[] = [];
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local", ".env.production", ".env.production.local"]) {
    if (existsSync(resolve(root, name))) issues.push({ message: `root ${name} is not supported; use app-specific env files` });
  }
  for (const [label, path] of Object.entries(ENVIRONMENT_FILES)) {
    if (!existsSync(resolve(root, path))) issues.push({ message: `${label} env file is missing (${path})` });
  }
  if (issues.length > 0) return { issues, warnings: [] };
  const files = Object.fromEntries(
    Object.entries(ENVIRONMENT_FILES).map(([label, path]) => [label, readEnvFile(resolve(root, path))]),
  ) as unknown as EnvironmentFiles;
  const leftovers = webBackendVariables(files.web);
  const config = ts.readConfigFile(resolve(root, "apps/api/wrangler.jsonc"), ts.sys.readFile);
  return {
    issues: [...checkEnvironmentValues(files), ...(config.error ? [{ message: "Wrangler configuration could not be read" }] : checkStorageBindings(files.api, config.config))],
    warnings: leftovers.length > 0
      ? [`web env file still holds backend settings (remove them locally and on Vercel): ${leftovers.join(", ")}`]
      : [],
  };
}

if (import.meta.main) {
  const { issues, warnings } = runEnvironmentCheck();
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (issues.length > 0) {
    console.error("Environment check failed:");
    for (const issue of issues) console.error(`- ${issue.message}`);
    process.exitCode = 1;
  } else {
    console.log("Environment check passed: API, web and migration files agree on database, origins, Clerk and storage.");
  }
}
