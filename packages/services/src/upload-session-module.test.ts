import { describe, expect, test } from "bun:test";
import { createInMemoryUploadSessionHarness } from "./upload-session.test-support";
import {
  createUploadSessionModule,
  assertUploadProviderLifecyclePrerequisite,
  defaultUploadSessionConfig,
  planUploadTransfer,
  UploadSessionIdempotencyConflictError,
  UploadSessionIntegrityError,
  UploadSessionInvalidStateError,
  UploadSessionNotFoundError,
  UploadSessionQuotaRefusedError,
  UploadSessionReconciliationClaimLostError,
  type UploadSessionDiagnosticEvent,
  uploadSessionConfigFromEnv,
  uploadSessionDiagnosticRecord,
} from "./upload-session.service";

const ACTOR = {
  actorUserId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  legacyOwnerUserId: "33333333-3333-4333-8333-333333333333",
};

const CONTENT_PACK = {
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
  toneConstraints: ["concise", "conversational"],
  captionPreset: "brand_default",
  platformPlaybookVersion: "2026-07-01",
  mode: "clip",
  autoHook: true,
  specificMoments: "",
  processingStartSec: null,
  processingEndSec: null,
  clipLengthPreset: "auto",
  defaultAspectRatio: "9:16",
} as const;

describe("Upload Session", () => {
  test("serializes diagnostics through a secret-free allowlist", () => {
    const event = {
      phase: "reconciliation",
      disposition: "failed",
      sessionId: "session-safe-id",
      state: "compensating",
      providerOperation: "abort",
      failureCode: "upload_cleanup_access_denied",
      declaredAbandonedBytes: 2_048,
      declaredAbandonedAgeMs: 5_000,
      providerCallCount: 3,
      durationMs: 12,
      nextRetryAt: "2026-08-28T00:00:05.000Z",
      takeover: true,
      replay: false,
      signedUrl: "https://storage.invalid/secret",
      providerUploadId: "provider-secret",
      storageKey: "workspace/secret",
      rawError: new Error("provider secret"),
    } as const;
    const record = uploadSessionDiagnosticRecord(event);

    expect(Object.keys(record).sort()).toEqual([
      "declaredAbandonedAgeMs",
      "declaredAbandonedBytes",
      "disposition",
      "durationMs",
      "failureCode",
      "level",
      "message",
      "nextRetryAt",
      "phase",
      "providerCallCount",
      "providerOperation",
      "replay",
      "state",
      "takeover",
      "uploadSessionId",
    ]);
    const serialized = JSON.stringify(record);
    for (const forbidden of [
      "signedUrl",
      "providerUploadId",
      "storageKey",
      "etag",
      "fileName",
      "credentials",
      "rawError",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("requires a confirmed provider lifecycle beyond the application hard lifetime", () => {
    expect(() =>
      assertUploadProviderLifecyclePrerequisite({ NODE_ENV: "production" }),
    ).toThrow("R2_INCOMPLETE_MULTIPART_LIFECYCLE_DAYS");
    expect(() =>
      assertUploadProviderLifecyclePrerequisite({
        NODE_ENV: "production",
        R2_INCOMPLETE_MULTIPART_LIFECYCLE_DAYS: "6",
      }),
    ).toThrow("longer than the Upload Session hard lifetime");
    expect(() =>
      assertUploadProviderLifecyclePrerequisite({
        NODE_ENV: "production",
        R2_INCOMPLETE_MULTIPART_LIFECYCLE_DAYS: "7",
      }),
    ).not.toThrow();
  });

  test("plans direct PUT through 100 MiB and multipart above the threshold", () => {
    const threshold = 100 * 1024 * 1024;
    const config = defaultUploadSessionConfig();

    expect(planUploadTransfer(threshold - 1, config)).toMatchObject({
      kind: "single",
      partCount: 1,
    });
    expect(planUploadTransfer(threshold, config)).toMatchObject({
      kind: "single",
      partCount: 1,
    });
    expect(planUploadTransfer(threshold + 1, config)).toMatchObject({
      kind: "multipart",
      partSizeBytes: 16 * 1024 * 1024,
      partCount: 7,
    });
    expect(planUploadTransfer(5 * 1024 * 1024 * 1024, config)).toMatchObject({
      kind: "multipart",
      partCount: 320,
    });
  });

  test("opens multipart transfer with one bounded grant window", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        smallFileThresholdBytes: 1,
        multipartPartSizeBytes: 5 * 1024 * 1024,
      }),
    });

    const input = {
      ...ACTOR,
      clientIdempotencyKey: "40000000-0000-4000-8000-000000000004",
      title: "Windowed grants",
      source: {
        fileName: "windowed.mp4",
        sizeBytes: 100 * 1024 * 1024,
        contentType: "video/mp4",
        browserFingerprint: '["windowed.mp4",104857600,"video/mp4",4]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };
    const opened = await module.open(input);

    if (opened.outcome !== "uploading" || opened.transfer.kind !== "multipart") {
      throw new Error("expected multipart transfer");
    }
    expect(opened.transfer.partCount).toBe(20);
    expect(opened.transfer.grants.map((grant) => grant.partNumber)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    expect(opened.transfer.grantExpiresAt).toBe("2026-08-27T00:15:00.000Z");
    expect(harness.facts.multipartPartListings).toBe(0);
  });

  test("issues a requested in-range grant window without provider facts", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        smallFileThresholdBytes: 1,
        multipartPartSizeBytes: 5 * 1024 * 1024,
      }),
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "40000000-0000-4000-8000-000000000014",
      title: "More grants",
      source: {
        fileName: "more-grants.mp4",
        sizeBytes: 100 * 1024 * 1024,
        contentType: "video/mp4",
        browserFingerprint: '["more-grants.mp4",104857600,"video/mp4",14]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });

    const outcome = await module.grant({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      partNumbers: [17, 18, 19, 20],
    });

    expect(outcome).toEqual({
      outcome: "granted",
      sessionId: opened.sessionId,
      expiresAt: "2026-08-27T00:15:00.000Z",
      grants: [17, 18, 19, 20].map((partNumber) => ({
        partNumber,
        url: `https://upload.invalid/part/${partNumber}`,
      })),
    });
    expect(outcome).not.toHaveProperty("providerUploadId");
    expect(outcome).not.toHaveProperty("storageKey");
  });

  test("rejects malformed, excessive, cross-workspace, and non-uploading grant requests", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "40000000-0000-4000-8000-000000000024",
      title: "Guard grants",
      source: {
        fileName: "guard.mp4",
        sizeBytes: 32 * 1024 * 1024,
        contentType: "video/mp4",
        browserFingerprint: '["guard.mp4",33554432,"video/mp4",24]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    for (const partNumbers of [
      [0],
      [1, 1],
      Array.from({ length: 17 }, (_, index) => index + 1),
      [3],
    ]) {
      await expect(
        module.grant({
          actorUserId: ACTOR.actorUserId,
          workspaceId: ACTOR.workspaceId,
          sessionId: opened.sessionId,
          partNumbers,
        }),
      ).rejects.toBeInstanceOf(UploadSessionInvalidStateError);
    }
    await expect(
      module.grant({
        actorUserId: ACTOR.actorUserId,
        workspaceId: "99999999-9999-4999-8999-999999999999",
        sessionId: opened.sessionId,
        partNumbers: [1],
      }),
    ).rejects.toBeInstanceOf(UploadSessionNotFoundError);
    harness.facts.sessions[0]!.status = "finalizing";
    await expect(
      module.grant({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
        partNumbers: [1],
      }),
    ).rejects.toBeInstanceOf(UploadSessionInvalidStateError);
  });

  test("grant activity renews idle expiry without crossing the hard lifetime", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        smallFileThresholdBytes: 1,
        sessionIdleMs: 60 * 60 * 1_000,
        sessionHardLifetimeMs: 3 * 60 * 60 * 1_000,
      }),
      now: () => now,
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "40000000-0000-4000-8000-000000000034",
      title: "Renew idle expiry",
      source: {
        fileName: "renew.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["renew.mp4",2,"video/mp4",34]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    now = new Date("2026-08-27T00:50:00.000Z");
    await module.grant({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      partNumbers: [1],
    });
    expect(harness.facts.sessions[0]?.expiresAt.toISOString()).toBe(
      "2026-08-27T01:50:00.000Z",
    );

    now = new Date("2026-08-27T01:40:00.000Z");
    await module.grant({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      partNumbers: [1],
    });
    expect(harness.facts.sessions[0]?.expiresAt.toISOString()).toBe(
      "2026-08-27T02:40:00.000Z",
    );

    now = new Date("2026-08-27T02:30:00.000Z");
    await module.grant({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      partNumbers: [1],
    });
    expect(harness.facts.sessions[0]?.expiresAt.toISOString()).toBe(
      "2026-08-27T03:00:00.000Z",
    );
  });

  test("resume grants renew idle expiry without crossing hard expiry", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        sessionIdleMs: 60_000,
        sessionHardLifetimeMs: 180_000,
      }),
      now: () => now,
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "40000000-0000-4000-8000-000000000043",
      title: "Resume renewal",
      source: {
        fileName: "resume-renew.mp4",
        sizeBytes: 100,
        contentType: "video/mp4",
        browserFingerprint: '["resume-renew.mp4",100,"video/mp4",43]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };
    await module.open(input);
    now = new Date("2026-08-27T00:00:50.000Z");

    const resumed = await module.open(input);

    expect(resumed.outcome).toBe("uploading");
    expect(harness.facts.sessions[0]?.expiresAt.toISOString()).toBe(
      "2026-08-27T00:01:50.000Z",
    );
  });

  test("a maintenance claim fences late grant renewal and finalization", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      now: () => now,
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "40000000-0000-4000-8000-000000000045",
      title: "Fenced transfer",
      source: {
        fileName: "fenced.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["fenced.mp4",2,"video/mp4",45]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const session = harness.facts.sessions[0]!;
    session.cleanupRetryAt = now;
    const claim = await harness.adapters.persistence.claimReconciliation({
      sessionId: session.id,
      reconciliationAttemptId: "maintenance-claim",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      updatedAt: now,
    });
    expect(claim.claimed).toBe(true);

    await expect(
      module.grant({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
        partNumbers: [1],
      }),
    ).rejects.toBeInstanceOf(UploadSessionInvalidStateError);
    await expect(
      module.finalize({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
        parts: [{ partNumber: 1, etag: "etag-1" }],
      }),
    ).rejects.toBeInstanceOf(UploadSessionInvalidStateError);
    expect(session.reconciliationAttemptId).toBe("maintenance-claim");
    expect(session.status).toBe("uploading");
  });

  test("expired browser activity schedules compensation before issuing more grants", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        smallFileThresholdBytes: 1,
        sessionIdleMs: 60_000,
        sessionHardLifetimeMs: 120_000,
      }),
      now: () => now,
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "40000000-0000-4000-8000-000000000044",
      title: "Expired browser",
      source: {
        fileName: "expired-browser.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["expired-browser.mp4",2,"video/mp4",44]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };
    const opened = await module.open(input);
    now = new Date("2026-08-27T00:01:00.001Z");

    await expect(module.open(input)).rejects.toBeInstanceOf(
      UploadSessionInvalidStateError,
    );
    await expect(
      module.grant({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
        partNumbers: [1],
      }),
    ).rejects.toBeInstanceOf(UploadSessionInvalidStateError);
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "compensating",
      failureCode: "upload_session_expired",
      reconcileAt: now,
    });
  });

  test("rejects grants after idle expiry instead of reviving the session", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        smallFileThresholdBytes: 1,
        sessionIdleMs: 60_000,
        sessionHardLifetimeMs: 120_000,
      }),
      now: () => now,
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "40000000-0000-4000-8000-000000000044",
      title: "Expired grant",
      source: {
        fileName: "expired.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["expired.mp4",2,"video/mp4",44]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    now = new Date("2026-08-27T00:01:00.001Z");

    await expect(
      module.grant({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
        partNumbers: [1],
      }),
    ).rejects.toBeInstanceOf(UploadSessionInvalidStateError);
    expect(harness.facts.sessions[0]?.expiresAt.toISOString()).toBe(
      "2026-08-27T00:01:00.000Z",
    );
  });

  test("parses transfer policy once and rejects invalid startup configuration", () => {
    expect(
      uploadSessionConfigFromEnv({
        UPLOAD_SINGLE_PUT_THRESHOLD_BYTES: String(64 * 1024 * 1024),
        UPLOAD_MULTIPART_CONCURRENCY: "8",
      }),
    ).toMatchObject({
      smallFileThresholdBytes: 64 * 1024 * 1024,
      multipartConcurrency: 8,
    });
    expect(() =>
      uploadSessionConfigFromEnv({ UPLOAD_MULTIPART_CONCURRENCY: "0" }),
    ).toThrow("UPLOAD_MULTIPART_CONCURRENCY");
  });

  test("opens one workspace-owned multipart session without creating an empty Project", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });

    const result = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "44444444-4444-4444-8444-444444444444",
      title: "Field notes",
      source: {
        fileName: "field-notes.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["field-notes.mp4",33554432,"video/mp4",42]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });

    expect(result.outcome).toBe("uploading");
    if (result.outcome !== "uploading") throw new Error("expected uploading outcome");
    expect(result.transfer.kind).toBe("multipart");
    expect(result).not.toHaveProperty("providerUploadId");
    expect(result).not.toHaveProperty("storageKey");
    expect(harness.facts.projects).toHaveLength(0);
    expect(harness.facts.providerInitiations).toHaveLength(1);
    expect(harness.facts.multipartPartListings).toBe(0);
    expect(harness.facts.sessions).toHaveLength(1);
    expect(harness.facts.sessions[0]).toMatchObject({
      id: result.sessionId,
      workspaceId: ACTOR.workspaceId,
      preallocatedProjectId: result.projectId,
      title: "Field notes",
      fileName: "field-notes.mp4",
      status: "uploading",
      transferKind: "multipart",
    });
  });

  test("uses one content-type-bound PUT and one exact probe for a small source", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "45454545-4545-4454-8454-454545454545",
      title: "Short audio",
      source: {
        fileName: "short.wav",
        sizeBytes: 2_048,
        contentType: "audio/wav",
        browserFingerprint: '["short.wav",2048,"audio/wav",101]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    if (opened.outcome !== "uploading" || opened.transfer.kind !== "single") {
      throw new Error("expected single transfer");
    }
    expect(opened.transfer.grant.contentType).toBe("audio/wav");
    expect(harness.facts.providerInitiations).toHaveLength(0);
    harness.putSingleObject(opened.sessionId, {
      sizeBytes: 2_048,
      contentType: "audio/wav",
    });

    const finalized = await module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts: [],
    });

    expect(finalized.outcome).toBe("queued_for_ingest");
    expect(harness.facts.singlePuts).toBe(1);
    expect(harness.facts.providerCompletions).toBe(0);
    expect(harness.facts.objectProbes).toBe(1);
    expect(harness.facts.projects).toHaveLength(1);
  });

  test("adopts an exact direct object on replay without uploading it again", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "46464646-4646-4464-8464-464646464646",
      title: "Lost PUT response",
      source: {
        fileName: "adopt.wav",
        sizeBytes: 2_048,
        contentType: "audio/wav",
        browserFingerprint: '["adopt.wav",2048,"audio/wav",102]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };
    const opened = await module.open(input);
    harness.putSingleObject(opened.sessionId, {
      sizeBytes: 2_048,
      contentType: "audio/wav",
    });

    const adopted = await module.open(input);

    expect(adopted).toMatchObject({
      outcome: "queued_for_ingest",
      sessionId: opened.sessionId,
      projectId: opened.projectId,
    });
    expect(harness.facts.singlePuts).toBe(1);
    expect(harness.facts.objectProbes).toBe(1);
    expect(harness.facts.projects).toHaveLength(1);
  });

  test("replays the same immutable client intent without repeating admission or provider work", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "55555555-5555-4555-8555-555555555555",
      title: "Replay me",
      source: {
        fileName: "replay.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["replay.mp4",33554432,"video/mp4",77]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    };

    const first = await module.open(input);
    const replay = await module.open(input);

    expect(replay).toEqual(first);
    expect(harness.facts.sessions).toHaveLength(1);
    expect(harness.facts.providerInitiations).toHaveLength(1);
    expect(harness.facts.quotaChecks).toBe(1);
    expect(harness.facts.brandResolutions).toBe(1);
  });

  test("active multipart replay returns completed-part facts without another provider start", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "54545454-5454-4454-8454-545454545454",
      title: "Resume parts",
      source: {
        fileName: "resume.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["resume.mp4",33554432,"video/mp4",10]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    };
    const opened = await module.open(input);
    harness.uploadMultipartParts(opened.sessionId, [
      { partNumber: 1, etag: "etag-1" },
    ]);

    const resumed = await module.open(input);

    if (resumed.outcome !== "uploading" || resumed.transfer.kind !== "multipart") {
      throw new Error("expected multipart resume");
    }
    expect(resumed.transfer.completedParts).toEqual([
      { partNumber: 1, etag: "etag-1" },
    ]);
    expect(resumed.transfer.grants).toHaveLength(resumed.transfer.partCount - 1);
    expect(harness.facts.providerInitiations).toHaveLength(1);
    expect(harness.facts.multipartPartListings).toBe(1);
  });

  test("rejects duplicate or out-of-plan provider parts during true resume", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "40000000-0000-4000-8000-000000000024",
      title: "Malformed resume",
      source: {
        fileName: "malformed.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["malformed.mp4",33554432,"video/mp4",24]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };
    const opened = await module.open(input);
    harness.uploadMultipartParts(opened.sessionId, [
      { partNumber: 1, etag: "first" },
      { partNumber: 1, etag: "replacement" },
    ]);

    await expect(module.open(input)).rejects.toBeInstanceOf(
      UploadSessionIntegrityError,
    );
  });

  test("collapses concurrent open commands before quota, brand, or provider work", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "67676767-6767-4676-8676-676767676767",
      title: "Concurrent open",
      source: {
        fileName: "concurrent.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["concurrent.mp4",33554432,"video/mp4",404]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    };

    const [left, right] = await Promise.all([
      module.open(input),
      module.open(input),
    ]);

    expect(right.sessionId).toBe(left.sessionId);
    expect(harness.facts.sessions).toHaveLength(1);
    expect(harness.facts.quotaChecks).toBe(1);
    expect(harness.facts.brandResolutions).toBe(1);
    expect(harness.facts.providerInitiations).toHaveLength(1);
  });

  test("persists the frozen profile snapshot in the initial durable reservation", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const basePersistence = harness.adapters.persistence;
    const baseAdmission = harness.adapters.admission;
    const profileId = "77777777-7777-4777-8777-777777777777";
    const profileSnapshot = { version: 1, profileId, profileRevision: 3 };
    let observedReservation: { profileId: string | null; snapshot: unknown } | null = null;
    const module = createUploadSessionModule({
      ...harness.adapters,
      admission: {
        ...baseAdmission,
        async resolveBrand() {
          return {
            templateId: null,
            snapshot: null,
            profileId,
            profileSnapshot,
          };
        },
      },
      persistence: {
        ...basePersistence,
        async prepareAdmission(input) {
          const reserved = harness.facts.sessions.find(
            (session) => session.id === input.sessionId,
          );
          observedReservation = {
            profileId: reserved?.brandProfileId ?? null,
            snapshot: reserved?.brandProfileSnapshot ?? null,
          };
          return basePersistence.prepareAdmission(input);
        },
      },
    });

    await module.open({
      ...ACTOR,
      clientIdempotencyKey: "78787878-7878-4878-8878-787878787878",
      title: "Frozen reservation",
      source: {
        fileName: "frozen.mp4",
        sizeBytes: 100,
        contentType: "video/mp4",
        browserFingerprint: '["frozen.mp4",100,"video/mp4",1]',
      },
      brandTemplateId: null,
      brandProfileId: profileId,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });

    expect(observedReservation).toEqual({
      profileId,
      snapshot: profileSnapshot,
    });
  });

  test("waits for a live admission claim instead of bypassing quota during a slow check", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const baseAdmission = harness.adapters.admission;
    let releaseQuota!: () => void;
    let signalQuotaEntered!: () => void;
    const quotaEntered = new Promise<void>((resolve) => {
      signalQuotaEntered = resolve;
    });
    const quotaReleased = new Promise<void>((resolve) => {
      releaseQuota = resolve;
    });
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      admission: {
        ...baseAdmission,
        async assertQuota(workspaceId) {
          signalQuotaEntered();
          await quotaReleased;
          await baseAdmission.assertQuota(workspaceId);
        },
      },
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "68686868-6868-4686-8686-686868686868",
      title: "Slow admission",
      source: {
        fileName: "slow.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["slow.mp4",33554432,"video/mp4",505]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    };

    const first = module.open(input);
    await quotaEntered;
    const second = module.open(input);
    releaseQuota();
    const [left, right] = await Promise.all([first, second]);

    expect(right.sessionId).toBe(left.sessionId);
    expect(harness.facts.quotaChecks).toBe(1);
    expect(harness.facts.brandResolutions).toBe(1);
    expect(harness.facts.providerInitiations).toHaveLength(1);
  });

  test("elects one recovery claimant after an admission lease expires", async () => {
    const harness = createInMemoryUploadSessionHarness();
    harness.failNextProviderBinding();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "69696969-6969-4696-8696-696969696969",
      title: "Expired admission",
      source: {
        fileName: "expired.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["expired.mp4",33554432,"video/mp4",606]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    };
    await expect(module.open(input)).rejects.toThrow(
      "injected provider bind loss",
    );
    const session = harness.facts.sessions[0]!;
    session.admissionPreparedAt = null;
    session.admissionClaimExpiresAt = new Date("2026-08-26T23:59:59.000Z");

    const [left, right] = await Promise.all([
      module.open(input),
      module.open(input),
    ]);

    expect(right.sessionId).toBe(left.sessionId);
    expect(harness.facts.quotaChecks).toBe(2);
    expect(harness.facts.brandResolutions).toBe(1);
    expect(harness.facts.exactKeyListings).toBe(1);
    expect(harness.facts.providerInitiations).toHaveLength(1);
  });

  test("aborts a newly-created provider transfer when another claimant already won binding", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const basePersistence = harness.adapters.persistence;
    let injectWinner = true;
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      persistence: {
        ...basePersistence,
        async bindMultipartProvider(input) {
          if (injectWinner) {
            injectWinner = false;
            const session = harness.facts.sessions.find(
              (candidate) => candidate.id === input.sessionId,
            )!;
            session.providerUploadId = "opaque/provider/winner";
            session.status = "uploading";
            session.admissionAttemptId = null;
            session.admissionClaimExpiresAt = null;
          }
          return basePersistence.bindMultipartProvider(input);
        },
      },
    });

    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "70707070-7070-4070-8070-707070707070",
      title: "Losing provider",
      source: {
        fileName: "loser.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["loser.mp4",33554432,"video/mp4",707]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    });

    expect(opened.outcome).toBe("uploading");
    expect(harness.facts.providerAborts).toEqual(["opaque/provider/1"]);
    expect(harness.facts.sessions[0]?.providerUploadId).toBe(
      "opaque/provider/winner",
    );
  });

  test("records malformed provider identity as a terminal typed failure", async () => {
    const harness = createInMemoryUploadSessionHarness();
    harness.returnNextProviderIdentity("");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "71717171-7171-4171-8171-717171717171",
      title: "Malformed provider",
      source: {
        fileName: "malformed.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["malformed.mp4",33554432,"video/mp4",808]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    };

    await expect(module.open(input)).rejects.toThrow(
      "malformed upload identity",
    );
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "failed",
      failureCode: "provider_identity_invalid",
    });
    await expect(module.open(input)).rejects.toBeInstanceOf(
      UploadSessionInvalidStateError,
    );
  });

  test("adopts the exact-key provider upload after its binding response is lost", async () => {
    const harness = createInMemoryUploadSessionHarness();
    harness.failNextProviderBinding();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "56565656-5656-4565-8565-565656565656",
      title: "Recover admission",
      source: {
        fileName: "recover.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["recover.mp4",33554432,"video/mp4",202]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    };

    await expect(module.open(input)).rejects.toThrow("injected provider bind loss");
    const recovered = await module.open(input);

    expect(recovered.outcome).toBe("uploading");
    expect(harness.facts.providerInitiations).toHaveLength(1);
    expect(harness.facts.exactKeyListings).toBe(1);
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "uploading",
      providerUploadId: "opaque/provider/1",
    });
  });

  test("adopts the oldest exact-key upload and aborts every duplicate", async () => {
    const harness = createInMemoryUploadSessionHarness();
    harness.failNextProviderBinding();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "57575757-5757-4575-8575-575757575757",
      title: "Deduplicate admission",
      source: {
        fileName: "dedupe.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["dedupe.mp4",33554432,"video/mp4",303]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    };
    await expect(module.open(input)).rejects.toThrow("injected provider bind loss");
    const sessionId = harness.facts.sessions[0]!.id;
    harness.createDuplicateUnfinishedUpload(sessionId);
    harness.createDuplicateUnfinishedUpload(sessionId);

    await module.open(input);

    expect(harness.facts.sessions[0]?.providerUploadId).toBe(
      "opaque/provider/1",
    );
    expect(harness.facts.providerAborts).toEqual([
      "opaque/provider/2",
      "opaque/provider/3",
    ]);
    expect(harness.facts.unfinishedProviderUploads).toEqual([
      "opaque/provider/1",
    ]);
  });

  test("persists and retries partial duplicate-upload cleanup", async () => {
    const harness = createInMemoryUploadSessionHarness();
    harness.failNextProviderBinding();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "58585858-5858-4585-8585-585858585858",
      title: "Retry cleanup",
      source: {
        fileName: "cleanup.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["cleanup.mp4",33554432,"video/mp4",304]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    };
    await expect(module.open(input)).rejects.toThrow(
      "injected provider bind loss",
    );
    const sessionId = harness.facts.sessions[0]!.id;
    harness.createDuplicateUnfinishedUpload(sessionId);
    harness.createDuplicateUnfinishedUpload(sessionId);
    harness.failNextProviderAbort(new Error("temporary abort failure"));

    await expect(module.open(input)).rejects.toThrow(
      "storage cleanup must be retried",
    );
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "uploading",
      failureCode: "duplicate_upload_cleanup_failed",
      cleanupRetryAt: expect.any(Date),
    });

    await module.open(input);

    expect(harness.facts.unfinishedProviderUploads).toEqual([
      "opaque/provider/1",
    ]);
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "uploading",
      failureCode: null,
      cleanupRetryAt: null,
    });
  });

  test("rejects changed immutable input for an existing workspace key without mutation", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "66666666-6666-4666-8666-666666666666",
      title: "Original",
      source: {
        fileName: "original.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["original.mp4",33554432,"video/mp4",88]',
      },
      brandTemplateId: null,
      generation: { languageCode: "auto", contentPack: CONTENT_PACK },
    };
    await module.open(input);

    await expect(
      module.open({ ...input, title: "Changed after reservation" }),
    ).rejects.toBeInstanceOf(UploadSessionIdempotencyConflictError);
    expect(harness.facts.sessions).toHaveLength(1);
    expect(harness.facts.providerInitiations).toHaveLength(1);
    expect(harness.facts.quotaChecks).toBe(1);
    expect(harness.facts.brandResolutions).toBe(1);
  });

  test("finalizes multipart bytes into exactly one queued Project handoff", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "77777777-7777-4777-8777-777777777777",
      title: "Verified source",
      source: {
        fileName: "verified.mp4",
        sizeBytes: 33_554_432,
        contentType: "video/mp4",
        browserFingerprint: '["verified.mp4",33554432,"video/mp4",99]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    if (opened.outcome !== "uploading" || opened.transfer.kind !== "multipart") {
      throw new Error("expected multipart transfer");
    }
    harness.uploadMultipartParts(
      opened.sessionId,
      Array.from({ length: opened.transfer.partCount }, (_, index) => ({
        partNumber: index + 1,
        etag: `etag-${index + 1}`,
      })),
    );

    const finalized = await module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts: Array.from({ length: opened.transfer.partCount }, (_, index) => ({
        partNumber: index + 1,
        etag: `etag-${index + 1}`,
      })),
    });
    const replay = await module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts: [],
    });

    expect(finalized).toEqual({
      outcome: "queued_for_ingest",
      sessionId: opened.sessionId,
      projectId: opened.projectId,
      queuedJobId: expect.any(String),
    });
    expect(replay).toEqual(finalized);
    expect(harness.facts.projects).toHaveLength(1);
    expect(harness.facts.contentPacks).toHaveLength(1);
    expect(harness.facts.ingestJobs).toHaveLength(1);
    expect(harness.facts.providerCompletions).toBe(1);
    expect(harness.facts.objectProbes).toBe(1);
    expect(harness.facts.projects[0]).toMatchObject({
      id: opened.projectId,
      title: "Verified source",
      workspaceId: ACTOR.workspaceId,
      createdByUserId: ACTOR.actorUserId,
      sourceSizeBytes: 33_554_432,
      sourceMimeType: "video/mp4",
      ingestStatus: "queued",
    });
  });

  test("persists completion intent and returns reconciling after an ambiguous provider timeout", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "50000000-0000-4000-8000-000000000005",
      title: "Ambiguous completion",
      source: {
        fileName: "ambiguous.mp4",
        sizeBytes: 32 * 1024 * 1024,
        contentType: "video/mp4",
        browserFingerprint: '["ambiguous.mp4",33554432,"video/mp4",5]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };
    const opened = await module.open(input);
    if (opened.outcome !== "uploading" || opened.transfer.kind !== "multipart") {
      throw new Error("expected multipart transfer");
    }
    const parts = Array.from(
      { length: opened.transfer.partCount },
      (_, index) => ({ partNumber: index + 1, etag: `etag-${index + 1}` }),
    );
    harness.uploadMultipartParts(opened.sessionId, parts);
    const timeout = new Error("socket timed out after provider accepted request");
    timeout.name = "TimeoutError";
    harness.failNextProviderCompletion(timeout, true);

    const result = await module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts,
    });
    const replay = await module.open(input);

    expect(result).toEqual({
      outcome: "reconciling",
      sessionId: opened.sessionId,
      retryAfterSeconds: 5,
    });
    expect(replay).toEqual({
      outcome: "reconciling",
      sessionId: opened.sessionId,
      projectId: opened.projectId,
      retryAfterSeconds: 5,
    });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "reconciling",
      completionParts: parts,
    });
    expect(harness.facts.projects).toHaveLength(0);
  });

  test("reconciliation adopts an exact object from a persisted completion intent", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      now: () => now,
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "50000000-0000-4000-8000-000000000015",
      title: "Background adoption",
      source: {
        fileName: "background.mp4",
        sizeBytes: 32 * 1024 * 1024,
        contentType: "video/mp4",
        browserFingerprint: '["background.mp4",33554432,"video/mp4",15]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    if (opened.outcome !== "uploading" || opened.transfer.kind !== "multipart") {
      throw new Error("expected multipart transfer");
    }
    const parts = Array.from(
      { length: opened.transfer.partCount },
      (_, index) => ({ partNumber: index + 1, etag: `etag-${index + 1}` }),
    );
    harness.uploadMultipartParts(opened.sessionId, parts);
    const timeout = new Error("provider response lost");
    timeout.name = "TimeoutError";
    harness.failNextProviderCompletion(timeout, true);
    await module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts,
    });
    now = new Date("2026-08-27T00:00:06.000Z");

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 1, deferred: 0 });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "queued_for_ingest",
      queuedJobId: expect.any(String),
    });
    expect(harness.facts.projects).toHaveLength(1);
    expect(harness.facts.ingestJobs).toHaveLength(1);
    expect(harness.facts.providerCompletions).toBe(1);
    expect(harness.facts.objectProbes).toBe(1);
  });

  test("replays handoff after the provider object succeeds but the database transaction fails", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      now: () => now,
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "50000000-0000-4000-8000-000000000020",
      title: "Retry handoff",
      source: {
        fileName: "handoff.mp4",
        sizeBytes: 100,
        contentType: "video/mp4",
        browserFingerprint: '["handoff.mp4",100,"video/mp4",20]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    harness.putSingleObject(opened.sessionId, {
      sizeBytes: 100,
      contentType: "video/mp4",
    });
    harness.failNextHandoff(new Error("database transaction unavailable"));

    const inline = await module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts: [],
    });
    now = new Date("2026-08-27T00:00:06.000Z");
    const background = await module.reconcileDueSessions();

    expect(inline).toEqual({
      outcome: "reconciling",
      sessionId: opened.sessionId,
      retryAfterSeconds: 5,
    });
    expect(background).toEqual({ claimed: 1, settled: 1, deferred: 0 });
    expect(harness.facts.projects).toHaveLength(1);
    expect(harness.facts.ingestJobs).toHaveLength(1);
    expect(harness.facts.sessions[0]?.status).toBe("queued_for_ingest");
  });

  test("an exact NoSuchUpload response adopts the completed object", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "50000000-0000-4000-8000-000000000025",
      title: "Missing provider upload",
      source: {
        fileName: "missing-upload.mp4",
        sizeBytes: 32 * 1024 * 1024,
        contentType: "video/mp4",
        browserFingerprint: '["missing-upload.mp4",33554432,"video/mp4",25]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    if (opened.outcome !== "uploading" || opened.transfer.kind !== "multipart") {
      throw new Error("expected multipart transfer");
    }
    const parts = Array.from(
      { length: opened.transfer.partCount },
      (_, index) => ({ partNumber: index + 1, etag: `etag-${index + 1}` }),
    );
    harness.uploadMultipartParts(opened.sessionId, parts);
    const missingUpload = new Error("provider upload no longer exists");
    missingUpload.name = "NoSuchUpload";
    harness.failNextProviderCompletion(missingUpload, true);

    const result = await module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts,
    });

    expect(result.outcome).toBe("queued_for_ingest");
    expect(harness.facts.projects).toHaveLength(1);
    expect(harness.facts.objectProbes).toBe(1);
  });

  test("settles an invalid multipart inventory without futile reconciliation", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "50000000-0000-4000-8000-000000000035",
      title: "Invalid completion",
      source: {
        fileName: "invalid.mp4",
        sizeBytes: 32 * 1024 * 1024,
        contentType: "video/mp4",
        browserFingerprint: '["invalid.mp4",33554432,"video/mp4",35]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    if (opened.outcome !== "uploading" || opened.transfer.kind !== "multipart") {
      throw new Error("expected multipart transfer");
    }
    const parts = Array.from(
      { length: opened.transfer.partCount },
      (_, index) => ({ partNumber: index + 1, etag: `etag-${index + 1}` }),
    );
    harness.uploadMultipartParts(opened.sessionId, parts);
    const invalidPart = new Error("provider rejected a part");
    invalidPart.name = "InvalidPart";
    harness.failNextProviderCompletion(invalidPart);

    await expect(
      module.finalize({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
        parts,
      }),
    ).rejects.toBeInstanceOf(UploadSessionIntegrityError);
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "failed",
      failureCode: "multipart_completion_invalid_parts",
    });
    expect(harness.facts.providerAborts).toHaveLength(1);
    expect(harness.facts.unfinishedProviderUploads).toHaveLength(0);
  });

  test("maintenance compensates an idle multipart session before expiring it", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const diagnostics: UploadSessionDiagnosticEvent[] = [];
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      now: () => now,
      diagnose: (event) => diagnostics.push(event),
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000006",
      title: "Idle upload",
      source: {
        fileName: "idle.mp4",
        sizeBytes: 32 * 1024 * 1024,
        contentType: "video/mp4",
        browserFingerprint: '["idle.mp4",33554432,"video/mp4",6]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    now = new Date("2026-08-28T00:00:00.001Z");

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 1, deferred: 0 });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "expired",
      failureCode: "upload_session_expired",
    });
    expect(harness.facts.providerAborts).toHaveLength(1);
    expect(harness.facts.unfinishedProviderUploads).toHaveLength(0);
    expect(harness.facts.projects).toHaveLength(0);
    expect(opened.outcome).toBe("uploading");
    expect(
      diagnostics.find(
        (event) =>
          event.phase === "reconciliation" &&
          event.disposition === "succeeded",
      ),
    ).toMatchObject({
      providerOperation: "abort",
      providerCallCount: 1,
      declaredAbandonedBytes: 32 * 1024 * 1024,
      declaredAbandonedAgeMs: 86_400_001,
    });
  });

  test("maintenance adopts an initiating multipart transfer after the browser disappears", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    harness.failNextProviderBinding();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      now: () => now,
    });
    await expect(
      module.open({
        ...ACTOR,
        clientIdempotencyKey: "60000000-0000-4000-8000-000000000016",
        title: "Interrupted admission",
        source: {
          fileName: "interrupted.mp4",
          sizeBytes: 32 * 1024 * 1024,
          contentType: "video/mp4",
          browserFingerprint: '["interrupted.mp4",33554432,"video/mp4",16]',
        },
        brandTemplateId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
      }),
    ).rejects.toThrow("injected provider bind loss");
    now = new Date("2026-08-27T00:00:31.000Z");

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 1, deferred: 0 });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "uploading",
      providerUploadId: expect.any(String),
      reconciliationAttemptId: null,
    });
    expect(harness.facts.providerInitiations).toHaveLength(1);
  });

  test("initiating recovery applies the provider operation deadline", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const now = new Date("2026-08-27T00:01:00.000Z");
    const baseStorage = harness.adapters.storage;
    let providerObservedAbort = false;
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        smallFileThresholdBytes: 1,
        reconciliationOperationDeadlineMs: 5,
        reconciliationLeaseMs: 30,
      }),
      now: () => now,
      storage: {
        ...baseStorage,
        listExactKeyMultipartUploads: (_key, signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener("abort", () => {
              providerObservedAbort = true;
              reject(signal.reason);
            });
          }),
      },
    });
    await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000026",
      title: "Bound initiating recovery",
      source: {
        fileName: "bound-initiation.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["bound-initiation.mp4",2,"video/mp4",26]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const session = harness.facts.sessions[0]!;
    session.status = "initiating";
    session.providerUploadId = null;
    session.admissionAttemptId = null;
    session.admissionClaimExpiresAt = new Date("2026-08-27T00:00:01.000Z");
    session.admissionClaimExpiresAt = new Date(now.getTime() - 1);

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 0, deferred: 1 });
    expect(session).toMatchObject({
      status: "initiating",
      admissionAttemptId: null,
      failureCode: "upload_reconciliation_deferred",
    });
    expect(providerObservedAbort).toBe(true);
  });

  test("maintenance compensates unbound multipart state before expiring admission", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    harness.failNextProviderBinding();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      now: () => now,
    });
    await expect(
      module.open({
        ...ACTOR,
        clientIdempotencyKey: "60000000-0000-4000-8000-000000000026",
        title: "Expired admission",
        source: {
          fileName: "expired-admission.mp4",
          sizeBytes: 32 * 1024 * 1024,
          contentType: "video/mp4",
          browserFingerprint: '["expired-admission.mp4",33554432,"video/mp4",26]',
        },
        brandTemplateId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
      }),
    ).rejects.toThrow("injected provider bind loss");
    now = new Date("2026-08-28T00:00:00.001Z");

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 1, deferred: 0 });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "expired",
      failureCode: "upload_session_expired",
    });
    expect(harness.facts.providerAborts).toHaveLength(1);
    expect(harness.facts.unfinishedProviderUploads).toHaveLength(0);
  });

  test("maintenance bounds provider concurrency and isolates one session failure", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    let active = 0;
    let maximumActive = 0;
    let aborts = 0;
    const baseStorage = harness.adapters.storage;
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      now: () => now,
      storage: {
        ...baseStorage,
        async abortMultipart(input) {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          aborts += 1;
          const abortNumber = aborts;
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          if (abortNumber === 1) throw new Error("cleanup denied");
          await baseStorage.abortMultipart(input);
        },
      },
    });
    for (let index = 0; index < 6; index += 1) {
      await module.open({
        ...ACTOR,
        clientIdempotencyKey: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        title: `Expired ${index}`,
        source: {
          fileName: `expired-${index}.mp4`,
          sizeBytes: 2,
          contentType: "video/mp4",
          browserFingerprint: `["expired-${index}.mp4",2,"video/mp4",${index}]`,
        },
        brandTemplateId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
      });
    }
    now = new Date("2026-08-28T00:00:00.001Z");

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 6, settled: 5, deferred: 1 });
    expect(maximumActive).toBe(4);
    expect(
      harness.facts.sessions.filter((session) => session.status === "expired"),
    ).toHaveLength(5);
    expect(
      harness.facts.sessions.filter(
        (session) => session.status === "compensating",
      ),
    ).toHaveLength(1);
  });

  test("maintenance caps provider calls and defers remaining exact-key cleanup", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        smallFileThresholdBytes: 1,
        reconciliationProviderCallBudget: 3,
      }),
      now: () => now,
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000048",
      title: "Bound cleanup calls",
      source: {
        fileName: "bound-cleanup.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["bound-cleanup.mp4",2,"video/mp4",46]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    for (let index = 0; index < 5; index += 1) {
      harness.createDuplicateUnfinishedUpload(opened.sessionId);
    }
    const session = harness.facts.sessions[0]!;
    session.status = "initiating";
    session.providerUploadId = null;
    session.admissionAttemptId = null;
    session.admissionClaimExpiresAt = new Date("2026-08-27T00:00:01.000Z");
    now = new Date("2026-08-28T00:00:00.001Z");

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 0, deferred: 1 });
    expect(harness.facts.providerAborts).toHaveLength(2);
    expect(session.status).toBe("compensating");
  });

  test("paginated inventory charges every provider page against the attempt budget", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const baseStorage = harness.adapters.storage;
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        smallFileThresholdBytes: 1,
        reconciliationProviderCallBudget: 2,
      }),
      now: () => now,
      storage: {
        ...baseStorage,
        async listExactKeyMultipartUploads(storageKey, signal, onProviderCall) {
          onProviderCall?.();
          onProviderCall?.();
          onProviderCall?.();
          return baseStorage.listExactKeyMultipartUploads(
            storageKey,
            signal,
            onProviderCall,
          );
        },
      },
    });
    await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000058",
      title: "Paged inventory budget",
      source: {
        fileName: "paged-budget.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["paged-budget.mp4",2,"video/mp4",58]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const session = harness.facts.sessions[0]!;
    session.status = "initiating";
    session.providerUploadId = null;
    session.admissionAttemptId = null;
    session.admissionClaimExpiresAt = new Date("2026-08-27T00:00:01.000Z");
    now = new Date("2026-08-28T00:00:00.001Z");

    expect(await module.reconcileDueSessions()).toEqual({
      claimed: 1,
      settled: 0,
      deferred: 1,
    });
    expect(harness.facts.providerAborts).toHaveLength(0);
  });

  test.each(["AccessDenied", "NoSuchBucket"])(
    "permanent %s inventory failure settles unbound compensation",
    async (errorName) => {
      const harness = createInMemoryUploadSessionHarness();
      let now = new Date("2026-08-27T00:00:00.000Z");
      const module = createUploadSessionModule({
        ...harness.adapters,
        config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
        now: () => now,
        storage: {
          ...harness.adapters.storage,
          async listExactKeyMultipartUploads() {
            const error = new Error(errorName);
            error.name = errorName;
            throw error;
          },
        },
      });
      await module.open({
        ...ACTOR,
        clientIdempotencyKey:
          errorName === "AccessDenied"
            ? "60000000-0000-4000-8000-000000000059"
            : "60000000-0000-4000-8000-000000000060",
        title: `Permanent ${errorName}`,
        source: {
          fileName: "permanent-list.mp4",
          sizeBytes: 2,
          contentType: "video/mp4",
          browserFingerprint: `["permanent-list.mp4",2,"video/mp4","${errorName}"]`,
        },
        brandTemplateId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
      });
      const session = harness.facts.sessions[0]!;
      session.status = "initiating";
      session.providerUploadId = null;
      session.admissionAttemptId = null;
      session.admissionClaimExpiresAt = new Date("2026-08-27T00:00:01.000Z");
      now = new Date("2026-08-28T00:00:00.001Z");

      expect(await module.reconcileDueSessions()).toEqual({
        claimed: 1,
        settled: 1,
        deferred: 0,
      });
      expect(session).toMatchObject({
        status: "failed",
        failureCode:
          errorName === "AccessDenied"
            ? "upload_cleanup_access_denied"
            : "upload_cleanup_bucket_missing",
      });
    },
  );

  test("permanent compensation denial settles without reclaiming forever", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      now: () => now,
    });
    await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000047",
      title: "Denied cleanup",
      source: {
        fileName: "denied-cleanup.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["denied-cleanup.mp4",2,"video/mp4",47]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const denied = new Error("cleanup forbidden");
    denied.name = "AccessDenied";
    harness.failNextProviderAbort(denied);
    now = new Date("2026-08-28T00:00:00.001Z");

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 1, deferred: 0 });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "failed",
      failureCode: "upload_cleanup_access_denied",
      reconciliationAttemptId: null,
    });
  });

  test("cleanup exhaustion never authorizes a fresh upload", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        smallFileThresholdBytes: 1,
        reconciliationMaximumAttempts: 1,
      }),
      now: () => now,
    });
    const browserFingerprint = '["exhausted-cleanup.mp4",2,"video/mp4",61]';
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000061",
      title: "Exhausted cleanup",
      source: {
        fileName: "exhausted-cleanup.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint,
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const unavailable = new Error("provider temporarily unavailable");
    unavailable.name = "TimeoutError";
    harness.failNextProviderAbort(unavailable);
    now = new Date("2026-08-28T00:00:00.001Z");

    expect(await module.reconcileDueSessions()).toEqual({
      claimed: 1,
      settled: 1,
      deferred: 0,
    });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "failed",
      failureCode: "upload_reconciliation_exhausted",
      providerUploadId: expect.any(String),
    });
    await expect(
      module.status({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        clientIdempotencyKey: "60000000-0000-4000-8000-000000000061",
        sessionId: opened.sessionId,
        browserFingerprint,
      }),
    ).resolves.toMatchObject({
      outcome: "terminal",
      failureCode: "upload_reconciliation_exhausted",
      freshUploadAllowed: false,
    });
  });

  test("maintenance caps a batch at twenty-five sessions and leaves the rest fair", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      now: () => now,
    });
    for (let index = 0; index < 30; index += 1) {
      await module.open({
        ...ACTOR,
        clientIdempotencyKey: `61000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        title: `Batch ${index}`,
        source: {
          fileName: `batch-${index}.mp4`,
          sizeBytes: 100,
          contentType: "video/mp4",
          browserFingerprint: `["batch-${index}.mp4",100,"video/mp4",${index}]`,
        },
        brandTemplateId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
      });
    }
    now = new Date("2026-08-28T00:00:00.001Z");

    const first = await module.reconcileDueSessions();
    const second = await module.reconcileDueSessions();

    expect(first).toEqual({ claimed: 25, settled: 25, deferred: 0 });
    expect(second).toEqual({ claimed: 5, settled: 5, deferred: 0 });
    expect(
      harness.facts.sessions.filter((session) => session.status === "expired"),
    ).toHaveLength(30);
  });

  test("maintenance retries due duplicate multipart cleanup without a browser", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const now = new Date("2026-08-27T00:02:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      now: () => now,
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000056",
      title: "Duplicate cleanup",
      source: {
        fileName: "duplicate.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["duplicate.mp4",2,"video/mp4",56]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    harness.createDuplicateUnfinishedUpload(opened.sessionId);
    harness.facts.sessions[0]!.cleanupRetryAt = now;

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 1, deferred: 0 });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "uploading",
      cleanupRetryAt: null,
    });
    expect(harness.facts.unfinishedProviderUploads).toHaveLength(1);
  });

  test("background completion terminalizes a permanent InvalidPart refusal", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      now: () => now,
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000066",
      title: "Permanent replay failure",
      source: {
        fileName: "permanent.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["permanent.mp4",2,"video/mp4",66]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const parts = [{ partNumber: 1, etag: "etag-1" }];
    harness.uploadMultipartParts(opened.sessionId, parts);
    const timeout = new Error("provider timeout");
    timeout.name = "TimeoutError";
    harness.failNextProviderCompletion(timeout);
    await module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts,
    });
    const invalidPart = new Error("provider rejected persisted inventory");
    invalidPart.name = "InvalidPart";
    harness.failNextProviderCompletion(invalidPart);
    now = new Date("2026-08-27T00:00:06.000Z");

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 1, deferred: 0 });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "failed",
      failureCode: "multipart_completion_invalid_parts",
    });
  });

  test("ambiguous reconciliation stops after the validated attempt budget", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ reconciliationMaximumAttempts: 1 }),
      now: () => now,
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000067",
      title: "Bound reconciliation",
      source: {
        fileName: "bounded-reconciliation.mp4",
        sizeBytes: 100,
        contentType: "video/mp4",
        browserFingerprint: '["bounded-reconciliation.mp4",100,"video/mp4",67]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    harness.failNextObjectProbe("unavailable");
    await module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts: [],
    });
    harness.failNextObjectProbe("unavailable");
    now = new Date("2026-08-27T00:00:06.000Z");

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 1, deferred: 0 });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "failed",
      failureCode: "upload_reconciliation_exhausted",
    });
  });

  test("each reconciliation claim receives a lease based on its actual start", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const claims: Array<{ updatedAt: Date; leaseExpiresAt: Date }> = [];
    const basePersistence = harness.adapters.persistence;
    const baseStorage = harness.adapters.storage;
    let deletes = 0;
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ reconciliationConcurrency: 1 }),
      now: () => now,
      persistence: {
        ...basePersistence,
        async claimReconciliation(input) {
          claims.push({
            updatedAt: input.updatedAt,
            leaseExpiresAt: input.leaseExpiresAt,
          });
          return basePersistence.claimReconciliation(input);
        },
      },
      storage: {
        ...baseStorage,
        async deleteExactObject(key) {
          await baseStorage.deleteExactObject(key);
          deletes += 1;
          if (deletes === 1) {
            now = new Date("2026-08-28T00:01:10.000Z");
          }
        },
      },
    });
    for (let index = 0; index < 2; index += 1) {
      await module.open({
        ...ACTOR,
        clientIdempotencyKey: `60000000-0000-4000-8000-00000000007${index}`,
        title: `Fresh lease ${index}`,
        source: {
          fileName: `fresh-${index}.mp4`,
          sizeBytes: 100,
          contentType: "video/mp4",
          browserFingerprint: `["fresh-${index}.mp4",100,"video/mp4",${index}]`,
        },
        brandTemplateId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
      });
    }
    now = new Date("2026-08-28T00:00:00.000Z");

    await module.reconcileDueSessions();

    expect(claims).toHaveLength(2);
    expect(claims[1]!.updatedAt).toEqual(now);
    expect(claims[1]!.leaseExpiresAt.getTime() - now.getTime()).toBe(60_000);
  });

  test("a stale reconciler cannot overwrite a newer terminal settlement", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const now = new Date("2026-08-27T00:00:00.000Z");
    const baseStorage = harness.adapters.storage;
    const module = createUploadSessionModule({
      ...harness.adapters,
      now: () => now,
      storage: {
        ...baseStorage,
        async headExactObjectIfExists(_storageKey) {
          const session = harness.facts.sessions[0]!;
          session.status = "expired";
          session.failureCode = "settled_by_newer_attempt";
          session.reconciliationAttemptId = null;
          session.reconciliationLeaseExpiresAt = null;
          return {
            sizeBytes: session.fileSizeBytes,
            contentType: session.contentType,
          };
        },
      },
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000036",
      title: "Stale reconciliation",
      source: {
        fileName: "stale.mp4",
        sizeBytes: 100,
        contentType: "video/mp4",
        browserFingerprint: '["stale.mp4",100,"video/mp4",36]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    harness.putSingleObject(opened.sessionId, {
      sizeBytes: 100,
      contentType: "video/mp4",
    });
    harness.facts.sessions[0]!.status = "reconciling";
    harness.facts.sessions[0]!.reconcileAt = now;

    const result = await module.reconcileDueSessions();

    expect(result).toEqual({ claimed: 1, settled: 0, deferred: 0 });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "expired",
      failureCode: "settled_by_newer_attempt",
      queuedJobId: null,
    });
    expect(harness.facts.projects).toHaveLength(0);
  });

  test("claim renewal loss fences provider work before the next operation", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const basePersistence = harness.adapters.persistence;
    const now = new Date("2026-08-27T00:00:06.000Z");
    let renewalCalls = 0;
    const module = createUploadSessionModule({
      ...harness.adapters,
      now: () => now,
      persistence: {
        ...basePersistence,
        async renewReconciliationClaim(input) {
          renewalCalls += 1;
          const session = harness.facts.sessions.find(
            (candidate) => candidate.id === input.sessionId,
          )!;
          session.reconciliationAttemptId = "newer-attempt";
          session.reconciliationLeaseExpiresAt = new Date(
            now.getTime() + 60_000,
          );
          throw new UploadSessionReconciliationClaimLostError();
        },
      },
    });
    await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000061",
      title: "Renewal fencing",
      source: {
        fileName: "renewal.mp4",
        sizeBytes: 100,
        contentType: "video/mp4",
        browserFingerprint: '["renewal.mp4",100,"video/mp4",61]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const session = harness.facts.sessions[0]!;
    session.status = "reconciling";
    session.completionParts = [];
    session.reconcileAt = now;

    expect(await module.reconcileDueSessions()).toEqual({
      claimed: 1,
      settled: 0,
      deferred: 0,
    });
    expect(renewalCalls).toBe(1);
    expect(harness.facts.objectProbes).toBe(0);
    expect(session.reconciliationAttemptId).toBe("newer-attempt");
  });

  test("an expired reconciliation lease can be taken over and fences its predecessor", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "60000000-0000-4000-8000-000000000046",
      title: "Lease takeover",
      source: {
        fileName: "lease.mp4",
        sizeBytes: 100,
        contentType: "video/mp4",
        browserFingerprint: '["lease.mp4",100,"video/mp4",46]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const session = harness.facts.sessions[0]!;
    const startedAt = new Date("2026-08-27T00:00:00.000Z");
    session.status = "reconciling";
    session.reconcileAt = startedAt;
    const first = await harness.adapters.persistence.claimReconciliation({
      sessionId: opened.sessionId,
      reconciliationAttemptId: "first-attempt",
      leaseExpiresAt: new Date("2026-08-27T00:01:00.000Z"),
      updatedAt: startedAt,
    });
    const blocked = await harness.adapters.persistence.claimReconciliation({
      sessionId: opened.sessionId,
      reconciliationAttemptId: "blocked-attempt",
      leaseExpiresAt: new Date("2026-08-27T00:01:00.000Z"),
      updatedAt: startedAt,
    });
    const takeover = await harness.adapters.persistence.claimReconciliation({
      sessionId: opened.sessionId,
      reconciliationAttemptId: "takeover-attempt",
      leaseExpiresAt: new Date("2026-08-27T00:02:01.000Z"),
      updatedAt: new Date("2026-08-27T00:01:01.000Z"),
    });

    expect(first.claimed).toBe(true);
    expect(blocked.claimed).toBe(false);
    expect(takeover.claimed).toBe(true);
    await expect(
      harness.adapters.persistence.releaseReconciliation({
        sessionId: opened.sessionId,
        reconciliationAttemptId: "first-attempt",
        updatedAt: new Date("2026-08-27T00:01:02.000Z"),
      }),
    ).rejects.toBeInstanceOf(UploadSessionReconciliationClaimLostError);
    expect(session.reconciliationAttemptId).toBe("takeover-attempt");
  });

  test("refuses unsupported media before provider work and records a terminal session", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);

    await expect(
      module.open({
        ...ACTOR,
        clientIdempotencyKey: "88888888-8888-4888-8888-888888888888",
        title: "Not media",
        source: {
          fileName: "notes.txt",
          sizeBytes: 100,
          contentType: "text/plain",
          browserFingerprint: '["notes.txt",100,"text/plain",1]',
        },
        brandTemplateId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
      }),
    ).rejects.toThrow("Unsupported upload content type");
    expect(harness.facts.providerInitiations).toHaveLength(0);
    expect(harness.facts.sessions[0]?.status).toBe("failed");
  });

  test("records quota refusal once without brand or provider work", async () => {
    const harness = createInMemoryUploadSessionHarness();
    harness.failQuota(
      new UploadSessionQuotaRefusedError({
        tier: "free",
        limitMinutes: 60,
        usedMinutes: 60,
        requestedMinutes: 0,
      }),
    );
    const module = createUploadSessionModule(harness.adapters);
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "88998899-8899-4899-8899-889988998899",
      title: "No quota",
      source: {
        fileName: "quota.mp4",
        sizeBytes: 100,
        contentType: "video/mp4",
        browserFingerprint: '["quota.mp4",100,"video/mp4",1]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };

    await expect(module.open(input)).rejects.toBeInstanceOf(
      UploadSessionQuotaRefusedError,
    );
    await expect(module.open(input)).rejects.toBeInstanceOf(
      UploadSessionInvalidStateError,
    );
    expect(harness.facts.quotaChecks).toBe(1);
    expect(harness.facts.brandResolutions).toBe(0);
    expect(harness.facts.providerInitiations).toHaveLength(0);
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "failed",
      failureCode: "quota_exceeded",
    });
  });

  test("turns an unambiguous provider refusal into a terminal session", async () => {
    const harness = createInMemoryUploadSessionHarness();
    harness.failNextProviderCreation(new Error("provider refused request"));
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });

    await expect(
      module.open({
        ...ACTOR,
        clientIdempotencyKey: "88118811-8811-4811-8811-881188118811",
        title: "Provider refusal",
        source: {
          fileName: "provider.mp4",
          sizeBytes: 2_048,
          contentType: "video/mp4",
          browserFingerprint: '["provider.mp4",2048,"video/mp4",1]',
        },
        brandTemplateId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
      }),
    ).rejects.toThrow("provider refused request");
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "failed",
      failureCode: "provider_creation_failed",
    });
  });

  test("isolates session finalization by workspace", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "89898989-8989-4989-8989-898989898989",
      title: "Private upload",
      source: {
        fileName: "private.mp4",
        sizeBytes: 100,
        contentType: "video/mp4",
        browserFingerprint: '["private.mp4",100,"video/mp4",1]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });

    await expect(
      module.finalize({
        actorUserId: ACTOR.actorUserId,
        workspaceId: "99999999-9999-4999-8999-999999999999",
        sessionId: opened.sessionId,
        parts: [],
      }),
    ).rejects.toBeInstanceOf(UploadSessionNotFoundError);
  });

  test("does not let another workspace actor resume a guessed client key", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);
    const input = {
      ...ACTOR,
      clientIdempotencyKey: "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a",
      title: "Actor-owned intent",
      source: {
        fileName: "actor.mp4",
        sizeBytes: 100,
        contentType: "video/mp4",
        browserFingerprint: '["actor.mp4",100,"video/mp4",1]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };
    await module.open(input);

    await expect(
      module.open({
        ...input,
        actorUserId: "abababab-abab-4bab-8bab-abababababab",
      }),
    ).rejects.toBeInstanceOf(UploadSessionNotFoundError);
  });

  test("deletes a mismatched direct object and records a stable failed disposition", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "90909090-9090-4090-8090-909090909090",
      title: "Wrong bytes",
      source: {
        fileName: "wrong.wav",
        sizeBytes: 2_048,
        contentType: "audio/wav",
        browserFingerprint: '["wrong.wav",2048,"audio/wav",1]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    harness.putSingleObject(opened.sessionId, {
      sizeBytes: 2_047,
      contentType: "audio/wav",
    });

    await expect(
      module.finalize({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
        parts: [],
      }),
    ).rejects.toBeInstanceOf(UploadSessionIntegrityError);
    expect(harness.facts.objectDeletes).toBe(1);
    expect(harness.facts.projects).toHaveLength(0);
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "failed",
      failureCode: "upload_object_size_mismatch",
    });
  });

  test("reconciles a missing object but settles access-denied verification", async () => {
    for (const [disposition, expected] of [
      ["missing", { outcome: "reconciling", failureCode: "upload_object_missing" }],
      ["access_denied", { outcome: "failed", failureCode: "upload_object_access_denied" }],
    ] as const) {
      const harness = createInMemoryUploadSessionHarness();
      const module = createUploadSessionModule(harness.adapters);
      const opened = await module.open({
        ...ACTOR,
        clientIdempotencyKey:
          disposition === "missing"
            ? "93939393-9393-4393-8393-939393939393"
            : "94949494-9494-4494-8494-949494949494",
        title: "Probe failure",
        source: {
          fileName: "probe.mp4",
          sizeBytes: 100,
          contentType: "video/mp4",
          browserFingerprint: `["probe.mp4",100,"video/mp4","${disposition}"]`,
        },
        brandTemplateId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
      });
      harness.failNextObjectProbe(disposition);

      const finalization = module.finalize({
          actorUserId: ACTOR.actorUserId,
          workspaceId: ACTOR.workspaceId,
          sessionId: opened.sessionId,
          parts: [],
        });
      if (expected.outcome === "reconciling") {
        await expect(finalization).resolves.toEqual({
          outcome: "reconciling",
          sessionId: opened.sessionId,
          retryAfterSeconds: 5,
        });
      } else {
        await expect(finalization).rejects.toBeInstanceOf(
          UploadSessionIntegrityError,
        );
      }
      expect(harness.facts.sessions[0]).toMatchObject({
        status: expected.outcome,
        failureCode: expected.failureCode,
      });
      expect(harness.facts.projects).toHaveLength(0);
    }
  });

  test("normalizes an exact-object WAV content type before handoff", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "91919191-9191-4191-8191-919191919191",
      title: "WAV alias",
      source: {
        fileName: "alias.wav",
        sizeBytes: 2_048,
        contentType: "audio/wav",
        browserFingerprint: '["alias.wav",2048,"audio/wav",1]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    harness.putSingleObject(opened.sessionId, {
      sizeBytes: 2_048,
      contentType: "audio/x-wav; charset=binary",
    });

    await module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts: [],
    });

    expect(harness.facts.projects[0]?.sourceMimeType).toBe("audio/wav");
  });

  test("a late inline completion returns the worker winner without overwriting it", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const baseStorage = harness.adapters.storage;
    let now = new Date("2026-08-27T00:00:00.000Z");
    let releaseInline!: () => void;
    let signalInlineEntered!: () => void;
    const inlineEntered = new Promise<void>((resolve) => {
      signalInlineEntered = resolve;
    });
    const inlineReleased = new Promise<void>((resolve) => {
      releaseInline = resolve;
    });
    let completionCalls = 0;
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      now: () => now,
      storage: {
        ...baseStorage,
        async completeMultipart(input) {
          completionCalls += 1;
          if (completionCalls === 1) {
            signalInlineEntered();
            await inlineReleased;
            return;
          }
          await baseStorage.completeMultipart(input);
        },
      },
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "95959595-9595-4595-8595-959595959595",
      title: "Inline fencing",
      source: {
        fileName: "inline-fencing.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["inline-fencing.mp4",2,"video/mp4",1]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const parts = [{ partNumber: 1, etag: "etag-1" }];
    harness.uploadMultipartParts(opened.sessionId, parts);

    const inline = module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts,
    });
    await inlineEntered;
    now = new Date("2026-08-27T00:00:06.000Z");
    expect(await module.reconcileDueSessions()).toEqual({
      claimed: 1,
      settled: 1,
      deferred: 0,
    });
    releaseInline();

    await expect(inline).resolves.toMatchObject({ outcome: "queued_for_ingest" });
    expect(harness.facts.sessions[0]?.status).toBe("queued_for_ingest");
    expect(harness.facts.projects).toHaveLength(1);
    expect(harness.facts.ingestJobs).toHaveLength(1);
  });

  test("a stalled first-finalize provider call aborts and returns reconciling", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let aborted = false;
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({
        smallFileThresholdBytes: 1,
        reconciliationOperationDeadlineMs: 5,
        reconciliationLeaseMs: 20,
      }),
      storage: {
        ...harness.adapters.storage,
        async completeMultipart({ signal }) {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        },
      },
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "98989898-9898-4898-8898-989898989898",
      title: "Bound inline completion",
      source: {
        fileName: "bound-inline.mp4",
        sizeBytes: 2,
        contentType: "video/mp4",
        browserFingerprint: '["bound-inline.mp4",2,"video/mp4",98]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const parts = [{ partNumber: 1, etag: "etag-1" }];
    harness.uploadMultipartParts(opened.sessionId, parts);

    await expect(
      module.finalize({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
        parts,
      }),
    ).resolves.toEqual({
      outcome: "reconciling",
      sessionId: opened.sessionId,
      retryAfterSeconds: 5,
    });
    expect(aborted).toBe(true);
  });

  test.each(["timeout", "AccessDenied"])(
    "background integrity cleanup is bounded for %s",
    async (failure) => {
      const harness = createInMemoryUploadSessionHarness();
      const baseStorage = harness.adapters.storage;
      const now = new Date("2026-08-27T00:00:06.000Z");
      let aborted = false;
      const module = createUploadSessionModule({
        ...harness.adapters,
        config: defaultUploadSessionConfig({
          reconciliationOperationDeadlineMs: 5,
          reconciliationLeaseMs: 20,
        }),
        now: () => now,
        storage: {
          ...baseStorage,
          async deleteExactObject(storageKey, signal) {
            if (failure === "AccessDenied") {
              const error = new Error("denied");
              error.name = "AccessDenied";
              throw error;
            }
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new DOMException("aborted", "AbortError"));
              });
            });
            await baseStorage.deleteExactObject(storageKey, signal);
          },
        },
      });
      const opened = await module.open({
        ...ACTOR,
        clientIdempotencyKey:
          failure === "timeout"
            ? "96969696-9696-4696-8696-969696969696"
            : "97979797-9797-4797-8797-979797979797",
        title: "Bound integrity cleanup",
        source: {
          fileName: "integrity.mp4",
          sizeBytes: 100,
          contentType: "video/mp4",
          browserFingerprint: `["integrity.mp4",100,"video/mp4","${failure}"]`,
        },
        brandTemplateId: null,
        generation: { languageCode: "en", contentPack: CONTENT_PACK },
      });
      harness.putSingleObject(opened.sessionId, {
        sizeBytes: 99,
        contentType: "video/mp4",
      });
      const session = harness.facts.sessions[0]!;
      session.status = "reconciling";
      session.completionParts = [];
      session.reconcileAt = now;

      const result = await module.reconcileDueSessions();

      expect(result).toEqual(
        failure === "timeout"
          ? { claimed: 1, settled: 0, deferred: 1 }
          : { claimed: 1, settled: 1, deferred: 0 },
      );
      if (failure === "timeout") expect(aborted).toBe(true);
      else expect(session.failureCode).toBe("upload_cleanup_access_denied");
    },
  );

  test("concurrent finalization converges on one handoff", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "92929292-9292-4292-8292-929292929292",
      title: "Finalize once",
      source: {
        fileName: "once.mp4",
        sizeBytes: 2_048,
        contentType: "video/mp4",
        browserFingerprint: '["once.mp4",2048,"video/mp4",1]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    harness.putSingleObject(opened.sessionId, {
      sizeBytes: 2_048,
      contentType: "video/mp4",
    });

    const [left, right] = await Promise.all([
      module.finalize({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
        parts: [],
      }),
      module.finalize({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
        parts: [],
      }),
    ]);

    expect([left.outcome, right.outcome].sort()).toEqual([
      "queued_for_ingest",
      "reconciling",
    ]);
    expect(harness.facts.projects).toHaveLength(1);
    expect(harness.facts.ingestJobs).toHaveLength(1);
  });

  test("resumes an exact browser file without resubmitting frozen settings", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);
    const browserFingerprint = '["resume.mp4",2048,"video/mp4",7]';
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "93939393-9393-4393-8393-939393939393",
      title: "Frozen title",
      source: {
        fileName: "resume.mp4",
        sizeBytes: 2_048,
        contentType: "video/mp4",
        browserFingerprint,
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });

    const resumed = await module.status({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      clientIdempotencyKey: "93939393-9393-4393-8393-939393939393",
      sessionId: opened.sessionId,
      browserFingerprint,
    });

    expect(resumed).toMatchObject({
      outcome: "uploading",
      sessionId: opened.sessionId,
      projectId: opened.projectId,
    });
  });

  test("discards an active multipart session through fenced compensation", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "94949494-9494-4494-8494-949494949494",
      title: "Discard me",
      source: {
        fileName: "discard.mp4",
        sizeBytes: 2_048,
        contentType: "video/mp4",
        browserFingerprint: '["discard.mp4",2048,"video/mp4",8]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });

    const discarded = await module.discard({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
    });

    expect(discarded).toEqual({
      outcome: "discarded",
      sessionId: opened.sessionId,
    });
    expect(harness.facts.providerAborts).toHaveLength(1);
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "aborted",
      failureCode: "user_discarded",
    });
  });

  test("accepts Discard as delayed compensation when provider cleanup fails", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      storage: {
        ...harness.adapters.storage,
        async abortMultipart() {
          const error = new Error("provider detail must stay internal");
          error.name = "AccessDenied";
          throw error;
        },
      },
    });
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "96969696-9696-4696-8696-969696969691",
      title: "Delayed discard",
      source: {
        fileName: "delayed-discard.mp4",
        sizeBytes: 2_048,
        contentType: "video/mp4",
        browserFingerprint: '["delayed-discard.mp4",2048,"video/mp4",10]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });

    await expect(
      module.discard({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
      }),
    ).resolves.toEqual({
      outcome: "compensating",
      sessionId: opened.sessionId,
      retryAfterSeconds: 5,
    });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "compensating",
      failureCode: "user_discarded",
    });
    await expect(
      module.status({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        clientIdempotencyKey: "96969696-9696-4696-8696-969696969691",
        sessionId: opened.sessionId,
        browserFingerprint: '["delayed-discard.mp4",2048,"video/mp4",10]',
      }),
    ).resolves.toMatchObject({
      outcome: "reconciling",
      sessionId: opened.sessionId,
      projectId: opened.projectId,
    });
  });

  test("turns an idle-expired status read into a pollable cleanup decision", async () => {
    const harness = createInMemoryUploadSessionHarness();
    let now = new Date("2026-08-27T00:00:00.000Z");
    const module = createUploadSessionModule({
      ...harness.adapters,
      now: () => now,
    });
    const browserFingerprint = '["expired-status.mp4",2048,"video/mp4",12]';
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "98989898-9898-4898-8898-989898989893",
      title: "Expired status",
      source: {
        fileName: "expired-status.mp4",
        sizeBytes: 2_048,
        contentType: "video/mp4",
        browserFingerprint,
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    now = new Date("2026-08-29T01:00:00.000Z");

    await expect(
      module.status({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        clientIdempotencyKey: "98989898-9898-4898-8898-989898989893",
        sessionId: opened.sessionId,
        browserFingerprint,
      }),
    ).resolves.toMatchObject({
      outcome: "reconciling",
      sessionId: opened.sessionId,
      projectId: opened.projectId,
    });
    expect(harness.facts.sessions[0]).toMatchObject({
      status: "compensating",
      failureCode: "upload_session_expired",
    });
  });

  test("finalization intent fences a racing Discard", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const baseStorage = harness.adapters.storage;
    const admissionModule = createUploadSessionModule(harness.adapters);
    const opened = await admissionModule.open({
      ...ACTOR,
      clientIdempotencyKey: "97979797-9797-4797-8797-979797979792",
      title: "Finalize wins",
      source: {
        fileName: "finalize-wins.wav",
        sizeBytes: 2_048,
        contentType: "audio/wav",
        browserFingerprint: '["finalize-wins.wav",2048,"audio/wav",11]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    harness.putSingleObject(opened.sessionId, {
      sizeBytes: 2_048,
      contentType: "audio/wav",
    });
    let announceProbe!: () => void;
    let releaseProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      announceProbe = resolve;
    });
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const module = createUploadSessionModule({
      ...harness.adapters,
      storage: {
        ...baseStorage,
        async headExactObject(storageKey, signal) {
          announceProbe();
          await probeGate;
          return baseStorage.headExactObject(storageKey, signal);
        },
      },
    });
    const finalization = module.finalize({
      actorUserId: ACTOR.actorUserId,
      workspaceId: ACTOR.workspaceId,
      sessionId: opened.sessionId,
      parts: [],
    });
    await probeStarted;
    await expect(
      module.discard({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        sessionId: opened.sessionId,
      }),
    ).rejects.toBeInstanceOf(UploadSessionInvalidStateError);
    releaseProbe();
    await expect(finalization).resolves.toMatchObject({
      outcome: "queued_for_ingest",
      projectId: opened.projectId,
    });
  });

  test("proves a terminal compensated session before allowing a fresh upload", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule(harness.adapters);
    const browserFingerprint = '["terminal.mp4",2048,"video/mp4",9]';
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "95959595-9595-4595-8595-959595959595",
      title: "Terminal upload",
      source: {
        fileName: "terminal.mp4",
        sizeBytes: 2_048,
        contentType: "video/mp4",
        browserFingerprint,
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const session = harness.facts.sessions[0]!;
    session.status = "expired";
    session.failureCode = "upload_session_expired";

    await expect(
      module.status({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        clientIdempotencyKey: "95959595-9595-4595-8595-959595959595",
        sessionId: opened.sessionId,
        browserFingerprint,
      }),
    ).resolves.toEqual({
      outcome: "terminal",
      sessionId: opened.sessionId,
      state: "expired",
      failureCode: "upload_session_expired",
      freshUploadAllowed: true,
    });
  });

  test("does not allow a fresh upload when cleanup was denied", async () => {
    const harness = createInMemoryUploadSessionHarness();
    const module = createUploadSessionModule({
      ...harness.adapters,
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
    });
    const browserFingerprint = '["unsafe-terminal.mp4",2048,"video/mp4",13]';
    const opened = await module.open({
      ...ACTOR,
      clientIdempotencyKey: "99999999-9999-4999-8999-999999999994",
      title: "Unsafe terminal",
      source: {
        fileName: "unsafe-terminal.mp4",
        sizeBytes: 2_048,
        contentType: "video/mp4",
        browserFingerprint,
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    });
    const session = harness.facts.sessions[0]!;
    session.status = "failed";
    session.providerUploadId = null;
    for (const failureCode of [
      "upload_cleanup_access_denied",
      "upload_reconciliation_exhausted",
      "multipart_completion_access_denied",
      "multipart_completion_unknown_not_found",
      "upload_object_access_denied",
      "provider_identity_invalid",
    ]) {
      session.failureCode = failureCode;
      await expect(
        module.status({
          actorUserId: ACTOR.actorUserId,
          workspaceId: ACTOR.workspaceId,
          clientIdempotencyKey: "99999999-9999-4999-8999-999999999994",
          sessionId: opened.sessionId,
          browserFingerprint,
        }),
      ).resolves.toEqual({
        outcome: "terminal",
        sessionId: opened.sessionId,
        state: "failed",
        failureCode,
        freshUploadAllowed: false,
      });
    }

    session.transferKind = "single";
    for (const failureCode of [
      "upload_object_access_denied",
      "upload_reconciliation_exhausted",
    ]) {
      session.failureCode = failureCode;
      await expect(
        module.status({
          actorUserId: ACTOR.actorUserId,
          workspaceId: ACTOR.workspaceId,
          clientIdempotencyKey: "99999999-9999-4999-8999-999999999994",
          sessionId: opened.sessionId,
          browserFingerprint,
        }),
      ).resolves.toMatchObject({
        outcome: "terminal",
        failureCode,
        freshUploadAllowed: false,
      });
    }

    session.transferKind = "multipart";
    session.providerUploadId = "provider-state-may-remain";
    session.failureCode = "upload_reconciliation_exhausted";
    await expect(
      module.status({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        clientIdempotencyKey: "99999999-9999-4999-8999-999999999994",
        sessionId: opened.sessionId,
        browserFingerprint,
      }),
    ).resolves.toMatchObject({
      outcome: "terminal",
      failureCode: "upload_reconciliation_exhausted",
      freshUploadAllowed: false,
    });

    session.providerUploadId = null;
    session.failureCode = "upload_object_size_mismatch";
    await expect(
      module.status({
        actorUserId: ACTOR.actorUserId,
        workspaceId: ACTOR.workspaceId,
        clientIdempotencyKey: "99999999-9999-4999-8999-999999999994",
        sessionId: opened.sessionId,
        browserFingerprint,
      }),
    ).resolves.toMatchObject({
      outcome: "terminal",
      failureCode: "upload_object_size_mismatch",
      freshUploadAllowed: true,
    });
  });
});
