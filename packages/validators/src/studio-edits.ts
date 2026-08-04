import { z } from "zod";
import { logoPositionSchema } from "./logo-position";

const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

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
  });

export const updateClipStudioEditsSchema = z.object({
  studioEdits: studioEditsSchema,
});

export type StudioTextLayer = z.infer<typeof studioTextLayerSchema>;
export type StudioTransition = z.infer<typeof studioTransitionSchema>;
export type StudioMusic = z.infer<typeof studioMusicSchema>;
export type StudioSourceAudio = z.infer<typeof studioSourceAudioSchema>;
export type StudioLogo = z.infer<typeof studioLogoSchema>;
export type StudioEdits = z.infer<typeof studioEditsSchema>;
export type UpdateClipStudioEdits = z.infer<typeof updateClipStudioEditsSchema>;
