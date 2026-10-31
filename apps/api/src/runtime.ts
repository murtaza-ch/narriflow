import type { WorkerInvocation } from "./worker";
import { readServiceEnvironment, type ServiceEnvironment } from "@narriflow/services/runtime-environment";
import {
  createBearerAuthenticator,
  createServerClerkClient,
} from "@narriflow/auth";
import { getPrismaClient } from "@narriflow/db/client";
import { billingService } from "@narriflow/services/billing.service";
import { checkRateLimit } from "@narriflow/services/rate-limit";
import { Hono } from "hono";
import { createApiApp, type ApiAppDependencies } from "./app";
import type { ApiDomainRoutes } from "./domains";
import type { ApiConfig } from "./config";
import { createAutomationRouteDeps, createAutomationWebhookDeps } from "./domains/automation/runtime";
import { createAutomationRoutes } from "./domains/automation/routes";
import { createAutomationWebhookRoutes } from "./domains/automation/webhooks";
import { createBillingRouteDeps, createBillingWebhookDeps } from "./domains/billing/runtime";
import { createBillingRoutes } from "./domains/billing/routes";
import { createBillingWebhookRoutes } from "./domains/billing/webhooks";
import { createBrandRouteDeps } from "./domains/brand/runtime";
import { createBrandRoutes } from "./domains/brand/routes";
import { createClipsRouteDeps } from "./domains/clips/runtime";
import { createClipsRoutes } from "./domains/clips/routes";
import { createDeveloperRouteDeps } from "./domains/developer/runtime";
import { createDeveloperRoutes } from "./domains/developer/routes";
import { createExportsRouteDeps } from "./domains/exports/runtime";
import { createExportsRoutes } from "./domains/exports/routes";
import { createExecutionRoutes } from "./domains/execution/routes";
import { createLocalDeviceRoutes } from "./domains/execution/local-device";
import { createWorkerExecutionDependencies } from "./domains/execution/runtime";
import { createIngestRouteDeps } from "./domains/ingest/runtime";
import { createIngestRoutes } from "./domains/ingest/routes";
import { createIntegrationsRouteDeps, createMcpTransportDeps } from "./domains/integrations/runtime";
import { createMcpTransportRoutes } from "./domains/integrations/mcp";
import { createIntegrationsRoutes } from "./domains/integrations/routes";
import { createLibraryRouteDeps } from "./domains/library/runtime";
import { createLibraryRoutes } from "./domains/library/routes";
import { createClerkWebhookDependencies } from "./domains/platform/clerk/runtime";
import { createDatabaseReadiness, expectedDatabaseMigrations } from "./domains/platform/database-readiness";
import type { HealthDependencies } from "./domains/platform/health";
import { createProgressSocketRoutes } from "./domains/progress/socket";
import { createProgressSocketDeps, createProgressRouteDeps } from "./domains/progress/runtime";
import { createProgressRoutes } from "./domains/progress/routes";
import { createProjectsRouteDeps } from "./domains/projects/runtime";
import { createProjectsRoutes } from "./domains/projects/routes";
import { createPublishingRouteDeps, createPublishingWebhookDeps } from "./domains/publishing/runtime";
import { createPublishingRoutes } from "./domains/publishing/routes";
import { createPublishingWebhookRoutes } from "./domains/publishing/webhooks";
import { createRecipesRouteDeps } from "./domains/recipes/runtime";
import { createRecipesRoutes } from "./domains/recipes/routes";
import { createRestRouteDeps } from "./domains/rest/runtime";
import { createRestRoutes } from "./domains/rest/routes";
import { createReviewsRouteDeps } from "./domains/reviews/runtime";
import { createReviewsRoutes } from "./domains/reviews/routes";
import { createSessionRouteDeps } from "./domains/session/runtime";
import { createSessionRoutes } from "./domains/session/routes";
import { createProjectsWebhookDeps } from "./domains/projects/runtime";
import { createProjectsWebhookRoutes } from "./domains/projects/webhooks";
import { createStudioRouteDeps } from "./domains/studio/runtime";
import { createStudioRoutes } from "./domains/studio/routes";
import { createWorkspaceRouteDeps } from "./domains/workspace/runtime";
import { createWorkspaceRoutes } from "./domains/workspace/routes";
import { createProductionRequestPolicyRuntime } from "./http/request-policy-runtime";
import type { ApiEnv } from "./http/env";

