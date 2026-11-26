import { z } from "zod";
import {
  CAPTION_EMPHASIS_OVERRIDE_LIMIT,
  captionEmphasisOverrideSchema,
  captionWordKeySchema,
  type CaptionEmphasisOverride,
} from "./caption-emphasis";
import {
  CAPTION_EMOJI_LIMIT,
  captionEmojisSchema,
  type CaptionEmojiRef,
} from "./caption-emojis";
import { logoPositionSchema } from "./logo-position";
import {
  sourceRangeToEdited,
  sourceToEdited,
  type EditedTimeMap,
} from "./edit-ranges";
import type { TranscriptUtterance } from "./transcript";
import {
  speakerLayoutOverridesEqual,
  studioSpeakerLayoutOverrideSchema,
} from "./speaker-layout-overrides";
import { brandFontReferenceSchema, visualAssetReferenceSchema } from "./timed-edits";
import {
  sceneLayoutSelectionsEqual,
  studioSceneLayoutSelectionsSchema,
} from "./scene-layouts";

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

/** Per-clip caps on Studio Edits. The document schema enforces them and the
 *  Studio panels read the same values, so the editor can't build a document
 *  its save would refuse. */
export const STUDIO_EDIT_LIMITS = {
  textLayers: 12,
  textLayerChars: 280,
  sfx: 20,
  visualBroll: 20,
  musicBlocks: 12,
} as const;

