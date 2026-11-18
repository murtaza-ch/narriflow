import { z } from "zod";
import { dubLanguageCodeSchema, dubVoiceSchema } from "./dubbing";
import { clipAspectRatioSchema } from "./clip";

const id = z.string().uuid();
const model = z.string().min(1).max(128);
/** Rounding slack for times that cross JSON and the edit-range epsilon. */
export const TIME_SLACK_SEC = 1e-6;
const seconds = z.number().finite().nonnegative().max(3600);
/** One sentence voiced on the clip's edited timeline (before inserted scene blocks). */
const dubSegmentSchema = z.strictObject({ startSec: seconds, endSec: seconds, text: z.string().trim().min(1).max(20_000).refine(value => !value.includes("\0")) });
export const frozenDubbingRequestSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("dubbing_request"), dubId: id, workflowRunId: id,
  projectId: id, workspaceId: id, actorUserId: id, clipId: id,
  editorRevision: z.number().int().nonnegative(), sourceRevision: z.number().int().positive(),
  segments: z.array(dubSegmentSchema).min(1).max(160), editedDurationSec: z.number().finite().positive().max(3600),
  sourceLanguageCode: z.union([dubLanguageCodeSchema, z.literal("auto")]).nullable(),
  targetLanguageCode: dubLanguageCodeSchema, voice: dubVoiceSchema, aspectRatio: clipAspectRatioSchema,
  provider: z.literal("openai"), model, translationModel: model,
}).superRefine((request, context) => {
  let previousStart = 0, length = 0;
  for (const [index, segment] of request.segments.entries()) {
    length += segment.text.length;
    if (segment.endSec < segment.startSec || segment.endSec > request.editedDurationSec + TIME_SLACK_SEC || segment.startSec < previousStart)
      context.addIssue({ code: "custom", path: ["segments", index], message: "Dub segments must be ordered within the edited duration" });
    previousStart = segment.startSec;
  }
  if (length > 100_000) context.addIssue({ code: "custom", path: ["segments"], message: "The dub transcript is too long" });
});
export type FrozenDubbingRequest = z.infer<typeof frozenDubbingRequestSchema>;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const dubbingExecutionInputSchema = z.strictObject({
  version: z.literal(1), kind: z.literal("dub_mix"), request: frozenDubbingRequestSchema, requestHash: sha256,
  bindingHash: sha256, toolchainFingerprint: sha256,
});
export type DubbingExecutionInput = z.infer<typeof dubbingExecutionInputSchema>;

const checkpoint = { version: z.literal(1), kind: z.literal("dubbing_checkpoint"), dubId: id, requestHash: sha256 };
const dubCaptionWordSchema = z.strictObject({ text: z.string().min(1).max(200), spaceBefore: z.boolean(), startSec: seconds, endSec: seconds });
const dubTimingSegmentSchema = z.strictObject({ startSec: seconds, endSec: seconds, tempo: z.number().finite().min(1).max(2), words: z.array(dubCaptionWordSchema).min(1).max(2000) });
const stageCheckpointSchema = z.discriminatedUnion("stage", [
  z.strictObject({ ...checkpoint, stage: z.literal("translation_intent"), bodySha256: sha256 }),
  z.strictObject({ ...checkpoint, stage: z.literal("speech_intent"), bodySha256: sha256 }),
  z.strictObject({ ...checkpoint, stage: z.literal("translation_result"),
    segments: z.array(z.string().trim().min(1).max(20_000).refine(value => !value.includes("\0"))).min(1).max(160),
    providerRequestId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/).nullable() }),
  z.strictObject({ ...checkpoint, stage: z.literal("timing"), segments: z.array(dubTimingSegmentSchema).min(1).max(160) }),
]);
const measuredFile = z.strictObject({ byteLength: z.number().int().positive().safe().max(10 * 1024 ** 3), sha256 });
const failedProviderStage = z.enum(["translation", "speech"]);
export const dubbingCheckpointSchema = z.union([stageCheckpointSchema,
  z.strictObject({ ...checkpoint, stage: z.literal("final_result"), outcome: z.literal("rejected"), providerStage: failedProviderStage,
    httpStatus: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404), z.literal(413), z.literal(415), z.literal(422), z.literal(429)]) }),
  z.strictObject({ ...checkpoint, stage: z.literal("final_result"), outcome: z.literal("unknown"), providerStage: failedProviderStage }),
  /** The placed narration cannot fit the clip: a known failure that releases the monthly count. */
  z.strictObject({ ...checkpoint, stage: z.literal("final_result"), outcome: z.literal("unfit"), segmentIndex: z.number().int().nonnegative().max(159) }),
  z.strictObject({ ...checkpoint, stage: z.literal("final_result"), outcome: z.literal("completed"),
  audio: measuredFile.extend({ byteLength: z.number().int().positive().max(64 * 1024 ** 2) }),
  probe: z.discriminatedUnion("state", [z.strictObject({ state: z.literal("ready"), durationSec: z.number().finite().positive() }),
    z.strictObject({ state: z.literal("unavailable"), reason: z.literal("dub_duration_unavailable") })]),
})]);
export type DubbingCheckpoint = z.infer<typeof dubbingCheckpointSchema>;
