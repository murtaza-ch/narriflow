import { describe, expect, test } from "bun:test";
import { ApiConfigError, loadApiConfig } from "./config";

const valid = {
  NODE_ENV: "development",
  API_ORIGIN: "http://localhost:4000",
  WEB_ORIGIN: "http://localhost:3000",
  CLERK_SECRET_KEY: "sk_test_x",
  CLERK_PUBLISHABLE_KEY: "pk_test_x",
  CLERK_AUTHORIZED_PARTIES: "http://localhost:3000,http://127.0.0.1:3000",
};

function problems(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadApiConfig(env);
  } catch (error) {
    if (error instanceof ApiConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("API configuration", () => {
  test("loads local development defaults", () => {
    const config = loadApiConfig(valid);
    expect(config.port).toBe(4000);
    expect(config.corsAllowedOrigins).toEqual(["http://localhost:3000"]);
    expect(config.clerk.authorizedParties).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
    expect(config.staffAllowlist.size).toBe(0);
    expect(config.streams).toEqual({ maxConnections: 100, maxConnectionsPerActor: 5 });
    expect(config.trustedClientIpHeader).toBeNull();
  });

  test("parses the server-only staff allowlist as exact IDs", () => {
    const config = loadApiConfig({ ...valid, PLATFORM_STAFF_CLERK_USER_IDS: " user_a , user_b ,," });
    expect([...config.staffAllowlist]).toEqual(["user_a", "user_b"]);
  });

  test("keeps CORS origins and authorized parties distinct, exact and never the API itself", () => {
    expect(
      loadApiConfig({ ...valid, CORS_ALLOWED_ORIGINS: "https://a.example,https://a.example" }).corsAllowedOrigins,
    ).toEqual(["https://a.example"]);
    expect(problems({ ...valid, CORS_ALLOWED_ORIGINS: "http://localhost:4000" })).toContain(
      "CORS_ALLOWED_ORIGINS must not include API_ORIGIN",
    );
    expect(problems({ ...valid, CLERK_AUTHORIZED_PARTIES: "http://localhost:4000" })).toContain(
      "CLERK_AUTHORIZED_PARTIES must not include API_ORIGIN",
    );
  });

  test.each(["https://*.vercel.app", "https://a.example/path", "narriflow.app", "ftp://a.example"])(
    "rejects the origin %s without echoing it",
    (value) => {
      const found = problems({ ...valid, CORS_ALLOWED_ORIGINS: value });
      expect(found).toHaveLength(1);
      expect(found.join(" ")).not.toContain(value);
    },
  );

  test("requires explicit authorized parties and Clerk keys", () => {
    const found = problems({ ...valid, CLERK_AUTHORIZED_PARTIES: "", CLERK_SECRET_KEY: "" });
    expect(found).toContain("CLERK_AUTHORIZED_PARTIES must list at least one frontend origin");
    expect(found).toContain("CLERK_SECRET_KEY is required");
  });

  test("requires https outside loopback in production", () => {
    expect(
      problems({
        ...valid,
        NODE_ENV: "production",
        API_ORIGIN: "http://api.example.com",
        WEB_ORIGIN: "https://app.example.com",
        CLERK_AUTHORIZED_PARTIES: "https://app.example.com",
      }),
    ).toEqual(["API_ORIGIN must use https in production"]);
  });

  test("validates bounded integers and the trusted IP header name", () => {
    expect(problems({ ...valid, API_STREAM_MAX_CONNECTIONS: "0", TRUSTED_CLIENT_IP_HEADER: "bad header" })).toEqual([
      "TRUSTED_CLIENT_IP_HEADER must be a header name",
      "API_STREAM_MAX_CONNECTIONS must be a positive integer",
    ]);
  });
});
