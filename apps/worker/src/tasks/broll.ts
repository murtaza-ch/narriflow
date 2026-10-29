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
  searchPexelsVideos,
  selectBestPexelsVideo,
  type BrollAttribution,
  type BrollClip,
} from "@narriflow/services";
import {
  brollQueryForClip,
  dominantPexelsOrientation,
  isSourceTimeDeleted,
  pexelsOrientationForAspectRatio,
  planBrollCutaways,
  planBrollWindow,
  sourceToEdited,
} from "@narriflow/validators";
import type {
  BrollCueInput,
  PexelsOrientation,
  PlannedBrollCutaway,
} from "@narriflow/validators";
import type { ClipCutPlan } from "./cut-plan";

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
  searchPexelsVideos,
  selectBestPexelsVideo,
};
export type { BrollCueInput, PexelsOrientation, PlannedBrollCutaway };
export type { BrollAttribution, BrollClip } from "@narriflow/services";

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

export interface ResolvedBrollCutaway {
  startSec: number;
  endSec: number;
  query: string;
  downloadUrl: string;
  assetDurationSec: number;
  attribution: BrollAttribution;
}

export interface ResolveBrollCutawaysParams {
  clipDurationSec: number;
  cues: BrollCueInput[] | null | undefined;
  fallbackQuery: string | null;
  /** Tried only when a slot's own query returns zero results. */
  broaderFallbackQuery: string | null;
  orientation: PexelsOrientation;
  targetWidth: number;
  targetHeight: number;
  /** Test-only: injected fetch implementation, forwarded to searchPexelsVideos. */
  fetchImpl?: typeof fetch;
}

// Below this, a cutaway clamped to a short asset's real duration is no longer
// worth showing (matches the single-cutaway path's existing 1.2s floor).
const MIN_CUTAWAY_SEC_AFTER_ASSET_CLAMP = 1.2;

async function resolveSlotAsset(
  slot: PlannedBrollCutaway,
  params: ResolveBrollCutawaysParams,
): Promise<BrollClip | null> {
  let videos = await searchPexelsVideos(slot.query, params.orientation, {
    fetchImpl: params.fetchImpl,
  });

  if (
    videos.length === 0 &&
    params.broaderFallbackQuery &&
    params.broaderFallbackQuery.trim().toLowerCase() !== slot.query.trim().toLowerCase()
  ) {
    videos = await searchPexelsVideos(params.broaderFallbackQuery, params.orientation, {
      fetchImpl: params.fetchImpl,
    });
  }

  if (videos.length === 0) return null;
  // Use the same floor as the post-clamp validity check below (not
  // selectBestPexelsVideo's own 2s default, which is tuned for the
  // single-cutaway manual-pick path): a video between
  // MIN_CUTAWAY_SEC_AFTER_ASSET_CLAMP and 2s can still produce a valid,
  // if short, clamped cutaway and shouldn't be rejected before that check
  // even runs.
  return selectBestPexelsVideo(
    videos,
    params.targetWidth,
    params.targetHeight,
    MIN_CUTAWAY_SEC_AFTER_ASSET_CLAMP,
  );
}

/**
 * Remaps LLM-provided B-roll cue timestamps (`clip.brollCues[].atSec`, which
 * are clip-relative seconds on the UNCUT source timeline — see
 * `packages/validators/src/broll.ts` `BrollCueInput`) onto the edited
 * (post-cut) timeline that `planBrollCutaways` actually places cutaways
 * against once `deletedRanges` are in play (multi-model review fix #2).
 * Without this, `resolveBrollCutaways` receives cue timestamps in the wrong
 * time base and cutaways land on the wrong moment in the rendered output —
 * or, when a cue's original moment was itself deleted, on content that no
 * longer exists at all.
 *
 * `clipStartSec` converts the clip-relative `atSec` into the source-absolute
 * seconds `cutPlan.map` expects. Cues whose source instant falls inside a
 * deleted range are dropped rather than remapped onto the cut point (a
 * deleted moment has no "intended" content to cut away to). A no-op
 * (returns `cues` unchanged) when the clip is uncut, matching every other
 * cut-concat consumer's byte-identical-common-case contract.
 */
export function remapBrollCuesForCutPlan(
  cues: BrollCueInput[] | null | undefined,
  cutPlan: ClipCutPlan,
  clipStartSec: number,
): BrollCueInput[] | null | undefined {
  if (!cues || cutPlan.isUncut) return cues;
  const remapped: BrollCueInput[] = [];
  for (const cue of cues) {
    const sourceSec = clipStartSec + cue.atSec;
    if (isSourceTimeDeleted(cutPlan.map, sourceSec)) continue;
    remapped.push({ ...cue, atSec: sourceToEdited(cutPlan.map, sourceSec) });
  }
  return remapped;
}

/**
 * Plans B-roll cutaway time windows for a clip (`planBrollCutaways`) and
 * resolves each one to an actual Pexels asset: searches the slot's own query,
 * broadening to `broaderFallbackQuery` when that specific query returns
 * nothing, then picks the best-matching video for the target frame. Each
 * resolved window is clamped (shrunk from the end only — the plan's ordering
 * and gaps are never violated) to the chosen asset's own duration, since a
 * cutaway can never outlast the footage backing it.
 *
 * Slots that fail entirely (no results even after broadening, or the asset is
 * too short to clear the minimum cutaway length) are dropped rather than
 * failing the whole clip — a partial plan (e.g. 2 of 3 cutaways resolved) is
 * normal, best-effort behavior, exactly like a single failed B-roll pick has
 * always degraded to "render without it."
 */
export async function resolveBrollCutaways(
  params: ResolveBrollCutawaysParams,
): Promise<ResolvedBrollCutaway[]> {
  const slots = planBrollCutaways(
    params.clipDurationSec,
    params.cues,
    params.fallbackQuery,
  );
  if (slots.length === 0) return [];

  const resolved: ResolvedBrollCutaway[] = [];

  for (const slot of slots) {
    try {
      const picked = await resolveSlotAsset(slot, params);
      if (!picked) continue;

      const maxEnd = slot.startSec + picked.durationSec;
      const clampedEnd = Math.min(slot.endSec, maxEnd);
      if (clampedEnd - slot.startSec < MIN_CUTAWAY_SEC_AFTER_ASSET_CLAMP) continue;

      resolved.push({
        startSec: slot.startSec,
        endSec: Number(clampedEnd.toFixed(2)),
        query: slot.query,
        downloadUrl: picked.downloadUrl,
        assetDurationSec: picked.durationSec,
        attribution: picked.attribution,
      });
    } catch {
      // One bad slot (a transient failure that survived retries, an
      // unexpected parse error, etc.) must never take down the other
      // cutaways or the render itself.
    }
  }

  return resolved;
}
