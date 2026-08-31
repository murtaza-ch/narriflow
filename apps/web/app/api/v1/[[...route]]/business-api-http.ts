import {
  BusinessAutomationAccessError,
  BUSINESS_AUTOMATION_FAILURE_MESSAGE,
  businessAutomationDomainErrorCode,
  type BusinessAutomationActorContext,
  type BusinessAutomationPrincipal,
  type WorkspaceApiKeyPrincipal,
  type WorkspaceApiKeyScope,
  type createBusinessAutomation,
} from "@narriflow/services";
import {
  businessAutomationUuidSchema,
  type WorkspaceCapability,
} from "@narriflow/validators";
import { ZodError } from "zod";

const MAX_REQUEST_BYTES = 256 * 1024;
const API_KEY_RATE_LIMIT = 300;
const API_KEY_RATE_WINDOW_SECONDS = 60;

type BusinessAutomation = ReturnType<typeof createBusinessAutomation>;

export interface BusinessApiMutationLog {
  level: "info" | "warn";
  message: "business_api_mutation";
  operation: string;
  outcome: "accepted" | "replayed" | "rejected";
  userId: string;
  workspaceId: string;
  projectId: string | null;
  apiKeyId: string;
  resourceId: string | null;
}

export interface BusinessApiHttpDependencies {
  authenticateApiKey(secret: string): Promise<WorkspaceApiKeyPrincipal | null>;
  authorize(
    principal: BusinessAutomationPrincipal,
    input: {
      requestedWorkspaceId?: string;
      requiredScope: WorkspaceApiKeyScope;
      capability: WorkspaceCapability;
      integration: "api";
    },
  ): Promise<BusinessAutomationActorContext>;
  automation: BusinessAutomation;
  rateLimit(input: {
    key: string;
    limit: number;
    windowSeconds: number;
  }): Promise<{ allowed: boolean }>;
  log(event: BusinessApiMutationLog): void;
}

class BusinessApiRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 405 | 413,
    message: string,
  ) {
    super(message);
    this.name = "BusinessApiRequestError";
  }
}

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function bearerSecret(request: Request) {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match?.[1]?.startsWith("nf_") ? match[1] : null;
}

async function readJson(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new BusinessApiRequestError(
      "request_too_large",
      413,
      "Request body exceeds the API limit",
    );
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new BusinessApiRequestError(
      "request_too_large",
      413,
      "Request body exceeds the API limit",
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new BusinessApiRequestError(
      "request_invalid_json",
      400,
      "Request body must be valid JSON",
    );
  }
}

function id(value: string | undefined, name: string) {
  const parsed = businessAutomationUuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new BusinessApiRequestError(
      "request_invalid",
      400,
      `${name} must be a UUID`,
    );
  }
  return parsed.data;
}

function idempotencyHeader(request: Request) {
  const value = request.headers.get("idempotency-key") ?? undefined;
  return id(value, "Idempotency-Key");
}

function domainStatus(code: string) {
  if (
    code.includes("conflict") ||
    code.includes("stale") ||
    code.includes("idempotency") ||
    code.includes("revision")
  ) return 409;
  if (code.includes("not_found") || code.endsWith("_missing")) return 404;
  if (
    code.includes("forbidden") ||
    code.includes("unauthorized") ||
    code.includes("unavailable_on_plan") ||
    code.includes("approval_required")
  ) return 403;
  if (
    code.includes("not_configured") ||
    code.includes("unconfigured") ||
    code.includes("configuration_invalid") ||
    code.includes("worker_required") ||
    code === "program_write_disabled"
  ) return 503;
  return 400;
}

