import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Validator } from "@seriousme/openapi-schema-validator";
import {
  callbackEventId,
  clipExportService,
  clipTimelineService,
  encodeOperationId,
  ExpectedDomainFailureError,
  integrationUploadSessionKey,
  operationStatusService,
  projectService,
  publishingQueue,
  recipeService,
  RecipeError,
  socialOAuthService,
  uploadSessionService,
  webhookSubscriptions,
  workspaceService,
  WorkspaceOperationError,
  type RateLimitResult,
  type WorkspaceActorContext,
} from "@narriflow/services";
import { buildGenerationContentPack } from "@narriflow/validators";
import { Hono } from "hono";
import { createRestRoutes, REST_AUTH_FAILURE_RATE_LIMIT } from "./routes";

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

function harness(options: { scopes?: string[]; limiter?: RateLimitResult; authFailures?: Map<string, number>; rateKeys?: string[]; actor?: WorkspaceActorContext | Error } = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const failures = options.authFailures ?? new Map<string, number>();
  spy(workspaceService, "authenticateApiKey").mockImplementation(async (secret: string) =>
    secret === SECRET ? { apiKeyId: KEY_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, name: "Automation", scopes: options.scopes ?? ALL_SCOPES } : null);
  const requireActor = spy(workspaceService, "requireActor").mockImplementation(async () => {
    if (options.actor instanceof Error) throw options.actor;
    return options.actor ?? actor();
  });
  const app = new Hono().route("/api/v1", createRestRoutes({
    checkRateLimit: async (key, limit) => {
      options.rateKeys?.push(key);
      if (!key.startsWith("rest:authfail:")) return options.limiter ?? available;
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      return { allowed: count <= limit, availability: "available", remaining: Math.max(0, limit - count), limit };
    },
    readRateLimit: async (key, limit) => {
      const count = failures.get(key) ?? 0;
      return { allowed: count < limit, availability: "available", remaining: Math.max(0, limit - count), limit };
    }, trustedClientIpHeader: "x-real-ip", apiOrigin: () => "https://api.narriflow.test", webOrigin: () => "https://narriflow.test", corsAllowedOrigins: ["https://narriflow.test"],
    callbackResolver: async () => [{ address: "93.184.216.34", family: 4 }], log: (entry) => logs.push(entry) }));
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
  test("an IP over the failed-authentication limit is refused before any DB lookup", async () => {
    const rateKeys: string[] = [];
    const authFailures = new Map([["rest:authfail:192.0.2.1", REST_AUTH_FAILURE_RATE_LIMIT.limit]]);
    const { call } = harness({ rateKeys, authFailures });
    for (const key of ["nf_unknown1", "nf_unknown2", "malformed", SECRET]) {
      const response = await call("/workspace", { key, headers: { "x-real-ip": "192.0.2.1", "x-forwarded-for": "203.0.113.10" } });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
    }
    expect(workspaceService.authenticateApiKey).not.toHaveBeenCalled();
    expect(rateKeys).toEqual([]);
    expect((await call("/workspace", { key: "nf_another", headers: { "x-real-ip": "192.0.2.2" } })).status).toBe(401);
    expect(rateKeys).toEqual(["rest:authfail:192.0.2.2"]);
  });

  test("only failed authentications count toward the per-IP limit", async () => {
    spy(projectService, "getUsageSummary").mockResolvedValue({ tier: "business", usedCredits: 0, reservedCredits: 0, limitCredits: 1800, remainingCredits: 1800, periodStart: new Date("2026-10-01T00:00:00.000Z"), renewsAt: new Date("2026-11-01T00:00:00.000Z"), inFlight: 0, inFlightLimit: 20, maxUploadSeconds: 10_800 } as never);
    const rateKeys: string[] = [];
    const authFailures = new Map<string, number>();
    const { call } = harness({ rateKeys, authFailures });
    const headers = { "x-real-ip": "192.0.2.9" };
    for (let i = 0; i < REST_AUTH_FAILURE_RATE_LIMIT.limit + 5; i++) expect((await call("/workspace", { headers })).status).toBe(200);
    expect(authFailures.size).toBe(0);
    expect((await call("/workspace", { key: null, headers })).status).toBe(401);
    expect((await call("/workspace", { key: "nf_wrong", headers })).status).toBe(401);
    expect(authFailures.get("rest:authfail:192.0.2.9")).toBe(2);
    expect((await call("/workspace", { headers })).status).toBe(200);
  });

  test("an OpenAPI suffix on another route still requires API-key authentication", async () => {
    const { call } = harness();
    for (const path of ["/projects/openapi.json", "/recipes/openapi.json"]) {
      const response = await call(path, { key: null });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "authentication_required" });
    }
  });

  test("unknown REST paths terminate before the first-party middleware", async () => {
    const { app, call } = harness();
    let firstPartyCalls = 0;
    app.use("/api/*", (c) => { firstPartyCalls++; return c.json({ error: "first_party" }, 415); });
    for (const method of ["GET", "POST"]) {
      const response = await call("/unknown/path", { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "route_not_found" });
    }
    expect(firstPartyCalls).toBe(0);
  });

  test("malformed operation IDs fail validation after scope and Workspace admission", async () => {
    const { call, requireActor } = harness();
    for (const [path, method] of [["/operations/op_bad", "GET"], ["/operations/op_bad/callback/redeliver", "POST"]]) {
      const response = await call(path!, { method, idempotencyKey: "redeliver" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
    expect(requireActor).toHaveBeenCalledTimes(2);
    const refused = await harness({ scopes: [] }).call("/operations/op_bad");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "scope_required" });
  });

  test("vendor JSON content types reach the ordinary body validator", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake() as never);
    const { call } = harness();
    const response = await call("/projects", { method: "POST", idempotencyKey: "vendor-json", headers: { "content-type": "application/vnd.narriflow+json; charset=utf-8" }, body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }) });
    expect(response.status).toBe(202);
    expect(intake).toHaveBeenCalledTimes(1);
  });

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
    const usage = spy(projectService, "getUsageSummary").mockResolvedValue({ tier: "business", usedCredits: 1, reservedCredits: 2, limitCredits: 1800, remainingCredits: 1797, periodStart: new Date("2026-10-01T00:00:00.000Z"), renewsAt: new Date("2026-11-01T00:00:00.000Z"), inFlight: 0, inFlightLimit: 20, maxUploadSeconds: 10_800 } as never);
    const { call, requireActor } = harness();
    const response = await call("/workspace");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspace: { workspaceId: WORKSPACE_ID, name: "Studio", role: "editor", pricingTier: "business" }, usage: { remainingCredits: 1797, reservedCredits: 2, renewsAt: "2026-11-01T00:00:00.000Z" } });
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

  test("API access follows the plan catalog: Pro and above, on an active Workspace", async () => {
    for (const tier of ["free", "creator"] as const) {
      const response = await harness({ actor: actor({ pricingTier: tier }) }).call("/brand-profiles");
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({ error: "plan_feature_required", details: { feature: "integrations.api", currentTier: tier, requiredTier: "pro" } });
    }
    const inactive = await harness({ actor: actor({ status: "suspended" as never }) }).call("/brand-profiles");
    expect(inactive.status).toBe(402);
    expect(await inactive.json()).toMatchObject({ error: "integration_access_unavailable", message: "This workspace isn't active, so the Narriflow API can't act in it" });
    spy(projectService, "getUsageSummary").mockResolvedValue({ tier: "pro", usedCredits: 0, reservedCredits: 0, limitCredits: 900, remainingCredits: 900, periodStart: new Date("2026-10-01T00:00:00.000Z"), renewsAt: new Date("2026-11-01T00:00:00.000Z"), inFlight: 0, inFlightLimit: 10, maxUploadSeconds: 10_800 } as never);
    const pro = await harness({ actor: actor({ pricingTier: "pro" }) }).call("/workspace");
    expect(pro.status).toBe(200);
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
    expect(await first.json()).toEqual({ projectId: PROJECT_ID, operation: { operationId, kind: "intake", statusUrl: `https://api.narriflow.test/api/v1/operations/${operationId}` },
      reviewUrl: `https://narriflow.test/projects/${PROJECT_ID}`, callback: null });
    const replay = await call("/projects", request);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(intake).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), { url: request.json.url, title: undefined, brandProfileId: undefined },
      expect.objectContaining({ mutation: expect.objectContaining({ clientIdempotencyKey: "drive-file-1:submit" }) }));
  });

  test("finishing rides in the generation context to intake, and an invalid one is refused before any work", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake() as never);
    const { call } = harness();
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const accepted = await call("/projects", { method: "POST", idempotencyKey: "fin-1", json: { url, finishing: { topClips: 3, copyPlatforms: ["tiktok"] } } });
    expect(accepted.status).toBe(202);
    expect(intake.mock.calls[0]![2]).toMatchObject({ generationContext: { finishing: { topClips: 3, minScore: 0, resolution: "1080p", copyPlatforms: ["tiktok"], delivery: "ready_to_review" } } });

    // Without it the context carries none.
    await call("/projects", { method: "POST", idempotencyKey: "fin-2", json: { url } });
    expect(intake.mock.calls[1]![2]).not.toHaveProperty("generationContext.finishing");

    const refused = await call("/projects", { method: "POST", idempotencyKey: "fin-3", json: { url, finishing: { topClips: 11 } } });
    expect(refused.status).toBe(400);
    expect(intake).toHaveBeenCalledTimes(2);
  });

  test("a generation request passes its finishing beside the input and refuses an invalid one", async () => {
    const trigger = spy(projectService, "triggerGeneration").mockResolvedValue({ workflowRunId: JOB_ID, acceptedAt: "2026-10-24T00:00:00.000Z", initialSeq: 0 } as never);
    const { call } = harness();
    const path = `/projects/${PROJECT_ID}/generations`;
    const accepted = await call(path, { method: "POST", idempotencyKey: "gen-1", json: { finishing: { topClips: 2, aspectRatios: ["1:1"] } } });
    expect(accepted.status).toBe(202);
    expect(trigger.mock.calls[0]![2]).not.toHaveProperty("finishing");
    expect(trigger.mock.calls[0]![4]).toMatchObject({ finishing: { topClips: 2, aspectRatios: ["1:1"], minScore: 0, delivery: "ready_to_review" } });
    expect((await call(path, { method: "POST", idempotencyKey: "gen-2", json: { finishing: { topClips: 0 } } })).status).toBe(400);
    expect(trigger).toHaveBeenCalledTimes(1);
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

describe("REST v1 captioned videos", () => {
  const srt = "1\n00:00:00,000 --> 00:00:02,000\nHello there\n\n2\n00:00:02,000 --> 00:00:04,000\nA short film";
  const link = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  test("a link starts a caption-only intake with settings frozen into its Content Pack and callback", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake() as never);
    const { call, requireActor } = harness();
    const response = await call("/captioned-videos", { method: "POST", idempotencyKey: "short-1", json: {
      source: { kind: "url", url: link, callback: { url: "https://hooks.example/resume/abc" } }, framing: "center", aspectRatios: ["9:16", "16:9"], resolution: "720p",
      captions: { source: "supplied", text: srt } } });
    expect(response.status).toBe(202);
    const operationId = encodeOperationId({ kind: "intake", id: JOB_ID });
    expect(await response.json()).toEqual({ projectId: PROJECT_ID, operation: { operationId, kind: "intake", statusUrl: `https://api.narriflow.test/api/v1/operations/${operationId}` },
      reviewUrl: `https://narriflow.test/projects/${PROJECT_ID}`, callback: { eventId: callbackEventId(linkIntake().receiptId) } });
    expect(requireActor).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, "processing.consume");
    const [, input, options] = intake.mock.calls[0]!;
    expect(input).toEqual({ url: link, title: undefined, brandProfileId: undefined });
    expect(options).toMatchObject({ command: "create_captioned_video", mutation: { clientIdempotencyKey: "short-1", callback: { url: new URL("https://hooks.example/resume/abc") } } });
    expect(options.generationContext.contentPack).toMatchObject({ mode: "caption_only", defaultAspectRatio: "9:16", captionedVideo: { framing: "center", aspectRatios: ["9:16", "16:9"], resolution: "720p",
      captions: { source: "supplied", utterances: [{ text: "Hello there", words: [{ word: "Hello", startSec: 0 }, { word: "there", endSec: 2 }] }, { text: "A short film" }] } } });
  });

  test("defaults to Fit, a 9:16 1080p export, and speech captions", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake() as never);
    const response = await harness().call("/captioned-videos", { method: "POST", idempotencyKey: "short-2", json: { source: { kind: "url", url: link } } });
    expect(response.status).toBe(202);
    expect(intake.mock.calls[0]![2].generationContext.contentPack.captionedVideo).toEqual({ framing: "fit", aspectRatios: ["9:16"], resolution: "1080p", captions: { source: "auto" } });
  });

  test("a file opens an Upload Session that carries the settings; finalize starts the intake", async () => {
    const open = spy(uploadSessionService, "open").mockResolvedValue({ outcome: "uploading", sessionId: SESSION_ID, projectId: PROJECT_ID, expiresAt: "2026-10-09T00:00:00.000Z",
      transfer: { kind: "single", contentType: "video/mp4", grant: { url: "https://bucket.r2.test/signed", contentType: "video/mp4" } } } as never);
    const key = "6d27d010-f52c-4e5c-9ea3-012c0bf7d921";
    const response = await harness().call("/captioned-videos", { method: "POST", idempotencyKey: key, json: {
      source: { kind: "upload", file: { name: "ai-short.mp4", sizeBytes: 4_000_000, contentType: "video/mp4" }, transfer: "single" }, captions: { source: "none" } } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ upload: { uploadId: SESSION_ID, state: "uploading", transfer: { kind: "single", method: "PUT" }, operation: null } });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: USER_ID }), expect.objectContaining({ clientIdempotencyKey: integrationUploadSessionKey(USER_ID, key), title: "ai-short.mp4", transfer: "single",
      generationContext: { languageCode: null, contentPack: expect.objectContaining({ mode: "caption_only", captionedVideo: expect.objectContaining({ captions: { source: "none" } }) }) } }));
  });

  test("malformed, empty, and oversized supplied captions are typed refusals before any work is accepted", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake() as never);
    const open = spy(uploadSessionService, "open");
    const { call } = harness();
    const refuse = (text: string) => call("/captioned-videos", { method: "POST", idempotencyKey: "short-3", json: { source: { kind: "url", url: link }, captions: { source: "supplied", text } } });
    const malformed = await refuse("1\n00:00:03,000 --> 00:00:01,000\nBackwards");
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toMatchObject({ error: "supplied_captions_malformed", details: { cue: 1 } });
    const empty = await refuse("WEBVTT\n\n");
    expect(empty.status).toBe(422);
    expect(await empty.json()).toMatchObject({ error: "supplied_captions_empty" });
    const tooLarge = await refuse(`1\n00:00:00,000 --> 00:00:01,000\n${"x".repeat(70 * 1024)}`);
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.json()).toMatchObject({ error: "supplied_captions_too_large" });
    expect(intake).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  test("rejects unknown settings, duplicate formats, and a callback on a file", async () => {
    const { call } = harness();
    const request = (json: unknown) => call("/captioned-videos", { method: "POST", idempotencyKey: "short-4", json });
    expect((await request({ source: { kind: "url", url: link }, framing: "stretch" })).status).toBe(400);
    expect((await request({ source: { kind: "url", url: link }, aspectRatios: ["9:16", "9:16"] })).status).toBe(400);
    expect((await request({ source: { kind: "upload", file: { name: "a.mp4", sizeBytes: 1, contentType: "video/mp4" }, callback: { url: "https://hooks.example/x" } } })).status).toBe(400);
    expect((await call("/captioned-videos", { method: "POST", json: { source: { kind: "url", url: link } } })).status).toBe(400);
  });

  test("needs the processing:write scope", async () => {
    const response = await harness({ scopes: ["projects:read"] }).call("/captioned-videos", { method: "POST", idempotencyKey: "short-5", json: { source: { kind: "url", url: link } } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "scope_required", details: { scope: "processing:write" } });
  });

  test("Operation Status reports the export and a framing notice", async () => {
    const notice = { code: "framing_degraded", aspectRatio: "9:16", croppedPercent: 68 };
    spy(operationStatusService, "read").mockResolvedValue({ kind: "intake", id: JOB_ID, state: "completed", stage: "rendering", progress: 1, items: [{ kind: "variant", id: EXPORT_ID, state: "completed", failureCode: null }],
      results: { projectId: PROJECT_ID, clipIds: [], exportId: EXPORT_ID }, notices: [notice], failureCode: null } as never);
    const response = await harness().call(`/operations/${encodeOperationId({ kind: "intake", id: JOB_ID })}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "completed", results: { exportId: EXPORT_ID }, notices: [notice] });
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

  test("an upload session freezes the finishing it was opened with", async () => {
    const open = spy(uploadSessionService, "open").mockResolvedValue(grant as never);
    const { call } = harness();
    const file = { name: "talk.mp4", sizeBytes: 1_000_000, contentType: "video/mp4" };
    const response = await call("/uploads", { method: "POST", idempotencyKey: "6d27d010-f52c-4e5c-9ea3-012c0bf7d922", json: { file, finishing: { topClips: 2, minScore: 70, aspectRatios: ["1:1"] } } });
    expect(response.status).toBe(200);
    expect(open.mock.calls[0]![1]).toMatchObject({ generationContext: { finishing: { topClips: 2, minScore: 70, aspectRatios: ["1:1"] } } });
    expect((await call("/uploads", { method: "POST", idempotencyKey: "6d27d010-f52c-4e5c-9ea3-012c0bf7d923", json: { file, finishing: { topClips: 2, copyPlatforms: ["myspace"] } } })).status).toBe(400);
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

describe("REST v1 clip timelines", () => {
  const CLIP_ID = "00000000-0000-4000-8000-000000000008";
  const timeline = { projectId: PROJECT_ID, clipId: CLIP_ID, editorRevision: 3, format: "edl", timeline: { fileName: "Big-Idea-v3.edl", content: "TITLE: Big Idea\n" },
    subtitles: { format: "srt", fileName: "Big-Idea-v3.srt", content: "" },
    source: { fileName: "Talk-source.mp4", sizeBytes: 1234, downloadUrl: "https://files.example/source?signature=x", expiresAt: "2026-10-24T12:15:00.000Z" } };
  const globals = globalThis as unknown as { narriflowPrismaClient?: unknown };
  const previous = { prisma: globals.narriflowPrismaClient, database: process.env.DATABASE_URL };
  afterEach(() => {
    globals.narriflowPrismaClient = previous.prisma;
    if (previous.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.database;
  });
  function knownClip() {
    process.env.DATABASE_URL ??= "postgresql://unused.test/db";
    globals.narriflowPrismaClient = { clip: { findFirst: async () => ({ projectId: PROJECT_ID }) } };
  }

  test("returns the timeline for the key's clip in the requested format with a source grant", async () => {
    knownClip();
    const exported = spy(clipTimelineService, "export").mockResolvedValue(timeline as never);
    const response = await harness({ scopes: ["exports:read"] }).call(`/clips/${CLIP_ID}/timeline?format=edl`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(timeline);
    expect(exported).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), PROJECT_ID, CLIP_ID, "edl", { credentialKind: "api_key" });
  });

  test("needs the exports:read scope, a Workspace download role, and a known format", async () => {
    knownClip();
    const exported = spy(clipTimelineService, "export").mockResolvedValue(timeline as never);
    expect((await harness({ scopes: ["projects:read"] }).call(`/clips/${CLIP_ID}/timeline?format=edl`)).status).toBe(403);
    const download = harness({ scopes: ["exports:read"] });
    expect((await download.call(`/clips/${CLIP_ID}/timeline?format=edl`)).status).toBe(200);
    expect(download.requireActor).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, "content.download");
    for (const query of ["", "?format=aaf", "?format=XMEML"]) {
      const response = await harness().call(`/clips/${CLIP_ID}/timeline${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
    expect(exported).toHaveBeenCalledTimes(1);
  });

  test("a timeline that cannot be cut is a 422 with its typed code, not a 500", async () => {
    knownClip();
    for (const code of ["timeline_empty", "timeline_source_rate_unsupported", "timeline_source_unmeasured", "timeline_video_required"]) {
      spy(clipTimelineService, "export").mockRejectedValue(new ExpectedDomainFailureError({ code, kind: "unprocessable", message: "Cannot cut a timeline" }));
      const response = await harness().call(`/clips/${CLIP_ID}/timeline?format=edl`);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: code, message: "Cannot cut a timeline" });
    }
  });

  test("a clip outside the key's workspace is not found", async () => {
    process.env.DATABASE_URL ??= "postgresql://unused.test/db";
    globals.narriflowPrismaClient = { clip: { findFirst: async () => null } };
    const exported = spy(clipTimelineService, "export");
    const response = await harness().call(`/clips/${CLIP_ID}/timeline?format=fcpxml`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "clip_not_found" });
    expect(exported).not.toHaveBeenCalled();
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
    expect((await harness().call("/operations/op_notanoperationidvalue12")).status).toBe(400);
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

describe("REST v1 events", () => {
  test("need projects:read, and reject unknown types and malformed paging before any read", async () => {
    const denied = await harness({ scopes: ["publishing:read"] }).call("/events");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "scope_required", details: { scope: "projects:read" } });
    const { call } = harness();
    for (const query of ["?types=made.up", "?types=operation.finished,made.up", "?after=abc", "?after=-1", "?limit=201", "?limit=0"]) {
      expect(`${query} ${(await call(`/events${query}`)).status}`).toBe(`${query} 400`);
    }
  });

  test("order=desc can't be combined with after, and an unknown order is invalid", async () => {
    const { call } = harness({ scopes: ["projects:read", "publishing:read"] });
    const refused = await call("/events?order=desc&after=5");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_request" });
    expect((await call("/events?order=sideways")).status).toBe(400);
  });

  test("types the key can't see are refused with the scope it lacks instead of an empty page", async () => {
    const { call } = harness({ scopes: ["projects:read"] });
    for (const types of ["social_post.finished", "social_post.proposed", "social_post.proposed,social_post.finished"]) {
      const refused = await call(`/events?types=${types}`);
      expect(`${types} ${refused.status}`).toBe(`${types} 403`);
      expect(refused.headers.get("WWW-Authenticate")).toContain('scope="publishing:read"');
      expect(await refused.json()).toMatchObject({ error: "scope_required", details: { scope: "publishing:read" } });
    }
  });
});

