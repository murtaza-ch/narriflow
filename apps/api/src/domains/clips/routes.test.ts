import { describe, expect, mock, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { contentPackSchema } from "@narriflow/validators";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { createInventoryApp } from "../../test-app";
import { createClipsRoutes, type ClipsRouteDeps } from "./routes";

const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const CLIP_ID = "40000000-0000-4000-8000-000000000002";
const WEB = "http://localhost:3000";
const user = { id: "actor-user", clerkId: "clerk-1" } as AppUser;

function context(role: WorkspaceActorContext["role"]): WorkspaceActorContext {
  return {
    userId: "actor-user",
    workspaceId: "workspace-a",
    workspaceName: "Workspace A",
    workspaceOwnerUserId: "owner-user",
    role,
    status: "active",
    pricingTier: "creator",
    isPersonal: false,
    workspaceSelectionChanged: false,
  };
}

function appWith(
  deps: Partial<ClipsRouteDeps>,
  options: { role?: WorkspaceActorContext["role"]; rateAllowed?: boolean; rateAvailable?: boolean } = {},
) {
  const policyRuntime = createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) =>
      hint === "workspace-a" ? context(options.role ?? "editor") : null,
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "active", projectId: PROJECT_ID }),
      rateLimit: async () => ({
        allowed: options.rateAllowed ?? true,
        availability: options.rateAvailable === false ? "unavailable" : "available",
        retryAfterSeconds: 30,
        limit: 30,
        remaining: 5,
      }),
      now: () => 1_000,
    },
  });
  return createInventoryApp({
    policyRuntime,
    domains: { clips: createClipsRoutes(deps as ClipsRouteDeps) },
  });
}

const headers = {
  authorization: "Bearer good",
  "x-workspace-id": "workspace-a",
  origin: WEB,
  "content-type": "application/json",
};
const pack = contentPackSchema.parse({
  outputTypes: ["short_clip"],
  clipCountTarget: 3,
  clipDurationSecTarget: 45,
  platformPlaybookVersion: "platform-playbook-v1",
});
const base = `/api/projects/${PROJECT_ID}/clips`;

