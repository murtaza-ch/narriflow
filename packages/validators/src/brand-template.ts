import { z } from "zod";
import { captionDynamicStyle, captionStyleDrawsHero, captionStyleUsesAccent } from "./caption-dynamic";
import { applyBrandColorsToScene, brandColorsFromScene } from "./caption-scene";
import type { CaptionPreset } from "./caption-preset";
import { captionPresetSchema } from "./clip";
import { logoPositionSchema, type LogoPosition } from "./logo-position";

const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

// Re-exported from logo-position.ts (not defined here) — see that module's
// doc comment for why it was split out (avoids a clip.ts <-> studio-edits.ts
// <-> brand-template.ts import cycle).
export { logoPositionSchema, type LogoPosition };

/**
 * A brand template's two colours on its caption style. Classic styles take
 * the primary as text and the secondary as the highlight. Dynamic Styles keep
 * their support colour (white or cream): the primary becomes the hero (the
 * text colour for a style without a hero, Cutout's tile ink) and the
 * secondary the accent, for styles that draw one. A Scene Style says for itself
 * which slots the brand colours colour (`CaptionSceneMeta.brand`): its ink on a
 * fixed plate is never one, and a plate under fixed ink takes a brand colour
 * only when the ink reads on it.
 */
export function applyBrandColorsToCaption(
  preset: CaptionPreset,
  primaryColor: string,
  secondaryColor: string,
): CaptionPreset {
  if (preset.scene) return { ...preset, ...applyBrandColorsToScene(preset.scene, preset, { primaryColor, secondaryColor }) };
  if (!preset.dynamic) return { ...preset, primaryColor, highlightColor: secondaryColor };
  // The accent is written only where the style draws one and it changes, so a
  // catalog look whose colours are the brand's still matches its catalog entry.
  const style = captionDynamicStyle(preset.dynamic);
  const changesAccent = captionStyleUsesAccent(style) && effectiveAccent(preset).toUpperCase() !== secondaryColor.toUpperCase();
  // The brand primary goes to the hero; a style without one (Cutout) draws it as the text colour.
  const primarySlot = captionStyleDrawsHero(style) ? "highlightColor" : "primaryColor";
  return { ...preset, [primarySlot]: primaryColor, ...(changesAccent ? { accentColor: secondaryColor } : {}) };
}

/** The colour a dynamic preset draws in its accent slot. */
function effectiveAccent(preset: CaptionPreset): string {
  return preset.accentColor ?? (preset.dynamic ? captionDynamicStyle(preset.dynamic).accentColor : undefined) ?? preset.highlightColor;
}

/** The brand colours a caption look implies, the inverse of `applyBrandColorsToCaption`. */
export function brandColorsFromCaption(preset: CaptionPreset): { primaryColor: string; secondaryColor: string } {
  if (preset.scene) return brandColorsFromScene(preset.scene, preset);
  if (!preset.dynamic) return { primaryColor: preset.primaryColor, secondaryColor: preset.highlightColor };
  const primaryColor = captionStyleDrawsHero(captionDynamicStyle(preset.dynamic)) ? preset.highlightColor : preset.primaryColor;
  return { primaryColor, secondaryColor: effectiveAccent(preset) };
}

export const brandTemplateInputSchema = z.object({
  name: z.string().min(1).max(60),
  captionPreset: captionPresetSchema,
  logoStorageKey: z.string().nullable().optional(),
  logoPosition: logoPositionSchema.default("bot-right"),
  logoOpacity: z.number().int().min(10).max(100).default(80),
  logoScalePct: z.number().int().min(5).max(40).default(15),
  primaryColor: hexColorSchema.default("#FFFFFF"),
  secondaryColor: hexColorSchema.default("#00FF88"),
  accentColor: hexColorSchema.nullable().optional(),
}).strict();

export type BrandTemplateInput = z.infer<typeof brandTemplateInputSchema>;

export const brandTemplateUpdateSchema = brandTemplateInputSchema.partial();

export type BrandTemplateUpdate = z.infer<typeof brandTemplateUpdateSchema>;

export const brandTemplateSnapshotSchema = z.object({
  templateId: z.string().uuid().nullable(),
  captionPreset: captionPresetSchema,
  logoStorageKey: z.string().nullable(),
  logoPosition: logoPositionSchema,
  logoOpacity: z.number().int().min(10).max(100),
  logoScalePct: z.number().int().min(5).max(40),
  primaryColor: hexColorSchema,
  secondaryColor: hexColorSchema,
  accentColor: hexColorSchema.nullable(),
});

export type BrandTemplateSnapshot = z.infer<typeof brandTemplateSnapshotSchema>;

export const brandTemplateSummarySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  name: z.string(),
  isBuiltIn: z.boolean(),
  builtInKey: z.string().nullable(),
  captionPreset: captionPresetSchema,
  logoStorageKey: z.string().nullable(),
  logoPosition: logoPositionSchema,
  logoOpacity: z.number().int(),
  logoScalePct: z.number().int(),
  primaryColor: hexColorSchema,
  secondaryColor: hexColorSchema,
  accentColor: hexColorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type BrandTemplateSummary = z.infer<typeof brandTemplateSummarySchema>;

export const duplicateBrandTemplateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
}).strict();

export type DuplicateBrandTemplateInput = z.infer<typeof duplicateBrandTemplateSchema>;

export const presignBrandLogoSchema = z.object({
  contentType: z.enum(["image/png", "image/svg+xml", "image/jpeg", "image/webp"]),
  sizeBytes: z.number().int().positive().max(2 * 1024 * 1024),
}).strict();

export type PresignBrandLogoInput = z.infer<typeof presignBrandLogoSchema>;
