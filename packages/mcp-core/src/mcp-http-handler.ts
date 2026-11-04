import { bearerAuthChallengeResponse, createMcpHandler, hostHeaderValidationResponse, OAuthError, OAuthErrorCode,
  verifyBearerToken, type McpServer, type Server, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { bearerCredential } from "@narriflow/validators/identifiers";
import { type AuthFailureThrottle } from "@narriflow/services/auth-failure-throttle";
import { logFailure } from "@narriflow/services/log-failure";
import { type RateLimitResult } from "@narriflow/services/rate-limit";
import { McpAuthUnavailableError, principalFromMcpAuth } from "./mcp-auth";
import { recordMcpDiagnostic } from "./mcp-diagnostics";
import { boundedMcpRequest, mcpCorsResponse, rejectMcpOrigin } from "./mcp-http";
import { requireNewMutationAllowed } from "@narriflow/services/rate-limit";
import { mcpToolRequiredScope, type NarriflowMcpPrincipal } from "./mcp-tool-admission";

export function mcpAuthFailureResponse(error: unknown, metadataUrl: string, requiredScopes: string[] = []) {
  if (error instanceof McpAuthUnavailableError) return Response.json({ error: "temporarily_unavailable",
    error_description: error.message }, { status: 503, headers: { "Retry-After": String(error.retryAfterSeconds), "Cache-Control": "no-store" } });
  const response = bearerAuthChallengeResponse(error, { resourceMetadataUrl: metadataUrl, requiredScopes });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function mcpRateLimitKey(principal: NarriflowMcpPrincipal) {
  return `mcp:${principal.kind}:${principal.clientId}:${principal.userId}`;
}

export interface NarriflowMcpHttpDependencies {
  verifier: OAuthTokenVerifier;
  allowedHosts(): string[];
  allowedOrigins(): string[];
  resourceMetadataUrl(): string;
  checkRateLimit(key: string, limit: number, window: number): Promise<RateLimitResult>;
  /** Failed-credential budget of the caller's address; consulted before any token lookup. */
  authFailureThrottle(request: Request, socketAddress?: string): AuthFailureThrottle;
  buildServer(principal: NarriflowMcpPrincipal, options: { protocolEra: "modern" | "legacy"; assertNewMutationAllowed(): void }): McpServer | Server | Promise<McpServer | Server>;
  diagnostic?: typeof recordMcpDiagnostic;
}

export function createNarriflowMcpHttpHandler(deps: NarriflowMcpHttpDependencies) {
  const diagnostic = deps.diagnostic ?? recordMcpDiagnostic;
  const handler = createMcpHandler(({ authInfo, era }) => {
    const limiter = authInfo?.extra?.mcpLimiter as RateLimitResult;
    return deps.buildServer(principalFromMcpAuth(authInfo), { protocolEra: era, assertNewMutationAllowed: () => requireNewMutationAllowed(limiter) });
  });
  return async (input: Request, socketAddress?: string): Promise<Response> => {
    const started = performance.now();
    const origins = deps.allowedOrigins();
    const finish = (response: Response) => {
      diagnostic({ event: "request", transport: "http", outcome: response.status >= 500 ? "unavailable" :
        response.status >= 400 ? "denied" : "success", durationMs: performance.now() - started, status: response.status });
      return mcpCorsResponse(response, input, origins);
    };
    const denied = hostHeaderValidationResponse(input, deps.allowedHosts()) ?? rejectMcpOrigin(input, origins);
    if (denied) return finish(denied);
    if (input.method === "OPTIONS") return finish(new Response(null, { status: 204 }));
    const bounded = await boundedMcpRequest(input);
    if (bounded instanceof Response) return finish(bounded);
    const failures = deps.authFailureThrottle(input, socketAddress);
    if (await failures.exhausted()) {
      return finish(Response.json({ error: "rate_limited", message: "Too many failed authentication attempts from this address" },
        { status: 429, headers: { "Retry-After": String(failures.retryAfterSeconds), "Cache-Control": "no-store" } }));
    }
    let requiredScopes: string[] = [];
    try {
      const header = bounded.headers.get("authorization") ?? "";
      if (bearerCredential(header) === null) throw new OAuthError(OAuthErrorCode.InvalidToken, "Expected one Bearer credential");
      const auth = await verifyBearerToken(header, { verifier: deps.verifier });
      const principal = principalFromMcpAuth(auth);
      diagnostic({ event: "authentication", transport: "http", outcome: "accepted", durationMs: performance.now() - started });
      if (bounded.method === "POST") {
        let message: unknown;
        try { message = await bounded.clone().json(); } catch { /* SDK reports invalid JSON. */ }
        if (message && typeof message === "object" && "method" in message &&
          ["tasks/get", "tasks/update", "tasks/cancel"].includes(String(message.method)) && "params" in message) {
          const params = message.params;
          if (params && typeof params === "object" && "taskId" in params && typeof params.taskId === "string" &&
            bounded.headers.get("MCP-Name") !== params.taskId) {
            return finish(Response.json({ jsonrpc: "2.0", id: "id" in message ? message.id : null,
              error: { code: -32020, message: "MCP-Name must match the taskId" } },
            { status: 400, headers: { "Cache-Control": "no-store" } }));
          }
        }
        if (message && typeof message === "object" && "method" in message && message.method === "tools/call" && "params" in message) {
          const params = message.params;
          if (params && typeof params === "object" && "name" in params && typeof params.name === "string") {
            const scope = mcpToolRequiredScope(params.name, "arguments" in params ? params.arguments : undefined);
            if (scope) {
              requiredScopes = [scope];
              if (!principal.scopes.includes(scope)) throw new OAuthError(OAuthErrorCode.InsufficientScope, "Application scope consent is required");
            }
          }
        }
      }
      const limiter = await deps.checkRateLimit(mcpRateLimitKey(principal), 300, 60);
      if (!limiter.allowed) return finish(Response.json({ error: "rate_limited", message: "MCP request limit exceeded" },
        { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } }));
      return finish(await handler.fetch(bounded, { authInfo: { ...auth, extra: { ...auth.extra, mcpLimiter: limiter } } }));
    } catch (error) {
      const unavailable = error instanceof McpAuthUnavailableError;
      // Only a credential the caller got wrong spends the failure budget. An OAuthError from the
      // scope check also means a valid token; anything else is our own defect, never an auth denial.
      const rejected = error instanceof OAuthError;
      if (rejected && error.code === OAuthErrorCode.InvalidToken) await failures.recordFailure().catch(() => undefined);
      if (!unavailable && !rejected) {
        logFailure("mcp_http_request_failed", error);
        diagnostic({ event: "request", transport: "http", outcome: "failure", durationMs: performance.now() - started });
      } else {
        diagnostic({ event: "authentication", transport: "http", outcome: unavailable ? "unavailable" : "denied",
          durationMs: performance.now() - started });
      }
      return finish(mcpAuthFailureResponse(error, deps.resourceMetadataUrl(), requiredScopes));
    }
  };
}