function post(body: unknown, key: string | null = "key-1"): RequestInit {
  return {
    method: "POST",
    headers: { ...headers, ...(key === null ? {} : { "idempotency-key": key }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

describe("regeneration", () => {
  const url = `${base}/regenerate`;

  test.each([{}, null, { contentPack: {} }, { contentPack: { ...pack, captionPreset: "retired-preset" } }])(
    "rejects missing or invalid settings before the service",
    async (body) => {
      const regenerateClips = mock(async () => ({}));
      const app = appWith({ clipService: { regenerateClips } as never });
      const response = await app.request(url, post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_input" });
      expect(regenerateClips).not.toHaveBeenCalled();
    },
  );

  test("needs a bounded Idempotency-Key and well-formed JSON", async () => {
    const regenerateClips = mock(async () => ({}));
    const app = appWith({ clipService: { regenerateClips } as never });
    const missing = await app.request(url, post({ contentPack: pack }, null));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "idempotency_key_required" });
    expect((await app.request(url, post("{"))).status).toBe(400);
    expect(regenerateClips).not.toHaveBeenCalled();
  });

  test("passes the admitted actor, header key and content pack to the service", async () => {
    const regenerateClips = mock(async () => ({ workflowRunId: "run-1", acceptedAt: "now", initialSeq: 0 }));
    const app = appWith({ clipService: { regenerateClips } as never });
    const response = await app.request(url, post({ contentPack: pack }, "regen-key"));
    expect(response.status).toBe(202);
    expect(response.headers.get("x-workspace-id")).toBe("workspace-a");
    expect(regenerateClips.mock.calls[0]).toMatchObject([
      { actorUserId: "actor-user", workspaceId: "workspace-a" },
      PROJECT_ID,
      "regen-key",
      pack,
    ]);
  });

  test("a viewer cannot queue generation", async () => {
    const regenerateClips = mock(async () => ({}));
    const app = appWith({ clipService: { regenerateClips } as never }, { role: "viewer" });
    const response = await app.request(url, post({ contentPack: pack }));
    expect(response.status).toBe(403);
    expect(regenerateClips).not.toHaveBeenCalled();
  });

  test("keeps the 20-per-minute actor limit", async () => {
    const regenerateClips = mock(async () => ({}));
    const app = appWith({ clipService: { regenerateClips } as never }, { rateAllowed: false });
    const response = await app.request(url, post({ contentPack: pack }));
    expect(response.status).toBe(429);
    expect(regenerateClips).not.toHaveBeenCalled();
  });
});

describe("duplicate and create-from-range receipts", () => {
  const duplicateUrl = `${base}/${CLIP_ID}/duplicate`;
  const rangeUrl = `${base}/create-from-range`;
  const clip = { id: "new-clip" };

  test("both creates require an Idempotency-Key before any work", async () => {
    const duplicateClip = mock(async () => ({ clip, replayed: false }));
    const createClipFromRange = mock(async () => ({ clip, replayed: false }));
    const app = appWith({ clipsCommands: { duplicateClip, createClipFromRange } as never });
    for (const [path, body] of [
      [duplicateUrl, {}],
      [rangeUrl, { startSec: 1, endSec: 20 }],
    ] as const) {
      const response = await app.request(path, post(body, null));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "idempotency_key_required" });
    }
    expect(duplicateClip).not.toHaveBeenCalled();
    expect(createClipFromRange).not.toHaveBeenCalled();
  });

  test("a new duplicate is 201 and a replay says so", async () => {
    const duplicateClip = mock(async () => ({ clip, replayed: false }));
    const app = appWith({ clipsCommands: { duplicateClip } as never });
    const created = await app.request(duplicateUrl, post({}, "dup-1"));
    expect(created.status).toBe(201);
    expect(created.headers.get("idempotent-replayed")).toBeNull();
    expect(duplicateClip.mock.calls[0]).toMatchObject([
      { actorUserId: "actor-user", workspaceId: "workspace-a" },
      PROJECT_ID,
      CLIP_ID,
      { clientIdempotencyKey: "dup-1" },
    ]);

    duplicateClip.mockResolvedValueOnce({ clip, replayed: true });
    const replay = await app.request(duplicateUrl, post({}, "dup-1"));
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(clip);
  });

  test("a range create validates input after admission and replays with the header", async () => {
    const createClipFromRange = mock(async () => ({ clip, replayed: true }));
    const app = appWith({ clipsCommands: { createClipFromRange } as never });
    const invalid = await app.request(rangeUrl, post({ startSec: "x" }, "r-1"));
    expect(invalid.status).toBe(400);
    expect(createClipFromRange).not.toHaveBeenCalled();

    const response = await app.request(rangeUrl, post({ startSec: 1, endSec: 20 }, "r-1"));
    expect(response.status).toBe(201);
    expect(response.headers.get("idempotent-replayed")).toBe("true");
    expect(createClipFromRange.mock.calls[0]?.slice(1, 3)).toEqual([PROJECT_ID, { startSec: 1, endSec: 20 }]);
  });

  test("create-from-selection needs a key and replays through the receipt command", async () => {
    const selectionUrl = `${base}/${CLIP_ID}/create-from-selection`;
    const createClipFromSelection = mock(async () => ({ clip, replayed: true }));
    const app = appWith({ clipsCommands: { createClipFromSelection } as never });
    const missing = await app.request(selectionUrl, post({ startSec: 1, endSec: 20 }, null));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "idempotency_key_required" });
    expect(createClipFromSelection).not.toHaveBeenCalled();

    const response = await app.request(selectionUrl, post({ startSec: 1, endSec: 20 }, "s-1"));
    expect(response.status).toBe(201);
    expect(response.headers.get("idempotent-replayed")).toBe("true");
    expect(createClipFromSelection.mock.calls[0]).toMatchObject([
      { actorUserId: "actor-user", workspaceId: "workspace-a" },
      PROJECT_ID,
      CLIP_ID,
      { startSec: 1, endSec: 20 },
      { clientIdempotencyKey: "s-1" },
    ]);
  });

  test("the recorded limiter outcome is enforced by the command, never at admission", async () => {
    // Admission only records the exhausted limiter; a replay would still be answered.
    let enforced: unknown;
    const duplicateClip = mock(
      async (_actor: unknown, _p: string, _c: string, mutation: { beforeAccept?: () => Promise<void> }) => {
        enforced = await mutation.beforeAccept?.().then(
          () => "allowed",
          (error: unknown) => (error as { code?: string }).code,
        );
        return { clip, replayed: true };
      },
    );
    const app = appWith({ clipsCommands: { duplicateClip } as never }, { rateAllowed: false });
    const response = await app.request(duplicateUrl, post({}, "dup-2"));
    expect(response.status).toBe(201);
    expect(enforced).toBe("rate_limited");
  });

  test("an unavailable limiter pauses new work as mutations_unavailable", async () => {
    let enforced: unknown;
    const createClipFromRange = mock(
      async (_a: unknown, _p: string, _r: unknown, mutation: { beforeAccept?: () => Promise<void> }) => {
        enforced = await mutation.beforeAccept?.().then(
          () => "allowed",
          (error: unknown) => (error as { code?: string }).code,
        );
        return { clip, replayed: true };
      },
    );
    const app = appWith({ clipsCommands: { createClipFromRange } as never }, { rateAvailable: false });
    await app.request(rangeUrl, post({ startSec: 1, endSec: 20 }, "r-2"));
    expect(enforced).toBe("mutations_unavailable");
  });
});

