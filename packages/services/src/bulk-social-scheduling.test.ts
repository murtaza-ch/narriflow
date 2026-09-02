import { describe, expect, test } from "bun:test";
import {
  BulkSocialSchedulingError,
  createBulkSocialScheduling,
  createInMemoryBulkScheduleStore,
  resolveWorkspaceLocalDateTime,
} from "./bulk-social-scheduling";

const CLIP_A = "00000000-0000-4000-8000-000000000001";
const CLIP_B = "00000000-0000-4000-8000-000000000002";
const ACCOUNT = "00000000-0000-4000-8000-000000000003";
const EXPORT_A = "00000000-0000-4000-8000-000000000020";
const VARIANT_A = "00000000-0000-4000-8000-000000000021";
const EXPORT_B = "00000000-0000-4000-8000-000000000022";
const VARIANT_B = "00000000-0000-4000-8000-000000000023";

function copy(caption: string) {
  return {
    variantId: "00000000-0000-4000-8000-000000000004",
    caption,
    hashtags: ["#Narriflow"],
    title: "Publish with precision",
  };
}

const INPUT = {
  actorUserId: "00000000-0000-4000-8000-000000000010",
  workspaceId: "00000000-0000-4000-8000-000000000011",
  projectId: "00000000-0000-4000-8000-000000000012",
  idempotencyKey: "00000000-0000-4000-8000-000000000013",
  accounts: [{ accountId: ACCOUNT, platform: "youtube_shorts" as const }],
  clips: [
    {
      clipId: CLIP_A,
      expectedEditorRevision: 4,
		exportId: EXPORT_A,
		exportVariantId: VARIANT_A,
      aspectRatio: "9:16" as const,
      resolution: "1080p" as const,
      copyByPlatform: { youtube_shorts: copy("First clip") },
      thumbnailByPlatform: {},
    },
    {
      clipId: CLIP_B,
      expectedEditorRevision: 7,
		exportId: EXPORT_B,
		exportVariantId: VARIANT_B,
      aspectRatio: "9:16" as const,
      resolution: "1080p" as const,
      copyByPlatform: { youtube_shorts: copy("Second clip") },
      thumbnailByPlatform: {},
    },
  ],
  startDate: "2026-09-03",
  timeZone: "Asia/Karachi",
  postingWindow: { start: "09:00", end: "17:00" },
  frequency: { unit: "hours" as const, value: 2 },
  dstDisambiguation: null,
};

function harness(
  schedule: Parameters<typeof createBulkSocialScheduling>[0]["schedule"] = async (item) => ({
    socialPostId: item.clientIdempotencyKey,
    status: "scheduled" as const,
  }),
) {
  let id = 100;
  const store = createInMemoryBulkScheduleStore();
  return {
    store,
    module: createBulkSocialScheduling({
      store,
		authorize: async () => ({ pricingTier: "pro", timeZone: INPUT.timeZone }),
      schedule,
      createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      now: () => new Date("2026-09-02T10:00:00.000Z"),
    }),
  };
}

describe("workspace-local schedule resolution", () => {
  test("returns explicit guidance for daylight-saving gaps and overlaps", () => {
    expect(() => resolveWorkspaceLocalDateTime({
      date: "2026-03-08",
      time: "02:30",
      timeZone: "America/New_York",
      disambiguation: null,
    })).toThrow(expect.objectContaining({ code: "schedule_local_time_nonexistent" }));

    expect(() => resolveWorkspaceLocalDateTime({
      date: "2026-11-01",
      time: "01:30",
      timeZone: "America/New_York",
      disambiguation: null,
    })).toThrow(expect.objectContaining({ code: "schedule_local_time_ambiguous" }));

    const earlier = resolveWorkspaceLocalDateTime({
      date: "2026-11-01",
      time: "01:30",
      timeZone: "America/New_York",
      disambiguation: "earlier",
    });
    const later = resolveWorkspaceLocalDateTime({
      date: "2026-11-01",
      time: "01:30",
      timeZone: "America/New_York",
      disambiguation: "later",
    });
    expect(later.getTime() - earlier.getTime()).toBe(60 * 60_000);
  });
});

