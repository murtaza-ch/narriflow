import { z } from "zod";
import type { ClipAspectRatio } from "./clip";
import type { ClipCategory } from "./clip";

/**
 * Shared, dependency-free B-roll logic used by BOTH the worker's render
 * pipeline (`apps/worker/src/tasks/broll.ts`) and the studio B-roll panel
 * (`apps/web/.../tool-panels/broll-panel.tsx`), so the "what will actually
 * happen at render time" preview shown to the user in the studio is computed
 * by the exact same code that runs at render time — never a re-implementation
 * that can drift.
 *
 * Nothing here does network/file IO — that stays in the worker task and the
 * services layer so this module is safe to import from a client component.
 */

// --- LLM-cued B-roll placement -------------------------------------------

/**
 * One B-roll cutaway suggestion from the clip-detection LLM call. Optional on
 * the detection response/DB row so existing clips (and any concurrently
 * in-flight schema changes) keep working — see broll.ts/render-clips.ts,
 * which fall back to the keyword query path whenever cues are absent.
 */
export const brollCueSchema = z.object({
  atSec: z.number().min(0),
  query: z.string().trim().min(1).max(80),
  reason: z.string().trim().max(240).optional(),
});
export type BrollCue = z.infer<typeof brollCueSchema>;

export const brollCuesArraySchema = z.array(brollCueSchema).max(6);
export type BrollCues = z.infer<typeof brollCuesArraySchema>;

// --- Pexels orientation -----------------------------------------------------

export const pexelsOrientationSchema = z.enum([
  "portrait",
  "landscape",
  "square",
]);
export type PexelsOrientation = z.infer<typeof pexelsOrientationSchema>;

const ORIENTATION_BY_ASPECT_RATIO: Record<ClipAspectRatio, PexelsOrientation> = {
  "9:16": "portrait",
  "4:5": "portrait",
  "1:1": "square",
  "16:9": "landscape",
};

/** Correct aspect-ratio -> Pexels orientation mapping (fixes 1:1 resolving to landscape). */
export function pexelsOrientationForAspectRatio(
  aspectRatio: ClipAspectRatio,
): PexelsOrientation {
  return ORIENTATION_BY_ASPECT_RATIO[aspectRatio] ?? "portrait";
}

/**
 * Picks the orientation to search for when a clip renders multiple aspect
 * ratios at once: majority vote across outputs, ties broken toward portrait
 * (the common case for social clips). Previously this was inlined in
 * render-clips.ts as a portrait-vs-landscape binary that silently dropped
 * "square" — a 1:1-only render always resolved to landscape.
 */
export function dominantPexelsOrientation(
  aspectRatios: ClipAspectRatio[],
): PexelsOrientation {
  const counts: Record<PexelsOrientation, number> = {
    portrait: 0,
    landscape: 0,
    square: 0,
  };
  for (const ratio of aspectRatios) {
    counts[pexelsOrientationForAspectRatio(ratio)] += 1;
  }
  let best: PexelsOrientation = "portrait";
  for (const candidate of ["portrait", "square", "landscape"] as const) {
    if (counts[candidate] > counts[best]) best = candidate;
  }
  return best;
}

// --- Query derivation --------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "for", "in", "on", "at",
  "with", "from", "by", "as", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they",
  "my", "your", "our", "their", "how", "why", "what", "when", "where", "who",
  "do", "does", "did", "can", "could", "should", "would", "will", "just", "so",
  "not", "no", "yes", "if", "then", "than", "about", "into", "out", "up", "down",
  "get", "got", "very", "really", "like", "one", "more", "most", "some", "all",
]);

/**
 * Hyperbolic/abstract "hook framing" words common in clickbait titles.
 * Stripped before building a visual search query because they either carry no
 * concrete visual meaning ("mistakes", "secrets", "hacks") or map to literally
 * unsafe stock footage when taken at face value — e.g. "5 Mistakes That Are
 * Killing Your Ads" naively reduces to "mistakes killing ads", which matches
 * real violence footage on Pexels.
 */
const HOOK_FRAMING_WORDS = new Set([
  "mistake", "mistakes", "secret", "secrets", "hack", "hacks", "trick", "tricks",
  "tip", "tips", "way", "ways", "reason", "reasons", "thing", "things",
  "kill", "kills", "killing", "killed",
  "crush", "crushes", "crushing", "crushed",
  "destroy", "destroys", "destroying", "destroyed",
  "wreck", "wrecks", "wrecking", "wrecked",
  "ruin", "ruins", "ruining", "ruined",
  "explode", "explodes", "exploding", "exploded",
  "break", "breaks", "breaking", "broke", "broken",
  "dominate", "dominates", "dominating", "dominated",
  "murder", "murders", "murdering", "murdered",
  "slaughter", "slaughters", "slaughtering", "slaughtered",
  "attack", "attacks", "attacking", "attacked",
  "war", "fight", "fights", "fighting", "fought",
  "blood", "bloody", "violent", "violence",
  "die", "dies", "dying", "died", "death", "deadly",
  "danger", "dangerous", "brutal", "savage",
  "nuke", "nukes", "nuking", "bomb", "bombs", "bombing",
  "weapon", "weapons", "gun", "guns", "shoot", "shoots", "shooting",
]);

