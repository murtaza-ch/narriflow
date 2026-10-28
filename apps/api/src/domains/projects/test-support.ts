import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { Hono } from "hono";
import { installRequestPolicy, requireAdmissionDeclaration } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { apiErrorHandler, apiNotFoundHandler, errorEnvelopeMiddleware } from "../../http/errors";
import { apiRequestId } from "../../http/logging";
import type { RateLimitCheck } from "../../http/request-policy";
import { createRequestPolicyRuntime, type RequestPolicyRuntime } from "../../http/request-policy-runtime";

/** Shared fixtures for the projects and library adapter tests: a real policy runtime over fake identity. */
export const WEB_ORIGIN = "http://localhost:3000";
export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const FOLDER_ID = "22222222-2222-4222-8222-222222222222";

export const testUser = { id: "actor-user", clerkId: "clerk-1", firstName: " Ada " } as AppUser;

export function workspaceContext(overrides: Partial<WorkspaceActorContext> = {}): WorkspaceActorContext {
  return {
    userId: "actor-user",
    workspaceId: "workspace-a",
    workspaceName: "Workspace A",
    workspaceOwnerUserId: "owner-user",
    role: "owner",
    status: "active",
    pricingTier: "creator",
    isPersonal: false,
    workspaceSelectionChanged: false,
    ...overrides,
  };
}

export function policyRuntime(
  options: {
    context?: WorkspaceActorContext;
    rateLimit?: (input: { key: string }) => RateLimitCheck;
    projectAccessible?: boolean;
  } = {},
) {
  const context = options.context ?? workspaceContext();
  return createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => testUser,
    resolveScopedWorkspace: async (_user, hint) => (hint === "workspace-a" ? context : null),
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () =>
        options.projectAccessible === false
          ? { kind: "missing" }
          : { kind: "active", projectId: PROJECT_ID },
      rateLimit: async (input) => options.rateLimit?.(input) ?? { allowed: true },
      now: () => 1_000,
    },
  });
}

export const signedInHeaders = {
  authorization: "Bearer good",
  "x-workspace-id": "workspace-a",
  origin: WEB_ORIGIN,
};

/**
 * One domain's routes behind the real request id, error envelope, policy and
 * fail-closed guard, mounted at `/api`. Adapter tests need nothing else, so
 * they do not load every other domain.
 */
export function mountDomain(routes: Hono<ApiEnv, any, any>, runtime: RequestPolicyRuntime = policyRuntime()) {
  const app = new Hono<ApiEnv>();
  app.use("*", apiRequestId());
  app.use("*", errorEnvelopeMiddleware());
  app.onError(apiErrorHandler);
  app.notFound(apiNotFoundHandler);
  app.use("*", installRequestPolicy(runtime));
  app.use("*", requireAdmissionDeclaration());
  app.route("/api", routes);
  return app;
}
