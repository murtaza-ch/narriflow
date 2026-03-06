import Redis from "ioredis";
import { getPrismaClient } from "@narriflow/db/client";
import { workflowStageUpdatedEventSchema, type WorkflowStageUpdatedEvent } from "@narriflow/validators";

const redisUrl = process.env.UPSTASH_REDIS_URL;

let publisher: Redis | null = null;
let publisherReady: Promise<void> | null = null;

function getPublisher() {
  if (!redisUrl) {
    return null;
  }

  if (!publisher) {
    publisher = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    publisherReady = publisher.connect();
  }

  return { client: publisher, ready: publisherReady! };
}

export function getWorkflowChannel(projectId: string) {
  return `workflow:${projectId}`;
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
    seq: row.seq,
    stage: row.stage,
    status: row.status,
    progress: row.progress,
    errorCode: row.errorCode,
    emittedAt: row.emittedAt.toISOString(),
  }));
}

export async function publishWorkflowStageUpdated(
  event: Omit<WorkflowStageUpdatedEvent, "seq" | "emittedAt">,
) {
  const prisma = getPrismaClient();
  if (!prisma) return null;

  const emittedAt = new Date();

  const nextSeq = await prisma.$transaction(async (tx) => {
    const result = await tx.workflowEvent.aggregate({
      where: { projectId: event.projectId },
      _max: { seq: true },
    });
    const seq = (result._max.seq ?? 0) + 1;

    await tx.workflowEvent.create({
      data: {
        projectId: event.projectId,
        workflowRunId: event.workflowRunId,
        seq,
        stage: event.stage,
        status: event.status,
        progress: event.progress,
        errorCode: event.errorCode,
        emittedAt,
      },
    });

    return seq;
  });

  const parsed = workflowStageUpdatedEventSchema.parse({
    ...event,
    seq: nextSeq,
    emittedAt: emittedAt.toISOString(),
  });

  const pub = getPublisher();
  if (pub) {
    try {
      await pub.ready;
      await pub.client.publish(getWorkflowChannel(parsed.projectId), JSON.stringify(parsed));
    } catch {
      // Redis unavailable — event is persisted in DB, just no real-time push.
    }
  }

  return parsed;
}
