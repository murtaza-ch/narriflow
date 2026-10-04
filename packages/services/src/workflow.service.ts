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

export function isWorkflowRedisDeliveryEnabled() {
  return Boolean(redisUrl);
}

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

/** Publishes an already-persisted outbox event. Persistence and domain
 * transitions are intentionally owned by WorkflowRunLifecycle. */
export async function publishPersistedWorkflowEvent(
  event: WorkflowStageUpdatedEvent,
): Promise<boolean> {
  const parsed = workflowStageUpdatedEventSchema.parse(event);
  const pub = getPublisher();
  if (!pub) return false;
  try {
    await pub.ready;
    await pub.client.publish(
      getWorkflowChannel(parsed.projectId),
      JSON.stringify(parsed),
    );
  } catch (error) {
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
    throw error;
  }
  return true;
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
    ...(row.ingestJobId ? { ingestJobId: row.ingestJobId } : {}),
    seq: row.seq,
    stage: row.stage,
    status: row.status,
    progress: row.progress,
    errorCode: row.errorCode,
    emittedAt: row.emittedAt.toISOString(),
  }));
}
