import { z } from "zod";
import { logoPositionSchema } from "./logo-position";

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

export const studioEditsSchema = z
  .object({
    textLayers: z.array(studioTextLayerSchema).max(12).default([]),
    transition: studioTransitionSchema.default({
      type: "none",
      durationSec: 0.4,
    }),
    music: studioMusicSchema.default({
      url: null,
      title: null,
      volume: 35,
      startOffsetSec: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
    }),
    sourceAudio: studioSourceAudioSchema.default({ volume: 100, muted: false }),
    logo: studioLogoSchema.default(STUDIO_LOGO_DEFAULT),
    background: studioBackgroundSchema.default(STUDIO_BACKGROUND_DEFAULT),
  })
  .default({
    textLayers: [],
    transition: { type: "none", durationSec: 0.4 },
    music: {
      url: null,
      title: null,
      volume: 35,
      startOffsetSec: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
    },
    sourceAudio: { volume: 100, muted: false },
    logo: STUDIO_LOGO_DEFAULT,
    background: STUDIO_BACKGROUND_DEFAULT,
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
export type StudioEdits = z.infer<typeof studioEditsSchema>;
export type UpdateClipStudioEdits = z.infer<typeof updateClipStudioEditsSchema>;

/**
 * "Apply to all clips" for a single `studioEdits` sub-field (vizard-parity.md
 * Phase C — transitions/background apply-to-all). Unlike `captionPreset`,
 * `studioEdits` is a JSON blob, so a bulk apply can't overwrite the whole
 * column — it must patch exactly one named sub-object per call, merged
 * per-row on top of that clip's existing `studioEdits` by the service. The
 * `.strict()` + refine keeps the payload to precisely one of the two known
 * fields; add a new branch here (and in `applyStudioEditsPatchToAllClips`)
 * when another sub-field earns an apply-to-all action.
 */
export const applyStudioEditsPatchSchema = z
  .object({
    transition: studioTransitionSchema.optional(),
    background: studioBackgroundSchema.optional(),
  })
  .strict()
  .refine(
    (patch) => (patch.transition !== undefined) !== (patch.background !== undefined),
    { message: "patch must contain exactly one of: transition, background" },
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
