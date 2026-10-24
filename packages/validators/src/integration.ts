import { z } from "zod";
import { BRAND_DEFAULT_CAPTION_PRESET_ID, captionPresetIdSchema } from "./caption-preset";
import { clipAspectRatioSchema, clipCategorySchema, clipRenderResolutionSchema, clipStatusSchema } from "./clip";
import { clipExportStatusSchema } from "./clip-export";
import { captionedVideoSettingsSchema, type CaptionedVideoSettings } from "./captioned-video";
import { clipLengthPresetRanges, clipLengthPresetSchema, clipPlatformTargetSchema, contentPackSchema, generationModeSchema, PLATFORM_PLAYBOOK_VERSION } from "./content-pack";
import { finishingSettingsSchema, type FinishingSettingsInput } from "./finishing";
import { ingestStatusSchema } from "./ingest";
import { sourceLanguageCodeSchema } from "./language";

/** Transport-neutral command inputs and resource views shared by the MCP
 * server and the public REST API. Transport envelopes (MCP's workspaceId and
 * clientIdempotencyKey, REST's path, headers, and derived Workspace) stay in
 * their adapters. */
const id = z.string().uuid();
const text = z.string().max(2_000);
const date = z.string().datetime();
const link = z.string().url().max(4_096);

export const generationSettingsSchema = z.strictObject({
  clipCountTarget: z.number().int().min(3).max(30).default(10),
  clipLengthPreset: clipLengthPresetSchema.default("auto"),
  defaultAspectRatio: clipAspectRatioSchema.default("9:16"),
  captionPreset: captionPresetIdSchema.default(BRAND_DEFAULT_CAPTION_PRESET_ID),
  mode: generationModeSchema.default("clip"),
  autoHook: z.boolean().default(true),
  specificMoments: z.string().max(500).default(""),
  processingStartSec: z.number().int().min(0).nullable().default(null),
  processingEndSec: z.number().int().min(0).nullable().default(null),
  languageCode: sourceLanguageCodeSchema.default(null),
});
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;
export function buildGenerationContentPack(input: z.input<typeof generationSettingsSchema> = {}) {
  const settings = generationSettingsSchema.parse(input);
  return contentPackSchema.parse({
    outputTypes: ["short_clip"], clipGenerationMode: "best", clipCountTarget: settings.clipCountTarget,
    ...clipLengthPresetRanges[settings.clipLengthPreset],
    platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
    toneConstraints: ["concise", "conversational"],
    captionPreset: settings.captionPreset, platformPlaybookVersion: PLATFORM_PLAYBOOK_VERSION,
    mode: settings.mode, autoHook: settings.autoHook, specificMoments: settings.specificMoments,
    processingStartSec: settings.processingStartSec, processingEndSec: settings.processingEndSec,
    clipLengthPreset: settings.clipLengthPreset, defaultAspectRatio: settings.defaultAspectRatio,
  });
}

/** The Content Pack of a captioned video: a caption-only generation whose
 * settings travel with it from acceptance to export. */
export function buildCaptionedVideoContentPack(settings: CaptionedVideoSettings) {
  return contentPackSchema.parse({
    ...buildGenerationContentPack({ mode: "caption_only", defaultAspectRatio: settings.aspectRatios[0] }),
    captionedVideo: captionedVideoSettingsSchema.parse(settings),
  });
}

/** The generation context every intake carries to its Ingest Generation Handoff:
 * the committed Content Pack, the source language, and, when asked for, finishing. */
export function buildGenerationContext(input: z.input<typeof generationSettingsSchema> = {}, finishing?: FinishingSettingsInput | null) {
  const settings = generationSettingsSchema.parse(input);
  return {
    contentPack: buildGenerationContentPack(settings),
    languageCode: settings.languageCode,
    ...(finishing ? { finishing: finishingSettingsSchema.parse(finishing) } : {}),
  };
}

/** The generation context a Recipe commits: the same shape as an inline one. */
export function buildRecipeGenerationContext(recipe: { contentPack: unknown; languageCode: string | null; finishing: FinishingSettingsInput | null }) {
  return {
    contentPack: contentPackSchema.parse(recipe.contentPack),
    languageCode: sourceLanguageCodeSchema.parse(recipe.languageCode),
    ...(recipe.finishing ? { finishing: finishingSettingsSchema.parse(recipe.finishing) } : {}),
  };
}

/** Omitted means the Workspace's default Brand Profile, if any. Only intake
 * commands take it. */
export const intakeBrandProfileIdSchema = id.optional().describe("Brand Profile to apply; omit to use the Workspace default");

/** A saved Recipe supplies the Brand Profile, language, generation settings,
 * and finishing that a request would otherwise send inline. */
