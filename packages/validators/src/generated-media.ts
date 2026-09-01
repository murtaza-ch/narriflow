import { z } from "zod";

export const generatedMediaPromptOriginSchema = z.enum([
  "transcript_selection",
  "broll_cue",
  "manual",
]);
export const generatedImageAspectRatioSchema = z.enum(["9:16", "16:9", "1:1"]);
export const generatedImageStyleSchema = z.enum([
  "editorial",
  "cinematic",
  "photoreal",
  "illustration",
]);

export const createGeneratedImageSchema = z.object({
  projectId: z.string().uuid(),
  clipId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(160),
  // Absolute transport ceiling; the deployment-specific admission limit is
  // enforced by the generated-media module before usage is reserved.
  prompt: z.string().trim().min(3).max(20_000),
  promptOrigin: generatedMediaPromptOriginSchema,
  aspectRatio: generatedImageAspectRatioSchema,
  style: generatedImageStyleSchema,
  sourceStartSec: z.number().finite().nonnegative().nullable().optional(),
  sourceEndSec: z.number().finite().nonnegative().nullable().optional(),
  sourceCueAtSec: z.number().finite().nonnegative().nullable().optional(),
}).strict().superRefine((value, context) => {
  if (
    value.promptOrigin === "transcript_selection" &&
    !(value.sourceStartSec != null && value.sourceEndSec != null && value.sourceEndSec > value.sourceStartSec)
  ) {
    context.addIssue({ code: "custom", path: ["sourceEndSec"], message: "selection source range is required" });
  }
  if (value.promptOrigin === "broll_cue" && value.sourceCueAtSec == null) {
    context.addIssue({ code: "custom", path: ["sourceCueAtSec"], message: "B-roll cue time is required" });
  }
});

export const listGeneratedMediaJobsSchema = z.object({
  projectId: z.string().uuid(),
  clipId: z.string().uuid().optional(),
}).strict();

export const generatedMediaJobIdSchema = z.string().uuid();

export type CreateGeneratedImageInput = z.infer<typeof createGeneratedImageSchema>;
