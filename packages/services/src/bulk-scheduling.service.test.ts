import { describe, expect, test } from "bun:test";

import {
  BulkScheduleReconciliationRequiredError,
  BulkScheduleItemError,
  createBulkSchedulingService,
  createInMemoryBulkSchedulingStore,
  type BulkPublicationScheduler,
} from "./bulk-scheduling.service";

const scope = {
  actorUserId: "30000000-0000-4000-8000-000000000001",
  ownerUserId: "30000000-0000-4000-8000-000000000002",
  workspaceId: "30000000-0000-4000-8000-000000000003",
  projectId: "30000000-0000-4000-8000-000000000004",
  approvalPrincipal: {
    kind: "browser" as const,
    actorUserId: "30000000-0000-4000-8000-000000000001",
  },
};
const clipA = "30000000-0000-4000-8000-000000000005";
const clipB = "30000000-0000-4000-8000-000000000006";
const accountA = "30000000-0000-4000-8000-000000000007";
const accountB = "30000000-0000-4000-8000-000000000008";
const copyA = "30000000-0000-4000-8000-000000000009";
const copyB = "30000000-0000-4000-8000-000000000010";
const exportA = "30000000-0000-4000-8000-000000000011";
const exportB = "30000000-0000-4000-8000-000000000012";
const itemA = "30000000-0000-4000-8000-000000000013";
const itemB = "30000000-0000-4000-8000-000000000014";
const accountC = "30000000-0000-4000-8000-000000000022";
const copyC = "30000000-0000-4000-8000-000000000023";

const baseInput = {
  idempotencyKey: "30000000-0000-4000-8000-000000000015",
  timezone: "America/New_York",
  startDate: "2026-09-01",
  postingWindow: { startTime: "09:00", endTime: "11:00", frequencyMinutes: 60 },
  items: [
    {
      itemKey: itemA,
      clipId: clipA,
      expectedEditorRevision: 2,
      exportVariantId: exportA,
      accountId: accountA,
      platform: "linkedin" as const,
      assistedCopyDraftId: copyA,
      assistedCopyRevision: 2,
      aspectRatio: "9:16" as const,
      resolution: "1080p" as const,
      durationSec: 30,
      occurrenceIndex: 0,
      thumbnailAssetId: null,
    },
    {
      itemKey: itemB,
      clipId: clipB,
      expectedEditorRevision: 4,
      exportVariantId: exportB,
      accountId: accountB,
      platform: "youtube_shorts" as const,
      assistedCopyDraftId: copyB,
      assistedCopyRevision: 2,
      aspectRatio: "9:16" as const,
      resolution: "1080p" as const,
      durationSec: 30,
      occurrenceIndex: 1,
      thumbnailAssetId: null,
    },
  ],
};

function fixture(
  scheduler?: BulkPublicationScheduler,
  accountBOverrides: {
    status?: "active" | "expired" | "revoked";
    expiresAt?: Date | null;
    refreshable?: boolean;
  } = {},
) {
  const store = createInMemoryBulkSchedulingStore({
    accounts: [
		{
			id: accountA,
			workspaceId: scope.workspaceId,
			platform: "linkedin",
			status: "active",
			expiresAt: null,
			refreshable: false,
		},
		{
			id: accountB,
			workspaceId: scope.workspaceId,
			platform: "youtube_shorts",
			status: "active",
			expiresAt: null,
			refreshable: false,
			...accountBOverrides,
		},
		{
			id: accountC,
			workspaceId: scope.workspaceId,
			platform: "instagram_reels",
			status: "active",
			expiresAt: null,
			refreshable: false,
		},
    ],
    copyDrafts: [
      {
        id: copyA,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        clipId: clipA,
        platform: "linkedin",
        status: "completed",
        revision: 2,
        confirmed: true,
        content: { caption: "A measured takeaway.", hashtags: ["recovery"], title: null },
      },
      {
        id: copyB,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        clipId: clipB,
        platform: "youtube_shorts",
        status: "completed",
        revision: 2,
        confirmed: true,
        content: { caption: "The full breakdown.", hashtags: [], title: "Recovery signals" },
      },
		{
			id: copyC,
			workspaceId: scope.workspaceId,
			projectId: scope.projectId,
			clipId: clipA,
			platform: "instagram_reels",
			status: "completed",
			revision: 2,
			confirmed: true,
			content: { caption: "A measured takeaway.", hashtags: ["recovery"], title: null },
		},
    ],
    thumbnailAssets: [],
  });
  const calls: unknown[] = [];
  const service = createBulkSchedulingService({
    store,
    authorize: async () => undefined,
    scheduler:
      scheduler ??
      {
        async schedule(input) {
          calls.push(input);
          return { postId: input.itemKey, status: "scheduled" };
        },
      },
    now: () => new Date("2026-08-31T10:00:00.000Z"),
  });
  return { store, service, calls };
}

