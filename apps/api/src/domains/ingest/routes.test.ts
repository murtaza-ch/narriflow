import { describe, expect, mock, test } from "bun:test";
import { ExpectedDomainFailureError, IngestNotFailedError } from "@narriflow/services";
import { ingestAdmission } from "./admission";
import { createIngestRoutes, type IngestRouteDeps } from "./routes";
import { createDomainTestApp, signedInHeaders as signedIn, TEST_WEB_ORIGIN as WEB } from "./test-app";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const COMMIT_TOKEN = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function app(deps: Partial<IngestRouteDeps>, rateLimitAllows = true) {
  return createDomainTestApp("ingest", createIngestRoutes(deps as IngestRouteDeps), { rateLimitAllows });
}

function post(path: string, body: unknown, method = "POST") {
  return { path, init: { method, headers: signedIn, body: JSON.stringify(body) } };
}

const contentPack = {
  outputTypes: ["short_clip"],
  clipCountTarget: 10,
  clipDurationSecTarget: 45,
  toneConstraints: [],
  platformPlaybookVersion: "platform-playbook-v1",
  mode: "clip",
};

describe("link and Drive commits", () => {
  const link = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", commitToken: COMMIT_TOKEN };

  test("a link commit needs its commit token, then looks up the title only when none was typed", async () => {
    const queueLinkIngest = mock(async (_actor: unknown, input: { title?: string }) => ({
      project: { id: PROJECT_ID, title: input.title ?? "Link Import" },
      queuedJobId: "job-1",
    }));
    const fetchLinkTitle = mock(async () => "Looked up");
    const routes = app({ projectService: { queueLinkIngest, fetchLinkTitle } as never });

    const noToken = post("/api/ingest/link", { url: link.url });
    const refused = await routes.request(noToken.path, noToken.init);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_input" });
    expect(queueLinkIngest).not.toHaveBeenCalled();

    const untitled = post("/api/ingest/link", link);
    const accepted = await routes.request(untitled.path, untitled.init);
    expect(accepted.status).toBe(202);
    expect(queueLinkIngest.mock.calls[0]?.[0]).toMatchObject({ actorUserId: "actor-user", workspaceId: "workspace-a" });
    expect(queueLinkIngest.mock.calls[0]?.[1]).toMatchObject({ title: "Looked up", commitToken: COMMIT_TOKEN });

    const typed = post("/api/ingest/link", { ...link, title: "  My title  " });
    await routes.request(typed.path, typed.init);
    expect(queueLinkIngest.mock.calls[1]?.[1]).toMatchObject({ title: "My title" });
    expect(fetchLinkTitle).toHaveBeenCalledTimes(1);
  });

  test("an unsupported link is refused by the shared schema before any service runs", async () => {
    const queueLinkIngest = mock(async () => ({}));
    const routes = app({ projectService: { queueLinkIngest } as never });
    const request = post("/api/ingest/link", { url: "https://example.com/video.mp4", commitToken: COMMIT_TOKEN });
    const response = await routes.request(request.path, request.init);
    expect(response.status).toBe(400);
    expect(queueLinkIngest).not.toHaveBeenCalled();
  });

  test("a usage refusal keeps its code and recovery details in the common envelope", async () => {
    const queueLinkIngest = mock(async () => {
      throw new ExpectedDomainFailureError({
        code: "processing_credits_exhausted",
        kind: "payment_required",
        message: "No credits left",
        details: { tier: "creator", requestedCredits: 12 },
      });
    });
    const routes = app({ projectService: { queueLinkIngest, fetchLinkTitle: async () => null } as never });
    const request = post("/api/ingest/link", link);
    const response = await routes.request(request.path, request.init);
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: "processing_credits_exhausted",
      details: { tier: "creator", requestedCredits: 12 },
    });
  });

  test("a Drive commit sends the token to the service only and never echoes it", async () => {
    const queueDriveIngest = mock(async () => ({ project: { id: PROJECT_ID, title: "Clip" }, queuedJobId: "job-2" }));
    const routes = app({ projectService: { queueDriveIngest } as never });
    const body = { fileId: "1AbCdEfGhIjKlMnOp", accessToken: "ya29.secret-drive-token", commitToken: COMMIT_TOKEN, title: "  Picked  " };
    const request = post("/api/ingest/drive", body);
    const response = await routes.request(request.path, request.init);
    expect(response.status).toBe(202);
    expect(JSON.stringify(await response.json())).not.toContain("ya29.secret-drive-token");
    expect(queueDriveIngest.mock.calls[0]?.[1]).toMatchObject({ fileId: body.fileId, accessToken: body.accessToken, title: "Picked" });

    const missingToken = post("/api/ingest/drive", { ...body, commitToken: undefined });
    expect((await routes.request(missingToken.path, missingToken.init)).status).toBe(400);
  });

  test("Drive imports declare the 10 per minute Workspace limit and RSS the 20 preview and 5 import limits", () => {
    expect(ingestAdmission["POST /ingest/drive"]).toMatchObject({ rate: { scope: "workspace", prefix: "drive-import", limit: 10 } });
    expect(ingestAdmission["POST /ingest/rss/preview"]).toMatchObject({ rate: { scope: "workspace", prefix: "rss-preview", limit: 20 } });
    expect(ingestAdmission["POST /ingest/rss/import"]).toMatchObject({ rate: { scope: "workspace", prefix: "rss-import", limit: 5 } });
  });

  test("an exhausted Drive limit refuses with 429 before the service runs", async () => {
    const queueDriveIngest = mock(async () => ({}));
    const routes = app({ projectService: { queueDriveIngest } as never }, false);
    const request = post("/api/ingest/drive", { fileId: "1AbCdEfGhIjKlMnOp", accessToken: "t", commitToken: COMMIT_TOKEN });
    const response = await routes.request(request.path, request.init);
    expect(response.status).toBe(429);
    expect(queueDriveIngest).not.toHaveBeenCalled();
  });
});

