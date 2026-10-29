import { getActor, createRouteApp } from "../../http/admission";
import { failureResponse, requestIdOf } from "../../http/errors";
import { AuthenticatedRequestUnexpectedError } from "../../http/request-policy";
import { disableIdleTimeout, getLifecycle } from "../../server-hooks";
import { parseSinceSeq } from "@narriflow/validators/api/progress";
import { uuidParams } from "../platform/params";
import { progressAdmission as access } from "./admission";
import { type ConnectionLimits, createConnectionRegistry } from "./connections";
import {
  type ReauthorizationResult,
  reauthorizationResult,
} from "./reauthorization";
import { type ProgressStreamOptions, type SubscribeLive, openProgressStream } from "./stream";

export const PROGRESS_HEARTBEAT_MS = 15_000;
export const PROGRESS_FALLBACK_POLL_MS = 15_000;
const MAX_BUFFERED_LIVE_EVENTS = 1_000;
const MAX_QUEUED_FRAMES = 256;
/** A Clerk outage is not a sign-out: tolerate this many consecutive unavailable checks before closing. */
const MAX_CONSECUTIVE_UNAVAILABLE = 3;
const REFUSAL_RETRY_AFTER_SECONDS = 5;

export interface ProgressRouteDeps {
  getEventsSince: ProgressStreamOptions["getEventsSince"];
  /** Live delivery over Redis, or null when Redis is not configured. */
  subscribeLive: SubscribeLive | null;
  limits: ConnectionLimits;
  /** Overrides for tests; production uses the 15-second defaults. */
  timing?: { heartbeatMs?: number; fallbackPollMs?: number };
}

/** The project progress stream (`/api/stream/:projectId`). */
export function createProgressRoutes(deps: ProgressRouteDeps) {
  const registry = createConnectionRegistry(deps.limits);

  return createRouteApp(access).get("/stream/:projectId", uuidParams("projectId"), async (c) => {
    const actor = getActor(c);
    const { projectId } = c.req.valid("param");
    const requestId = requestIdOf(c);

    const admitted = registry.admit(actor.actorUserId);
    if ("refused" in admitted) {
      return failureResponse(
        admitted.refused === "capacity"
          ? {
              code: "stream_capacity_reached",
              category: "unavailable",
              status: 503,
              message: "Live progress is busy. Reconnecting shortly.",
              requestId,
              retryAfterSeconds: REFUSAL_RETRY_AFTER_SECONDS,
            }
          : {
              code: "too_many_streams",
              category: "rate_limit",
              status: 429,
              message: "Too many open progress connections.",
              requestId,
              retryAfterSeconds: REFUSAL_RETRY_AFTER_SECONDS,
            },
      );
    }

    // Admitted: lift Bun's idle timeout for this request only.
    disableIdleTimeout(c);

    const runtime = c.get("policyRuntime");
    if (!runtime) throw new Error("installRequestPolicy must precede admitted routes");
    const request = c.req.raw;
    let unavailableStreak = 0;
    // Each beat re-verifies the Bearer token and re-resolves membership,
    // Workspace status and Project from scratch: nothing is memoized across beats.
    const authorize = async (): Promise<ReauthorizationResult> => {
      const result = await runtime.policy.execute(
        {
          adapter: "stream",
          operationName: "reauthorize-workflow-progress-stream",
          admission: { kind: "project", capability: "content.view", projectId },
          operation: async () => true,
        },
        { requestId, resolveActor: runtime.actorsFor(request).workspace },
      );
      if (result.ok) {
        unavailableStreak = 0;
      } else if (result.failure.category === "unavailable") {
        unavailableStreak += 1;
        if (unavailableStreak < MAX_CONSECUTIVE_UNAVAILABLE) return { ok: true };
      }
      return reauthorizationResult(result);
    };

    let unregisterDrain: (() => void) | undefined;
    const stream = openProgressStream({
      projectId,
      sinceSeq: parseSinceSeq(c.req.query("sinceSeq")),
      signal: request.signal,
      getEventsSince: deps.getEventsSince,
      subscribeLive: deps.subscribeLive,
      authorize,
      unexpectedControl: (error) => ({
        error: "internal_error",
        ...(error instanceof AuthenticatedRequestUnexpectedError ? { requestId: error.requestId } : {}),
      }),
      heartbeatMs: deps.timing?.heartbeatMs ?? PROGRESS_HEARTBEAT_MS,
      fallbackPollMs: deps.timing?.fallbackPollMs ?? PROGRESS_FALLBACK_POLL_MS,
      maxBufferedEvents: MAX_BUFFERED_LIVE_EVENTS,
      maxQueuedFrames: MAX_QUEUED_FRAMES,
      onClose: () => {
        admitted.release();
        unregisterDrain?.();
      },
    });
    // SIGTERM closes every open stream; one registered during a drain closes at once.
    unregisterDrain = getLifecycle(c)?.onDrain(() => stream.close());

    return new Response(stream.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Request-ID": requestId,
      },
    });
  });
}

export type ProgressRoutes = ReturnType<typeof createProgressRoutes>;
