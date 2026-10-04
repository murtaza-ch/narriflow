import { expect, test } from "bun:test";
import { createMcpTaskRegistry, type McpTaskRecord, type McpTaskResolution } from "@narriflow/services";
import { z } from "zod";
import { installNarriflowTasks, mcpTaskTerminalResult, NarriflowMcpServer } from "./mcp-tasks";
import { createNarriflowMcpHttpHandler } from "./mcp-http-handler";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const domainId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const key = "55555555-5555-4555-8555-555555555555";
const extension = "io.modelcontextprotocol/tasks";
function fixture() {
  const rows = new Map<string, McpTaskRecord>();
  let resolution: McpTaskResolution = { status: "working" };
  let principal = { kind: "oauth" as const, userId, clientId: "client", scopes: ["projects:read", "processing:write"] };
  const registry = createMcpTaskRegistry({ persistence: {
    createOrRead: async (record) => { const existing = [...rows.values()].find((row) => row.domainId === record.domainId); if (existing) return existing; rows.set(record.id, record); return record; },
    read: async (id) => rows.get(id) ?? null,
    settle: async (id, outcome, at) => { const row = rows.get(id)!; if (row.status === "working") { row.status = outcome.status; row.terminalOutcome = outcome; row.updatedAt = at; } return row; },
    requestCancellation: async (id, at) => { rows.get(id)!.cancellationRequestedAt = at; },
  }, authorize: async () => {}, resolve: async () => resolution, cancel: async () => {} });
  const handler = createNarriflowMcpHttpHandler({
    verifier: { verifyAccessToken: async (token) => ({ token, clientId: principal.clientId, scopes: principal.scopes, expiresAt: 2100000000,
      extra: { narriflowPrincipal: principal } }) },
    allowedHosts: () => ["localhost"], allowedOrigins: () => ["http://localhost"],
    resourceMetadataUrl: () => "http://localhost/.well-known/oauth-protected-resource/mcp",
    checkRateLimit: async () => ({ allowed: true, remaining: 299, limit: 300, availability: "available" }), diagnostic: () => {},
    buildServer: () => {
    const server = new NarriflowMcpServer({ name: "task-test", version: "1" });
    installNarriflowTasks(server, { principal, registry: () => registry });
    server.registerTool("narriflow_submit_video", {
      inputSchema: z.strictObject({ clientIdempotencyKey: z.string().uuid() }),
      outputSchema: z.strictObject({ data: z.strictObject({ projectId: z.string().uuid(), operationId: z.string().uuid() }) }),
    }, async () => ({ content: [], structuredContent: { data: { projectId, operationId: domainId } },
      _meta: { "narriflow/operation": { workspaceId, domainKind: "ingest", domainId, projectId }, privateGrant: "must-not-survive" } }));
    return server;
    },
  });
  async function rpc(method: string, params: Record<string, unknown> = {}, tasks = true, options: { headers?: Record<string, string>; metadata?: Record<string, unknown> } = {}) {
    const metadata = options.metadata ?? { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": { extensions: tasks ? { [extension]: {} } : {} } };
    const name = method === "tools/call" ? String(params.name) : method.startsWith("tasks/") ? String(params.taskId) : undefined;
    const response = await handler(new Request("http://localhost/mcp", { method: "POST", headers: {
      Host: "localhost", Authorization: "Bearer task-test",
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28",
      "MCP-Method": method, ...(name ? { "MCP-Name": name } : {}), ...options.headers,
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: metadata } }) }));
    const text = await response.text();
    const raw = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    return { ...JSON.parse(raw), httpStatus: response.status };
  }
  return { rpc, rows, finish: (outcome: McpTaskResolution) => { resolution = outcome; }, setCaller: () => { principal = { ...principal, clientId: "other" }; } };
}

