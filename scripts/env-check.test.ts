import { describe, expect, test } from "bun:test";
import { checkEnvironmentValues, webBackendVariables, type EnvironmentFiles, type EnvironmentValues } from "./env-check";

const database = "postgresql://user:password@ep-dev-pooler.us-east-1.aws.neon.tech/neondb?schema=public";
const directDatabase = "postgresql://user:password@ep-dev.us-east-1.aws.neon.tech/neondb?schema=public";
const redis = "rediss://:secret@dev.upstash.io/0";

function api(overrides: EnvironmentValues = {}): EnvironmentValues {
  return {
    DATABASE_URL: database,
    API_ORIGIN: "http://localhost:4000",
    WEB_ORIGIN: "http://localhost:3000",
    CORS_ALLOWED_ORIGINS: "http://localhost:3000",
    CLERK_AUTHORIZED_PARTIES: "http://localhost:3000",
    CLERK_SECRET_KEY: "sk_shared",
    CLERK_PUBLISHABLE_KEY: "pk_shared",
    R2_ACCOUNT_ID: "shared-account",
    R2_BUCKET: "narriflow-dev",
    UPSTASH_REDIS_URL: redis,
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

function worker(overrides: EnvironmentValues = {}): EnvironmentValues {
  return {
    DATABASE_URL: database,
    R2_ACCOUNT_ID: "shared-account",
    R2_BUCKET: "narriflow-dev",
    UPSTASH_REDIS_URL: redis,
    WORKER_APP_BASE_URL: "http://localhost:3000",
    ...overrides,
  };
}

function files(overrides: Partial<EnvironmentFiles> = {}): EnvironmentFiles {
  return { api: api(), web: web(), worker: worker(), db: { DATABASE_URL: database, DIRECT_URL: directDatabase }, ...overrides };
}

const messages = (issues: { message: string }[]) => issues.map((issue) => issue.message);

describe("env check", () => {
  test("accepts four consistent files, with pooler and direct database URLs of one identity", () => {
    expect(checkEnvironmentValues(files())).toEqual([]);
  });

  test("reports database, bucket, and Redis mismatches without exposing values", () => {
    const issues = checkEnvironmentValues(files({
      api: api({ R2_BUCKET: "api" }),
      worker: worker({ DATABASE_URL: database.replace("neondb", "other"), R2_ACCOUNT_ID: "other-account", R2_BUCKET: "worker", UPSTASH_REDIS_URL: "rediss://:secret@other.upstash.io/1" }),
    }));
    const text = messages(issues).join(" ");
    expect(text).toContain("PostgreSQL identities");
    expect(text).toContain("R2_BUCKET");
    expect(text).toContain("R2_ACCOUNT_ID");
    expect(text).toContain("Redis endpoints");
    expect(JSON.stringify(issues)).not.toContain("secret");
  });

  test("rejects an app direct connection to another database", () => {
    const issues = checkEnvironmentValues(files({ worker: worker({ DIRECT_URL: directDatabase.replace("neondb", "other") }) }));
    expect(messages(issues)).toContain("api, worker, and db PostgreSQL identities do not agree");
  });

  test("keeps non-Neon pooler names, checks ports, and uses Redis port 6379 for TLS", () => {
    const mismatched = checkEnvironmentValues(files({
      api: api({ DATABASE_URL: "postgresql://u:p@db-pooler.example.com:5433/narriflow" }),
      worker: worker({ DATABASE_URL: "postgresql://u:p@db.example.com:5433/narriflow" }),
      db: { DATABASE_URL: database, DIRECT_URL: "postgresql://u:p@db.example.com:5433/narriflow" },
    }));
    expect(messages(mismatched)).toContain("api, worker, and db PostgreSQL identities do not agree");
    const sameEndpoint = "rediss://:secret@local.upstash.io";
    expect(checkEnvironmentValues(files({ api: api({ UPSTASH_REDIS_URL: sameEndpoint }), worker: worker({ UPSTASH_REDIS_URL: sameEndpoint }) }))).toEqual([]);
    expect(messages(checkEnvironmentValues(files({
      api: api({ UPSTASH_REDIS_URL: "rediss://:secret@local.upstash.io/0" }),
      worker: worker({ UPSTASH_REDIS_URL: "rediss://:secret@local.upstash.io/1" }),
    })))).toContain("api and worker Redis endpoints do not agree");
  });

  test("allows Redis to be absent in both files but flags a one-sided setting", () => {
    expect(checkEnvironmentValues(files({ api: api({ UPSTASH_REDIS_URL: "" }), worker: worker({ UPSTASH_REDIS_URL: "" }) }))).toEqual([]);
    expect(checkEnvironmentValues(files({ api: api({ UPSTASH_REDIS_URL: "" }), worker: worker({ UPSTASH_REDIS_URL: "redis://127.0.0.1:6379" }) }))).toEqual(expect.arrayContaining([
      { message: "api and worker UPSTASH_REDIS_URL must both be present or both be absent" },
    ]));
  });

  test("allows image generation and shared secrets in both files or neither, without exposing values", () => {
    const shared = { OPENAI_IMAGE_MODEL: "gpt-image-2", GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY: "secret-key", SOCIAL_TOKEN_ENCRYPTION_KEY: "token-key" };
    expect(checkEnvironmentValues(files({ api: api(shared), worker: worker(shared) }))).toEqual([]);
    const issues = checkEnvironmentValues(files({
      api: api(shared),
      worker: worker({ GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY: "other-secret-key", SOCIAL_TOKEN_ENCRYPTION_KEY: "other-token-key" }),
    }));
    expect(messages(issues)).toEqual([
      "api and worker OPENAI_IMAGE_MODEL values do not agree",
      "api and worker GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY values do not agree",
      "api and worker SOCIAL_TOKEN_ENCRYPTION_KEY values do not agree",
    ]);
    expect(JSON.stringify(issues)).not.toContain("secret");
    expect(JSON.stringify(issues)).not.toContain("token-key");
  });

  test("requires the API's origins, Clerk keys and database, the web app's API URL, and R2 values", () => {
    const issues = checkEnvironmentValues({ api: {}, web: {}, worker: {}, db: {} });
    expect(messages(issues)).toEqual(expect.arrayContaining([
      "api is missing DATABASE_URL",
      "worker is missing DATABASE_URL",
      "db is missing DATABASE_URL",
      "db is missing DIRECT_URL",
      "api is missing API_ORIGIN",
      "api is missing WEB_ORIGIN",
      "api is missing CLERK_SECRET_KEY",
      "web is missing NEXT_PUBLIC_API_URL",
      "web is missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "api is missing R2_ACCOUNT_ID",
      "worker is missing R2_BUCKET",
    ]));
  });

  test("the browser's API URL must be the API origin and the web URL the human origin", () => {
    const issues = checkEnvironmentValues(files({
      web: web({ NEXT_PUBLIC_API_URL: "https://old.example.com", NEXT_PUBLIC_APP_URL: "https://other.example.com" }),
    }));
    expect(messages(issues)).toEqual([
      "web NEXT_PUBLIC_API_URL and api API_ORIGIN are not the same origin",
      "web NEXT_PUBLIC_APP_URL and api WEB_ORIGIN are not the same origin",
    ]);
    // A path or trailing slash is not a different origin.
    expect(checkEnvironmentValues(files({ web: web({ NEXT_PUBLIC_API_URL: "http://localhost:4000/" }) }))).toEqual([]);
  });

  test("CORS and Clerk authorized parties must admit the web origin; the worker links to the web origin", () => {
    const issues = checkEnvironmentValues(files({
      api: api({ CORS_ALLOWED_ORIGINS: "http://localhost:4000", CLERK_AUTHORIZED_PARTIES: "http://127.0.0.1:3000" }),
      worker: worker({ WORKER_APP_BASE_URL: "http://localhost:4000" }),
    }));
    expect(messages(issues)).toEqual([
      "api CORS_ALLOWED_ORIGINS does not include WEB_ORIGIN",
      "api CLERK_AUTHORIZED_PARTIES does not include WEB_ORIGIN",
      "worker WORKER_APP_BASE_URL is not the web origin (WEB_ORIGIN), never the API origin",
    ]);
  });

  test("the API and web app must share one Clerk instance, compared without printing keys", () => {
    const issues = checkEnvironmentValues(files({ web: web({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_other", CLERK_SECRET_KEY: "sk_other" }) }));
    expect(messages(issues)).toEqual([
      "api CLERK_PUBLISHABLE_KEY and web NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY do not agree",
      "api and web CLERK_SECRET_KEY values do not agree",
    ]);
    expect(JSON.stringify(issues)).not.toContain("pk_");
    expect(JSON.stringify(issues)).not.toContain("sk_");
  });

  test("lists backend settings left in the web file by name only", () => {
    const leftovers = webBackendVariables(web({
      DATABASE_URL: "postgresql://secret", STRIPE_SECRET_KEY: "sk_secret", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_secret",
      R2_BUCKET: "x", NEXT_PUBLIC_GOOGLE_CLIENT_ID: "public", NODE_ENV: "development", CLERK_WEBHOOK_SECRET: "whsec",
    }));
    expect(leftovers).toEqual(["CLERK_WEBHOOK_SECRET", "DATABASE_URL", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "R2_BUCKET", "STRIPE_SECRET_KEY"]);
    expect(webBackendVariables(web())).toEqual([]);
  });
});
