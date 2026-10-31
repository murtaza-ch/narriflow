import { afterEach, expect, test } from "bun:test";
import { OAuthError, OAuthErrorCode, inputRequired, acceptedContent, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { NarriflowMcpServer } from "@narriflow/mcp-core/server";
import { createNarriflowMcpHttpHandler } from "@narriflow/mcp-core/http";
import { installNarriflowTasks } from "@narriflow/mcp-core/tasks";
import { createMcpTaskRegistry, type McpTaskRecord, type McpTaskResolution } from "@narriflow/services/mcp-task";
import { z } from "zod";

const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "bridge-gate", version: "1" }, "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} }, extensions: { "io.modelcontextprotocol/ui": {}, "io.modelcontextprotocol/tasks": {} } } };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

function fixture() {
  let active = true;
  let unavailable = false;
  let aborted = 0;
  const principal = { kind: "oauth" as const, userId: "11111111-1111-4111-8111-111111111111", clientId: "bridge-gate", scopes: ["projects:read", "processing:write"] };
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const domainId = "33333333-3333-4333-8333-333333333333";
  const projectId = "44444444-4444-4444-8444-444444444444";
  const rows = new Map<string, McpTaskRecord>();
  let resolution: McpTaskResolution = { status: "working" };
  const registry = createMcpTaskRegistry({ persistence: {
    createOrRead: async (record) => { const existing = [...rows.values()].find((row) => row.domainId === record.domainId); if (existing) return existing; rows.set(record.id, record); return record; },
    read: async (id) => rows.get(id) ?? null,
    settle: async (id, outcome, at) => { const row = rows.get(id)!; if (row.status === "working") { row.status = outcome.status; row.terminalOutcome = outcome; row.updatedAt = at; } return row; },
    requestCancellation: async (id, at) => { rows.get(id)!.cancellationRequestedAt = at; },
  }, authorize: async () => {}, resolve: async () => resolution, cancel: async () => {} });
  const calls: Array<{ method: string; headers: Headers; body: Record<string, unknown> | null }> = [];
  let http: ReturnType<typeof Bun.serve>;
  const handle = createNarriflowMcpHttpHandler({
    verifier: { verifyAccessToken: async (token) => {
      if (!active || token !== "nf_bridge_gate") throw new OAuthError(OAuthErrorCode.InvalidToken, "Revoked");
      return { token, clientId: "bridge-gate", scopes: ["projects:read", "processing:write"], expiresAt: 2_100_000_000,
        extra: { narriflowPrincipal: principal } };
    } },
    allowedHosts: () => [http.url.hostname], allowedOrigins: () => [http.url.origin], resourceMetadataUrl: () => `${http.url.origin}/.well-known/oauth-protected-resource/mcp`,
    checkRateLimit: async () => ({ allowed: true, remaining: 299, limit: 300, availability: "available" }), diagnostic: () => {},
    buildServer: () => {
      const server = new NarriflowMcpServer({ name: "remote-gate", version: "1" }, { capabilities: { logging: {} }, requestState: { verify: async (token) => ({ valid: token === "opaque-confirmation" }) } });
      installNarriflowTasks(server, { principal, registry: () => registry });
      server.registerTool("echo", { inputSchema: z.strictObject({ text: z.string() }) }, async (input) => ({ content: [{ type: "text", text: input.text }], structuredContent: { echo: input.text }, ttlMs: 0, cacheScope: "private", _meta: { privateGrant: "host-only" } }));
      server.registerResource("card", "ui://gate/card.html", { mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: ["https://api.narriflow.test"] } } } }, async () => ({ contents: [{ uri: "ui://gate/card.html", mimeType: "text/html;profile=mcp-app", text: "<main>Remote App</main>", _meta: { privateTemplate: "opaque" } }] }));
      server.registerTool("confirm", { inputSchema: z.strictObject({}) }, async (_, context) => {
        const accepted = acceptedContent(context.mcpReq.inputResponses, "approve", z.strictObject({ confirm: z.boolean() }));
        if (accepted?.confirm && context.mcpReq.requestState<{ valid: boolean }>()?.valid) return { content: [], structuredContent: { accepted: true }, _meta: { privateReceipt: "opaque" } };
        return inputRequired({ requestState: "opaque-confirmation", inputRequests: { approve: inputRequired.elicit({ message: "Confirm exact intent", requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] } }) } });
      });
      server.registerTool("slow", { inputSchema: z.strictObject({}) }, async (_, context) => {
        await context.mcpReq.notify({ method: "notifications/message", params: { level: "info", data: "stream-open" } });
        await new Promise<void>((resolve) => { if (context.mcpReq.signal.aborted) resolve(); else context.mcpReq.signal.addEventListener("abort", () => { aborted++; resolve(); }, { once: true }); });
        return { content: [{ type: "text", text: "cancelled" }] };
      });
      server.registerTool("narriflow_submit_video", { inputSchema: z.strictObject({ clientIdempotencyKey: z.string().uuid() }) }, async () => ({ content: [], structuredContent: { data: { projectId, operationId: domainId } }, _meta: { "narriflow/operation": { workspaceId, domainKind: "intake", domainId, projectId } } }));
      return server;
    },
  });
  http = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    calls.push({ method: request.method, headers: new Headers(request.headers), body: request.method === "POST" ? await request.clone().json() as Record<string, unknown> : null });
    if (unavailable) return new Response("private-upstream-diagnostic-nf_bridge_gate", { status: 503 });
    return handle(request);
  } });
  disposals.push(async () => { http.stop(true); });
  return { http, calls, rows, aborted: () => aborted, revoke: () => { active = false; }, restore: () => { active = true; }, unavailable: () => { unavailable = true; }, finish: (outcome: McpTaskResolution) => { resolution = outcome; } };
}
function bridge(origin: string) {
  const child = Bun.spawn([process.execPath, "run", `${import.meta.dir}/index.ts`], { cwd: `${import.meta.dir}/..`, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {
    ...process.env, NARRIFLOW_URL: origin, NARRIFLOW_API_KEY: "nf_bridge_gate", DATABASE_URL: "postgresql://poison.invalid/no_database", DIRECT_URL: "postgresql://poison.invalid/no_database", UPSTASH_REDIS_URL: "redis://poison.invalid:1", CLERK_SECRET_KEY: "poison-no-local-auth", WEB_ORIGIN: "https://poison.invalid",
  } });
  const messages: JSONRPCMessage[] = [];
  const stderr = new Response(child.stderr).text();
  const done = (async () => {
    const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let pending = "";
    while (true) { const item = await reader.read(); if (item.done) return; pending += decoder.decode(item.value, { stream: true }); let newline = pending.indexOf("\n"); while (newline >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (line) messages.push(JSON.parse(line)); newline = pending.indexOf("\n"); } }
  })();
  let closed = false;
  async function close() { if (closed) return; closed = true; child.stdin.end(); const result = await Promise.race([child.exited, Bun.sleep(2_000).then(() => { child.kill(); return -1; })]); await done; expect(result).toBe(0); }
  disposals.push(close);
  function send(message: unknown) { child.stdin.write(`${JSON.stringify(message)}\n`); child.stdin.flush(); }
  async function until(predicate: () => boolean, timeout = 3_000) { const deadline = Date.now() + timeout; while (!predicate()) { if (Date.now() > deadline) throw new Error(`Bridge response timed out; exit=${child.exitCode}; stderr=${child.exitCode !== null ? await stderr : "still running"}`); await Bun.sleep(5); } }
  async function rpc(id: number | string, method: string, params: Record<string, unknown> = {}, modern = true) {
    send({ jsonrpc: "2.0", id, method, params: modern ? { ...params, _meta: { ...meta, ...(params._meta as Record<string, unknown> | undefined) } } : params });
    await until(() => messages.some((message) => "id" in message && message.id === id && !("method" in message)));
    return messages.find((message) => "id" in message && message.id === id && !("method" in message)) as unknown as { result?: Record<string, unknown>; error?: { code: number; data?: unknown } };
  }
  return { child, messages, stderr, close, send, until, rpc };
}

