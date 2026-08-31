import { describe, expect, test } from "bun:test";

import {
  ThumbnailExtractionError,
  createInMemoryThumbnailExtractionStore,
  createThumbnailExtractionService,
  type ThumbnailFrameProcessor,
} from "./thumbnail-extraction.service";

const scope = {
  actorUserId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  projectId: "10000000-0000-4000-8000-000000000003",
};
const exportVariantId = "10000000-0000-4000-8000-000000000004";
const idempotencyKey = "10000000-0000-4000-8000-000000000005";

function fixture(processor?: ThumbnailFrameProcessor) {
  const store = createInMemoryThumbnailExtractionStore({
    variants: [
      {
        id: exportVariantId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        status: "completed",
        storageKey: "exports/immutable.mp4",
        durationSec: 28,
      },
    ],
  });
  return {
    store,
    service: createThumbnailExtractionService({
      store,
      authorize: async () => undefined,
      processor:
        processor ??
        {
          async extract(request) {
            expect(request.sourceStorageKey).toBe("exports/immutable.mp4");
            return {
              storageKey: request.destinationStorageKey,
              contentType: "image/jpeg",
              sizeBytes: 42_000,
              width: 1080,
              height: 1920,
              fingerprint: "a".repeat(64),
            };
          },
        },
      now: () => new Date("2026-08-31T10:00:00.000Z"),
    }),
  };
}

