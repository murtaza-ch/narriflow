import { describe, expect, test } from "bun:test";
import { checkEnvironmentValues } from "./env-check";

const database = "postgresql://user:password@ep-dev-pooler.us-east-1.aws.neon.tech/neondb?schema=public";
const directDatabase = "postgresql://user:password@ep-dev.us-east-1.aws.neon.tech/neondb?schema=public";
const redis = "rediss://:secret@dev.upstash.io/0";

function values(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: database,
    DIRECT_URL: directDatabase,
    R2_ACCOUNT_ID: "shared-account",
    R2_BUCKET: "narriflow-dev",
    UPSTASH_REDIS_URL: redis,
    ...overrides,
  };
}

describe("env check", () => {
  test("accepts pooler and direct database URLs with the same identity", () => {
    expect(checkEnvironmentValues(values(), values(), values())).toEqual([]);
  });

  test("reports database, bucket, and Redis mismatches without exposing values", () => {
    const issues = checkEnvironmentValues(
      values({ R2_BUCKET: "web" }),
      values({ DATABASE_URL: database.replace("neondb", "other"), R2_ACCOUNT_ID: "other-account", R2_BUCKET: "worker", UPSTASH_REDIS_URL: "rediss://:secret@other.upstash.io/1" }),
      values(),
    );
    expect(issues.map((issue) => issue.message).join(" ")).toContain("PostgreSQL identities");
    expect(issues.map((issue) => issue.message).join(" ")).toContain("R2_BUCKET");
    expect(issues.map((issue) => issue.message).join(" ")).toContain("R2_ACCOUNT_ID");
    expect(issues.map((issue) => issue.message).join(" ")).toContain("Redis endpoints");
    expect(JSON.stringify(issues)).not.toContain("secret");
  });

  test("rejects an app direct connection to another database", () => {
    const issues = checkEnvironmentValues(values(), values({ DIRECT_URL: directDatabase.replace("neondb", "other") }), values());
    expect(issues.map((issue) => issue.message)).toContain("web, worker, and db PostgreSQL identities do not agree");
  });

  test("keeps non-Neon pooler names, checks ports, and uses Redis port 6379 for TLS", () => {
    const issues = checkEnvironmentValues(
      values({ DATABASE_URL: "postgresql://u:p@db-pooler.example.com:5433/narriflow" }),
      values({ DATABASE_URL: "postgresql://u:p@db.example.com:5433/narriflow" }),
      values({ DIRECT_URL: "postgresql://u:p@db.example.com:5433/narriflow" }),
    );
    expect(issues.map((issue) => issue.message)).toContain("web, worker, and db PostgreSQL identities do not agree");
    expect(checkEnvironmentValues(values({ UPSTASH_REDIS_URL: "rediss://:secret@local.upstash.io" }), values({ UPSTASH_REDIS_URL: "rediss://:secret@local.upstash.io" }), values())).toEqual([]);
    expect(checkEnvironmentValues(values({ UPSTASH_REDIS_URL: "rediss://:secret@local.upstash.io/0" }), values({ UPSTASH_REDIS_URL: "rediss://:secret@local.upstash.io/1" }), values()).map((issue) => issue.message)).toContain("web and worker Redis endpoints do not agree");
  });

  test("allows Redis to be absent in both files but flags a one-sided setting", () => {
    expect(checkEnvironmentValues(values({ UPSTASH_REDIS_URL: "" }), values({ UPSTASH_REDIS_URL: "" }), values())).toEqual([]);
    expect(checkEnvironmentValues(values({ UPSTASH_REDIS_URL: "" }), values({ UPSTASH_REDIS_URL: "redis://127.0.0.1:6379" }), values())).toEqual(expect.arrayContaining([
      { message: "web and worker UPSTASH_REDIS_URL must both be present or both be absent" },
    ]));
  });

  test("requires database and R2 values", () => {
    const issues = checkEnvironmentValues({}, {}, {});
    expect(issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "web is missing DATABASE_URL",
      "worker is missing DATABASE_URL",
      "db is missing DATABASE_URL",
      "db is missing DIRECT_URL",
      "web is missing R2_ACCOUNT_ID",
      "worker is missing R2_ACCOUNT_ID",
      "web is missing R2_BUCKET",
      "worker is missing R2_BUCKET",
    ]));
  });
});
