import { randomUUID } from "node:crypto";
import { createRoute, OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv } from "../../http/env";
import { limitBody } from "../../http/limits";
import { REST_ENDPOINT_COMMANDS, type RestEndpoint } from "./admission";
import {
  assertCompletionCallbackUrl,
  boundedExpectedDomainFailureDetails,
  brandProfileService,
  callbackEventId,
  captionedVideoGenerationContext,
  captionedVideoSettings,
  clipExportService,
  clipService,
  clipTimelineService,
  clipView,
  createCaptionedVideo,
  createClipExport,
  decodeOperationId,
  encodeOperationId,
  ExpectedDomainFailureError,
  exportView,
  generateClips,
  IntegrationAdmission,
  integrationUploadSessions,
  isExpectedDomainFailure,
  librarySearchService,
  listEvents,
  locateClip,
  locateExport,
  operationReadScope,
  operationStatusService,
  operationWriteScope,
  projectService,
  projectView,
  proposeSocialPost,
  recipeService,
  recipesView,
  recipeView,
  redeliverCallbacks,
  requireNewMutationAllowed,
  requireQueueDeliveryScope,
  requireWebhookTypeScopes,
  socialAccountsView,
  submitVideo,
  uploadSessionService,
  webhookSubscriptions,
  workspaceLibraryService,
  workspaceService,
  type ActorScope,
  type HostResolver,
  type IntegrationMutation,
  type IntegrationPrincipal,
  type OperationStatus,
  type RateLimitResult,
} from "@narriflow/services";
import { buildGenerationContext, generationSettingsSchema, parseWorkspaceEventTypes, restApiSchemas as schemas } from "@narriflow/validators";
import { domainFailureHttpStatus } from "../../http/errors";

/** Public REST API v1. A separate Hono app from the browser API: Workspace API
 * keys only, the key's Workspace only, and the same commands and admission
 * table as MCP. See docs/integrations/rest-api.md. */

const REPLAYABLE_ENDPOINTS = new Set([
  "POST /uploads", "POST /projects", "POST /captioned-videos", "POST /projects/{id}/generations",
  "POST /clips/{id}/exports", "POST /social-posts/proposals", "POST /operations/{id}/callback/redeliver",
]);

export const REST_API_RATE_LIMIT = { limit: 300, windowSeconds: 60 } as const;

export interface RestRouteDeps {
  checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  apiOrigin(): string;
  webOrigin(): string;
  corsAllowedOrigins: readonly string[];
  /** Test seam for callback URL DNS checks. */
  callbackResolver?: HostResolver;
  log?: (entry: Record<string, unknown>) => void;
}

/** REST's independent credential state; it never populates the first-party actor. */
type Env = {
  Variables: ApiEnv["Variables"] & {
    restActor: Awaited<ReturnType<IntegrationAdmission["requireWorkspace"]>>;
    restPrincipal: IntegrationPrincipal;
    restLimiter: RateLimitResult;
  };
};
type RestContext = Context<Env>;

const security = [{ bearerAuth: [] }];
/** The usage read model as JSON: credit period dates become ISO strings. */
const usageView = (usage: Awaited<ReturnType<typeof projectService.getUsageSummary>>) =>
  ({ ...usage, periodStart: usage.periodStart.toISOString(), renewsAt: usage.renewsAt.toISOString() });
const json = <T>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(schemas.restErrorSchema, "Invalid request"),
  401: json(schemas.restErrorSchema, "Missing or invalid API key"),
  402: json(schemas.restErrorSchema, "Plan or billing refusal. `plan_feature_required` and `plan_limit_reached` name the feature or limit, the current tier, and the required tier in `details`; `credits_exhausted` reports the month's credits; `integration_access_unavailable` means the Workspace isn't active"),
  403: json(schemas.restErrorSchema, "Scope, role, or Workspace boundary refusal"),
  404: json(schemas.restErrorSchema, "Not found"),
  409: json(schemas.restErrorSchema, "Conflict, including an idempotency key reused with different input"),
  422: json(schemas.restErrorSchema, "Unprocessable"),
  429: json(schemas.restErrorSchema, "Rate limited; see Retry-After"),
  503: json(schemas.restErrorSchema, "Temporarily unavailable; see Retry-After"),
} as const;
const body = <T>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });

