import { createHmac } from "node:crypto";
import { WebSocket } from "ws";

const MODERN = "2026-07-28", LEGACY = "2025-11-25";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024, MAX_REQUESTS = 64;
const VIEWS = ["upload", "progress", "clip-review", "publication-confirmation"] as const;
export class AcceptanceFailure extends Error {
  readonly code: string;
  phase?: string;
  requestIndex?: number;
  constructor(code: string) { super(code); this.code = code; }
}
function requireFact(value: unknown, code: string): asserts value {
  if (!value) throw new AcceptanceFailure(code);
}
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export interface AcceptanceInput {
  apiOrigin: string;
  webOrigin: string;
  workspaceId: string;
  projectId: string;
  deniedWorkspaceId: string;
  taskId: string;
  apiKey: string;
  sessionToken: string;
  webhookSecrets: { elevenlabs: string; stripe: string; clerk: string; zoom?: string };
  fixtures: { runId: string; clerkEventId: string; stripeEventId: string; missingTaskId: string };
}
export interface AcceptanceReport {
  status: "passed";
  checks: string[];
  requests: number;
  scope: string;
}

/** Use Node ws: unexpected-response exposes an exact refused upgrade status. */
export function inspectProgressSocket(url: URL, origin: string, input: { expectedStatus: number; projectId?: string; signal: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin, followRedirects: false, handshakeTimeout: 10_000, maxPayload: 64 * 1024 });
    let finished = false, opened = false, frames = 0;
    const finish = (error?: AcceptanceFailure) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); input.signal.removeEventListener("abort", aborted);
      socket.terminate();
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(new AcceptanceFailure("progress_aborted"));
    const timer = setTimeout(() => finish(new AcceptanceFailure("progress_timeout")), 12_000);
    input.signal.addEventListener("abort", aborted, { once: true });
    if (input.signal.aborted) return aborted();
    socket.on("open", () => {
      opened = true;
      if (input.expectedStatus !== 101) finish(new AcceptanceFailure("progress_refusal_missing"));
    });
    socket.on("message", (data) => {
      try {
        requireFact(++frames <= 512, "progress_frame_count_limit");
        const frame = object(JSON.parse(data.toString()));
        if (frame.type === "connected") {
          requireFact(opened && input.expectedStatus === 101 && frame.projectId === input.projectId && Number.isSafeInteger(frame.cursor), "progress_connected_scope");
          finish();
        } else if (frame.type === "event") requireFact(frame.event?.projectId === input.projectId && Number.isSafeInteger(frame.event.seq), "progress_event_scope");
        else requireFact(frame.type === "reset" && Number.isSafeInteger(frame.cursor), "progress_unexpected_frame");
      } catch { finish(new AcceptanceFailure("progress_frame_invalid")); }
    });
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      finish(response.statusCode === input.expectedStatus ? undefined : new AcceptanceFailure("progress_wrong_refusal_status"));
    });
    socket.on("close", () => { if (!finished) finish(new AcceptanceFailure("progress_closed_before_connected")); });
    socket.on("error", () => finish(new AcceptanceFailure("progress_transport_failed")));
  });
}

async function boundedJson(response: Response): Promise<Record<string, any>> {
  requireFact(Number(response.headers.get("content-length") ?? 0) <= MAX_RESPONSE_BYTES, "response_length_limit");
  const reader = response.body?.getReader();
  requireFact(reader, "response_body_missing");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; requireFact(size <= MAX_RESPONSE_BYTES, "response_length_limit"); chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const records = text.split(/\r?\n\r?\n/).flatMap(frame => {
      const raw = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      return raw ? [object(JSON.parse(raw))] : [];
    });
    const reply = records.filter(value => typeof value.id === "string" && ("result" in value || "error" in value));
    requireFact(reply.length === 1, "mcp_sse_reply_count"); return reply[0]!;
  }
  return object(JSON.parse(text));
}

/** This caller cannot start product work. Its POST allowlist consists only of
 * tickets, read-only MCP methods/tools and controlled unknown webhook events. */
