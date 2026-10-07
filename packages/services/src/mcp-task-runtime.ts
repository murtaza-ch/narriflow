import { getPrismaClient } from "@narriflow/db/client";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { McpTaskPersistence, McpTaskRecord, McpTaskResolution } from "./mcp-task";
import { getWorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { getIngestJobLifecycle } from "./ingest-job-lifecycle-runtime";
import { clipExportService } from "./clip-export.service";

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

export async function cancelMcpTaskDomainWork(record: McpTaskRecord) {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Task storage is unavailable");
  if (record.domainKind === "intake") {
    // After handoff the intake continues as its stored generation run.
    const handedOff = await prisma.ingestJob.findFirst({ where: { id: record.domainId, projectId: record.projectId }, select: { generationRunId: true } });
    if (handedOff?.generationRunId) {
      await getWorkflowRunLifecycle().cancelQueuedGenerationOperation({ workspaceId: record.workspaceId, projectId: record.projectId, workflowRunId: handedOff.generationRunId });
      return;
    }
    await getIngestJobLifecycle().cancelQueuedOperation({ actorUserId: record.ownerUserId, workspaceId: record.workspaceId, projectId: record.projectId, ingestJobId: record.domainId });
  } else if (record.domainKind === "generation") {
    await getWorkflowRunLifecycle().cancelQueuedGenerationOperation({ workspaceId: record.workspaceId, projectId: record.projectId, workflowRunId: record.domainId });
  } else await clipExportService.cancelQueuedOperation({ actorUserId: record.ownerUserId, workspaceId: record.workspaceId }, record.domainId);
}
