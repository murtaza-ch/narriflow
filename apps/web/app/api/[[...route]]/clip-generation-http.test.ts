import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { contentPackSchema } from "@narriflow/validators";
import { createAuthenticatedRequestPolicy, type ActorScope } from "@/lib/authenticated-request-policy";
import { createClipGenerationHttpRoutes } from "./clip-generation-http";

mock.module("server-only", () => ({}));
const { authenticatedHonoActor, authenticatedHonoInput, authenticatedRequestHonoErrorHandler, createAuthenticatedRequestHonoMiddleware } = await import("@/lib/authenticated-request-hono");
const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const actor: ActorScope = {
  actorUserId: "actual-actor", workspaceId: "active-workspace", workspaceOwnerUserId: "workspace-owner", workspaceName: "Workspace",
  role: "editor", status: "active", pricingTier: "creator", isPersonalWorkspace: false, workspaceSelectionChanged: false,
};
const pack = contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1" });
function testApp(role: ActorScope["role"] = "editor") {
  const calls: unknown[][] = [];
  const policy = createAuthenticatedRequestPolicy({
    resolveActorScope: async () => ({ ...actor, role }), resolveProject: async () => ({ kind: "active", projectId: PROJECT_ID }),
    rateLimit: async () => ({ allowed: true }), createRequestId: () => "clip-generation-http-request", now: () => 1_000,
  });
  const app = new Hono().basePath("/api");
  app.onError(authenticatedRequestHonoErrorHandler);
  app.use("*", createAuthenticatedRequestHonoMiddleware(policy as unknown as Parameters<typeof createAuthenticatedRequestHonoMiddleware>[0]));
  app.route("/", createClipGenerationHttpRoutes({
    getActor: authenticatedHonoActor, getInput: authenticatedHonoInput,
    clip: { regenerateClips: async (...args) => { calls.push(args); return { run: null, lastSeq: 0 }; } },
  }));
  return { app, calls };
}
const path = `/api/projects/${PROJECT_ID}/clips/regenerate`;
function request(body: unknown, key = "regen-key") {
  return { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) };
}
describe("Clip regeneration HTTP admission", () => {
  test.each([{}, null, { contentPack: {} }, { contentPack: { ...pack, captionPreset: "retired-preset" } }])("rejects missing or invalid settings before admission", async (body) => {
    const { app, calls } = testApp();
    const response = await app.request(path, request(body));
    expect(response.status).toBe(400); expect(calls).toEqual([]);
  });
  test("rejects malformed JSON and missing intent before admission", async () => {
    const { app, calls } = testApp();
    expect((await app.request(path, { ...request({ contentPack: pack }), body: "{" })).status).toBe(400);
    expect((await app.request(path, request({ contentPack: pack }, ""))).status).toBe(400);
    expect(calls).toEqual([]);
  });
  test("passes the admitted current settings and actual actor to the module", async () => {
    const { app, calls } = testApp();
    expect((await app.request(path, request({ contentPack: pack }))).status).toBe(202);
    expect(calls).toEqual([[actor, PROJECT_ID, "regen-key", pack]]);
  });
  test("a viewer cannot queue generation", async () => {
    const { app, calls } = testApp("viewer");
    expect((await app.request(path, request({ contentPack: pack }))).status).toBe(403);
    expect(calls).toEqual([]);
  });
});
