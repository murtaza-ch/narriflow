/**
 * Stock B-roll via the Pexels video API (free, commercial-OK). Query
 * derivation, orientation mapping, and cutaway placement are pure and shared
 * with the studio B-roll panel — they live in `@narriflow/validators`
 * (re-exported below so existing imports of `./broll` keep working). Pexels
 * HTTP search (with retry/backoff/caching/attribution) lives in
 * `@narriflow/services`, shared with the web studio picker.
 *
 * This module owns the parts that are specific to the render pipeline:
 * resolving a multi-cutaway plan into actual downloadable assets, and a
 * local-disk cache for the downloaded bytes themselves (the search-result
 * cache in `pexels.service.ts` avoids repeat *searches*; this avoids repeat
 * *downloads* of the same resolved asset). Everything here is gated on
 * PEXELS_API_KEY at the call site — with no key, the worker simply skips
 * B-roll entirely.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectBestPexelsVideo,
} from "@narriflow/services/pexels-contract";
import {
  brollQueryForClip,
  dominantPexelsOrientation,
  pexelsOrientationForAspectRatio,
  planBrollCutaways,
  planBrollWindow,
} from "@narriflow/validators";
import type {
  BrollCueInput,
  PexelsOrientation,
  PlannedBrollCutaway,
} from "@narriflow/validators";

// Re-exported so existing imports (`from "./broll"`) keep resolving — the
// actual implementations live in @narriflow/validators (pure placement/query
// logic, shared with the studio panel) and @narriflow/services (the Pexels
// HTTP client, shared with the web search route).
export {
  brollQueryForClip,
  dominantPexelsOrientation,
  pexelsOrientationForAspectRatio,
  planBrollCutaways,
  planBrollWindow,
  selectBestPexelsVideo,
};
export type { BrollCueInput, PexelsOrientation, PlannedBrollCutaway };
export type { BrollAttribution, BrollClip } from "@narriflow/services/pexels-contract";

// --- Downloaded-asset disk cache ---------------------------------------------
//
// Lives outside any per-run temp directory (those are deleted at the end of
// every render) so a resolved asset survives across clips/runs/users for as
// long as this worker's container does — "cheap infra": no new dependency, no
// migration, no cross-service coupling.

const BROLL_ASSET_CACHE_DIR = join(tmpdir(), "narriflow-broll-asset-cache");
const DEFAULT_ASSET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ASSET_CACHE_MAX_BYTES = 1024 ** 3;
/** A temporary write older than this belongs to a writer that died. */
const STALE_TEMP_WRITE_MS = 10 * 60 * 1000;
const TEMP_WRITE_MARKER = ".tmp-";

export interface BrollCacheOptions {
  /** Defaults to the shared worker cache directory; tests use their own. */
  directory?: string;
  ttlMs?: number;
  maxBytes?: number;
}

function assetCacheKey(downloadUrl: string): string {
  return createHash("sha256").update(downloadUrl).digest("hex");
}

export function brollAssetCachePath(
  downloadUrl: string,
  directory: string = BROLL_ASSET_CACHE_DIR,
): string {
  return join(directory, `${assetCacheKey(downloadUrl)}.mp4`);
}

/**
 * Returns a local path to a previously-downloaded copy of this exact asset
 * URL if one exists and is still fresh, so the caller can skip the network
 * download entirely. Read-only — never mutates the cache. Returns null (never
 * throws) on any filesystem error, which callers treat as "not cached".
 */
export async function getCachedBrollAssetPath(
  downloadUrl: string,
  cacheTtlMs: number = DEFAULT_ASSET_CACHE_TTL_MS,
  directory?: string,
): Promise<string | null> {
  const path = brollAssetCachePath(downloadUrl, directory);
  try {
    const stats = await stat(path);
    if (Date.now() - stats.mtimeMs < cacheTtlMs) return path;
  } catch {
    // Not cached (or unreadable) — caller downloads normally.
  }
  return null;
}

export interface BrollCachePruneResult {
  removedFiles: number;
  removedBytes: number;
  remainingBytes: number;
}

/**
 * Bounds the cache by lifetime and bytes: expired assets and dead writers'
 * temporary files go first, then the oldest assets until `reserveBytes` more
 * fit under `maxBytes`. Never throws; a file that cannot be removed stays.
 */
export async function pruneBrollAssetCache(
  options: BrollCacheOptions & { reserveBytes?: number; nowMs?: number } = {},
): Promise<BrollCachePruneResult> {
  const directory = options.directory ?? BROLL_ASSET_CACHE_DIR;
  const ttlMs = options.ttlMs ?? DEFAULT_ASSET_CACHE_TTL_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_ASSET_CACHE_MAX_BYTES;
  const nowMs = options.nowMs ?? Date.now();
  const result: BrollCachePruneResult = { removedFiles: 0, removedBytes: 0, remainingBytes: 0 };
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return result;
  }
  const remove = async (path: string, size: number): Promise<boolean> => {
    try {
      await rm(path, { force: true });
      result.removedFiles += 1;
      result.removedBytes += size;
      return true;
    } catch {
      return false;
    }
  };
  const live: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    const path = join(directory, name);
    let stats;
    try {
      stats = await stat(path);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    const age = nowMs - stats.mtimeMs;
    const expired = name.includes(TEMP_WRITE_MARKER) ? age >= STALE_TEMP_WRITE_MS : age >= ttlMs;
    if (expired && (await remove(path, stats.size))) continue;
    live.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
  }
  let total = live.reduce((sum, file) => sum + file.size, 0);
  live.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const budget = maxBytes - (options.reserveBytes ?? 0);
  while (total > budget && live.length > 0) {
    const oldest = live.shift()!;
    if (await remove(oldest.path, oldest.size)) total -= oldest.size;
  }
  result.remainingBytes = total;
  return result;
}

/**
 * Best-effort: copies an already-downloaded asset into the shared cache dir
 * so future renders (any clip, any run, any user) can reuse it without
 * re-fetching from Pexels. Writes to a temp path and renames into place so a
 * concurrent reader never observes a partially-written file; a failed write
 * removes its temp file. An asset larger than the byte bound is not cached,
 * and older assets are evicted to keep the cache within it. A cache-write
 * failure must never fail the render — this is a pure optimization.
 */
export async function saveBrollAssetToCache(
  downloadUrl: string,
  sourceFilePath: string,
  options: BrollCacheOptions = {},
): Promise<void> {
  const directory = options.directory ?? BROLL_ASSET_CACHE_DIR;
  const maxBytes = options.maxBytes ?? DEFAULT_ASSET_CACHE_MAX_BYTES;
  let tmpPath: string | null = null;
  try {
    const { size } = await stat(sourceFilePath);
    if (size > maxBytes) return;
    await mkdir(directory, { recursive: true });
    await pruneBrollAssetCache({ ...options, directory, maxBytes, reserveBytes: size });
    const finalPath = brollAssetCachePath(downloadUrl, directory);
    tmpPath = `${finalPath}${TEMP_WRITE_MARKER}${process.pid}-${Date.now()}`;
    await copyFile(sourceFilePath, tmpPath);
    await rename(tmpPath, finalPath);
    tmpPath = null;
  } catch {
    // Cache is a pure optimization — never let a write failure affect rendering.
    if (tmpPath) await rm(tmpPath, { force: true }).catch(() => {});
  }
}

// --- Multi-cutaway resolution -------------------------------------------------

export { remapBrollCuesForCutPlan, resolveBrollCutaways, type ResolvedBrollCutaway, type ResolveBrollCutawaysParams, type ResolveBrollCutaways, type BrollSearch } from "@narriflow/services/broll-plan";
