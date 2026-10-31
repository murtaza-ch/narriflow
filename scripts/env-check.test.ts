import { describe, expect, test } from "bun:test";
import { checkEnvironmentValues, checkStorageBindings, webBackendVariables, type EnvironmentFiles, type EnvironmentValues } from "./env-check";

const database = "postgresql://user:password@ep-dev-pooler.us-east-1.aws.neon.tech/neondb?schema=public";
const directDatabase = "postgresql://user:password@ep-dev.us-east-1.aws.neon.tech/neondb?schema=public";
const account = "a".repeat(32);
function api(overrides: EnvironmentValues = {}): EnvironmentValues {
  return {
    DATABASE_URL: database,
    API_ORIGIN: "http://localhost:4000",
    WEB_ORIGIN: "http://localhost:3000",
    CORS_ALLOWED_ORIGINS: "http://localhost:3000",
    CLERK_AUTHORIZED_PARTIES: "http://localhost:3000",
    CLERK_SECRET_KEY: "sk_shared",
    CLERK_PUBLISHABLE_KEY: "pk_shared",
    R2_ACCOUNT_ID: account,
    R2_BUCKET: "narriflow-dev",
    ...overrides,
  };
}
function web(overrides: EnvironmentValues = {}): EnvironmentValues {
  return {
    NEXT_PUBLIC_API_URL: "http://localhost:4000",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_shared",
    CLERK_SECRET_KEY: "sk_shared",
    ...overrides,
  };
}
function files(overrides: Partial<EnvironmentFiles> = {}): EnvironmentFiles {
  return { api: api(), web: web(), db: { DATABASE_URL: database, DIRECT_URL: directDatabase }, ...overrides };
}
const messages = (issues: { message: string }[]) => issues.map(issue => issue.message);