describe("RSS import", () => {
  test("carries the generation settings and the commit token to the service", async () => {
    const importFromRss = mock(async () => ({ projects: [{ project: { id: PROJECT_ID } }] }));
    const routes = app({ projectService: { importFromRss } as never });
    const body = {
      rssUrl: "https://feed.example/rss.xml",
      episodeIds: ["ep-1"],
      commitToken: COMMIT_TOKEN,
      brandProfileId: null,
      contentPack,
      languageCode: "en",
    };
    const request = post("/api/ingest/rss/import", body);
    const response = await routes.request(request.path, request.init);
    expect(response.status).toBe(202);
    const [, episode, generation] = importFromRss.mock.calls[0] as unknown as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(episode).toMatchObject({ rssUrl: body.rssUrl, episodeIds: ["ep-1"], commitToken: COMMIT_TOKEN });
    expect(episode).not.toHaveProperty("contentPack");
    expect(generation).toMatchObject({ languageCode: "en" });

    const withoutSettings = post("/api/ingest/rss/import", { rssUrl: body.rssUrl, episodeIds: ["ep-1"], commitToken: COMMIT_TOKEN });
    expect((await routes.request(withoutSettings.path, withoutSettings.init)).status).toBe(400);
  });
});

describe("Configure step", () => {
  const setup = { contentPack, languageCode: null };

  test("saving a draft and finalizing are separate acceptances", async () => {
    const saveGenerationDraft = mock(async () => true);
    const finalizeGenerationSetup = mock(async () => ({ started: true, ingestStatus: "ready", workflowRunId: "run-1" }));
    const routes = app({ projectService: { saveGenerationDraft, finalizeGenerationSetup } as never });

    const draft = post(`/api/projects/${PROJECT_ID}/generation/draft`, setup, "PUT");
    const saved = await routes.request(draft.path, draft.init);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, saved: true });
    expect(saveGenerationDraft).toHaveBeenCalledTimes(1);
    expect(finalizeGenerationSetup).not.toHaveBeenCalled();

    const finalize = post(`/api/projects/${PROJECT_ID}/generation/finalize`, setup);
    const finalized = await routes.request(finalize.path, finalize.init);
    expect(await finalized.json()).toEqual({ ok: true, started: true, ingestStatus: "ready", workflowRunId: "run-1" });
    expect(finalizeGenerationSetup).toHaveBeenCalledTimes(1);
    expect(saveGenerationDraft).toHaveBeenCalledTimes(1);
  });

  test("the picker's auto language is stored as automatic detection, and unknown codes are refused", async () => {
    const finalizeGenerationSetup = mock(async () => ({ started: true, ingestStatus: "ready", workflowRunId: "run-1" }));
    const routes = app({ projectService: { finalizeGenerationSetup } as never });

    for (const [languageCode, stored] of [["auto", null], ["", null], ["UR", "ur"]] as const) {
      const finalize = post(`/api/projects/${PROJECT_ID}/generation/finalize`, { contentPack, languageCode });
      expect((await routes.request(finalize.path, finalize.init)).status).toBe(200);
      expect(finalizeGenerationSetup.mock.calls.at(-1)?.[3]).toBe(stored);
    }

    const unknown = post(`/api/projects/${PROJECT_ID}/generation/finalize`, { contentPack, languageCode: "klingon" });
    expect((await routes.request(unknown.path, unknown.init)).status).toBe(400);
  });

  test("unknown fields are refused and a usage refusal at finalize keeps its details", async () => {
    const finalizeGenerationSetup = mock(async () => {
      throw new ExpectedDomainFailureError({
        code: "processing_video_too_long",
        kind: "payment_required",
        message: "Too long",
        details: { tier: "creator", maxSeconds: 600, seconds: 900 },
      });
    });
    const routes = app({ projectService: { finalizeGenerationSetup } as never });
    const forged = post(`/api/projects/${PROJECT_ID}/generation/finalize`, { ...setup, projectId: "other" });
    expect((await routes.request(forged.path, forged.init)).status).toBe(400);

    const finalize = post(`/api/projects/${PROJECT_ID}/generation/finalize`, setup);
    const refused = await routes.request(finalize.path, finalize.init);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ error: "processing_video_too_long", details: { maxSeconds: 600 } });
  });
});

