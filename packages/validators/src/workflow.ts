import { z } from "zod";

export const workflowStageSchema = z.enum([
  "ingest",
  "ingest_queued",
  "ingest_downloading",
  "ingest_normalizing",
  "ingest_retrying",
  "ingest_ready",
  "stt",
  "moment_detection",
  "clip_rendering",
  "dubbing",
  "output_pack_generation",
  "export_bundle",
]);

export const workflowStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "completed",
  "partial",
  "failed",
]);

export const workflowStageUpdatedEventSchema = z.object({
  event: z.literal("workflow.stage.updated"),
  projectId: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  seq: z.number().int().positive(),
  stage: workflowStageSchema,
  status: workflowStatusSchema,
  progress: z.number().min(0).max(100),
  errorCode: z.string().nullable().default(null),
  emittedAt: z.string().datetime(),
});

export type WorkflowStageUpdatedEvent = z.infer<typeof workflowStageUpdatedEventSchema>;
export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