function safeError(error: unknown) {
  if (error instanceof BusinessApiRequestError) {
    return json({ error: error.code, message: error.message }, error.status);
  }
  if (error instanceof BusinessAutomationAccessError) {
    return json({ error: error.code, message: error.message }, 403);
  }
  const validationIssues = error instanceof ZodError
    ? error.issues
    : error && typeof error === "object" && "issues" in error &&
        Array.isArray(error.issues)
      ? error.issues
      : null;
  if (validationIssues) {
    return json(
      {
        error: "request_invalid",
        message: "Request does not match the documented workflow contract",
        issues: validationIssues.map((issue) => ({
          code:
            issue && typeof issue === "object" && "code" in issue
              ? String(issue.code)
              : "invalid",
          path:
            issue && typeof issue === "object" && "path" in issue &&
              Array.isArray(issue.path)
              ? issue.path.map(String)
              : [],
        })),
      },
      400,
    );
  }
  const code = businessAutomationDomainErrorCode(error);
  if (code) {
    return json(
      { error: code, message: BUSINESS_AUTOMATION_FAILURE_MESSAGE },
      domainStatus(code),
    );
  }
  return json(
    { error: "business_api_failed", message: "Business API request failed" },
    500,
  );
}

function resourceId(value: unknown) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["operationId", "roundId", "draftId", "jobId"]) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function isReplay(value: unknown) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).replayed === true,
  );
}

