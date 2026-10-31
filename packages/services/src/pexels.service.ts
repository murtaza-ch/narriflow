import { pickPexelsFile, type PexelsVideo, type BrollSearchResult } from "./pexels-contract";
export { pickPexelsFile, selectBestPexelsVideo, type PexelsUser, type PexelsVideoFile, type PexelsVideo, type BrollAttribution, type BrollClip, type BrollSearchResult } from "./pexels-contract";
/**
 * Pexels video search — the single client used by both the studio B-roll
 * picker (web `/broll/search` route) and the worker's render-time auto
 * B-roll (`apps/worker/src/tasks/broll.ts`), so retry/backoff, caching, and
 * attribution extraction exist in exactly one place.
 *
 * Everything here is gated on PEXELS_API_KEY — with no key configured, every
 * export degrades gracefully to "no B-roll" (empty results), never a thrown
 * error, since a stock-footage hiccup must never fail a clip render or a
 * studio search.
 *
 * Caching: search results are cached (in-process, plus Redis when
 * UPSTASH_REDIS_URL is configured — same optional/fail-open pattern as
 * `rate-limit.ts`) keyed by query+orientation, so the same query isn't
 * re-fetched from Pexels per clip/run/user. Downloaded-asset (byte-level)
 * caching lives in the worker (`apps/worker/src/tasks/broll.ts`), which is
 * the only place that writes files to disk.
 */
import Redis from "ioredis";
import type { PexelsOrientation } from "@narriflow/validators";
import {
  boundedRedisRetryDelay,
  installOptionalRedisErrorHandler,
  OPTIONAL_REDIS_COMMAND_TIMEOUT_MS,
  OPTIONAL_REDIS_CONNECT_TIMEOUT_MS,
  OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS,
  optionalRedisUrl,
} from "./optional-redis";

const PEXELS_VIDEO_SEARCH_URL = "https://api.pexels.com/videos/search";

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.warn(JSON.stringify({ level, message, ...context }));
}

export function isPexelsConfigured(): boolean {
  return Boolean(process.env.PEXELS_API_KEY);
}

// --- Optional Redis cache (fail-open, same pattern as rate-limit.ts) --------

let redisClient: Redis | null = null;
let redisRetryAfter = 0;

function resetRedisClient(failedClient: Redis) {
  if (redisClient === failedClient) {
    redisClient = null;
    redisRetryAfter = Date.now() + OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS;
  }
  failedClient.disconnect();
}

function getRedisClient(): Redis | null {
  const url = optionalRedisUrl(process.env.UPSTASH_REDIS_URL);
  if (!url) return null;
  if (Date.now() < redisRetryAfter) return null;
  if (!redisClient) {
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
      redisRetryAfter = Date.now() + OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS;
      return null;
    }
    installOptionalRedisErrorHandler(nextClient);
    nextClient.on("end", () => {
      if (redisClient === nextClient) {
        redisClient = null;
        redisRetryAfter = Date.now() + OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS;
      }
    });
    redisClient = nextClient;
  }
  return redisClient;
}

const DEFAULT_CACHE_TTL_SEC = 21_600; // 6h — Pexels' catalog doesn't churn minute to minute
const MEMORY_CACHE_MAX_ENTRIES = 500;

function cacheTtlSec(): number {
  const raw = Number(process.env.PEXELS_SEARCH_CACHE_TTL_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CACHE_TTL_SEC;
}

interface MemoryCacheEntry {
  videos: PexelsVideo[];
  expiresAt: number;
}

const memoryCache = new Map<string, MemoryCacheEntry>();

function memoryCacheSet(key: string, videos: PexelsVideo[], ttlSec: number) {
  if (memoryCache.size >= MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey !== undefined) memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, { videos, expiresAt: Date.now() + ttlSec * 1000 });
}

function cacheKeyFor(query: string, orientation: string, perPage: number): string {
  return `broll:search:v1:${orientation}:${perPage}:${query.trim().toLowerCase()}`;
}

async function getCachedSearch(key: string): Promise<PexelsVideo[] | null> {
  const mem = memoryCache.get(key);
  if (mem) {
    if (mem.expiresAt > Date.now()) return mem.videos;
    memoryCache.delete(key);
  }

  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const videos = JSON.parse(raw) as PexelsVideo[];
    memoryCacheSet(key, videos, cacheTtlSec());
    return videos;
  } catch {
    return null;
  }
}

async function setCachedSearch(key: string, videos: PexelsVideo[]): Promise<void> {
  const ttlSec = cacheTtlSec();
  memoryCacheSet(key, videos, ttlSec);

  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(videos), "EX", ttlSec);
  } catch {
    resetRedisClient(redis);
  }
}

// --- Resilient search: retry + backoff, distinct logging per failure mode ---

const DEFAULT_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const BASE_RETRY_DELAY_MS = 400;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_RETRY_AFTER_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** +/-15% jitter so concurrent renders don't retry Pexels in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.85 + Math.random() * 0.3));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return null;
}

