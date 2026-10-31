import { z } from "zod";
import { dubLanguageCodeSchema, dubVoiceSchema } from "./dubbing";
import { clipAspectRatioSchema } from "./clip";

const id = z.string().uuid();
const model = z.string().min(1).max(128);
export const frozenDubbingRequestSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("dubbing_request"), dubId: id, workflowRunId: id,
  projectId: id, workspaceId: id, actorUserId: id, clipId: id,
  editorRevision: z.number().int().nonnegative(), sourceRevision: z.number().int().positive(),
  baseRender: z.strictObject({ id, storageKey: z.string().min(1).max(1024), byteLength: z.number().int().positive().max(10 * 1024 ** 3), durationSec: z.number().positive().max(180) }),
  script: z.string().trim().min(1).max(100_000), sourceLanguageCode: z.union([dubLanguageCodeSchema, z.literal("auto")]).nullable(),
  targetLanguageCode: dubLanguageCodeSchema, voice: dubVoiceSchema, aspectRatio: clipAspectRatioSchema,
  provider: z.literal("openai"), model, translationModel: model,
});
export type FrozenDubbingRequest = z.infer<typeof frozenDubbingRequestSchema>;
