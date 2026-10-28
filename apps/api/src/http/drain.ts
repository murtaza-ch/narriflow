import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "./env";
import { failureResponse, requestIdOf } from "./errors";

/** Health and readiness keep answering while draining: readiness is how the platform learns about it. */
const ALWAYS_OPEN = new Set(["/api/health", "/api/ready"]);

export const DRAIN_RETRY_AFTER_SECONDS = 5;

/**
 * New admission stops the moment draining begins: any request that arrives
 * afterwards is a 503 with `Retry-After` in the common envelope, before
 * identity, body reads or handlers. Requests already past this gate finish (or
 * are closed by their registered drain closers). `refusalHeaders` carries the
 * first-party CORS headers so a browser reads the refusal.
 */
export function drainGate(options: {
  isDraining(): boolean;
  refusalHeaders?: (request: Request) => Record<string, string>;
}): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (!options.isDraining() || ALWAYS_OPEN.has(new URL(c.req.url).pathname)) {
      await next();
      return;
    }
    const response = failureResponse({
      code: "server_draining",
      category: "unavailable",
      status: 503,
      message: "The service is restarting. Try again shortly.",
      requestId: requestIdOf(c),
      retryAfterSeconds: DRAIN_RETRY_AFTER_SECONDS,
    });
    for (const [name, value] of Object.entries(options.refusalHeaders?.(c.req.raw) ?? {})) {
      response.headers.set(name, value);
    }
    return response;
  };
}