export interface SearchPexelsVideosOptions {
  perPage?: number;
  maxAttempts?: number;
  /** Test-only: injected fetch implementation. Production call sites never pass it. */
  fetchImpl?: typeof fetch;
  /** Test-only: bypasses the cache so retry/backoff behavior is deterministic. */
  skipCache?: boolean;
}

/**
 * Searches Pexels for videos. Resolves to [] (never throws) whenever no key
 * is configured, the query is empty, or every attempt fails — callers treat
 * that as "no B-roll for this query" and either try a broader query or render
 * without one. Zero-results, 429, and network/HTTP errors are logged
 * distinctly; 429/5xx/network errors are retried with jittered backoff
 * (respecting `Retry-After` on 429), while a genuine 4xx (e.g. a bad API key)
 * fails fast without retrying.
 */
export async function searchPexelsVideos(
  query: string,
  orientation: PexelsOrientation,
  options: SearchPexelsVideosOptions = {},
): Promise<PexelsVideo[]> {
  const apiKey = process.env.PEXELS_API_KEY;
  const trimmedQuery = query.trim();
  if (!apiKey || !trimmedQuery) return [];

  const perPage = Math.min(40, Math.max(1, options.perPage ?? 15));
  const cacheKey = cacheKeyFor(trimmedQuery, orientation, perPage);

  if (!options.skipCache) {
    const cached = await getCachedSearch(cacheKey);
    if (cached) {
      log("info", "pexels_search_cache_hit", { query: trimmedQuery, orientation });
      return cached;
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const url = `${PEXELS_VIDEO_SEARCH_URL}?query=${encodeURIComponent(trimmedQuery)}&orientation=${orientation}&per_page=${perPage}&size=medium`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= maxAttempts) {
        log("error", "pexels_search_network_error", {
          query: trimmedQuery,
          orientation,
          attempt,
          // Named errorMessage (not "message") so it can't collide with —
          // and silently overwrite — this log call's own event-name field
          // once spread into the same JSON object.
          errorMessage: error instanceof Error ? error.message : "unknown",
        });
        return [];
      }
      log("info", "pexels_search_retry", {
        query: trimmedQuery,
        orientation,
        attempt,
        reason: "network_error",
      });
      await sleep(jitter(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1)));
      continue;
    }

    if (response.status === 429) {
      if (attempt >= maxAttempts) {
        log("error", "pexels_search_rate_limited", {
          query: trimmedQuery,
          orientation,
          attempt,
        });
        return [];
      }
      log("info", "pexels_search_retry", {
        query: trimmedQuery,
        orientation,
        attempt,
        reason: "rate_limited",
      });
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      await sleep(retryAfterMs ?? jitter(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1)));
      continue;
    }

    if (!response.ok) {
      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        log("info", "pexels_search_retry", {
          query: trimmedQuery,
          orientation,
          attempt,
          reason: "http_error",
          status: response.status,
        });
        await sleep(jitter(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1)));
        continue;
      }
      log("error", "pexels_search_http_error", {
        query: trimmedQuery,
        orientation,
        status: response.status,
      });
      return [];
    }

    let data: { videos?: PexelsVideo[] };
    try {
      data = (await response.json()) as { videos?: PexelsVideo[] };
    } catch {
      log("error", "pexels_search_parse_error", { query: trimmedQuery, orientation });
      return [];
    }

    const videos = Array.isArray(data.videos) ? data.videos : [];
    if (videos.length === 0) {
      log("info", "pexels_search_empty", { query: trimmedQuery, orientation });
      return [];
    }

    if (!options.skipCache) {
      await setCachedSearch(cacheKey, videos);
    }
    return videos;
  }

  return [];
}

// --- Web-facing search (studio B-roll picker) --------------------------------

/**
 * Studio-picker-shaped search: thumbnail + downloadUrl + attribution per
 * result. Thin wrapper over `searchPexelsVideos` — kept as its own export so
 * the web route's contract (and existing tests) don't need to change.
 */
export async function searchBrollVideos(
  query: string,
  orientation: PexelsOrientation = "portrait",
  limit = 12,
): Promise<BrollSearchResult[]> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey || !query.trim()) return [];

  const targetWidth = orientation === "landscape" ? 1920 : 1080;
  const videos = await searchPexelsVideos(query, orientation, {
    perPage: Math.min(40, Math.max(1, limit)),
  });

  const results: BrollSearchResult[] = [];
  for (const video of videos) {
    const file = pickPexelsFile(video.video_files, targetWidth);
    if (!file) continue;
    results.push({
      id: video.id,
      image: video.image,
      width: video.width,
      height: video.height,
      durationSec: video.duration,
      downloadUrl: file.link,
      authorName: video.user?.name ?? null,
      authorUrl: video.user?.url ?? null,
      pageUrl: video.url ?? null,
    });
  }
  return results;
}
