export const OPTIONAL_REDIS_CONNECT_TIMEOUT_MS = 2_000;
export const OPTIONAL_REDIS_COMMAND_TIMEOUT_MS = 2_000;
export const OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS = 10_000;

const SAFE_REDIS_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

/** Validate without logging or returning a partially parsed credential URL. */
export function optionalRedisUrl(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol === "redis:" || parsed.protocol === "rediss:") &&
      parsed.hostname.length > 0
    ) {
      return parsed.toString();
    }
  } catch {
    // Invalid configuration disables the optional Redis integration safely.
  }

  return null;
}

/**
 * ioredis reconnects forever by default. Optional infrastructure should make a
 * small number of attempts and then let the durable/fail-open fallback take
 * over instead of keeping sockets and timers alive indefinitely.
 */
export function boundedRedisRetryDelay(
  attempt: number,
  maxAttempts = 3,
): number | null {
  if (
    !Number.isInteger(attempt) ||
    !Number.isInteger(maxAttempts) ||
    attempt < 1 ||
    maxAttempts < 1 ||
    attempt > maxAttempts
  ) {
    return null;
  }

  return Math.min(100 * 2 ** (attempt - 1), 1_000);
}

/**
 * ioredis writes an "Unhandled error event" (including the connection host)
 * when no error listener is attached. Callers still handle operation failures
 * through rejected promises; this listener only prevents unsafe implicit logs.
 */
export function installOptionalRedisErrorHandler(client: {
  on(event: "error", listener: (error: Error) => void): unknown;
}): void {
  client.on("error", () => {
    // Operation-level failures are handled by the caller's fallback policy.
  });
}

/** Return a low-cardinality diagnostic without ever serializing a Redis URL. */
export function optionalRedisFailureCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "REDIS_UNAVAILABLE";
  }

  const code = Reflect.get(error, "code");
  return typeof code === "string" && SAFE_REDIS_ERROR_CODES.has(code)
    ? code
    : "REDIS_UNAVAILABLE";
}