describe("reads and grants", () => {
  test("the redirecting file route is gone; downloads are JSON grants", async () => {
    const getClipDownloadUrl = mock(async () => ({ downloadUrl: "https://storage.example/clip.mp4" }));
    const app = appWith({ clipService: { getClipDownloadUrl } as never });
    const file = await app.request(`${base}/${CLIP_ID}/file`, { headers });
    expect(file.status).toBe(404);
    const grant = await app.request(`${base}/${CLIP_ID}/download?aspectRatio=9:16`, { headers });
    expect(grant.status).toBe(200);
    expect(await grant.json()).toEqual({ downloadUrl: "https://storage.example/clip.mp4" });
    expect(getClipDownloadUrl.mock.calls[0]?.slice(1)).toEqual([PROJECT_ID, CLIP_ID, "9:16"]);
  });

  test("preview peaks are 204 when absent and never cached by the browser", async () => {
    const peaks = { version: 1, sampleRateHz: null, peaksPerSec: 20, startSec: 0, durationSec: 1, peaks: [1] };
    const getClipPreviewPeaks = mock(async () => peaks as unknown);
    const app = appWith({ clipService: { getClipPreviewPeaks } as never });
    const found = await app.request(`${base}/${CLIP_ID}/preview-peaks`, { headers });
    expect(found.status).toBe(200);
    expect(found.headers.get("cache-control")).toBe("private, no-store");
    getClipPreviewPeaks.mockResolvedValueOnce(null);
    expect((await app.request(`${base}/${CLIP_ID}/preview-peaks`, { headers })).status).toBe(204);
  });
});

describe("campaign operations keep their native identities", () => {
  const RETRY_OF = "50000000-0000-4000-8000-000000000001";

  test("render passes the header key to the admission and to the render execution", async () => {
    const triggerClipRendering = mock(async () => ({ queued: 1 }));
    const renderSelected = mock(async (input: { execute(clipIds?: string[]): Promise<unknown> }) => {
      await input.execute(["clip-a"]);
      return { operationId: "op-1" };
    });
    const app = appWith({
      clipService: { triggerClipRendering } as never,
      campaignOperationService: { renderSelected } as never,
    });
    const url = `${base}/render`;
    const missing = await app.request(url, post({ clipIds: [CLIP_ID] }, null));
    expect(missing.status).toBe(400);

    const response = await app.request(url, post({ clipIds: [CLIP_ID] }, "render-key"));
    expect(response.status).toBe(202);
    expect(renderSelected.mock.calls[0]?.[0]).toMatchObject({
      actorUserId: "actor-user",
      workspaceId: "workspace-a",
      projectId: PROJECT_ID,
      idempotencyKey: "render-key",
      clipIds: [CLIP_ID],
    });
    expect(triggerClipRendering.mock.calls[0]?.slice(1, 4)).toEqual([PROJECT_ID, "render-key", ["clip-a"]]);
  });

  test("apply-style passes the key and the explicit retry-of identity to the service", async () => {
    const applyStyleSelected = mock(async () => ({ operationId: "op-2" }));
    const app = appWith({ campaignOperationService: { applyStyleSelected } as never });
    const url = `${base.replace("/clips", "")}/campaign-operations/apply-style`;
    const body = {
      templateId: "40000000-0000-4000-8000-0000000000aa",
      templateFingerprint: "a".repeat(64),
      clips: [{ clipId: CLIP_ID, expectedEditorRevision: 3 }],
    };
    const missing = await app.request(url, post(body, null));
    expect(missing.status).toBe(400);

    const badRetry = await app.request(url, {
      ...post(body, "style-key"),
      headers: { ...headers, "idempotency-key": "style-key", "campaign-retry-of": "not-a-uuid" },
    });
    expect(badRetry.status).toBe(400);
    expect(applyStyleSelected).not.toHaveBeenCalled();

    const response = await app.request(url, {
      ...post(body, "style-key"),
      headers: { ...headers, "idempotency-key": "style-key", "campaign-retry-of": RETRY_OF },
    });
    expect(response.status).toBe(200);
    expect(applyStyleSelected.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      idempotencyKey: "style-key",
      retryOfId: RETRY_OF,
      actorUserId: "actor-user",
    });
  });

  test("thumbnail frame retry is limited to publishing managers", async () => {
    const retry = mock(async () => ({ id: "t" }));
    const app = appWith({ thumbnailFramePreparationService: { retry } as never }, { role: "viewer" });
    const response = await app.request(
      `/api/projects/${PROJECT_ID}/thumbnail-frames/40000000-0000-4000-8000-0000000000bb/retry`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(403);
    expect(retry).not.toHaveBeenCalled();
  });
});
