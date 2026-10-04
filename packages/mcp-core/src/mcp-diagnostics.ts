type Diagnostic = {
  event: "authentication" | "request" | "tool";
  outcome: "accepted" | "denied" | "unavailable" | "success" | "failure";
  transport: "http" | "stdio";
  durationMs: number;
  tool?: string;
  operationId?: string;
  status?: number;
};

export function recordMcpDiagnostic(event: Diagnostic) {
  console.warn(JSON.stringify({ level: event.outcome === "failure" || event.outcome === "unavailable" ? "warn" : "info",
    message: "narriflow_mcp", event: event.event, outcome: event.outcome, transport: event.transport,
    durationMs: Math.min(3_600_000, Math.max(0, Math.round(event.durationMs))),
    ...(event.tool && /^narriflow_[a-z_]{1,70}$/.test(event.tool) ? { tool: event.tool } : {}),
    ...(event.operationId && /^[a-f0-9-]{36}$/i.test(event.operationId) ? { operationId: event.operationId } : {}),
    ...(event.status ? { status: event.status } : {}) }));
}
