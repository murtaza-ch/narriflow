import Redis from "ioredis";
import {
  boundedRedisRetryDelay,
  installOptionalRedisErrorHandler,
  OPTIONAL_REDIS_COMMAND_TIMEOUT_MS,
  OPTIONAL_REDIS_CONNECT_TIMEOUT_MS,
  OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS,
  optionalRedisUrl,
} from "./optional-redis";

let client: Redis | null = null;
let retryAfter = 0;

function resetClient(failedClient: Redis) {
  if (client === failedClient) {
    client = null;
    retryAfter = Date.now() + OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS;
  }
  failedClient.disconnect();
}

function getClient(): Redis | null {
  const url = optionalRedisUrl(process.env.UPSTASH_REDIS_URL);
  if (!url) return null;
  if (Date.now() < retryAfter) return null;
  if (!client) {
    let nextClient: Redis;
    try {
      nextClient = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: OPTIONAL_REDIS_CONNECT_TIMEOUT_MS,
        commandTimeout: OPTIONAL_REDIS_COMMAND_TIMEOUT_MS,
        retryStrategy: (attempt) => boundedRedisRetryDelay(attempt, 2),
      });
    } catch {
      retryAfter = Date.now() + OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS;
      return null;
    }
    installOptionalRedisErrorHandler(nextClient);
    nextClient.on("end", () => {
      if (client === nextClient) {
        client = null;
        retryAfter = Date.now() + OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS;
      }
    });
    client = nextClient;
  }
  return client;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

/** Fixed-window per-key limiter. Fails OPEN (allowed=true) if Redis is
 *  unavailable — availability must not depend on the limiter. */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  let redis: Redis | null = null;
  try {
    redis = getClient();
    if (!redis) return { allowed: true, remaining: limit, limit };
    const bucket = `ratelimit:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    const count = await redis.incr(bucket);
    if (count === 1) await redis.expire(bucket, windowSeconds);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), limit };
  } catch {
    if (redis) resetClient(redis);
    return { allowed: true, remaining: limit, limit };
  }
}