test("a spawned stdio bridge forwards modern tools and private metadata with poisoned backend env", async () => {
  const remote = fixture(); const client = bridge(remote.http.url.origin);
  const discover = await client.rpc(1, "server/discover");
  expect(discover.result).toMatchObject({ capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "remote-gate" } } });
  const result = (await client.rpc(2, "tools/call", { name: "echo", arguments: { text: "remote value" } })).result;
  expect(result).toMatchObject({ structuredContent: { echo: "remote value" }, ttlMs: 0, cacheScope: "private", _meta: { privateGrant: "host-only" } });
  expect(remote.calls.every((call) => call.headers.get("Authorization") === "Bearer nf_bridge_gate")).toBe(true);
  expect(remote.calls.filter((call) => call.method === "POST").map((call) => call.headers.get("MCP-Method"))).toEqual(["server/discover", "tools/call"]);
  await client.close(); expect(await client.stderr).not.toContain("poison.invalid");
});

test("Apps resources and multi-round confirmation cross the bridge unchanged", async () => {
  const remote = fixture(); const client = bridge(remote.http.url.origin);
  const resource = (await client.rpc(1, "resources/read", { uri: "ui://gate/card.html" })).result;
  expect(resource).toMatchObject({ contents: [{ mimeType: "text/html;profile=mcp-app", text: "<main>Remote App</main>", _meta: { privateTemplate: "opaque" } }] });
  const first = (await client.rpc(2, "tools/call", { name: "confirm", arguments: {} })).result;
  expect(first).toMatchObject({ resultType: "input_required", requestState: "opaque-confirmation", inputRequests: { approve: { method: "elicitation/create" } } });
  const accepted = (await client.rpc(3, "tools/call", { name: "confirm", arguments: {}, requestState: first!.requestState, inputResponses: { approve: { action: "accept", content: { confirm: true } } } })).result;
  expect(accepted).toMatchObject({ resultType: "complete", structuredContent: { accepted: true }, _meta: { privateReceipt: "opaque" } });
  expect(remote.calls[0]!.headers.get("MCP-Name")).toBe("ui://gate/card.html");
  expect(remote.calls.at(-1)!.body).toMatchObject({ params: { requestState: "opaque-confirmation", inputResponses: { approve: { action: "accept", content: { confirm: true } } } } });
  expect((await client.rpc(4, "resources/list")).result).toMatchObject({ resources: [{ _meta: { ui: { csp: { connectDomains: ["https://api.narriflow.test"] } } } }] });
});

