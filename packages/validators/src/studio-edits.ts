import { z } from "zod";

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
});

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
    }),
  })
  .default({
    textLayers: [],
    transition: { type: "none", durationSec: 0.4 },
    music: { url: null, title: null, volume: 35, startOffsetSec: 0 },
  });

export const updateClipStudioEditsSchema = z.object({
  studioEdits: studioEditsSchema,
});

export type StudioTextLayer = z.infer<typeof studioTextLayerSchema>;
export type StudioTransition = z.infer<typeof studioTransitionSchema>;
export type StudioMusic = z.infer<typeof studioMusicSchema>;
export type StudioEdits = z.infer<typeof studioEditsSchema>;
export type UpdateClipStudioEdits = z.infer<typeof updateClipStudioEditsSchema>;