/**
 * Generic, safe, visually concrete search fallback per clip category — used
 * only when a clip's title/hook reduces to nothing usable (all stopwords/
 * hook-framing words), so a clip never silently gets zero B-roll just because
 * its title happened to be abstract.
 */
export const CATEGORY_BROLL_FALLBACK_QUERY: Record<ClipCategory, string> = {
  hook: "city skyline morning",
  insight: "person thinking notebook",
  story: "storytelling warm light",
  humor: "friends laughing together",
  controversy: "people discussing debate",
  emotional: "quiet emotional moment",
  tutorial: "hands typing laptop",
  quote: "notebook pen writing",
  debate: "conversation across table",
  surprise: "surprised reaction people",
};

/**
 * Derives a short visual search query from a clip's title (preferred) or hook
 * text: strips stopwords/punctuation/numbers/hook-framing words and keeps up
 * to 4 remaining meaningful words. Falls back to a category-based generic
 * query when nothing usable remains (rather than silently returning no B-roll
 * at all); returns null only when there's truly nothing to go on.
 */
export function brollQueryForClip(
  title: string | null | undefined,
  hookText: string | null | undefined,
  category?: ClipCategory | null,
): string | null {
  const source = (title && title.trim()) || (hookText && hookText.trim()) || "";

  const words = source
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .filter((w) => !/^\d+$/.test(w))
    .filter((w) => !STOPWORDS.has(w))
    .filter((w) => !HOOK_FRAMING_WORDS.has(w));

  if (words.length > 0) {
    return words.slice(0, 4).join(" ");
  }

  if (category && CATEGORY_BROLL_FALLBACK_QUERY[category]) {
    return CATEGORY_BROLL_FALLBACK_QUERY[category];
  }

  return null;
}

// --- Placement: single window (manual/studio pick) --------------------------

/** Stable identity used only by the one URL-backed manual B-roll placement. */
export const MANUAL_BROLL_COMPOSITION_ID = "manual-url";

/**
 * The persisted motion request cannot depend on browser-only or worker-probed
 * media metadata. Give the URL-backed target one deterministic window derived
 * from the edited source duration; the composition planner clamps that request
 * when a short optional asset resolves to a smaller active range.
 */
export function manualBrollMotionWindow(
	editedDurationSec: number,
): { startSec: number; endSec: number } | null {
	return planBrollWindow(editedDurationSec, 3.5);
}

export function activeManualBrollMotionWindow(input: {
	brollUrl: string | null | undefined;
	assetBackedPlacementCount: number;
	editedDurationSec: number;
}): { startSec: number; endSec: number } | null {
	return input.brollUrl && input.assetBackedPlacementCount === 0
		? manualBrollMotionWindow(input.editedDurationSec)
		: null;
}

/**
 * Plans a single B-roll cutaway window inside the clip: a short segment placed
 * after the hook, bounded by a *specific* asset's own duration. Used for the
 * studio's manual B-roll pick, which stays a single cutaway by design — a user
 * who explicitly chose one clip didn't ask to see it repeated 2-4 times.
 * Returns null if the clip is too short to be worth it.
 */
export function planBrollWindow(
  clipDurationSec: number,
  brollDurationSec: number,
  options: { minClipSec?: number; cutawaySec?: number } = {},
): { startSec: number; endSec: number } | null {
  const minClipSec = options.minClipSec ?? 12;
  const cutawaySec = options.cutawaySec ?? 3.5;
  if (clipDurationSec < minClipSec || brollDurationSec <= 0) return null;

  // Start ~28% in (after the hook), never in the first 4s or last 3s.
  const start = Math.max(4, Math.min(clipDurationSec * 0.28, clipDurationSec - 6));
  const maxLen = Math.min(cutawaySec, brollDurationSec, clipDurationSec - start - 3);
  if (maxLen < 1.2) return null;
  return { startSec: Number(start.toFixed(2)), endSec: Number((start + maxLen).toFixed(2)) };
}

// --- Placement: multiple cutaways (auto path, cue-driven) --------------------

export interface BrollCueInput {
  atSec: number;
  query: string;
  reason?: string;
}

export interface PlannedBrollCutaway {
  startSec: number;
  endSec: number;
  query: string;
  reason?: string;
}

