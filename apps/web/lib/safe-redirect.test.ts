import { describe, expect, test } from "bun:test";
import {
  AppOriginConfigurationError,
  resolveCanonicalAppOrigin,
  safeSocialRedirectPath,
} from "./safe-redirect";

const DEFAULT_REDIRECT = "/settings/social";

describe("safeSocialRedirectPath", () => {
  test.each([
    undefined,
    null,
    "",
    "https://evil.example/settings/social",
    "//evil.example/settings/social",
    "/\\evil.example/settings/social",
    "/settings/%5csocial",
    "/settings/%2fsocial",
    "/settings/social\n",
    "/settings/social/%00",
    "/settings/profile",
  ])("returns the safe default for %s", (value) => {
    expect(safeSocialRedirectPath(value)).toBe(DEFAULT_REDIRECT);
  });

  test("accepts the allowlisted social settings path", () => {
    expect(safeSocialRedirectPath("/settings/social")).toBe(
      DEFAULT_REDIRECT,
    );
  });

  test("preserves a canonical query and hash", () => {
    expect(
      safeSocialRedirectPath("/settings/social?source=project#accounts"),
    ).toBe("/settings/social?source=project#accounts");
  });
});

describe("resolveCanonicalAppOrigin", () => {
  test.each([
    ["https://app.example.com", "https://app.example.com"],
    ["https://app.example.com/", "https://app.example.com"],
    ["http://app.example.com:8080/", "http://app.example.com:8080"],
  ])("canonicalizes configured origin %s", (configuredOrigin, expected) => {
    expect(
      resolveCanonicalAppOrigin({
        configuredOrigin,
        environment: "production",
        requestUrl: "https://attacker.example/api/social/oauth/start",
      }),
    ).toBe(expected);
  });

  test.each([
    "https://user:secret@app.example.com",
    "file:///tmp/app",
    "https://app.example.com/base-path",
    "https://app.example.com/?source=oauth",
    "https://app.example.com/#oauth",
    "https:\\app.example.com",
    "https://app.example.com\n",
    "   ",
  ])("rejects invalid configured origin %s", (configuredOrigin) => {
    expect(() =>
      resolveCanonicalAppOrigin({
        configuredOrigin,
        environment: "production",
        requestUrl: "http://localhost:3000/api/social/oauth/start",
      }),
    ).toThrow(AppOriginConfigurationError);
  });

  test("requires a configured origin in production", () => {
    try {
      resolveCanonicalAppOrigin({
        environment: "production",
        requestUrl: "https://attacker.example/api/social/oauth/start",
      });
      throw new Error("expected origin rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AppOriginConfigurationError);
      expect((error as AppOriginConfigurationError).reason).toBe(
        "configured_origin_missing",
      );
    }
  });

  test.each([
    "http://localhost:3000/api/social/oauth/start",
    "http://project.localhost:3000/api/social/oauth/start",
    "http://127.0.0.1:3000/api/social/oauth/start",
    "http://[::1]:3000/api/social/oauth/start",
  ])("allows loopback request origin in development for %s", (requestUrl) => {
    expect(
      resolveCanonicalAppOrigin({
        environment: "development",
        requestUrl,
      }),
    ).toBe(new URL(requestUrl).origin);
  });

  test("rejects a public request-derived origin in development", () => {
    expect(() =>
      resolveCanonicalAppOrigin({
        environment: "development",
        requestUrl: "https://attacker.example/api/social/oauth/start",
      }),
    ).toThrow(AppOriginConfigurationError);
  });

  test("does not fall back when a configured development origin is invalid", () => {
    expect(() =>
      resolveCanonicalAppOrigin({
        configuredOrigin: "https://user:secret@app.example.com",
        environment: "development",
        requestUrl: "http://localhost:3000/api/social/oauth/start",
      }),
    ).toThrow(AppOriginConfigurationError);
  });

  test("does not enable request fallback in test environments", () => {
    expect(() =>
      resolveCanonicalAppOrigin({
        environment: "test",
        requestUrl: "http://localhost:3000/api/social/oauth/start",
      }),
    ).toThrow(AppOriginConfigurationError);
  });
});
