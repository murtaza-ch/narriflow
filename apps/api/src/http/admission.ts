import type { WorkspaceCapability } from "@narriflow/validators";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { matchedRoutes, routePath } from "hono/route";
import type {
  AdmissionEntry,
  AdmissionTable,
  RouteMethod,
} from "../domains/platform/admission-table";
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

const REGISTRATION_MARK = Symbol.for("narriflow.api.registration");

/** What a route entry in a mounted app says about the registration that created it. */
export interface RegistrationMark {
  /** Identity of the registration; every entry of one `registerRoute` call shares it. */
  readonly registration: object;
  /** The first entry of a registration is its admission or trust declaration. */
  readonly role: "admission" | "trust" | "handler";
}

/** Reads the mark of a mounted route handler (also through Hono's composed-handler wrapper). */
export function registrationOf(handler: unknown): RegistrationMark | undefined {
  if (typeof handler !== "function") return undefined;
  const record = handler as unknown as Record<string | symbol, unknown>;
  const direct = record[REGISTRATION_MARK] as RegistrationMark | undefined;
  if (direct) return direct;
  const composed = record.__COMPOSED_HANDLER;
  return composed === undefined ? undefined : registrationOf(composed);
}

function tag(
  handler: MiddlewareHandler<ApiEnv>,
  mark: RegistrationMark,
): MiddlewareHandler<ApiEnv> {
  // A fresh function per registration, so a handler shared between two routes
  // cannot carry one route's mark into the other. Other symbol markers (the
  // body class) are carried over.
  const tagged: MiddlewareHandler<ApiEnv> = (c, next) => handler(c, next);
  for (const symbol of Object.getOwnPropertySymbols(handler)) {
    const descriptor = Object.getOwnPropertyDescriptor(handler, symbol);
    if (descriptor) Object.defineProperty(tagged, symbol, descriptor);
  }
  Object.defineProperty(tagged, REGISTRATION_MARK, { value: mark });
  return tagged;
}

const noop: MiddlewareHandler<ApiEnv> = async (_c, next) => {
  await next();
};

/**
 * The complete handler chain of one registration: the declaration's admission
 * (or, for independent trust, a no-op that only records the trust), then the
 * route's own validators and handler. Every entry is marked with the same
 * registration, so the fail-closed guard and the inventory can tell this
 * registration from any other that answers the same method and path.
 */
function registrationChain(
  entry: AdmissionEntry,
  handlers: readonly MiddlewareHandler<ApiEnv>[],
): MiddlewareHandler<ApiEnv>[] {
  const registration = {};
  const declaration = "trust" in entry ? null : entry;
  return [
    tag(declaration ? admit(declaration) : noop, {
      registration,
      role: declaration ? "admission" : "trust",
    }),
    ...handlers.map((handler) => tag(handler, { registration, role: "handler" })),
  ];
}

/**
 * Marks an app-level guard middleware that belongs to a trust area (the staff
 * `use("*")`), so the fail-closed guard accepts the area's handlers.
 */
export function guardMiddleware(handler: MiddlewareHandler<ApiEnv>): MiddlewareHandler<ApiEnv> {
  return tag(handler, { registration: {}, role: "admission" });
}

export class RouteRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteRegistrationError";
  }
}

type OnRoute = (
  method: string,
  path: string,
  ...handlers: MiddlewareHandler<ApiEnv>[]
) => unknown;

function onOf(app: Hono<ApiEnv>): OnRoute {
  return (app as unknown as { on: OnRoute }).on.bind(app);
}

const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const satisfies readonly RouteMethod[];
const UNSUPPORTED_REGISTRATIONS = ["use", "all", "on", "route", "mount"] as const;

/**
 * The only way a domain registers HTTP routes. The returned app is a normal
 * chained Hono app (so `typeof` it feeds the Hono RPC client), except that
 * `.get/.post/.put/.patch/.delete(path, ...handlers)` look `METHOD path` up in
 * the domain's admission table and install the declared admission (or trust)
 * ahead of the handlers. A route with no declaration, a second registration of
 * the same route, and any other way of adding routes (`use`, `all`, `on`,
 * `route`, `mount`) throw at construction, so an unguarded or shadowing
 * registration cannot exist.
 */
export function createRouteApp(table: AdmissionTable): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const on = onOf(app);
  const registered = new Set<string>();
  const methods = app as unknown as Record<string, unknown>;

  for (const method of ROUTE_METHODS) {
    methods[method.toLowerCase()] = (path: string, ...handlers: MiddlewareHandler<ApiEnv>[]) => {
      const key = `${method} ${path}`;
      const entry = (table as Readonly<Record<string, AdmissionEntry | undefined>>)[key];
      if (!entry) throw new RouteRegistrationError(`${key} has no admission declaration`);
      if (registered.has(key)) throw new RouteRegistrationError(`${key} is registered twice`);
      if (handlers.length === 0) throw new RouteRegistrationError(`${key} has no handler`);
      registered.add(key);
      on(method, path, ...registrationChain(entry, handlers));
      return app;
    };
  }
  for (const name of UNSUPPORTED_REGISTRATIONS) {
    methods[name] = () => {
      throw new RouteRegistrationError(
        `Domain apps register routes only through get/post/put/patch/delete, not ${name}`,
      );
    };
  }
  return app;
}

/**
 * Registers one route on an app that is not built by `createRouteApp` (the
 * reserved staff area, which owns its guard). Same chain, same marks.
 */
export function registerRoute(
  app: Hono<ApiEnv>,
  method: RouteMethod,
  path: string,
  entry: AdmissionEntry,
  handlers: readonly MiddlewareHandler<ApiEnv>[],
): void {
  onOf(app)(method, path, ...registrationChain(entry, handlers));
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
 * routes: every handler that can answer this request must belong to a
 * registration that begins with its admission or trust declaration. A handler
 * registered any other way (a raw Hono registration or `use`, in front of or
 * behind a declared one) is refused before any handler runs. Paths without any
 * handler fall through to the JSON 404.
 */
export function requireAdmissionDeclaration(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const downstream = matchedRoutes(c).slice(c.req.routeIndex + 1);
    if (downstream.every((route) => registrationOf(route.handler) !== undefined)) {
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
  return async (c, next) => {
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
                c.header("X-Workspace-Id", actor.workspaceId);
                if (project) c.set("project", project);
                return proceed(rateLimit);
              },
            },
            { requestId, resolveActor: actors.workspace },
          );

    if (!result.ok) return markEnvelope(c, failureResponse(result.failure));
  };
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
