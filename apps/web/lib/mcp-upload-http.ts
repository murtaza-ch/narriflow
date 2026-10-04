import { Hono } from "hono";
import type { ActorScope, UploadSessionService } from "@narriflow/services";
import { isExpectedDomainFailure, boundedExpectedDomainFailureDetails } from "@narriflow/services";
import { openUploadSessionSchema } from "@narriflow/validators";
import { createUploadSessionHttpRoutes } from "../app/api/[[...route]]/upload-session-http";

export interface McpUploadHttpDependencies {
  admit(request: Request, workspaceId: string): Promise<{ actor: ActorScope; beforeAccept: () => void }>;
  authenticationFailure(error: unknown): Response | null;
  service: Pick<UploadSessionService, "open" | "finalize" | "grant" | "status" | "discard">;
}

/** OAuth/key uploads share the browser Upload Session HTTP adapter and its
 * durable intake state machine. All requests retain the authenticated request
 * budget; only new mutations pause during a limiter outage. */
export function createMcpUploadHttpHandler(dependencies: McpUploadHttpDependencies) {
  return async (request: Request, workspaceId: string) => {
    let admitted: Awaited<ReturnType<McpUploadHttpDependencies["admit"]>>;
    try { admitted = await dependencies.admit(request, workspaceId); }
    catch (error) { return failure(error); }
    const routes = new Hono();
    routes.onError((error) => failure(error));
    routes.route(`/mcp/integrations/${workspaceId}`, createUploadSessionHttpRoutes({
      getActor: async (context) => {
        if (context.req.path.endsWith("/open")) {
          const body = await context.req.json().catch(() => null);
          const input = openUploadSessionSchema.safeParse(body);
          if (input.success) {
            try { admitted.beforeAccept(); }
            catch (limiterError) {
              if (!isExpectedDomainFailure(limiterError) || limiterError.code !== "mcp_mutations_unavailable") throw limiterError;
              try { await dependencies.service.status(admitted.actor, { clientIdempotencyKey: input.data.clientIdempotencyKey, sessionId: null, browserFingerprint: input.data.source.browserFingerprint }); }
              catch (error) {
                if (isExpectedDomainFailure(error) && error.code === "upload_session_not_found") throw limiterError;
                throw error;
              }
            }
          }
        } else if (context.req.path.endsWith("/discard")) admitted.beforeAccept();
        return admitted.actor;
      },
      service: dependencies.service,
    }));
    const result = await routes.fetch(request);
    result.headers.set("Cache-Control", "private, no-store");
    return result;
  };

  function failure(error: unknown) {
    const auth = dependencies.authenticationFailure(error);
    if (auth) return auth;
    if (isExpectedDomainFailure(error)) {
      const status = { missing: 404, invalid: 400, forbidden: 403, unauthenticated: 401, conflict: 409, unavailable: 503, payment_required: 402, unprocessable: 422, rate_limited: 429 }[error.kind] ?? 400;
      return Response.json({ error: error.code, message: error.message, details: boundedExpectedDomainFailureDetails(error.details) }, { status, headers: { "Cache-Control": "private, no-store", ...(status === 503 || status === 429 ? { "Retry-After": String(error.retryAfterSeconds ?? 5) } : {}), ...(error.code === "mcp_scope_required" ? { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="processing:write"' } : {}) } });
    }
    console.warn(JSON.stringify({ level: "error", message: "mcp_upload_request_failed" }));
    return Response.json({ error: "mcp_upload_unavailable", message: "Upload is temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "5" } });
  }
}
