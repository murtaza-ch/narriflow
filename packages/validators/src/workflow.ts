import { z } from "zod";

export const workflowStageSchema = z.enum([
  "ingest",
  "stt",
  "moment_detection",
  "clip_rendering",
  "output_pack_generation",
  "export_bundle",
]);

export const workflowStatusSchema = z.enum(["queued", "running", "completed", "failed"]);

export const workflowStageUpdatedEventSchema = z.object({
  event: z.literal("workflow.stage.updated"),
  projectId: z.string().uuid(),
  stage: workflowStageSchema,
  status: workflowStatusSchema,
  progress: z.number().min(0).max(100),
  errorCode: z.string().nullable().default(null),
});

export type WorkflowStageUpdatedEvent = z.infer<typeof workflowStageUpdatedEventSchema>;
