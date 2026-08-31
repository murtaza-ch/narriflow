import { describe, expect, test } from "bun:test";
import {
  buildPublishingSelection,
  campaignScheduleIdempotencyKey,
  mergePublishingBulkScheduleResult,
  publishingBulkItemLabel,
  releaseCampaignScheduleIdempotencyKey,
  resolvePublishingExport,
	thumbnailAssetEligibleForPlatform,
  thumbnailControlForPlatform,
} from "./publishing-preparation-model";

const clips = [
  { id: "clip-a", editorRevision: 4, index: 1 },
  { id: "clip-b", editorRevision: 2, index: 2 },
  { id: "clip-c", editorRevision: 7, index: 3 },
];

describe("publishing preparation model", () => {
  test("keeps the persisted campaign order and excludes stale clip ids", () => {
    expect(buildPublishingSelection(clips, new Set(["clip-c", "missing", "clip-a"]))).toEqual([
      clips[0],
      clips[2],
    ]);
  });

  test("requires the exact current editor revision and maps frozen DB ratios", () => {
    expect(
      resolvePublishingExport({
        clip: clips[0]!,
        platform: "tiktok",
        candidates: [
          {
            id: "export-a",
            clipId: "clip-a",
            editorRevision: 4,
            variants: [
              {
                id: "variant-a",
                aspectRatio: "ratio_9_16",
                resolution: "1080p",
                durationSec: 31,
                status: "completed",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      kind: "ready",
      exportId: "export-a",
      exportVariantId: "variant-a",
      aspectRatio: "9:16",
      resolution: "1080p",
      durationSec: 31,
    });

    expect(
      resolvePublishingExport({
        clip: clips[0]!,
        platform: "tiktok",
        candidates: [
          {
            id: "export-old",
            clipId: "clip-a",
            editorRevision: 3,
            variants: [],
          },
        ],
      }),
    ).toEqual({ kind: "attention", code: "export_revision_stale" });
  });

  test("uses the provider matrix for exact aspect-ratio eligibility", () => {
    expect(
      resolvePublishingExport({
        clip: clips[1]!,
        platform: "facebook_reels",
        candidates: [
          {
            id: "export-b",
            clipId: "clip-b",
            editorRevision: 2,
            variants: [
              {
                id: "variant-square",
                aspectRatio: "ratio_1_1",
                resolution: "720p",
                durationSec: 20,
                status: "completed",
              },
            ],
          },
        ],
      }),
    ).toEqual({ kind: "attention", code: "export_variant_unsupported" });

		expect(
			resolvePublishingExport({
				clip: clips[1]!,
				platform: "facebook_reels",
				candidates: [{
					id: "export-too-long",
					clipId: "clip-b",
					editorRevision: 2,
					variants: [{
						id: "variant-too-long",
						aspectRatio: "ratio_9_16",
						resolution: "1080p",
						durationSec: 61,
						status: "completed",
					}],
				}],
			}),
		).toEqual({ kind: "attention", code: "export_variant_unsupported" });
  });

  test("renders only thumbnail controls the provider actually supports", () => {
    expect(thumbnailControlForPlatform("youtube_shorts")).toBe("custom_image");
    expect(thumbnailControlForPlatform("instagram_reels")).toBe("video_frame");
		expect(thumbnailControlForPlatform("facebook_reels")).toBeNull();
    expect(thumbnailControlForPlatform("linkedin")).toBeNull();
    expect(thumbnailControlForPlatform("x")).toBeNull();
  });

	test("filters custom-image choices through the shared provider object contract", () => {
		expect(thumbnailAssetEligibleForPlatform("youtube_shorts", {
			kind: "image",
			contentType: "image/png",
			sizeBytes: 2 * 1024 * 1024,
		})).toBe(true);
		expect(thumbnailAssetEligibleForPlatform("youtube_shorts", {
			kind: "image",
			contentType: "image/webp",
			sizeBytes: 100,
		})).toBe(false);
		expect(thumbnailAssetEligibleForPlatform("youtube_shorts", {
			kind: "video",
			contentType: "video/mp4",
			sizeBytes: 100,
		})).toBe(false);
	});

  test("reuses a bulk intent key until the exact frozen request changes", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    let sequence = 0;
    const createId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    const intent = { itemIds: ["clip-a"], startDate: "2026-09-01" };

    expect(campaignScheduleIdempotencyKey(storage, "project-a", intent, createId)).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(campaignScheduleIdempotencyKey(storage, "project-a", intent, createId)).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(
      campaignScheduleIdempotencyKey(
        storage,
        "project-a",
        { ...intent, startDate: "2026-09-02" },
        createId,
      ),
    ).toBe("00000000-0000-4000-8000-000000000002");

    releaseCampaignScheduleIdempotencyKey(storage, "project-a");
    expect(
      campaignScheduleIdempotencyKey(
        storage,
        "project-a",
        { ...intent, startDate: "2026-09-02" },
        createId,
      ),
    ).toBe("00000000-0000-4000-8000-000000000003");
  });

  test("retries only failed rows and keeps the known successful outcomes", () => {
    const initial = {
      operationId: "operation-1",
      status: "partial" as const,
      counts: { scheduled: 1, failed: 1 },
      items: [
        {
          itemKey: "clip-a",
          clipId: "clip-a",
          accountId: "account-a",
          status: "scheduled" as const,
          postId: "post-a",
          scheduledFor: "2026-09-01T09:00:00.000Z",
          errorCode: null,
        },
        {
          itemKey: "clip-b",
          clipId: "clip-b",
          accountId: "account-b",
          status: "failed" as const,
          postId: null,
          scheduledFor: null,
          errorCode: "bulk_schedule_account_expired",
        },
      ],
      replayed: false,
    };
    const retry = {
      operationId: "operation-2",
      status: "completed" as const,
      counts: { scheduled: 1, failed: 0 },
      items: [
        {
          itemKey: "clip-b",
          clipId: "clip-b",
          accountId: "account-b",
          status: "scheduled" as const,
          postId: "post-b",
          scheduledFor: "2026-09-01T11:00:00.000Z",
          errorCode: null,
        },
      ],
      replayed: false,
    };

    expect(mergePublishingBulkScheduleResult(initial, retry)).toMatchObject({
      operationId: "operation-2",
      status: "completed",
      counts: { scheduled: 2, failed: 0 },
      items: [
        { itemKey: "clip-a", status: "scheduled" },
        { itemKey: "clip-b", status: "scheduled" },
      ],
    });
    expect(
      publishingBulkItemLabel("failed", "bulk_schedule_account_expired"),
    ).toBe("Reconnect account");
    expect(publishingBulkItemLabel("scheduled", null)).toBe("Scheduled");
  });
});