export const studioTextLayerSchema = z
  .object({
    id: z.string().min(1).max(80),
    text: z.string().trim().min(1).max(STUDIO_EDIT_LIMITS.textLayerChars),
    startSec: z.number().min(0).default(0),
    endSec: z.number().min(0).nullable().optional(),
    positionX: z.number().min(0).max(100).default(50),
    positionY: z.number().min(0).max(100).default(18),
    fontName: z.string().trim().min(1).max(100).default("Arial"),
    fontAsset: brandFontReferenceSchema.nullable().optional(),
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

export const CLIP_TRANSITION_TYPES = [
  "none",
  "fade",
  "fade-black",
  "dip-white",
  "wipe-left",
  "wipe-right",
  "wipe-up",
  "wipe-down",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "zoom-in",
  "zoom-out",
] as const;

export const studioTransitionSchema = z.object({
  type: z.enum(CLIP_TRANSITION_TYPES).default("none"),
  durationSec: z.number().min(0.1).max(2).default(0.4),
});

/** Shortest Music Block the Studio can make by trimming or splitting. */
export const MUSIC_BLOCK_MIN_DURATION_SEC = 0.5;

/**
 * A Music Block: one stretch of a music track on the clip's music lane.
 *
 * `startSec`/`endSec` are EDITED-timeline seconds, the same convention as
 * `studioTextLayerSchema` and `studioSfxPlacementSchema`; `endSec: null`
 * means "until the clip ends", so a full-length bed survives trims. The
 * renderer clamps a block to the clip and skips one that starts at or past
 * the end. `sourceStartSec` is the in-point inside the track: the block
 * plays the track from there and loops it when the block outlasts it.
 *
 * `assetId` identifies an AudioAsset row and wins over `url` at render time
 * (the worker resolves it through `audioAssetService.resolveRenderSource`).
 * `url` doubles as the preview playback hint and stays the escape hatch for
 * pasted links when `assetId` is null. `title` is a display-only cache.
 */
export const studioMusicBlockSchema = z
  .object({
    id: z.string().min(1).max(80),
    assetId: z.string().uuid().nullable().default(null),
    url: httpUrlSchema.nullable().default(null),
    title: z.string().trim().max(120).nullable().default(null),
    startSec: z.number().finite().min(0),
    endSec: z.number().finite().min(0).nullable().default(null),
    sourceStartSec: z.number().finite().min(0).default(0),
    volume: z.number().min(0).max(100).default(35),
    fadeInSec: z.number().min(0).max(5).default(0),
    fadeOutSec: z.number().min(0).max(5).default(0),
  })
  .refine((block) => block.assetId !== null || block.url !== null, {
    message: "a music block needs an assetId or a url",
    path: ["assetId"],
  })
  .refine((block) => block.endSec === null || block.endSec > block.startSec, {
    message: "endSec must be greater than startSec",
    path: ["endSec"],
  });

/**
 * The clip's music lane: Music Blocks that never overlap, plus the
 * clip-wide auto-ducking switch. Blocks are stored in timeline order; only
 * the last block may run to the clip end (`endSec: null`).
 *
 * Auto-ducking (vizard-parity.md) lowers every block under detected speech.
 * The window/gain math lives in `computeSpeechWindows` /
 * `duckingGainMultiplierAt` below, the SAME functions the worker's timed
 * volume automation and the Studio preview both call.
 */
export const studioMusicSchema = z
  .object({
    blocks: z.array(studioMusicBlockSchema).max(STUDIO_EDIT_LIMITS.musicBlocks).default([]),
    ducking: z.boolean().default(false),
  })
  .superRefine((music, context) => {
    if (new Set(music.blocks.map((block) => block.id)).size !== music.blocks.length) {
      context.addIssue({ code: "custom", path: ["blocks"], message: "music block ids must be unique" });
    }
    music.blocks.forEach((block, index) => {
      const next = music.blocks[index + 1];
      if (!next) return;
      if (block.endSec === null || block.endSec > next.startSec) {
        context.addIssue({
          code: "custom",
          path: ["blocks", index],
          message: "music blocks must be in timeline order and cannot overlap",
        });
      }
    });
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

const STUDIO_MUSIC_DEFAULT: z.output<typeof studioMusicSchema> = {
  blocks: [],
  ducking: false,
};

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

export const studioVisualBrollPlacementSchema = z.strictObject({
  id: z.string().uuid(),
  asset: visualAssetReferenceSchema,
  startSec: z.number().finite().min(0).max(60 * 60 * 12),
  endSec: z.number().finite().min(0).max(60 * 60 * 12),
  fit: z.enum(["cover", "contain"]),
}).refine((placement) => placement.endSec > placement.startSec, {
  message: "endSec must be greater than startSec",
  path: ["endSec"],
});

/**
 * Caption emphasis overrides by Word Key (a word's source start in whole
 * milliseconds). Overrides whose key matches no word are kept and ignored.
 */
export const studioCaptionEmphasisSchema = z
  .record(captionWordKeySchema, captionEmphasisOverrideSchema)
  .refine((overrides) => Object.keys(overrides).length <= CAPTION_EMPHASIS_OVERRIDE_LIMIT, {
    message: `at most ${CAPTION_EMPHASIS_OVERRIDE_LIMIT} caption emphasis overrides`,
  });

/** Most captions a clip can hold merged by hand. */
export const CAPTION_MERGE_LIMIT = 2000;

/**
 * Captions merged by hand: by the Word Key of a caption's first word, the Word Key of its last.
 * The cue grouping keeps the words from one to the other in one caption (both in one utterance);
 * an entry whose words are gone is kept and ignored.
 */
export const studioCaptionMergesSchema = z
  .record(captionWordKeySchema, captionWordKeySchema)
  .refine((merges) => Object.keys(merges).length <= CAPTION_MERGE_LIMIT, {
    message: `at most ${CAPTION_MERGE_LIMIT} merged captions`,
  });

export const studioEditsSchema = z
  .object({
    textLayers: z.array(studioTextLayerSchema).max(STUDIO_EDIT_LIMITS.textLayers).default([]),
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
    sceneLayouts: studioSceneLayoutSelectionsSchema,
    sfx: z.array(studioSfxPlacementSchema).max(STUDIO_EDIT_LIMITS.sfx).default([]),
    visualBroll: z.array(studioVisualBrollPlacementSchema).max(STUDIO_EDIT_LIMITS.visualBroll).default([]),
    /** Hero overrides for Dynamic Style captions. Absent = none. */
    captionEmphasis: studioCaptionEmphasisSchema.optional(),
    /** Caption Emojis by Word Key, drawn when the preset's `emojis` is on. Absent = none. */
    captionEmojis: captionEmojisSchema.optional(),
    /** Captions merged by hand (`studioCaptionMergesSchema`). Absent = none. */
    captionMerges: studioCaptionMergesSchema.optional(),
  })
  .superRefine((edits, context) => {
    const ordered = [...edits.visualBroll].sort((left, right) => left.startSec - right.startSec);
    if (new Set(ordered.map((placement) => placement.id)).size !== ordered.length) {
      context.addIssue({ code: "custom", path: ["visualBroll"], message: "visual B-roll ids must be unique" });
    }
    ordered.forEach((placement, index) => {
      const previous = ordered[index - 1];
      if (previous && placement.startSec < previous.endSec) {
        context.addIssue({ code: "custom", path: ["visualBroll", index], message: "visual B-roll windows cannot overlap" });
      }
    });
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
    sceneLayouts: [],
    sfx: [],
    visualBroll: [],
  });

export const updateClipStudioEditsSchema = z.object({
  studioEdits: studioEditsSchema,
});

export type StudioTextLayer = z.infer<typeof studioTextLayerSchema>;
export type StudioTransition = z.infer<typeof studioTransitionSchema>;
export type StudioMusic = z.infer<typeof studioMusicSchema>;
export type StudioMusicBlock = z.infer<typeof studioMusicBlockSchema>;
export type StudioSourceAudio = z.infer<typeof studioSourceAudioSchema>;
export type StudioLogo = z.infer<typeof studioLogoSchema>;
export type StudioBackground = z.infer<typeof studioBackgroundSchema>;
export type StudioFraming = z.infer<typeof studioFramingSchema>;
export type { StudioSpeakerLayoutOverride, SpeakerLayerTransform } from "./speaker-layout-overrides";
export type StudioSfxPlacement = z.infer<typeof studioSfxPlacementSchema>;
export type StudioVisualBrollPlacement = z.infer<typeof studioVisualBrollPlacementSchema>;
export type StudioEdits = z.infer<typeof studioEditsSchema>;
export type UpdateClipStudioEdits = z.infer<typeof updateClipStudioEditsSchema>;

function studioTextLayersEqual(
  left: readonly StudioTextLayer[],
  right: readonly StudioTextLayer[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((layer, index) => {
    const candidate = right[index]!;
    return (
      layer === candidate ||
      (layer.id === candidate.id &&
        layer.text === candidate.text &&
        layer.startSec === candidate.startSec &&
        layer.endSec === candidate.endSec &&
        layer.positionX === candidate.positionX &&
        layer.positionY === candidate.positionY &&
        layer.fontName === candidate.fontName &&
        (layer.fontAsset?.id ?? null) === (candidate.fontAsset?.id ?? null) &&
        (layer.fontAsset?.fingerprint ?? null) === (candidate.fontAsset?.fingerprint ?? null) &&
        layer.fontSize === candidate.fontSize &&
        layer.color === candidate.color &&
        layer.backgroundColor === candidate.backgroundColor &&
        layer.backgroundOpacity === candidate.backgroundOpacity &&
        layer.bold === candidate.bold &&
        layer.outlineColor === candidate.outlineColor &&
        layer.outlineWidth === candidate.outlineWidth)
    );
  });
}

function studioMusicBlocksEqual(
  left: readonly StudioMusicBlock[],
  right: readonly StudioMusicBlock[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((block, index) => {
    const candidate = right[index]!;
    return (
      block === candidate ||
      (block.id === candidate.id &&
        block.assetId === candidate.assetId &&
        block.url === candidate.url &&
        block.title === candidate.title &&
        block.startSec === candidate.startSec &&
        block.endSec === candidate.endSec &&
        block.sourceStartSec === candidate.sourceStartSec &&
        block.volume === candidate.volume &&
        block.fadeInSec === candidate.fadeInSec &&
        block.fadeOutSec === candidate.fadeOutSec)
    );
  });
}

function studioSfxPlacementsEqual(
  left: readonly StudioSfxPlacement[],
  right: readonly StudioSfxPlacement[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((placement, index) => {
    const candidate = right[index]!;
    return (
      placement === candidate ||
      (placement.id === candidate.id &&
        placement.assetId === candidate.assetId &&
        placement.title === candidate.title &&
        placement.startSec === candidate.startSec &&
        placement.volume === candidate.volume)
    );
  });
}

function studioVisualBrollEqual(
  left: readonly StudioVisualBrollPlacement[],
  right: readonly StudioVisualBrollPlacement[],
) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((placement, index) => {
    const candidate = right[index]!;
    return placement === candidate || (
      placement.id === candidate.id &&
      placement.asset.id === candidate.asset.id &&
      placement.asset.fingerprint === candidate.asset.fingerprint &&
      placement.startSec === candidate.startSec &&
      placement.endSec === candidate.endSec &&
      placement.fit === candidate.fit
    );
  });
}

/**
 * `edits` with every key in `keys` set to `value`, or cleared when `value`
 * is null. The field is dropped once no override is left. Null when the
 * result would hold more than `CAPTION_EMPHASIS_OVERRIDE_LIMIT` overrides.
 */
export function withCaptionEmphasis(
  edits: StudioEdits,
  keys: readonly string[],
  value: CaptionEmphasisOverride | null,
): StudioEdits | null {
  const next: Record<string, CaptionEmphasisOverride> = { ...edits.captionEmphasis };
  for (const key of keys) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const count = Object.keys(next).length;
  if (count > CAPTION_EMPHASIS_OVERRIDE_LIMIT) return null;
  if (count > 0) return { ...edits, captionEmphasis: next };
  const { captionEmphasis: _cleared, ...rest } = edits;
  return rest;
}

/**
 * `edits` with each entry's emoji set, or removed when it is null. The field
 * is dropped once no emoji is left. Null when the result would hold more than
 * `CAPTION_EMOJI_LIMIT` emojis.
 */
export function withCaptionEmojis(
  edits: StudioEdits,
  entries: Readonly<Record<string, CaptionEmojiRef | null>>,
): StudioEdits | null {
  const next: Record<string, CaptionEmojiRef> = { ...edits.captionEmojis };
  for (const [key, ref] of Object.entries(entries)) {
    if (ref === null) delete next[key];
    else next[key] = ref;
  }
  return replaceCaptionEmojis(edits, next);
}

/** `edits` with exactly `value` as its emojis, stored as absent when empty. Null beyond `CAPTION_EMOJI_LIMIT`. */
export function replaceCaptionEmojis(
  edits: StudioEdits,
  value: Readonly<Record<string, CaptionEmojiRef>>,
): StudioEdits | null {
  const count = Object.keys(value).length;
  if (count > CAPTION_EMOJI_LIMIT) return null;
  if (count > 0) return { ...edits, captionEmojis: { ...value } };
  const { captionEmojis: _cleared, ...rest } = edits;
  return rest;
}

function captionEmojisEqual(
  left: Readonly<Record<string, CaptionEmojiRef>> | undefined,
  right: Readonly<Record<string, CaptionEmojiRef>> | undefined,
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left ?? {});
  if (leftKeys.length !== Object.keys(right ?? {}).length) return false;
  return leftKeys.every((key) => {
    const candidate = right?.[key];
    return candidate !== undefined && candidate.id === left![key]!.id && candidate.tone === left![key]!.tone && candidate.word === left![key]!.word;
  });
}

/** Equality of two records of strings by Word Key (emphasis overrides, merged captions). */
function wordKeyRecordEqual(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left ?? {});
  if (leftKeys.length !== Object.keys(right ?? {}).length) return false;
  return leftKeys.every((key) => left![key] === right?.[key]);
}

/** Field-aware equality for canonical Studio edit values. */
export function studioEditsEqual(
  left: StudioEdits,
  right: StudioEdits,
): boolean {
  if (left === right) return true;
  return (
    left.transition.type === right.transition.type &&
    left.transition.durationSec === right.transition.durationSec &&
    left.music.ducking === right.music.ducking &&
    studioMusicBlocksEqual(left.music.blocks, right.music.blocks) &&
    left.sourceAudio.volume === right.sourceAudio.volume &&
    left.sourceAudio.muted === right.sourceAudio.muted &&
    left.logo.enabled === right.logo.enabled &&
    left.logo.position === right.logo.position &&
    left.logo.opacity === right.logo.opacity &&
    left.logo.scalePct === right.logo.scalePct &&
    left.background.mode === right.background.mode &&
    left.background.color === right.background.color &&
    left.background.imageUrl === right.background.imageUrl &&
    left.framing.mode === right.framing.mode &&
    studioTextLayersEqual(left.textLayers, right.textLayers) &&
    studioSfxPlacementsEqual(left.sfx, right.sfx) &&
    studioVisualBrollEqual(left.visualBroll, right.visualBroll) &&
    wordKeyRecordEqual(left.captionEmphasis, right.captionEmphasis) &&
    wordKeyRecordEqual(left.captionMerges, right.captionMerges) &&
    captionEmojisEqual(left.captionEmojis, right.captionEmojis) &&
    speakerLayoutOverridesEqual(
      left.speakerLayoutOverrides,
      right.speakerLayoutOverrides,
    ) &&
    sceneLayoutSelectionsEqual(left.sceneLayouts, right.sceneLayouts)
  );
}

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
 * One `studioEdits` sub-field inside an Apply-to-all persistence intent.
 * A user gesture may group several of these patches in one atomic project
 * mutation, while each patch remains strict and names exactly one sub-object.
 * Clip Editor Document Persistence merges the group onto each target's
 * canonical document. Add a schema branch here and handle the field in that
 * module's project-selection intent when another sub-field earns Apply-to-all.
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
 * Request body for `POST /projects/:id/clips/apply-studio-edits`. The
 * single-patch form remains part of the current endpoint contract; first-party
 * callers send the normalized grouped form so one user gesture always has one
 * request shape.
 * `excludeClipId` lets the studio session that originated the patch skip
 * itself server-side — that clip already has the change applied locally
 * (undoable, via the open editor document) and will persist it through the
 * normal revision-guarded autosave; including it in the bulk write would
 * bump its `editorRevision` out from under the client's in-flight
 * `baseRevision` and 409 the next autosave.
 */
const applyStudioEditsToAllSingleSchema = z
  .object({
    patch: applyStudioEditsPatchSchema,
    excludeClipId: z.string().uuid().optional(),
  })
  .strict();

const applyStudioEditsToAllGroupedSchema = z
  .object({
    patches: z.array(applyStudioEditsPatchSchema).min(1).max(3),
    excludeClipId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const fields = value.patches.map((patch) => Object.keys(patch)[0]);
    if (new Set(fields).size !== fields.length) {
      context.addIssue({
        code: "custom",
        path: ["patches"],
        message: "grouped patches cannot repeat a Studio edit field",
      });
    }
  });

export const applyStudioEditsToAllSchema = z
  .union([
    applyStudioEditsToAllSingleSchema,
    applyStudioEditsToAllGroupedSchema,
  ])
  .transform((value) => ({
    patches: "patches" in value ? value.patches : [value.patch],
    excludeClipId: value.excludeClipId,
  }));

export type ApplyStudioEditsToAll = z.infer<typeof applyStudioEditsToAllSchema>;