export async function runDeployedHttpAcceptance(input: AcceptanceInput, dependencies: {
  fetch?: typeof fetch;
  progress?: typeof inspectProgressSocket;
} = {}): Promise<AcceptanceReport> {
  const checks: string[] = [];
  requireFact(typeof input.taskId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.taskId), "positive_tasks_fixture_required");
  const overall = AbortSignal.timeout(180_000);
  let requests = 0, rpcId = 0, phase = "first_party";
  try {
  const send = async (path: string, options: RequestInit = {}) => {
    requireFact(++requests <= MAX_REQUESTS, "request_count_limit");
    requireFact(path.startsWith("/") && !path.startsWith("//"), "request_target_invalid");
    return (dependencies.fetch ?? fetch)(new URL(path, input.apiOrigin), { ...options, redirect: "manual", credentials: "omit", signal: AbortSignal.any([overall, AbortSignal.timeout(15_000)]) });
  };
  const firstParty = (credential: string, workspaceId = input.workspaceId) => ({ Authorization: `Bearer ${credential}`, "X-Workspace-Id": workspaceId });
  const key = { Authorization: `Bearer ${input.apiKey}` };
  async function expectJson(path: string, status: number, options: RequestInit = {}, error?: string) {
    const response = await send(path, options);
    requireFact(response.status === status, "http_status_mismatch");
    const body = await boundedJson(response);
    if (error) requireFact(body.error === error, "http_error_code_mismatch");
    return body;
  }
  const project = await expectJson(`/api/projects/${input.projectId}`, 200, { headers: firstParty(input.sessionToken) });
  requireFact(project.project?.id === input.projectId, "first_party_project_identity"); checks.push("clerk_owned_project_read");
  await expectJson(`/api/projects/${input.projectId}`, 409, { headers: firstParty(input.sessionToken, input.deniedWorkspaceId) }, "workspace_selection_changed"); checks.push("first_party_inaccessible_workspace_refused");
  await expectJson(`/api/projects/${input.projectId}`, 401, { headers: firstParty(input.apiKey) }, "authentication_required"); checks.push("api_key_cannot_enter_first_party");
  phase = "rest";
  const rest = await expectJson(`/api/v1/projects/${input.projectId}`, 200, { headers: key });
  requireFact(rest.project?.projectId === input.projectId, "rest_project_identity"); checks.push("scoped_api_key_owned_project_read");
  const hinted = await expectJson(`/api/v1/projects/${input.projectId}`, 200, { headers: { ...key, "X-Workspace-Id": input.deniedWorkspaceId } });
  requireFact(hinted.project?.projectId === input.projectId, "rest_key_workspace_binding"); checks.push("rest_key_workspace_ignores_foreign_hint");
  await expectJson(`/api/v1/projects/${input.projectId}`, 401, { headers: { Authorization: `Bearer ${input.sessionToken}` } }, "authentication_required"); checks.push("clerk_session_cannot_enter_rest");
  const missingScope = await expectJson("/api/v1/social-accounts", 403, { headers: key }, "scope_required");
  requireFact(missingScope.details?.scope === "publishing:read", "rest_missing_scope_identity"); checks.push("rest_missing_publishing_scope_refused");

  phase = "progress";
  const ticket = await expectJson(`/api/projects/${input.projectId}/progress-ticket`, 200, { method: "POST", headers: { ...firstParty(input.sessionToken), Origin: input.webOrigin, "Content-Type": "application/json" }, body: "{}" });
  requireFact(typeof ticket.ticket === "string" && ticket.ticket.length <= 4096 && ticket.ticketExpiresAt > Date.now(), "progress_ticket_shape");
  const url = new URL(`/api/progress/${input.projectId}`, input.apiOrigin); url.protocol = "wss:";
  url.searchParams.set("ticket", ticket.ticket); url.searchParams.set("sinceSeq", "0");
  const progress = dependencies.progress ?? inspectProgressSocket;
  await progress(url, input.webOrigin, { expectedStatus: 101, projectId: input.projectId, signal: overall });
  await progress(url, input.webOrigin, { expectedStatus: 409, signal: overall });
  await progress(url, "https://invalid-origin.example", { expectedStatus: 403, signal: overall });
  checks.push("progress_connected_exact_project_one_use_and_origin_refusals");

  async function rpc(method: string, params: Record<string, unknown>, modern: boolean, expectedStatus = 200) {
    phase = `mcp_${modern ? "modern" : "legacy"}_${method.replaceAll("/", "_")}`;
    const version = modern ? MODERN : LEGACY, id = `acceptance-${++rpcId}`;
    const name = method === "tools/call" ? params.name : method === "resources/read" ? params.uri : method.startsWith("tasks/") ? params.taskId : undefined;
    const meta = { "io.modelcontextprotocol/protocolVersion": version,
      "io.modelcontextprotocol/clientInfo": { name: "narriflow-deployed-read-acceptance", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] }, "io.modelcontextprotocol/tasks": {} } } };
    const response = await send("/mcp", { method: "POST", headers: { ...key, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": version,
      ...(modern ? { "MCP-Method": method, ...(typeof name === "string" ? { "MCP-Name": name } : {}) } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, ...(modern ? { _meta: meta } : {}) } }) });
    requireFact(response.status === expectedStatus, "mcp_http_status_mismatch");
    const body = await boundedJson(response);
    if (expectedStatus === 200) requireFact(body.id === id, "mcp_reply_identity");
    return body;
  }
  for (const modern of [true, false]) {
    const era = modern ? "modern" : "legacy";
    if (!modern) {
      const initialized = await rpc("initialize", { protocolVersion: LEGACY, capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }, clientInfo: { name: "acceptance-legacy", version: "1" } }, false);
      requireFact(initialized.result?.protocolVersion === LEGACY, "mcp_legacy_initialize");
    }
    const tools = await rpc("tools/list", {}, modern);
    requireFact(Array.isArray(tools.result?.tools) && tools.result.tools.some((tool: any) => tool.name === "narriflow_get_project"), "mcp_tools_catalog");
    const resources = await rpc("resources/list", {}, modern);
    requireFact(Array.isArray(resources.result?.resources) && VIEWS.every(view => resources.result.resources.some((resource: any) => resource.uri === `ui://narriflow/v2/${view}.html`)), "mcp_resource_catalog");
    const read = await rpc("tools/call", { name: "narriflow_get_project", arguments: { workspaceId: input.workspaceId, projectId: input.projectId } }, modern);
    requireFact(!read.result?.isError && read.result?.structuredContent?.data?.project?.projectId === input.projectId, "mcp_owned_project_identity");
    if (modern) requireFact(read.result.cacheScope === "private" && read.result.ttlMs === 0, "mcp_private_zero_ttl");
    checks.push(`mcp_${era}_catalog_resources_and_owned_tool_read`);
    for (const view of VIEWS) {
      const app = await rpc("resources/read", { uri: `ui://narriflow/v2/${view}.html` }, modern);
      const content = app.result?.contents?.[0];
      requireFact(content?.mimeType === "text/html;profile=mcp-app" && typeof content.text === "string" && content.text.includes(`data-view="${view}"`), "mcp_apps_template");
      requireFact(content._meta?.ui?.csp?.connectDomains?.includes(input.apiOrigin), "mcp_apps_csp");
      requireFact(!content.text.includes(input.apiKey) && !content.text.includes(input.sessionToken), "mcp_apps_private_credential_leak");
    }
    checks.push(`mcp_${era}_four_apps_templates_and_csp`);
  }
  await rpc("tools/call", { name: "narriflow_list_social_accounts", arguments: { workspaceId: input.workspaceId } }, true, 403);
  checks.push("mcp_missing_publishing_scope_refused");
  const missing = await rpc("tasks/get", { taskId: input.fixtures.missingTaskId }, true);
  requireFact(missing.error?.code === -32602, "mcp_missing_task_refusal"); checks.push("mcp_tasks_negotiation_and_missing_task_isolation");
  {
    const task = await rpc("tasks/get", { taskId: input.taskId }, true);
    requireFact(task.result?.taskId === input.taskId && task.result.resultType === "complete" && ["working", "completed", "failed", "cancelled"].includes(task.result.status), "mcp_owned_task_read");
    checks.push("mcp_actual_owned_task_read");
  }

  phase = "webhooks";
  const time = String(Math.floor(Date.now() / 1000));
  const hmac = (secret: string | Buffer, prefix: string, body: string, encoding: "hex" | "base64") => createHmac("sha256", secret).update(prefix).update(body).digest(encoding);
  const unknownType = `serverless_gate_unknown_${input.fixtures.runId.replaceAll("-", "")}`;
  const scribe = `{ "type" : "${unknownType}", "data" : { "id" : "${input.fixtures.runId}" } }\n`;
  const scribeHeader = { "elevenlabs-signature": `t=${time},v0=${hmac(input.webhookSecrets.elevenlabs, `${time}.`, scribe, "hex")}` };
  const postWebhook = (path: string, body: string, headers: Record<string, string>, status: number, error?: string) => {
    phase = `webhook_${path.split("/").at(-1)}_${status}`;
    return expectJson(path, status, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }, error);
  };
  requireFact((await postWebhook("/api/webhooks/elevenlabs", scribe, scribeHeader, 200)).disposition === "ignored", "scribe_unknown_ignored");
  await postWebhook("/api/webhooks/elevenlabs", JSON.stringify(JSON.parse(scribe)), scribeHeader, 401, "invalid_signature");
  checks.push("scribe_raw_signed_unknown_and_reserialized_tamper");
  const stripe = `{ "id" : "${input.fixtures.stripeEventId}", "object" : "event", "created" : ${Number(time)}, "livemode" : false, "api_version" : "2026-07-29.dahlia", "type" : "${unknownType}", "data" : { "object" : {} } }\n`;
  const stripeHeader = { "stripe-signature": `t=${time},v1=${hmac(input.webhookSecrets.stripe, `${time}.`, stripe, "hex")}` };
  requireFact((await postWebhook("/api/webhooks/stripe", stripe, stripeHeader, 200)).disposition === "ignored", "stripe_unknown_ignored");
  requireFact((await postWebhook("/api/webhooks/stripe", stripe, stripeHeader, 200)).disposition === "duplicate", "stripe_unknown_replay");
  await postWebhook("/api/webhooks/stripe", JSON.stringify(JSON.parse(stripe)), stripeHeader, 400, "invalid_signature");
  checks.push("stripe_raw_unknown_receipt_replay_and_tamper");
  requireFact(/^whsec_[A-Za-z0-9+/]+=*$/.test(input.webhookSecrets.clerk), "clerk_webhook_secret_format");
  const clerk = `{ "type" : "${unknownType}", "data" : { "id" : "${input.fixtures.runId}" } }\n`;
  const clerkHeader = { "svix-id": input.fixtures.clerkEventId, "svix-timestamp": time,
    "svix-signature": `v1,${hmac(Buffer.from(input.webhookSecrets.clerk.slice(6), "base64"), `${input.fixtures.clerkEventId}.${time}.`, clerk, "base64")}` };
  requireFact((await postWebhook("/api/webhooks/clerk", clerk, clerkHeader, 200)).received === true, "clerk_unknown_accepted");
  requireFact((await postWebhook("/api/webhooks/clerk", clerk, clerkHeader, 200)).replay === true, "clerk_unknown_replay");
  await postWebhook("/api/webhooks/clerk", JSON.stringify(JSON.parse(clerk)), clerkHeader, 400, "Invalid webhook signature");
  checks.push("clerk_raw_unknown_receipt_replay_and_tamper_without_user_or_email_event");
  if (input.webhookSecrets.zoom) {
    const zoom = `{ "event" : "${unknownType}", "payload" : {} }\n`, headers = { "x-zm-request-timestamp": time, "x-zm-signature": `v0=${hmac(input.webhookSecrets.zoom, `v0:${time}:`, zoom, "hex")}` };
    requireFact((await postWebhook("/api/webhooks/zoom", zoom, headers, 200)).accepted === true, "zoom_unknown_accepted");
    await postWebhook("/api/webhooks/zoom", JSON.stringify(JSON.parse(zoom)), headers, 401, "zoom_signature_invalid");
    checks.push("zoom_raw_unknown_and_tamper");
  } else {
    await postWebhook("/api/webhooks/zoom", `{ "event" : "${unknownType}", "payload" : {} }\n`, {}, 503, "zoom_not_configured");
    checks.push("zoom_unconfigured_typed_unavailable");
  }
  return { status: "passed", checks, requests,
    scope: "Configured deployed production endpoints and exact supplied identities; product reads, progress protocol and controlled unknown webhook receipts only; no paid source/render/provider/email/social actions" };
  } catch (cause) {
    const failure = cause instanceof AcceptanceFailure ? cause : new AcceptanceFailure("acceptance_transport_failed");
    failure.phase = phase; failure.requestIndex = requests; throw failure;
  }
}