describe("retry, resume and metadata", () => {
  test("retry passes the admitted actor and reports expected refusals as typed failures", async () => {
    const retry = mock(async () => ({ queuedJobId: "job-3", attemptsUsed: 2, maxAttempts: 3 }));
    const routes = app({ ingestJobLifecycle: () => ({ retry }) as never });
    const ok = await routes.request(`/api/ingest/${PROJECT_ID}/retry`, { method: "POST", headers: signedIn });
    expect(await ok.json()).toEqual({ ok: true, queuedJobId: "job-3", attemptsUsed: 2, maxAttempts: 3 });
    expect(retry).toHaveBeenCalledWith({ projectId: PROJECT_ID, workspaceId: "workspace-a", actorUserId: "actor-user" });

    const refused = app({
      ingestJobLifecycle: () => ({
        retry: async () => {
          throw new IngestNotFailedError();
        },
      }) as never,
    });
    const response = await refused.request(`/api/ingest/${PROJECT_ID}/retry`, { method: "POST", headers: signedIn });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "ingest_not_failed" });
  });

  test("resume returns the typed outcome the service decided", async () => {
    const getLinkResume = mock(async () => ({ outcome: "open_project" as const }));
    const routes = app({ projectService: { getLinkResume } as never });
    const response = await routes.request(`/api/ingest/${PROJECT_ID}/resume`, { headers: signedIn });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "open_project" });
  });

  test("literal ingest paths are not swallowed by :projectId", async () => {
    const fetchLinkTitle = mock(async () => "A video");
    const getIngestSnapshot = mock(async () => null);
    const routes = app({ projectService: { fetchLinkTitle, getIngestSnapshot } as never });
    const metadata = await routes.request(`/api/ingest/link/metadata?url=${encodeURIComponent("https://youtu.be/dQw4w9WgXcQ")}`, { headers: signedIn });
    expect(await metadata.json()).toEqual({ title: "A video" });
    expect(getIngestSnapshot).not.toHaveBeenCalled();

    const unsupported = await routes.request(`/api/ingest/link/metadata?url=${encodeURIComponent("https://example.com/x")}`, { headers: signedIn });
    expect(unsupported.status).toBe(400);
    expect(fetchLinkTitle).toHaveBeenCalledTimes(1);
  });

  test("configuration reads every picker choice at once, with the full Brand Profile page", async () => {
    const list = mock(async () => [{ id: "profile-1" }]);
    const routes = app({
      brandTemplateService: { list: async () => ({ builtIns: [], mine: [], defaultId: null }) } as never,
      brandProfileService: { list, getApplicableDefaultId: async () => "profile-1" } as never,
      projectService: { getUsageSummary: async () => ({ remainingCredits: 5 }) } as never,
      recipeService: { list: async () => [{ id: "recipe-1" }] } as never,
    });
    const response = await routes.request("/api/ingest/configuration", { headers: signedIn });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      brandTemplates: { builtIns: [], mine: [], defaultId: null },
      brandProfiles: { items: [{ id: "profile-1" }], defaultId: "profile-1" },
      usageSummary: { remainingCredits: 5 },
      recipes: [{ id: "recipe-1" }],
    });
    expect(list.mock.calls[0]?.[1]).toEqual({ limit: 100, includeDeleted: false });
  });
});

