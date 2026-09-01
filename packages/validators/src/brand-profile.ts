import { z } from "zod";

const idSchema = z.string().uuid();
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const boundedTermsSchema = z.array(z.string().trim().min(1).max(80)).max(50);

export const brandVoiceGuidanceSchema = z
  .object({
    audience: z.string().trim().max(500).default(""),
    tone: boundedTermsSchema.default([]),
    preferredTerms: boundedTermsSchema.default([]),
    blockedTerms: boundedTermsSchema.default([]),
    hashtagGuidance: z.string().trim().max(500).default(""),
  })
  .strict();

export const brandVisualIdentitySchema = z
  .object({
    primaryColor: hexColorSchema.default("#FFFFFF"),
    secondaryColor: hexColorSchema.default("#111522"),
    accentColor: hexColorSchema.nullable().default(null),
    primaryLogoAssetId: idSchema.nullable().default(null),
    alternateLogoAssetId: idSchema.nullable().default(null),
  })
  .strict();

export const brandApprovalRuleSchema = z.enum([
  "none",
  "approval_required",
]);

export const brandProfileCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    identity: brandVisualIdentitySchema.optional(),
    voice: brandVoiceGuidanceSchema.optional(),
    approvalRule: brandApprovalRuleSchema.default("none"),
    defaultTemplateId: idSchema.nullable().optional(),
  })
  .strict();

export const brandProfileUpdateSchema = brandProfileCreateSchema
  .omit({ slug: true })
  .partial()
  .extend({
    revision: z.number().int().positive(),
    slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  })
  .strict();

export const brandProfileListSchema = z
  .object({
    cursor: idSchema.optional(),
    limit: z.number().int().min(1).max(100).default(24),
    query: z.string().trim().max(100).optional(),
    includeDeleted: z.boolean().default(false),
  })
  .strict();

export const visualAssetContentTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

export const visualAssetUploadSchema = z
  .object({
    contentType: visualAssetContentTypeSchema,
    sizeBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  })
  .strict();

export const visualAssetFinalizeSchema = z
  .object({
    key: z.string().min(1).max(1024),
    contentType: visualAssetContentTypeSchema,
    sizeBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
    fingerprint: fingerprintSchema,
    title: z.string().trim().min(1).max(120),
    provenance: z.enum(["uploaded", "generated"]).default("uploaded"),
  })
  .strict();

export const brandFontContentTypeSchema = z.enum([
  "font/ttf",
  "font/otf",
  "font/woff2",
  "application/font-sfnt",
]);

export const brandFontUploadSchema = z
  .object({
    contentType: brandFontContentTypeSchema,
    sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
    licenseConfirmed: z.literal(true),
  })
  .strict();

export const brandFontFinalizeSchema = brandFontUploadSchema
  .extend({
    key: z.string().min(1).max(1024),
    fingerprint: fingerprintSchema,
    family: z.string().trim().min(1).max(120),
    style: z.string().trim().min(1).max(80),
    weight: z.number().int().min(100).max(900),
  })
  .strict();

const commonMembership = {
  resourceId: idSchema,
  position: z.number().int().nonnegative().max(10_000),
};

export const brandProfileMembershipSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("template"), ...commonMembership }).strict(),
  z.object({
    kind: z.literal("asset"),
    ...commonMembership,
    role: z.enum(["logo", "image", "video", "thumbnail", "intro_source", "outro_source"]),
  }).strict(),
  z.object({
    kind: z.literal("font"),
    ...commonMembership,
    role: z.enum(["display", "body", "caption", "fallback"]),
  }).strict(),
  z.object({ kind: z.literal("audio"), ...commonMembership }).strict(),
]);

export const brandProfileSoftDeleteSchema = z
  .object({
    revision: z.number().int().positive(),
    replacementProfileId: idSchema.nullable().optional(),
  })
  .strict();

export const brandProfileProjectApplicationSchema = z
  .object({
    projectId: idSchema,
    profileId: idSchema,
    templateId: idSchema.nullable(),
  })
  .strict();

export const reusableAssetSoftDeleteSchema = z
  .object({ replacementId: idSchema.nullable().optional() })
  .strict();

export type BrandVoiceGuidance = z.infer<typeof brandVoiceGuidanceSchema>;
export type BrandVisualIdentity = z.infer<typeof brandVisualIdentitySchema>;
export type BrandProfileCreateInput = z.infer<typeof brandProfileCreateSchema>;
export type BrandProfileUpdateInput = z.infer<typeof brandProfileUpdateSchema>;
export type BrandProfileListInput = z.infer<typeof brandProfileListSchema>;
export type VisualAssetUploadInput = z.infer<typeof visualAssetUploadSchema>;
export type VisualAssetFinalizeInput = z.infer<typeof visualAssetFinalizeSchema>;
export type BrandFontUploadInput = z.infer<typeof brandFontUploadSchema>;
export type BrandFontFinalizeInput = z.infer<typeof brandFontFinalizeSchema>;
export type BrandProfileMembershipInput = z.infer<typeof brandProfileMembershipSchema>;
export type BrandProfileSoftDeleteInput = z.infer<typeof brandProfileSoftDeleteSchema>;
export type BrandProfileProjectApplicationInput = z.infer<
  typeof brandProfileProjectApplicationSchema
>;
export type ReusableAssetSoftDeleteInput = z.infer<typeof reusableAssetSoftDeleteSchema>;