describe("REST v1 webhooks", () => {
  const WEBHOOK_ID = "00000000-0000-4000-8000-0000000000b1";
  const view = { webhookId: WEBHOOK_ID, urlHost: "hooks.example.com", types: ["operation.finished"], status: "active", disabledReason: null, disabledAt: null,
    lastDeliveredSeq: 0, consecutiveFailures: 0, lastAttemptAt: null, lastResponseStatus: null, lastDeliveredAt: null, createdAt: "2026-10-24T12:00:00.000Z" };
  const create = (call: ReturnType<typeof harness>["call"], json: unknown) => call("/webhooks", { method: "POST", json });

  test("reading needs projects:read and the content.view role; the response never carries a URL", async () => {
    const list = spy(webhookSubscriptions, "list").mockResolvedValue([view] as never);
    const denied = await harness({ scopes: ["processing:write"] }).call("/webhooks");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "scope_required", details: { scope: "projects:read" } });
    const reader = harness({ scopes: ["projects:read"] });
    const response = await reader.call("/webhooks");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ webhooks: [view] });
    expect(reader.requireActor).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, "content.view");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID, actorUserId: USER_ID }));
  });

  test("creating needs processing:write and the processing.consume role, then validates the URL and types", async () => {
    const created = spy(webhookSubscriptions, "create").mockResolvedValue(view as never);
    const body = { url: "https://hooks.example.com/narriflow", types: ["operation.finished"] };
    expect((await create(harness({ scopes: ["projects:read"] }).call, body)).status).toBe(403);

    const writer = harness({ scopes: ["processing:write"] });
    const response = await create(writer.call, { ...body, types: ["operation.finished", "autopilot.episode_imported"] });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ webhook: view });
    expect(writer.requireActor).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, "processing.consume");
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), { url: new URL(body.url), types: ["operation.finished", "autopilot.episode_imported"] });

    created.mockClear();
    for (const bad of [{ ...body, types: [] }, { ...body, types: ["made.up"] }, { types: ["operation.finished"] }, { ...body, extra: true }]) {
      expect((await create(harness().call, bad)).status).toBe(400);
    }
    for (const url of ["http://hooks.example.com/x", "https://hooks.example.com:8443/x", "https://user@localhost/x"]) {
      const refused = await create(harness().call, { ...body, url });
      expect(`${url} ${refused.status}`).toBe(`${url} 400`);
      expect(await refused.json()).toMatchObject({ error: "callback_url_invalid" });
    }
    expect(created).not.toHaveBeenCalled();
  });

  test("posting outcomes need publishing:read, like the feed", async () => {
    const created = spy(webhookSubscriptions, "create").mockResolvedValue(view as never);
    const body = { url: "https://hooks.example.com/narriflow", types: ["operation.finished", "social_post.finished"] };
    const denied = await create(harness({ scopes: ["processing:write"] }).call, body);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("WWW-Authenticate")).toContain('scope="publishing:read"');
    expect(await denied.json()).toMatchObject({ error: "scope_required", details: { scope: "publishing:read" } });
    expect(created).not.toHaveBeenCalled();
    expect((await create(harness({ scopes: ["processing:write", "publishing:read"] }).call, body)).status).toBe(201);
  });

  test("a Workspace without a signing secret, a repeated URL, and a full list are conflicts", async () => {
    const body = { url: "https://hooks.example.com/narriflow", types: ["operation.finished"] };
    for (const code of ["callback_secret_required", "webhook_exists", "webhook_limit_reached"]) {
      spy(webhookSubscriptions, "create").mockRejectedValue(new ExpectedDomainFailureError({ code, kind: "conflict", message: "Refused" }));
      const response = await create(harness().call, body);
      expect(`${code} ${response.status}`).toBe(`${code} 409`);
      expect(await response.json()).toMatchObject({ error: code });
    }
  });

  test("new webhooks pause while the request limiter is unavailable", async () => {
    const created = spy(webhookSubscriptions, "create");
    const response = await create(harness({ limiter: { allowed: true, availability: "unavailable", remaining: 0, limit: 300 } as RateLimitResult }).call, { url: "https://hooks.example.com/x", types: ["operation.finished"] });
    expect(response.status).toBe(503);
    expect(created).not.toHaveBeenCalled();
  });

  test("delete, enable, and test act on the key's Workspace and report unknown webhooks as 404", async () => {
    const deleted = spy(webhookSubscriptions, "delete").mockResolvedValue({ webhookId: WEBHOOK_ID } as never);
    const enabled = spy(webhookSubscriptions, "enable").mockResolvedValue(view as never);
    const tested = spy(webhookSubscriptions, "test").mockResolvedValue({ eventId: WEBHOOK_ID, delivered: true, status: 200, durationMs: 12 } as never);
    const { call, requireActor } = harness({ scopes: ["processing:write"] });

    const remove = await call(`/webhooks/${WEBHOOK_ID}`, { method: "DELETE" });
    expect(remove.status).toBe(200);
    expect(await remove.json()).toEqual({ webhookId: WEBHOOK_ID, deleted: true });
    expect(deleted).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), WEBHOOK_ID);

    const enable = await call(`/webhooks/${WEBHOOK_ID}/enable`, { method: "POST" });
    expect(enable.status).toBe(200);
    expect(await enable.json()).toEqual({ webhook: view });
    expect(enabled).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), WEBHOOK_ID, expect.objectContaining({ scopes: ["processing:write"] }));

    const test = await call(`/webhooks/${WEBHOOK_ID}/test`, { method: "POST" });
    expect(test.status).toBe(200);
    expect(await test.json()).toEqual({ eventId: WEBHOOK_ID, delivered: true, status: 200, durationMs: 12 });
    expect(tested).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), WEBHOOK_ID, expect.objectContaining({ scopes: ["processing:write"] }));
    expect(requireActor).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, "processing.consume");

    const reader = harness({ scopes: ["projects:read"] });
    for (const [path, method] of [[`/webhooks/${WEBHOOK_ID}`, "DELETE"], [`/webhooks/${WEBHOOK_ID}/enable`, "POST"], [`/webhooks/${WEBHOOK_ID}/test`, "POST"]] as const) {
      expect(`${method} ${path} ${(await reader.call(path, { method })).status}`).toBe(`${method} ${path} 403`);
    }
    expect((await harness().call("/webhooks/not-a-uuid", { method: "DELETE" })).status).toBe(400);

    enabled.mockRejectedValue(new ExpectedDomainFailureError({ code: "webhook_not_found", kind: "missing", message: "No such webhook" }));
    const missing = await harness().call(`/webhooks/${WEBHOOK_ID}/enable`, { method: "POST" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "webhook_not_found" });
  });

  test("enable and test hand the key's scopes to the service, which refuses event types the key may not read", async () => {
    const refusal = new ExpectedDomainFailureError({ code: "scope_required", kind: "forbidden", message: "This credential requires the publishing:read scope", details: { scope: "publishing:read" } });
    const enabled = spy(webhookSubscriptions, "enable").mockRejectedValue(refusal);
    const tested = spy(webhookSubscriptions, "test").mockRejectedValue(refusal);
    const { call } = harness({ scopes: ["processing:write"] });
    for (const action of ["enable", "test"]) {
      const response = await call(`/webhooks/${WEBHOOK_ID}/${action}`, { method: "POST" });
      expect(`${action} ${response.status}`).toBe(`${action} 403`);
      expect(await response.json()).toMatchObject({ error: "scope_required", details: { scope: "publishing:read" } });
    }
    expect(enabled.mock.calls[0]![2]).toMatchObject({ scopes: ["processing:write"] });
    expect(tested.mock.calls[0]![2]).toMatchObject({ scopes: ["processing:write"] });
  });

  test("a test sent again within five seconds is a 429 with Retry-After", async () => {
    spy(webhookSubscriptions, "test").mockRejectedValue(new ExpectedDomainFailureError({ code: "webhook_test_throttled", kind: "rate_limited", message: "Wait a few seconds", retryAfterSeconds: 5 }));
    const response = await harness().call(`/webhooks/${WEBHOOK_ID}/test`, { method: "POST" });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toMatchObject({ error: "webhook_test_throttled", retryAfterSeconds: 5 });
  });
});

