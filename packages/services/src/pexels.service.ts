import { readServiceEnvironment } from "./runtime-environment";
import { pickPexelsFile, type PexelsVideo, type BrollSearchResult } from "./pexels-contract";
export { pickPexelsFile, selectBestPexelsVideo, type PexelsUser, type PexelsVideoFile, type PexelsVideo, type BrollAttribution, type BrollClip, type BrollSearchResult } from "./pexels-contract";
/** Pexels metadata search. Cache and provider failures preserve the optional
 * no-B-roll result. Native byte transfer belongs to the media executor. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PexelsOrientation } from "@narriflow/validators";

const PEXELS_VIDEO_SEARCH_URL = "https://api.pexels.com/videos/search";

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.warn(JSON.stringify({ level, message, ...context }));
}

export function isPexelsConfigured(): boolean {
  return Boolean(readServiceEnvironment().PEXELS_API_KEY);
}

export interface PexelsSearchCachePort {
  get(key: string): Promise<PexelsVideo[] | null>;
  set(key: string, videos: PexelsVideo[], ttlSeconds: number): Promise<void>;
}
const searchCache = new AsyncLocalStorage<PexelsSearchCachePort | null>();
export function withPexelsSearchCache<Result>(cache: PexelsSearchCachePort | null, operation: () => Result): Result {
  return searchCache.run(cache, operation);
}

const DEFAULT_CACHE_TTL_SEC = 21_600;
function cacheTtlSec(): number {
  const raw = Number(readServiceEnvironment().PEXELS_SEARCH_CACHE_TTL_SEC);
  return Number.isFinite(raw) && raw > 0 ? Math.min(86_400, Math.ceil(raw)) : DEFAULT_CACHE_TTL_SEC;
}
function cacheKeyFor(query: string, orientation: string, perPage: number): string {
  return `broll:search:v1:${orientation}:${perPage}:${query.trim().toLowerCase()}`;
}
async function getCachedSearch(key: string): Promise<PexelsVideo[] | null> {
  try { return await searchCache.getStore()?.get(key) ?? null; } catch { return null; }
}
async function setCachedSearch(key: string, videos: PexelsVideo[]): Promise<void> {
  try { await searchCache.getStore()?.set(key, videos, cacheTtlSec()); } catch { /* Optional metadata cache. */ }
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
  const apiKey = readServiceEnvironment().PEXELS_API_KEY;
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
  const apiKey = readServiceEnvironment().PEXELS_API_KEY;
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
