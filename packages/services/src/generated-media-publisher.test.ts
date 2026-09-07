import { describe, expect, test } from "bun:test";
import {
  GeneratedMediaPublicationError,
  createGeneratedMediaPublisher,
  type GeneratedMediaAssetRepository,
  type GeneratedMediaPublicationStorage,
} from "./generated-media-publisher";

const scope = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  workspaceOwnerUserId: "00000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  status: "active" as const,
  pricingTier: "creator",
  isPersonalWorkspace: true,
};

function harness(options: {
  bytes?: Uint8Array;
  contentType?: "image/png" | "image/jpeg";
  uploadFailure?: boolean;
  databaseFailure?: boolean;
  orphanAdmissionFailure?: boolean;
  existingAsset?: boolean;
} = {}) {
  const calls: string[] = [];
  const bytes = options.bytes ?? Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const storage: GeneratedMediaPublicationStorage = {
    async download(url, maxBytes) {
      calls.push(`download:${url}:${maxBytes}`);
      return bytes;
    },
    async putAttempt(key) {
      calls.push(`put:${key}`);
      if (options.uploadFailure) throw new Error("upload failed");
    },
    async readAttempt(key) {
      calls.push(`read:${key}`);
      return bytes;
    },
    async publishAttempt(attemptKey, finalKey) {
      calls.push(`publish:${attemptKey}:${finalKey}`);
    },
    async delete(key) {
      calls.push(`delete:${key}`);
    },
  };
  const repository: GeneratedMediaAssetRepository = {
    async findByFingerprint() {
      return options.existingAsset ? {
        id: "00000000-0000-4000-8000-000000000099",
        title: "Existing",
        kind: "image" as const,
        contentType: "image/png" as const,
        sizeBytes: bytes.length,
        width: 1024,
        height: 1536,
        durationSec: null,
        fingerprint: "existing",
        provenance: "generated" as const,
        accessUrl: "https://media.example.test/existing.png",
        replayed: true,
        createdAt: "2026-09-01T00:00:00.000Z",
      } : null;
    },
    async create(input) {
      calls.push(`database:${input.storageKey}`);
      if (options.databaseFailure) throw new Error("database failed");
      return {
        id: "00000000-0000-4000-8000-000000000003",
        title: input.title,
        kind: "image" as const,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        width: input.width,
        height: input.height,
        durationSec: null,
        fingerprint: input.fingerprint,
        provenance: "generated" as const,
        accessUrl: "https://media.example.test/generated.png",
        replayed: false,
        createdAt: "2026-09-01T00:00:00.000Z",
      };
    },
    async admitOrphan(key) {
      calls.push(`orphan:${key}`);
      if (options.orphanAdmissionFailure) throw new Error("database unavailable");
      return "cleanup-claim-1";
    },
  };
  return {
    calls,
    publisher: createGeneratedMediaPublisher({
      storage,
      repository,
      inspect: async () => ({
        contentType: options.contentType ?? "image/png",
        width: 1024,
        height: 1536,
      }),
      maxBytes: 16,
    }),
  };
}

