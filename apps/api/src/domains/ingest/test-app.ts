import { Hono } from "hono";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { createApiApp } from "../../app";
import { loadApiConfig } from "../../config";
import { FIRST_PARTY_DOMAINS, type AnyRoutes, type FirstPartyDomain } from "../index";
import type { ApiEnv } from "../../http/env";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";

export const TEST_WEB_ORIGIN = "http://localhost:3000";
const user = { id: "actor-user", clerkId: "clerk-1" } as AppUser;
const context: WorkspaceActorContext = {
  userId: "actor-user",
  workspaceId: "workspace-a",
  workspaceName: "Workspace A",
  workspaceOwnerUserId: "owner-user",
  role: "owner",
  status: "active",
  pricingTier: "creator",
  isPersonal: false,
  workspaceSelectionChanged: false,
};

/** Headers of a signed-in request in `workspace-a`. */
export const signedInHeaders = {
  authorization: "Bearer good",
  "x-workspace-id": "workspace-a",
  origin: TEST_WEB_ORIGIN,
  "content-type": "application/json",
};

/**
 * The real first-party chain (CORS, envelope, body limits, Authenticated Request
 * Policy, fail-closed admission) around exactly one domain app. Every other
 * domain is empty, so the test reads no other domain's modules. The policy knows
 * one signed-in user with `Bearer good`; `rateLimit` decides the limiter outcome.
 */
export function createDomainTestApp(
  domain: FirstPartyDomain,
  routes: AnyRoutes,
  options: { rateLimitAllows?: boolean } = {},
): Hono<ApiEnv> {
  const config = loadApiConfig({
    NODE_ENV: "test",
    API_ORIGIN: "http://localhost:4000",
    WEB_ORIGIN: TEST_WEB_ORIGIN,
    CORS_ALLOWED_ORIGINS: TEST_WEB_ORIGIN,
    CLERK_AUTHORIZED_PARTIES: TEST_WEB_ORIGIN,
    CLERK_SECRET_KEY: "sk_test_inert",
    CLERK_PUBLISHABLE_KEY: "pk_test_inert",
  });
  const domains = Object.fromEntries(
    FIRST_PARTY_DOMAINS.map((name) => [name, name === domain ? routes : new Hono<ApiEnv>()]),
  ) as Record<FirstPartyDomain, AnyRoutes>;
  return createApiApp({
    config,
    policyRuntime: createRequestPolicyRuntime({
      authenticate: async (request) =>
        request.headers.get("authorization") === "Bearer good"
          ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
          : ({ status: "unauthenticated", reason: "missing_credential" } as const),
      loadAppUser: async () => user,
      resolveScopedWorkspace: async (_user, hint) => (hint === "workspace-a" ? context : null),
      staffAllowlist: new Set(),
      policy: {
        resolveProject: async () => ({ kind: "active", projectId: "11111111-1111-4111-8111-111111111111" }),
        rateLimit: async () => ({ allowed: options.rateLimitAllows ?? true }) as never,
        now: () => 1_000,
      },
    }),
    health: { version: "test", isDraining: () => false, checkDatabase: async () => {} },
    clerkWebhook: {
      webhookSecret: "whsec_inert",
      verify: () => {
        throw new Error("signature rejected");
      },
      claimDelivery: async () => "claimed",
      recordDeliveryLog: async () => undefined,
      syncUser: async () => undefined,
      markUserDeleted: async () => undefined,
      relayEmail: async () => ({ sent: false }),
    },
    domains,
    webhooks: { billing: new Hono<ApiEnv>(), publishing: new Hono<ApiEnv>(), automation: new Hono<ApiEnv>() },
    rest: new Hono<ApiEnv>(),
    mcp: new Hono<ApiEnv>(),
    admin: { rateLimit: async () => ({ allowed: true }) as never },
  });
}
