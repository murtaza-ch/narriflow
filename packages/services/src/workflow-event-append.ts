import { Prisma } from "@prisma/client";
import type {
  RenderTerminalNotificationPayload,
  WorkflowStage,
  WorkflowStageUpdatedEvent,
  WorkflowStatus,
} from "@narriflow/validators";

type Tx = Prisma.TransactionClient;

/** What a Workflow Event carries beyond the run's own transition. */
export interface WorkflowEventInput {
  projectId: string;
  workflowRunId: string;
  attemptId: string;
  stage: WorkflowStage;
  status: WorkflowStatus;
  progress: number;
  errorCode: string | null;
  transition: string;
  followUpWorkflowRunId?: string;
  generationRenders?: NonNullable<WorkflowStageUpdatedEvent["generationRenders"]>;
  generationRenderResults?: NonNullable<WorkflowStageUpdatedEvent["generationRenderResults"]>;
  generationExport?: NonNullable<WorkflowStageUpdatedEvent["generationExport"]>;
  generationExportResult?: NonNullable<WorkflowStageUpdatedEvent["generationExportResult"]>;
  analyticsRequired?: boolean;
  notification?: RenderTerminalNotificationPayload;
}

/** Which deliveries the event is owed: Redis for live progress, analytics for
 * terminal runs. A record that only history reads needs neither. */
export interface WorkflowEventDelivery {
  redisRequired: boolean;
  analyticsEnabled: boolean;
}

/**
 * Appends one Workflow Event, once per `workflowRunId:attemptId:transition`.
 * The Project's event counter orders it, so the caller's transaction holds the
 * Project row from here to commit.
 */
export async function appendWorkflowEvent(tx: Tx, input: WorkflowEventInput, delivery: WorkflowEventDelivery) {
  const emittedAt = new Date();
  const dedupeKey = `${input.workflowRunId}:${input.attemptId}:${input.transition}`;
  const existing = await tx.workflowEvent.findUnique({
    where: { dedupeKey },
    select: { id: true },
  });
  if (existing) return;
  const projects = await tx.$queryRaw<Array<{ workflowEventSeq: number }>>`
    UPDATE "Project"
    SET "workflowEventSeq" = GREATEST(
      "workflowEventSeq",
      COALESCE(
        (
          SELECT MAX("seq")
          FROM "WorkflowEvent"
          WHERE "projectId" = ${input.projectId}::uuid
        ),
        0
      )
    ) + 1
    WHERE "id" = ${input.projectId}::uuid
    RETURNING "workflowEventSeq"
  `;
  const project = projects[0];
  if (!project) throw new Error("Workflow event project unavailable");
  // A render cache can be reset by Studio or deleted by a later generation.
  // Preserve its first settled results in the same durable workflow event.
  let generationRenderResults = input.generationRenderResults;
  if (input.stage === "clip_rendering" && ["completed", "partial", "failed"].includes(input.status)) {
    const renders = await tx.clipRender.findMany({ where: { workflowRunId: input.workflowRunId, exportVariantId: null },
      select: { id: true, status: true, errorCode: true } });
    generationRenderResults = renders.flatMap((render) => render.status === "completed" || render.status === "failed"
      ? [{ renderId: render.id, status: render.status as "completed" | "failed", errorCode: render.errorCode }] : []);
  }
  const payload = {
    event: "workflow.stage.updated" as const,
    projectId: input.projectId,
    workflowRunId: input.workflowRunId,
    seq: project.workflowEventSeq,
    stage: input.stage,
    status: input.status,
    progress: input.progress,
    errorCode: input.errorCode,
    emittedAt: emittedAt.toISOString(),
    ...(input.followUpWorkflowRunId ? { followUpWorkflowRunId: input.followUpWorkflowRunId } : {}),
    ...(input.generationRenders ? { generationRenders: input.generationRenders } : {}),
    ...(generationRenderResults ? { generationRenderResults } : {}),
    ...(input.generationExport ? { generationExport: input.generationExport } : {}),
    ...(input.generationExportResult ? { generationExportResult: input.generationExportResult } : {}),
    ...(input.notification ? { notification: input.notification } : {}),
  } satisfies WorkflowStageUpdatedEvent;

  await tx.workflowEvent.create({
    data: {
      projectId: input.projectId,
      workflowRunId: input.workflowRunId,
      seq: payload.seq,
      stage: input.stage,
      status: input.status,
      progress: input.progress,
      errorCode: input.errorCode,
      emittedAt,
      dedupeKey,
      eventType: payload.event,
      payload: payload as unknown as Prisma.InputJsonValue,
      availableAt: emittedAt,
      nextDeliveryAt: emittedAt,
      redisRequired: delivery.redisRequired,
      analyticsRequired: (input.analyticsRequired ?? false) && delivery.analyticsEnabled,
      notificationRequired: Boolean(input.notification),
    },
  });
}
