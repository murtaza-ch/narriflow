import type { RateLimiterPort } from "@narriflow/services/rate-limit";
import type { RateLimiter } from "./durable-objects/rate-limiter";

export function createRateLimiterClient(namespace: { getByName(name: string): Pick<RateLimiter, "check"> }): RateLimiterPort {
  return {
    async check(key, limit, windowSeconds, consume) {
      if (key.length < 1 || key.length > 1_024) throw new Error("Invalid rate limit key");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${windowSeconds}:${key}`));
      const name = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return namespace.getByName(name).check({ limit, windowSeconds, consume });
    },
  };
}
