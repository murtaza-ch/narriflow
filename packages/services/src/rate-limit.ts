import { AsyncLocalStorage } from "node:async_hooks";
import { ExpectedDomainFailureError } from "./expected-domain-failure";

export interface RateLimitResult {
  availability: "available" | "unavailable";
  allowed: boolean;
  remaining: number;
  limit: number;
}

/** The Worker supplies a Durable Object client for exactly one invocation. */
export interface RateLimiterPort {
  check(key: string, limit: number, windowSeconds: number, consume: boolean): Promise<RateLimitResult>;
}
const currentLimiter = new AsyncLocalStorage<RateLimiterPort>();
export function withRateLimiter<Result>(limiter: RateLimiterPort, operation: () => Result): Result {
  return currentLimiter.run(limiter, operation);
}

/** Unknown availability carries no measured exhaustion. Admission rejects all
 * new mutations using availability; reads and immutable receipt replays may proceed. */
function unavailable(limit: number): RateLimitResult {
  return { allowed: true, remaining: limit, limit, availability: "unavailable" };
}

async function check(key: string, limit: number, windowSeconds: number, consume: boolean): Promise<RateLimitResult> {
  const limiter = currentLimiter.getStore();
  if (!limiter) return unavailable(limit);
  try {
    const result = await limiter.check(key, limit, windowSeconds, consume);
    if (result.availability !== "available" || result.limit !== limit ||
      typeof result.allowed !== "boolean" || !Number.isSafeInteger(result.remaining) ||
      result.remaining < 0 || result.remaining > limit) return unavailable(limit);
    return result;
  } catch {
    return unavailable(limit);
  }
}

export function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  return check(key, limit, windowSeconds, true);
}

/** Peeks without counting, so successful reviewer authentication does not use
 * the failed-authentication budget. */
export function readRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  return check(key, limit, windowSeconds, false);
}

/** Run after immutable replay lookup, before accepting genuinely new work. */
export function requireNewMutationAllowed(result: RateLimitResult) {
  if (result.availability !== "available") throw new ExpectedDomainFailureError({ code: "mutations_unavailable", kind: "unavailable",
    message: "New mutations are paused while the request limiter is unavailable", retryAfterSeconds: 5 });
  if (!result.allowed) throw new ExpectedDomainFailureError({ code: "request_limit_exceeded", kind: "rate_limited",
    message: "Request limit exceeded", retryAfterSeconds: 60 });
}
