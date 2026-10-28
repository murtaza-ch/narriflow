import type { WorkspaceCapability } from "@narriflow/validators";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes, routePath } from "hono/route";
import type { ApiEnv } from "./env";
import {
  failureResponse,
  jsonError,
  markEnvelope,
  requestIdOf,
} from "./errors";
import {
  baselineRateRules,
  defaultTierForMethod,
  rateLimitHeaders,
  type RateTier,
} from "./limits";
import type {
  AuthenticatedRequestAdmission,
  RateLimitRule,
} from "./request-policy";
import type {
  BrowserActorScope,
  RequestPolicyRuntime,
  SignedInActorScope,
} from "./request-policy-runtime";

/** The operation's own limit, in addition to the tier baseline. Keys are `prefix:actorUserId|workspaceId`. */
export interface OperationRate {
  prefix: string;
  limit: number;
  windowSeconds?: number;
}

interface DeclarationCommon {
  /**
   * Overrides the baseline class, which otherwise follows the HTTP method
   * (reads are 300/min, everything else 60/min). Polling or high-frequency
   * POST commands choose `read`; the Studio document PUT/reset chooses `editor`.
   */
  tier?: RateTier;
  /** Route parameter naming the clip for the `editor` tier. */
  editorClipParam?: string;
  /**
   * Receipt-backed retryable commands record the limiter outcome and enforce
   * it via `enforceRecordedRateLimit` only after immutable replay lookup.
   */
  deferRateRefusal?: boolean;
}

export type AdmissionDeclaration =
  | (DeclarationCommon & {
      kind: "signed_in";
      rate?: OperationRate & { scope: "actor" };
    })
  | (DeclarationCommon & {
      kind: "workspace";
      capability: WorkspaceCapability;
      rate?: OperationRate & { scope: "actor" | "workspace" };
    })
  | (DeclarationCommon & {
      kind: "project";
      capability: WorkspaceCapability;
      /** The route parameter holding the Project ID. */
      projectParam: "id" | "projectId";
      rate?: OperationRate & { scope: "actor" | "workspace" };
    });

/**
 * Independent trust: the route verifies its own credential (signed review or
 * share token, signed opt-out, OAuth state, provider signature) and is never
 * given a Clerk session. Declaring it keeps the route off the fail-closed path.
 */
export type IndependentTrust =
  | "signed_review_token"
  | "public_share_token"
  | "signed_opt_out_token"
  | "oauth_state"
  | "provider_signature";

const ADMISSION_MARK = Symbol.for("narriflow.api.admission");

function mark<T extends MiddlewareHandler<ApiEnv>>(handler: T): T {
  Object.defineProperty(handler, ADMISSION_MARK, { value: true });
  return handler;
}

function isMarked(handler: unknown): boolean {
  return (
    typeof handler === "function" &&
    (handler as unknown as Record<symbol, unknown>)[ADMISSION_MARK] === true
  );
}

/** Used by staff admission so the fail-closed guard recognizes it. */
export function markAdmissionHandler<T extends MiddlewareHandler<ApiEnv>>(
  handler: T,
): T {
  return mark(handler);
}

export function declareIndependentTrust(
  _trust: IndependentTrust,
): MiddlewareHandler<ApiEnv> {
  return mark(async (_c, next) => {
    await next();
  });
}

/** App-level: makes the policy and this request's fresh actor promises available to `admit`. */
export function installRequestPolicy(
  runtime: RequestPolicyRuntime,
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    c.set("policyRuntime", runtime);
    c.set("requestActors", runtime.actorsFor(c.req.raw));
    await next();
  };
}

/**
 * App-level, registered after every other `use("*")` and before the domain
 * routes: a first-party endpoint that no `admit(...)`/`declareIndependentTrust`
 * precedes is refused before its handler runs. Paths without any endpoint fall
 * through to the JSON 404.
 */
export function requireAdmissionDeclaration(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const matched = matchedRoutes(c);
    if (matched.length === c.req.routeIndex + 1) {
      await next();
      return;
    }
    // An admission that matches this request and precedes the endpoint runs
    // before it, whatever pattern it was registered under (`/admin/*`, `/x/:id`).
    const declared = matched.some((route) => isMarked(route.handler));
    if (declared) {
      await next();
      return;
    }
    const requestId = requestIdOf(c);
    console.warn(
      JSON.stringify({
        level: "error",
        message: "authenticated_request_surface_missing",
        adapter: "hono",
        method: c.req.method,
        route: routePath(c, -1),
        requestId,
      }),
    );
    return markEnvelope(
      c,
      jsonError(
        500,
        "request_policy_missing",
        "This request is unavailable.",
        requestId,
      ),
    );
  };
}

