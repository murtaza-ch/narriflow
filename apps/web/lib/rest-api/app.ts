import { randomUUID } from "node:crypto";
import { createRoute, OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  assertCompletionCallbackUrl,
  boundedExpectedDomainFailureDetails,
  brandProfileService,
  callbackEventId,
  clipExportService,
  clipService,
  clipView,
  createClipExport,
  decodeOperationId,
  encodeOperationId,
  ExpectedDomainFailureError,
  exportView,
  generateClips,
  IntegrationAdmission,
  integrationUploadSessions,
  isExpectedDomainFailure,
  locateClip,
  locateExport,
  operationReadScope,
  operationStatusService,
  operationWriteScope,
  projectService,
  projectView,
  redeliverCallbacks,
  requireNewMutationAllowed,
  submitVideo,
  uploadSessionService,
  workspaceLibraryService,
  workspaceService,
  type ActorScope,
  type HostResolver,
  type IntegrationCommand,
  type IntegrationMutation,
  type IntegrationPrincipal,
  type OperationStatus,
  type RateLimitResult,
} from "@narriflow/services";
import { buildGenerationContentPack, generationSettingsSchema, restApiSchemas as schemas, type WorkspaceApiKeyScope } from "@narriflow/validators";
import { domainFailureHttpStatus } from "../authenticated-request-http";

/** Public REST API v1. A separate Hono app from the browser API: Workspace API
 * keys only, the key's Workspace only, and the same commands and admission
 * table as MCP. See docs/integrations/rest-api.md. */

export const REST_API_RATE_LIMIT = { limit: 300, windowSeconds: 60 } as const;

/** Every REST endpoint admits exactly one integration command, so its scope
 * and Workspace capability match MCP and the browser peer. */
export const REST_ENDPOINT_COMMANDS = {
  "GET /workspace": "get_workspace_usage",
  "GET /brand-profiles": "list_brand_profiles",
  "POST /uploads": "open_upload",
  "GET /uploads/{id}": "open_upload",
  "POST /uploads/{id}/grants": "open_upload",
  "POST /uploads/{id}/finalize": "open_upload",
  "DELETE /uploads/{id}": "open_upload",
  "POST /projects": "submit_video",
  "GET /projects": "list_projects",
  "GET /projects/{id}": "get_project",
  "POST /projects/{id}/generations": "generate_clips",
  "GET /projects/{id}/clips": "list_clips",
  "GET /clips/{id}": "get_clip",
  "POST /clips/{id}/exports": "create_clip_export",
  "GET /exports/{id}": "get_clip_export",
  "GET /exports/{id}/download": "get_export_download",
  "GET /operations/{id}": "get_operation",
  "POST /operations/{id}/callback/redeliver": "redeliver_callback",
} as const satisfies Record<string, IntegrationCommand>;
type RestEndpoint = keyof typeof REST_ENDPOINT_COMMANDS;

export interface RestApiDependencies {
  checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  appOrigin(): string;
  /** Test seam for callback URL DNS checks. */
  callbackResolver?: HostResolver;
  log?: (entry: Record<string, unknown>) => void;
}

type Env = { Variables: { requestId: string; principal: IntegrationPrincipal; limiter: RateLimitResult } };
type RestContext = Context<Env>;

const security = [{ bearerAuth: [] }];
const json = <T>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(schemas.restErrorSchema, "Invalid request"),
  401: json(schemas.restErrorSchema, "Missing or invalid API key"),
  402: json(schemas.restErrorSchema, "The Workspace needs active Business access"),
  403: json(schemas.restErrorSchema, "Scope, role, or Workspace boundary refusal"),
  404: json(schemas.restErrorSchema, "Not found"),
  409: json(schemas.restErrorSchema, "Conflict, including an idempotency key reused with different input"),
  422: json(schemas.restErrorSchema, "Unprocessable"),
  429: json(schemas.restErrorSchema, "Rate limited; see Retry-After"),
  503: json(schemas.restErrorSchema, "Temporarily unavailable; see Retry-After"),
} as const;
const body = <T>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });

