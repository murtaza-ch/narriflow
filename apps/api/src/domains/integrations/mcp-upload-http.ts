import { Hono } from "hono";
import { type ActorScope } from "@narriflow/services/actor-scope";
import { type IntegrationUploadSessions } from "@narriflow/services/integration-commands";
import { isExpectedDomainFailure, boundedExpectedDomainFailureDetails } from "@narriflow/services/expected-domain-failure";
import { mcpFailureMessage } from "@narriflow/mcp-core";
import { type AuthFailureThrottle } from "@narriflow/services/auth-failure-throttle";
import { logFailure } from "@narriflow/services/log-failure";
import { domainFailureHttpStatus } from "../../http/errors";
import { createUploadSessionHttpRoutes } from "../ingest/upload-session-http";

export interface McpUploadHttpDependencies {
  admit(request: Request, workspaceId: string): Promise<{ actor: ActorScope; beforeAccept: () => void; credential?: { scopes: readonly string[] } }>;
  authenticationFailure(error: unknown): Response | null;
  /** Failed-credential budget of the caller's address; consulted before any credential lookup. */
  authFailureThrottle(request: Request, socketAddress?: string): AuthFailureThrottle;
  service: IntegrationUploadSessions;
}

/** OAuth/key uploads share the browser Upload Session HTTP adapter and its
 * durable intake state machine. All requests retain the authenticated request
 * budget; only new mutations pause during a limiter outage. */
export function createMcpUploadHttpHandler(dependencies: McpUploadHttpDependencies) {
  return async (request: Request, workspaceId: string, socketAddress?: string) => {
    const failures = dependencies.authFailureThrottle(request, socketAddress);
    if (await failures.exhausted()) {
      return Response.json({ error: "rate_limited", message: "Too many failed authentication attempts from this address" },
        { status: 429, headers: { "Cache-Control": "private, no-store", "Retry-After": String(failures.retryAfterSeconds) } });
    }
    let admitted: Awaited<ReturnType<McpUploadHttpDependencies["admit"]>>;
    try { admitted = await dependencies.admit(request, workspaceId); }
    catch (error) {
      const response = failure(error);
      // A rejected credential spends the failure budget; a bad workspace or plan does not.
      if (response.status === 401) await failures.recordFailure().catch(() => undefined);
      return response;
    }
    const routes = new Hono();
    routes.onError((error) => failure(error));
    routes.route(`/mcp/integrations/${workspaceId}`, createUploadSessionHttpRoutes({
      getActor: async (context) => {
        if (context.req.path.endsWith("/discard")) admitted.beforeAccept();
        return admitted.actor;
      },
      service: { ...dependencies.service,
        open: (actor, input) => dependencies.service.open(actor, input, admitted.beforeAccept, admitted.credential),
        finalize: (actor, input) => dependencies.service.finalize(actor, input, {}, admitted.beforeAccept) },
    }));
    const result = await routes.fetch(request);
    result.headers.set("Cache-Control", "private, no-store");
    return result;
  };

  function failure(error: unknown) {
    const auth = dependencies.authenticationFailure(error);
    if (auth) return auth;
    if (isExpectedDomainFailure(error)) {
      const status = domainFailureHttpStatus(error.kind);
      return Response.json({ error: error.code, message: mcpFailureMessage(error), details: boundedExpectedDomainFailureDetails(error.details) }, { status, headers: { "Cache-Control": "private, no-store", ...(status === 503 || status === 429 ? { "Retry-After": String(error.retryAfterSeconds ?? 5) } : {}), ...(error.code === "scope_required" ? { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="processing:write"' } : {}) } });
    }
    // Not an expected refusal: an internal defect, so a retry would only repeat it.
    logFailure("mcp_upload_request_failed", error);
    return Response.json({ error: "internal_error", message: "Upload could not be completed. Try again or contact support." }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