export function createBusinessApiHttpHandler(
  dependencies: BusinessApiHttpDependencies,
) {
  return async function handleBusinessApi(request: Request): Promise<Response> {
    const secret = bearerSecret(request);
    if (!secret) {
      return json(
        { error: "api_key_invalid", message: "API key is invalid or revoked" },
        401,
      );
    }

    let authenticated: WorkspaceApiKeyPrincipal | null;
    try {
      authenticated = await dependencies.authenticateApiKey(secret);
    } catch {
      return json(
        { error: "api_auth_unavailable", message: "API authentication is unavailable" },
        503,
      );
    }
    if (!authenticated) {
      return json(
        { error: "api_key_invalid", message: "API key is invalid or revoked" },
        401,
      );
    }

    const limited = await dependencies.rateLimit({
      key: `business-api:${authenticated.apiKeyId}`,
      limit: API_KEY_RATE_LIMIT,
      windowSeconds: API_KEY_RATE_WINDOW_SECONDS,
    });
    if (!limited.allowed) {
      return json(
        { error: "api_rate_limited", message: "API request limit exceeded" },
        429,
        { "Retry-After": String(API_KEY_RATE_WINDOW_SECONDS) },
      );
    }

    const principal: BusinessAutomationPrincipal = {
      kind: "api_key",
      userId: authenticated.userId,
      apiKeyId: authenticated.apiKeyId,
      workspaceId: authenticated.workspaceId,
      scopes: authenticated.scopes,
    };
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);
    let mutation:
      | {
          operation: string;
          actor: BusinessAutomationActorContext;
          projectId: string | null;
        }
      | undefined;

    const authorize = async (
      requestedWorkspaceId: string,
      requiredScope: WorkspaceApiKeyScope,
      capability: WorkspaceCapability,
    ) => dependencies.authorize(principal, {
      requestedWorkspaceId,
      requiredScope,
      capability,
      integration: "api",
    });

    const mutate = async (
      operation: string,
      actor: BusinessAutomationActorContext,
      projectId: string | null,
      execute: () => Promise<unknown>,
    ) => {
      mutation = { operation, actor, projectId };
      const result = await execute();
      const replayed = isReplay(result);
      dependencies.log({
        level: "info",
        message: "business_api_mutation",
        operation,
        outcome: replayed ? "replayed" : "accepted",
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        projectId,
        apiKeyId: authenticated.apiKeyId,
        resourceId: resourceId(result),
      });
      mutation = undefined;
      return json(result, replayed ? 200 : 202);
    };

    try {
      if (
        segments.length < 4 ||
        segments[0] !== "api" ||
        segments[1] !== "v1" ||
        segments[2] !== "workspaces"
      ) {
        throw new BusinessApiRequestError(
          "api_route_not_found",
          404,
          "Business API route not found",
        );
      }
      const workspaceId = id(segments[3], "workspaceId");

      if (segments[4] === "brand-profiles") {
        if (request.method !== "GET") {
          throw new BusinessApiRequestError(
            "method_not_allowed",
            405,
            "Method is not allowed for this route",
          );
        }
        const actor = await authorize(workspaceId, "brand:read", "content.view");
        if (segments.length === 5) {
          const query = new URL(request.url).searchParams;
          return json(await dependencies.automation.listBrandProfiles(actor, {
            cursor: query.get("cursor") ?? undefined,
            limit: query.has("limit") ? Number(query.get("limit")) : undefined,
            query: query.get("query") ?? undefined,
            includeDeleted: query.get("includeDeleted") === "true",
          }));
        }
        if (segments.length === 6) {
          return json(
            await dependencies.automation.getBrandProfile(
              actor,
              id(segments[5], "profileId"),
            ),
          );
        }
      }

      if (segments[4] !== "projects" || segments.length < 7) {
        throw new BusinessApiRequestError(
          "api_route_not_found",
          404,
          "Business API route not found",
        );
      }
      const projectId = id(segments[5], "projectId");
      const workflow = segments[6];

      if (workflow === "campaign-operations") {
        if (segments.length === 7 && request.method === "GET") {
          const actor = await authorize(
            workspaceId,
            "campaign:operate",
            "content.view",
          );
          return json(
            await dependencies.automation.listCampaignOperations(actor, projectId),
          );
        }
        if (
          segments.length === 8 &&
          segments[7] === "editor-action-catalog" &&
          request.method === "GET"
        ) {
          const actor = await authorize(
            workspaceId,
            "campaign:operate",
            "content.view",
          );
          return json(
            await dependencies.automation.getCampaignEditorActionCatalog(
              actor,
              projectId,
            ),
          );
        }
        if (
          segments.length === 8 &&
          segments[7] === "preview-editor-action" &&
          request.method === "POST"
        ) {
          const actor = await authorize(
            workspaceId,
            "campaign:operate",
            "content.view",
          );
          return json(
            await dependencies.automation.previewCampaignEditorAction(
              actor,
              projectId,
              await readJson(request),
            ),
          );
        }
        if (
          segments.length === 8 &&
          segments[7] === "apply-brand-profile" &&
          request.method === "POST"
        ) {
          const actor = await authorize(
            workspaceId,
            "campaign:operate",
            "content.edit",
          );
          const key = idempotencyHeader(request);
          const body = await readJson(request);
          return await mutate("campaign.apply_brand_profile", actor, projectId, () =>
            dependencies.automation.applyCampaignBrandProfile(
              actor,
              projectId,
              key,
              body,
            ));
        }
        if (
          segments.length === 8 &&
          segments[7] === "apply-style" &&
          request.method === "POST"
        ) {
          const actor = await authorize(
            workspaceId,
            "campaign:operate",
            "content.edit",
          );
          const key = idempotencyHeader(request);
          const body = await readJson(request);
          return await mutate("campaign.apply_style", actor, projectId, () =>
            dependencies.automation.applyCampaignStyle(
              actor,
              projectId,
              key,
              body,
            ));
        }
        if (
          segments.length === 8 &&
          segments[7] === "apply-motion" &&
          request.method === "POST"
        ) {
          const actor = await authorize(
            workspaceId,
            "campaign:operate",
            "content.edit",
          );
          const key = idempotencyHeader(request);
          const body = await readJson(request);
          return await mutate("campaign.apply_motion", actor, projectId, () =>
            dependencies.automation.applyCampaignMotion(
              actor,
              projectId,
              key,
              body,
            ));
        }
      }

      if (
        workflow === "brand-profiles" &&
        segments.length === 11 &&
        segments[8] === "scene-templates" &&
        segments[10] === "apply" &&
        request.method === "POST"
      ) {
        const actor = await authorize(
          workspaceId,
          "campaign:operate",
          "content.edit",
        );
        const key = idempotencyHeader(request);
        const body = await readJson(request);
        return await mutate("campaign.apply_scene_template", actor, projectId, () =>
          dependencies.automation.applyCampaignSceneTemplate(
            actor,
            projectId,
            id(segments[7], "profileId"),
            id(segments[9], "templateId"),
            key,
            body,
          ));
      }

      if (workflow === "review-rounds" && segments.length === 7) {
        if (request.method === "GET") {
          const actor = await authorize(workspaceId, "review:read", "content.view");
          return json(await dependencies.automation.listReviewRounds(actor, projectId));
        }
        if (request.method === "POST") {
          const actor = await authorize(
            workspaceId,
            "review:write",
            "review.manage",
          );
          const body = await readJson(request);
          return await mutate("review.create_round", actor, projectId, () =>
            dependencies.automation.createReviewRound(actor, projectId, body));
        }
      }

      if (workflow === "assisted-copy") {
        if (segments.length === 7 && request.method === "POST") {
          const actor = await authorize(
            workspaceId,
            "publishing:prepare",
            "publishing.manage",
          );
          const body = await readJson(request);
          return await mutate("publishing.generate_copy", actor, projectId, () =>
            dependencies.automation.generateAssistedCopy(actor, projectId, body));
        }
        if (segments.length === 8 && request.method === "GET") {
          const actor = await authorize(
            workspaceId,
            "publishing:prepare",
            "content.view",
          );
          return json(await dependencies.automation.getAssistedCopy(
            actor,
            projectId,
            id(segments[7], "draftId"),
          ));
        }
      }

      if (workflow === "thumbnail-extractions") {
        if (segments.length === 7 && request.method === "POST") {
          const actor = await authorize(
            workspaceId,
            "publishing:prepare",
            "publishing.manage",
          );
          const body = await readJson(request);
          return await mutate("publishing.extract_thumbnail", actor, projectId, () =>
            dependencies.automation.requestThumbnailExtraction(actor, projectId, body));
        }
        if (segments.length === 8 && request.method === "GET") {
          const actor = await authorize(
            workspaceId,
            "publishing:prepare",
            "content.view",
          );
          return json(await dependencies.automation.getThumbnailExtraction(
            actor,
            projectId,
            id(segments[7], "jobId"),
          ));
        }
      }

      if (
        workflow === "bulk-schedules" &&
        segments.length === 7 &&
        request.method === "POST"
      ) {
        const actor = await authorize(
          workspaceId,
          "publishing:prepare",
          "publishing.manage",
        );
        const body = await readJson(request);
        return await mutate("publishing.bulk_schedule", actor, projectId, () =>
          dependencies.automation.bulkSchedule(actor, projectId, body));
      }

      if (
        workflow === "generated-media" &&
        segments[7] === "jobs"
      ) {
        if (segments.length === 8 && request.method === "POST") {
          const actor = await authorize(
            workspaceId,
            "generated-media:submit",
            "content.edit",
          );
          const body = await readJson(request);
          if (
            body &&
            typeof body === "object" &&
            "projectId" in body &&
            (body as { projectId?: unknown }).projectId !== projectId
          ) {
            throw new BusinessApiRequestError(
              "project_id_mismatch",
              400,
              "Body projectId must match the route projectId",
            );
          }
          return await mutate("generated_media.submit", actor, projectId, () =>
            dependencies.automation.submitGeneratedMedia(actor, body));
        }
        if (segments.length === 9 && request.method === "GET") {
          const actor = await authorize(
            workspaceId,
            "generated-media:submit",
            "content.view",
          );
          const status = await dependencies.automation.getGeneratedMedia(
            actor,
            id(segments[8], "jobId"),
          );
          if (status.projectId !== projectId) {
            throw new BusinessApiRequestError(
              "api_route_not_found",
              404,
              "Generated-media job was not found in this project",
            );
          }
          return json(status);
        }
      }

      throw new BusinessApiRequestError(
        "api_route_not_found",
        404,
        "Business API route not found",
      );
    } catch (error) {
      if (mutation) {
        dependencies.log({
          level: "warn",
          message: "business_api_mutation",
          operation: mutation.operation,
          outcome: "rejected",
          userId: mutation.actor.userId,
          workspaceId: mutation.actor.workspaceId,
          projectId: mutation.projectId,
          apiKeyId: authenticated.apiKeyId,
          resourceId: null,
        });
      }
      return safeError(error);
    }
  };
}
