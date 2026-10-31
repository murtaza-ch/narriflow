import { clipAutoLayoutAnalysisSchema, clipSplitLayoutAnalysisSchema, clipSplitLayoutFailureSchema } from "./clip-auto-layout-analysis";
import { clipLayoutAnalysisSchema, clipLayoutAnalysisFailureSchema } from "./clip-layout-analysis";
import { z } from "zod";
import { editorDocumentSchema } from "./editor-document";
import { sourceProbeSchema, mediaFactsSchema } from "./source-probe";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const clipPreparationObjectSchema = z.strictObject({
  storageKey: z.string().min(1).max(1024), etag: z.string().min(1).max(160).regex(/^"[^\r\n"]+"$/),
  byteLength: z.number().int().positive().safe().max(10 * 1024 ** 3), sha256,
});

/** Sealed in R2. Neither captions nor scoped URLs enter Workflow state. */
export const clipPreparationInputSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("prepare_clip"),
  preparationId: z.string().uuid(), projectId: z.string().uuid(), clipId: z.string().uuid(),
  sourceRevision: z.number().int().positive(), editorRevision: z.number().int().nonnegative(),
  toolchainFingerprint: sha256, engineHash: sha256, bindingHash: sha256,
  source: clipPreparationObjectSchema,
  sourceProbe: sourceProbeSchema.extend({ facts: mediaFactsSchema }),
  document: editorDocumentSchema,
  wholeSource: z.boolean(),
  llmModel: z.string().min(1).max(160),
});
export type ClipPreparationInput = z.infer<typeof clipPreparationInputSchema>;
export type ClipPreparationObject = z.infer<typeof clipPreparationObjectSchema>;

/** One sealed preparation outcome, read and validated before domain locks. */
export const clipPreparationResultSchema = z.strictObject({
  version: z.literal(1), preparationId: z.string().uuid(), bindingHash: sha256,
  preview: z.strictObject({ artifactId: z.string().uuid(), startSec: z.number().finite().nonnegative(), durationSec: z.number().finite().positive() }),
  peaks: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("ready"), artifactId: z.string().uuid() }),
    z.strictObject({ state: z.literal("unavailable"), reason: z.enum(["no_audio", "peaks_unavailable"]) }),
  ]),
  layout: z.strictObject({
    automatic: z.union([clipAutoLayoutAnalysisSchema, z.strictObject({ state: z.literal("failed"), reason: z.literal("analysis_unavailable") })]).nullable(),
    screen: z.union([clipLayoutAnalysisSchema, clipLayoutAnalysisFailureSchema]).nullable(),
    split: z.union([clipSplitLayoutAnalysisSchema, clipSplitLayoutFailureSchema]).nullable(),
  }),
}).refine(value => value.peaks.state !== "ready" || value.peaks.artifactId !== value.preview.artifactId, "Preview and peaks require distinct assigned artifacts");
export type ClipPreparationResult = z.infer<typeof clipPreparationResultSchema>;