/** A required, non-secret-logged setting. The message names the setting, never its value. */
function requireSetting(name: string): string {
  const value = readServiceEnvironment()[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createHealthDependencies(environment: ServiceEnvironment): HealthDependencies {
  return {
    version: environment.DEPLOYMENT_VERSION?.slice(0, 64) ?? "dev",
    isDraining: () => environment.ADMISSION_STATE === "closed",
    checkDatabase: createDatabaseReadiness({
      expectedMigrations: expectedDatabaseMigrations(),
      async appliedMigrations() {
        const prisma = getPrismaClient();
        if (!prisma) throw new Error("Database scope is unavailable");
        const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
          SELECT migration_name FROM "_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        `;
        return rows.map((row) => row.migration_name);
      },
      log: (entry) => console.warn(JSON.stringify(entry)),
    }),
  };
}

/** Every first-party domain app, wired to the production services. Building them connects to nothing. */
export function createDomainRoutes(config: ApiConfig): ApiDomainRoutes {
  return {
    session: createSessionRoutes(createSessionRouteDeps(config)),
    workspace: createWorkspaceRoutes(createWorkspaceRouteDeps(config)),
    billing: createBillingRoutes(createBillingRouteDeps(config)),
    projects: createProjectsRoutes(createProjectsRouteDeps(config)),
    library: createLibraryRoutes(createLibraryRouteDeps(config)),
    ingest: createIngestRoutes(createIngestRouteDeps(config)),
    recipes: createRecipesRoutes(createRecipesRouteDeps(config)),
    clips: createClipsRoutes(createClipsRouteDeps(config)),
    exports: createExportsRoutes(createExportsRouteDeps(config)),
    studio: createStudioRoutes(createStudioRouteDeps(config)),
    brand: createBrandRoutes(createBrandRouteDeps(config)),
    publishing: createPublishingRoutes(createPublishingRouteDeps(config)),
    automation: createAutomationRoutes(createAutomationRouteDeps(config)),
    reviews: createReviewsRoutes(createReviewsRouteDeps(config)),
    developer: createDeveloperRoutes(createDeveloperRouteDeps(config)),
    integrations: createIntegrationsRoutes(createIntegrationsRouteDeps(config)),
    progress: createProgressRoutes(createProgressRouteDeps(config)),
  };
}

/** The apps mounted outside the first-party chain: webhooks, public REST and the MCP transport. */
export function createExternalRoutes(
  config: ApiConfig,
  clerkClient?: ReturnType<typeof createServerClerkClient>,
  runInRequestScope?: WorkerInvocation,
): Pick<ApiAppDependencies, "webhooks" | "rest" | "mcp" | "progressSocket" | "execution"> {
  return {
    webhooks: {
      billing: createBillingWebhookRoutes(createBillingWebhookDeps()),
      publishing: createPublishingWebhookRoutes(createPublishingWebhookDeps()),
      automation: createAutomationWebhookRoutes(createAutomationWebhookDeps()),
      projects: createProjectsWebhookRoutes(createProjectsWebhookDeps()),
    },
    progressSocket: createProgressSocketRoutes(createProgressSocketDeps(config)),
    execution: new Hono<ApiEnv>().route("/", createExecutionRoutes(createWorkerExecutionDependencies())).route("/", createLocalDeviceRoutes()),
    rest: createRestRoutes(createRestRouteDeps(config)),
    mcp: createMcpTransportRoutes(createMcpTransportDeps(config, clerkClient, runInRequestScope)),
  };
}

/** Wires every production dependency and returns the composed app. Throws on missing core settings. */
export function createProductionApp(config: ApiConfig, environment: ServiceEnvironment, runInRequestScope: WorkerInvocation): Hono<ApiEnv> {
  requireSetting("ELEVENLABS_WEBHOOK_SECRET");
  billingService.validateConfiguration({ surface: "web" });

  const clerkClient = createServerClerkClient({
    secretKey: config.clerk.secretKey,
    publishableKey: config.clerk.publishableKey,
  });
  const policyRuntime = createProductionRequestPolicyRuntime({
    authenticate: createBearerAuthenticator({
      client: clerkClient,
      authorizedParties: config.clerk.authorizedParties,
    }),
    clerkClient,
    staffAllowlist: config.staffAllowlist,
  });

  return createApiApp({
    config,
    policyRuntime,
    health: createHealthDependencies(environment),
    clerkWebhook: createClerkWebhookDependencies({
      webhookSecret: requireSetting("CLERK_WEBHOOK_SECRET"),
      clerkClient,
    }),
    domains: createDomainRoutes(config),
    ...createExternalRoutes(config, clerkClient, runInRequestScope),
    admin: {
      rateLimit: ({ key, limit, windowSeconds }) => checkRateLimit(key, limit, windowSeconds),
    },
  });
}
