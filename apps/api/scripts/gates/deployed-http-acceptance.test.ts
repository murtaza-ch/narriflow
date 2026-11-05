import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { AcceptanceFailure, inspectProgressSocket, runDeployedHttpAcceptance, type AcceptanceInput } from "./deployed-http-acceptance.ts";

function fixture(task = true) {
  const input: AcceptanceInput = { apiOrigin: "https://api.fixture.invalid", webOrigin: "https://web.fixture.invalid", workspaceId: randomUUID(), projectId: randomUUID(), deniedWorkspaceId: randomUUID(),
    taskId: task ? randomUUID() : "", apiKey: "nf_fixture_key", sessionToken: "fixture_session_token",
    webhookSecrets: { elevenlabs: "fixture_elevenlabs", stripe: "fixture_stripe", clerk: `whsec_${Buffer.from("fixture_clerk_secret").toString("base64")}` },
    fixtures: { runId: randomUUID(), clerkEventId: `msg_gate_${randomUUID()}`, stripeEventId: `evt_gate_${randomUUID()}`, missingTaskId: randomUUID() } };
  const calls: { path: string; method: string; body: string }[] = [], socketStatuses: number[] = [], receipts = new Set<string>();
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const transport = (async (target: string | URL | Request, options: RequestInit = {}) => {
    assert.equal(options.redirect, "manual"); assert.equal(options.credentials, "omit");
    const path = new URL(String(target)).pathname, headers = new Headers(options.headers), body = String(options.body ?? "");
    calls.push({ path, method: options.method ?? "GET", body });
    const bearer = headers.get("Authorization");
    if (path === `/api/projects/${input.projectId}`) {
      if (bearer !== `Bearer ${input.sessionToken}`) return json({ error: "authentication_required" }, 401);
      if (headers.get("X-Workspace-Id") !== input.workspaceId) return json({ error: "workspace_selection_changed" }, 409);
      return json({ project: { id: input.projectId } });
    }
    // Public REST/MCP use projectView.projectId; the first-party snapshot uses id.
    if (path === `/api/v1/projects/${input.projectId}`) return bearer === `Bearer ${input.apiKey}` ? json({ project: { projectId: input.projectId } }) : json({ error: "authentication_required" }, 401);
    if (path === "/api/v1/social-accounts") return json({ error: "scope_required", details: { scope: "publishing:read" } }, 403);
    if (path.endsWith("/progress-ticket")) return headers.get("Origin") === input.webOrigin
      ? json({ ticket: "private-fixture-ticket", ticketExpiresAt: Date.now() + 30_000, subscriptionExpiresAt: Date.now() + 60_000 })
      : json({ error: "progress_origin_not_allowed" }, 403);
    if (path === "/mcp") {
      const request = JSON.parse(body), { method, params } = request, modern = headers.get("MCP-Protocol-Version") === "2026-07-28";
      if (modern) { assert.equal(headers.get("MCP-Method"), method); assert.equal(params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28"); }
      let result: any;
      if (method === "initialize") result = { protocolVersion: "2025-11-25" };
      else if (method === "tools/list") result = { tools: [{ name: "narriflow_get_project" }] };
      else if (method === "resources/list") result = { resources: ["upload", "progress", "clip-review", "publication-confirmation"].map(view => ({ uri: `ui://narriflow/v3/${view}.html` })) };
      else if (method === "resources/read") {
        const view = params.uri.split("/").at(-1).slice(0, -5);
        result = { contents: [{ mimeType: "text/html;profile=mcp-app", text: `<html data-view="${view}">fixture template</html>`, _meta: { ui: { csp: { connectDomains: [input.apiOrigin] } } } }] };
      } else if (method === "tools/call") {
        assert.ok(["narriflow_get_project", "narriflow_list_social_accounts"].includes(params.name));
        if (params.name === "narriflow_list_social_accounts") return json({ error: "insufficient_scope" }, 403);
        assert.equal(params.arguments.workspaceId, input.workspaceId); assert.equal(params.arguments.projectId, input.projectId);
        result = { resultType: "complete", cacheScope: "private", ttlMs: 0, structuredContent: { data: { project: { projectId: input.projectId } } } };
      } else if (method === "tasks/get") {
        assert.equal(headers.get("MCP-Name"), params.taskId);
        if (params.taskId === input.fixtures.missingTaskId) return json({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Task not found" } });
        assert.equal(params.taskId, input.taskId); result = { taskId: input.taskId, status: "completed", resultType: "complete" };
      } else throw new Error("Fixture received a non-read MCP method");
      const reply = { jsonrpc: "2.0", id: request.id, result };
      return modern ? new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, { headers: { "Content-Type": "text/event-stream" } }) : json(reply);
    }
    if (path.startsWith("/api/webhooks/")) {
      const provider = path.split("/").at(-1)!;
      if (provider === "zoom") return json({ error: "zoom_not_configured" }, 503);
      const supplied = provider === "clerk" ? headers.get("svix-signature")! : headers.get(provider === "stripe" ? "stripe-signature" : "elevenlabs-signature")!;
      const time = provider === "clerk" ? headers.get("svix-timestamp")! : /t=(\d+)/.exec(supplied)![1]!;
      const eventId = provider === "clerk" ? headers.get("svix-id")! : input.fixtures.stripeEventId;
      const secret = provider === "clerk" ? Buffer.from(input.webhookSecrets.clerk.slice(6), "base64") : provider === "stripe" ? input.webhookSecrets.stripe : input.webhookSecrets.elevenlabs;
      const prefix = provider === "clerk" ? `${eventId}.${time}.` : `${time}.`;
      const digest = createHmac("sha256", secret).update(prefix).update(body).digest(provider === "clerk" ? "base64" : "hex");
      if (!supplied.endsWith(digest)) return json({ error: provider === "clerk" ? "Invalid webhook signature" : "invalid_signature" }, provider === "elevenlabs" ? 401 : 400);
      const parsed = JSON.parse(body); assert.match(parsed.type, /^serverless_gate_unknown_/);
      if (provider === "stripe") { assert.ok(Number.isSafeInteger(parsed.created)); assert.equal(parsed.livemode, false); assert.equal(parsed.api_version, "2026-07-29.dahlia"); }
      if (provider === "elevenlabs") return json({ received: true, disposition: "ignored" });
      const replay = receipts.has(eventId); receipts.add(eventId);
      return provider === "clerk" ? json({ received: true, ...(replay ? { replay: true } : {}) }) : json({ received: true, disposition: replay ? "duplicate" : "ignored" });
    }
    throw new Error("Fixture received an unexpected production path");
  }) as typeof fetch;
  const progress: typeof inspectProgressSocket = async (url, origin, options) => {
    assert.equal(url.searchParams.get("ticket"), "private-fixture-ticket");
    assert.equal(url.pathname, `/api/progress/${input.projectId}`);
    assert.equal(origin, options.expectedStatus === 403 ? "https://invalid-origin.example" : input.webOrigin);
    socketStatuses.push(options.expectedStatus);
  };
  return { input, calls, socketStatuses, transport, progress };
}

test("fixture-only complete caller keeps a read-only method allowlist, signatures, bounded protocol metadata and redacted report", async () => {
  const f = fixture(), result = await runDeployedHttpAcceptance(f.input, { fetch: f.transport, progress: f.progress });
  assert.equal(result.status, "passed"); assert.ok(result.requests <= 64); assert.ok(result.checks.includes("mcp_actual_owned_task_read"));
  assert.deepEqual(f.socketStatuses, [101, 409, 403]);
  assert.equal(f.calls.filter(call => call.path === "/mcp").length, 18);
  const report = JSON.stringify(result);
  for (const privateValue of [f.input.apiKey, f.input.sessionToken, f.input.apiOrigin, f.input.webOrigin, "private-fixture-ticket"]) assert.ok(!report.includes(privateValue));
});
test("missing positive Tasks fixture refuses before making any HTTP request", async () => {
  const f = fixture(false);
  await assert.rejects(runDeployedHttpAcceptance(f.input, { fetch: f.transport, progress: f.progress }), error => error instanceof AcceptanceFailure && error.code === "positive_tasks_fixture_required");
  assert.equal(f.calls.length, 0);
});
test("a truncated HTTP response reports its body stage, status and received bytes without private response data", async () => {
  const f = fixture(), secret = "private-response-body-url-token";
  const partial = Buffer.from(`{"private":"${secret}",`);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": partial.length + 100 });
    response.write(partial);
    setTimeout(() => response.destroy(), 30);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const transport = (async (target, options) => new URL(String(target)).pathname === "/mcp"
      ? fetch(`http://127.0.0.1:${port}/private-url-token`, options) : f.transport(target, options)) as typeof fetch;
    await assert.rejects(runDeployedHttpAcceptance(f.input, { fetch: transport, progress: f.progress }), error => {
      assert.ok(error instanceof AcceptanceFailure);
      assert.equal(error.code, "acceptance_transport_failed");
      assert.equal(error.phase, "mcp_modern_tools_list"); assert.equal(error.requestIndex, 9);
      assert.deepEqual(error.diagnostics, { stage: "body", errorName: "TypeError", statusCode: 200, receivedBytes: partial.length });
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("a request deadline after partial response bytes reports the body timeout and abort names", async context => {
  const f = fixture(), timeout = AbortSignal.timeout;
  // Shorten only the clock in this fixture. Production keeps its 15-second
  // request and 180-second overall deadlines, including response consumption.
  context.mock.method(AbortSignal, "timeout", (ms: number) => timeout(ms === 15_000 ? 100 : ms));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write(Buffer.alloc(65536)); // Deliberately never finish the body.
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const transport = (async (target, options) => new URL(String(target)).pathname === "/mcp"
      ? fetch(`http://127.0.0.1:${port}/private-url-token`, options) : f.transport(target, options)) as typeof fetch;
    await assert.rejects(runDeployedHttpAcceptance(f.input, { fetch: transport, progress: f.progress }), error => {
      assert.ok(error instanceof AcceptanceFailure);
      assert.equal(error.code, "acceptance_transport_failed");
      assert.equal(error.phase, "mcp_modern_tools_list"); assert.equal(error.requestIndex, 9);
      assert.deepEqual(error.diagnostics, { stage: "body", errorName: "TimeoutError", abortName: "TimeoutError", statusCode: 200, receivedBytes: 65536 });
      return true;
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
for (const [name, bytes, errorName] of [["malformed JSON", Buffer.from("private-body-token"), "SyntaxError"], ["invalid UTF-8", new Uint8Array([255]), "TypeError"]] as const)
  test(`${name} reports a decode failure after the complete bounded body`, async () => {
    const f = fixture();
    const transport = (async (target, options) => new URL(String(target)).pathname === "/mcp"
      ? new Response(bytes, { headers: { "Content-Type": "application/json" } }) : f.transport(target, options)) as typeof fetch;
    await assert.rejects(runDeployedHttpAcceptance(f.input, { fetch: transport, progress: f.progress }), error => {
      assert.ok(error instanceof AcceptanceFailure);
      assert.deepEqual(error.diagnostics, { stage: "decode", errorName, statusCode: 200, receivedBytes: bytes.byteLength });
      assert.ok(!JSON.stringify(error).includes("private-body-token"));
      return true;
    });
  });
test("oversized response is refused before parsing", async () => {
  const f = fixture();
  await assert.rejects(runDeployedHttpAcceptance(f.input, { fetch: (async () => new Response("a".repeat(2 * 1024 * 1024 + 1))) as typeof fetch, progress: f.progress }), error => error instanceof AcceptanceFailure && error.code === "response_length_limit");
});
test("redirect is refused without a follow-up request", async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(runDeployedHttpAcceptance(f.input, { fetch: (async () => { calls++; return new Response(null, { status: 302, headers: { Location: "https://must-not-follow.invalid" } }); }) as typeof fetch, progress: f.progress }), error => error instanceof AcceptanceFailure && error.code === "http_status_mismatch");
  assert.equal(calls, 1);
});
test("CLI diagnostics omit private arguments and URLs without making HTTP requests", () => {
  const privateUrl = "https://must-not-print.invalid/private-ticket";
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../run-deployed-http-acceptance.ts", import.meta.url)), "--api-origin", privateUrl], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stderr, ""); assert.ok(!result.stdout.includes(privateUrl));
  assert.deepEqual(JSON.parse(result.stdout), { status: "failed", code: "required_argument_missing" });
});
test("the CLI reports only safe transport observations and never serializes arbitrary error names or messages", () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "narriflow-http-failure-"));
  const credentials = join(directory, "credentials.json"), settings = join(directory, "settings.json");
  const secret = "private-network-error-url-token";
  try {
    writeFileSync(credentials, JSON.stringify({ workspaceId: f.input.workspaceId, apiKey: f.input.apiKey, sessionToken: f.input.sessionToken }), { mode: 0o600 });
    writeFileSync(settings, JSON.stringify({ WEB_ORIGIN: f.input.webOrigin, ELEVENLABS_WEBHOOK_SECRET: f.input.webhookSecrets.elevenlabs,
      STRIPE_WEBHOOK_SECRET: f.input.webhookSecrets.stripe, CLERK_WEBHOOK_SECRET: f.input.webhookSecrets.clerk }), { mode: 0o600 });
    const preload = `data:text/javascript,${encodeURIComponent(`globalThis.fetch=async()=>{const error=new Error(${JSON.stringify(secret)});error.name=${JSON.stringify(secret)};throw error;};`)}`;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", preload,
      fileURLToPath(new URL("../run-deployed-http-acceptance.ts", import.meta.url)), "--credentials-file", credentials, "--settings-file", settings,
      "--api-origin", f.input.apiOrigin, "--workspace-id", f.input.workspaceId, "--project-id", f.input.projectId,
      "--denied-workspace-id", f.input.deniedWorkspaceId, "--task-id", f.input.taskId, "--journal-file", join(directory, "journal.json")], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { status: "failed", code: "acceptance_transport_failed", phase: "first_party", requestIndex: 1,
      diagnostics: { stage: "fetch", errorName: "unknown", receivedBytes: 0 } });
    for (const privateValue of [secret, f.input.apiKey, f.input.sessionToken, f.input.apiOrigin, credentials]) assert.ok(!result.stdout.includes(privateValue));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("Node ws fixture-only transport observes exact upgrade, replay refusal and Origin refusal statuses", async () => {
  const server = createServer(), sockets = new WebSocketServer({ noServer: true });
  const projectId = randomUUID(); let used = false;
  server.on("upgrade", (request, socket, head) => {
    const status = request.headers.origin !== "https://web.fixture.invalid" ? 403 : used ? 409 : 101;
    if (status !== 101) { socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return; }
    used = true; sockets.handleUpgrade(request, socket, head, webSocket => webSocket.send(JSON.stringify({ type: "connected", projectId, cursor: 0 })));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port, url = new URL(`ws://127.0.0.1:${port}/fixture`), signal = AbortSignal.timeout(5_000);
    await inspectProgressSocket(url, "https://web.fixture.invalid", { expectedStatus: 101, projectId, signal });
    await inspectProgressSocket(url, "https://web.fixture.invalid", { expectedStatus: 409, signal });
    await inspectProgressSocket(url, "https://wrong.fixture.invalid", { expectedStatus: 403, signal });
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
