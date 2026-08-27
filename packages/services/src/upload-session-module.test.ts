import { describe, expect, test } from "bun:test";
import {
  createInMemoryUploadSessionHarness,
  createUploadSessionModule,
  defaultUploadSessionConfig,
  planUploadTransfer,
  UploadSessionIdempotencyConflictError,
  UploadSessionIntegrityError,
  UploadSessionInvalidStateError,
  UploadSessionNotFoundError,
  UploadSessionQuotaRefusedError,
  uploadSessionConfigFromEnv,
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
      throw new Error("expected multipart upload");
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

    expect(right).toEqual(left);
    expect(harness.facts.projects).toHaveLength(1);
    expect(harness.facts.ingestJobs).toHaveLength(1);
  });
});
