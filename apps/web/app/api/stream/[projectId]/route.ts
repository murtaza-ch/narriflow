import Redis from "ioredis";
import { getCurrentWorkspaceAppUser as getCurrentAppUser } from "@/lib/workspace";
import {
  boundedRedisRetryDelay,
  getWorkflowChannel,
  getWorkflowEventsSince,
  installOptionalRedisErrorHandler,
  OPTIONAL_REDIS_COMMAND_TIMEOUT_MS,
  OPTIONAL_REDIS_CONNECT_TIMEOUT_MS,
  optionalRedisUrl,
  projectService,
} from "@narriflow/services";
import {
  workflowStageUpdatedEventSchema,
  type WorkflowStageUpdatedEvent,
} from "@narriflow/validators";
import {
  advanceWorkflowCursor,
  isAfterWorkflowCursor,
  normalizeWorkflowSeq,
} from "@/lib/workflow-stream";

export const runtime = "nodejs";

const FALLBACK_POLL_INTERVAL_MS = 15_000;
const MAX_BUFFERED_REDIS_EVENTS = 1_000;

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  req: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { projectId } = await context.params;
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

  if (access === "missing") {
    return new Response(JSON.stringify({ error: "Project not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (access === "forbidden") {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const channel = getWorkflowChannel(projectId);
  const redisUrl = optionalRedisUrl(process.env.UPSTASH_REDIS_URL);
  const requestedSinceSeq = Number(
    req.url ? new URL(req.url).searchParams.get("sinceSeq") ?? "0" : "0",
  );
  const sinceSeq = normalizeWorkflowSeq(requestedSinceSeq) ?? 0;
  const encoder = new TextEncoder();

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let fallbackPoller: ReturnType<typeof setInterval> | null = null;
  let fallbackPollInFlight = false;
  let accessCheckInFlight = false;
  let lastSentSeq = sinceSeq;
  let subscriber: Redis | null = null;
  let streamActive = true;
  let abortHandler: (() => void) | null = null;

  function disconnectSubscriber() {
    if (!subscriber) return;

    const activeSubscriber = subscriber;
    subscriber = null;
    activeSubscriber.removeAllListeners("message");
    activeSubscriber.removeAllListeners("end");
    activeSubscriber.disconnect();
  }

  function cleanup() {
    streamActive = false;
    if (abortHandler !== null) {
      req.signal.removeEventListener("abort", abortHandler);
      abortHandler = null;
    }
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (fallbackPoller !== null) {
      clearInterval(fallbackPoller);
      fallbackPoller = null;
    }
    disconnectSubscriber();
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      abortHandler = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // The consumer may have closed the stream concurrently.
        }
      };
      req.signal.addEventListener("abort", abortHandler, { once: true });
      if (req.signal.aborted) {
        abortHandler();
        return;
      }

      controller.enqueue(
        encoder.encode(
          sseEvent("connected", {
            projectId,
            channel,
            sinceSeq,
            ts: new Date().toISOString(),
          }),
        ),
      );

      const enqueuePersistedEvents = (
        events: Awaited<ReturnType<typeof getWorkflowEventsSince>>,
      ): boolean => {
        for (const event of events) {
          if (!isAfterWorkflowCursor(lastSentSeq, event.seq)) continue;
          try {
            controller.enqueue(encoder.encode(sseEvent("workflow.stage.updated", event)));
          } catch {
            cleanup();
            return false;
          }
          lastSentSeq = advanceWorkflowCursor(lastSentSeq, event.seq);
        }
        return true;
      };

      const pollPersistedEvents = async () => {
        if (!streamActive || fallbackPollInFlight) return;
        fallbackPollInFlight = true;
        let events: Awaited<ReturnType<typeof getWorkflowEventsSince>>;
        try {
          events = await getWorkflowEventsSince(projectId, lastSentSeq);
        } catch {
          // The next bounded interval retries; never expose database details.
          return;
        } finally {
          fallbackPollInFlight = false;
        }
        if (streamActive) enqueuePersistedEvents(events);
      };

      const startFallbackPolling = () => {
        if (!streamActive || fallbackPoller !== null) return;
        void pollPersistedEvents();
        fallbackPoller = setInterval(() => {
          void pollPersistedEvents();
        }, FALLBACK_POLL_INTERVAL_MS);
      };

      const cachedEvents = await getWorkflowEventsSince(projectId, sinceSeq);
      if (!streamActive || !enqueuePersistedEvents(cachedEvents)) return;

      if (redisUrl) {
        try {
          const nextSubscriber = new Redis(redisUrl, {
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            lazyConnect: true,
            connectTimeout: OPTIONAL_REDIS_CONNECT_TIMEOUT_MS,
            commandTimeout: OPTIONAL_REDIS_COMMAND_TIMEOUT_MS,
            retryStrategy: (attempt) => boundedRedisRetryDelay(attempt, 3),
          });
          installOptionalRedisErrorHandler(nextSubscriber);
          subscriber = nextSubscriber;
          let catchingUp = true;
          const bufferedEvents: WorkflowStageUpdatedEvent[] = [];
          let redisDeliveryChain = Promise.resolve();

          const fallbackToPolling = () => {
            disconnectSubscriber();
            startFallbackPolling();
          };

          const enqueueRedisEvent = async (event: WorkflowStageUpdatedEvent) => {
            if (!streamActive || !isAfterWorkflowCursor(lastSentSeq, event.seq)) return;

            if (event.seq > lastSentSeq + 1) {
              let missingEvents: Awaited<ReturnType<typeof getWorkflowEventsSince>>;
              try {
                missingEvents = await getWorkflowEventsSince(projectId, lastSentSeq);
              } catch {
                fallbackToPolling();
                return;
              }

              if (!streamActive) return;
              if (!enqueuePersistedEvents(missingEvents)) {
                if (streamActive) fallbackToPolling();
                return;
              }
              if (!isAfterWorkflowCursor(lastSentSeq, event.seq)) return;
              if (event.seq !== lastSentSeq + 1) {
                fallbackToPolling();
                return;
              }
            }

            try {
              controller.enqueue(encoder.encode(sseEvent("workflow.stage.updated", event)));
              lastSentSeq = advanceWorkflowCursor(lastSentSeq, event.seq);
            } catch {
              cleanup();
            }
          };

          const queueRedisEvent = (event: WorkflowStageUpdatedEvent) => {
            redisDeliveryChain = redisDeliveryChain
              .then(() => enqueueRedisEvent(event))
              .catch(() => {
                if (streamActive) fallbackToPolling();
              });
          };

          nextSubscriber.on("end", () => {
            if (subscriber !== nextSubscriber) return;
            subscriber = null;
            nextSubscriber.removeAllListeners("message");
            startFallbackPolling();
          });

          nextSubscriber.on("message", (incomingChannel, message) => {
            if (incomingChannel !== channel) {
              return;
            }

            let payload: unknown;
            try {
              payload = JSON.parse(message) as unknown;
            } catch {
              return;
            }

            const parsed = workflowStageUpdatedEventSchema.safeParse(payload);
            if (!parsed.success || parsed.data.projectId !== projectId) return;

            if (catchingUp) {
              if (bufferedEvents.length >= MAX_BUFFERED_REDIS_EVENTS) {
                fallbackToPolling();
                return;
              }
              bufferedEvents.push(parsed.data);
              return;
            }

            queueRedisEvent(parsed.data);
          });

          await nextSubscriber.connect();
          if (!streamActive) return;
          await nextSubscriber.subscribe(channel);
          if (!streamActive) return;

          // Close the replay/subscribe race, then drain messages that arrived
          // during the database catch-up in sequence order.
          const catchUpEvents = await getWorkflowEventsSince(projectId, lastSentSeq);
          if (!streamActive) return;
          if (!enqueuePersistedEvents(catchUpEvents)) {
            if (streamActive) fallbackToPolling();
            return;
          }
          catchingUp = false;
          bufferedEvents.sort((left, right) => left.seq - right.seq);
          for (const event of bufferedEvents) {
            await enqueueRedisEvent(event);
            if (!streamActive) return;
          }
        } catch {
          // Redis unavailable — continue from the durable event log.
          disconnectSubscriber();
          startFallbackPolling();
        }
      } else {
        startFallbackPolling();
      }

      if (!streamActive) return;

      heartbeat = setInterval(() => {
        if (accessCheckInFlight) return;
        accessCheckInFlight = true;
        void projectService
          .getProjectAccess(appUser.actorUserId, projectId, appUser.workspaceId)
          .then((currentAccess) => {
            if (currentAccess !== "owned") {
              cleanup();
              try {
                controller.close();
              } catch {
                // Client and expiry check may close concurrently.
              }
              return;
            }
            controller.enqueue(
              encoder.encode(sseEvent("ping", { ts: Date.now() })),
            );
          })
          .catch(() => cleanup())
          .finally(() => {
            accessCheckInFlight = false;
          });
      }, 15000);

    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