export interface PlanBrollCutawaysOptions {
  /** Below this clip duration, no cutaways at all. Default 12. */
  minClipSec?: number;
  /** Never start a cutaway before this many seconds in (the hook). Default 2. */
  hookSec?: number;
  /** Never let a cutaway run within this many seconds of the clip end. Default 2. */
  tailSec?: number;
  /** Shortest allowed cutaway. Default 2. */
  minCutawaySec?: number;
  /** Longest allowed cutaway. Default 4. */
  maxCutawaySec?: number;
  /** Minimum gap between the end of one cutaway and the start of the next. Default 1.5. */
  minGapSec?: number;
  /** Hard cap on cutaway count regardless of duration/cues. Default 4. */
  maxCutaways?: number;
}

/** Scales the cutaway count with clip length: longer clips can carry more inserts. */
function durationCutawayCap(clipDurationSec: number): number {
  if (clipDurationSec < 12) return 0;
  if (clipDurationSec < 24) return 2;
  if (clipDurationSec < 45) return 3;
  return 4;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Plans 2-4 short B-roll cutaways across a clip (never exactly one — a lone
 * cutaway reads as accidental). Rules enforced unconditionally regardless of
 * input: never during the hook, never overlapping, a minimum gap between
 * cutaways, each cutaway 2-4s (bounded by `minCutawaySec`/`maxCutawaySec`),
 * and never running past the clip end.
 *
 * When `cues` (from the clip-detection LLM call) are present, their `atSec`
 * timestamps drive placement, deduplicating cues that land too close together.
 * When absent, up to `durationCutawayCap(clipDurationSec)` cutaways are spaced
 * evenly across the clip using `fallbackQuery` for all of them (the current
 * keyword-derived query path). Returns [] when the clip is too short or
 * neither cues nor a fallback query are available.
 */
export function planBrollCutaways(
  clipDurationSec: number,
  cues: BrollCueInput[] | null | undefined,
  fallbackQuery: string | null,
  options: PlanBrollCutawaysOptions = {},
): PlannedBrollCutaway[] {
  const hookSec = options.hookSec ?? 2;
  const tailSec = options.tailSec ?? 2;
  const minCutawaySec = options.minCutawaySec ?? 2;
  const maxCutawaySec = options.maxCutawaySec ?? 4;
  const minGapSec = options.minGapSec ?? 1.5;
  const maxCutaways = options.maxCutaways ?? 4;
  const minClipSec = options.minClipSec ?? 12;

  if (!Number.isFinite(clipDurationSec) || clipDurationSec < minClipSec) {
    return [];
  }

  const safeStart = hookSec;
  const safeEnd = clipDurationSec - tailSec;
  if (safeEnd - safeStart < minCutawaySec) return [];

  const availableSec = safeEnd - safeStart;
  const capacityByRoom = Math.floor(
    (availableSec + minGapSec) / (minCutawaySec + minGapSec),
  );
  const cap = Math.max(
    0,
    Math.min(maxCutaways, capacityByRoom, durationCutawayCap(clipDurationSec)),
  );
  if (cap <= 0) return [];

  const validCues = (cues ?? [])
    .filter((cue) => Boolean(cue.query?.trim()))
    .filter((cue) => cue.atSec >= safeStart && cue.atSec <= safeEnd)
    .sort((a, b) => a.atSec - b.atSec);

  const centers: Array<{ atSec: number; query: string; reason?: string }> = [];

  if (validCues.length > 0) {
    for (const cue of validCues) {
      if (centers.length >= cap) break;
      const last = centers[centers.length - 1];
      // Drop cues that land too close to the previous chosen cue — avoids
      // near-duplicate back-to-back cutaways from clustered cues.
      if (last && cue.atSec - last.atSec < minCutawaySec + minGapSec) continue;
      centers.push({ atSec: cue.atSec, query: cue.query.trim(), reason: cue.reason });
    }
  } else if (fallbackQuery) {
    // Evenly space `cap` cutaways across the safe zone.
    const step = availableSec / (cap + 1);
    for (let i = 1; i <= cap; i++) {
      centers.push({ atSec: safeStart + step * i, query: fallbackQuery });
    }
  }

  const plans: PlannedBrollCutaway[] = [];
  for (const center of centers) {
    let start = Math.max(safeStart, center.atSec - maxCutawaySec / 2);
    const prev = plans[plans.length - 1];
    if (prev && start - prev.endSec < minGapSec) {
      start = prev.endSec + minGapSec;
    }
    const end = Math.min(safeEnd, start + maxCutawaySec);
    if (end - start < minCutawaySec) continue; // no room left for this slot
    plans.push({
      startSec: round2(start),
      endSec: round2(end),
      query: center.query,
      reason: center.reason,
    });
  }

  return plans;
}
