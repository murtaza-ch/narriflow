import { z } from "zod";
import { clipPreparationInputSchema, clipPreparationObjectSchema, clipPreparationResultSchema } from "./clip-preparation";
import { clipAspectRatioDbSchema, clipCategorySchema, clipRenderResolutionSchema } from "./clip";
import { brollCuesArraySchema, pexelsOrientationSchema } from "./broll";
import { pricingTierSchema } from "./pricing";

/** A failed variant has a sealed outcome instead of fabricated media bytes. */
export const renderVariantFailureSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("failed"), renderId: z.string().uuid(),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  errorCode: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  disposition: z.enum(["retryable", "permanent"]),
});
export type RenderVariantFailure = z.infer<typeof renderVariantFailureSchema>;

/** Authoritative settlement facts from the transaction publishing the final member. */
export const renderGroupOutcomeSchema = z.strictObject({
  status: z.enum(["queued", "completed", "partial", "failed", "superseded"]),
  requested: z.number().int().positive().max(4),
  succeeded: z.number().int().nonnegative().max(4),
  failed: z.number().int().nonnegative().max(4),
  superseded: z.number().int().nonnegative().max(4),
}).refine(value => {
  const settled = value.succeeded + value.failed + value.superseded;
  if (value.status === "queued") return settled < value.requested;
  if (settled !== value.requested) return false;
  if (value.status === "superseded") return value.superseded === value.requested;
  if (value.status === "completed") return value.succeeded > 0 && value.failed === 0;
  if (value.status === "partial") return value.succeeded > 0 && value.failed > 0;
  return value.failed > 0 && value.succeeded === 0;
}, "Outcome counts must cover exactly the settled group members");
export type RenderGroupOutcome = z.infer<typeof renderGroupOutcomeSchema>;

const source = { name: z.string().regex(/^[a-z][a-z0-9_]{0,159}$/), object: clipPreparationObjectSchema };
const id = z.string().uuid(), fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const renderBrollRequestSchema = z.strictObject({
  clipDurationSec: z.number().finite().positive(), cues: brollCuesArraySchema.nullable(),
  fallbackQuery: z.string().max(1000).nullable(), broaderFallbackQuery: z.string().max(1000).nullable(),
  orientation: pexelsOrientationSchema, targetWidth: z.number().int().positive().max(4096), targetHeight: z.number().int().positive().max(4096),
});
export const renderExecutionInputSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("render_group"), groupId: id, workflowRunId: id, workSetGeneration: id,
  preparation: clipPreparationInputSchema,
  prepared: z.strictObject({ preview: clipPreparationObjectSchema, result: clipPreparationResultSchema }),
  workspace: z.strictObject({ id, ownerUserId: id, pricingTier: pricingTierSchema }),
  captionLanguage: z.string().max(80).nullable(), brandSnapshot: z.json().nullable(),
  clip: z.strictObject({ index: z.number().int().nonnegative(), title: z.string().max(10000).nullable(), hookText: z.string().max(10000), category: clipCategorySchema, brollCues: brollCuesArraySchema.nullable() }),
  variants: z.array(z.strictObject({ renderId: id, aspectRatio: clipAspectRatioDbSchema, resolution: clipRenderResolutionSchema,
    exportVariantId: id.nullable(), export: z.strictObject({ id, watermark: z.boolean() }).nullable() })).min(1).max(4),
  assets: z.strictObject({
    visuals: z.array(z.strictObject({ ...source, id, kind: z.enum(["image", "video"]), fingerprint })).max(1024),
    fonts: z.array(z.strictObject({ ...source, id, family: z.string().max(160), format: z.string().max(16), fingerprint })).max(1024),
    audio: z.array(z.strictObject({ ...source, id, title: z.string().max(1000), durationSec: z.number().finite().nonnegative() })).max(1024),
    logo: z.strictObject(source).nullable(),
  }),
  autoBroll: z.strictObject({ configured: z.boolean(), request: renderBrollRequestSchema.nullable(), resolved: z.array(z.strictObject({
    startSec: z.number().finite().nonnegative(), endSec: z.number().finite().positive(), query: z.string().max(1000),
    downloadUrl: z.url().max(8192), assetDurationSec: z.number().finite().positive(), attribution: z.strictObject({
      authorName: z.string().max(1000).nullable(), authorUrl: z.url().max(8192).nullable(), pageUrl: z.url().max(8192).nullable(), pexelsId: z.number().int().positive(),
    }),
  })).max(6) }),
}).superRefine((value, context) => {
  if (value.preparation.preparationId !== value.prepared.result.preparationId || value.preparation.bindingHash !== value.prepared.result.bindingHash)
    context.addIssue({ code: "custom", path: ["prepared"], message: "Preparation result must match its sealed input" });
  const names = ["original", ...value.assets.visuals.map(item => item.name), ...value.assets.fonts.map(item => item.name), ...value.assets.audio.map(item => item.name), ...(value.assets.logo ? [value.assets.logo.name] : [])];
  if (new Set(names).size !== names.length || new Set(value.variants.map(item => item.renderId)).size !== value.variants.length || new Set(value.variants.map(item => item.aspectRatio)).size !== value.variants.length)
    context.addIssue({ code: "custom", message: "Frozen sources and aspect members must be unique" });
  if (value.variants.some(item => (item.exportVariantId === null) !== (item.export === null))) context.addIssue({ code: "custom", path: ["variants"], message: "Export membership must be complete" });
  if (!value.autoBroll.configured && (value.autoBroll.request || value.autoBroll.resolved.length)) context.addIssue({ code: "custom", path: ["autoBroll"], message: "Unconfigured stock media cannot carry resolved assets" });
});
export type RenderExecutionInput = z.infer<typeof renderExecutionInputSchema>;
