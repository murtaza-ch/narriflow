import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Validator } from "@seriousme/openapi-schema-validator";
import {
  callbackEventId,
  clipExportService,
  encodeOperationId,
  ExpectedDomainFailureError,
  integrationUploadSessionKey,
  operationStatusService,
  projectService,
  uploadSessionService,
  workspaceService,
  WorkspaceOperationError,
  type RateLimitResult,
  type WorkspaceActorContext,
} from "@narriflow/services";
import { createRestApi } from "./app";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const KEY_ID = "00000000-0000-4000-8000-000000000003";
const PROJECT_ID = "00000000-0000-4000-8000-000000000004";
const JOB_ID = "00000000-0000-4000-8000-000000000005";
const SESSION_ID = "00000000-0000-4000-8000-000000000006";
const EXPORT_ID = "00000000-0000-4000-8000-000000000007";
const ALL_SCOPES = ["projects:read", "exports:read", "processing:write", "exports:write", "usage:read"];
const SECRET = `nf_${"a".repeat(40)}`;
const available: RateLimitResult = { allowed: true, availability: "available", remaining: 299, limit: 300 };

const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const mock of mocks.splice(0)) mock.mockRestore(); });
function spy<T extends object, K extends keyof T>(target: T, key: K) {
  const mocked = spyOn(target, key as never) as unknown as ReturnType<typeof spyOn>;
  mocks.push(mocked);
  return mocked;
}

function actor(overrides: Partial<WorkspaceActorContext> = {}): WorkspaceActorContext {
  return { actorUserId: USER_ID, workspaceId: WORKSPACE_ID, workspaceName: "Studio", workspaceOwnerUserId: USER_ID, isPersonalWorkspace: false,
    role: "editor", status: "active", pricingTier: "business", ...overrides };
}

function harness(options: { scopes?: string[]; limiter?: RateLimitResult; actor?: WorkspaceActorContext | Error } = {}) {
  const logs: Array<Record<string, unknown>> = [];
  spy(workspaceService, "authenticateApiKey").mockImplementation(async (secret: string) =>
    secret === SECRET ? { apiKeyId: KEY_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, name: "Automation", scopes: options.scopes ?? ALL_SCOPES } : null);
  const requireActor = spy(workspaceService, "requireActor").mockImplementation(async () => {
    if (options.actor instanceof Error) throw options.actor;
    return options.actor ?? actor();
  });
  const app = createRestApi({ checkRateLimit: async () => options.limiter ?? available, appOrigin: () => "https://narriflow.test",
    callbackResolver: async () => [{ address: "93.184.216.34", family: 4 }], log: (entry) => logs.push(entry) });
  const call = (path: string, init: RequestInit & { key?: string | null; idempotencyKey?: string; json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (init.key !== null) headers.set("authorization", `Bearer ${init.key ?? SECRET}`);
    if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return app.request(`/api/v1${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };
  return { app, call, requireActor, logs };
}

const linkIntake = (overrides: Record<string, unknown> = {}) => ({ project: { id: PROJECT_ID }, queuedJobId: JOB_ID, replayed: false, receiptId: "00000000-0000-4000-8000-0000000000aa", ...overrides });

describe("REST v1 OpenAPI document", () => {
  test("is served without authentication and validates as OpenAPI 3.1", async () => {
    const { call } = harness();
    const response = await call("/openapi.json", { key: null });
    expect(response.status).toBe(200);
    const document = await response.json();
    expect(document.openapi).toBe("3.1.0");
    const validation = await new Validator().validate(document);
    expect(validation.errors).toBeUndefined();
    expect(validation.valid).toBe(true);
  });

  test("lists exactly the v1 endpoints", async () => {
    const document = await (await harness().call("/openapi.json", { key: null })).json() as { paths: Record<string, Record<string, unknown>> };
    const endpoints = Object.entries(document.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path.replace("/api/v1", "")}`)).sort();
    expect(endpoints).toMatchSnapshot();
  });

  test("changes only additively: the whole document is snapshotted", async () => {
    // Review any diff here: v1 may add operations or optional fields, never remove or tighten them.
    expect(await (await harness().call("/openapi.json", { key: null })).json()).toMatchSnapshot();
  });
});