describe("serverless env check", () => {
  test("accepts three consistent files with pooled and direct URLs of one database", () => {
    expect(checkEnvironmentValues(files())).toEqual([]);
  });
  test("rejects another migration database and hides credentials", () => {
    const issues = checkEnvironmentValues(files({ db: { DATABASE_URL: database, DIRECT_URL: directDatabase.replace("neondb", "other") } }));
    expect(messages(issues)).toContain("api and db PostgreSQL identities do not agree");
    expect(JSON.stringify(issues)).not.toContain("password");
  });
  test("rejects an API direct connection to another database", () => {
    expect(messages(checkEnvironmentValues(files({ api: api({ DIRECT_URL: directDatabase.replace("neondb", "other") }) })))).toContain("api and db PostgreSQL identities do not agree");
  });
  test("preserves non-Neon pooler names, schema and ports", () => {
    for (const wrong of ["postgresql://u:p@db-pooler.example.com:5433/narriflow", directDatabase.replace("schema=public", "schema=other"), directDatabase.replace(".tech/", ".tech:5433/")]) {
      expect(messages(checkEnvironmentValues(files({ api: api({ DATABASE_URL: wrong }) })))).toContain("api and db PostgreSQL identities do not agree");
    }
  });
  test("rejects leftover polling runtime settings by name without exposing values", () => {
    const issues = checkEnvironmentValues(files({ api: api({ UPSTASH_REDIS_URL: "rediss://:secret@retired.example/0", WORKER_URL: "https://retired.example", WORKER_HEALTH_TOKEN: "private-health-token" }) }));
    expect(messages(issues)).toEqual(["api still configures obsolete UPSTASH_REDIS_URL", "api still configures obsolete WORKER_URL", "api still configures obsolete WORKER_HEALTH_TOKEN"]);
    expect(JSON.stringify(issues)).not.toContain("retired.example");
    expect(JSON.stringify(issues)).not.toContain("private-health-token");
    expect(checkEnvironmentValues(files({ api: api({ UPSTASH_REDIS_URL: "" }) }))).toEqual([]);
  });
  test("compares the signed storage selection to the actual Worker binding", () => {
    const config = { account_id: account, r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "narriflow-dev" }] };
    expect(checkStorageBindings(api(), config)).toEqual([]);
    expect(checkStorageBindings(api({ R2_ACCOUNT_ID: "b".repeat(32), R2_BUCKET: "other" }), config)).toEqual([
      { message: "api R2_ACCOUNT_ID and Wrangler account_id do not agree" },
      { message: "api R2_BUCKET and Wrangler MEDIA_BUCKET do not agree" },
    ]);
    expect(checkStorageBindings(api(), { account_id: account, r2_buckets: [] })).toEqual([{ message: "api R2_BUCKET and Wrangler MEDIA_BUCKET do not agree" }]);
    expect(checkStorageBindings(api(), { ...config, r2_buckets: [...config.r2_buckets, ...config.r2_buckets] })).toEqual([{ message: "api R2_BUCKET and Wrangler MEDIA_BUCKET do not agree" }]);
  });
  test("requires origins, Clerk, local Hyperdrive and migration database settings, and storage", () => {
    expect(messages(checkEnvironmentValues({ api: {}, web: {}, db: {} }))).toEqual(expect.arrayContaining([
      "api is missing DATABASE_URL", "db is missing DATABASE_URL", "db is missing DIRECT_URL", "api is missing API_ORIGIN", "api is missing WEB_ORIGIN", "api is missing CLERK_SECRET_KEY", "web is missing NEXT_PUBLIC_API_URL", "web is missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "api is missing R2_ACCOUNT_ID", "api is missing R2_BUCKET",
    ]));
  });
  test("browser API and human links use their explicit origins", () => {
    expect(messages(checkEnvironmentValues(files({ web: web({ NEXT_PUBLIC_API_URL: "https://old.example.com", NEXT_PUBLIC_APP_URL: "https://other.example.com" }) })))).toEqual([
      "web NEXT_PUBLIC_API_URL and api API_ORIGIN are not the same origin", "web NEXT_PUBLIC_APP_URL and api WEB_ORIGIN are not the same origin",
    ]);
    expect(checkEnvironmentValues(files({ web: web({ NEXT_PUBLIC_API_URL: "http://localhost:4000/" }) }))).toEqual([]);
  });
  test("CORS and Clerk authorized parties admit the web origin", () => {
    expect(messages(checkEnvironmentValues(files({ api: api({ CORS_ALLOWED_ORIGINS: "http://localhost:4000", CLERK_AUTHORIZED_PARTIES: "http://127.0.0.1:3000" }) })))).toEqual([
      "api CORS_ALLOWED_ORIGINS does not include WEB_ORIGIN", "api CLERK_AUTHORIZED_PARTIES does not include WEB_ORIGIN",
    ]);
  });
  test("API and web share a Clerk instance without printing keys", () => {
    const issues = checkEnvironmentValues(files({ web: web({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_other", CLERK_SECRET_KEY: "sk_other" }) }));
    expect(messages(issues)).toEqual(["api CLERK_PUBLISHABLE_KEY and web NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY do not agree", "api and web CLERK_SECRET_KEY values do not agree"]);
    expect(JSON.stringify(issues)).not.toContain("pk_");
    expect(JSON.stringify(issues)).not.toContain("sk_");
  });
  test("lists backend settings left in web by name only", () => {
    expect(webBackendVariables(web({ DATABASE_URL: "postgresql://secret", STRIPE_SECRET_KEY: "sk_secret", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_secret", R2_BUCKET: "x", NEXT_PUBLIC_GOOGLE_CLIENT_ID: "public", NODE_ENV: "development", CLERK_WEBHOOK_SECRET: "whsec" }))).toEqual(["CLERK_WEBHOOK_SECRET", "DATABASE_URL", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "R2_BUCKET", "STRIPE_SECRET_KEY"]);
    expect(webBackendVariables(web())).toEqual([]);
  });
});
