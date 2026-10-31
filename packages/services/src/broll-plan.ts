import { selectBestPexelsVideo, type BrollAttribution, type BrollClip } from "./pexels-contract";
import { isSourceTimeDeleted, sourceToEdited, planBrollCutaways, type BrollCueInput, type PexelsOrientation, type PlannedBrollCutaway, type ClipCutPlan } from "@narriflow/validators";

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
  /** Forwarded only by a provider adapter; no provider access is created here. */
  fetchImpl?: typeof fetch;
}

// Below this, a cutaway clamped to a short asset's real duration is no longer
// worth showing (matches the single-cutaway path's existing 1.2s floor).
const MIN_CUTAWAY_SEC_AFTER_ASSET_CLAMP = 1.2;

async function resolveSlotAsset(
  slot: PlannedBrollCutaway,
  params: ResolveBrollCutawaysParams,
  searchPexelsVideos: BrollSearch,
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
  searchPexelsVideos: BrollSearch,
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
      const picked = await resolveSlotAsset(slot, params, searchPexelsVideos);
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

export type ResolveBrollCutaways = (params: ResolveBrollCutawaysParams) => Promise<ResolvedBrollCutaway[]>;
export type BrollSearch = (query: string, orientation: PexelsOrientation, options: { fetchImpl?: typeof fetch }) => Promise<import("./pexels-contract").PexelsVideo[]>;
