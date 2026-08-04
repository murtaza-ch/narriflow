import { z } from "zod";
import { captionPresetSchema } from "./clip";
import { logoPositionSchema, type LogoPosition } from "./logo-position";

const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

// Re-exported from logo-position.ts (not defined here) — see that module's
// doc comment for why it was split out (avoids a clip.ts <-> studio-edits.ts
// <-> brand-template.ts import cycle).
export { logoPositionSchema, type LogoPosition };

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
});

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
});

export type DuplicateBrandTemplateInput = z.infer<typeof duplicateBrandTemplateSchema>;

export const presignBrandLogoSchema = z.object({
  contentType: z.enum(["image/png", "image/svg+xml", "image/jpeg", "image/webp"]),
  sizeBytes: z.number().int().positive().max(2 * 1024 * 1024),
});

export type PresignBrandLogoInput = z.infer<typeof presignBrandLogoSchema>;