function route<const R extends RouteConfig>(config: R) {
  return createRoute({ security, ...config, responses: { ...errors, ...config.responses } });
}

class RestFailure extends Error {
  constructor(readonly status: 400 | 401 | 404 | 429, readonly code: string, message: string, readonly extra: { details?: Record<string, unknown>; retryAfterSeconds?: number; headers?: Record<string, string> } = {}) {
    super(message);
  }
}

/** The OpenAPI document's header; `origin` becomes its only server. */
export function openApiDocumentConfig(origin: string) {
  return {
    openapi: "3.1.0",
    info: { title: "Narriflow API", version: "1.0.0", description: "Turn long videos into short, captioned clips. Changes within v1 are additive." },
    servers: [{ url: origin }],
  };
}

export function createRestApi(dependencies: RestApiDependencies) {
  const admission = new IntegrationAdmission(workspaceService);
  const uploads = integrationUploadSessions(uploadSessionService);
  const log = dependencies.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  const origin = () => new URL(dependencies.appOrigin()).origin;

  const app = new OpenAPIHono<Env>({
    defaultHook: (result) => {
      if (result.success) return;
      const issues = result.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      if (result.target === "header" && issues.some((issue) => issue.path === "idempotency-key")) {
        throw new RestFailure(400, "idempotency_key_required", "Send an Idempotency-Key header of 1–200 URL-safe characters", { details: { issues } });
      }
      throw new RestFailure(400, "invalid_request", "The request is invalid", { details: { issues } });
    },
  }).basePath("/api/v1");

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http", scheme: "bearer", description: "A Workspace API key (nf_…) from Settings → Developer access",
  });

  app.use("*", async (c, next) => {
    const started = performance.now();
    const requestId = `req_${randomUUID().replaceAll("-", "")}`;
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("X-Request-Id", requestId);
    c.res.headers.set("Cache-Control", "no-store");
    const principal = c.get("principal");
    log({ level: c.res.status >= 500 ? "error" : "info", message: "rest_api_request", requestId, method: c.req.method,
      route: c.req.routePath, status: c.res.status, durationMs: Math.round(performance.now() - started),
      ...(principal?.kind === "api_key" ? { apiKeyId: principal.apiKeyId, workspaceId: principal.workspaceId } : {}) });
  });

  app.doc31("/openapi.json", (c) => openApiDocumentConfig(new URL(c.req.url).origin));

  // Authentication: the key is the Workspace. Membership, role, and plan are
  // rechecked by admission on every request.
  app.use("*", async (c, next) => {
    if (c.req.path === "/api/v1/openapi.json") return next();
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer (nf_[A-Za-z0-9_-]+)$/.exec(header);
    const challenge = { "WWW-Authenticate": 'Bearer realm="narriflow"' };
    if (!match) throw new RestFailure(401, "authentication_required", "Send a Workspace API key as a Bearer token", { headers: challenge });
    const key = await workspaceService.authenticateApiKey(match[1]!);
    if (!key) throw new RestFailure(401, "invalid_api_key", "This API key is invalid or revoked", { headers: { "WWW-Authenticate": 'Bearer realm="narriflow", error="invalid_token"' } });
    c.set("principal", { kind: "api_key", userId: key.userId, clientId: `api_key:${key.apiKeyId}`, apiKeyId: key.apiKeyId, workspaceId: key.workspaceId, scopes: key.scopes });
    const limiter = await dependencies.checkRateLimit(`rest:${key.apiKeyId}`, REST_API_RATE_LIMIT.limit, REST_API_RATE_LIMIT.windowSeconds);
    c.set("limiter", limiter);
    if (!limiter.allowed) throw new RestFailure(429, "rate_limited", "This API key sent more than 300 requests this minute", { retryAfterSeconds: 60, headers: { "Retry-After": "60" } });
    await next();
    if (limiter.availability === "available") {
      c.res.headers.set("RateLimit-Limit", String(limiter.limit));
      c.res.headers.set("RateLimit-Remaining", String(limiter.remaining));
    }
  });

  app.onError((error, c) => {
    const requestId = c.get("requestId");
    const respond = (status: number, payload: { error: string; message: string; details?: unknown; retryAfterSeconds?: number }, headers: Record<string, string> = {}) =>
      c.json({ error: payload.error, message: payload.message, requestId,
        ...(payload.details ? { details: payload.details } : {}), ...(payload.retryAfterSeconds ? { retryAfterSeconds: payload.retryAfterSeconds } : {}) },
      status as 400, { ...headers, ...(payload.retryAfterSeconds ? { "Retry-After": String(payload.retryAfterSeconds) } : {}), "X-Request-Id": requestId, "Cache-Control": "no-store" });
    if (error instanceof RestFailure) return respond(error.status, { error: error.code, message: error.message, details: error.extra.details, retryAfterSeconds: error.extra.retryAfterSeconds }, error.extra.headers);
    if (isExpectedDomainFailure(error)) {
      const status = domainFailureHttpStatus(error.kind);
      const retryAfterSeconds = error.retryAfterSeconds ?? (status === 503 ? 5 : undefined);
      const insufficientScope: Record<string, string> = error.code === "scope_required" && typeof (error.details as { scope?: unknown } | undefined)?.scope === "string"
        ? { "WWW-Authenticate": `Bearer realm="narriflow", error="insufficient_scope", scope="${(error.details as { scope: string }).scope}"` } : {};
      return respond(status, { error: error.code, message: error.message, details: boundedExpectedDomainFailureDetails(error.details), retryAfterSeconds }, insufficientScope);
    }
    log({ level: "error", message: "rest_api_failed", requestId, route: c.req.routePath, errorName: error instanceof Error ? error.name : "unknown" });
    return respond(500, { error: "internal_error", message: "Narriflow could not complete this request. Retry with the same idempotency key, or contact support with the request ID." });
  });

  app.notFound((c) => { throw new RestFailure(404, "route_not_found", `No ${c.req.method} ${c.req.path} endpoint exists`); });

  const admit = (c: RestContext, endpoint: RestEndpoint, scope?: WorkspaceApiKeyScope) =>
    admission.requireWorkspace(REST_ENDPOINT_COMMANDS[endpoint], c.get("principal"), { surface: "rest", scope });
  const newMutationGuard = (c: RestContext) => async () => { requireNewMutationAllowed(c.get("limiter")); };
  const idempotencyKey = (c: RestContext) => {
    const key = c.req.header("idempotency-key") ?? "";
    if (!schemas.REST_IDEMPOTENCY_KEY_PATTERN.test(key)) throw new RestFailure(400, "idempotency_key_required", "Send an Idempotency-Key header of 1–200 URL-safe characters");
    return key;
  };
  const mutation = async (c: RestContext, callback?: { url: string }): Promise<IntegrationMutation> => ({
    clientIdempotencyKey: idempotencyKey(c),
    beforeAccept: newMutationGuard(c),
    ...(callback ? { callback: { url: await assertCompletionCallbackUrl(callback.url, dependencies.callbackResolver) } } : {}),
  });
  const replayed = (c: RestContext, wasReplayed: boolean) => { if (wasReplayed) c.header("Idempotent-Replayed", "true"); };
  const statusUrl = (operationId: string) => `${origin()}/api/v1/operations/${operationId}`;
  const accepted = (operation: { kind: "intake" | "generation" | "export"; id: string }) => {
    const operationId = encodeOperationId(operation);
    return { operationId, kind: operation.kind, statusUrl: statusUrl(operationId) };
  };
  const generation = (input: unknown) => generationSettingsSchema.parse(input ?? {});

  type UploadOutcome = Awaited<ReturnType<typeof uploads.open>> | Awaited<ReturnType<typeof uploads.status>> | Awaited<ReturnType<typeof uploads.finalize>> | Awaited<ReturnType<typeof uploads.discard>>;
  const uploadView = (outcome: UploadOutcome) => {
    const transfer = outcome.outcome === "uploading"
      ? outcome.transfer.kind === "single"
        ? { kind: "single" as const, method: "PUT" as const, url: outcome.transfer.grant.url, headers: { "Content-Type": outcome.transfer.grant.contentType } }
        : { kind: "multipart" as const, partSizeBytes: outcome.transfer.partSizeBytes, partCount: outcome.transfer.partCount, concurrency: outcome.transfer.concurrency,
            parts: outcome.transfer.grants, grantExpiresAt: outcome.transfer.grantExpiresAt, completedParts: outcome.transfer.completedParts }
      : null;
    const intake = outcome.outcome === "queued_for_ingest" || outcome.outcome === "reconciling";
    return {
      uploadId: outcome.sessionId,
      state: outcome.outcome,
      projectId: "projectId" in outcome ? outcome.projectId : null,
      expiresAt: outcome.outcome === "uploading" ? outcome.expiresAt : null,
      transfer,
      retryAfterSeconds: "retryAfterSeconds" in outcome ? outcome.retryAfterSeconds : null,
      failureCode: outcome.outcome === "terminal" ? outcome.failureCode ?? outcome.state : null,
      operation: intake ? accepted({ kind: "intake", id: outcome.sessionId }) : null,
    };
  };
  const operationView = (status: OperationStatus) => {
    const operationId = encodeOperationId(status);
    return { operationId, kind: status.kind, state: status.state, stage: status.stage, progress: status.progress, items: status.items, results: status.results,
      failureCode: status.failureCode, reviewUrl: status.results.projectId ? `${origin()}/projects/${status.results.projectId}` : null, statusUrl: statusUrl(operationId) };
  };
  const decodeOperation = (value: string) => {
    const operation = decodeOperationId(value);
    if (!operation) throw new ExpectedDomainFailureError({ code: "operation_not_found", kind: "missing", message: "This operation doesn't exist in the key's workspace. Use the operation ID returned by the accepted request." });
    return operation;
  };

  return app
    .openapi(route({ method: "get", path: "/workspace", summary: "Get the key's Workspace, plan, and processing usage", tags: ["Workspace"],
      responses: { 200: json(schemas.workspaceResultSchema, "Workspace and usage") } }), async (c) => {
      const actor = await admit(c, "GET /workspace");
      return c.json({ workspace: { workspaceId: actor.workspaceId, name: actor.workspaceName, role: actor.role, status: actor.status, pricingTier: actor.pricingTier },
        usage: await projectService.getUsageSummary(actor) }, 200);
    })
    .openapi(route({ method: "get", path: "/brand-profiles", summary: "List Brand Profiles", tags: ["Workspace"],
      responses: { 200: json(schemas.brandProfilesResultSchema, "Brand Profiles") } }), async (c) => {
      const profiles = await brandProfileService.listSummaries(await admit(c, "GET /brand-profiles"));
      return c.json({ profiles: profiles.map((profile) => ({ brandProfileId: profile.id, name: profile.name, isDefault: profile.isDefault,
        defaultStyle: profile.defaultStyle ? { templateId: profile.defaultStyle.id, name: profile.defaultStyle.name } : null })) }, 200);
    })
    .openapi(route({ method: "post", path: "/uploads", summary: "Open an Upload Session", tags: ["Uploads"],
      description: "Returns signed transfer URLs. Use transfer \"single\" to upload any supported size with one PUT. Retrying with the same Idempotency-Key returns the same Upload Session.",
      request: { headers: schemas.restIdempotencyHeaders, ...body(schemas.openUploadRequestSchema) },
      responses: { 200: json(schemas.uploadResultSchema, "The Upload Session") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = await admit(c, "POST /uploads");
      const key = idempotencyKey(c);
      const settings = generation(input.generation);
      const outcome = await uploads.open(actor, {
        clientIdempotencyKey: key,
        title: input.title ?? input.file.name,
        // The shared upload rule replaces this with a fingerprint every transport computes alike.
        source: { fileName: input.file.name, sizeBytes: input.file.sizeBytes, contentType: input.file.contentType, browserFingerprint: "rest" },
        ...(input.brandProfileId ? { brandProfileId: input.brandProfileId } : {}),
        generationContext: { contentPack: buildGenerationContentPack(settings), languageCode: settings.languageCode },
        transfer: input.transfer,
      }, newMutationGuard(c));
      return c.json({ upload: uploadView(outcome) }, 200);
    })
    .openapi(route({ method: "get", path: "/uploads/{id}", summary: "Read an Upload Session", tags: ["Uploads"],
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.uploadResultSchema, "The Upload Session") } }), async (c) => {
      const actor = await admit(c, "GET /uploads/{id}");
      return c.json({ upload: uploadView(await uploadSessionService.statusById(actor, c.req.valid("param").id)) }, 200);
    })
    .openapi(route({ method: "post", path: "/uploads/{id}/grants", summary: "Issue more multipart part URLs", tags: ["Uploads"],
      request: { params: schemas.restUuidParam, ...body(schemas.grantPartsRequestSchema) }, responses: { 200: json(schemas.grantPartsResultSchema, "Signed part URLs") } }), async (c) => {
      const actor = await admit(c, "POST /uploads/{id}/grants");
      const granted = await uploads.grant(actor, { sessionId: c.req.valid("param").id, partNumbers: c.req.valid("json").partNumbers });
      return c.json({ uploadId: granted.sessionId, expiresAt: granted.expiresAt, parts: granted.grants }, 200);
    })
    .openapi(route({ method: "post", path: "/uploads/{id}/finalize", summary: "Finalize an upload and start its intake", tags: ["Uploads"],
      description: "Starts the upload intake. Repeating finalize for the same Upload Session returns its current state; a different callback URL is a conflict.",
      request: { params: schemas.restUuidParam, ...body(schemas.finalizeUploadRequestSchema) }, responses: { 200: json(schemas.uploadResultSchema, "The accepted intake") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = await admit(c, "POST /uploads/{id}/finalize");
      const sessionId = c.req.valid("param").id;
      const callback = input.callback ? { url: await assertCompletionCallbackUrl(input.callback.url, dependencies.callbackResolver) } : undefined;
      const outcome = await uploads.finalize(actor, { sessionId, parts: input.parts }, { callback }, newMutationGuard(c));
      return c.json({ upload: uploadView(outcome), callback: callback ? { eventId: callbackEventId(sessionId) } : null }, 200);
    })
    .openapi(route({ method: "delete", path: "/uploads/{id}", summary: "Discard an unfinished upload", tags: ["Uploads"],
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.uploadResultSchema, "The discarded Upload Session") } }), async (c) => {
      const actor = await admit(c, "DELETE /uploads/{id}");
      await newMutationGuard(c)();
      return c.json({ upload: uploadView(await uploads.discard(actor, { sessionId: c.req.valid("param").id })) }, 200);
    })
    .openapi(route({ method: "post", path: "/projects", summary: "Submit a video link", tags: ["Projects"],
      description: "Imports a supported video link with committed generation settings. Accepts an optional completion callback.",
      request: { headers: schemas.restIdempotencyHeaders, ...body(schemas.submitVideoRequestSchema) }, responses: { 202: json(schemas.acceptedProjectSchema, "Accepted intake") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = await admit(c, "POST /projects");
      const result = await submitVideo(actor, { url: input.url, title: input.title, brandProfileId: input.brandProfileId, generation: generation(input.generation) }, await mutation(c, input.callback));
      replayed(c, result.replayed);
      return c.json({ projectId: result.projectId, operation: accepted(result.operation), reviewUrl: `${origin()}/projects/${result.projectId}`, callback: result.callback }, 202);
    })
    .openapi(route({ method: "get", path: "/projects", summary: "List projects", tags: ["Projects"],
      request: { query: schemas.listProjectsQuery }, responses: { 200: json(schemas.projectsResultSchema, "A page of projects") } }), async (c) => {
      const query = c.req.valid("query");
      const page = await workspaceLibraryService.listProjects(await admit(c, "GET /projects"), { limit: query.limit, cursor: query.cursor ?? null });
      return c.json({ items: page.items.map((project) => ({ ...projectView(project, origin()), progress: { ...project.progress, stage: null, percent: null }, clipCount: project.clipCount })),
        nextCursor: page.nextCursor, totalCount: page.totalCount }, 200);
    })
    .openapi(route({ method: "get", path: "/projects/{id}", summary: "Get a project", tags: ["Projects"],
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.projectResultSchema, "The project") } }), async (c) => {
      const snapshot = await projectService.getProjectSnapshot(await admit(c, "GET /projects/{id}"), c.req.valid("param").id);
      if (!snapshot.project) throw new ExpectedDomainFailureError({ code: "project_not_found", kind: "missing", message: "This project doesn't exist in the key's workspace, or it has been deleted. List projects for current IDs." });
      return c.json({ project: projectView(snapshot.project, origin()),
        progress: snapshot.progress ? { ...snapshot.progress, stage: snapshot.activeRun?.stage ?? null, percent: snapshot.activeRun?.progress ?? null } : null }, 200);
    })
    .openapi(route({ method: "post", path: "/projects/{id}/generations", summary: "Generate clips", tags: ["Projects"],
      request: { params: schemas.restUuidParam, headers: schemas.restIdempotencyHeaders, ...body(schemas.generateClipsRequestSchema) },
      responses: { 202: json(schemas.acceptedProjectSchema, "Accepted generation") } }), async (c) => {
      const input = c.req.valid("json");
      const projectId = c.req.valid("param").id;
      const actor = await admit(c, "POST /projects/{id}/generations");
      const result = await generateClips(actor, { projectId, generation: generation(input.generation), forceRegenerate: input.forceRegenerate }, await mutation(c, input.callback));
      replayed(c, result.replayed);
      return c.json({ projectId, operation: accepted(result.operation), reviewUrl: `${origin()}/projects/${projectId}`, callback: result.callback }, 202);
    })
    .openapi(route({ method: "get", path: "/projects/{id}/clips", summary: "List a project's clips by virality", tags: ["Clips"],
      request: { params: schemas.restUuidParam, query: schemas.listClipsQuery }, responses: { 200: json(schemas.clipsResultSchema, "A page of clips") } }), async (c) => {
      const query = c.req.valid("query");
      const page = await clipService.listClipReviewFacts(await admit(c, "GET /projects/{id}/clips"), c.req.valid("param").id, { limit: query.limit, cursor: query.cursor ?? null, includeTranscriptExcerpt: query.includeTranscriptExcerpt });
      return c.json({ items: page.items.map((clip) => clipView(clip, origin(), query.includeTranscriptExcerpt)), nextCursor: page.nextCursor }, 200);
    })
    .openapi(route({ method: "get", path: "/clips/{id}", summary: "Get a clip", tags: ["Clips"],
      request: { params: schemas.restUuidParam, query: schemas.getClipQuery }, responses: { 200: json(schemas.clipResultSchema, "The clip") } }), async (c) => {
      const actor = await admit(c, "GET /clips/{id}");
      const { includeTranscriptExcerpt } = c.req.valid("query");
      const clip = await locateClip(actor, c.req.valid("param").id);
      return c.json({ clip: clipView(await clipService.getClipReviewFacts(actor, clip.projectId, clip.clipId, { includeTranscriptExcerpt }), origin(), includeTranscriptExcerpt) }, 200);
    })
    .openapi(route({ method: "post", path: "/clips/{id}/exports", summary: "Export a clip revision", tags: ["Exports"],
      description: "Exports the exact editor revision in the selected formats. The response reports any plan limit applied to resolution or watermark.",
      request: { params: schemas.restUuidParam, headers: schemas.restIdempotencyHeaders, ...body(schemas.createExportRequestSchema) },
      responses: { 202: json(schemas.createdExportResultSchema, "Accepted export") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = await admit(c, "POST /clips/{id}/exports");
      const clip = await locateClip(actor, c.req.valid("param").id);
      const result = await createClipExport(actor, { ...clip, expectedRevision: input.expectedRevision, aspectRatios: input.aspectRatios, resolution: input.resolution }, await mutation(c, input.callback));
      replayed(c, result.replayed);
      return c.json({ export: exportView(result.export, origin()), reused: result.reused, output: result.output, operation: accepted(result.operation), callback: result.callback }, 202);
    })
    .openapi(route({ method: "get", path: "/exports/{id}", summary: "Get an export", tags: ["Exports"],
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.exportResultSchema, "The export") } }), async (c) => {
      const actor = await admit(c, "GET /exports/{id}");
      const located = await locateExport(actor, c.req.valid("param").id);
      const snapshot = await clipExportService.getOwned(actor, located.projectId, located.clipId, located.exportId);
      if (!snapshot) throw new ExpectedDomainFailureError({ code: "clip_export_not_found", kind: "missing", message: "This export doesn't exist in the key's workspace. Use the export ID returned when it was requested." });
      return c.json({ export: exportView(snapshot, origin()) }, 200);
    })
    .openapi(route({ method: "get", path: "/exports/{id}/download", summary: "Issue Download Grants and subtitles", tags: ["Exports"],
      description: "Fresh private download URLs (valid 15 minutes) for a finished export's files, plus SRT and VTT subtitles. Call again for new URLs.",
      request: { params: schemas.restUuidParam, query: schemas.exportDownloadQuery }, responses: { 200: json(schemas.exportDownloadResultSchema, "Download Grants") } }), async (c) => {
      const actor = await admit(c, "GET /exports/{id}/download");
      return c.json(await clipExportService.issueDownloadGrants(actor, c.req.valid("param").id, { variantId: c.req.valid("query").variantId, credentialKind: "api_key" }), 200);
    })
    .openapi(route({ method: "get", path: "/operations/{id}", summary: "Get Operation Status", tags: ["Operations"],
      description: "Follows exactly the work one accepted request started, with per-clip or per-format outcomes.",
      request: { params: schemas.restOperationIdParam }, responses: { 200: json(schemas.operationSchema, "Operation Status") } }), async (c) => {
      const operation = decodeOperation(c.req.valid("param").id);
      const actor = await admit(c, "GET /operations/{id}", operationReadScope(operation.kind));
      return c.json(operationView(await operationStatusService.read(actor, operation)), 200);
    })
    .openapi(route({ method: "post", path: "/operations/{id}/callback/redeliver", summary: "Redeliver completion callbacks", tags: ["Operations"],
      description: "Resets this operation's delivered or failed callbacks with a fresh attempt budget and the same event IDs.",
      request: { params: schemas.restOperationIdParam, headers: schemas.restIdempotencyHeaders }, responses: { 202: json(schemas.redeliverResultSchema, "Callbacks queued again") } }), async (c) => {
      const operation = decodeOperation(c.req.valid("param").id);
      const actor: ActorScope = await admit(c, "POST /operations/{id}/callback/redeliver", operationWriteScope(operation.kind));
      const result = await redeliverCallbacks(actor, operation, await mutation(c));
      replayed(c, result.replayed);
      return c.json({ callbacks: result.callbacks as Array<{ eventId: string; state: "waiting" | "pending" | "delivered" | "failed" | "cancelled" }> }, 202);
    });
}

export type RestApi = ReturnType<typeof createRestApi>;