test("Tasks keep their negotiated methods, eventual private result, and remote revocation checks", async () => {
  const remote = fixture(); const client = bridge(remote.http.url.origin);
  expect((await client.rpc(1, "server/discover")).result).toMatchObject({ capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } });
  const created = (await client.rpc(2, "tools/call", { name: "narriflow_submit_video", arguments: { clientIdempotencyKey: "55555555-5555-4555-8555-555555555555" } })).result;
  expect(created).toMatchObject({ resultType: "task", status: "working" });
  const taskId = created!.taskId;
  expect((await client.rpc(3, "tasks/get", { taskId })).result).toMatchObject({ status: "working" });
  expect((await client.rpc(4, "tasks/update", { taskId, inputResponses: {} })).error).toBeUndefined();
  expect((await client.rpc(5, "tasks/cancel", { taskId })).error).toBeUndefined();
  expect(remote.rows.get(taskId as string)?.cancellationRequestedAt).toBeInstanceOf(Date);
  remote.finish({ status: "completed", result: { resultType: "complete", content: [], structuredContent: { done: true }, ttlMs: 0, cacheScope: "private", _meta: { privateGrant: "eventual-only" } } });
  expect((await client.rpc(6, "tasks/get", { taskId })).result).toMatchObject({ status: "completed", result: { structuredContent: { done: true }, ttlMs: 0, cacheScope: "private", _meta: { privateGrant: "eventual-only" } } });
  remote.revoke();
  expect((await client.rpc(7, "tasks/get", { taskId })).error).toMatchObject({ code: -32001, data: { httpStatus: 401, error: "invalid_token" } });
  remote.restore();
  expect((await client.rpc(8, "tasks/get", { taskId })).result).toMatchObject({ status: "completed" });
  expect(remote.calls.every((call) => call.headers.get("Authorization") === "Bearer nf_bridge_gate")).toBe(true);
  expect(remote.calls.filter((call) => call.headers.get("MCP-Method")?.startsWith("tasks/")).every((call) => call.headers.get("MCP-Name") === taskId)).toBe(true);
});

