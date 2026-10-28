import type { PlatformActor } from "@narriflow/auth";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { guardMiddleware, registerRoute } from "./admission";
import type { ApiEnv } from "./env";
import {
  apiNotFoundHandler,
  failureResponse,
  markEnvelope,
  requestIdOf,
} from "./errors";
import { RATE_TIERS } from "./limits";
import type { RateLimitCheck } from "./request-policy";

/** What a durable admin audit record binds. Never contains secrets or request bodies. */
export interface AdminAuditEntry {
  staffClerkUserId: string;
  action: string;
  target: string;
  requestId: string;
  outcome: "succeeded" | "refused" | "failed";
  occurredAt: Date;
}

/**
 * Durable storage for admin mutations, injected by the future operator
 * module. There is deliberately no default and no no-op implementation.
 */
export interface AdminAudit {
  record(entry: AdminAuditEntry): Promise<void>;
}

export interface AdminDependencies {
  rateLimit(input: {
    key: string;
    limit: number;
    windowSeconds: number;
  }): Promise<RateLimitCheck>;
  audit?: AdminAudit;
  now?: () => Date;
}

export class AdminAuditRequiredError extends Error {
  constructor(action: string) {
    super(`Admin mutation "${action}" cannot be registered without an AdminAudit`);
    this.name = "AdminAuditRequiredError";
  }
}

/** Every staff route is guarded by the area's `requireStaff`; the registration records that trust. */
const STAFF = { trust: "staff" } as const;

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * Staff admission: a verified Clerk session whose user ID is on the
 * server-side allowlist. A Workspace Admin membership, a header or any client
 * metadata cannot satisfy it. Staff get their own 60/min read and 10/min
 * mutation buckets, keyed by staff identity, and never a Workspace.
 */
export function requireStaff(
  dependencies: Pick<AdminDependencies, "rateLimit">,
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const actors = c.get("requestActors");
    if (!actors) throw new Error("installRequestPolicy must precede admin routes");
    const requestId = requestIdOf(c);
    const identity = await actors.identity();
    if (!identity) {
      return markEnvelope(
        c,
        failureResponse({
          code: "authentication_required",
          category: "authentication",
          status: 401,
          message: "Sign in to continue.",
          requestId,
        }),
      );
    }
    const staff = await actors.platform();
    if (!staff) {
      return markEnvelope(
        c,
        failureResponse({
          code: "staff_required",
          category: "authorization",
          status: 403,
          message: "This area is restricted to platform staff.",
          requestId,
        }),
      );
    }
    const tier = isMutation(c.req.method)
      ? RATE_TIERS.adminMutation
      : RATE_TIERS.adminRead;
    const check = await dependencies.rateLimit({
      key: `api-admin-${isMutation(c.req.method) ? "mutation" : "read"}:${staff.clerkUserId}`,
      ...tier,
    });
    if (!check.allowed) {
      return markEnvelope(
        c,
        failureResponse({
          code: "rate_limited",
          category: "rate_limit",
          status: 429,
          message: "Too many requests. Wait before trying again.",
          requestId,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(check.retryAfterSeconds ?? tier.windowSeconds),
          ),
        }),
      );
    }
    c.set("platformActor", staff);
    await next();
  };
}

export function getPlatformActor(c: Context<ApiEnv>): PlatformActor {
  const actor = c.get("platformActor");
  if (!actor) throw new Error("requireStaff did not admit this route");
  return actor;
}

export interface AdminMutationRoute {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Stable audit action name, for example `workspace.suspend`. */
  action: string;
  /** The audited subject, derived from the admitted request. */
  target(c: Context<ApiEnv>): string;
}

export interface AdminRoutes {
  /** Mount at `/api/admin`. Every path beneath it is staff-guarded. */
  app: Hono<ApiEnv>;
  read(path: string, handler: (c: Context<ApiEnv>) => Response | Promise<Response>): void;
  /** Throws `AdminAuditRequiredError` at registration when no audit was injected. */
  mutation(
    route: AdminMutationRoute,
    handler: (c: Context<ApiEnv>) => Response | Promise<Response>,
  ): void;
}

/**
 * The reserved `/admin/*` group. It ships no operations: every path answers
 * 404 to an admitted staff request. Future reads register through `read`;
 * future mutations through `mutation`, which refuses to register without an
 * injected durable audit and records the outcome of every call.
 */
export function createAdminRoutes(dependencies: AdminDependencies): AdminRoutes {
  const app = new Hono<ApiEnv>();
  app.use("*", guardMiddleware(requireStaff(dependencies)));
  app.notFound(apiNotFoundHandler);
  const now = dependencies.now ?? (() => new Date());

  return {
    app,
    read(path, handler) {
      registerRoute(app, "GET", path, STAFF, [async (c) => handler(c)]);
    },
    mutation(route, handler) {
      const { audit } = dependencies;
      if (!audit) throw new AdminAuditRequiredError(route.action);
      registerRoute(app, route.method, route.path, STAFF, [async (c) => {
        const staff = getPlatformActor(c);
        let outcome: AdminAuditEntry["outcome"] = "succeeded";
        let response: Response | undefined;
        let failure: unknown;
        try {
          response = await handler(c);
          if (response.status >= 400) {
            outcome = response.status >= 500 ? "failed" : "refused";
          }
        } catch (error) {
          outcome = "failed";
          failure = error;
        }
        await audit.record({
          staffClerkUserId: staff.clerkUserId,
          action: route.action,
          target: route.target(c),
          requestId: requestIdOf(c),
          outcome,
          occurredAt: now(),
        });
        if (failure !== undefined) throw failure;
        return response as Response;
      }]);
    },
  };
}
