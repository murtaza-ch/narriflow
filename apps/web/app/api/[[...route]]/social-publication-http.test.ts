import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  createAuthenticatedRequestPolicy,
  type ActorScope,
} from "@/lib/authenticated-request-policy";
import {
  createSocialPublicationHttpRoutes,
  type SocialPublicationHttpDependencies,
} from "./social-publication-http";

mock.module("server-only", () => ({}));
const {
  authenticatedHonoActor,
  authenticatedHonoInput,
  authenticatedRequestHonoErrorHandler,
  createAuthenticatedRequestHonoMiddleware,
} = await import("@/lib/authenticated-request-hono");

const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const POST_ID = "50000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "60000000-0000-4000-8000-000000000001";
const actor: ActorScope = {
  actorUserId: "actual-actor",
  workspaceId: "active-workspace",
  workspaceOwnerUserId: "workspace-owner",
  workspaceName: "Workspace",
  role: "editor",
  status: "active",
  pricingTier: "creator",
  isPersonalWorkspace: false,
  workspaceSelectionChanged: false,
};

function testApp(role: ActorScope["role"] = "editor") {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const response = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    return { id: POST_ID };
  };
  const dependencies = {
    getActor: authenticatedHonoActor,
    getInput: authenticatedHonoInput,
    social: {
      listProjectPosts: async (...args: unknown[]) => {
        calls.push({ name: "list", args });
        return { items: [], nextCursor: null };
      },
      cancelPost: response("cancel"),
      inspectPublication: response("inspect"),
      recheckPublication: response("recheck"),
      confirmPublication: response("confirm"),
      republishPublication: response("publish-again"),
    },
    bulk: { preview: response("preview"), schedule: response("schedule") },
    publishingOptions: response("options"),
    refreshInbox: response("refresh"),
  } as unknown as SocialPublicationHttpDependencies;
  const policy = createAuthenticatedRequestPolicy({
    resolveActorScope: async () => ({ ...actor, role }),
    resolveProject: async () => ({ kind: "active", projectId: PROJECT_ID }),
    rateLimit: async () => ({ allowed: true }),
    createRequestId: () => "publication-http-request",
    now: () => 1_000,
  });
  const app = new Hono().basePath("/api");
  app.onError(authenticatedRequestHonoErrorHandler);
  app.use("*", createAuthenticatedRequestHonoMiddleware(
    policy as unknown as Parameters<typeof createAuthenticatedRequestHonoMiddleware>[0],
  ));
  app.route("/", createSocialPublicationHttpRoutes(dependencies));
  return { app, calls };
}

function postRequest(body: unknown) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
const publicationPath = `/api/projects/${PROJECT_ID}/social-posts/${POST_ID}`;

describe("Social Publication HTTP admission", () => {
  test.each([
    ["recheck", { reason: "Check again" }],
    ["confirm", { reason: "Confirmed", evidenceKind: "platform_url", externalUrl: "https://youtube.com/watch?v=video" }],
    ["publish-again", { reason: "New attempt", duplicateRiskAcknowledged: true }],
  ])("passes admitted %s input with the actual actor and project", async (action, body) => {
    const { app, calls } = testApp();
    const response = await app.request(`${publicationPath}/${action}`, postRequest(body));
    expect(response.status).toBe(action === "publish-again" ? 201 : 200);
    expect(calls).toEqual([{ name: action, args: [actor, POST_ID, body, PROJECT_ID] }]);
  });

  test.each([
    ["recheck", { reason: "Check", actorUserId: "forged" }],
    ["confirm", { reason: "Confirmed", evidenceKind: "platform_url" }],
    ["publish-again", { reason: "Retry", duplicateRiskAcknowledged: false }],
  ])("rejects invalid %s before the domain operation", async (action, body) => {
    const { app, calls } = testApp();
    const response = await app.request(`${publicationPath}/${action}`, postRequest(body));
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("publication-http-request");
    expect(calls).toEqual([]);
  });

  test("rejects malformed JSON and post identifiers through the policy", async () => {
    const { app, calls } = testApp();
    for (const [path, body] of [
      [`${publicationPath}/recheck`, "{"],
      [`/api/projects/${PROJECT_ID}/social-posts/invalid/recheck`, JSON.stringify({ reason: "Check" })],
    ]) {
      const response = await app.request(path!, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("admits provider options and inbox refresh identifiers once", async () => {
    const { app, calls } = testApp();
    const options = await app.request(`/api/projects/${PROJECT_ID}/social-accounts/${ACCOUNT_ID}/publishing-options`);
    const refresh = await app.request(`${publicationPath}/refresh-inbox`, { method: "POST" });
    expect(options.status).toBe(200);
    expect(refresh.status).toBe(200);
    expect(calls).toEqual([
      { name: "options", args: [actor, ACCOUNT_ID] },
      { name: "refresh", args: [actor, PROJECT_ID, POST_ID] },
    ]);
  });

  test("passes validated preview input and refuses forged timing authority", async () => {
    const { app, calls } = testApp();
    const input = { clipIds: [POST_ID], scheduleMode: "now", startDate: "2026-10-04", timeZone: "Asia/Karachi", postingWindow: { start: "09:00", end: "17:00" }, frequency: { unit: "hours", value: 2 }, dstDisambiguation: null };
    const path = `/api/projects/${PROJECT_ID}/campaign-operations/schedule/preview`;
    const valid = await app.request(path, postRequest(input));
    expect(valid.status).toBe(200);
    expect(calls).toEqual([{ name: "preview", args: [actor.actorUserId, actor.workspaceId, input] }]);
    const invalid = await app.request(path, postRequest({ ...input, workspaceId: "forged" }));
    expect(invalid.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test("checks publishing capability before reading invalid mutation input", async () => {
    const { app, calls } = testApp("viewer");
    const response = await app.request(`${publicationPath}/recheck`, postRequest({ reason: "" }));
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
    const inspect = await app.request(`${publicationPath}/publication`);
    expect(inspect.status).toBe(200);
    expect(calls).toEqual([{ name: "inspect", args: [{ ...actor, role: "viewer" }, POST_ID, PROJECT_ID] }]);
  });

  test("does not expose the removed single scheduling or metrics routes", () => {
    const { app } = testApp();
    expect(app.routes.some(({ method, path }) => method === "POST" && path === `/api/projects/:id/social-posts`)).toBe(false);
    expect(app.routes.some(({ path }) => path.endsWith("/metrics"))).toBe(false);
  });
});
