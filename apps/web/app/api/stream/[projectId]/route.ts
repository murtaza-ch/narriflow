import Redis from "ioredis";
import { freshAuthenticatedRequestPolicy } from "@/lib/authenticated-request-policy.server";
import { AuthenticatedRequestUnexpectedError } from "@/lib/authenticated-request-policy";
import {
  boundedRedisRetryDelay,
  getWorkflowChannel,
  getWorkflowEventsSince,
  installOptionalRedisErrorHandler,
  OPTIONAL_REDIS_COMMAND_TIMEOUT_MS,
  OPTIONAL_REDIS_CONNECT_TIMEOUT_MS,
  optionalRedisUrl,
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
import {
  createWorkflowStreamReauthorizationGuard,
  workflowStreamAuthorizationResult,
} from "@/lib/workflow-stream-reauthorization";

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
  const { projectId } = await context.params;
  let admission;
  try {
    admission = await freshAuthenticatedRequestPolicy.execute({
      adapter: "stream",
      operationName: "open-workflow-progress-stream",
      admission: { kind: "project", capability: "content.view", projectId },
      operation: async ({ actor }) => actor,
    });
  } catch (error) {
    const requestId =
      error instanceof AuthenticatedRequestUnexpectedError
        ? error.requestId
        : crypto.randomUUID();
    console.warn(JSON.stringify({
        level: "error",
        message: "workflow_progress_stream_admission_failed",
        requestId,
    projectId,
      }),
    );
    return Response.json(
      {
        error: "internal_error",
        message: "The progress stream is temporarily unavailable.",
        requestId,
      }, {
      status: 500,
      headers: { "X-Request-ID": requestId } },
  );
  }

  if (!admission.ok) {
    const headers: Record<string, string> = { "Content-Type": "application/json",
      "X-Request-ID": admission.requestId,
    };
    if (admission.failure.retryAfterSeconds) {
      headers["Retry-After"] = String(admission.failure.retryAfterSeconds);
  }
    return new Response(JSON.stringify({ error: admission.failure.code,
        message: admission.failure.message,
        requestId: admission.requestId,
        ...(admission.failure.details
          ? { details: admission.failure.details }
          : {}),
      }), {
      status: admission.failure.status,
      headers },
    );
  }

  const channel = getWorkflowChannel(projectId);
  const redisUrl = optionalRedisUrl(process.env.UPSTASH_REDIS_URL);
  const requestedSinceSeq = Number(
    req.url ? (new URL(req.url).searchParams.get("sinceSeq") ?? "0") : "0",
  );
  const sinceSeq = normalizeWorkflowSeq(requestedSinceSeq) ?? 0;
  const encoder = new TextEncoder();

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let fallbackPoller: ReturnType<typeof setInterval> | null = null;
  let fallbackPollInFlight = false;
  let authorizationGuard: ReturnType<
    typeof createWorkflowStreamReauthorizationGuard
  > | null = null;
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
    authorizationGuard?.stop();
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
            controller.enqueue(encoder.encode(sseEvent("workflow.stage.updated", event)),
            );
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

          const enqueueRedisEvent = async (event: WorkflowStageUpdatedEvent,
          ) => {
            if (!streamActive || !isAfterWorkflowCursor(lastSentSeq, event.seq)) return;

            if (event.seq > lastSentSeq + 1) {
              let missingEvents: Awaited<ReturnType<typeof getWorkflowEventsSince>>;
              try {
                missingEvents = await getWorkflowEventsSince(projectId, lastSentSeq,
                );
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
              controller.enqueue(encoder.encode(sseEvent("workflow.stage.updated", event)),
              );
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
          const catchUpEvents = await getWorkflowEventsSince(projectId, lastSentSeq,
          );
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

      authorizationGuard = createWorkflowStreamReauthorizationGuard({
        authorize: async () => {
          const result = await freshAuthenticatedRequestPolicy.execute({
            adapter: "stream",
            operationName: "reauthorize-workflow-progress-stream",
            admission: {
              kind: "project",
              capability: "content.view", projectId,
            },
            operation: async () => true,
          });
          return workflowStreamAuthorizationResult(result);
        },
        onAuthorized: () => {
          controller.enqueue(
            encoder.encode(sseEvent("ping", { ts: Date.now() })),
          );
        },
        onRevoked: (control) => {
          try {
            controller.enqueue(
              encoder.encode(sseEvent("authorization.revoked", control)),
            );
          } catch {
            // The connection may close at the same time as revocation.
          }
        },
        cleanup,
        close: () => {
          try {
            controller.close();
          } catch {
            // Client and expiry check may close concurrently.
          }
        },
        unexpectedControl: (error) => {
          const requestId =
            error instanceof AuthenticatedRequestUnexpectedError
              ? error.requestId
              : null;
          return {
            error: "internal_error",
            ...(requestId ? { requestId } : {}),
          };
        },
      });
      heartbeat = setInterval(() => {
        void authorizationGuard?.check();
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
      "X-Request-ID": admission.requestId,
      "X-Accel-Buffering": "no",
    },
  });
}
