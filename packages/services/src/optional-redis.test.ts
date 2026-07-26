import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  boundedRedisRetryDelay,
  installOptionalRedisErrorHandler,
  optionalRedisFailureCode,
  optionalRedisUrl,
} from "./optional-redis";

describe("optionalRedisUrl", () => {
  test("accepts only Redis connection schemes with a hostname", () => {
    expect(optionalRedisUrl("redis://localhost:6379")).toBe(
      "redis://localhost:6379",
    );
    expect(optionalRedisUrl("rediss://user:token@example.invalid:6379")).toBe(
      "rediss://user:token@example.invalid:6379",
    );
    expect(optionalRedisUrl("https://example.invalid")).toBeNull();
    expect(optionalRedisUrl("redis://:6379")).toBeNull();
  });

  test("rejects malformed credential URLs without returning their contents", () => {
    const malformed = "redis://user:secret@[invalid";
    const result = optionalRedisUrl(malformed);

    expect(result).toBeNull();
    expect(String(result)).not.toContain("secret");
  });
});

describe("boundedRedisRetryDelay", () => {
  test("uses capped exponential backoff and then stops reconnecting", () => {
    expect([
      boundedRedisRetryDelay(1),
      boundedRedisRetryDelay(2),
      boundedRedisRetryDelay(3),
      boundedRedisRetryDelay(4),
    ]).toEqual([100, 200, 400, null]);
  });

  test("supports a tighter retry budget and rejects invalid attempts", () => {
    expect(boundedRedisRetryDelay(1, 1)).toBe(100);
    expect(boundedRedisRetryDelay(2, 1)).toBeNull();
    expect(boundedRedisRetryDelay(0)).toBeNull();
    expect(boundedRedisRetryDelay(Number.NaN)).toBeNull();
  });
});

describe("optionalRedisFailureCode", () => {
  test("keeps only allow-listed, low-cardinality network codes", () => {
    expect(optionalRedisFailureCode({ code: "ENOTFOUND" })).toBe("ENOTFOUND");
    expect(optionalRedisFailureCode({ code: "ETIMEDOUT" })).toBe("ETIMEDOUT");
  });

  test("does not expose messages, URLs, or arbitrary error codes", () => {
    const secretUrl = "rediss://user:secret@example.invalid:6379";
    const result = optionalRedisFailureCode({
      code: secretUrl,
      message: `getaddrinfo ENOTFOUND ${secretUrl}`,
    });

    expect(result).toBe("REDIS_UNAVAILABLE");
    expect(result).not.toContain("example.invalid");
    expect(optionalRedisFailureCode(new Error(secretUrl))).toBe(
      "REDIS_UNAVAILABLE",
    );
  });
});

test("installOptionalRedisErrorHandler consumes client error events", () => {
  const emitter = new EventEmitter();
  installOptionalRedisErrorHandler(emitter);

  expect(() =>
    emitter.emit("error", new Error("rediss://user:secret@example.invalid")),
  ).not.toThrow();
});
