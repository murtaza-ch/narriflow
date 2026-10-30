import { createApiApp, type ApiAppDependencies } from "./app";
import type { ApiDomainRoutes } from "./domains";
import { loadApiConfig } from "./config";
import { createExternalRoutes, createDomainRoutes } from "./runtime";
import { createRequestPolicyRuntime, type RequestPolicyRuntime } from "./http/request-policy-runtime";
import type { Hono } from "hono";
import type { ApiEnv } from "./http/env";

/** A syntactically valid configuration that points nowhere. */
export function inertConfig() {
  return loadApiConfig({
    NODE_ENV: "test",
    API_ORIGIN: "http://localhost:4000",
    WEB_ORIGIN: "http://localhost:3000",
    CORS_ALLOWED_ORIGINS: "http://localhost:3000",
    CLERK_AUTHORIZED_PARTIES: "http://localhost:3000",
    CLERK_SECRET_KEY: "sk_test_inert",
    CLERK_PUBLISHABLE_KEY: "pk_test_inert",
  });
}

/**
 * The real composition with inert edges: production domain modules and mounts,
 * but a policy runtime that treats everyone as signed out and a database probe
 * that answers instantly. Nothing external is contacted unless a request
 * reaches a service.
 */
export function createInventoryApp(
  overrides: {
    policyRuntime?: RequestPolicyRuntime;
    domains?: Partial<ApiDomainRoutes>;
    health?: Partial<ApiAppDependencies["health"]>;
  } = {},
): Hono<ApiEnv> {
  const config = inertConfig();
  const signedOut = createRequestPolicyRuntime({
    authenticate: async () => ({ status: "unauthenticated", reason: "missing_credential" }),
    loadAppUser: async () => {
      throw new Error("no user is ever loaded for a signed-out caller");
    },
    resolveScopedWorkspace: async () => null,
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "inaccessible" }) as never,
      rateLimit: async () => ({ allowed: true }),
      now: Date.now,
    },
  });
  return createApiApp({
    config,
    policyRuntime: overrides.policyRuntime ?? signedOut,
    health: {
      version: "test",
      isDraining: () => false,
      checkDatabase: async () => {},
      ...overrides.health,
    },
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
    domains: { ...createDomainRoutes(config), ...overrides.domains },
    ...createExternalRoutes(config),
    admin: { rateLimit: async () => ({ allowed: true }) as never },
  });
}
