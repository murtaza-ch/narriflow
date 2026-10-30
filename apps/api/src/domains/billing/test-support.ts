import { Hono } from "hono";
import { createApiApp } from "../../app";
import type { ApiDomainRoutes } from "../index";
import type { ApiEnv } from "../../http/env";
import type { RequestPolicyRuntime } from "../../http/request-policy-runtime";
import { inertConfig } from "../../test-app";
import type { BillingRoutes } from "./routes";
import type { BillingWebhookRoutes } from "./webhooks";

const empty = () => new Hono<ApiEnv>();

/**
 * The real middleware chain (CORS, envelope, body limits, Authenticated Request
 * Policy, fail-closed admission) around only the billing domain, so these tests
 * do not depend on any other domain's routes being complete.
 */
export function createBillingTestApp(input: {
  policyRuntime: RequestPolicyRuntime;
  routes: BillingRoutes;
  webhook?: BillingWebhookRoutes;
}): Hono<ApiEnv> {
  const config = inertConfig();
  const domains = Object.fromEntries(
    [
      "session",
      "workspace",
      "billing",
      "projects",
      "library",
      "ingest",
      "recipes",
      "clips",
      "exports",
      "studio",
      "brand",
      "publishing",
      "automation",
      "reviews",
      "developer",
      "integrations",
      "progress",
    ].map((name) => [name, empty()]),
  ) as unknown as ApiDomainRoutes;
  return createApiApp({
    config,
    policyRuntime: input.policyRuntime,
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
    domains: { ...domains, billing: input.routes },
    webhooks: {
      billing: input.webhook ?? empty(),
      publishing: empty(),
      automation: empty(),
    },
    rest: empty(),
    mcp: empty(),
    admin: { rateLimit: async () => ({ allowed: true }) as never },
  });
}
