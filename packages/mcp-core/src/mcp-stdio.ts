import { AsyncLocalStorage } from "node:async_hooks";
import { OAuthError, type JSONRPCMessage, type MessageExtraInfo, type Transport } from "@modelcontextprotocol/server";
import type { RateLimitResult } from "@narriflow/services";
import { McpAuthUnavailableError } from "./mcp-auth";
import { recordMcpDiagnostic } from "./mcp-diagnostics";
import { mcpRateLimitKey } from "./mcp-http-handler";
import { requireMcpMutationLimiter } from "./mcp-http";
import type { NarriflowMcpPrincipal } from "./mcp-tool-admission";

interface RequestAdmission { principal: NarriflowMcpPrincipal; limiter: RateLimitResult }

/** serveStdio pins its server. This transport supplies fresh admission for each inbound request. */
export function createAuthenticatedStdioTransport(options: {
  wire: Transport;
  authenticate(): Promise<NarriflowMcpPrincipal>;
  checkRateLimit(key: string, limit: number, window: number): Promise<RateLimitResult>;
  diagnostic?: typeof recordMcpDiagnostic;
}) {
  const current = new AsyncLocalStorage<RequestAdmission>();
  const diagnostic = options.diagnostic ?? recordMcpDiagnostic;
  const wire = options.wire;
  const transport: Transport = {
    async start() {
      wire.onclose = () => transport.onclose?.();
      wire.onerror = (error) => transport.onerror?.(error);
      wire.onmessage = (message, extra) => { void receive(message, extra); };
      await wire.start();
    },
    send: (message, extra) => wire.send(message, extra),
    close: () => wire.close(),
    setProtocolVersion: (version) => wire.setProtocolVersion?.(version),
    setSupportedProtocolVersions: (versions) => wire.setSupportedProtocolVersions?.(versions),
  };
  async function receive(message: JSONRPCMessage, extra?: MessageExtraInfo) {
    if (!("method" in message)) { transport.onmessage?.(message, extra); return; }
    const started = performance.now();
    try {
      const principal = await options.authenticate();
      const limiter = "id" in message ? await options.checkRateLimit(mcpRateLimitKey(principal), 300, 60) :
        { allowed: true, remaining: 300, limit: 300, availability: "available" as const };
      if (!limiter.allowed) {
        if ("id" in message) await wire.send({ jsonrpc: "2.0", id: message.id,
          error: { code: -32002, message: "MCP request limit exceeded", data: { error: "rate_limited", retryAfterSeconds: 60 } } });
        return;
      }
      diagnostic({ event: "authentication", transport: "stdio", outcome: "accepted", durationMs: performance.now() - started });
      current.run({ principal, limiter }, () => transport.onmessage?.(message, extra));
    } catch (error) {
      const unavailable = error instanceof McpAuthUnavailableError || !(error instanceof OAuthError);
      diagnostic({ event: "authentication", transport: "stdio", outcome: unavailable ? "unavailable" : "denied", durationMs: performance.now() - started });
      if ("id" in message) {
        await wire.send({ jsonrpc: "2.0", id: message.id, error: { code: unavailable ? -32002 : -32001,
          message: unavailable ? "Credential verification is temporarily unavailable" : "Credential is invalid or revoked",
          data: { error: unavailable ? "temporarily_unavailable" : "invalid_token", ...(unavailable ? { retryAfterSeconds: 5 } : {}) } } });
      }
    }
  }
  return {
    transport,
    async authenticatePrincipal() {
      const admission = current.getStore();
      if (!admission) throw new Error("Stdio request admission is missing");
      return admission.principal;
    },
    assertNewMutationAllowed() {
      const admission = current.getStore();
      if (!admission) throw new Error("Stdio request admission is missing");
      requireMcpMutationLimiter(admission.limiter);
    },
  };
}
