import { describe, expect, test } from "bun:test";
import {
  UploadSessionIdempotencyConflictError,
  UploadSessionIntegrityError,
  UploadSessionInvalidStateError,
  UploadSessionNotFoundError,
  UploadSessionQuotaRefusedError,
} from "@narriflow/services";
import {
  createUploadSessionHttpRoutes,
  type UploadSessionHttpDependencies,
} from "./upload-session-http";

const ACTOR_USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";

const OPEN_PAYLOAD = {
  clientIdempotencyKey: "66666666-6666-4666-8666-666666666666",
  title: "Interview",
  source: {
    fileName: "interview.mp4",
    sizeBytes: 1_024,
    contentType: "video/mp4",
    browserFingerprint: "sha256:browser-fingerprint",
  },
  brandTemplateId: null,
  generationContext: {
    contentPack: {
      outputTypes: ["short_clip"],
      clipGenerationMode: "best",
      clipCountTarget: 10,
      clipDurationSecTarget: 45,
      minDurationSec: 15,
      preferredMinDurationSec: 30,
      preferredMaxDurationSec: 60,
      maxDurationSec: 90,
      platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
      autoRenderClips: false,
      toneConstraints: ["concise"],
      captionPreset: "brand_default",
      platformPlaybookVersion: "2026.2",
      mode: "clip",
      autoHook: true,
      specificMoments: "",
      processingStartSec: null,
      processingEndSec: null,
      clipLengthPreset: "auto",
      defaultAspectRatio: "9:16",
    },
    languageCode: "en",
  },
} as const;

function dependencies(
  overrides: Partial<UploadSessionHttpDependencies> = {},
): UploadSessionHttpDependencies {
  return {
    getCurrentUser: async () => ({
      id: "legacy-owner",
      actorUserId: ACTOR_USER_ID,
      workspaceId: WORKSPACE_ID,
    }),
    checkRateLimit: async () => ({ allowed: true }),
    service: {
      open: async () => ({
        outcome: "uploading",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        expiresAt: "2026-08-27T12:00:00.000Z",
        transfer: {
          kind: "single",
          contentType: "video/mp4",
          grant: { url: "https://storage.test/put", contentType: "video/mp4" },
        },
      }),
      finalize: async () => ({
        outcome: "queued_for_ingest",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        queuedJobId: JOB_ID,
      }),
    },
    ...overrides,
  };
}

describe("Upload Session HTTP routes", () => {
  test("rejects unauthenticated requests before rate limiting or service work", async () => {
    let rateChecks = 0;
    const app = createUploadSessionHttpRoutes(
      dependencies({
        getCurrentUser: async () => null,
        checkRateLimit: async () => {
          rateChecks += 1;
          return { allowed: true };
        },
      }),
    );

    const response = await app.request("/upload-sessions/open", {
      method: "POST",
      body: JSON.stringify(OPEN_PAYLOAD),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(401);
    expect(rateChecks).toBe(0);
  });

  test("rate limits per authenticated identity before parsing or service work", async () => {
    const seenKeys: string[] = [];
    let serviceCalls = 0;
    const base = dependencies();
    const app = createUploadSessionHttpRoutes(
      dependencies({
        checkRateLimit: async (key) => {
          seenKeys.push(key);
          return { allowed: false };
        },
        service: {
          ...base.service,
          open: async () => {
            serviceCalls += 1;
            return base.service.open(ACTOR_USER_ID, OPEN_PAYLOAD, WORKSPACE_ID);
          },
        },
      }),
    );

    const response = await app.request("/upload-sessions/open", {
      method: "POST",
      body: "not-json",
    });

    expect(response.status).toBe(429);
    expect(seenKeys).toEqual(["upload-session-open:legacy-owner"]);
    expect(serviceCalls).toBe(0);
  });

  test("strictly rejects unknown upload intent fields", async () => {
    const app = createUploadSessionHttpRoutes(dependencies());
    const response = await app.request("/upload-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...OPEN_PAYLOAD, providerUploadId: "forged" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid payload" });
  });

  test("passes only validated intent with actor and workspace ownership", async () => {
    const calls: unknown[][] = [];
    const base = dependencies();
    const app = createUploadSessionHttpRoutes(
      dependencies({
        service: {
          ...base.service,
          open: async (...args) => {
            calls.push(args);
            return base.service.open(...args);
          },
        },
      }),
    );

    const response = await app.request("/upload-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(OPEN_PAYLOAD),
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(ACTOR_USER_ID);
    expect(calls[0]?.[1]).toEqual(OPEN_PAYLOAD);
    expect(calls[0]?.[2]).toBe(WORKSPACE_ID);
  });

  test("maps open-session domain failures to stable HTTP statuses", async () => {
    const quota = new UploadSessionQuotaRefusedError({
      tier: "free",
      limitMinutes: 60,
      usedMinutes: 60,
      requestedMinutes: 1,
    });
    const cases = [
      [new UploadSessionIdempotencyConflictError(), 409],
      [new UploadSessionNotFoundError(), 404],
      [new UploadSessionIntegrityError("mismatch"), 422],
      [quota, 402],
      [new Error("provider secret"), 503],
    ] as const;

    for (const [failure, expectedStatus] of cases) {
      const base = dependencies();
      const app = createUploadSessionHttpRoutes(
        dependencies({
          service: {
            ...base.service,
            open: async () => {
              throw failure;
            },
          },
        }),
      );
      const response = await app.request("/upload-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(OPEN_PAYLOAD),
      });
      expect(response.status).toBe(expectedStatus);
      expect(JSON.stringify(await response.json())).not.toContain(
        "provider secret",
      );
    }
  });

  test("validates finalization and maps its domain failures", async () => {
    const payload = { sessionId: SESSION_ID, parts: [] };
    const failures = [
      [new UploadSessionNotFoundError(), 404],
      [new UploadSessionInvalidStateError(), 409],
      [new UploadSessionIntegrityError("mismatch"), 422],
      [new Error("provider secret"), 503],
    ] as const;

    for (const [failure, expectedStatus] of failures) {
      const base = dependencies();
      const app = createUploadSessionHttpRoutes(
        dependencies({
          service: {
            ...base.service,
            finalize: async () => {
              throw failure;
            },
          },
        }),
      );
      const response = await app.request("/upload-sessions/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(expectedStatus);
      expect(JSON.stringify(await response.json())).not.toContain(
        "provider secret",
      );
    }

    const invalidResponse = await createUploadSessionHttpRoutes(
      dependencies(),
    ).request("/upload-sessions/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, providerUploadId: "forged" }),
    });
    expect(invalidResponse.status).toBe(400);
  });
});
