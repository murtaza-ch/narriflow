import { z } from "zod";
import { logoPositionSchema } from "./logo-position";
import {
  sourceRangeToEdited,
  sourceToEdited,
  type EditedTimeMap,
} from "./edit-ranges";
import type { TranscriptUtterance } from "./transcript";
import { studioSpeakerLayoutOverrideSchema } from "./speaker-layout-overrides";

const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** `.url()` alone accepts any scheme (file://, ftp://, javascript:, ...) — this
 *  refines to http/https only, matching `assertPublicHttpUrl`'s expectations
 *  at render time (packages/services) and the panel's own client-side gate. */
const httpUrlSchema = z.string().url().refine(
  (value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "must be an http(s) URL" },
);

export const studioTextLayerSchema = z
  .object({
    id: z.string().min(1).max(80),
    text: z.string().trim().min(1).max(280),
    startSec: z.number().min(0).default(0),
    endSec: z.number().min(0).nullable().optional(),
    positionX: z.number().min(0).max(100).default(50),
    positionY: z.number().min(0).max(100).default(18),
    fontName: z.string().trim().min(1).max(100).default("Arial"),
    fontSize: z.number().min(8).max(160).default(44),
    color: hexColorSchema.default("#FFFFFF"),
    backgroundColor: hexColorSchema.nullable().optional(),
    backgroundOpacity: z.number().min(0).max(1).default(0.72),
    bold: z.boolean().default(true),
    outlineColor: hexColorSchema.default("#000000"),
    outlineWidth: z.number().min(0).max(8).default(2),
  })
  .refine(
    (layer) => layer.endSec == null || layer.endSec > layer.startSec,
    { message: "endSec must be greater than startSec" },
  );

export const studioTransitionSchema = z.object({
  type: z.enum(["none", "fade", "fade-black", "dip-white"]).default("none"),
  durationSec: z.number().min(0.1).max(2).default(0.4),
});

export const studioMusicSchema = z.object({
  url: z.string().url().nullable().default(null),
  title: z.string().trim().max(120).nullable().default(null),
  volume: z.number().min(0).max(100).default(35),
  startOffsetSec: z.number().min(0).default(0),
  fadeInSec: z.number().min(0).max(5).default(0),
  fadeOutSec: z.number().min(0).max(5).default(0),
  // Music/SFX library (vizard-parity.md "Music/SFX library"): when set,
  // identifies an AudioAsset row and WINS over `url` at render time — the
  // worker resolves the actual audio through
  // `audioAssetService.resolveRenderSource(ownerUserId, assetId)`, never
  // `url`, once this is non-null. `url` doubles as the preview playback URL
  // (populated from the asset's presigned download URL when the user picks
  // one from the library) and stays the escape hatch for pasted links when
  // `assetId` is null.
  assetId: z.string().uuid().nullable().default(null),
  // Auto-ducking v1 (vizard-parity.md): lowers music under detected speech
  // when true. The window/gain math lives in `computeSpeechWindows` /
  // `duckingGainMultiplierAt` below — the SAME functions the worker's timed
  // volume automation and the studio preview's gain node both call, so
  // preview and burn-in can't fork on the ducking curve.
  ducking: z.boolean().default(false),
});

/**
 * Shared fade-window policy for music fades so the browser preview and the
 * worker's afade filters cannot drift: each fade is clamped to the clip
 * duration, and when the two windows would overlap they are scaled down
 * proportionally so fade-in ends before fade-out begins.
 */
export function resolveMusicFadeWindows(
  fadeInSec: number,
  fadeOutSec: number,
  clipDurationSec: number,
): { fadeInSec: number; fadeOutSec: number; fadeOutStartSec: number } {
  const duration = Math.max(0, clipDurationSec);
  let fadeIn = Math.min(Math.max(0, fadeInSec), duration);
  let fadeOut = Math.min(Math.max(0, fadeOutSec), duration);
  const total = fadeIn + fadeOut;
  if (total > duration && total > 0) {
    const scale = duration / total;
    fadeIn *= scale;
    fadeOut *= scale;
  }
  return { fadeInSec: fadeIn, fadeOutSec: fadeOut, fadeOutStartSec: duration - fadeOut };
}

/**
 * Auto-ducking v1 tuning (vizard-parity.md "Music/SFX library"). Tuned to
 * read as natural mixing rather than a hard on/off gate:
 *  - `duckedGainFraction`: how far music drops under speech (0.3 ≈ -10.5dB,
 *    audibly quieter without disappearing).
 *  - `attackSec` / `releaseSec`: ramp durations INTO / OUT OF a duck — see
 *    `duckingGainMultiplierAt` for exactly where these ramps sit relative to
 *    a speech window.
 *  - `mergeGapSec`: speech windows closer together than this merge into one
 *    continuous window, so rapid back-and-forth speech doesn't pump the
 *    music up and down between individual words.
 *  - `padSec`: each word's `[startSec, endSec]` is padded by this much
 *    (both sides) before merging, so ducking doesn't visibly clip the
 *    leading/trailing edge of speech.
 */
export const DUCKING_DEFAULTS = {
  duckedGainFraction: 0.3,
  attackSec: 0.25,
  releaseSec: 0.4,
  mergeGapSec: 0.45,
  padSec: 0.12,
} as const;

export type DuckingOptions = Partial<{
  [Key in keyof typeof DUCKING_DEFAULTS]: number;
}>;

export interface DuckingWindow {
  startSec: number;
  endSec: number;
}

/**
 * Derives merged, padded, clamped speech windows from transcript word
 * timings. This is the shared input to `duckingGainMultiplierAt` for both
 * the worker's timed volume automation and the studio preview's gain node,
 * so they can never fork on "when is someone talking". Pure — sorts a copy,
 * never mutates `words`; returns `[]` for no words or a non-positive
 * duration.
 */
export function computeSpeechWindows(
  words: Array<{ startSec: number; endSec: number }>,
  clipDurationSec: number,
  opts?: DuckingOptions,
): DuckingWindow[] {
  const { mergeGapSec, padSec } = { ...DUCKING_DEFAULTS, ...opts };
  const duration = Math.max(0, clipDurationSec);
  if (words.length === 0 || duration <= 0) return [];

  const padded = words
    .map((word) => ({
      startSec: Math.max(0, word.startSec - padSec),
      endSec: Math.min(duration, word.endSec + padSec),
    }))
    .filter((window) => window.endSec > window.startSec)
    .sort((left, right) => left.startSec - right.startSec);

  const merged: DuckingWindow[] = [];
  for (const window of padded) {
    const last = merged[merged.length - 1];
    if (last && window.startSec - last.endSec <= mergeGapSec) {
      last.endSec = Math.max(last.endSec, window.endSec);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/**
 * Gain multiplier at time `tSec` given merged speech windows: `1` outside
 * every window, `duckedGainFraction` fully inside one, ramping in between.
 *
 * Each window is already padded by `computeSpeechWindows`, so the ramp sits
 * OUTSIDE the window rather than eating into it: gain ramps DOWN across
 * `[startSec - attackSec, startSec]` (before speech starts) and ramps UP
 * across `[endSec, endSec + releaseSec]` (after speech ends). Ramping
 * inward instead — down across the first `attackSec` of the window — would
 * duck the first syllables of every utterance, the opposite of what
 * auto-ducking is for. Overlapping ramp regions from adjacent windows take
 * the MINIMUM multiplier (whichever window wants it quieter wins), so
 * back-to-back speech never audibly "un-ducks" in the gap between them.
 * Pure; returns `1` for empty `windows`.
 */
export function duckingGainMultiplierAt(
  tSec: number,
  windows: DuckingWindow[],
  opts?: DuckingOptions,
): number {
  if (windows.length === 0) return 1;
  const { duckedGainFraction, attackSec, releaseSec } = {
    ...DUCKING_DEFAULTS,
    ...opts,
  };

  let multiplier = 1;
  for (const window of windows) {
    let windowMultiplier: number;
    if (tSec >= window.startSec && tSec <= window.endSec) {
      windowMultiplier = duckedGainFraction;
    } else if (
      attackSec > 0 &&
      tSec >= window.startSec - attackSec &&
      tSec < window.startSec
    ) {
      const progress = (tSec - (window.startSec - attackSec)) / attackSec;
      windowMultiplier = 1 - progress * (1 - duckedGainFraction);
    } else if (
      releaseSec > 0 &&
      tSec > window.endSec &&
      tSec <= window.endSec + releaseSec
    ) {
      const progress = (tSec - window.endSec) / releaseSec;
      windowMultiplier =
        duckedGainFraction + progress * (1 - duckedGainFraction);
    } else {
      windowMultiplier = 1;
    }
    multiplier = Math.min(multiplier, windowMultiplier);
  }
  return multiplier;
}

/**
 * Word-level speech intervals on the EDITED timeline — the shared input to
 * `computeSpeechWindows` for auto-ducking (M1+M2, vizard-parity.md
 * "Music/SFX library"). Lives here (not just in the worker) so the studio
 * PREVIEW's gain node and the worker's timed volume automation derive
 * ducking windows through the exact same pipeline
 * (`extractSpeechWordIntervals` -> `computeSpeechWindows` -> `capDuckingWindows`)
 * instead of each hand-rolling its own version of this extraction — before
 * this move, the preview's own inline `utterances.flatMap(u => u.words)` had
 * no fallback for word-less utterances, so a transcript with no per-word
 * timings ducked at render time but never in the live preview.
 *
 * Deliberately mirrors `generateSrtFromSlice`/`generateAssFromSlice`'s own
 * `timeMap` contract instead of forking a second remap implementation: same
 * `sourceToEdited`/`sourceRangeToEdited` calls, `timeMap` omitted falls back
 * to the plain `clipStartSec` subtraction, and words/utterances that fall
 * entirely inside a deleted range are dropped rather than emitted.
 * Word-level granularity when a transcript has per-word timings (the common
 * case); falls back to one interval per utterance otherwise, same fallback
 * the caption builders use.
 */
export function extractSpeechWordIntervals(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  timeMap?: EditedTimeMap | null,
): Array<{ startSec: number; endSec: number }> {
  const toEdited = (sourceSec: number): number =>
    timeMap ? sourceToEdited(timeMap, sourceSec) : sourceSec - clipStartSec;
  const isVisible = (range: { startSec: number; endSec: number }): boolean =>
    !timeMap || sourceRangeToEdited(timeMap, range) !== null;

  const intervals: Array<{ startSec: number; endSec: number }> = [];
  for (const utterance of utterances) {
    const rawWords = utterance.words;
    if (rawWords.length > 0) {
      const words = timeMap ? rawWords.filter(isVisible) : rawWords;
      for (const word of words) {
        intervals.push({
          startSec: Math.max(0, toEdited(word.startSec)),
          endSec: Math.max(0, toEdited(word.endSec)),
        });
      }
    } else if (isVisible(utterance)) {
      intervals.push({
        startSec: Math.max(0, toEdited(utterance.startSec)),
        endSec: Math.max(0, toEdited(utterance.endSec)),
      });
    }
  }
  return intervals;
}

/**
 * An ffmpeg `volume` expression (built by the worker's
 * `buildDuckingVolumeExpression`) grows one `min(...)` nesting level per
 * speech window. `computeSpeechWindows` already merges windows within
 * `mergeGapSec` of each other, so this only kicks in for pathologically
 * choppy transcripts (many short utterances separated by silences just over
 * `mergeGapSec`) — capped here rather than left unbounded so the filtergraph
 * string ffmpeg has to parse (and the preview's own gain curve, once it
 * uses the same cap) stay bounded regardless of transcript shape.
 */
export const MAX_DUCKING_WINDOWS = 40;

/**
 * Merges the closest-gap adjacent pair of windows repeatedly until at most
 * `maxWindows` remain. Windows are assumed sorted and disjoint (as
 * `computeSpeechWindows` returns them). Merging by smallest gap first —
 * rather than e.g. truncating the tail of the list — keeps every original
 * speech moment covered by SOME window; the cost is that ducking stays "on"
 * through a few extra silent gaps that would otherwise have briefly
 * un-ducked. Pure; a no-op (returns `windows` as-is) when already at or
 * under the cap.
 *
 * M1+M2 (vizard-parity.md "Music/SFX library"): moved here from the
 * worker-only `ducking.ts` so BOTH the worker's render-time volume
 * automation and the studio preview's live gain node apply the identical
 * cap — the worker used to cap alone, so a transcript with more than
 * `MAX_DUCKING_WINDOWS` speech windows ducked differently in the export
 * than in the preview the user actually watched while editing.
 */
export function capDuckingWindows(
  windows: DuckingWindow[],
  maxWindows: number = MAX_DUCKING_WINDOWS,
): DuckingWindow[] {
  if (windows.length <= maxWindows) return windows;
  const merged = windows.map((window) => ({ ...window }));
  while (merged.length > maxWindows) {
    let bestIndex = 0;
    let bestGap = Infinity;
    for (let i = 0; i < merged.length - 1; i++) {
      const gap = merged[i + 1]!.startSec - merged[i]!.endSec;
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }
    merged[bestIndex] = {
      startSec: merged[bestIndex]!.startSec,
      endSec: Math.max(merged[bestIndex]!.endSec, merged[bestIndex + 1]!.endSec),
    };
    merged.splice(bestIndex + 1, 1);
  }
  return merged;
}

export const studioSourceAudioSchema = z.object({
  volume: z.number().int().min(0).max(100).default(100),
  muted: z.boolean().default(false),
});

// Per-clip logo overrides (vizard-parity.md Phase A step 6). The PROJECT
// brand snapshot (`brandTemplateSnapshotSchema`) stays the source of truth
// for the logo ASSET (`logoStorageKey`) — this only overrides how it's
// shown on THIS clip. `null` on position/opacity/scalePct means "inherit
// the snapshot value"; `enabled: false` turns the logo off for this clip
// regardless of what the snapshot says. See
// `resolveEffectiveLogoSettings` in logo-overlay.ts for the merge, shared
// by the worker (burn-in) and the studio preview overlay so they can't fork.
export const studioLogoSchema = z.object({
  enabled: z.boolean().default(true),
  position: logoPositionSchema.nullable().default(null),
  opacity: z.number().int().min(10).max(100).nullable().default(null),
  scalePct: z.number().int().min(5).max(40).nullable().default(null),
});

const STUDIO_LOGO_DEFAULT = {
  enabled: true,
  position: null,
  opacity: null,
  scalePct: null,
} as const;

// Per-clip canvas background (vizard-parity.md Phase C item 2): when enabled,
// the source video letterboxes ("fit" — scale + pad) instead of cropping to
// fill, and the empty frame area shows a solid color or an image behind it.
// "off" (the default) preserves today's crop-to-fill behavior everywhere —
// the studio preview's cosmetic `layoutMode` local state (fill/fit/blur,
// video-preview.tsx) is left untouched when this is off, and only overridden
// once a mode is actually chosen here. `color`/`imageUrl` are independent of
// `mode` so switching modes back and forth doesn't lose the user's last pick;
// `color: null` is treated as black (both by the worker's pad filter and the
// preview's stage background) and `imageUrl: null`/invalid falls back to
// color/black the same way on both sides.
export const studioBackgroundSchema = z.object({
  mode: z.enum(["off", "color", "image"]).default("off"),
  color: hexColorSchema.nullable().default(null),
  imageUrl: httpUrlSchema.nullable().default(null),
});

const STUDIO_BACKGROUND_DEFAULT = {
  mode: "off",
  color: null,
  imageUrl: null,
} as const;

// Per-clip framing intent. "fit" is deliberately derived from
// `background.mode !== "off"` rather than duplicated here. Split and Screen
// are resolved exclusively through the shared Clip Composition Plan: the
// worker supplies identity-bound evidence, the planner owns exact per-target
// geometry and typed fallbacks, and Studio plus FFmpeg consume the same plan.
export const studioFramingSchema = z.object({
  mode: z.enum(["auto", "center", "split", "screen"]).default("auto"),
});

const STUDIO_FRAMING_DEFAULT = { mode: "auto" } as const;

const STUDIO_MUSIC_DEFAULT = {
  url: null,
  title: null,
  volume: 35,
  startOffsetSec: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  assetId: null,
  ducking: false,
} as const;

// One-shot SFX placement (vizard-parity.md "Music/SFX library"): plays once
// from `startSec` — EDITED-timeline seconds, the same convention as
// `studioTextLayerSchema.startSec` — never loops, and is truncated at clip
// end by the render pipeline. `assetId` references an AudioAsset row of
// kind "sfx"; `title` is a display-only cache of the asset's title at
// placement time (nullable — the panel falls back to a lookup if absent)
// so the timeline doesn't need a join just to render a label.
export const studioSfxPlacementSchema = z.object({
  id: z.string().min(1).max(80),
  assetId: z.string().uuid(),
  title: z.string().trim().max(120).nullable().default(null),
  startSec: z.number().min(0),
  volume: z.number().min(0).max(100).default(80),
});

export const studioEditsSchema = z
  .object({
    textLayers: z.array(studioTextLayerSchema).max(12).default([]),
    transition: studioTransitionSchema.default({
      type: "none",
      durationSec: 0.4,
    }),
    music: studioMusicSchema.default(STUDIO_MUSIC_DEFAULT),
    sourceAudio: studioSourceAudioSchema.default({ volume: 100, muted: false }),
    logo: studioLogoSchema.default(STUDIO_LOGO_DEFAULT),
    background: studioBackgroundSchema.default(STUDIO_BACKGROUND_DEFAULT),
    framing: studioFramingSchema.default(STUDIO_FRAMING_DEFAULT),
    speakerLayoutOverrides: z
      .array(studioSpeakerLayoutOverrideSchema)
      .max(64)
      .default([]),
    sfx: z.array(studioSfxPlacementSchema).max(20).default([]),
  })
  .default({
    textLayers: [],
    transition: { type: "none", durationSec: 0.4 },
    music: STUDIO_MUSIC_DEFAULT,
    sourceAudio: { volume: 100, muted: false },
    logo: STUDIO_LOGO_DEFAULT,
    background: STUDIO_BACKGROUND_DEFAULT,
    framing: STUDIO_FRAMING_DEFAULT,
    speakerLayoutOverrides: [],
    sfx: [],
  });

export const updateClipStudioEditsSchema = z.object({
  studioEdits: studioEditsSchema,
});

export type StudioTextLayer = z.infer<typeof studioTextLayerSchema>;
export type StudioTransition = z.infer<typeof studioTransitionSchema>;
export type StudioMusic = z.infer<typeof studioMusicSchema>;
export type StudioSourceAudio = z.infer<typeof studioSourceAudioSchema>;
export type StudioLogo = z.infer<typeof studioLogoSchema>;
export type StudioBackground = z.infer<typeof studioBackgroundSchema>;
export type StudioFraming = z.infer<typeof studioFramingSchema>;
export type { StudioSpeakerLayoutOverride, SpeakerLayerTransform } from "./speaker-layout-overrides";
export type StudioSfxPlacement = z.infer<typeof studioSfxPlacementSchema>;
export type StudioEdits = z.infer<typeof studioEditsSchema>;
export type UpdateClipStudioEdits = z.infer<typeof updateClipStudioEditsSchema>;

export type EffectiveFramingMode = "auto" | "center" | "fit" | "split" | "screen";

/**
 * The single source of truth for "how is this clip actually framed" —
 * folds `background` and `framing` into one of five effective modes so the
 * worker's render pipeline and the studio's Layout panel/preview can never
 * fork on the answer. `background.mode !== "off"` always wins as "fit"
 * regardless of `framing.mode` — including when `framing.mode === "split"`
 * or `"screen"`: a user picking Split/Screen in the panel also turns
 * background off via the same choice handler that Auto/Center use (see
 * layout-panel.tsx's `setFramingChoice`), so in practice "fit" never
 * coexists with either, but the precedence rule here is unconditional
 * either way. Fit isn't a `framing` enum value (see `studioFramingSchema`'s
 * doc comment), it's derived entirely from `background`. Only when
 * background is off does `framing.mode` (auto vs center vs split vs screen)
 * take effect.
 */
export function resolveEffectiveFramingMode(
  studioEdits: Pick<StudioEdits, "background" | "framing">,
): EffectiveFramingMode {
  if (studioEdits.background.mode !== "off") return "fit";
  return studioEdits.framing.mode;
}

/**
 * "Apply to all clips" for a single `studioEdits` sub-field (vizard-parity.md
 * Phase C — transitions/background/framing apply-to-all). Unlike
 * `captionPreset`, `studioEdits` is a JSON blob, so a bulk apply can't
 * overwrite the whole column — it must patch exactly one named sub-object
 * per call, merged per-row on top of that clip's existing `studioEdits` by
 * the service. The `.strict()` + refine keeps the payload to precisely one
 * of the known fields; add a new branch here (and in
 * `applyStudioEditsPatchToAllClips`) when another sub-field earns an
 * apply-to-all action.
 */
export const applyStudioEditsPatchSchema = z
  .object({
    transition: studioTransitionSchema.optional(),
    background: studioBackgroundSchema.optional(),
    framing: studioFramingSchema.optional(),
  })
  .strict()
  .refine(
    (patch) =>
      [patch.transition, patch.background, patch.framing].filter(
        (value) => value !== undefined,
      ).length === 1,
    { message: "patch must contain exactly one of: transition, background, framing" },
  );

export type ApplyStudioEditsPatch = z.infer<typeof applyStudioEditsPatchSchema>;

/**
 * Request body for `POST /projects/:id/clips/apply-studio-edits`.
 * `excludeClipId` lets the studio session that originated the patch skip
 * itself server-side — that clip already has the change applied locally
 * (undoable, via the open editor document) and will persist it through the
 * normal revision-guarded autosave; including it in the bulk write would
 * bump its `editorRevision` out from under the client's in-flight
 * `baseRevision` and 409 the next autosave.
 */
export const applyStudioEditsToAllSchema = z.object({
  patch: applyStudioEditsPatchSchema,
  excludeClipId: z.string().uuid().optional(),
});

export type ApplyStudioEditsToAll = z.infer<typeof applyStudioEditsToAllSchema>;