describe("REST v1 authentication and admission", () => {
  test("requires a Bearer API key", async () => {
    const { call } = harness();
    for (const header of [null, "Basic abc", "Bearer not-a-key"]) {
      const response = await call("/workspace", { key: null, headers: header ? { authorization: header } : {} });
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
      expect(await response.json()).toMatchObject({ error: "authentication_required", requestId: expect.stringMatching(/^req_/) });
    }
    const revoked = await call("/workspace", { key: `nf_${"b".repeat(40)}` });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ error: "invalid_api_key" });
  });

  test("derives the Workspace from the key and rechecks the key creator's membership", async () => {
    const usage = spy(projectService, "getUsageSummary").mockResolvedValue({ tier: "business", usedMinutes: 1, reservedMinutes: 0, limitMinutes: 1800, remainingMinutes: 1799, inFlight: 0, inFlightLimit: 5, maxUploadSeconds: 14_400 } as never);
    const { call, requireActor } = harness();
    const response = await call("/workspace");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspace: { workspaceId: WORKSPACE_ID, name: "Studio", role: "editor", pricingTier: "business" }, usage: { remainingMinutes: 1799 } });
    expect(requireActor).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, "content.view");
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }));
  });

  test("refuses a key without the endpoint's scope before reading the Workspace", async () => {
    const { call, requireActor } = harness({ scopes: ["projects:read"] });
    const response = await call("/workspace");
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain('scope="usage:read"');
    expect(await response.json()).toMatchObject({ error: "scope_required", details: { scope: "usage:read" } });
    expect(requireActor).not.toHaveBeenCalled();
  });

  test("a removed key creator or a viewer role is refused like the web app", async () => {
    const { call } = harness({ actor: new WorkspaceOperationError("workspace_access_denied", "Current membership refuses this action") });
    const response = await call("/projects", { method: "POST", idempotencyKey: "k-1", json: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "workspace_access_denied" });
  });

  test("API access stays a Business feature", async () => {
    for (const restricted of [actor({ pricingTier: "pro" }), actor({ status: "suspended" as never })]) {
      const response = await harness({ actor: restricted }).call("/brand-profiles");
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({ error: "integration_access_unavailable", message: "This workspace needs active Business access to use the Narriflow API" });
    }
  });
});