export const recipeIdSchema = id.describe("A Recipe from the Recipes list. It replaces brandProfileId, generation, and finishing: send it or those, never both. Generating clips for an existing Project uses the Recipe's language, generation settings, and finishing; the Project keeps the Brand Profile it was imported with");
const RECIPE_WITH_INLINE_MESSAGE = "A Recipe replaces brandProfileId, generation, and finishing. Send recipeId or those settings, not both";
/** Adds an issue when a request names a Recipe and also sends inline settings. */
export function refuseRecipeWithInlineSettings(
  input: { recipeId?: string; brandProfileId?: unknown; generation?: unknown; finishing?: unknown },
  context: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void },
) {
  if (input.recipeId === undefined) return;
  for (const field of ["brandProfileId", "generation", "finishing"] as const) {
    if (input[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: RECIPE_WITH_INLINE_MESSAGE });
  }
}
export const clipExportRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  aspectRatios: z.array(clipAspectRatioSchema).min(1).max(4).refine((values) => new Set(values).size === values.length, "Choose each format once"),
  resolution: clipRenderResolutionSchema,
});
export type ClipExportRequest = z.infer<typeof clipExportRequestSchema>;

export const projectViewSchema = z.strictObject({ projectId: id, workspaceId: id, title: z.string().max(500), sourceType: z.enum(["upload", "youtube", "rss", "link"]), ingestStatus: ingestStatusSchema, durationSeconds: z.number().nonnegative().nullable(), languageCode: z.string().max(30).nullable(), createdAt: date, reviewUrl: link });
export const clipViewSchema = z.strictObject({ clipId: id, projectId: id, editorRevision: z.number().int().nonnegative(), title: z.string().max(500).nullable(), status: clipStatusSchema, startSec: z.number().nonnegative(), endSec: z.number().nonnegative(), durationSec: z.number().nonnegative(), hookText: text, reasoning: text, category: clipCategorySchema, platformFit: z.array(clipPlatformTargetSchema), scores: z.strictObject({ virality: z.number().min(0).max(100), hookStrength: z.number().min(0).max(100), emotionalIntensity: z.number().min(0).max(100), storyCompleteness: z.number().min(0).max(100), pacing: z.number().min(0).max(100), durationOptimality: z.number().min(0).max(100) }), hasPreview: z.boolean(), transcriptExcerpt: z.string().max(2_000).optional(), reviewUrl: link });
export const exportViewSchema = z.strictObject({ exportId: id, projectId: id, clipId: id, editorRevision: z.number().int().nonnegative(), currentEditorRevision: z.number().int().nonnegative(), isOlderVersion: z.boolean(), resolution: clipRenderResolutionSchema, watermark: z.boolean(), status: clipExportStatusSchema, progress: z.number().min(0).max(100), createdAt: date, completedAt: date.nullable(), variants: z.array(z.strictObject({ variantId: id, aspectRatio: clipAspectRatioSchema, resolution: clipRenderResolutionSchema, status: z.enum(["pending", "rendering", "completed", "failed"]), hasAsset: z.boolean(), durationSeconds: z.number().nonnegative().nullable() })), reviewUrl: link });

/** A Recipe as integrations see it: the generation settings a request would
 * send inline, plus the Brand Profile, language, and finishing. */
export const recipeViewSchema = z.strictObject({
  recipeId: id, name: z.string().max(120), revision: z.number().int().positive(),
  brandProfileId: id.nullable().describe("Applied to intake; null applies no Brand Profile"),
  languageCode: z.string().max(30).nullable().describe("Source language; null detects it"),
  generation: generationSettingsSchema.omit({ languageCode: true }),
  finishing: finishingSettingsSchema.nullable(),
  updatedAt: date,
});
export type RecipeView = z.infer<typeof recipeViewSchema>;
export const recipesResultSchema = z.strictObject({ recipes: z.array(recipeViewSchema).max(50) });
/** What an accepted request records about the Recipe it used. */
export const acceptedRecipeSchema = z.strictObject({ id, revision: z.number().int().positive() });
export type AcceptedRecipe = z.infer<typeof acceptedRecipeSchema>;
export function acceptedRecipe(recipe: AcceptedRecipe): AcceptedRecipe {
  return { id: recipe.id, revision: recipe.revision };
}
export type GenerationSettingsInput = z.input<typeof generationSettingsSchema>;
/** The ContentPack column that keeps the Recipe a generation's settings were
 * read from, for audit. Empty when the settings were sent explicitly. */
export function recipeColumn(context?: { recipe?: AcceptedRecipe | null } | null) {
  return context?.recipe ? { recipe: acceptedRecipe(context.recipe) } : {};
}