describe("generated image publication", () => {
  test("validates, fingerprints, stages, publishes, and creates a generated Visual Asset", async () => {
    const { publisher, calls } = harness();
    const asset = await publisher.publish({
      jobId: "job-1",
      attempt: 2,
      scope,
      title: "Editorial frame",
      resultContentType: "image/png",
      result: { contentType: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    });

    expect(asset).toMatchObject({ kind: "image", provenance: "generated", width: 1024, height: 1536 });
    expect(calls).toEqual([
      "put:workspaces/00000000-0000-4000-8000-000000000002/generated-media-attempts/job-1/2.png",
      expect.stringMatching(/^orphan:visual-assets\/.*\/generated\/[a-f0-9]{64}\.png$/),
      expect.stringMatching(/^publish:.*:visual-assets\/.*\/generated\/[a-f0-9]{64}\.png$/),
      expect.stringMatching(/^database:visual-assets\/.*\/generated\/[a-f0-9]{64}\.png$/),
      "delete:workspaces/00000000-0000-4000-8000-000000000002/generated-media-attempts/job-1/2.png",
    ]);
  });

  test("uses guarded download for a remote result", async () => {
    const { publisher, calls } = harness();
    await publisher.publish({
      jobId: "job-remote",
      attempt: 1,
      scope,
      title: "Remote frame",
      resultContentType: "image/png",
      result: { contentType: "image/png", url: "https://provider.example.test/result" },
    });
    expect(calls[0]).toBe("download:https://provider.example.test/result:16");
  });

  test("rejects oversized and MIME-mismatched output before upload", async () => {
    const oversized = harness({ bytes: new Uint8Array(17) });
    await expect(oversized.publisher.publish({
      jobId: "large",
      attempt: 1,
      scope,
      title: "Large",
      resultContentType: "image/png",
      result: { contentType: "image/png", bytes: new Uint8Array(17) },
    })).rejects.toMatchObject({ code: "generated_media_output_too_large" });
    expect(oversized.calls).toEqual([]);

    const mismatch = harness({ contentType: "image/jpeg" });
    await expect(mismatch.publisher.publish({
      jobId: "mismatch",
      attempt: 1,
      scope,
      title: "Mismatch",
      resultContentType: "image/png",
      result: { contentType: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    })).rejects.toMatchObject({ code: "generated_media_output_mime_mismatch" });
    expect(mismatch.calls).toEqual([]);
  });

  test("does not publish after an attempt upload crash", async () => {
    const { publisher, calls } = harness({ uploadFailure: true });
    await expect(publisher.publish({
      jobId: "upload-crash",
      attempt: 1,
      scope,
      title: "Crash",
      resultContentType: "image/png",
      result: { contentType: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    })).rejects.toBeInstanceOf(Error);
    expect(calls).toEqual([
      "put:workspaces/00000000-0000-4000-8000-000000000002/generated-media-attempts/upload-crash/1.png",
    ]);
  });

  test("records a published object as an orphan when database publication crashes", async () => {
    const { publisher, calls } = harness({ databaseFailure: true });
    await expect(publisher.publish({
      jobId: "database-crash",
      attempt: 1,
      scope,
      title: "Crash",
      resultContentType: "image/png",
      result: { contentType: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    })).rejects.toBeInstanceOf(Error);
    expect(calls.some((call) => call.startsWith("orphan:"))).toBe(true);
    expect(calls.some((call) => call.startsWith("delete:"))).toBe(false);
  });

  test("never copies the final object when orphan admission is unavailable", async () => {
    const { publisher, calls } = harness({ orphanAdmissionFailure: true });
    await expect(publisher.publish({
      jobId: "orphan-admission-crash",
      attempt: 1,
      scope,
      title: "Crash",
      resultContentType: "image/png",
      result: { contentType: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    })).rejects.toThrow("database unavailable");
    expect(calls.some((call) => call.startsWith("publish:"))).toBe(false);
  });

  test("resumes publication from the durable attempt object", async () => {
    const { publisher, calls } = harness();
    const asset = await publisher.publish({
      jobId: "resume",
      attempt: 1,
      scope,
      title: "Recovered",
      resultContentType: "image/png",
    });

    expect(asset.provenance).toBe("generated");
    expect(calls[0]).toBe(
      "read:workspaces/00000000-0000-4000-8000-000000000002/generated-media-attempts/resume/1.png",
    );
    expect(calls.some((call) => call.startsWith("put:"))).toBe(false);
    expect(calls.at(-1)).toBe(
      "delete:workspaces/00000000-0000-4000-8000-000000000002/generated-media-attempts/resume/1.png",
    );
  });

  test("cleans the durable attempt when a recovered asset already exists", async () => {
    const { publisher, calls } = harness({ existingAsset: true });
    const asset = await publisher.publish({
      jobId: "replay-existing",
      attempt: 1,
      scope,
      title: "Recovered",
      resultContentType: "image/png",
    });
    expect(asset.replayed).toBe(true);
    expect(calls).toEqual([
      "read:workspaces/00000000-0000-4000-8000-000000000002/generated-media-attempts/replay-existing/1.png",
      "delete:workspaces/00000000-0000-4000-8000-000000000002/generated-media-attempts/replay-existing/1.png",
    ]);
  });

  test("requires exactly one output source", async () => {
    const { publisher } = harness();
    await expect(publisher.publish({
      jobId: "malformed",
      attempt: 1,
      scope,
      title: "Malformed",
      resultContentType: "image/png",
      result: { contentType: "image/png" },
    })).rejects.toBeInstanceOf(GeneratedMediaPublicationError);
  });
});
