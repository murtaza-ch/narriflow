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
    /** The renders a detection handoff froze for its generation, with their
     * clips, so outcomes keep clip identity after render or clip deletion. */
    generationRenders: z.array(z.strictObject({ renderId: z.string().uuid(), clipId: z.string().uuid() })).max(2000).optional(),
    generationRenderResults: z.array(z.strictObject({
      renderId: z.string().uuid(),
      status: z.enum(["completed", "failed"]),
      errorCode: z.string().nullable(),
    })).max(2000).optional(),
    /** The export a captioned video's detection completion admitted for its
     * generation, frozen with that completion so the generation keeps naming it
     * after the export or its clip is deleted. */
    generationExport: z.strictObject({ exportId: z.string().uuid(), clipId: z.string().uuid() }).optional(),
    /** The captioned video's export outcome the first time it was final. A later
     * retry of the export does not change what its generation reported. */
    generationExportResult: z.strictObject({
      exportId: z.string().uuid(),
      state: z.enum(["completed", "partial", "failed", "cancelled"]),
      failureCode: z.string().nullable(),
      items: z.array(z.strictObject({
        id: z.string().uuid(),
        state: z.enum(["completed", "failed", "cancelled"]),
        failureCode: z.string().nullable(),
      })).max(8),
    }).optional(),
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