function admissionOf(
  declaration: AdmissionDeclaration,
  c: Context<ApiEnv>,
): AuthenticatedRequestAdmission {
  switch (declaration.kind) {
    case "signed_in":
      return { kind: "signed_in" };
    case "workspace":
      return { kind: "workspace", capability: declaration.capability };
    case "project": {
      const projectId = c.req.param(declaration.projectParam);
      if (!projectId) {
        throw new Error(
          `Route ${routePath(c)} declares Project parameter ${declaration.projectParam} that it does not have`,
        );
      }
      return {
        kind: "project",
        capability: declaration.capability,
        projectId,
      };
    }
  }
}

type RuleActor = { actorUserId: string; workspaceId?: string };

function rateRules(
  declaration: AdmissionDeclaration,
  c: Context<ApiEnv>,
): RateLimitRule<RuleActor>[] {
  const tier = declaration.tier ?? defaultTierForMethod(c.req.method);
  const clipParam = declaration.editorClipParam ?? "clipId";
  const rules: RateLimitRule<RuleActor>[] = baselineRateRules(tier, {
    editorClipId: tier === "editor" ? c.req.param(clipParam) : undefined,
  });
  const rate = declaration.rate;
  if (rate) {
    rules.push({
      key: (actor) =>
        `${rate.prefix}:${
          rate.scope === "actor" ? actor.actorUserId : (actor.workspaceId ?? "")
        }`,
      limit: rate.limit,
      windowSeconds: rate.windowSeconds ?? 60,
    });
  }
  return rules;
}

async function diagnoseResponse(response: Response) {
  if (response.status < 400) return null;
  let failureCode =
    response.status >= 500 ? "internal_error" : "request_failed";
  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    if (typeof payload.error === "string") failureCode = payload.error;
  } catch {
    // Non-JSON failures keep the bounded fallback code.
  }
  return {
    disposition: response.status >= 500 ? ("failed" as const) : ("refused" as const),
    failureCode,
    status: response.status,
  };
}

/**
 * Authenticated Request Policy for one route, in its established order:
 * identity, selected Workspace, capability and status, rate limits, Project
 * concealment, then the validators and handler registered after it.
 * Register as `.post(path, admit(declaration), validator(...), handler)`.
 * Capability always comes from the declaration, never from the HTTP method.
 */
export function admit(
  declaration: AdmissionDeclaration,
): MiddlewareHandler<ApiEnv> {
  return mark(async (c, next) => {
    const runtime = c.get("policyRuntime");
    const actors = c.get("requestActors");
    if (!runtime || !actors) {
      throw new Error("installRequestPolicy must precede admitted routes");
    }
    const requestId = requestIdOf(c);
    const common = {
      adapter: "hono",
      operationName: `${c.req.method} ${routePath(c)}`,
      admission: admissionOf(declaration, c),
      rateLimit: rateRules(declaration, c),
      deferRateRefusal: declaration.deferRateRefusal ?? false,
      diagnoseResult: diagnoseResponse,
    } as const;

    const proceed = async (rateLimit: Parameters<typeof rateLimitHeaders>[0]) => {
      for (const [name, value] of Object.entries(rateLimitHeaders(rateLimit))) {
        c.header(name, value);
      }
      if (rateLimit && declaration.deferRateRefusal) {
        c.set("recordedRateLimit", rateLimit);
      }
      await next();
      return c.res;
    };

    const result =
      declaration.kind === "signed_in"
        ? await runtime.policy.execute<undefined, Response, SignedInActorScope>(
            {
              ...common,
              operation: async ({ actor, rateLimit }) => {
                c.set("signedInActor", actor);
                return proceed(rateLimit);
              },
            },
            { requestId, resolveActor: actors.signedIn },
          )
        : await runtime.policy.execute<undefined, Response, BrowserActorScope>(
            {
              ...common,
              operation: async ({ actor, project, rateLimit }) => {
                c.set("actor", actor);
                if (project) c.set("project", project);
                return proceed(rateLimit);
              },
            },
            { requestId, resolveActor: actors.workspace },
          );

    if (!result.ok) return markEnvelope(c, failureResponse(result.failure));
  });
}

function admitted<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Authenticated Request Policy did not admit ${what}`);
  }
  return value;
}

/** The admitted Workspace actor. Throws if the route has no Workspace or Project admission. */
export function getActor(c: Context<ApiEnv>): BrowserActorScope {
  return admitted(c.get("actor"), "a Workspace actor");
}

/** The admitted identity-only actor of a signed-in route. */
export function getSignedInActor(c: Context<ApiEnv>): SignedInActorScope {
  return admitted(c.get("signedInActor"), "a signed-in actor");
}

export function getProject(c: Context<ApiEnv>) {
  return admitted(c.get("project"), "a Project");
}

/** The limiter outcome of a `deferRateRefusal` declaration; pass to `enforceRecordedRateLimit`. */
export function getRecordedRateLimit(c: Context<ApiEnv>) {
  return c.get("recordedRateLimit");
}