test("legacy initialize selects the negotiated HTTP version and preserves legacy envelopes", async () => {
  const remote = fixture(); const client = bridge(remote.http.url.origin);
  expect((await client.rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-host", version: "1" } }, false)).result).toMatchObject({ protocolVersion: "2025-11-25", serverInfo: { name: "remote-gate" } });
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const result = (await client.rpc(2, "tools/call", { name: "echo", arguments: { text: "legacy value" } }, false)).result;
  expect(result).toMatchObject({ structuredContent: { echo: "legacy value" }, _meta: { privateGrant: "host-only" } });
  expect(result!.resultType).toBeUndefined();
  expect(remote.calls.find((call) => call.body?.method === "tools/call")!.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
  expect((await client.rpc(3, "resources/read", { uri: "ui://gate/card.html" }, false)).result).toMatchObject({ contents: [{ text: "<main>Remote App</main>" }] });
  client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "legacy-ended", reason: "host cancelled" } });
  await client.until(() => remote.calls.some((call) => call.body?.method === "notifications/cancelled"));
  expect(remote.calls.find((call) => call.body?.method === "notifications/cancelled")!.body).toMatchObject({ params: { requestId: "legacy-ended", reason: "host cancelled" } });
});

test("modern cancellation aborts only its HTTP stream and EOF aborts outstanding requests", async () => {
  const remote = fixture(); const client = bridge(remote.http.url.origin);
  client.send({ jsonrpc: "2.0", id: "slow", method: "tools/call", params: { name: "slow", arguments: {}, _meta: meta } });
  await client.until(() => client.messages.some((message) => "method" in message && message.method === "notifications/message"));
  expect((await client.rpc(2, "tools/call", { name: "echo", arguments: { text: "concurrent" } })).result).toMatchObject({ structuredContent: { echo: "concurrent" } });
  client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow" } });
  await client.until(() => remote.aborted() === 1);
  expect(remote.calls.some((call) => call.body?.method === "notifications/cancelled")).toBe(false);
  expect((await client.rpc(3, "tools/call", { name: "echo", arguments: { text: "still open" } })).error).toBeUndefined();
  client.send({ jsonrpc: "2.0", id: "eof", method: "tools/call", params: { name: "slow", arguments: {}, _meta: meta } });
  await client.until(() => client.messages.filter((message) => "method" in message && message.method === "notifications/message").length === 2);
  await client.close();
  await client.until(() => remote.aborted() === 2);
  expect(client.messages.some((message) => "id" in message && message.id === "slow" && !("method" in message))).toBe(false);
});

test("HTTP outages become correlated errors without exposing upstream bodies or credentials", async () => {
  const remote = fixture(); const client = bridge(remote.http.url.origin); remote.unavailable();
  expect((await client.rpc("outage", "tools/call", { name: "echo", arguments: { text: "safe" } })).error).toMatchObject({ code: -32002, data: { httpStatus: 503, error: "temporarily_unavailable" } });
  await client.close();
  expect(await client.stderr).not.toContain("private-upstream-diagnostic");
  expect(await client.stderr).not.toContain("nf_bridge_gate");
  expect(JSON.stringify(client.messages)).not.toContain("private-upstream-diagnostic");
});