describe("REST v1 Publishing Queue", () => {
  const ACCOUNT_ID = "00000000-0000-4000-8000-000000000011";
  const CLIP_ID = "00000000-0000-4000-8000-000000000012";
  const PROPOSAL_ID = "00000000-0000-4000-8000-000000000013";
  const body = { clipId: CLIP_ID, exportId: EXPORT_ID, socialAccountId: ACCOUNT_ID };
  const proposal = { proposalId: PROPOSAL_ID, projectId: PROJECT_ID, clipId: CLIP_ID, socialAccountId: ACCOUNT_ID, platform: "tiktok", caption: "Draft", source: "integration",
    exportId: EXPORT_ID, exportVariantId: "00000000-0000-4000-8000-000000000014", aspectRatio: "9:16", createdAt: "2026-10-24T12:00:00.000Z" };

  test("proposing needs publishing:write and an Idempotency-Key, and never schedules", async () => {
    const { call } = harness({ scopes: ["publishing:read"] });
    const refused = await call("/social-posts/proposals", { method: "POST", idempotencyKey: "k1", json: body });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("scope_required");

    const allowed = harness({ scopes: ["publishing:write"] });
    const propose = spy(publishingQueue, "propose").mockResolvedValue({ proposal, replayed: false } as never);
    expect((await allowed.call("/social-posts/proposals", { method: "POST", json: body })).status).toBe(400);
    const response = await allowed.call("/social-posts/proposals", { method: "POST", idempotencyKey: "k1", json: body });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ proposal, queueUrl: "https://narriflow.test/calendar/queue", replayed: false });
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0]![1]).toEqual(body);
    expect(propose.mock.calls[0]![2]).toMatchObject({ source: "integration", mutation: { clientIdempotencyKey: "k1" } });
  });

  test("a replayed proposal says so, and the body cannot choose a time", async () => {
    const { call } = harness({ scopes: ["publishing:write"] });
    spy(publishingQueue, "propose").mockResolvedValue({ proposal, replayed: true } as never);
    const replay = await call("/social-posts/proposals", { method: "POST", idempotencyKey: "k1", json: body });
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    const timed = await call("/social-posts/proposals", { method: "POST", idempotencyKey: "k2", json: { ...body, scheduledFor: "2030-01-01T00:00:00Z" } });
    expect(timed.status).toBe(400);
  });

  test("a queue refusal keeps its typed code", async () => {
    const { call } = harness({ scopes: ["publishing:write"] });
    spy(publishingQueue, "propose").mockRejectedValue(new ExpectedDomainFailureError({ code: "social_proposal_variant_unavailable", kind: "unprocessable", message: "No finished format" }));
    const response = await call("/social-posts/proposals", { method: "POST", idempotencyKey: "k3", json: body });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe("social_proposal_variant_unavailable");
  });

  test("starting finishing that proposes to the queue needs publishing:write on every route that accepts finishing", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake() as never);
    const trigger = spy(projectService, "triggerGeneration").mockResolvedValue({ workflowRunId: JOB_ID, acceptedAt: "2026-10-24T00:00:00.000Z", initialSeq: 0 } as never);
    const opened = spy(uploadSessionService, "open").mockRejectedValue(new Error("must not run"));
    spy(publishingQueue, "activeAccounts").mockResolvedValue([{ id: ACCOUNT_ID, platform: "youtube_shorts" }] as never);
    const finishing = { topClips: 2, aspectRatios: ["9:16"], delivery: "propose_to_queue", queueAccountIds: [ACCOUNT_ID] };
    const requests: Array<[string, unknown]> = [
      ["/projects", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", finishing }],
      [`/projects/${PROJECT_ID}/generations`, { finishing }],
      ["/uploads", { file: { name: "talk.mp4", sizeBytes: 10, contentType: "video/mp4" }, finishing }],
    ];
    const withoutScope = harness({ scopes: ["processing:write"] });
    for (const [index, [path, json]] of requests.entries()) {
      const refused = await withoutScope.call(path, { method: "POST", idempotencyKey: `queue-${index}`, json });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "scope_required", details: { scope: "publishing:write" } });
    }
    expect(intake).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();

    const withScope = harness({ scopes: ["processing:write", "publishing:write"] });
    expect((await withScope.call("/projects", { method: "POST", idempotencyKey: "queue-ok", json: requests[0]![1] })).status).toBe(202);
    expect((await withScope.call(requests[1]![0], { method: "POST", idempotencyKey: "queue-ok-2", json: requests[1]![1] })).status).toBe(202);
    expect(intake.mock.calls[0]![2]).toMatchObject({ generationContext: { finishing: { delivery: "propose_to_queue", queueAccountIds: [ACCOUNT_ID] } } });
  });

  test("lists accounts with their posting slots and the Workspace time zone, never credentials", async () => {
    expect((await harness({ scopes: ["projects:read"] }).call("/social-accounts")).status).toBe(403);
    const { call } = harness({ scopes: ["publishing:read"] });
    const schedule = { slots: [{ weekday: "mon", time: "09:00" }] };
    spy(socialOAuthService, "listAccounts").mockResolvedValue([{ id: ACCOUNT_ID, platform: "tiktok", providerAccountId: "p-1", displayName: "Studio", handle: "@studio", avatarUrl: null,
      scopes: ["video.publish"], expiresAt: null, status: "active", postingSchedule: schedule, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }] as never);
    spy(workspaceService, "getWorkspace").mockResolvedValue({ timezone: "America/New_York" } as never);
    const response = await call("/social-accounts");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accounts: [{ accountId: ACCOUNT_ID, platform: "tiktok", displayName: "Studio", handle: "@studio", status: "active", postingSchedule: schedule }], timeZone: "America/New_York" });
  });
});