describe("bulk campaign scheduling", () => {
  test("schedules valid items across the workspace-local posting window", async () => {
    const { service, calls } = fixture();
    const result = await service.schedule(scope, baseInput);

    expect(result.status).toBe("completed");
    expect(result.counts).toEqual({ scheduled: 2, failed: 0 });
    expect(result.items.map((item) => item.scheduledFor)).toEqual([
      "2026-09-01T13:00:00.000Z",
      "2026-09-01T14:00:00.000Z",
    ]);
    expect(calls).toHaveLength(2);
  });

  test("settles valid items when another account is expired", async () => {
    const { service, store } = fixture();
    store.expireAccount(accountB, new Date("2026-08-31T00:00:00.000Z"));

    const result = await service.schedule(scope, baseInput);
    expect(result.status).toBe("partial");
    expect(result.counts).toEqual({ scheduled: 1, failed: 1 });
    expect(result.items[1]).toMatchObject({ status: "failed", errorCode: "bulk_schedule_account_expired" });
  });

	test("schedules an active refreshable account when access expires before delivery", async () => {
		const { service, calls } = fixture(undefined, {
			expiresAt: new Date("2026-08-31T11:00:00.000Z"),
			refreshable: true,
		});

		const result = await service.schedule(scope, {
			...baseInput,
			items: [baseInput.items[1]],
		});

		expect(result.items[0]).toMatchObject({ status: "scheduled", errorCode: null });
		expect(calls).toHaveLength(1);
	});

	test("schedules an active refreshable account after access expires", async () => {
		const { service, calls } = fixture(undefined, {
			expiresAt: new Date("2026-08-31T09:00:00.000Z"),
			refreshable: true,
		});

		const result = await service.schedule(scope, {
			...baseInput,
			items: [baseInput.items[1]],
		});

		expect(result.items[0]).toMatchObject({ status: "scheduled", errorCode: null });
		expect(calls).toHaveLength(1);
	});

	test("rejects an active non-refreshable account after access expires", async () => {
		const { service, calls } = fixture(undefined, {
			expiresAt: new Date("2026-08-31T09:00:00.000Z"),
			refreshable: false,
		});

		const result = await service.schedule(scope, {
			...baseInput,
			items: [baseInput.items[1]],
		});

		expect(result.items[0]).toMatchObject({
			status: "failed",
			errorCode: "bulk_schedule_account_expired",
		});
		expect(calls).toHaveLength(0);
	});

	for (const status of ["expired", "revoked"] as const) {
		test(`rejects a refreshable account with ${status} status`, async () => {
			const { service, calls } = fixture(undefined, {
				status,
				expiresAt: new Date("2026-09-30T09:00:00.000Z"),
				refreshable: true,
			});

			const result = await service.schedule(scope, {
				...baseInput,
				items: [baseInput.items[1]],
			});

			expect(result.items[0]).toMatchObject({
				status: "failed",
				errorCode: "bulk_schedule_account_expired",
			});
			expect(calls).toHaveLength(0);
		});
	}

  test("keeps a failed item's original posting slot when it is retried alone", async () => {
    const first = fixture();
    first.store.expireAccount(accountB, new Date("2026-08-31T00:00:00.000Z"));

    const partial = await first.service.schedule(scope, baseInput);
    expect(partial.items[1]).toMatchObject({
      itemKey: itemB,
      status: "failed",
      scheduledFor: "2026-09-01T14:00:00.000Z",
    });

    const retry = fixture();
    const retried = await retry.service.schedule(scope, {
      ...baseInput,
      idempotencyKey: "30000000-0000-4000-8000-000000000029",
      items: [baseInput.items[1]],
    });

    expect(retried.items[0]).toMatchObject({
      itemKey: itemB,
      status: "scheduled",
      scheduledFor: "2026-09-01T14:00:00.000Z",
    });
  });

  test("requires an explicitly confirmed, exact assisted-copy revision", async () => {
    const { service, store } = fixture();
    store.unconfirmCopy(copyA);

    const result = await service.schedule(scope, { ...baseInput, items: [baseInput.items[0]] });
    expect(result.items[0]).toMatchObject({
      status: "failed",
      errorCode: "bulk_schedule_copy_unconfirmed",
    });
  });

  test("validates thumbnail provenance against provider capabilities and exact export", async () => {
    const thumbnailId = "30000000-0000-4000-8000-000000000016";
    const { service, store } = fixture();
    store.addThumbnail({
      id: thumbnailId,
      workspaceId: scope.workspaceId,
			kind: "image",
			contentType: "image/png",
			sizeBytes: 1_024,
			fingerprint: "e".repeat(64),
      provenance: "generated",
      sourceExportVariantId: null,
			sourceTimeMs: null,
      deletedAt: null,
    });

    const result = await service.schedule(scope, {
      ...baseInput,
      items: [{ ...baseInput.items[0], thumbnailAssetId: thumbnailId }],
    });
    expect(result.items[0]).toMatchObject({
      status: "failed",
      errorCode: "bulk_schedule_thumbnail_unsupported",
    });
  });

	test("rejects non-image Visual Assets at the service boundary", async () => {
		const thumbnailId = "30000000-0000-4000-8000-000000000019";
		const { service, store } = fixture();
		store.addThumbnail({
			id: thumbnailId,
			workspaceId: scope.workspaceId,
			kind: "video",
			contentType: "video/mp4",
			sizeBytes: 1_024,
			fingerprint: "f".repeat(64),
			provenance: "generated",
			sourceExportVariantId: null,
			sourceTimeMs: null,
			deletedAt: null,
		});

		const result = await service.schedule(scope, {
			...baseInput,
			idempotencyKey: "30000000-0000-4000-8000-000000000020",
			items: [{ ...baseInput.items[1], thumbnailAssetId: thumbnailId }],
		});

		expect(result.items[0]).toMatchObject({
			status: "failed",
			errorCode: "bulk_schedule_thumbnail_invalid",
		});
	});

	test("rejects a soft-deleted thumbnail before Social Post creation", async () => {
		const thumbnailId = "30000000-0000-4000-8000-000000000026";
		const { service, store, calls } = fixture();
		store.addThumbnail({
			id: thumbnailId,
			workspaceId: scope.workspaceId,
			kind: "image",
			contentType: "image/jpeg",
			sizeBytes: 1_024,
			fingerprint: "c".repeat(64),
			provenance: "generated",
			sourceExportVariantId: null,
			sourceTimeMs: null,
			deletedAt: new Date("2026-08-31T09:00:00.000Z"),
		});

		const result = await service.schedule(scope, {
			...baseInput,
			idempotencyKey: "30000000-0000-4000-8000-000000000027",
			items: [{ ...baseInput.items[1], thumbnailAssetId: thumbnailId }],
		});

		expect(result.items[0]).toMatchObject({
			status: "failed",
			errorCode: "bulk_schedule_thumbnail_missing",
		});
		expect(calls).toHaveLength(0);
	});

	test("rejects media outside the provider duration contract before scheduling", async () => {
		const { service, calls } = fixture();
		const result = await service.schedule(scope, {
			...baseInput,
			idempotencyKey: "30000000-0000-4000-8000-000000000021",
			items: [{ ...baseInput.items[1], durationSec: 180.01 }],
		});

		expect(result.items[0]).toMatchObject({
			status: "failed",
			errorCode: "bulk_schedule_media_unsupported",
		});
		expect(calls).toHaveLength(0);
	});

	test("freezes the selected thumbnail fingerprint and exact frame time", async () => {
		const thumbnailId = "30000000-0000-4000-8000-000000000024";
		const { service, store, calls } = fixture();
		store.addThumbnail({
			id: thumbnailId,
			workspaceId: scope.workspaceId,
			kind: "image",
			contentType: "image/jpeg",
			sizeBytes: 8_192,
			fingerprint: "d".repeat(64),
			provenance: "extracted",
			sourceExportVariantId: exportA,
			sourceTimeMs: 750,
			deletedAt: null,
		});

		const result = await service.schedule(scope, {
			...baseInput,
			idempotencyKey: "30000000-0000-4000-8000-000000000025",
			items: [{
				...baseInput.items[0],
				accountId: accountC,
				platform: "instagram_reels",
				assistedCopyDraftId: copyC,
				thumbnailAssetId: thumbnailId,
			}],
		});

		expect(result.counts).toEqual({ scheduled: 1, failed: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			providerSettings: {
				thumbnailType: "video_frame",
				thumbnailAssetId: thumbnailId,
				thumbnailFingerprint: "d".repeat(64),
				thumbnailSourceTimeMs: 750,
			},
		});
	});

	test("uses the provider first-frame default when exact extraction is not selected", async () => {
		const { service, calls } = fixture();
		const result = await service.schedule(scope, {
			...baseInput,
			idempotencyKey: "30000000-0000-4000-8000-000000000028",
			items: [{
				...baseInput.items[0],
				accountId: accountC,
				platform: "instagram_reels",
				assistedCopyDraftId: copyC,
				thumbnailAssetId: null,
			}],
		});

		expect(result.counts).toEqual({ scheduled: 1, failed: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ providerSettings: {} });
		expect(calls[0]).not.toHaveProperty("providerSettings.thumbnailType");
	});

  test("replays the durable result without duplicating Social Posts", async () => {
    const { service, calls } = fixture();
    const first = await service.schedule(scope, baseInput);
    const replay = await service.schedule(scope, baseInput);

    expect(replay).toEqual({ ...first, replayed: true });
    expect(calls).toHaveLength(2);
  });

  test("turns DST gaps and overlaps into per-item failures", async () => {
    const spring = fixture();
    const gap = await spring.service.schedule(scope, {
      ...baseInput,
      idempotencyKey: "30000000-0000-4000-8000-000000000017",
      startDate: "2026-03-08",
      postingWindow: { startTime: "02:30", endTime: "03:00", frequencyMinutes: 30 },
      items: [baseInput.items[0]],
    });
    expect(gap.items[0]).toMatchObject({ status: "failed", errorCode: "nonexistent_local_time" });

    const autumn = fixture();
    const overlap = await autumn.service.schedule(scope, {
      ...baseInput,
      idempotencyKey: "30000000-0000-4000-8000-000000000018",
      startDate: "2026-11-01",
      postingWindow: { startTime: "01:30", endTime: "02:00", frequencyMinutes: 30 },
      items: [baseInput.items[0]],
    });
    expect(overlap.items[0]).toMatchObject({ status: "failed", errorCode: "ambiguous_local_time" });
  });

  test("contains scheduler approval and rate-limit failures to their items", async () => {
    const { service } = fixture({
      async schedule(input) {
        if (input.itemKey === itemA) {
          throw new BulkScheduleItemError("review_approval_required", "Approval is required");
        }
        throw new BulkScheduleItemError("provider_rate_limited", "Provider rate limited");
      },
    });
    const result = await service.schedule(scope, baseInput);

    expect(result.status).toBe("failed");
    expect(result.items.map((item) => item.errorCode)).toEqual([
      "review_approval_required",
      "provider_rate_limited",
    ]);
  });

  test("does not durably settle an ambiguous child publication as failed", async () => {
    let calls = 0;
    const { service } = fixture({
      async schedule(input) {
        calls += 1;
        if (calls === 1) {
          throw new BulkScheduleReconciliationRequiredError();
        }
        return { postId: input.itemKey, status: "scheduled" };
      },
    });
    const oneItem = { ...baseInput, items: [baseInput.items[0]] };

    await expect(service.schedule(scope, oneItem)).rejects.toMatchObject({
      code: "bulk_schedule_publication_reconciliation_required",
    });
    await expect(service.schedule(scope, oneItem)).resolves.toMatchObject({
      status: "completed",
      counts: { scheduled: 1, failed: 0 },
      items: [{ status: "scheduled", postId: itemA }],
    });
    expect(calls).toBe(2);
  });

  test("schedules approved items when another exact export still needs approval", async () => {
    const { service } = fixture({
      async schedule(input) {
        if (input.itemKey === itemA) {
          throw new BulkScheduleItemError("review_approval_required", "Approval is required");
        }
        return { postId: input.itemKey, status: "scheduled" };
      },
    });

    const result = await service.schedule(scope, baseInput);
    expect(result).toMatchObject({
      status: "partial",
      counts: { scheduled: 1, failed: 1 },
      items: [
        { itemKey: itemA, status: "failed", errorCode: "review_approval_required" },
        { itemKey: itemB, status: "scheduled", postId: itemB, errorCode: null },
      ],
    });
  });
});