describe("thumbnail frame extraction", () => {
  test("queues once, extracts asynchronously, and returns a durable Visual Asset", async () => {
    const { service } = fixture();
    const first = await service.request(scope, {
      idempotencyKey,
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 7.25,
      title: "Opening proof point",
    });
    const replay = await service.request(scope, {
      idempotencyKey,
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 7.25,
      title: "Opening proof point",
    });

    expect(first.status).toBe("queued");
    expect(replay).toMatchObject({ id: first.id, replayed: true });
    expect(await service.processNext()).toMatchObject({ status: "completed" });
    expect(await service.get(scope, first.id)).toMatchObject({
      status: "completed",
      asset: {
        kind: "image",
        provenance: "extracted",
        sourceExportVariantId: exportVariantId,
        sourceTimeMs: 7_250,
      },
    });
  });

  test("refuses thumbnail extraction for a provider without video-frame support", async () => {
    const { service } = fixture();
    await expect(
      service.request(scope, {
        idempotencyKey,
        platform: "linkedin",
        exportVariantId,
        sourceTimeSec: 2,
        title: "Ignored",
      }),
    ).rejects.toMatchObject({ code: "thumbnail_source_unsupported" });
  });

  test("rejects missing export objects and frame times outside the immutable export", async () => {
    const { service, store } = fixture();
    store.setObjectAvailable(exportVariantId, false);
    await expect(
      service.request(scope, {
        idempotencyKey,
        platform: "tiktok",
        exportVariantId,
        sourceTimeSec: 1,
        title: "Missing",
      }),
    ).rejects.toMatchObject({ code: "thumbnail_source_object_missing" });

    store.setObjectAvailable(exportVariantId, true);
    await expect(
      service.request(scope, {
        idempotencyKey: "10000000-0000-4000-8000-000000000006",
        platform: "tiktok",
        exportVariantId,
        sourceTimeSec: 28,
        title: "Past the end",
      }),
    ).rejects.toMatchObject({ code: "thumbnail_frame_time_invalid" });
  });

  test("makes a failed extraction retryable without creating another job", async () => {
    let calls = 0;
    const destinations: string[] = [];
    const { service } = fixture({
      async extract(request) {
        calls += 1;
        destinations.push(request.destinationStorageKey);
        if (calls === 1) throw new ThumbnailExtractionError("thumbnail_extract_failed", "FFmpeg failed");
        return {
          storageKey: request.destinationStorageKey,
          contentType: "image/jpeg",
          sizeBytes: 10,
          width: 1080,
          height: 1920,
          fingerprint: "b".repeat(64),
        };
      },
    });
    const job = await service.request(scope, {
      idempotencyKey,
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 4,
      title: "Retry frame",
    });

    expect(await service.processNext()).toMatchObject({ status: "failed", attempts: 1 });
    expect((await service.retry(scope, job.id)).id).toBe(job.id);
    expect(await service.processNext()).toMatchObject({ status: "completed", attempts: 2 });
    expect(destinations).toHaveLength(2);
    expect(destinations[0]).not.toBe(destinations[1]);
    expect(destinations[0]).toContain(`${job.id}/attempt-1.jpg`);
    expect(destinations[1]).toContain(`${job.id}/attempt-2.jpg`);
  });

  test("admits an exact-key cleanup obligation before upload and adopts it on completion", async () => {
    const events: string[] = [];
    const { service, store } = fixture({
      async extract(request) {
        events.push(`upload:${request.destinationStorageKey}`);
        expect(store.outputObligations()).toEqual([
          expect.objectContaining({
            objectKey: request.destinationStorageKey,
            status: "held",
          }),
        ]);
        return {
          storageKey: request.destinationStorageKey,
          contentType: "image/jpeg",
          sizeBytes: 42_000,
          width: 1080,
          height: 1920,
          fingerprint: "c".repeat(64),
        };
      },
    });
    const job = await service.request(scope, {
      idempotencyKey,
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 7.25,
      title: "Ledgered frame",
    });

    expect(await service.processNext()).toMatchObject({ status: "completed" });
    expect(events).toHaveLength(1);
    expect(store.outputObligations()).toEqual([
      expect.objectContaining({
        objectKey: expect.stringContaining(`${job.id}/attempt-1.jpg`),
        status: "adopted",
      }),
    ]);
  });

  test("leaves a crashed upload cleanable and retries through a new exact key", async () => {
    const { service, store } = fixture();
    await service.request(scope, {
      idempotencyKey,
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 7.25,
      title: "Crash-safe frame",
    });
    const first = await store.claimNext({ now: new Date("2026-08-31T10:00:00.000Z") });
    const firstKey = `visual-assets/extracted/${scope.workspaceId}/${first!.id}/attempt-1.jpg`;
    await store.prepareOutput({
      jobId: first!.id,
      claimId: first!.claimId!,
      claimExpiresAt: first!.claimExpiresAt!,
      destinationStorageKey: firstKey,
      now: new Date("2026-08-31T10:00:00.000Z"),
    });

    const second = await store.claimNext({ now: new Date("2026-08-31T10:02:01.000Z") });
    expect(second).toMatchObject({ id: first!.id, attempts: 2 });
    const secondKey = `visual-assets/extracted/${scope.workspaceId}/${second!.id}/attempt-2.jpg`;
    await store.prepareOutput({
      jobId: second!.id,
      claimId: second!.claimId!,
      claimExpiresAt: second!.claimExpiresAt!,
      destinationStorageKey: secondKey,
      now: new Date("2026-08-31T10:02:01.000Z"),
    });

    expect(store.outputObligations()).toEqual([
      expect.objectContaining({ objectKey: firstKey, status: "released" }),
      expect.objectContaining({ objectKey: secondKey, status: "held" }),
    ]);
  });

  test("does not resolve a thumbnail after its Visual Asset is deleted", async () => {
    const { service, store } = fixture();
    const job = await service.request(scope, {
      idempotencyKey,
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 5,
      title: "Disposable frame",
    });
    await service.processNext();
    const completed = await service.get(scope, job.id);
    store.deleteAsset(completed.asset?.id ?? "missing");

    await expect(service.get(scope, job.id)).rejects.toMatchObject({
      code: "thumbnail_asset_deleted",
    });
  });

  test("fences settlement from a worker that no longer owns the claim", async () => {
    const { service, store } = fixture();
    await service.request(scope, {
      idempotencyKey,
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 5,
      title: "Fenced frame",
    });
    const claimed = await store.claimNext({ now: new Date() });
    expect(claimed?.claimId).toBeString();

    await expect(
      store.fail({
        jobId: claimed!.id,
        claimId: "40000000-0000-4000-8000-000000000099",
        errorCode: "thumbnail_extract_failed",
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "thumbnail_claim_lost" });
  });

  test("keeps durable status readable when thumbnail writes and retries are disabled", async () => {
    const { service: writer, store } = fixture();
    const durable = await writer.request(scope, {
      idempotencyKey,
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 5,
      title: "Rollback-safe frame",
    });
    const rolledBack = createThumbnailExtractionService({
      store,
      processor: {
        async extract() {
          throw new Error("worker must not run");
        },
      },
      authorize: async () => {
        throw new ThumbnailExtractionError(
          "program_write_disabled",
          "New thumbnail writes are disabled",
        );
      },
      authorizeRead: async () => undefined,
    });

    await expect(rolledBack.get(scope, durable.id)).resolves.toEqual(durable);
    await expect(
      rolledBack.listLatest(scope, {
        platform: "instagram_reels",
        exportVariantIds: [exportVariantId],
      }),
    ).resolves.toEqual([durable]);
    await expect(rolledBack.request(scope, {
      idempotencyKey: "10000000-0000-4000-8000-000000000099",
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 6,
      title: "Blocked frame",
    })).rejects.toMatchObject({ code: "program_write_disabled" });
    await expect(rolledBack.retry(scope, durable.id)).rejects.toMatchObject({
      code: "program_write_disabled",
    });
  });

  test("hydrates only the latest durable job for each requested exact export", async () => {
    const store = createInMemoryThumbnailExtractionStore({
      variants: [{
        id: exportVariantId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        status: "completed",
        storageKey: "exports/immutable.mp4",
        durationSec: 28,
      }],
    });
    let timestamp = Date.parse("2026-08-31T10:00:00.000Z");
    let idSequence = 20;
    let readAuthorizations = 0;
    const service = createThumbnailExtractionService({
      store,
      authorize: async () => undefined,
      authorizeRead: async () => {
        readAuthorizations += 1;
      },
      processor: {
        async extract() {
          throw new Error("worker is not part of hydration");
        },
      },
      now: () => new Date(timestamp++),
      createId: () =>
        `10000000-0000-4000-8000-${String(idSequence++).padStart(12, "0")}`,
    });
    await service.request(scope, {
      idempotencyKey: "10000000-0000-4000-8000-000000000021",
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 1,
      title: "Opening frame",
    });
    const latest = await service.request(scope, {
      idempotencyKey: "10000000-0000-4000-8000-000000000022",
      platform: "instagram_reels",
      exportVariantId,
      sourceTimeSec: 2,
      title: "Updated frame",
    });

    await expect(
      service.listLatest(scope, {
        platform: "instagram_reels",
        exportVariantIds: [exportVariantId],
      }),
    ).resolves.toEqual([latest]);
    expect(readAuthorizations).toBe(1);
  });
});
