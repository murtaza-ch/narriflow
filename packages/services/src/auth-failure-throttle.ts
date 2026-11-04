import { checkRateLimit, readRateLimit, type RateLimitResult } from "./rate-limit";

/** Failed credentials per address. Only failures count, so valid traffic never spends it. */
export const AUTH_FAILURE_RATE_LIMIT = { limit: 600, windowSeconds: 60 } as const;

export interface AuthFailureLimiter {
  read(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

export interface AuthFailureThrottle {
  /** Peeks the address's failure bucket: true once it has used its budget. Call before looking up any credential. */
  exhausted(): Promise<boolean>;
  /** Spends one failure. Call only for a credential the caller got wrong. */
  recordFailure(): Promise<void>;
  retryAfterSeconds: number;
}

/**
 * The read-then-consume bucket for failed authentication, so a client cycling
 * bogus credentials is refused before each one costs a lookup. `scope`
 * separates surfaces (`rest`, `mcp`); the key is `<scope>:authfail:<address>`.
 */
export function authFailureThrottle(
  scope: "rest" | "mcp",
  address: string,
  limiter: AuthFailureLimiter = { read: readRateLimit, check: checkRateLimit },
): AuthFailureThrottle {
  const key = `${scope}:authfail:${address}`;
  const { limit, windowSeconds } = AUTH_FAILURE_RATE_LIMIT;
  return {
    exhausted: async () => !(await limiter.read(key, limit, windowSeconds)).allowed,
    recordFailure: async () => { await limiter.check(key, limit, windowSeconds); },
    retryAfterSeconds: windowSeconds,
  };
}