describe("REST v1 idempotency and errors", () => {
  test("mutations require a bounded URL-safe Idempotency-Key", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake() as never);
    const { call } = harness();
    for (const idempotencyKey of [undefined, "has space", "x".repeat(201)]) {
      const response = await call("/projects", { method: "POST", idempotencyKey, json: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "idempotency_key_required" });
    }
    expect(intake).not.toHaveBeenCalled();
  });

  test("an accepted link intake returns an opaque operation, and a replay says so", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValueOnce(linkIntake() as never).mockResolvedValueOnce(linkIntake({ replayed: true }) as never);
    const { call } = harness();
    const request = { method: "POST", idempotencyKey: "drive-file-1:submit", json: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", generation: { clipCountTarget: 5 } } };
    const first = await call("/projects", request);
    expect(first.status).toBe(202);
    expect(first.headers.get("Idempotent-Replayed")).toBeNull();
    const operationId = encodeOperationId({ kind: "intake", id: JOB_ID });
    expect(await first.json()).toEqual({ projectId: PROJECT_ID, operation: { operationId, kind: "intake", statusUrl: `https://narriflow.test/api/v1/operations/${operationId}` },
      reviewUrl: `https://narriflow.test/projects/${PROJECT_ID}`, callback: null });
    const replay = await call("/projects", request);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(intake).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), { url: request.json.url, title: undefined, brandProfileId: undefined },
      expect.objectContaining({ mutation: expect.objectContaining({ clientIdempotencyKey: "drive-file-1:submit" }) }));
  });

  test("callbacks are validated at acceptance and report their event ID", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake() as never);
    const { call } = harness();
    const rejected = await call("/projects", { method: "POST", idempotencyKey: "k", json: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", callback: { url: "http://hooks.example/x" } } });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "callback_url_invalid", details: { reason: "not_https" } });
    expect(intake).not.toHaveBeenCalled();
    const response = await call("/projects", { method: "POST", idempotencyKey: "k", json: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", callback: { url: "https://hooks.example/resume/abc" } } });
    expect(response.status).toBe(202);
    expect((await response.json()).callback).toEqual({ eventId: callbackEventId(linkIntake().receiptId) });
    expect(intake.mock.calls[0]![2]).toMatchObject({ mutation: { callback: { url: new URL("https://hooks.example/resume/abc") } } });
  });

  test("callback fields are rejected where no operation starts", async () => {
    const { call } = harness();
    const response = await call("/uploads/00000000-0000-4000-8000-000000000006/grants", { method: "POST", json: { partNumbers: [1], callback: { url: "https://hooks.example/x" } } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  test("errors carry a stable code, a safe message, and the request ID", async () => {
    spy(projectService, "getProjectSnapshot").mockRejectedValueOnce(new ExpectedDomainFailureError({ code: "project_not_found", kind: "missing", message: "Project not found" }))
      .mockRejectedValueOnce(new Error("connection string postgres://secret leaked"));
    const { call, logs } = harness();
    const missing = await call(`/projects/${PROJECT_ID}`);
    expect(missing.status).toBe(404);
    const body = await missing.json();
    expect(body).toEqual({ error: "project_not_found", message: "Project not found", requestId: missing.headers.get("X-Request-Id") });
    const broken = await call(`/projects/${PROJECT_ID}`);
    expect(broken.status).toBe(500);
    const text = await broken.text();
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toMatchObject({ error: "internal_error" });
    expect(JSON.stringify(logs)).not.toContain("secret");
    const invalid = await call("/projects/not-a-uuid");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_request", details: { issues: [expect.objectContaining({ path: "id" })] } });
    expect((await call("/nowhere")).status).toBe(404);
  });
});

describe("REST v1 rate limits", () => {
  test("a key over its budget receives 429 with Retry-After", async () => {
    const response = await harness({ limiter: { allowed: false, availability: "available", remaining: 0, limit: 300 } }).call("/brand-profiles");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toMatchObject({ error: "rate_limited", retryAfterSeconds: 60 });
  });

  test("while the limiter is unavailable, reads and replays proceed and new mutations pause", async () => {
    const outage: RateLimitResult = { allowed: true, availability: "unavailable", remaining: 300, limit: 300 };
    spy(projectService, "getProjectSnapshot").mockResolvedValue({ project: { id: PROJECT_ID, workspaceId: WORKSPACE_ID, title: "T", sourceType: "link", ingestStatus: "ready", sourceDurationSeconds: 60, languageCode: "en", createdAt: "2026-10-08T00:00:00.000Z" }, progress: null, activeRun: null } as never);
    let accepted = false;
    spy(projectService, "queueLinkIngest").mockImplementation(async (_actor: unknown, _input: unknown, options: { mutation: { beforeAccept(): Promise<void> } }) => {
      if (accepted) return linkIntake({ replayed: true });
      await options.mutation.beforeAccept();
      return linkIntake();
    });
    const { call } = harness({ limiter: outage });
    expect((await call(`/projects/${PROJECT_ID}`)).status).toBe(200);
    const paused = await call("/projects", { method: "POST", idempotencyKey: "k", json: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    expect(paused.status).toBe(503);
    expect(paused.headers.get("Retry-After")).toBe("5");
    expect(await paused.json()).toMatchObject({ error: "mutations_unavailable" });
    accepted = true;
    const replay = await call("/projects", { method: "POST", idempotencyKey: "k", json: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  });
});

describe("REST v1 uploads", () => {
  const grant = { outcome: "uploading", sessionId: SESSION_ID, projectId: PROJECT_ID, expiresAt: "2026-10-09T00:00:00.000Z",
    transfer: { kind: "single", contentType: "video/mp4", grant: { url: "https://bucket.r2.test/signed", contentType: "video/mp4" } } };

  test("opens a single-PUT session under the same per-user key MCP derives", async () => {
    const open = spy(uploadSessionService, "open").mockResolvedValue(grant as never);
    const { call } = harness();
    const key = "6d27d010-f52c-4e5c-9ea3-012c0bf7d921";
    const response = await call("/uploads", { method: "POST", idempotencyKey: key, json: { file: { name: "talk.mp4", sizeBytes: 5 * 1024 * 1024 * 1024 - 6 * 1024 * 1024, contentType: "video/mp4" }, transfer: "single" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ upload: { uploadId: SESSION_ID, state: "uploading", transfer: { kind: "single", method: "PUT", url: "https://bucket.r2.test/signed", headers: { "Content-Type": "video/mp4" } }, operation: null } });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: USER_ID }), expect.objectContaining({ clientIdempotencyKey: integrationUploadSessionKey(USER_ID, key), transfer: "single", title: "talk.mp4" }));
  });

  test("finalize starts the intake with its callback and reads go by Upload Session ID", async () => {
    const finalize = spy(uploadSessionService, "finalize").mockResolvedValue({ outcome: "queued_for_ingest", sessionId: SESSION_ID, projectId: PROJECT_ID, queuedJobId: JOB_ID } as never);
    const read = spy(uploadSessionService, "statusById").mockResolvedValue(grant as never);
    const { call } = harness();
    const response = await call(`/uploads/${SESSION_ID}/finalize`, { method: "POST", json: { callback: { url: "https://hooks.example/resume/upload" } } });
    expect(response.status).toBe(200);
    const operationId = encodeOperationId({ kind: "intake", id: SESSION_ID });
    expect(await response.json()).toMatchObject({ upload: { state: "queued_for_ingest", operation: { operationId, kind: "intake" } }, callback: { eventId: callbackEventId(SESSION_ID) } });
    expect(finalize).toHaveBeenCalledWith(expect.anything(), { sessionId: SESSION_ID, parts: [] }, { callback: { url: new URL("https://hooks.example/resume/upload") } });
    expect((await call(`/uploads/${SESSION_ID}`)).status).toBe(200);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), SESSION_ID);
  });
});

describe("REST v1 operations", () => {
  test("Operation Status uses the scope of the work it describes", async () => {
    const read = spy(operationStatusService, "read").mockResolvedValue({ kind: "export", id: EXPORT_ID, state: "completed", stage: "rendering", progress: 1, items: [],
      results: { projectId: PROJECT_ID, clipIds: [], exportId: EXPORT_ID }, failureCode: null } as never);
    const operationId = encodeOperationId({ kind: "export", id: EXPORT_ID });
    const denied = await harness({ scopes: ["projects:read"] }).call(`/operations/${operationId}`);
    expect(denied.status).toBe(403);
    const allowed = await harness({ scopes: ["exports:read"] }).call(`/operations/${operationId}`);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ operationId, kind: "export", state: "completed", results: { exportId: EXPORT_ID } });
    expect(read).toHaveBeenCalledWith(expect.anything(), { kind: "export", id: EXPORT_ID });
    expect((await harness().call("/operations/op_notanoperationidvalue12")).status).toBe(404);
  });

  test("redelivery needs the original mutation's scope and an Idempotency-Key", async () => {
    const operationId = encodeOperationId({ kind: "export", id: EXPORT_ID });
    expect((await harness({ scopes: ["processing:write"] }).call(`/operations/${operationId}/callback/redeliver`, { method: "POST", idempotencyKey: "r" })).status).toBe(403);
    expect((await harness({ scopes: ["exports:write"] }).call(`/operations/${operationId}/callback/redeliver`, { method: "POST" })).status).toBe(400);
  });

  test("download grants are issued for the key's export", async () => {
    const grants = spy(clipExportService, "issueDownloadGrants").mockResolvedValue({ exportId: EXPORT_ID, projectId: PROJECT_ID, clipId: PROJECT_ID, editorRevision: 0, variants: [], subtitles: [] } as never);
    const response = await harness().call(`/exports/${EXPORT_ID}/download`);
    expect(response.status).toBe(200);
    expect(grants).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), EXPORT_ID, { variantId: undefined, credentialKind: "api_key" });
  });
});
