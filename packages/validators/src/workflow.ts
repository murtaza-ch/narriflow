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

export const renderTerminalNotificationPayloadSchema = z
  .object({
    kind: z.enum([
      "clip_render.completed",
      "clip_render.partial",
      "clip_render.failed",
    ]),
    projectId: z.string().uuid(),
    workflowRunId: z.string().uuid(),
    requested: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.succeeded + payload.failed + payload.superseded !==
      payload.requested
    ) {
      context.addIssue({
        code: "custom",
        message: "Render notification counts must equal the requested count",
      });
    }
  });

export const workflowStageUpdatedEventSchema = z
  .object({
    event: z.literal("workflow.stage.updated"),
    projectId: z.string().uuid(),
    workflowRunId: z.string().uuid().nullable().default(null),
    ingestJobId: z.string().uuid().optional(),
    seq: z.number().int().positive(),
    stage: workflowStageSchema,
    status: workflowStatusSchema,
    progress: z.number().min(0).max(100),
    errorCode: z.string().nullable().default(null),
    followUpWorkflowRunId: z.string().uuid().optional(),
    generationRenderIds: z.array(z.string().uuid()).max(2000).optional(),
    generationRenderResults: z.array(z.strictObject({
      renderId: z.string().uuid(),
      status: z.enum(["completed", "failed"]),
      errorCode: z.string().nullable(),
    })).max(2000).optional(),
    emittedAt: z.string().datetime(),
    notification: z
      .union([
        renderTerminalNotificationPayloadSchema,
        z
          .object({
            kind: z.literal("ingest.failed"),
            projectId: z.string().uuid(),
            ingestJobId: z.string().uuid(),
          })
          .strict(),
      ])
      .optional(),
  })
  .refine(
    (event) => Boolean(event.workflowRunId) !== Boolean(event.ingestJobId),
    {
      message:
        "Workflow events require exactly one Workflow Run or Ingest Job identity",
    },
  );

export type RenderTerminalNotificationPayload = z.infer<
  typeof renderTerminalNotificationPayloadSchema
>;
export type WorkflowStageUpdatedEvent = z.infer<
  typeof workflowStageUpdatedEventSchema
>;
export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
