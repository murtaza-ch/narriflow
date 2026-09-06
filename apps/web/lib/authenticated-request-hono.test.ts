import { describe, expect, mock, test } from "bun:test";
import { ExpectedDomainFailureError } from "@narriflow/services";
import { Hono } from "hono";
import {
  createAuthenticatedRequestPolicy,
  type ActorScope,
} from "./authenticated-request-policy";

mock.module("server-only", () => ({}));
const {
  authenticatedRequestHonoErrorHandler,
  createAuthenticatedRequestHonoMiddleware,
} = await import(
  "./authenticated-request-hono"
);

const actor: ActorScope = {
  actorUserId: "actor-user",
  workspaceId: "workspace-a",
  workspaceName: "Workspace A",
  workspaceOwnerUserId: "owner-user",
  role: "owner",
  status: "active",
  pricingTier: "creator",
  isPersonalWorkspace: false,
  workspaceSelectionChanged: false,
};

function testApp(
  handler: () => Response | Promise<Response>,
): Hono {
  const policy = createAuthenticatedRequestPolicy({
    resolveActorScope: async () => actor,
    resolveProject: async () => ({ kind: "active", projectId: "project-a" }),
    rateLimit: async () => ({ allowed: true }),
    createRequestId: () => "hono-request-id",
    now: () => 1_000,
  });
  const app = new Hono().basePath("/api");
  app.onError(authenticatedRequestHonoErrorHandler);
  app.use(
    "*",
    createAuthenticatedRequestHonoMiddleware(
      policy as unknown as Parameters<
        typeof createAuthenticatedRequestHonoMiddleware
      >[0],
    ),
  );
  app.get("/projects", handler);
  return app;
}

describe("authenticated request Hono middleware", () => {
  test("normalizes literal handler failures with the policy request ID", async () => {
    const response = await testApp(() =>
      Response.json(
        { error: "literal_invalid", message: "Safe literal message", private: "hidden" },
        { status: 400 },
      ),
    ).request("/api/projects");

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("hono-request-id");
    expect(await response.json()).toEqual({
      error: "literal_invalid",
      message: "Safe literal message",
      requestId: "hono-request-id",
    });
  });

  test.each([
    ["invalid", 400],
    ["unprocessable", 422],
    ["forbidden", 403],
    ["payment_required", 402],
    ["missing", 404],
    ["conflict", 409],
    ["rate_limited", 429],
    ["unavailable", 503],
  ] as const)(
    "translates the %s domain kind at the middleware seam",
    async (kind, status) => {
      const response = await testApp(() => {
        throw new ExpectedDomainFailureError({
          code: `example_${kind}`,
          kind,
          message: "Safe domain message.",
        });
      }).request("/api/projects");

      expect(response.status).toBe(status);
      expect(response.headers.get("x-request-id")).toBe("hono-request-id");
      expect(await response.json()).toEqual({
        error: `example_${kind}`,
        message: "Safe domain message.",
        requestId: "hono-request-id",
      });
    },
  );

  test("bounds details and applies retry guidance through Hono", async () => {
    const details = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `field${index}`,
        index === 0 ? "x".repeat(300) : index,
      ]),
    );
    const response = await testApp(() => {
      throw new ExpectedDomainFailureError({
        code: "provider_busy",
        kind: "rate_limited",
        message: "Try again soon.",
        details,
        retryAfterSeconds: 2.1,
      });
    }).request("/api/projects");

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    const body = await response.json();
    expect(body.retryAfterSeconds).toBe(3);
    expect(Object.keys(body.details)).toHaveLength(16);
    expect(body.details.field0).toHaveLength(240);
  });

  test("redacts unknown exceptions and keeps the diagnostic request ID", async () => {
    const response = await testApp(() => {
      throw new Error("private provider token");
    }).request("/api/projects");

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("hono-request-id");
    const body = await response.json();
    expect(body).toEqual({
      error: "internal_error",
      message: "Something went wrong. Try again or contact support.",
      requestId: "hono-request-id",
    });
    expect(JSON.stringify(body)).not.toContain("provider token");
  });
});
