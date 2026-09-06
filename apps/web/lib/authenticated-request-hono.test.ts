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

  test("translates typed domain failures at the middleware seam", async () => {
    const response = await testApp(() => {
      throw new ExpectedDomainFailureError({
        code: "resource_missing",
        kind: "missing",
        message: "The resource was not found.",
        details: { lookup: "bounded" },
      });
    }).request("/api/projects");

    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("hono-request-id");
    expect(await response.json()).toEqual({
      error: "resource_missing",
      message: "The resource was not found.",
      requestId: "hono-request-id",
      details: { lookup: "bounded" },
    });
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
