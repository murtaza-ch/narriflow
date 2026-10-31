import { checkRateLimit, readRateLimit } from "@narriflow/services/rate-limit";
import { searchPexelsVideos } from "@narriflow/services/pexels.service";
export { RateLimiter } from "../../src/durable-objects/rate-limiter";
import { Hono } from "hono";
import { createBearerAuthenticator, createServerClerkClient } from "@narriflow/auth";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { createProjectsWebhookRoutes } from "../../src/domains/projects/webhooks";
import { createApiWorker } from "../../src/worker";

let stockProviderCalls = 0;

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
      .get("/rate/:key", async (c) => c.json(await (c.req.query("peek") === "1" ? readRateLimit : checkRateLimit)(
        c.req.param("key"), Number(c.req.query("limit") ?? "2"), Number(c.req.query("window") ?? "86400"),
      )))
      .get("/stock-cache", async (c) => {
        const videos = await searchPexelsVideos(c.req.query("q") ?? "fixture", "portrait", {
          fetchImpl: async () => {
            stockProviderCalls += 1;
            return Response.json({ videos: [{ id: 1, width: 1080, height: 1920, duration: 6, url: "https://www.pexels.com/video/1", image: "https://images.pexels.com/fixture.jpg", user: null, video_files: [] }] });
          },
        });
        return c.json({ videos: videos.length, providerCalls: stockProviderCalls });
      })
      .get("/scope", (c) => c.json({ fixture: readServiceEnvironment().FIXTURE_ID }))
      .route("/api", createProjectsWebhookRoutes({
        webhookSecret: () => environment.ELEVENLABS_WEBHOOK_SECRET ?? null,
        finalizeScribeTranscript: async () => ({ kind: "applied" }),
        failProviderAttempt: async () => ({ kind: "applied" }),
      }));
  },
});