describe("REST v1 Recipes", () => {
  const RECIPE_ID = "00000000-0000-4000-8000-0000000000e1";
  const BRAND_ID = "00000000-0000-4000-8000-0000000000b1";
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    id: RECIPE_ID, workspaceId: WORKSPACE_ID, name: "Weekly show", revision: 3, brandProfileId: BRAND_ID, languageCode: "en",
    contentPack: buildGenerationContentPack({ clipCountTarget: 6, defaultAspectRatio: "1:1" }), finishing: null, ruleCount: 1,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", ...overrides,
  });
  const resolved = (overrides: Record<string, unknown> = {}) => ({
    id: RECIPE_ID, revision: 3, brandProfileId: BRAND_ID, languageCode: "en", contentPack: buildGenerationContentPack(), finishing: null, ...overrides,
  });

  test("lists Recipes and reads one at its current revision, without Content Pack internals", async () => {
    spy(recipeService, "list").mockResolvedValue([snapshot()] as never);
    spy(recipeService, "get").mockResolvedValue(snapshot() as never);
    const { call } = harness();
    const listed = await (await call("/recipes")).json();
    expect(listed).toEqual({ recipes: [{
      recipeId: RECIPE_ID, name: "Weekly show", revision: 3, brandProfileId: BRAND_ID, languageCode: "en", finishing: null, updatedAt: "2026-10-02T00:00:00.000Z",
      generation: { clipCountTarget: 6, clipLengthPreset: "auto", defaultAspectRatio: "1:1", captionPreset: "brand_default", mode: "clip", autoHook: true, specificMoments: "", processingStartSec: null, processingEndSec: null },
    }] });
    expect(await (await call(`/recipes/${RECIPE_ID}`)).json()).toEqual({ recipe: listed.recipes[0] });
  });

  test("an unknown Recipe is a 404 with a stable code", async () => {
    spy(recipeService, "get").mockRejectedValue(new RecipeError("recipe_not_found"));
    const { call } = harness();
    const response = await call(`/recipes/${RECIPE_ID}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "recipe_not_found" });
  });

  test("an intake that names a Recipe sends no settings, and its fingerprint holds only the ID", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake({ recipe: { id: RECIPE_ID, revision: 3 } }) as never);
    const { call } = harness();
    const response = await call("/projects", { method: "POST", idempotencyKey: "recipe-1", json: { url, recipeId: RECIPE_ID } });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ projectId: PROJECT_ID, recipe: { id: RECIPE_ID, revision: 3 } });
    const [, source, options] = intake.mock.calls[0]!;
    expect(source).toEqual({ url, title: undefined, brandProfileId: undefined });
    expect(options).toMatchObject({ command: "submit_video", recipe: { id: RECIPE_ID } });
    expect(options).not.toHaveProperty("generationContext");
  });

  test("a Recipe and inline settings together are a validation error before any work", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake() as never);
    const { call } = harness();
    for (const inline of [{ generation: { clipCountTarget: 5 } }, { finishing: { topClips: 2 } }, { brandProfileId: BRAND_ID }]) {
      const response = await call("/projects", { method: "POST", idempotencyKey: "both", json: { url, recipeId: RECIPE_ID, ...inline } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
    const generate = await call(`/projects/${PROJECT_ID}/generations`, { method: "POST", idempotencyKey: "both", json: { recipeId: RECIPE_ID, generation: {} } });
    expect(generate.status).toBe(400);
    expect(intake).not.toHaveBeenCalled();
  });

  test("the Recipe is read when the request is accepted: it must exist, and queue delivery needs the publishing scope", async () => {
    const intake = spy(projectService, "queueLinkIngest").mockResolvedValue(linkIntake() as never);
    const resolve = spy(recipeService, "resolve").mockResolvedValue(resolved({ finishing: { topClips: 2, minScore: 0, resolution: "1080p", copyPlatforms: [], delivery: "propose_to_queue", queueAccountIds: ["00000000-0000-4000-8000-0000000000a9"] } }) as never);
    const queue = spy(publishingQueue, "activeAccounts");
    queue.mockResolvedValue([] as never);
    const { call } = harness({ scopes: ["processing:write"] });
    // Nothing reads the Recipe before the intake runs it.
    await call("/projects", { method: "POST", idempotencyKey: "q-1", json: { url, recipeId: RECIPE_ID } });
    expect(resolve).not.toHaveBeenCalled();
    const use = (intake.mock.calls[0]![2] as { recipe: { resolve(): Promise<unknown> } }).recipe;
    await expect(use.resolve()).rejects.toMatchObject({ code: "scope_required", details: { scope: "publishing:write" } });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }), RECIPE_ID);
  });

  test("a generation that names a Recipe passes it to the run, and reports the revision it used", async () => {
    const trigger = spy(projectService, "triggerGeneration").mockResolvedValue({ workflowRunId: JOB_ID, acceptedAt: "2026-10-24T00:00:00.000Z", initialSeq: 0, recipe: { id: RECIPE_ID, revision: 3 } } as never);
    const { call } = harness();
    const response = await call(`/projects/${PROJECT_ID}/generations`, { method: "POST", idempotencyKey: "gen-r", json: { recipeId: RECIPE_ID, forceRegenerate: true } });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ recipe: { id: RECIPE_ID, revision: 3 } });
    expect(trigger.mock.calls[0]![2]).toMatchObject({ forceRegenerate: true, recipe: { id: RECIPE_ID } });
    expect(trigger.mock.calls[0]![2]).not.toHaveProperty("contentPack");
  });

  test("an upload that names a Recipe opens its session with the ID alone", async () => {
    const open = spy(uploadSessionService, "open").mockResolvedValue({ outcome: "reconciling", sessionId: SESSION_ID, projectId: PROJECT_ID, retryAfterSeconds: 2 } as never);
    spy(uploadSessionService, "recipeUsed").mockResolvedValue({ id: RECIPE_ID, revision: 3 } as never);
    const { call } = harness();
    const response = await call("/uploads", { method: "POST", idempotencyKey: "up-r", json: { file: { name: "a.mp4", sizeBytes: 10, contentType: "video/mp4" }, recipeId: RECIPE_ID } });
    expect(response.status).toBe(200);
    // The open response says which Recipe revision the session froze.
    expect(await response.json()).toMatchObject({ upload: { uploadId: SESSION_ID, recipe: { id: RECIPE_ID, revision: 3 } } });
    const [, input, options] = open.mock.calls[0]!;
    expect(input).toMatchObject({ recipeId: RECIPE_ID });
    expect(input).not.toHaveProperty("generationContext");
    expect(options).toMatchObject({ recipe: { id: RECIPE_ID } });
    const refused = await call("/uploads", { method: "POST", idempotencyKey: "up-both", json: { file: { name: "a.mp4", sizeBytes: 10, contentType: "video/mp4" }, recipeId: RECIPE_ID, generation: {} } });
    expect(refused.status).toBe(400);
  });
});

describe("REST extraction boundaries", () => {
  test("admission precedes validation and ignores session cookies", async () => {
    const { call } = harness({ scopes: ["projects:read"] });
    const forbidden = await call("/projects", { method: "POST", json: {} });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "scope_required" });
    const cookie = await call("/workspace", { key: null, headers: { cookie: "__session=valid-looking-cookie" } });
    expect(cookie.status).toBe(401);
  });

  test("allowed docs preflight and API-key requests work without Clerk CORS", async () => {
    const { call } = harness();
    const response = await call("/projects", { method: "OPTIONS", key: null, headers: {
      origin: "https://narriflow.test",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,idempotency-key",
    } });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://narriflow.test");
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(false);
    const failed = await call("/workspace", { key: null, headers: { origin: "https://narriflow.test" } });
    expect(failed.status).toBe(401);
    expect(failed.headers.get("Access-Control-Allow-Origin")).toBe("https://narriflow.test");
    const denied = await call("/workspace", { headers: { origin: "https://foreign.example.com" } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "origin_not_allowed" });
  });

  test("malformed JSON and oversized chunked bodies have bounded REST failures", async () => {
    const intake = spy(projectService, "queueLinkIngest");
    const { call } = harness();
    const malformed = await call("/projects", { method: "POST", idempotencyKey: "parse", body: "{", headers: { "content-type": "application/json" } });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid_request" });
    const wrongType = await call("/projects", { method: "POST", idempotencyKey: "type", body: "{}", headers: { "content-type": "text/plain" } });
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toMatchObject({ error: "invalid_request" });
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(600_000));
      controller.enqueue(new Uint8Array(600_000));
      controller.close();
    } });
    const oversized = await call("/projects", { method: "POST", body: stream, headers: { "content-type": "application/json", "content-length": "1" } });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "payload_too_large", requestId: expect.any(String) });
    expect(intake).not.toHaveBeenCalled();
  });

  test("immutable replays precede exhausted-budget refusal", async () => {
    let accepted = false;
    spy(projectService, "queueLinkIngest").mockImplementation(async (_actor: unknown, _input: unknown, options: { mutation: { beforeAccept(): Promise<void> } }) => {
      if (accepted) return linkIntake({ replayed: true });
      await options.mutation.beforeAccept();
      return linkIntake();
    });
    const { call } = harness({ limiter: { allowed: false, availability: "available", remaining: 0, limit: 300 } });
    const input = { method: "POST", idempotencyKey: "budget", json: { url: "https://example.com/video.mp4" } };
    const refused = await call("/projects", input);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: "rate_limited" });
    accepted = true;
    const replay = await call("/projects", input);
    expect(replay.status).toBe(202);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    const result = await replay.json();
    expect(result.operation.statusUrl).toStartWith("https://api.narriflow.test/");
    expect(result.reviewUrl).toStartWith("https://narriflow.test/");
  });
});
