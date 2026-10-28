import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { issueReviewSession, hashReviewAccessToken, reviewService, reviewsCommands } from "@narriflow/services";
import { routeBodyLimit } from "../../body-limits";
import { installRequestPolicy, requireAdmissionDeclaration } from "../../http/admission";
import { apiErrorHandler, apiNotFoundHandler, errorEnvelopeMiddleware } from "../../http/errors";
import type { ApiEnv } from "../../http/env";
import { apiRequestId } from "../../http/logging";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { requireJsonContentType } from "../../http/route";
import { guestRoom } from "./guest";
import { reviewsAdmission } from "./admission";
import { createReviewsRoutes, type ReviewsRouteDeps } from "./routes";

const secret = "s".repeat(64);
const uuid = "11111111-1111-4111-8111-111111111111";
const token = "review-token";
const session = issueReviewSession({ roundId: uuid, guestId: uuid, grant: hashReviewAccessToken(token), identity: "Client", subject: "subject" }, secret);
function setup(overrides: Partial<ReviewsRouteDeps> = {}, allowed = false) {
  const auth = mock(async () => session);
  const read = mock(async () => { throw new Error("unexpected read"); });
  const deps: ReviewsRouteDeps = { reviewService: { ...reviewService, authenticate: auth, readRound: read, authorizeSession: async () => {} } as typeof reviewService,
    commands: reviewsCommands, optOut: { preview: mock(async () => ({ email: "client@example.test", workspaceName: "Studio" })), confirm: mock(async () => ({ workspaceName: "Studio" })) },
    sharedExport: mock(async () => null), allowedOrigins: ["http://localhost:3000"], clientIp: () => "trusted-ip", sessionSecret: () => secret,
    rateLimit: async () => ({ allowed: true, availability: "available" }), ...overrides };
  const runtime = createRequestPolicyRuntime({
    authenticate: async () => allowed ? { status: "authenticated", identity: { clerkUserId: "clerk" } } as never : { status: "unauthenticated", reason: "missing_credential" },
    loadAppUser: async () => ({ id: uuid, clerkId: "clerk" }) as never,
    resolveScopedWorkspace: async () => ({ userId: uuid, workspaceId: uuid, workspaceOwnerUserId: uuid, role: "owner", status: "active", pricingTier: "business", isPersonal: true, workspaceSelectionChanged: false, workspaceName: "Studio" }), staffAllowlist: new Set(),
    policy: { resolveProject: async () => ({ kind: "active", projectId: uuid }), rateLimit: async () => ({ allowed: true, availability: "unavailable" }), now: Date.now },
  });
  const app = new Hono<ApiEnv>(); app.use("*", apiRequestId(), routeBodyLimit(), requireJsonContentType(), errorEnvelopeMiddleware(), installRequestPolicy(runtime), requireAdmissionDeclaration());
  app.onError(apiErrorHandler); app.notFound(apiNotFoundHandler); app.route("/api", createReviewsRoutes(deps));
  return { app, deps, auth, read };
}
function request(app: ReturnType<typeof setup>["app"], path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return app.request(`/api${path}`, { method, headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
describe("review HTTP migration", () => {
  test("registers eight internal, nine signed guest, share and two opt-out operations", () => {
    expect(Object.keys(reviewsAdmission)).toHaveLength(20);
    const { app } = setup();
    expect(new Set(app.routes.filter((r) => r.path !== "/*").map((r) => `${r.method} ${r.path}`)).size).toBe(20);
  });
  test("both access entries return a bound Bearer and signed expiry without cookies", async () => {
    const { app, auth } = setup();
    for (const path of [`/review/${token}`, `/review/${token}/access`]) {
      const response = await request(app, path, "POST", { identity: "Client", email: "client@example.test" });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ sessionToken: session, expiresAt: expect.any(String) });
      expect(response.headers.get("set-cookie")).toBeNull(); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(auth.mock.calls[0]?.[2]).toBe("trusted-ip");
  });
  test("rejects API-origin, hostile and null browser origins, while credentialed server calls can omit Origin", async () => {
    const { app, auth } = setup();
    for (const origin of ["http://localhost:4000", "https://unrelated.test", "null"]) {
      const response = await request(app, `/review/${token}/access`, "POST", {}, { origin });
      expect(await response.json()).toMatchObject({ error: "review_origin_invalid", requestId: expect.any(String) });
    }
    expect(auth).not.toHaveBeenCalled();
    const response = await app.request(`/api/review/${token}/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "Client", email: "a@example.test" }) });
    expect(response.status).toBe(200);
  });
  test("cookie, missing/malformed Bearer, token confusion and expiry fail before service reads", async () => {
    const { app, read } = setup();
    const expired = issueReviewSession({ roundId: uuid, guestId: uuid, grant: hashReviewAccessToken(token), identity: "Client", subject: "subject" }, secret, new Date(Date.now() - 13 * 3600_000));
    for (const headers of [{ cookie: `nf_review_x=${session}` }, { authorization: "Basic token" }, { authorization: `Bearer ${session}, ${session}` }, { authorization: `Bearer ${expired}` }]) {
      const response = await request(app, `/review/${token}`, "GET", undefined, headers);
      expect(await response.json()).toMatchObject({ error: "review_session_invalid" });
    }
    expect((await request(app, "/review/different", "GET", undefined, { authorization: `Bearer ${session}` })).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
  test("unknown/extra route segments return JSON 404 without guest auth", async () => {
    const { app } = setup(); expect((await request(app, `/review/${token}/access/extra`, "POST", {})).status).toBe(404);
  });
  test("malformed JSON and chunked overflow are bounded before credential exchange", async () => {
    const { app, auth } = setup();
    const bad = await app.request(`/api/review/${token}/access`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" }); expect(bad.status).toBe(400);
    let read = 0; let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { read++; c.enqueue(new Uint8Array(8192)); if (read === 100) c.close(); }, cancel() { cancelled = true; } });
    const response = await app.request(`/api/review/${token}/access`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(response.status).toBe(413); expect(read).toBeLessThan(10); expect(cancelled).toBe(true); expect(auth).not.toHaveBeenCalled();
  });
  test("opt-out GET previews only, POST confirms, literal is not a guest token", async () => {
    const { app, deps } = setup();
    expect((await request(app, "/review/opt-out?token=signed")).status).toBe(200); expect(deps.optOut.confirm).not.toHaveBeenCalled();
    expect((await request(app, "/review/opt-out", "POST", { token: "signed" })).status).toBe(200); expect(deps.optOut.confirm).toHaveBeenCalledTimes(1);
  });
  test("public-share miss is concealed and public per-IP ceilings are enforced", async () => {
    const { app, deps } = setup();
    expect((await request(app, "/share/signed")).status).toBe(404); expect(deps.sharedExport).toHaveBeenCalledWith("signed");
    const limited = setup({ rateLimit: async () => ({ allowed: false, availability: "available", retryAfterSeconds: 12 }) });
    expect((await request(limited.app, "/share/signed")).status).toBe(429);
    expect((await request(limited.app, `/review/${token}/access`, "POST", {})).status).toBe(429);
  });
  test("public reads omit private variant data and offer only completed downloadable media", async () => {
    const exported = { id: uuid, projectId: uuid, clipId: uuid, clipTitle: "Clip", projectTitle: "Project", editorRevision: 1, currentEditorRevision: 1, isOlderVersion: false, resolution: "1080p", watermark: false, status: "ready", progress: 100, errorCode: null, createdAt: new Date().toISOString(), completedAt: null,
      privateToken: "must-not-leak", variants: [
        { id: uuid, aspectRatio: "9:16", resolution: "1080p", watermark: false, status: "completed", sizeBytes: 123, durationSec: 10, errorCode: null, hasAsset: true, previewUrl: null, downloadUrl: "https://storage.test/download", completedAt: null, storageKey: "must-not-leak" },
        { id: uuid, status: "pending", hasAsset: false },
      ] };
    const { app } = setup({ sharedExport: async () => exported as never });
    const response = await request(app, "/share/public-token"); expect(response.status).toBe(200);
    const body = await response.json(); expect(body.variants).toHaveLength(1); expect(body.expiresAt).toBeString(); expect(JSON.stringify(body)).not.toContain("must-not-leak");
    const room = guestRoom({ claims: { identity: "Client", guestId: uuid, subject: "secret" }, round: { id: uuid, title: "Review", message: null, project: { title: "Project" }, workspace: { name: "Studio" }, revision: 1, status: "open", revokedAt: null, expiresAt: null, decision: null, allowDownloads: false, approvalRequired: true, items: [], comments: [], deliveryTokenEncrypted: "must-not-leak", recipientEmails: ["private@example.test"] } } as never);
    expect(JSON.stringify(room)).not.toContain("must-not-leak"); expect(JSON.stringify(room)).not.toContain("private@example.test");
  });
  test("live guest revocation precedes body validation", async () => {
    const { ReviewServiceError } = await import("@narriflow/services");
    const { app } = setup({ reviewService: { ...reviewService, authorizeSession: async () => { throw new ReviewServiceError("review_session_invalid", "Expired"); } } as never });
    const response = await request(app, `/review/${token}/comments`, "POST", {}, { authorization: `Bearer ${session}` });
    expect(await response.json()).toMatchObject({ error: "review_session_invalid" });
  });
  test("guest commands require caller keys and expose replay headers", async () => {
    const addComment = mock(async () => ({ value: { id: uuid, body: "Hi" }, replayed: true }));
    const { app } = setup({ reviewService: { ...reviewService, addComment, authorizeSession: async () => {} } as never });
    const headers = { authorization: `Bearer ${session}` };
    expect((await request(app, `/review/${token}/comments`, "POST", { body: "Hi" }, headers)).status).toBe(400);
    const accepted = await request(app, `/review/${token}/comments`, "POST", { body: "Hi" }, { ...headers, "Idempotency-Key": "intent" });
    expect(accepted.status).toBe(201); expect(accepted.headers.get("Idempotent-Replayed")).toBe("true"); expect(addComment.mock.calls[0]?.[3]).toMatchObject({ clientIdempotencyKey: "intent" });
  });
  test("media returns grant JSON with no redirect", async () => {
    const resolveMedia = mock(async () => ({ url: "https://storage.test/signed", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const { app } = setup({ reviewService: { ...reviewService, resolveMedia, authorizeSession: async () => {} } as never });
    const response = await request(app, `/review/${token}/media/${uuid}/${uuid}`, "GET", undefined, { authorization: `Bearer ${session}` });
    expect(response.status).toBe(200); expect(response.headers.get("location")).toBeNull(); expect(await response.json()).toMatchObject({ url: "https://storage.test/signed" });
    expect(resolveMedia.mock.calls[0]?.[4]).toBe("playback");
  });
  test("internal replay bypasses deferred limiter refusal, while new acceptance refuses outage", async () => {
    const comment = mock(async (_scope: unknown, _round: string, _input: unknown, mutation: { beforeAccept?: () => Promise<void> }) => {
      if (comment.mock.calls.length > 1) await mutation.beforeAccept?.();
      return { value: { id: uuid }, replayed: true };
    });
    const { app } = setup({ commands: { ...reviewsCommands, comment } as never }, true);
    const path = `/projects/${uuid}/review-rounds/${uuid}/comments`;
    const headers = { authorization: "Bearer clerk", "X-Workspace-Id": uuid, "Idempotency-Key": "intent" };
    const replayed = await request(app, path, "POST", { body: "Hi" }, headers);
    expect(replayed.status).toBe(201); expect(replayed.headers.get("Idempotent-Replayed")).toBe("true");
    const fresh = await request(app, path, "POST", { body: "Hi" }, headers);
    expect(fresh.status).toBe(503); expect(await fresh.json()).toMatchObject({ error: "mutations_unavailable" });
  });
  test("internal admission remains required before validation", async () => {
    const { app } = setup(); expect((await request(app, `/projects/${uuid}/review-rounds`, "POST", {})).status).toBe(401);
  });
});
