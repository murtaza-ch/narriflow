import { getPrismaClient } from "@narriflow/db/client";
import { workflowStageUpdatedEventSchema, type WorkflowStageUpdatedEvent } from "@narriflow/validators";
import { progressDeliveryPort } from "./progress-delivery";
import { progressEvent } from "./progress-feed";

/** Confirms delivery only after the destination Durable Object accepts it. */
export async function publishPersistedWorkflowEvent(event: WorkflowStageUpdatedEvent): Promise<boolean> {
  const port = progressDeliveryPort();
  if (!port) return false;
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Progress delivery requires a database scope");
  const parsed = workflowStageUpdatedEventSchema.parse(event);
  const project = await prisma.project.findUnique({ where: { id: parsed.projectId }, select: { workspaceId: true } });
  if (!project) return true;
  await port.publish({ projectId: parsed.projectId, workspaceId: project.workspaceId }, progressEvent({ ...parsed, ingestJobId: parsed.ingestJobId ?? null, emittedAt: new Date(parsed.emittedAt) }));
  return true;
}

export async function getLastWorkflowSeq(projectId: string) {
  const prisma = getPrismaClient();
  if (!prisma) return 0;

  const result = await prisma.workflowEvent.aggregate({
    where: { projectId },
    _max: { seq: true },
  });

  return result._max.seq ?? 0;
}

export async function getWorkflowEventsSince(projectId: string, sinceSeq = 0) {
  const prisma = getPrismaClient();
  if (!prisma) return [];

  const rows = await prisma.workflowEvent.findMany({
    where: {
      projectId,
      seq: { gt: sinceSeq },
    },
    orderBy: { seq: "asc" },
  });

  return rows.map((row) => ({
    event: "workflow.stage.updated" as const,
    projectId: row.projectId,
    workflowRunId: row.workflowRunId,
    ...(row.ingestJobId ? { ingestJobId: row.ingestJobId } : {}),
    seq: row.seq,
    stage: row.stage,
    status: row.status,
    progress: row.progress,
    errorCode: row.errorCode,
    emittedAt: row.emittedAt.toISOString(),
  }));
}
