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
