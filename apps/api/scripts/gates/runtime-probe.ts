import { Hono } from "hono";
import { createBearerAuthenticator, createServerClerkClient } from "@narriflow/auth";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { createProjectsWebhookRoutes } from "../../src/domains/projects/webhooks";
import { createApiWorker } from "../../src/worker";

/** Local transport gate. Provider verification is real; domain persistence is
 * the injected boundary so this program cannot write user or provider data. */
export default createApiWorker({
  createApp(environment) {
    const clerk = createServerClerkClient({
      secretKey: "sk_test_runtime_probe",
      publishableKey: `pk_test_${btoa("fixture.clerk.accounts.dev$")}`,
    });
    const authenticate = createBearerAuthenticator({
      authorizedParties: ["https://web.narriflow.test"],
      client: {
        authenticateRequest: (request, options) => clerk.authenticateRequest(request, {
          ...options,
          jwtKey: environment.CLERK_JWT_KEY,
        }),
      },
    });
    return new Hono()
      .get("/auth", async (c) => {
        const result = await authenticate(c.req.raw);
        return result.status === "authenticated"
          ? c.json({ userId: result.identity.clerkUserId })
          : c.json({ status: result.status }, result.status === "unavailable" ? 503 : 401);
      })
      .get("/scope", (c) => c.json({ fixture: readServiceEnvironment().FIXTURE_ID }))
      .route("/api", createProjectsWebhookRoutes({
        webhookSecret: () => environment.ELEVENLABS_WEBHOOK_SECRET ?? null,
        finalizeScribeTranscript: async () => ({ kind: "applied" }),
        failProviderAttempt: async () => ({ kind: "applied" }),
      }));
  },
});
