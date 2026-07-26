import Redis from "ioredis";
import { getPrismaClient } from "@narriflow/db/client";
import { workflowStageUpdatedEventSchema, type WorkflowStageUpdatedEvent } from "@narriflow/validators";
import {
  boundedRedisRetryDelay,
  installOptionalRedisErrorHandler,
  OPTIONAL_REDIS_COMMAND_TIMEOUT_MS,
  OPTIONAL_REDIS_CONNECT_TIMEOUT_MS,
  OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS,
  optionalRedisFailureCode,
  optionalRedisUrl,
} from "./optional-redis";

const redisUrl = optionalRedisUrl(process.env.UPSTASH_REDIS_URL);

let publisher: Redis | null = null;
let publisherReady: Promise<void> | null = null;
let publisherRetryAfter = 0;

function resetPublisher(client: Redis): boolean {
  const wasCurrentPublisher = publisher === client;
  if (wasCurrentPublisher) {
    publisher = null;
    publisherReady = null;
    publisherRetryAfter = Date.now() + OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS;
  }
  client.disconnect();
  return wasCurrentPublisher;
}

function getPublisher() {
  if (!redisUrl || Date.now() < publisherRetryAfter) {
    return null;
  }

  if (!publisher) {
    let nextPublisher: Redis;
    try {
      nextPublisher = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
        connectTimeout: OPTIONAL_REDIS_CONNECT_TIMEOUT_MS,
        commandTimeout: OPTIONAL_REDIS_COMMAND_TIMEOUT_MS,
        retryStrategy: (attempt) => boundedRedisRetryDelay(attempt, 2),
      });
    } catch {
      publisherRetryAfter = Date.now() + OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS;
      return null;
    }
    installOptionalRedisErrorHandler(nextPublisher);
    nextPublisher.on("end", () => {
      if (publisher === nextPublisher) {
        publisher = null;
        publisherReady = null;
        publisherRetryAfter = Date.now() + OPTIONAL_REDIS_RECOVERY_COOLDOWN_MS;
      }
    });
    publisher = nextPublisher;
    publisherReady = nextPublisher.connect();
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
    } catch (error) {
      // Redis unavailable — event is persisted in DB, just no real-time push.
      // Log so a flapping Redis is debuggable instead of silently degrading.
      if (resetPublisher(pub.client)) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "workflow_event_publish_failed",
            projectId: parsed.projectId,
            errorCode: optionalRedisFailureCode(error),
          }),
        );
      }
    }
  }

  return parsed;
}
