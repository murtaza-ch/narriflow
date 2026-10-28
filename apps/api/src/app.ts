import { Hono } from "hono";
import { routeBodyLimit } from "./body-limits";
import type { ApiConfig } from "./config";
import { handleClerkWebhook } from "./domains/platform/clerk/webhook";
import type { ClerkWebhookDependencies } from "./domains/platform/clerk/webhook";
import { platformAdmission } from "./domains/platform/admission";
import { createHealthRoutes, type HealthDependencies } from "./domains/platform/health";
import {
  FIRST_PARTY_DOMAINS,
  type AnyRoutes,
  type ApiDomainRoutes,
  type ApiWebhookRoutes,
} from "./domains";
import { createAdminRoutes, type AdminDependencies } from "./http/admin";
import { createRouteApp, installRequestPolicy, requireAdmissionDeclaration } from "./http/admission";
import { apiSecurityHeaders, firstPartyCors, firstPartyRefusalHeaders } from "./http/cors";
import { drainGate } from "./http/drain";
import type { ApiEnv } from "./http/env";
import {
  apiErrorHandler,
  apiNotFoundHandler,
  errorEnvelopeMiddleware,
} from "./http/errors";
import { limitBody, limitRequestEnvelope } from "./http/limits";
import { apiRequestId, requestLogger } from "./http/logging";
import { requireJsonContentType } from "./http/route";
import type { RequestPolicyRuntime } from "./http/request-policy-runtime";

export interface ApiAppDependencies {
  config: ApiConfig;
  policyRuntime: RequestPolicyRuntime;
  health: HealthDependencies;
  clerkWebhook: ClerkWebhookDependencies;
  /** First-party session routes, one chained app per domain. */
  domains: ApiDomainRoutes;
  /** Signature-authenticated webhook adapters, mounted at `/api` outside the first-party chain. */
  webhooks: ApiWebhookRoutes;
  /** Public REST v1, mounted at `/api/v1` outside the first-party chain. */
  rest: AnyRoutes;
  /** MCP resource, discovery documents and upload transport, mounted at `/` outside the first-party chain. */
  mcp: AnyRoutes;
  /** Reserved staff area at `/api/admin`; ships no operations. */
  admin: AdminDependencies;
}

/**
 * The one composition owner. Mount order:
 *
 * 1. request ID, bounded request log, secure headers, the drain gate (503
 *    once draining begins) and URL/header size limits, both readable by an
 *    allowed first-party origin;
 * 2. liveness/readiness, webhooks (1 MiB, raw bytes), REST v1 and MCP, each
 *    with its own credential model and error envelope;
 * 3. the first-party chain (CORS, error envelope, per-route body limit, JSON
 *    content type, Authenticated Request Policy, fail-closed admission) around
 *    the domain apps.
 *
 * A route in the first-party chain without an admission declaration is refused
 * before its handler runs; unknown paths answer a JSON 404.
 */
export function createApiApp(deps: ApiAppDependencies): Hono<ApiEnv> {
  const { config } = deps;
  const app = new Hono<ApiEnv>();

  app.use("*", apiRequestId());
  app.use("*", requestLogger({ skipRoutes: ["/api/health", "/api/ready"] }));
  app.use("*", apiSecurityHeaders({ production: config.nodeEnv === "production" }));
  const refusalHeaders = firstPartyRefusalHeaders(config.corsAllowedOrigins);
  app.use("*", drainGate({ isDraining: deps.health.isDraining, refusalHeaders }));
  app.use("*", limitRequestEnvelope(refusalHeaders));
  app.onError(apiErrorHandler);
  app.notFound(apiNotFoundHandler);

  app.route("/api", createHealthRoutes(deps.health));

  app.use("/api/webhooks/*", limitBody("webhook"));
  const webhooks = createRouteApp(platformAdmission).post("/webhooks/clerk", (c) =>
    handleClerkWebhook(c.req.raw, deps.clerkWebhook),
  );
  app.route("/api", webhooks);
  app.route("/api", deps.webhooks.billing);
  app.route("/api", deps.webhooks.publishing);
  app.route("/api", deps.webhooks.automation);

  app.route("/api/v1", deps.rest);
  app.route("/", deps.mcp);

  const firstParty = new Hono<ApiEnv>();
  firstParty.use("*", firstPartyCors({ allowedOrigins: config.corsAllowedOrigins }));
  firstParty.use("*", errorEnvelopeMiddleware());
  firstParty.use("*", routeBodyLimit("control"));
  firstParty.use("*", requireJsonContentType());
  firstParty.use("*", installRequestPolicy(deps.policyRuntime));
  firstParty.use("*", requireAdmissionDeclaration());
  firstParty.route("/admin", createAdminRoutes(deps.admin).app);
  for (const domain of FIRST_PARTY_DOMAINS) {
    firstParty.route("/", deps.domains[domain]);
  }
  app.route("/api", firstParty);

  return app;
}
