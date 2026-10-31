import { expect, test } from "bun:test";
import { checkRateLimit, readRateLimit, requireNewMutationAllowed, withRateLimiter } from "./rate-limit";

test("an unavailable limiter pauses new mutations without treating an outage as exhaustion", async () => {
  const result = await checkRateLimit("gen:user", 20, 60);
  expect(result.availability).toBe("unavailable");
  expect(() => requireNewMutationAllowed(result)).toThrow("New mutations are paused");
});

test("a request can read its bucket without consuming another admission", async () => {
  let count = 0;
  await withRateLimiter({
    async check(_key, limit, _windowSeconds, consume) {
      if (consume) count += 1;
      return { allowed: consume ? count <= limit : count < limit, remaining: Math.max(0, limit - count), limit, availability: "available" };
    },
  }, async () => {
    expect((await checkRateLimit("review:source", 2, 60)).remaining).toBe(1);
    expect((await readRateLimit("review:source", 2, 60)).remaining).toBe(1);
    expect((await checkRateLimit("review:source", 2, 60)).allowed).toBe(true);
    expect((await readRateLimit("review:source", 2, 60)).allowed).toBe(false);
    expect((await checkRateLimit("review:source", 2, 60)).allowed).toBe(false);
  });
  expect((await readRateLimit("review:source", 2, 60)).availability).toBe("unavailable");
});