class RestFailure extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 413 | 429, readonly code: string, message: string, readonly extra: { details?: Record<string, unknown>; retryAfterSeconds?: number; headers?: Record<string, string> } = {}) {
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

export function createRestOpenApiRoutes(dependencies: RestRouteDeps) {
  const admission = new IntegrationAdmission(workspaceService);
  const uploads = integrationUploadSessions(uploadSessionService);
  const log = dependencies.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  const apiOrigin = () => new URL(dependencies.apiOrigin()).origin;
  const webOrigin = () => new URL(dependencies.webOrigin()).origin;

  const app = new OpenAPIHono<Env>({
    defaultHook: (result) => {
      if (result.success) return;
      const issues = result.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      if (result.target === "header" && issues.some((issue) => issue.path === "idempotency-key")) {
        throw new RestFailure(400, "idempotency_key_required", "Send an Idempotency-Key header of 1–200 URL-safe characters", { details: { issues } });
      }
      throw new RestFailure(400, "invalid_request", "The request is invalid", { details: { issues } });
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http", scheme: "bearer", description: "A Workspace API key (nf_…) from Settings → Developer access",
  });

  app.use("*", async (c, next) => {
    const started = performance.now();
    const requestId = c.get("requestId") ?? `req_${randomUUID().replaceAll("-", "")}`;
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("X-Request-Id", requestId);
    c.res.headers.set("Cache-Control", "no-store");
    const principal = c.get("restPrincipal");
    log({ level: c.res.status >= 500 ? "error" : "info", message: "rest_api_request", requestId, method: c.req.method,
      route: c.req.routePath, status: c.res.status, durationMs: Math.round(performance.now() - started),
      ...(principal?.kind === "api_key" ? { apiKeyId: principal.apiKeyId, workspaceId: principal.workspaceId } : {}) });
  });

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !dependencies.corsAllowedOrigins.includes(origin)) {
      throw new RestFailure(403, "origin_not_allowed", "This origin is not allowed");
    }
    await next();
  });
  app.use("*", cors({
    origin: [...dependencies.corsAllowedOrigins],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    exposeHeaders: ["X-Request-Id", "Retry-After", "Idempotent-Replayed", "RateLimit-Limit", "RateLimit-Remaining"],
    credentials: false,
  }));
  app.use("*", limitBody("control") as MiddlewareHandler<Env>);
  app.get("/openapi.json", (c) => c.json(restOpenApiDocument(app, apiOrigin())));

  // Authentication: the key is the Workspace. Membership, role, and plan are
  // rechecked by admission on every request.
  app.use("*", async (c, next) => {
    if (c.req.path.endsWith("/openapi.json")) return next();
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer (nf_[A-Za-z0-9_-]+)$/.exec(header);
    const challenge = { "WWW-Authenticate": 'Bearer realm="narriflow"' };
    if (!match) throw new RestFailure(401, "authentication_required", "Send a Workspace API key as a Bearer token", { headers: challenge });
    const key = await workspaceService.authenticateApiKey(match[1]!);
    if (!key) throw new RestFailure(401, "invalid_api_key", "This API key is invalid or revoked", { headers: { "WWW-Authenticate": 'Bearer realm="narriflow", error="invalid_token"' } });
    c.set("restPrincipal", { kind: "api_key", userId: key.userId, clientId: `api_key:${key.apiKeyId}`, apiKeyId: key.apiKeyId, workspaceId: key.workspaceId, scopes: key.scopes });
    const limiter = await dependencies.checkRateLimit(`rest:${key.apiKeyId}`, REST_API_RATE_LIMIT.limit, REST_API_RATE_LIMIT.windowSeconds);
    c.set("restLimiter", limiter);
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
    if (error instanceof HTTPException && error.status === 400) return respond(400, { error: "invalid_request", message: "The request is invalid" });
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

  const requireActor = (c: RestContext) => c.get("restActor");
  function route<const R extends RouteConfig>(config: R) {
    const endpoint = `${config.method.toUpperCase()} ${config.path}` as RestEndpoint;
    if (!Object.hasOwn(REST_ENDPOINT_COMMANDS, endpoint)) throw new Error(`Undeclared REST endpoint: ${endpoint}`);
    const authenticate: MiddlewareHandler<Env> = async (c, next) => {
      const limiter = c.get("restLimiter");
      if (!limiter.allowed && !REPLAYABLE_ENDPOINTS.has(endpoint)) {
        throw new RestFailure(429, "rate_limited", "This API key sent more than 300 requests this minute", { retryAfterSeconds: 60 });
      }
      const command = REST_ENDPOINT_COMMANDS[endpoint];
      const operation = endpoint === "GET /operations/{id}" || endpoint === "POST /operations/{id}/callback/redeliver"
        ? decodeOperation(c.req.param("id") ?? "") : undefined;
      const scope = operation ? (command === "get_operation" ? operationReadScope(operation.kind) : operationWriteScope(operation.kind)) : undefined;
      c.set("restActor", await admission.requireWorkspace(command, c.get("restPrincipal"), { surface: "rest", scope }));
      if (config.request?.body && c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        throw new RestFailure(400, "invalid_request", "Send the request body as application/json");
      }
      await next();
    };
    return createRoute({ security, ...config, middleware: [authenticate] as const, responses: { ...errors, ...config.responses } });
  }
  const newMutationGuard = (c: RestContext) => async () => {
    const limiter = c.get("restLimiter");
    if (!limiter.allowed) throw new RestFailure(429, "rate_limited", "This API key sent more than 300 requests this minute", { retryAfterSeconds: 60 });
    requireNewMutationAllowed(limiter);
  };
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
  const statusUrl = (operationId: string) => `${apiOrigin()}/api/v1/operations/${operationId}`;
  const accepted = (operation: { kind: "intake" | "generation" | "export"; id: string }) => {
    const operationId = encodeOperationId(operation);
    return { operationId, kind: operation.kind, statusUrl: statusUrl(operationId) };
  };
  const generation = (input: unknown) => generationSettingsSchema.parse(input ?? {});
  const recipeUsed = (recipe: { id: string; revision: number } | undefined) => (recipe ? { recipe } : {});

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
      ...("recipe" in outcome && outcome.recipe ? { recipe: outcome.recipe } : {}),
    };
  };
  const operationView = (status: OperationStatus) => {
    const operationId = encodeOperationId(status);
    return { operationId, kind: status.kind, state: status.state, stage: status.stage, progress: status.progress, items: status.items, results: status.results,
      notices: status.notices, failureCode: status.failureCode, reviewUrl: status.results.projectId ? `${webOrigin()}/projects/${status.results.projectId}` : null, statusUrl: statusUrl(operationId) };
  };
  const decodeOperation = (value: string) => {
    const operation = decodeOperationId(value);
    if (!operation) throw new ExpectedDomainFailureError({ code: "operation_not_found", kind: "missing", message: "This operation doesn't exist in the key's workspace. Use the operation ID returned by the accepted request." });
    return operation;
  };

  return app
    .openapi(route({ method: "get", path: "/workspace", summary: "Get the key's Workspace, plan, and credit usage", tags: ["Workspace"],
      responses: { 200: json(schemas.workspaceResultSchema, "Workspace and usage") } }), async (c) => {
      const actor = requireActor(c);
      return c.json({ workspace: { workspaceId: actor.workspaceId, name: actor.workspaceName, role: actor.role, status: actor.status, pricingTier: actor.pricingTier },
        usage: usageView(await projectService.getUsageSummary(actor)) }, 200);
    })
    .openapi(route({ method: "get", path: "/brand-profiles", summary: "List Brand Profiles", tags: ["Workspace"],
      responses: { 200: json(schemas.brandProfilesResultSchema, "Brand Profiles") } }), async (c) => {
      const profiles = await brandProfileService.listSummaries(requireActor(c));
      return c.json({ profiles: profiles.map((profile) => ({ brandProfileId: profile.id, name: profile.name, isDefault: profile.isDefault,
        defaultStyle: profile.defaultStyle ? { templateId: profile.defaultStyle.id, name: profile.defaultStyle.name } : null })) }, 200);
    })
    .openapi(route({ method: "get", path: "/recipes", summary: "List Recipes", tags: ["Workspace"],
      description: "The Workspace's saved Recipes. Pass a recipeId to start an import or generation with a Recipe's Brand Profile, language, generation settings, and finishing instead of sending them. Recipes are created and edited in Narriflow.",
      responses: { 200: json(schemas.recipesResultSchema, "Recipes") } }), async (c) => {
      return c.json(await recipesView(requireActor(c)), 200);
    })
    .openapi(route({ method: "get", path: "/recipes/{id}", summary: "Get a Recipe", tags: ["Workspace"],
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.recipeResultSchema, "The Recipe at its current revision") } }), async (c) => {
      const actor = requireActor(c);
      return c.json({ recipe: recipeView(await recipeService.get(actor, c.req.valid("param").id)) }, 200);
    })
    .openapi(route({ method: "post", path: "/uploads", summary: "Open an Upload Session", tags: ["Uploads"],
      description: "Returns signed transfer URLs. Use transfer \"single\" to upload any supported size with one PUT. Retrying with the same Idempotency-Key returns the same Upload Session.",
      request: { headers: schemas.restIdempotencyHeaders, ...body(schemas.openUploadRequestSchema) },
      responses: { 200: json(schemas.uploadResultSchema, "The Upload Session") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = requireActor(c);
      requireQueueDeliveryScope(c.get("restPrincipal"), input.finishing);
      const key = idempotencyKey(c);
      const outcome = await uploads.open(actor, {
        clientIdempotencyKey: key,
        title: input.title ?? input.file.name,
        // The shared upload rule replaces this with a fingerprint every transport computes alike.
        source: { fileName: input.file.name, sizeBytes: input.file.sizeBytes, contentType: input.file.contentType, browserFingerprint: "rest" },
        // A Recipe supplies the Brand Profile and settings, read when the session is admitted.
        ...(input.recipeId
          ? { recipeId: input.recipeId }
          : { ...(input.brandProfileId ? { brandProfileId: input.brandProfileId } : {}), generationContext: buildGenerationContext(generation(input.generation), input.finishing) }),
        transfer: input.transfer,
      }, newMutationGuard(c), c.get("restPrincipal"));
      return c.json({ upload: uploadView(outcome) }, 200);
    })
    .openapi(route({ method: "get", path: "/uploads/{id}", summary: "Read an Upload Session", tags: ["Uploads"],
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.uploadResultSchema, "The Upload Session") } }), async (c) => {
      const actor = requireActor(c);
      return c.json({ upload: uploadView(await uploadSessionService.statusById(actor, c.req.valid("param").id)) }, 200);
    })
    .openapi(route({ method: "post", path: "/uploads/{id}/grants", summary: "Issue more multipart part URLs", tags: ["Uploads"],
      request: { params: schemas.restUuidParam, ...body(schemas.grantPartsRequestSchema) }, responses: { 200: json(schemas.grantPartsResultSchema, "Signed part URLs") } }), async (c) => {
      const actor = requireActor(c);
      const granted = await uploads.grant(actor, { sessionId: c.req.valid("param").id, partNumbers: c.req.valid("json").partNumbers });
      return c.json({ uploadId: granted.sessionId, expiresAt: granted.expiresAt, parts: granted.grants }, 200);
    })
    .openapi(route({ method: "post", path: "/uploads/{id}/finalize", summary: "Finalize an upload and start its intake", tags: ["Uploads"],
      description: "Starts the upload intake. Repeating finalize for the same Upload Session returns its current state; a different callback URL is a conflict.",
      request: { params: schemas.restUuidParam, ...body(schemas.finalizeUploadRequestSchema) }, responses: { 200: json(schemas.uploadResultSchema, "The accepted intake") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = requireActor(c);
      const sessionId = c.req.valid("param").id;
      const callback = input.callback ? { url: await assertCompletionCallbackUrl(input.callback.url, dependencies.callbackResolver) } : undefined;
      const outcome = await uploads.finalize(actor, { sessionId, parts: input.parts }, { callback }, newMutationGuard(c));
      return c.json({ upload: uploadView(outcome), callback: callback ? { eventId: callbackEventId(sessionId) } : null }, 200);
    })
    .openapi(route({ method: "delete", path: "/uploads/{id}", summary: "Discard an unfinished upload", tags: ["Uploads"],
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.uploadResultSchema, "The discarded Upload Session") } }), async (c) => {
      const actor = requireActor(c);
      await newMutationGuard(c)();
      return c.json({ upload: uploadView(await uploads.discard(actor, { sessionId: c.req.valid("param").id })) }, 200);
    })
    .openapi(route({ method: "post", path: "/projects", summary: "Submit a video link", tags: ["Projects"],
      description: "Imports a supported video link with committed generation settings, sent inline or named by recipeId (not both). A Recipe is read when the request is accepted, and the response reports the Recipe and revision it used. Retrying with the same Idempotency-Key replays the original result even after the Recipe is edited. Accepts an optional completion callback.",
      request: { headers: schemas.restIdempotencyHeaders, ...body(schemas.submitVideoRequestSchema) }, responses: { 202: json(schemas.acceptedProjectSchema, "Accepted intake") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = requireActor(c);
      requireQueueDeliveryScope(c.get("restPrincipal"), input.finishing);
      const result = await submitVideo(actor, { url: input.url, title: input.title, brandProfileId: input.brandProfileId, generation: input.generation, finishing: input.finishing, recipeId: input.recipeId }, await mutation(c, input.callback), c.get("restPrincipal"));
      replayed(c, result.replayed);
      return c.json({ projectId: result.projectId, operation: accepted(result.operation), reviewUrl: `${webOrigin()}/projects/${result.projectId}`, callback: result.callback, ...recipeUsed(result.recipe) }, 202);
    })
    .openapi(route({ method: "post", path: "/captioned-videos", summary: "Caption a finished video", tags: ["Projects"],
      description: "Captions a short, finished video, such as an AI-generated one, frames it Fit (the whole frame) or Center (a centered cover crop), and exports it at each requested format. There is no clip detection: the Project gets one clip, the whole video, up to 3 minutes. Captions come from the speech (auto), from SRT or WebVTT you supply, or are omitted (none); a video without an audio stream gets no speech captions. Send a link to import it (202), or describe a file to open an Upload Session that carries these settings (200), upload it, and finalize it with POST /uploads/{id}/finalize. Follow the work with GET /operations/{id}: its results name the export, and its notices report framing_degraded when Center crops part of the frame.",
      request: { headers: schemas.restIdempotencyHeaders, ...body(schemas.captionedVideoRequestSchema) },
      responses: { 200: json(schemas.uploadResultSchema, "The Upload Session, for a file"), 202: json(schemas.acceptedProjectSchema, "Accepted intake, for a link") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = requireActor(c);
      const settings = captionedVideoSettings({ framing: input.framing, aspectRatios: input.aspectRatios, resolution: input.resolution, captions: input.captions });
      const { source } = input;
      if (source.kind === "url") {
        const result = await createCaptionedVideo(actor, { url: source.url, title: input.title, brandProfileId: input.brandProfileId, settings }, await mutation(c, source.callback));
        replayed(c, result.replayed);
        return c.json({ projectId: result.projectId, operation: accepted(result.operation), reviewUrl: `${webOrigin()}/projects/${result.projectId}`, callback: result.callback }, 202);
      }
      const outcome = await uploads.open(actor, {
        clientIdempotencyKey: idempotencyKey(c),
        title: input.title ?? source.file.name,
        source: { fileName: source.file.name, sizeBytes: source.file.sizeBytes, contentType: source.file.contentType, browserFingerprint: "rest" },
        ...(input.brandProfileId ? { brandProfileId: input.brandProfileId } : {}),
        generationContext: captionedVideoGenerationContext(settings),
        transfer: source.transfer,
      }, newMutationGuard(c));
      return c.json({ upload: uploadView(outcome) }, 200);
    })
    .openapi(route({ method: "get", path: "/projects", summary: "List projects", tags: ["Projects"],
      request: { query: schemas.listProjectsQuery }, responses: { 200: json(schemas.projectsResultSchema, "A page of projects") } }), async (c) => {
      const query = c.req.valid("query");
      const page = await workspaceLibraryService.listProjects(requireActor(c), { limit: query.limit, cursor: query.cursor ?? null });
      return c.json({ items: page.items.map((project) => ({ ...projectView(project, webOrigin()), progress: { ...project.progress, stage: null, percent: null }, clipCount: project.clipCount })),
        nextCursor: page.nextCursor, totalCount: page.totalCount }, 200);
    })
    .openapi(route({ method: "get", path: "/projects/{id}", summary: "Get a project", tags: ["Projects"],
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.projectResultSchema, "The project") } }), async (c) => {
      const snapshot = await projectService.getProjectSnapshot(requireActor(c), c.req.valid("param").id);
      if (!snapshot.project) throw new ExpectedDomainFailureError({ code: "project_not_found", kind: "missing", message: "This project doesn't exist in the key's workspace, or it has been deleted. List projects for current IDs." });
      return c.json({ project: projectView(snapshot.project, webOrigin()),
        progress: snapshot.progress ? { ...snapshot.progress, stage: snapshot.activeRun?.stage ?? null, percent: snapshot.activeRun?.progress ?? null } : null }, 200);
    })
    .openapi(route({ method: "get", path: "/library/search", summary: "Search transcripts", tags: ["Library"],
      description: "Finds timestamped moments across the Workspace's finished transcripts, by meaning and by exact words. Results are limited to Projects the key's user can view. Newly finished transcripts become searchable within a minute or two.",
      request: { query: schemas.librarySearchQuery }, responses: { 200: json(schemas.librarySearchResultsSchema, "Matching moments, best first") } }), async (c) => {
      const query = c.req.valid("query");
      const results = await librarySearchService.search(requireActor(c), { query: query.q, limit: query.limit, projectIds: query.projectId ? [query.projectId] : undefined });
      return c.json({ results }, 200);
    })
    .openapi(route({ method: "post", path: "/projects/{id}/generations", summary: "Generate clips", tags: ["Projects"],
      request: { params: schemas.restUuidParam, headers: schemas.restIdempotencyHeaders, ...body(schemas.generateClipsRequestSchema) },
      responses: { 202: json(schemas.acceptedProjectSchema, "Accepted generation") } }), async (c) => {
      const input = c.req.valid("json");
      const projectId = c.req.valid("param").id;
      const actor = requireActor(c);
      requireQueueDeliveryScope(c.get("restPrincipal"), input.finishing);
      const result = await generateClips(actor, { projectId, generation: input.generation, finishing: input.finishing, recipeId: input.recipeId, forceRegenerate: input.forceRegenerate }, await mutation(c, input.callback), c.get("restPrincipal"));
      replayed(c, result.replayed);
      return c.json({ projectId, operation: accepted(result.operation), reviewUrl: `${webOrigin()}/projects/${projectId}`, callback: result.callback, ...recipeUsed(result.recipe) }, 202);
    })
    .openapi(route({ method: "get", path: "/projects/{id}/clips", summary: "List a project's clips by virality", tags: ["Clips"],
      request: { params: schemas.restUuidParam, query: schemas.listClipsQuery }, responses: { 200: json(schemas.clipsResultSchema, "A page of clips") } }), async (c) => {
      const query = c.req.valid("query");
      const page = await clipService.listClipReviewFacts(requireActor(c), c.req.valid("param").id, { limit: query.limit, cursor: query.cursor ?? null, includeTranscriptExcerpt: query.includeTranscriptExcerpt });
      return c.json({ items: page.items.map((clip) => clipView(clip, webOrigin(), query.includeTranscriptExcerpt)), nextCursor: page.nextCursor }, 200);
    })
    .openapi(route({ method: "get", path: "/clips/{id}", summary: "Get a clip", tags: ["Clips"],
      request: { params: schemas.restUuidParam, query: schemas.getClipQuery }, responses: { 200: json(schemas.clipResultSchema, "The clip") } }), async (c) => {
      const actor = requireActor(c);
      const { includeTranscriptExcerpt } = c.req.valid("query");
      const clip = await locateClip(actor, c.req.valid("param").id);
      return c.json({ clip: clipView(await clipService.getClipReviewFacts(actor, clip.projectId, clip.clipId, { includeTranscriptExcerpt }), webOrigin(), includeTranscriptExcerpt) }, 200);
    })
    .openapi(route({ method: "get", path: "/clips/{id}/timeline", summary: "Get an editor timeline", tags: ["Clips"],
      description: "The clip's current edit as a timeline that cuts the original source at the clip's kept ranges, for Premiere Pro (xmeml), Final Cut Pro and DaVinci Resolve (fcpxml), or any editor (edl). Includes the clip's captions as SRT and a private Download Grant (valid 15 minutes) for the original source. Save the source under source.fileName beside the timeline file. Scenes, overlays, and burned-in captions are not timeline layers.",
      request: { params: schemas.restUuidParam, query: schemas.clipTimelineQuery }, responses: { 200: json(schemas.clipTimelineResultSchema, "Timeline, SRT, and a Download Grant for the source") } }), async (c) => {
      const actor = requireActor(c);
      const clip = await locateClip(actor, c.req.valid("param").id);
      return c.json(await clipTimelineService.export(actor, clip.projectId, clip.clipId, c.req.valid("query").format, { credentialKind: "api_key" }), 200);
    })
    .openapi(route({ method: "post", path: "/clips/{id}/exports", summary: "Export a clip revision", tags: ["Exports"],
      description: "Exports the exact editor revision in the selected formats. The response reports any plan limit applied to resolution or watermark.",
      request: { params: schemas.restUuidParam, headers: schemas.restIdempotencyHeaders, ...body(schemas.createExportRequestSchema) },
      responses: { 202: json(schemas.createdExportResultSchema, "Accepted export") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = requireActor(c);
      const clip = await locateClip(actor, c.req.valid("param").id);
      const result = await createClipExport(actor, { ...clip, expectedRevision: input.expectedRevision, aspectRatios: input.aspectRatios, resolution: input.resolution }, await mutation(c, input.callback));
      replayed(c, result.replayed);
      return c.json({ export: exportView(result.export, webOrigin()), reused: result.reused, output: result.output, operation: accepted(result.operation), callback: result.callback }, 202);
    })
    .openapi(route({ method: "get", path: "/exports/{id}", summary: "Get an export", tags: ["Exports"],
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.exportResultSchema, "The export") } }), async (c) => {
      const actor = requireActor(c);
      const located = await locateExport(actor, c.req.valid("param").id);
      const snapshot = await clipExportService.getOwned(actor, located.projectId, located.clipId, located.exportId);
      if (!snapshot) throw new ExpectedDomainFailureError({ code: "clip_export_not_found", kind: "missing", message: "This export doesn't exist in the key's workspace. Use the export ID returned when it was requested." });
      return c.json({ export: exportView(snapshot, webOrigin()) }, 200);
    })
    .openapi(route({ method: "get", path: "/exports/{id}/download", summary: "Issue Download Grants and subtitles", tags: ["Exports"],
      description: "Fresh private download URLs (valid 15 minutes) for a finished export's files, plus SRT and VTT subtitles. Call again for new URLs.",
      request: { params: schemas.restUuidParam, query: schemas.exportDownloadQuery }, responses: { 200: json(schemas.exportDownloadResultSchema, "Download Grants") } }), async (c) => {
      const actor = requireActor(c);
      return c.json(await clipExportService.issueDownloadGrants(actor, c.req.valid("param").id, { variantId: c.req.valid("query").variantId, credentialKind: "api_key" }), 200);
    })
    .openapi(route({ method: "get", path: "/operations/{id}", summary: "Get Operation Status", tags: ["Operations"],
      description: "Follows exactly the work one accepted request started, with per-clip or per-format outcomes.",
      request: { params: schemas.restOperationIdParam }, responses: { 200: json(schemas.operationSchema, "Operation Status") } }), async (c) => {
      const operation = decodeOperation(c.req.valid("param").id);
      const actor = requireActor(c);
      return c.json(operationView(await operationStatusService.read(actor, operation)), 200);
    })
    .openapi(route({ method: "get", path: "/social-accounts", summary: "List connected social accounts", tags: ["Publishing"],
      description: "The Workspace's connected accounts without credentials, with each account's weekly posting slots and the time zone they are in. Propose posts to an account with POST /social-posts/proposals.",
      responses: { 200: json(schemas.socialAccountsResultSchema, "Connected accounts") } }), async (c) => {
      return c.json(await socialAccountsView(requireActor(c)), 200);
    })
    .openapi(route({ method: "post", path: "/social-posts/proposals", summary: "Propose a social post", tags: ["Publishing"],
      description: "Adds a clip's finished export to an account's Publishing Queue as a draft. Nothing publishes: a person accepts the proposal in Narriflow, which freezes it into the account's next free posting slot and applies the Brand Profile's approval rule. The caption defaults to the latest assisted copy for the platform, if any. Retrying with the same Idempotency-Key returns the original proposal.",
      request: { headers: schemas.restIdempotencyHeaders, ...body(schemas.proposeSocialPostRequestSchema) },
      responses: { 201: json(schemas.proposedSocialPostResultSchema, "The proposal") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = requireActor(c);
      const result = await proposeSocialPost(actor, input, await mutation(c));
      replayed(c, result.replayed);
      return c.json({ proposal: result.proposal, queueUrl: `${webOrigin()}/calendar/queue`, replayed: result.replayed }, 201);
    })
    .openapi(route({ method: "get", path: "/events", summary: "List Workspace Events", tags: ["Events"],
      description: "Polls what finished in this Workspace, including work no request started, such as an Autopilot import. Events are ordered by seq; pass the returned nextCursor as `after`. Delivery is at least once, so deduplicate by event id. Events expire after 30 days; re-sync from the list endpoints if a poller was down longer. order=desc returns the newest events, newest first, for pollers that read the newest page each time and deduplicate by id: at most limit (200) matching events per poll interval. Queue proposals (social_post.proposed) and posting outcomes (social_post.finished) need the publishing:read scope: a request that names only those types without it is refused with scope_required, and one that mixes them with other types gets the other types.",
      request: { query: schemas.listEventsQuery }, responses: { 200: json(schemas.eventsResultSchema, "A page of events: in seq order, or newest first with order=desc") } }), async (c) => {
      const query = c.req.valid("query");
      const actor = requireActor(c);
      return c.json(await listEvents(actor, c.get("restPrincipal"), { after: query.after, limit: query.limit, types: parseWorkspaceEventTypes(query.types) ?? undefined, order: query.order }), 200);
    })
    .openapi(route({ method: "get", path: "/webhooks", summary: "List webhooks", tags: ["Webhooks"],
      description: "The Workspace's webhooks with their delivery status. A webhook's URL is never returned, only its host.",
      responses: { 200: json(schemas.webhooksResultSchema, "Webhooks") } }), async (c) => {
      return c.json({ webhooks: await webhookSubscriptions.list(requireActor(c)) }, 200);
    })
    .openapi(route({ method: "post", path: "/webhooks", summary: "Create a webhook", tags: ["Webhooks"],
      description: "Delivers matching Workspace Events to a public HTTPS URL as signed POSTs, in seq order, at least once, signed with the Workspace's callback signing secret. Starts at the newest event; earlier ones are on GET /events. Needs a callback signing secret (callback_secret_required). Posting outcomes (social_post.finished) need the publishing:read scope.",
      request: body(schemas.createWebhookRequestSchema), responses: { 201: json(schemas.webhookResultSchema, "The webhook") } }), async (c) => {
      const input = c.req.valid("json");
      const actor = requireActor(c);
      requireWebhookTypeScopes(input.types, c.get("restPrincipal").scopes);
      await newMutationGuard(c)();
      const url = await assertCompletionCallbackUrl(input.url, dependencies.callbackResolver);
      return c.json({ webhook: await webhookSubscriptions.create(actor, { url, types: input.types }) }, 201);
    })
    .openapi(route({ method: "delete", path: "/webhooks/{id}", summary: "Delete a webhook", tags: ["Webhooks"],
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.deletedWebhookSchema, "The deleted webhook's ID") } }), async (c) => {
      const actor = requireActor(c);
      await newMutationGuard(c)();
      return c.json({ ...(await webhookSubscriptions.delete(actor, c.req.valid("param").id)), deleted: true as const }, 200);
    })
    .openapi(route({ method: "post", path: "/webhooks/{id}/enable", summary: "Re-enable a webhook", tags: ["Webhooks"],
      description: "Resumes a disabled webhook from the last event it acknowledged. Events older than 30 days have expired; if delivery fell behind that far, it resumes from the oldest retained event.",
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.webhookResultSchema, "The webhook") } }), async (c) => {
      const actor = requireActor(c);
      await newMutationGuard(c)();
      return c.json({ webhook: await webhookSubscriptions.enable(actor, c.req.valid("param").id, c.get("restPrincipal")) }, 200);
    })
    .openapi(route({ method: "post", path: "/webhooks/{id}/test", summary: "Send a test event", tags: ["Webhooks"],
      description: "Sends one signed webhook.test event to the endpoint now and reports its answer. It is not part of the event feed and does not move the webhook's cursor. One test per webhook every 5 seconds; a second one sooner is 429 webhook_test_throttled.",
      request: { params: schemas.restUuidParam }, responses: { 200: json(schemas.webhookTestResultSchema, "The endpoint's answer") } }), async (c) => {
      const actor = requireActor(c);
      await newMutationGuard(c)();
      return c.json(await webhookSubscriptions.test(actor, c.req.valid("param").id, c.get("restPrincipal")), 200);
    })
    .openapi(route({ method: "post", path: "/operations/{id}/callback/redeliver", summary: "Redeliver completion callbacks", tags: ["Operations"],
      description: "Resets this operation's delivered or failed callbacks with a fresh attempt budget and the same event IDs.",
      request: { params: schemas.restOperationIdParam, headers: schemas.restIdempotencyHeaders }, responses: { 202: json(schemas.redeliverResultSchema, "Callbacks queued again") } }), async (c) => {
      const operation = decodeOperation(c.req.valid("param").id);
      const actor: ActorScope = requireActor(c);
      const result = await redeliverCallbacks(actor, operation, await mutation(c));
      replayed(c, result.replayed);
      return c.json({ callbacks: result.callbacks as Array<{ eventId: string; state: "waiting" | "pending" | "delivered" | "failed" | "cancelled" }> }, 202);
    });
}

/** Mount the independent OpenAPI app without adding its variables to first-party auth state. */
export function createRestRoutes(dependencies: RestRouteDeps) {
  return new Hono<ApiEnv>().route("/", createRestOpenApiRoutes(dependencies));
}

export type RestRoutes = ReturnType<typeof createRestRoutes>;

/** Project the mounted public paths without importing a runtime or reading environment settings. */
export function restOpenApiDocument(app: Pick<OpenAPIHono<Env>, "getOpenAPI31Document">, origin: string) {
  const document = app.getOpenAPI31Document(openApiDocumentConfig(origin));
  return { ...document, paths: Object.fromEntries(Object.entries(document.paths ?? {}).map(([path, value]) => [`/api/v1${path}`, value])) };
}
