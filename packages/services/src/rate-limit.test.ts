import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkRateLimit } from "./rate-limit";

describe("checkRateLimit (fail-open safety)", () => {
  let savedUrl: string | undefined;

  beforeAll(() => {
    savedUrl = process.env.UPSTASH_REDIS_URL;
    delete process.env.UPSTASH_REDIS_URL;
  });

  afterAll(() => {
    if (savedUrl === undefined) {
      delete process.env.UPSTASH_REDIS_URL;
    } else {
      process.env.UPSTASH_REDIS_URL = savedUrl;
    }
  });

  test("fails open (allowed=true) when Redis URL is unset", async () => {
    const result = await checkRateLimit("gen:user-1", 20, 60);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(20);
    expect(result.remaining).toBe(20);
  });

  test("stays open across repeated calls beyond the limit", async () => {
    for (let i = 0; i < 50; i += 1) {
      const result = await checkRateLimit("gen:user-2", 5, 60);
      expect(result.allowed).toBe(true);
    }
  });

  test("returns the configured limit shape", async () => {
    const result = await checkRateLimit("presign:user-3", 60, 60);
    expect(result).toEqual({ allowed: true, remaining: 60, limit: 60 });
  });

  test("fails open for a malformed Redis credential URL", async () => {
    process.env.UPSTASH_REDIS_URL = "redis://user:secret@[invalid";
    try {
      await expect(checkRateLimit("gen:user-4", 20, 60)).resolves.toEqual({
        allowed: true,
        remaining: 20,
        limit: 20,
      });
    } finally {
      delete process.env.UPSTASH_REDIS_URL;
    }
  });
});