test("Tasks discovery and tool handles require the negotiated modern extension", async () => {
  const h = fixture();
  expect((await h.rpc("server/discover")).result.capabilities.extensions[extension]).toEqual({});
  expect((await h.rpc("server/discover", {}, false)).result.capabilities.extensions[extension]).toBeUndefined();
  const ordinary = await h.rpc("tools/call", { name: "narriflow_submit_video", arguments: { clientIdempotencyKey: key } }, false);
  expect(ordinary.result.resultType).toBe("complete"); expect(h.rows.size).toBe(0);
  const created = await h.rpc("tools/call", { name: "narriflow_submit_video", arguments: { clientIdempotencyKey: key } });
  expect(created.result).toMatchObject({ resultType: "task", status: "working", ttlMs: 604800000, pollIntervalMs: 5000 });
  expect(created.result.taskId).toBeString();
  expect(created.result._meta["narriflow/operation"]).toEqual({ workspaceId, domainKind: "ingest", domainId, projectId });
  expect(created.result._meta.privateGrant).toBeUndefined();
});
test("expired retained Tasks do not block an accepted operation replay", async () => {
  const h = fixture();
  const request = { name: "narriflow_submit_video", arguments: { clientIdempotencyKey: key } };
  const created = (await h.rpc("tools/call", request)).result;
  h.rows.get(created.taskId)!.expiresAt = new Date(0);
  const replay = await h.rpc("tools/call", request);
  expect(replay.error).toBeUndefined();
  expect(replay.result).toMatchObject({ resultType: "complete", structuredContent: { data: { projectId, operationId: domainId } } });
  expect((await h.rpc("tasks/get", { taskId: created.taskId })).error.code).toBe(-32602);
  expect(h.rows.size).toBe(1);
});
test("Tasks preserve SDK method/name validation and reject malformed extension input", async () => {
  const h = fixture();
  const created = (await h.rpc("tools/call", { name: "narriflow_submit_video", arguments: { clientIdempotencyKey: key } })).result;
  const params = { taskId: created.taskId };
  expect((await h.rpc("tasks/get", params, true, { headers: { "MCP-Name": key } })).httpStatus).toBe(400);
  expect((await h.rpc("tasks/get", params, true, { headers: { "MCP-Method": "tasks/cancel" } })).httpStatus).toBe(400);
  expect((await h.rpc("tasks/update", { ...params, inputResponses: [] })).error.code).toBe(-32602);
  expect((await h.rpc("tasks/update", params)).error.code).toBe(-32602);
  expect((await h.rpc("tasks/get", { taskId: "invalid" })).error.code).toBe(-32602);
  expect((await h.rpc("narriflow-extension/tasks/get", params)).error.code).toBe(-32601);
  const malformed = await h.rpc("tasks/get", params, true, { metadata: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { extensions: { [extension]: [] } },
  } });
  expect(malformed.httpStatus).toBe(400);
});
test("modern get/update/cancel wire methods reconnect and preserve immutable terminal outcomes", async () => {
  const h = fixture();
  const created = (await h.rpc("tools/call", { name: "narriflow_submit_video", arguments: { clientIdempotencyKey: key } })).result;
  const params = { taskId: created.taskId };
  const inspected = await h.rpc("tasks/get", params);
  expect(inspected.error).toBeUndefined();
  expect(inspected.result).toMatchObject({ resultType: "complete", status: "working" });
  expect((await h.rpc("tasks/update", { ...params, inputResponses: {} })).result.resultType).toBe("complete");
  expect((await h.rpc("tasks/cancel", params)).result.resultType).toBe("complete");
  h.finish({ status: "completed", result: { resultType: "complete", content: [], structuredContent: { done: true } } });
  expect((await h.rpc("tasks/get", params)).result).toMatchObject({ status: "completed", result: { structuredContent: { done: true } } });
  h.finish({ status: "failed", error: { code: -1, message: "Late failure" } });
  expect((await h.rpc("tasks/get", params)).result.status).toBe("completed");
  expect((await h.rpc("tasks/get", params, false)).error.code).toBe(-32601);
  h.setCaller(); expect((await h.rpc("tasks/get", params)).error.code).toBe(-32602);
});
test("eventual Task ToolResults carry private zero-TTL cache fields on the wire", async () => {
  const h = fixture();
  const created = (await h.rpc("tools/call", { name: "narriflow_submit_video", arguments: { clientIdempotencyKey: key } })).result;
  const record = h.rows.get(created.taskId)!;
  record.initialResult = { structuredContent: { data: { projectId, operationId: domainId, operationKind: "ingest", status: "accepted",
    statusTool: "narriflow_get_project", reviewUrl: "http://localhost/projects/project" } } };
  h.finish({ status: "completed", result: mcpTaskTerminalResult(record, "completed") });
  const eventual = (await h.rpc("tasks/get", { taskId: created.taskId })).result;
  expect(eventual).toMatchObject({ status: "completed", result: { resultType: "complete", ttlMs: 0, cacheScope: "private",
    structuredContent: { data: { projectId, status: "completed" } } } });
});
