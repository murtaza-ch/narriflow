import { z } from "zod";
import { captionPresetSchema } from "./caption-preset";
import { clipDetectionLlmResponseSchema } from "./clip";
import { contentPackSchema } from "./content-pack";
import { studioEditsSchema } from "./studio-edits";
import { transcriptUtteranceSchema } from "./transcript";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().finite().positive();
export const clipSelectionParentSchema = z.strictObject({ id: z.uuid(), projectId: z.uuid(), generation: z.number().int().positive(), deploymentEpoch: z.number().int().positive(), inputHash: hash });
export const clipSelectionInputSchema = z.strictObject({
  version: z.literal(1),
  parent: clipSelectionParentSchema,
  transcript: z.strictObject({ id: z.uuid(), generation: z.number().int().positive(), attemptId: z.uuid().nullable(), contentHash: hash,
    sourceRevision: z.number().int().positive(), sourceAudioId: z.uuid().nullable(), sourceAudioBindingHash: hash.nullable() })
    .refine(value => (value.sourceAudioId === null) === (value.sourceAudioBindingHash === null)),
  planning: z.strictObject({ projectTitle: z.string(), contentPack: contentPackSchema, sourceDurationSec: positive.nullable(), sourceProbeDurationSec: positive.nullable(),
    utterances: z.array(transcriptUtteranceSchema), fullText: z.string(), speakerCount: z.number().int().nonnegative().nullable(), sourceLanguageCode: z.string().nullable(), audienceDataLine: z.string().nullable() }),
  editor: z.strictObject({ captionPreset: captionPresetSchema, studioEdits: studioEditsSchema, sourceDurationSec: positive.nullable(), wholeSource: z.boolean() }),
  provider: z.strictObject({ model: z.string().min(1).max(100), reasoningEffort: z.string().min(1).max(40), maxOutputTokens: z.number().int().positive() }),
  systemPrompt: z.string().min(1), responseSchemaHash: hash,
});
export const clipSelectionResultBindingSchema = z.strictObject({ parentId: z.uuid(), parentGeneration: z.number().int().positive(), selectionHash: hash, windowIndex: z.number().int().min(0).max(5) });
export const clipSelectionResultSchema = clipSelectionResultBindingSchema.extend({ version: z.literal(1), clips: clipDetectionLlmResponseSchema.shape.clips,
  tokensUsed: z.number().int().nonnegative(), providerRequestId: z.string().max(160).nullable() }).strict();
export type ClipSelectionInput = z.infer<typeof clipSelectionInputSchema>;
export type ClipSelectionParent = z.infer<typeof clipSelectionParentSchema>;
export type ClipSelectionResultBinding = z.infer<typeof clipSelectionResultBindingSchema>;
export type ClipSelectionResult = z.infer<typeof clipSelectionResultSchema>;