describe("bulk social scheduling", () => {
	test("rejects settlement by a worker that does not hold the item claim", async () => {
		const store = createInMemoryBulkScheduleStore();
		const opened = await store.open({
			workspaceId: INPUT.workspaceId,
			projectId: INPUT.projectId,
			idempotencyKey: INPUT.idempotencyKey,
			requestFingerprint: "fingerprint",
			actorUserId: INPUT.actorUserId,
			pricingTier: "pro",
			validatedOptions: {},
			create: () => ({
				id: "00000000-0000-4000-8000-000000000099",
				workspaceId: INPUT.workspaceId,
				projectId: INPUT.projectId,
				idempotencyKey: INPUT.idempotencyKey,
				requestFingerprint: "fingerprint",
				status: "running",
				items: [{
					id: "00000000-0000-4000-8000-000000000098",
					requestKey: "request",
					clipId: CLIP_A,
					expectedEditorRevision: 4,
					accountId: ACCOUNT,
					platform: "youtube_shorts",
					scheduledFor: new Date("2026-09-03T04:00:00.000Z"),
					status: "pending",
					errorCode: null,
					retryable: false,
					socialPostId: null,
				}],
				createdAt: new Date("2026-09-02T10:00:00.000Z"),
				completedAt: null,
			}),
		});
		const claim = await store.claimItem(opened.operation.id, "request");
		expect(claim).not.toBeNull();
		await expect(store.settleItem(
			opened.operation.id,
			"request",
			"00000000-0000-4000-8000-000000000097",
			{ status: "succeeded", errorCode: null, retryable: false, socialPostId: "post" },
		)).rejects.toMatchObject({ code: "campaign_schedule_claim_lost" });
	});

  test("creates one item per clip, account, and scheduled occurrence", async () => {
		const seen: Array<{
			clipId: string;
			clipExportId: string;
			clipExportVariantId: string;
			scheduledFor: Date;
		}> = [];
    const { module } = harness(async (item) => {
			seen.push({
				clipId: item.clipId,
				clipExportId: item.clipExportId,
				clipExportVariantId: item.clipExportVariantId,
				scheduledFor: item.scheduledFor,
			});
      return { socialPostId: item.clientIdempotencyKey, status: "scheduled" };
    });

    const result = await module.schedule(INPUT);

    expect(result.status).toBe("completed");
    expect(result.counts).toEqual({ succeeded: 2, ineligible: 0, failed: 0 });
    expect(seen.map((item) => item.scheduledFor.toISOString())).toEqual([
      "2026-09-03T04:00:00.000Z",
      "2026-09-03T06:00:00.000Z",
    ]);
		expect(seen.map(({ clipExportId, clipExportVariantId }) => ({ clipExportId, clipExportVariantId }))).toEqual([
			{ clipExportId: EXPORT_A, clipExportVariantId: VARIANT_A },
			{ clipExportId: EXPORT_B, clipExportVariantId: VARIANT_B },
		]);
  });

  test("rejects a client timezone that differs from the workspace", async () => {
    const { module } = harness();
    await expect(module.schedule({ ...INPUT, timeZone: "UTC" })).rejects.toMatchObject({
      code: "schedule_timezone_mismatch",
    });
  });

  test("schedules valid items when approval, account, or rate-limit checks fail", async () => {
    const { module } = harness(async (item) => {
      if (item.clipId === CLIP_A) {
        throw new BulkSocialSchedulingError("review_approval_required", "Approval required", false);
      }
      return { socialPostId: item.clientIdempotencyKey, status: "scheduled" };
    });

    const result = await module.schedule(INPUT);

    expect(result.status).toBe("partial");
    expect(result.counts).toEqual({ succeeded: 1, ineligible: 1, failed: 0 });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ clipId: CLIP_A, status: "ineligible", errorCode: "review_approval_required" }),
      expect.objectContaining({ clipId: CLIP_B, status: "succeeded" }),
    ]));
  });

  test.each([
    ["social_account_expired", false, "ineligible"],
    ["publication_provider_rate_limited", true, "failed"],
  ] as const)("classifies %s per item", async (code, retryable, expectedStatus) => {
    const { module } = harness(async () => {
      throw new BulkSocialSchedulingError(code, code, retryable);
    });
    const result = await module.schedule({ ...INPUT, clips: [INPUT.clips[0]!] });
    expect(result.items[0]).toMatchObject({ status: expectedStatus, errorCode: code, retryable });
  });

  test("replays duplicate submissions without creating duplicate Social Posts", async () => {
    let calls = 0;
    const { module } = harness(async (item) => {
      calls += 1;
      return { socialPostId: item.clientIdempotencyKey, status: "scheduled" };
    });

    const first = await module.schedule(INPUT);
    const replay = await module.schedule(INPUT);

    expect(replay.id).toBe(first.id);
    expect(replay.replayed).toBe(true);
    expect(calls).toBe(2);
    await expect(module.schedule({ ...INPUT, startDate: "2026-09-04" }))
      .rejects.toMatchObject({ code: "campaign_schedule_idempotency_conflict" });
  });

  test("uses stable child idempotency keys when a partial campaign is retried", async () => {
    const attempts = new Map<string, number>();
    const createdPosts = new Map<string, string>();
    const { module } = harness(async (item) => {
      const attempt = (attempts.get(item.clientIdempotencyKey) ?? 0) + 1;
      attempts.set(item.clientIdempotencyKey, attempt);
      if (item.clipId === CLIP_B && attempt === 1) {
        throw new BulkSocialSchedulingError(
          "publication_provider_rate_limited",
          "Rate limited",
          true,
        );
      }
      const socialPostId = createdPosts.get(item.clientIdempotencyKey) ?? item.clientIdempotencyKey;
      createdPosts.set(item.clientIdempotencyKey, socialPostId);
      return { socialPostId, status: "scheduled" };
    });

    const first = await module.schedule(INPUT);
    const retry = await module.schedule({
      ...INPUT,
      idempotencyKey: "00000000-0000-4000-8000-000000000014",
    });

    expect(first.counts).toEqual({ succeeded: 1, ineligible: 0, failed: 1 });
    expect(retry.counts).toEqual({ succeeded: 2, ineligible: 0, failed: 0 });
    expect(createdPosts).toHaveLength(2);
    expect([...attempts.values()].sort()).toEqual([2, 2]);
  });
});
