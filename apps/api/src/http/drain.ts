import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "./env";
import { failureResponse, requestIdOf } from "./errors";

/** Health and readiness keep answering while draining: readiness is how the platform learns about it. */
const ALWAYS_OPEN = new Set(["/api/health", "/api/ready"]);
const CONTINUATION_POSTS = new Set([
  "/api/execution/command", "/api/execution/transfer",
  "/api/dev-device/connect-ticket", "/api/dev-device/reconcile", "/api/dev-device/execution/command", "/api/dev-device/execution/transfer",
  "/api/ingest/local-fetch/session", "/api/webhooks/clerk", "/api/webhooks/stripe", "/api/webhooks/zoom", "/api/webhooks/elevenlabs", "/api/webhooks/tiktok/publication",
]);

/** Intake pause cannot revoke previously accepted work's callback path.
 * These routes retain their ordinary signature, ticket or actor admission. */
export function continuesAcceptedWork(method: string, path: string): boolean {
  if (ALWAYS_OPEN.has(path)) return true;
  if (method === "OPTIONS") return continuesAcceptedWork("POST",path) || continuesAcceptedWork("GET",path);
  if (method === "POST") return CONTINUATION_POSTS.has(path) || /^\/api\/projects\/[a-f0-9-]{36}\/progress-ticket$/i.test(path);
  return method === "GET" && (/^\/api\/progress\/[a-f0-9-]{36}$/i.test(path) || /^\/api\/dev-device\/[a-f0-9-]{36}\/socket$/i.test(path) || /^\/api\/v1\/operations\/[^/]+$/.test(path));
}

export const DRAIN_RETRY_AFTER_SECONDS = 5;

/** An allowed browser can preflight a paused request, then read its typed 503. */
export function drainingResponse(request: Request, input: {
  requestId: string;
  state: "closed" | "fenced";
  headers: Record<string, string>;
}): Response {
  if (input.state === "closed" && request.method === "OPTIONS" && input.headers["Access-Control-Allow-Origin"]) {
    return new Response(null, { status: 204, headers: input.headers });
  }
  const response = failureResponse({
    code: "server_draining", category: "unavailable", status: 503,
    message: "The service is restarting. Try again shortly.",
    requestId: input.requestId, retryAfterSeconds: DRAIN_RETRY_AFTER_SECONDS,
  });
  for (const [name, value] of Object.entries(input.headers)) response.headers.set(name, value);
  return response;
}

/**
 * New admission stops immediately. Authenticated continuation routes remain
 * reachable so accepted work can settle while intake is paused.
 * Refusals carry `Retry-After` before identity, body reads or handlers.
 * `refusalHeaders` carries the
 * first-party CORS headers so a browser reads the refusal.
 */
export function drainGate(options: {
  isDraining(): boolean;
  isFenced?(): boolean;
  refusalHeaders?: (request: Request) => Record<string, string>;
}): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const fenced = options.isFenced?.() ?? false;
    if (fenced ? c.req.method === "GET" && path === "/api/health" : !options.isDraining() || continuesAcceptedWork(c.req.method,path)) {
      await next();
      return;
    }
    return drainingResponse(c.req.raw, {
      state: fenced ? "fenced" : "closed",
      requestId: requestIdOf(c),
      headers: options.refusalHeaders?.(c.req.raw) ?? {},
    });
  };
}
