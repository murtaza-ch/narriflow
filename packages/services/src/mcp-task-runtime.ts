import { getPrismaClient } from "@narriflow/db/client";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { McpTaskPersistence, McpTaskRecord, McpTaskResolution } from "./mcp-task";
import { getWorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { getIngestJobLifecycle } from "./ingest-job-lifecycle-runtime";
import { accessibleProjectWhere } from "./project-access";
import { generationTaskState } from "./mcp-generation-task";
import { workflowStageUpdatedEventSchema } from "@narriflow/validators";
import { clipExportService } from "./clip-export.service";
import type { GenerationTaskRun } from "./mcp-generation-task";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
function task(row: { domainKind: string; status: string } & Omit<McpTaskRecord, "domainKind" | "status">): McpTaskRecord {
  return row as McpTaskRecord;
}

export function prismaMcpTaskPersistence(prisma: PrismaClient): McpTaskPersistence {
  return {
    async createOrRead(record) {
      const identity = { ownerUserId: record.ownerUserId, callerId: record.callerId, toolName: record.toolName,
        domainKind: record.domainKind, domainId: record.domainId };
      try {
        return task(await prisma.mcpTask.create({ data: { ...record, resultContract: json(record.resultContract),
          initialResult: json(record.initialResult), terminalOutcome: Prisma.DbNull } }));
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        // An empty-update Prisma upsert can race its preliminary read. The
        // unique domain identity arbitrates concurrent registrations instead.
        const existing = await prisma.mcpTask.findUnique({ where: { ownerUserId_callerId_toolName_domainKind_domainId: identity } });
        if (!existing) throw error;
        return task(existing);
      }
    },
    async read(id) { const record = await prisma.mcpTask.findUnique({ where: { id } }); return record ? task(record) : null; },
    async settle(id, outcome: McpTaskResolution, at) {
      if (outcome.status !== "working") await prisma.mcpTask.updateMany({ where: { id, status: "working" },
        data: { status: outcome.status, terminalOutcome: json(outcome), updatedAt: at } });
      return task(await prisma.mcpTask.findUniqueOrThrow({ where: { id } }));
    },
    async requestCancellation(id, at) {
      await prisma.mcpTask.updateMany({ where: { id, status: "working", cancellationRequestedAt: null }, data: { cancellationRequestedAt: at } });
    },
  };
}

export async function pruneExpiredMcpTasks() {
  const prisma = getPrismaClient();
  if (!prisma) return 0;
  return (await prisma.mcpTask.deleteMany({ where: { expiresAt: { lte: new Date() } } })).count;
}

export function getMcpTaskPersistence() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Task storage is unavailable");
  return prismaMcpTaskPersistence(prisma);
}

export async function getMcpTaskDomainState(record: McpTaskRecord) {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Task storage is unavailable");
  const project = await prisma.project.findFirst({ where: { id: record.projectId, workspaceId: record.workspaceId, ...accessibleProjectWhere() }, select: { id: true } });
  if (!project) return null;
  if (record.domainKind === "export") {
    const row = await prisma.clipExport.findFirst({ where: { id: record.domainId, projectId: record.projectId, workspaceId: record.workspaceId }, select: { status: true, errorCode: true } });
    return row ? { status: row.status, cancelled: row.errorCode === "MCP_CANCELLED" } : null;
  }
  if (record.domainKind === "ingest") {
    const row = await prisma.ingestJob.findFirst({ where: { id: record.domainId, projectId: record.projectId }, select: { status: true } });
    return row ? { status: row.status, cancelled: row.status === "cancelled" } : null;
  }
  const select = { id: true, stage: true, status: true, errorCode: true, idempotencyKey: true, contentPackId: true } as const;
  const origin = await prisma.workflowRun.findFirst({ where: { id: record.domainId, projectId: record.projectId }, select });
  if (!origin || origin.stage !== "stt") return null;
  const detection = await prisma.workflowRun.findFirst({
    where: { projectId: record.projectId, stage: "moment_detection", idempotencyKey: `${origin.idempotencyKey}__moment_detection`, contentPackId: origin.contentPackId }, select,
  });
  const renders = detection ? await prisma.clipRender.findMany({ where: {
    exportVariantId: null, clip: { projectId: record.projectId, workflowRunId: detection.id },
  }, select: { id: true, status: true, errorCode: true, failureDisposition: true } }) : [];
  const events = detection ? await prisma.workflowEvent.findMany({ where: { projectId: record.projectId, workflowRunId: detection.id },
    orderBy: { seq: "desc" }, select: { payload: true, errorCode: true } }) : [];
  const handoff = events.map((event) => workflowStageUpdatedEventSchema.safeParse(event.payload))
    .find((event) => event.success && event.data.projectId === record.projectId && event.data.workflowRunId === detection?.id && event.data.followUpWorkflowRunId);
  const renderId = handoff?.success ? handoff.data.followUpWorkflowRunId : undefined;
  // The mutable render cache can be reset or deleted by Studio or a later
  // generation. Its original Render Work Set and drain lineage retain history.
  const renderRuns = renderId ? await prisma.$queryRaw<GenerationTaskRun[]>`
    WITH RECURSIVE family AS (
      SELECT run."id", run."stage", run."status", run."errorCode", run."idempotencyKey", run."contentPackId", ARRAY[run."id"] AS visited
      FROM "WorkflowRun" AS run
      WHERE run."id" = ${renderId}::uuid AND run."projectId" = ${record.projectId}::uuid AND run."stage" = 'clip_rendering'
      UNION ALL
      SELECT child."id", child."stage", child."status", child."errorCode", child."idempotencyKey", child."contentPackId", family.visited || child."id"
      FROM family INNER JOIN "WorkflowRun" AS child ON child."idempotencyKey" = 'drain-' || family."id"::text
      WHERE child."projectId" = ${record.projectId}::uuid AND child."stage" = 'clip_rendering' AND NOT child."id" = ANY(family.visited)
    ) SELECT "id", "stage", "status", "errorCode", "idempotencyKey", "contentPackId" FROM family
  ` : [];
  const renderEvents = renderRuns.length ? await prisma.workflowEvent.findMany({ where: { projectId: record.projectId,
    workflowRunId: { in: renderRuns.map((run) => run.id) } }, orderBy: { seq: "asc" }, select: { payload: true, errorCode: true } }) : [];
  const renderOutcomes = [...events].reverse().concat(renderEvents).flatMap((event) => {
    const parsed = workflowStageUpdatedEventSchema.safeParse(event.payload);
    return parsed.success && parsed.data.projectId === record.projectId
      ? (parsed.data.generationRenderResults ?? []).map((result) => ({ id: result.renderId, status: result.status, errorCode: result.errorCode })) : [];
  });
  return generationTaskState({ origin, detection, renders, renderRuns, renderOutcomes,
    expectedRenderIds: handoff?.success ? handoff.data.generationRenderIds : undefined });
}

export async function cancelMcpTaskDomainWork(record: McpTaskRecord) {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Task storage is unavailable");
  if (record.domainKind === "ingest") {
    await getIngestJobLifecycle().cancelQueuedOperation({ actorUserId: record.ownerUserId, workspaceId: record.workspaceId, projectId: record.projectId, ingestJobId: record.domainId });
  } else if (record.domainKind === "generation") {
    await getWorkflowRunLifecycle().cancelQueuedGenerationOperation({ workspaceId: record.workspaceId, projectId: record.projectId, workflowRunId: record.domainId });
  } else await clipExportService.cancelQueuedOperation({ actorUserId: record.ownerUserId, workspaceId: record.workspaceId }, record.domainId);
}
