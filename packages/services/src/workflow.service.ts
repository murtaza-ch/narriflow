import Redis from "ioredis";
import { randomUUID } from "node:crypto";
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
    seq: row.seq,
    stage: row.stage,
    status: row.status,
    progress: row.progress,
    errorCode: row.errorCode,
    emittedAt: row.emittedAt.toISOString(),
  }));
}

export async function publishIngestWorkflowStageUpdated(
  event: Omit<WorkflowStageUpdatedEvent, "seq" | "emittedAt">,
) {
  const prisma = getPrismaClient();
  if (!prisma) return null;

  const emittedAt = new Date();

  // Ingest Jobs have a separate lifecycle but share the durable project event
  // stream. Concurrent ingest writers serialize on Project's atomic sequence.
  let nextSeq: number | null = null;
  let eventId: string | null = null;
  for (let attempt = 0; attempt < 5 && nextSeq === null; attempt++) {
    try {
      const persisted = await prisma.$transaction(async (tx) => {
        const projects = await tx.$queryRaw<Array<{ workflowEventSeq: number }>>`
          UPDATE "Project"
          SET "workflowEventSeq" = GREATEST(
            "workflowEventSeq",
            COALESCE(
              (
                SELECT MAX("seq")
                FROM "WorkflowEvent"
                WHERE "projectId" = ${event.projectId}::uuid
              ),
              0
            )
          ) + 1
          WHERE "id" = ${event.projectId}::uuid
          RETURNING "workflowEventSeq"
        `;
        const seq = projects[0]?.workflowEventSeq;
        if (!seq) throw new Error("Workflow event project unavailable");
        const id = randomUUID();
        const payload = workflowStageUpdatedEventSchema.parse({
          ...event,
          seq,
          emittedAt: emittedAt.toISOString(),
        });
        await tx.workflowEvent.create({
          data: {
            id,
            projectId: event.projectId,
            workflowRunId: event.workflowRunId,
            seq,
            stage: event.stage,
            status: event.status,
            progress: event.progress,
            errorCode: event.errorCode,
            emittedAt,
            dedupeKey: `ingest:${id}`,
            payload,
            redisRequired: isWorkflowRedisDeliveryEnabled(),
            nextDeliveryAt: emittedAt,
          },
        });
        return { seq, id };
      });
      nextSeq = persisted.seq;
      eventId = persisted.id;
    } catch (error) {
      const isSeqCollision =
        (error as { code?: string }).code === "P2002";
      if (isSeqCollision && attempt < 4) {
        continue;
      }
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "workflow_event_persist_failed",
          projectId: event.projectId,
          workflowRunId: event.workflowRunId,
          stage: event.stage,
          status: event.status,
          attempts: attempt + 1,
          errorCode: isSeqCollision ? "seq_conflict_exhausted" : "db_error",
        }),
      );
      return null;
    }
  }
  if (nextSeq === null) return null;

  const parsed = workflowStageUpdatedEventSchema.parse({
    ...event,
    seq: nextSeq,
    emittedAt: emittedAt.toISOString(),
  });

  try {
    const published = await publishPersistedWorkflowEvent(parsed);
    if (published && eventId) {
      await prisma.workflowEvent.update({
        where: { id: eventId },
        data: { redisPublishedAt: new Date() },
      });
    }
  } catch {
    // The durable outbox row remains due; the worker dispatcher retries it.
  }

  return parsed;
}
