import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { uploadVideo } from "../../../mcp/src/upload.ts";
import { createProjectsClient } from "../../../../packages/api-client/src/projects/index.ts";
import { buildGenerationContext, generationSettingsSchema, mcpOperationStatusResultSchema } from "@narriflow/validators";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const VERSION = "2026-07-28", MAX_RESPONSE = 2 * 1024 * 1024;
export class FileJourneyFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
function fact(value: unknown, code: string): asserts value { if (!value) throw new FileJourneyFailure(code); }
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export const SPOKEN_SOURCE = { byteLength: 22_741_661, sha256: "32b20a20e84d46d17da126689572f9a431d01ddc23880b90240952875b2a3fe8", durationSeconds: 146.147 };

export interface FileJourneyJournal {
  version: 1;
  runId: string;
  workspaceId: string;
  apiOriginHash: string;
  source: { path: string; byteLength: number; sha256: string; durationSeconds: number };
  uploadKey: string;
  generationKey: string;
  generation: ReturnType<typeof generationSettingsSchema.parse>;
  projectId?: string;
  sessionId?: string;
  queuedJobId?: string;
  notificationDisabledAt?: string;
  generationOperationId?: string;
  taskId?: string;
  phase?: string;
  requests?: number;
  lastReport?: Record<string, unknown>;
}
export const originHash = (origin: string) => createHash("sha256").update(origin).digest("hex");

export async function inspectFile(path: string) {
  const info = await stat(path); fact(info.isFile(), "source_not_regular_file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { byteLength: info.size, sha256: hash.digest("hex") };
}

export function prepareFileJourney(input: { apiOrigin: string; workspaceId: string; source: FileJourneyJournal["source"] }): FileJourneyJournal {
  fact(UUID.test(input.workspaceId), "workspace_identity_invalid");
  return { version: 1, runId: randomUUID(), workspaceId: input.workspaceId, apiOriginHash: originHash(input.apiOrigin), source: input.source,
    uploadKey: randomUUID(), generationKey: randomUUID(), generation: generationSettingsSchema.parse({ clipCountTarget: 12, clipLengthPreset: "under_30s", defaultAspectRatio: "9:16", languageCode: "en" }), phase: "prepared" };
}

async function json(response: Response) {
  const reader = response.body?.getReader(); fact(reader, "response_body_missing");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      length += item.value.length; fact(length <= MAX_RESPONSE, "response_size_limit"); chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const replies = text.split(/\r?\n\r?\n/).flatMap(frame => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      return data ? [record(JSON.parse(data))] : [];
    }).filter(value => "id" in value && ("result" in value || "error" in value));
    fact(replies.length === 1, "mcp_reply_count_invalid"); return replies[0]!;
  }
  return record(JSON.parse(text));
}

/** Operator-only caller. Uses the production uploader and typed Project client;
 * it cannot issue arbitrary tools, callbacks, email or social commands. */
