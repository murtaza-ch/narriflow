import { z } from "zod";
import { dubLanguageCodeSchema, dubVoiceSchema } from "./dubbing";
import { clipAspectRatioSchema } from "./clip";
import { executionObjectIdentitySchema } from "./execution";

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

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const dubbingExecutionInputSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("dub_mix"), request: frozenDubbingRequestSchema, requestHash: sha256,
  bindingHash: sha256, toolchainFingerprint: sha256,
  baseVideo: z.strictObject({ storageKey: executionObjectIdentitySchema.shape.key, etag: z.string().max(160).regex(/^"[^\r\n"]+"$/),
    byteLength: executionObjectIdentitySchema.shape.byteLength, sha256: sha256.optional() }),
}).refine(input => input.baseVideo.storageKey === input.request.baseRender.storageKey && input.baseVideo.byteLength === input.request.baseRender.byteLength,
  "The native input must use the exact accepted source render");
export type DubbingExecutionInput = z.infer<typeof dubbingExecutionInputSchema>;

const checkpoint = { version: z.literal(1), kind: z.literal("dubbing_checkpoint"), dubId: id, requestHash: sha256 };
const paidCheckpointSchema = z.discriminatedUnion("stage", [
  z.strictObject({ ...checkpoint, stage: z.literal("translation_intent"), bodySha256: sha256 }),
  z.strictObject({ ...checkpoint, stage: z.literal("speech_intent"), bodySha256: sha256 }),
  z.strictObject({ ...checkpoint, stage: z.literal("translation_result"), text: z.string().trim().min(1).max(100_000).refine(value => !value.includes("\0")),
    providerRequestId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/).nullable() }),
]);
const measuredFile = z.strictObject({ byteLength: z.number().int().positive().safe().max(10 * 1024 ** 3), sha256 });
const failedProviderStage = z.enum(["translation", "speech"]);
export const dubbingCheckpointSchema = z.union([paidCheckpointSchema,
  z.strictObject({ ...checkpoint, stage: z.literal("final_result"), outcome: z.literal("rejected"), providerStage: failedProviderStage,
    httpStatus: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404), z.literal(413), z.literal(415), z.literal(422), z.literal(429)]) }),
  z.strictObject({ ...checkpoint, stage: z.literal("final_result"), outcome: z.literal("unknown"), providerStage: failedProviderStage }), z.strictObject({ ...checkpoint, stage: z.literal("final_result"), outcome: z.literal("completed"),
  audio: measuredFile.extend({ byteLength: z.number().int().positive().max(64 * 1024 ** 2) }), video: measuredFile,
  probe: z.discriminatedUnion("state", [z.strictObject({ state: z.literal("ready"), durationSec: z.number().finite().positive() }),
    z.strictObject({ state: z.literal("unavailable"), reason: z.literal("dub_duration_unavailable") })]),
})]);
export type DubbingCheckpoint = z.infer<typeof dubbingCheckpointSchema>;
