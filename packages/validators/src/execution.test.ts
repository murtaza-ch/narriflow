import { describe, expect, test } from "bun:test";
import { executionCommandSchema, executionDispatchReferenceSchema, executionSignatureSchema, executionDispositionSchema, sourceAudioBindingSchema } from "./execution";

const dispatch = {
  dispatchId: "d66ad223-9e95-4cbe-8838-43ec01aa6df0",
  deploymentEpoch: 1,
  kind: "import_pipeline",
  subject: { kind: "ingest_job", id: "477b7dc3-0584-44db-8ae7-e9269e8d37af" },
  generation: 1,
  inputHash: "a".repeat(64),
};

describe("Execution Dispatch references", () => {
  test("accepts a bounded reference and refuses embedded media or credentials", () => {
    expect(executionDispatchReferenceSchema.parse(dispatch)).toEqual(dispatch);
    expect(executionDispatchReferenceSchema.safeParse({ ...dispatch, signedUrl: "https://private.example/media?secret=credential" }).success).toBe(false);
    expect(executionDispatchReferenceSchema.safeParse({ ...dispatch, subject: { kind: "ingest_job", id: "https://private.example/media" } }).success).toBe(false);
    expect(executionDispatchReferenceSchema.safeParse({ ...dispatch, deploymentEpoch: 0 }).success).toBe(false);
  });
});

const fence = { reference: dispatch, attemptToken: "4ef8a069-3cef-480a-a74a-af3e04cc8859", owner: "583088db-08aa-450a-8b72-3c6c4f6425b9" };

describe("Executor commands", () => {
  test("separates owner acquisition from authority to start a process", () => {
    expect(executionCommandSchema.safeParse({ action: "acquire", reference: dispatch, attemptToken: fence.attemptToken, owner: fence.owner, leaseSeconds: 120 }).success).toBe(true);
    expect(executionCommandSchema.safeParse({ action: "process-start", reference: dispatch, owner: fence.owner }).success).toBe(false);
    expect(executionCommandSchema.safeParse({ action: "process-start", fence }).success).toBe(true);
    expect(executionCommandSchema.safeParse({ action: "acquire", reference: dispatch, attemptToken: fence.attemptToken, owner: fence.owner, leaseSeconds: 121 }).success).toBe(false);
  });
});

describe("Signed execution metadata", () => {
  test("pins method, canonical target, body digest, audience and key version", () => {
    const signature = { version: 1, keyId: "modal-2026-10", audience: "executor-control", method: "POST", canonicalTarget: "/api/execution/command", bodySha256: "b".repeat(64), timestamp: 1793440000, deliveryId: "5b3fb350-6604-4886-80d8-78fc5d17608f", signature: "c".repeat(64) };
    expect(executionSignatureSchema.safeParse(signature).success).toBe(true);
    expect(executionSignatureSchema.safeParse({ ...signature, canonicalTarget: "https://other.example/api/execution/command" }).success).toBe(false);
    expect(executionSignatureSchema.safeParse({ ...signature, version: 2 }).success).toBe(false);
    expect(executionSignatureSchema.safeParse({ ...signature, audience: "any" }).success).toBe(false);
    expect(executionSignatureSchema.safeParse({ ...signature, bodySha256: "not-a-digest" }).success).toBe(false);
  });
});

describe("Executor dispositions", () => {
  test("acquisition cannot grant a lease beyond its absolute operation deadline", () => {
    const acquired = { disposition: "acquired", fence, serverTime: "2026-10-31T00:00:00.000Z", leaseExpiresAt: "2026-10-31T00:02:00.000Z", operationDeadlineAt: "2026-10-31T00:45:00.000Z" };
    expect(executionDispositionSchema.safeParse(acquired).success).toBe(true);
    expect(executionDispositionSchema.safeParse({ ...acquired, leaseExpiresAt: "2026-10-31T00:46:00.000Z" }).success).toBe(false);
    expect(executionDispositionSchema.safeParse({ ...acquired, leaseExpiresAt: acquired.serverTime }).success).toBe(false);
    expect(executionDispositionSchema.safeParse({ disposition: "busy", leaseExpiresAt: acquired.leaseExpiresAt }).success).toBe(true);
  });
});

describe("Source Audio evidence", () => {
  test("requires immutable whole-source audio evidence rather than provider duration or a signed URL", () => {
    const binding = {
      sourceAudioId: "ce4d7e7e-caae-4d85-80f8-17f55e2eaf79", projectId: "05bfd4bb-8ce2-455c-a598-1328f676a288", sourceRevision: 1,
      mediaIdentity: { provider: "youtube", mediaId: "dQw4w9WgXcQ" },
      audioTrack: { id: "251", language: "en", codec: "opus", sampleRate: 48000, channels: 2 },
      object: { key: "attempts/ce4d7e7e/audio.webm", etag: "frozen-etag", byteLength: 20000000, sha256: "e".repeat(64) },
      durationSeconds: 3600.125, wholeSource: true, audioStartTimeSec: 0,
      probeVersion: "normalized-probe-1", toolchainFingerprint: "f".repeat(64),
    };
    expect(sourceAudioBindingSchema.safeParse(binding).success).toBe(true);
    for (const mediaId of ["_Qw4w9WgXcQ", "-Qw4w9WgXcQ"]) {
      expect(sourceAudioBindingSchema.safeParse({ ...binding, mediaIdentity: { provider: "youtube", mediaId } }).success).toBe(true);
    }
    expect(sourceAudioBindingSchema.safeParse({ ...binding, mediaIdentity: { provider: "youtube", mediaId: "too-short" } }).success).toBe(false);
    expect(sourceAudioBindingSchema.safeParse({ ...binding, wholeSource: false }).success).toBe(false);
    expect(sourceAudioBindingSchema.safeParse({ ...binding, object: { ...binding.object, signedUrl: "https://storage.example/audio" } }).success).toBe(false);
    expect(sourceAudioBindingSchema.safeParse({ ...binding, object: { ...binding.object, key: "../other/audio.webm" } }).success).toBe(false);
    expect(sourceAudioBindingSchema.safeParse({ ...binding, durationSeconds: Number.NaN }).success).toBe(false);
  });
});