describe("Upload Sessions", () => {
  const open = {
    clientIdempotencyKey: "44444444-4444-4444-8444-444444444444",
    title: "Interview",
    source: { fileName: "a.mp4", sizeBytes: 1024, contentType: "video/mp4", browserFingerprint: "sha256:fp" },
    brandTemplateId: null,
    generationContext: { contentPack: { ...contentPack, clipGenerationMode: "best", minDurationSec: 15, preferredMinDurationSec: 30, preferredMaxDurationSec: 60, maxDurationSec: 90, platformTargets: ["tiktok"], captionPreset: "brand_default", autoHook: true, specificMoments: "", processingStartSec: null, processingEndSec: null, clipLengthPreset: "auto", defaultAspectRatio: "9:16" }, languageCode: "en" },
  };

  test("open passes the validated intent with the admitted actor and maps reconciliation to 202 with Retry-After", async () => {
    const service = {
      open: mock(async () => ({ outcome: "reconciling", sessionId: SESSION_ID, projectId: PROJECT_ID, retryAfterSeconds: 7 })),
      finalize: mock(async () => ({ outcome: "queued_for_ingest", sessionId: SESSION_ID, projectId: PROJECT_ID, queuedJobId: "job-1" })),
      grant: mock(async () => ({ outcome: "granted", sessionId: SESSION_ID, grants: [] })),
      status: mock(async () => ({ outcome: "uploading", sessionId: SESSION_ID })),
      discard: mock(async () => ({ outcome: "compensating", sessionId: SESSION_ID, retryAfterSeconds: 5 })),
    };
    const routes = app({ uploadSessionService: service as never });

    const opened = post("/api/upload-sessions/open", open);
    const response = await routes.request(opened.path, opened.init);
    expect(response.status).toBe(202);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(service.open.mock.calls[0]?.[0]).toMatchObject({ actorUserId: "actor-user", workspaceId: "workspace-a" });
    expect(service.open.mock.calls[0]?.[1]).toMatchObject({ clientIdempotencyKey: open.clientIdempotencyKey });

    const discard = post("/api/upload-sessions/discard", { sessionId: SESSION_ID });
    const discarded = await routes.request(discard.path, discard.init);
    expect(discarded.status).toBe(202);
    expect(discarded.headers.get("retry-after")).toBe("5");

    const finalize = post("/api/upload-sessions/finalize", { sessionId: SESSION_ID, parts: [] });
    expect((await routes.request(finalize.path, finalize.init)).status).toBe(200);
  });

  test("forged provider fields and oversized grant requests are refused before the service", async () => {
    const service = { open: mock(async () => ({})), grant: mock(async () => ({})) };
    const routes = app({ uploadSessionService: service as never });
    const forged = post("/api/upload-sessions/open", { ...open, providerUploadId: "forged" });
    expect((await routes.request(forged.path, forged.init)).status).toBe(400);
    const grants = post("/api/upload-sessions/grants", { sessionId: SESSION_ID, partNumbers: Array.from({ length: 17 }, (_, i) => i + 1) });
    expect((await routes.request(grants.path, grants.init)).status).toBe(400);
    expect(service.open).not.toHaveBeenCalled();
    expect(service.grant).not.toHaveBeenCalled();
  });

  test("keeps the five per-actor limits and gives grants and status their own read-sized bucket", () => {
    expect(ingestAdmission["POST /upload-sessions/open"]).toMatchObject({ rate: { scope: "actor", prefix: "upload-session-open", limit: 60 } });
    expect(ingestAdmission["POST /upload-sessions/finalize"]).toMatchObject({ rate: { scope: "actor", prefix: "upload-session-finalize", limit: 60 } });
    expect(ingestAdmission["POST /upload-sessions/grants"]).toMatchObject({ tier: "read", rate: { scope: "actor", prefix: "upload-session-grants", limit: 120 } });
    expect(ingestAdmission["POST /upload-sessions/status"]).toMatchObject({ tier: "read", rate: { scope: "actor", prefix: "upload-session-status", limit: 120 } });
    expect(ingestAdmission["POST /upload-sessions/discard"]).toMatchObject({ rate: { scope: "actor", prefix: "upload-session-discard", limit: 30 } });
  });

  test("a signed-out caller is refused before the schema is consulted", async () => {
    const routes = app({ uploadSessionService: {} as never });
    const response = await routes.request("/api/upload-sessions/open", { method: "POST", headers: { origin: WEB, "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
  });
});