export async function runFileJourney(phase: "upload" | "generate" | "status", input: {
  apiOrigin: string;
  apiKey: string;
  sessionToken: string | (() => string | Promise<string>);
  journal: FileJourneyJournal;
  persist: (journal: FileJourneyJournal) => void;
}, dependencies: { fetch?: typeof fetch; delay?: (ms: number) => Promise<void> } = {}) {
  const journal = input.journal;
  fact(journal.version === 1 && originHash(input.apiOrigin) === journal.apiOriginHash, "journal_origin_mismatch");
  fact([journal.runId, journal.workspaceId, journal.uploadKey, journal.generationKey, journal.projectId, journal.sessionId, journal.queuedJobId, journal.taskId, journal.generationOperationId]
    .filter(value => value !== undefined).every(value => UUID.test(value!)), "journal_identity_invalid");
  generationSettingsSchema.parse(journal.generation);
  const overall = AbortSignal.timeout(phase === "generate" ? 12 * 60_000 : 8 * 60_000);
  const grants = new Set<string>(); let requests = 0;
  const save = (name: string) => { journal.phase = name; input.persist(journal); };
  const fetcher: typeof fetch = async (target, options = {}) => {
    fact(!(target instanceof Request), "request_shape_invalid");
    const url = new URL(String(target)); const method = options.method ?? "GET";
    fact(++requests <= 90, "request_count_limit");
    const own = url.origin === input.apiOrigin;
    if (own) {
      const upload = `/mcp/integrations/${journal.workspaceId}/upload-sessions/`;
      const project = journal.projectId && `/api/projects/${journal.projectId}`;
      fact(method === "POST" && (url.pathname === "/mcp" || ["open", "status", "grants", "finalize"].some(action => url.pathname === upload + action)) ||
        project && (method === "GET" && url.pathname === project || method === "PUT" && url.pathname === `${project}/notify-preference`), "http_action_not_allowed");
    } else {
      const headers = new Headers(options.headers);
      fact(method === "PUT" && grants.has(url.href) && !headers.has("Authorization") && !headers.has("Cookie"), "storage_target_not_assigned");
    }
    fact(url.protocol === "https:" && !url.username && !url.password, "request_target_invalid");
    // The identities are already durable before any mutation or storage PUT.
    journal.requests = (journal.requests ?? 0) + 1; input.persist(journal);
    const response = await (dependencies.fetch ?? fetch)(url, { ...options, redirect: "manual", credentials: "omit",
      signal: AbortSignal.any([overall, options.signal ?? overall, AbortSignal.timeout(120_000)]) });
    fact(response.status < 300 || response.status >= 400, "redirect_refused");
    if (own && response.ok && url.pathname.includes("/upload-sessions/")) {
      const value = await json(response.clone());
      if (value.sessionId) {
        fact(UUID.test(value.sessionId) && (!journal.sessionId || journal.sessionId === value.sessionId), "upload_session_changed"); journal.sessionId = value.sessionId;
      }
      if (value.projectId) {
        fact(UUID.test(value.projectId) && (!journal.projectId || journal.projectId === value.projectId), "upload_project_changed"); journal.projectId = value.projectId;
      }
      if (value.queuedJobId) { fact(UUID.test(value.queuedJobId) && (!journal.queuedJobId || journal.queuedJobId === value.queuedJobId), "ingest_identity_invalid"); journal.queuedJobId = value.queuedJobId; }
      const issued = [value.transfer?.grant, ...(value.transfer?.grants ?? []), ...(value.grants ?? [])].filter(Boolean);
      for (const grant of issued) {
        fact(typeof grant.url === "string" && grants.size < 64, "upload_grants_invalid"); grants.add(grant.url);
      }
      save(value.outcome === "queued_for_ingest" ? "finalized_notification_disable_pending" : "upload_identity_saved");
      if (value.outcome === "queued_for_ingest") await disableNotifications();
    }
    return response;
  };
  const projects = createProjectsClient({ baseUrl: input.apiOrigin, fetch: async (target, options = {}) => {
    const token = typeof input.sessionToken === "function" ? await input.sessionToken() : input.sessionToken;
    fact(typeof token === "string" && /^[^\s,]{1,8192}$/.test(token), "clerk_session_invalid");
    const headers = new Headers(options.headers); headers.set("Authorization", `Bearer ${token}`); headers.set("X-Workspace-Id", journal.workspaceId);
    const response = await fetcher(target, { ...options, headers }); fact(response.ok, "first_party_request_failed"); return response;
  } });
  async function project() {
    fact(journal.projectId, "project_identity_missing");
    const response = await projects.projects[":id"].$get({ param: { id: journal.projectId } });
    const value = await json(response); fact(value.project?.id === journal.projectId, "project_scope_mismatch"); return record(value.project);
  }
  async function disableNotifications() {
    fact(journal.projectId, "project_identity_missing");
    const response = await projects.projects[":id"]["notify-preference"].$put({ param: { id: journal.projectId }, json: { notifyOnComplete: false } });
    fact((await json(response)).ok === true, "notification_disable_failed");
    fact((await project()).notifyOnComplete === false, "notification_disable_not_observed");
    journal.notificationDisabledAt = new Date().toISOString(); save("notifications_disabled");
  }
  async function rpc(method: "tools/call" | "tasks/get", params: Record<string, unknown>, identity: string) {
    const name = method === "tools/call" ? params.name : params.taskId;
    const allowed = ["narriflow_generate_clips", "narriflow_get_operation"];
    fact(method === "tasks/get" || allowed.includes(String(name)), "mcp_tool_not_allowed");
    const response = await fetcher(new URL("/mcp", input.apiOrigin), { method: "POST", headers: { Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": VERSION, "MCP-Method": method, "MCP-Name": String(name) },
      body: JSON.stringify({ jsonrpc: "2.0", id: identity, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "narriflow-file-journey-gate", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } } } } }) });
    fact(response.ok, "mcp_http_refused"); const value = await json(response);
    fact(value.id === identity && !value.error && !value.result?.isError, "mcp_request_refused"); return record(value.result);
  }

  if (phase === "upload") {
    const source = await inspectFile(journal.source.path);
    fact(source.byteLength === journal.source.byteLength && source.sha256 === journal.source.sha256, "source_changed");
    save("upload_started");
    const outcome = await uploadVideo({ endpoint: input.apiOrigin, apiKey: input.apiKey, workspaceId: journal.workspaceId,
      filePath: journal.source.path, clientIdempotencyKey: journal.uploadKey, title: "Cutover real speech acceptance", contentType: "video/webm",
      generationContext: buildGenerationContext(journal.generation), fetch: fetcher, signal: overall });
    fact(outcome.outcome === "queued_for_ingest" && journal.notificationDisabledAt, "upload_not_accepted");
    const report = { status: "accepted", phase, notificationDisabled: true, sourceBytes: source.byteLength, requests };
    journal.lastReport = report; save("upload_accepted"); return report;
  }
  fact(journal.projectId && journal.notificationDisabledAt, "upload_and_notification_disable_required");
  let current = await project();
  if (current.notifyOnComplete !== false) { await disableNotifications(); current = await project(); }
  if (phase === "generate") {
    for (let attempt = 0; current.ingestStatus !== "ready" && attempt < 60; attempt++) {
      fact(current.ingestStatus !== "failed", "source_ingest_failed");
      await (dependencies.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(10_000);
      current = await project();
    }
    if (current.ingestStatus !== "ready") {
      const report = { status: "pending", phase, reason: "source_not_ready", requests }; journal.lastReport = report; save("waiting_source"); return report;
    }
    fact(typeof current.sourceDurationSeconds === "number" && Math.abs(current.sourceDurationSeconds - journal.source.durationSeconds) <= 0.1, "measured_source_duration_changed");
    save("generation_acceptance_pending");
    const result = await rpc("tools/call", { name: "narriflow_generate_clips", arguments: { workspaceId: journal.workspaceId,
      projectId: journal.projectId, clientIdempotencyKey: journal.generationKey, generation: journal.generation, forceRegenerate: false } }, `${journal.runId}:generate`);
    const operation = record(result._meta?.["narriflow/operation"]);
    fact(result.resultType === "task" && UUID.test(result.taskId) && operation.workspaceId === journal.workspaceId && operation.projectId === journal.projectId &&
      operation.domainKind === "generation" && UUID.test(operation.domainId), "generation_task_binding_invalid");
    fact(!journal.taskId || journal.taskId === result.taskId, "generation_task_changed");
    fact(!journal.generationOperationId || journal.generationOperationId === operation.domainId, "generation_operation_changed");
    journal.taskId = result.taskId; journal.generationOperationId = operation.domainId;
    const report = { status: "accepted", phase, positiveTask: true, requestedClips: journal.generation.clipCountTarget, requests };
    journal.lastReport = report; save("generation_accepted"); return report;
  }
  fact(journal.taskId && journal.generationOperationId, "generation_task_required");
  const task = await rpc("tasks/get", { taskId: journal.taskId }, `${journal.runId}:task-status`);
  fact(task.taskId === journal.taskId && ["working", "completed", "failed", "cancelled"].includes(task.status), "task_status_invalid");
  const result = await rpc("tools/call", { name: "narriflow_get_operation", arguments: { workspaceId: journal.workspaceId,
    operation: { kind: "generation", id: journal.generationOperationId } } }, `${journal.runId}:operation-status`);
  const operation = mcpOperationStatusResultSchema.parse(result.structuredContent?.data);
  fact(operation.operation.id === journal.generationOperationId && operation.results.projectId === journal.projectId, "operation_scope_mismatch");
  const report = { status: operation.state === "working" ? "pending" : operation.state, phase, taskStatus: task.status, notificationDisabled: true,
    requestedClips: journal.generation.clipCountTarget, actualClips: operation.results.clipIds.length,
    completedItems: operation.items.filter(item => item.state === "completed").length, failedItems: operation.items.filter(item => item.state === "failed").length,
    selectionBelowRequested: operation.state !== "working" && operation.results.clipIds.length < journal.generation.clipCountTarget,
    failureCode: operation.failureCode === null ? null : /^[a-zA-Z0-9_:-]{1,200}$/.test(operation.failureCode) ? operation.failureCode : "unclassified",
    progress: operation.progress, stage: operation.stage === null ? null : /^[a-z_]{1,60}$/.test(operation.stage) ? operation.stage : "unclassified", requests };
  journal.lastReport = report; save("status_observed"); return report;
}
