import { describe, expect, test } from "bun:test";
import {
  ThumbnailPreparationError,
  createInMemoryThumbnailFrameStore,
  createThumbnailFramePreparation,
  validateThumbnailSelection,
  validateProviderThumbnailAsset,
} from "./thumbnail-frame-preparation";

const INPUT = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  clipId: "00000000-0000-4000-8000-000000000004",
  exportVariantId: "00000000-0000-4000-8000-000000000005",
  sourceTimeMs: 2_500,
  idempotencyKey: "00000000-0000-4000-8000-000000000006",
};

function harness(overrides: {
  resolveSource?: Parameters<typeof createThumbnailFramePreparation>[0]["resolveSource"];
  extract?: Parameters<typeof createThumbnailFramePreparation>[0]["extract"];
  publish?: Parameters<typeof createThumbnailFramePreparation>[0]["publish"];
} = {}) {
  let id = 100;
  const store = createInMemoryThumbnailFrameStore();
  const module = createThumbnailFramePreparation({
    store,
    authorize: async () => undefined,
    resolveSource: overrides.resolveSource ?? (async () => ({
      storageKey: "exports/approved.mp4",
      durationMs: 10_000,
      exportFingerprint: "a".repeat(64),
      width: 1080,
      height: 1920,
    })),
    extract: overrides.extract ?? (async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg" as const,
      width: 1080,
      height: 1920,
    })),
    publish: overrides.publish ?? (async ({ fingerprint }) => ({
      id: "00000000-0000-4000-8000-000000000099",
      fingerprint,
      deleted: false,
    })),
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    now: () => new Date("2026-09-02T10:00:00.000Z"),
  });
  return { module, store };
}

describe("thumbnail frame preparation", () => {
  test("queues once for the immutable export variant and source time", async () => {
    const { module } = harness();
    const first = await module.request(INPUT);
    const replay = await module.request({
      ...INPUT,
      idempotencyKey: "00000000-0000-4000-8000-000000000007",
    });

    expect(first.status).toBe("queued");
    expect(replay.id).toBe(first.id);
    expect(replay.replayed).toBe(true);
  });

  test("rejects missing source objects and frame times outside the export", async () => {
    const missing = harness({ resolveSource: async () => null }).module;
    await expect(missing.request(INPUT)).rejects.toMatchObject({
      code: "thumbnail_source_missing",
    });

    const invalid = harness().module;
    await expect(invalid.request({ ...INPUT, sourceTimeMs: 10_000 }))
      .rejects.toMatchObject({ code: "thumbnail_frame_time_invalid" });
  });

  test("retries a failed extraction without creating a second operation", async () => {
    let attempts = 0;
		const { module, store } = harness({
      extract: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("ffmpeg exited 1");
        return {
          bytes: new Uint8Array([4, 5, 6]),
          contentType: "image/jpeg",
          width: 1080,
          height: 1920,
        };
      },
    });
    const queued = await module.request(INPUT);

    await expect(module.process(queued.id)).rejects.toMatchObject({
      code: "thumbnail_extraction_failed",
    });
		expect(await store.requeue(queued.id)).toMatchObject({ status: "queued", errorCode: null });
    const completed = await module.process(queued.id);

    expect(completed).toMatchObject({ id: queued.id, status: "completed", attempt: 2 });
    expect(attempts).toBe(2);
  });

	test("prevents an expired worker from settling after a newer claim takes over", async () => {
		const { module, store } = harness();
		const queued = await module.request(INPUT);
		const firstClaim = await store.claim(
			queued.id,
			"00000000-0000-4000-8000-000000000080",
			new Date("2026-09-02T10:00:00.000Z"),
			1_000,
		);
		expect(firstClaim).not.toBeNull();
		const secondClaim = await store.claim(
			queued.id,
			"00000000-0000-4000-8000-000000000081",
			new Date("2026-09-02T10:00:02.000Z"),
			1_000,
		);
		expect(secondClaim?.claimId).toBe("00000000-0000-4000-8000-000000000081");
		await expect(store.settle(
			queued.id,
			"00000000-0000-4000-8000-000000000080",
			{ status: "failed", errorCode: "stale_worker" },
		)).rejects.toMatchObject({ code: "thumbnail_claim_lost" });
		await expect(store.settle(
			queued.id,
			"00000000-0000-4000-8000-000000000081",
			{ status: "completed", claimId: null, claimExpiresAt: null },
		)).resolves.toMatchObject({ status: "completed" });
	});

  test("refuses to extract when the frozen export identity changes", async () => {
    let reads = 0;
    const { module } = harness({
      resolveSource: async () => {
        reads += 1;
        return {
          storageKey: "exports/approved.mp4",
          durationMs: 10_000,
          exportFingerprint: (reads === 1 ? "a" : "b").repeat(64),
          width: 1080,
          height: 1920,
        };
      },
    });
    const queued = await module.request(INPUT);

    await expect(module.process(queued.id)).rejects.toMatchObject({
      code: "thumbnail_export_changed",
    });
  });

  test("reports a deleted durable asset instead of returning a broken reference", async () => {
    let deleted = false;
    const { module } = harness({
      publish: async ({ fingerprint }) => ({
        id: "00000000-0000-4000-8000-000000000099",
        fingerprint,
        get deleted() {
          return deleted;
        },
      }),
    });
    const queued = await module.request(INPUT);
    const completed = await module.process(queued.id);
    expect(completed.asset?.id).toBe("00000000-0000-4000-8000-000000000099");

    deleted = true;
    await expect(module.get(INPUT.workspaceId, INPUT.projectId, queued.id)).rejects.toMatchObject({
      code: "thumbnail_asset_deleted",
    });
  });

  test("rejects unsupported thumbnail sources at the shared capability boundary", () => {
    expect(() => validateThumbnailSelection({
      platform: "x",
      selection: {
        assetId: "00000000-0000-4000-8000-000000000099",
        fingerprint: "b".repeat(64),
        source: "uploaded",
        sourceTimeMs: null,
      },
    })).toThrow(ThumbnailPreparationError);

    expect(validateThumbnailSelection({
      platform: "youtube_shorts",
      selection: {
        assetId: "00000000-0000-4000-8000-000000000099",
        fingerprint: "b".repeat(64),
        source: "generated",
        sourceTimeMs: null,
      },
    })).toMatchObject({ thumbnailType: "custom_image" });
    expect(validateThumbnailSelection({
      platform: "tiktok",
      selection: {
        assetId: "00000000-0000-4000-8000-000000000099",
        fingerprint: "b".repeat(64),
        source: "extracted_frame",
        sourceTimeMs: 2_500,
      },
    })).toMatchObject({ thumbnailType: "video_frame", videoCoverTimestampMs: 2_500 });
  });

  test("rejects YouTube thumbnail files that its API cannot accept", () => {
    expect(() => validateProviderThumbnailAsset({
      platform: "youtube_shorts",
      contentType: "image/webp",
      sizeBytes: 100n,
    })).toThrow(expect.objectContaining({ code: "thumbnail_provider_constraint" }));
    expect(() => validateProviderThumbnailAsset({
      platform: "youtube_shorts",
      contentType: "image/png",
      sizeBytes: 2_000_001n,
    })).toThrow(expect.objectContaining({ code: "thumbnail_provider_constraint" }));
    expect(() => validateProviderThumbnailAsset({
      platform: "youtube_shorts",
      contentType: "image/jpeg",
      sizeBytes: 2_000_000n,
    })).not.toThrow();
  });
});
