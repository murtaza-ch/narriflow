import { z } from "zod";
import { brandFontFinalizeSchema, visualAssetFinalizeSchema } from "./brand-profile";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const metric = z.number().finite().min(0).max(10);
export const validatedFontFaceSchema = z.strictObject({
  name: z.string().min(1).max(120), file: z.literal(""),
  assName: z.string().min(1).max(256).regex(/^[^,\\{}\r\n]+$/),
  weight: z.number().int().min(100).max(900), style: z.enum(["normal", "italic"]),
  ascent: metric, descent: metric, capHeight: metric,
}).refine(value => value.ascent + value.descent > 0);

export const nativeValidationInputSchema = z.discriminatedUnion("kind", [
  brandFontFinalizeSchema.extend({ kind: z.literal("font") }),
  visualAssetFinalizeSchema.extend({ kind: z.literal("visual") }),
]);

/** Stored-only lineage: public finalization schemas never accept this field. */
export const generatedValidationPlanSchema = z.strictObject({ key:z.string().min(1).max(1024), fingerprint:digest,
  contentType:z.enum(["image/png","image/jpeg","image/webp"]), sizeBytes:z.number().int().positive().max(100000000),
  sourceClaimLineage:z.string().uuid(), parentAttempt:z.number().int().positive().max(100), providerRef:z.string().min(1).max(2048) });
export type GeneratedValidationPlan = z.infer<typeof generatedValidationPlanSchema>;
export const generatedValidationParentSchema = z.strictObject({ id: z.string().uuid(), projectId: z.string().uuid(), attempt: z.number().int().positive().max(100),
  providerRef: z.string().min(1).max(2048), claimLineage: z.string().uuid(), admittingClaimLineage: z.string().uuid() });
export const nativeValidationStoredInputSchema = z.discriminatedUnion("kind", [
  brandFontFinalizeSchema.extend({ kind: z.literal("font") }),
  visualAssetFinalizeSchema.extend({ kind: z.literal("visual"), generated: generatedValidationParentSchema.optional() }),
]);
export type GeneratedValidationParent = z.infer<typeof generatedValidationParentSchema>;
export type NativeValidationStoredInput = z.infer<typeof nativeValidationStoredInputSchema>;

const binary = { sha256: digest, byteLength: z.number().int().positive().max(2 * 1024 ** 3) };
export const nativeValidationEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("font"), ...binary, format: z.enum(["ttf", "otf", "woff2"]),
    family: z.string().min(1).max(120), style: z.string().min(1).max(80), weight: z.number().int().min(100).max(900), face: validatedFontFaceSchema }),
  z.strictObject({ kind: z.enum(["visual", "thumbnail"]), ...binary,
    contentType: z.enum(["image/png", "image/jpeg", "image/webp", "video/mp4", "video/quicktime"]),
    mediaKind: z.enum(["image", "video"]), width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384),
    durationSec: z.number().finite().positive().max(86400).nullable(),
  }).refine(value => value.width * value.height <= 40_000_000 &&
    (value.mediaKind === "image" ? value.durationSec === null && value.contentType.startsWith("image/") : value.durationSec !== null && value.contentType.startsWith("video/"))),
]);

export type NativeValidationInput = z.infer<typeof nativeValidationInputSchema>;
export type NativeValidationEvidence = z.infer<typeof nativeValidationEvidenceSchema>;
