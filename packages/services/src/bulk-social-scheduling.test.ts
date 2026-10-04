import { describe, expect, test } from "bun:test";
import {
	BulkSocialSchedulingError,
	createBulkSocialScheduling,
	createInMemoryBulkScheduleStore,
	resolveWorkspaceLocalDateTime,
} from "./bulk-social-scheduling";
import {
	createInMemoryPublicationSchedulingStore,
	createSocialPublicationScheduling,
	type PublicationFreezePorts,
	type SchedulePublicationInput,
} from "./social-publication-scheduling";

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
	scheduleMode: "spread" as const,
	items: [
		{
			accountId: ACCOUNT,
			platform: "youtube_shorts" as const,
			deliveryMode: "direct" as const,
			providerSettings: {},
			thumbnail: null,
			clipId: CLIP_A,
			expectedEditorRevision: 4,
			exportId: EXPORT_A,
			exportVariantId: VARIANT_A,
			aspectRatio: "9:16" as const,
			resolution: "1080p" as const,
			copy: copy("First clip"),
		},
		{
			accountId: ACCOUNT,
			platform: "youtube_shorts" as const,
			deliveryMode: "direct" as const,
			providerSettings: {},
			thumbnail: null,
			clipId: CLIP_B,
			expectedEditorRevision: 7,
			exportId: EXPORT_B,
			exportVariantId: VARIANT_B,
			aspectRatio: "9:16" as const,
			resolution: "1080p" as const,
			copy: copy("Second clip"),
		},
	],
	startDate: "2026-09-03",
	timeZone: "Asia/Karachi",
	postingWindow: { start: "09:00", end: "17:00" },
	frequency: { unit: "hours" as const, value: 2 },
	dstDisambiguation: null,
};

const ACTOR = {
	actorUserId: INPUT.actorUserId,
	workspaceId: INPUT.workspaceId,
	workspaceOwnerUserId: INPUT.actorUserId,
	role: "owner" as const,
	status: "active" as const,
	pricingTier: "pro" as const,
	isPersonalWorkspace: false,
};

function harness(
	schedule: Parameters<
		typeof createBulkSocialScheduling
	>[0]["schedule"] = async (item) => ({
		id: item.clientIdempotencyKey,
	}),
) {
	let id = 100;
	const store = createInMemoryBulkScheduleStore();
	return {
		store,
		module: createBulkSocialScheduling({
			store,
			authorize: async () => ({ actor: ACTOR, timeZone: INPUT.timeZone }),
			schedule,
			createId: () =>
				`00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
			now: () => new Date("2026-09-02T10:00:00.000Z"),
		}),
	};
}

describe("workspace-local schedule resolution", () => {
	test("returns explicit guidance for daylight-saving gaps and overlaps", () => {
		expect(() =>
			resolveWorkspaceLocalDateTime({
				date: "2026-03-08",
				time: "02:30",
				timeZone: "America/New_York",
				disambiguation: null,
			}),
		).toThrow(
			expect.objectContaining({ code: "schedule_local_time_nonexistent" }),
		);

		expect(() =>
			resolveWorkspaceLocalDateTime({
				date: "2026-11-01",
				time: "01:30",
				timeZone: "America/New_York",
				disambiguation: null,
			}),
		).toThrow(
			expect.objectContaining({ code: "schedule_local_time_ambiguous" }),
		);

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
				items: [
					{
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
					},
				],
				createdAt: new Date("2026-09-02T10:00:00.000Z"),
				completedAt: null,
			}),
		});
		const claim = await store.claimItem(opened.operation.id, "request");
		expect(claim).not.toBeNull();
		await expect(
			store.settleItem(
				opened.operation.id,
				"request",
				"00000000-0000-4000-8000-000000000097",
				{
					status: "succeeded",
					errorCode: null,
					retryable: false,
					socialPostId: "post",
				},
			),
		).rejects.toMatchObject({ code: "campaign_schedule_claim_lost" });
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
			return { id: item.clientIdempotencyKey };
		});

		const result = await module.schedule(INPUT);

		expect(result.status).toBe("completed");
		expect(result.counts).toEqual({ succeeded: 2, ineligible: 0, failed: 0 });
		expect(seen.map((item) => item.scheduledFor.toISOString())).toEqual([
			"2026-09-03T04:00:00.000Z",
			"2026-09-03T06:00:00.000Z",
		]);
		expect(
			seen.map(({ clipExportId, clipExportVariantId }) => ({
				clipExportId,
				clipExportVariantId,
			})),
		).toEqual([
			{ clipExportId: EXPORT_A, clipExportVariantId: VARIANT_A },
			{ clipExportId: EXPORT_B, clipExportVariantId: VARIANT_B },
		]);
	});

	test("rejects a client timezone that differs from the workspace", async () => {
		const { module } = harness();
		await expect(
			module.schedule({ ...INPUT, timeZone: "UTC" }),
		).rejects.toMatchObject({
			code: "schedule_timezone_mismatch",
		});
	});

	test("passes the approved actor and exact copy, delivery, and thumbnail inputs to admission", async () => {
		const requests: SchedulePublicationInput[] = [];
		const actors: unknown[] = [];
		const { module } = harness(async (input, options) => {
			requests.push(input);
			actors.push(options.actor);
			return { id: "post" };
		});
		const thumbnail = { assetId: "00000000-0000-4000-8000-000000000055", fingerprint: "thumbnail-hash", source: "uploaded" as const, sourceTimeMs: null };
		await module.schedule({ ...INPUT, items: [{ ...INPUT.items[0]!, thumbnail }] });
		expect(actors).toEqual([ACTOR]);
		expect(requests[0]).toMatchObject({
			actorUserId: INPUT.actorUserId,
			workspaceId: INPUT.workspaceId, projectId: INPUT.projectId,
			clipId: CLIP_A, expectedEditorRevision: 4,
			clipExportId: EXPORT_A, clipExportVariantId: VARIANT_A,
			caption: "First clip\n\n#Narriflow", deliveryMode: "direct",
			assistedCopyVariantId: INPUT.items[0]!.copy.variantId, thumbnail,
			providerSettings: { title: "Publish with precision" },
		});
	});

	test("concurrent bulk submissions admit each item once and converge to one operation", async () => {
		const admitted: string[] = [];
		const { module } = harness(async (input) => {
			admitted.push(input.clientIdempotencyKey);
			await Promise.resolve();
			return { id: input.clientIdempotencyKey };
		});
		const [first, concurrent] = await Promise.all([module.schedule(INPUT), module.schedule(INPUT)]);
		const replay = await module.schedule(INPUT);
		expect(first.id).toBe(concurrent.id);
		expect(replay.id).toBe(first.id);
		expect(replay.status).toBe("completed");
		expect(replay.counts).toEqual({ succeeded: 2, ineligible: 0, failed: 0 });
		expect(admitted).toHaveLength(2);
		expect(new Set(admitted).size).toBe(2);
	});

	test("conflicts on changed delivery, copy provenance, or thumbnail before calling admission", async () => {
		let calls = 0;
		const { module } = harness(async () => { calls += 1; return { id: "post" }; });
		const item = INPUT.items[0]!;
		await module.schedule({ ...INPUT, items: [item] });
		for (const changed of [
			{ ...item, deliveryMode: "tiktok_inbox" as const },
			{ ...item, copy: { ...item.copy, variantId: "00000000-0000-4000-8000-000000000054" } },
			{ ...item, thumbnail: { assetId: "00000000-0000-4000-8000-000000000055", fingerprint: "new-hash", source: "uploaded" as const, sourceTimeMs: null } },
		]) {
			await expect(module.schedule({ ...INPUT, items: [changed] })).rejects.toMatchObject({ code: "campaign_schedule_idempotency_conflict" });
		}
		expect(calls).toBe(1);
	});

	test("schedules valid items when approval, account, or rate-limit checks fail", async () => {
		const { module } = harness(async (item) => {
			if (item.clipId === CLIP_A) {
				throw new BulkSocialSchedulingError(
					"review_approval_required",
					"Approval required",
					false,
				);
			}
			return { id: item.clientIdempotencyKey };
		});

		const result = await module.schedule(INPUT);

		expect(result.status).toBe("partial");
		expect(result.counts).toEqual({ succeeded: 1, ineligible: 1, failed: 0 });
		expect(result.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					clipId: CLIP_A,
					status: "ineligible",
					errorCode: "review_approval_required",
				}),
				expect.objectContaining({ clipId: CLIP_B, status: "succeeded" }),
			]),
		);
	});

	test.each([
		["social_account_expired", false, "ineligible"],
		["publication_provider_rate_limited", true, "failed"],
	] as const)("classifies %s per item", async (code, retryable, expectedStatus) => {
		const { module } = harness(async () => {
			throw new BulkSocialSchedulingError(code, code, retryable);
		});
		const result = await module.schedule({
			...INPUT,
			items: [INPUT.items[0]!],
		});
		expect(result.items[0]).toMatchObject({
			status: expectedStatus,
			errorCode: code,
			retryable,
		});
	});

	test("replays duplicate submissions without creating duplicate Social Posts", async () => {
		let calls = 0;
		const { module } = harness(async (item) => {
			calls += 1;
			return { id: item.clientIdempotencyKey };
		});

		const first = await module.schedule(INPUT);
		const replay = await module.schedule(INPUT);

		expect(replay.id).toBe(first.id);
		expect(replay.replayed).toBe(true);
		expect(calls).toBe(2);
		await expect(
			module.schedule({ ...INPUT, startDate: "2026-09-04" }),
		).rejects.toMatchObject({ code: "campaign_schedule_idempotency_conflict" });
	});

	test("recovers a committed Social Post when Campaign Operation settlement is interrupted", async () => {
		const backingStore = createInMemoryBulkScheduleStore();
		let interruptSettlement = true;
		const store = {
			...backingStore,
			async settleItem(...args: Parameters<typeof backingStore.settleItem>) {
				if (interruptSettlement) {
					interruptSettlement = false;
					throw new Error("settlement connection lost after admission");
				}
				return backingStore.settleItem(...args);
			},
		};
		const admitted = new Map<string, string>();
		const module = createBulkSocialScheduling({
			store,
			authorize: async () => ({ actor: ACTOR, timeZone: INPUT.timeZone }),
			schedule: async (item) => {
				const existing = admitted.get(item.clientIdempotencyKey);
				const socialPostId = existing ?? `post-${admitted.size + 1}`;
				admitted.set(item.clientIdempotencyKey, socialPostId);
				return { id: socialPostId };
			},
			createId: () => crypto.randomUUID(),
			now: () => new Date("2026-09-02T10:00:00.000Z"),
		});

		const first = await module.schedule({ ...INPUT, items: [INPUT.items[0]! ] });
		const replay = await module.schedule({ ...INPUT, items: [INPUT.items[0]! ] });
		const corrected = await module.schedule({
			...INPUT,
			idempotencyKey: "00000000-0000-4000-8000-000000000014",
			items: [INPUT.items[0]!],
		});

		expect(first.items[0]).toMatchObject({ status: "succeeded", socialPostId: "post-1" });
		expect(replay.items[0]).toMatchObject({ status: "succeeded", socialPostId: "post-1" });
		expect(corrected.items[0]).toMatchObject({ status: "succeeded", socialPostId: "post-2" });
		expect(admitted.size).toBe(2);
	});

	test("recovers a committed Social Post when admission loses its result", async () => {
		const admitted = new Map<string, string>();
		let loseResult = true;
		const { module } = harness(async (item) => {
			const socialPostId = admitted.get(item.clientIdempotencyKey) ?? "post-1";
			admitted.set(item.clientIdempotencyKey, socialPostId);
			if (loseResult) {
				loseResult = false;
				throw new Error("connection lost after Social Post commit");
			}
			return { id: socialPostId };
		});

		const first = await module.schedule({ ...INPUT, items: [INPUT.items[0]!] });
		const replay = await module.schedule({ ...INPUT, items: [INPUT.items[0]!] });

		expect(first.items[0]).toMatchObject({ status: "succeeded", socialPostId: "post-1" });
		expect(replay.items[0]).toMatchObject({ status: "succeeded", socialPostId: "post-1" });
		expect(admitted.size).toBe(1);
	});

	test("replays committed intent before changed facts and timezone can reject it", async () => {
		const posts = new Map<string, string>();
		let timeZone = INPUT.timeZone;
		let now = new Date("2026-09-02T10:00:00Z");
		let mutableChecks = 0;
		let eligible = true;
		const module = createBulkSocialScheduling({
			store: createInMemoryBulkScheduleStore(() => now),
			authorize: async () => ({ actor: ACTOR, timeZone }),
			schedule: async ({ clientIdempotencyKey }) => {
				const existing = posts.get(clientIdempotencyKey);
				if (existing) return { id: existing };
				mutableChecks += 1;
				if (!eligible) throw new BulkSocialSchedulingError("social_account_expired");
				posts.set(clientIdempotencyKey, "committed-post");
				eligible = false;
				throw new Error("result read unavailable");
			},
			createId: () => crypto.randomUUID(), now: () => now,
		});
		const input = { ...INPUT, items: [INPUT.items[0]!] };
		const first = await module.schedule(input);
		expect(first.items[0]?.socialPostId).toBe("committed-post");
		timeZone = "UTC";
		now = new Date("2027-01-01T00:00:00Z");
		const replay = await module.schedule(input);
		expect(replay).toMatchObject({ id: first.id, status: "completed", replayed: true });
		expect(posts.size).toBe(1);
		expect(mutableChecks).toBe(1);
	});

	test.each(["publishing", "processing", "reconciling", "posted", "failed", "inbox_delivered", "cancelled"] as const)(
		"recovers %s admission after interrupted Campaign settlement without reopening eligibility",
		async (status) => {
			let now = new Date("2026-09-02T10:00:00Z");
			let settlementAvailable = false;
			let mutableChecks = 0;
			const posts = new Map<string, { id: string; status: string }>();
			const backingStore = createInMemoryBulkScheduleStore(() => now);
			const scheduleCalls: SchedulePublicationInput[] = [];
			const module = createBulkSocialScheduling({
				store: {
					...backingStore,
					async settleItem(...args) {
						if (!settlementAvailable) throw new Error("Campaign settlement unavailable");
						return backingStore.settleItem(...args);
					},
				},
				authorize: async () => ({ actor: ACTOR, timeZone: INPUT.timeZone }),
				schedule: async (request) => {
					scheduleCalls.push(structuredClone(request));
					const existing = posts.get(request.clientIdempotencyKey);
					if (existing) return existing;
					mutableChecks += 1;
					const post = { id: "original-post", status: "scheduled" };
					posts.set(request.clientIdempotencyKey, post);
					return post;
				},
				createId: () => crypto.randomUUID(), now: () => now,
			});
			const input = { ...INPUT, scheduleMode: "now" as const, items: [INPUT.items[0]!] };
			await expect(module.schedule(input)).rejects.toMatchObject({ code: "campaign_schedule_item_failed" });
			for (const post of posts.values()) post.status = status;
			const waiting = await module.schedule(input);
			expect(waiting.status).toBe("running");
			expect(waiting.items[0]?.status).toBe("processing");
			settlementAvailable = true;
			now = new Date("2026-09-02T10:11:00Z");
			const recovered = await module.schedule(input);
			expect(recovered.status).toBe("completed");
			expect(recovered.items[0]?.socialPostId).toBe("original-post");
			expect(scheduleCalls).toHaveLength(2);
			expect(scheduleCalls[1]).toEqual(scheduleCalls[0]);
			expect([...posts.values()]).toEqual([{ id: "original-post", status }]);
			expect(mutableChecks).toBe(1);
		},
	);

	test("the shared admission replays a posted intent after bulk settlement and mutable facts are lost", async () => {
		let now = new Date("2026-09-02T10:00:00Z");
		let mutableReads = 0;
		let principalAdmissions = 0;
		let reviewAdmissions = 0;
		let unavailable = false;
		let providerPosted = false;
		let settleAvailable = false;
		const intentStore = createInMemoryPublicationSchedulingStore();
		const freezePorts: PublicationFreezePorts = {
			providerEnabled: () => true, capabilityVersion: () => "capability-v1",
			projectExists: async () => { mutableReads += 1; if (unavailable) throw new Error("project reader unavailable"); return true; },
			readClip: async () => ({ editorRevision: 4 }),
			readAccount: async () => ({ workspaceId: INPUT.workspaceId, platform: "youtube_shorts", status: "active", expiresAt: null, canRefresh: false }),
			readExport: async () => ({
				id: EXPORT_A, workspaceId: INPUT.workspaceId, projectId: INPUT.projectId, clipId: CLIP_A,
				editorRevision: 4, resolution: "1080p", fingerprint: "frozen-export",
				variants: [{ id: VARIANT_A, aspectRatio: "9:16", resolution: "1080p", status: "completed", storageKey: "local/export.mp4", sizeBytes: 42_000, durationSec: 30 }],
			}),
			createExport: async () => { throw new Error("bulk uses an exact prepared Export"); },
			tiktokOptions: async () => { throw new Error("not a TikTok request"); },
			requireCopyProvenance: async () => { if (unavailable) throw new Error("copy provenance unavailable"); },
			readThumbnailAsset: async () => null, thumbnailFrameMatches: async () => false,
		};
		const admission = createSocialPublicationScheduling({
			store: {
				...intentStore,
				async open(input) {
					const intent = await intentStore.open(input);
					return providerPosted ? { ...intent, status: "posted" as const, submissionEligible: false } : intent;
				},
			},
			authorize: async () => { principalAdmissions += 1; return ACTOR; },
			authorizeReview: async ({ exportIds }) => {
				reviewAdmissions += 1;
				return { allowed: true, items: exportIds.map((exportId) => ({ exportId, eligibility: "approved", overrideAuditId: null })) };
			},
			freezePorts, createId: () => "original-post", now: () => now,
		});
		const backingStore = createInMemoryBulkScheduleStore(() => now);
		const results: Array<Awaited<ReturnType<typeof admission.schedule>>> = [];
		const module = createBulkSocialScheduling({
			store: {
				...backingStore,
				async settleItem(...args) {
					if (!settleAvailable) throw new Error("bulk settlement unavailable");
					return backingStore.settleItem(...args);
				},
			},
			authorize: async () => ({ actor: ACTOR, timeZone: INPUT.timeZone }),
			schedule: async (input, options) => {
				const result = await admission.schedule(input, options);
				results.push(result);
				return result;
			},
			createId: () => crypto.randomUUID(), now: () => now,
		});
		const input = { ...INPUT, items: [INPUT.items[0]!] };
		await expect(module.schedule(input)).rejects.toMatchObject({ code: "campaign_schedule_item_failed" });
		providerPosted = true;
		unavailable = true;
		settleAvailable = true;
		now = new Date("2027-01-01T00:00:00Z");
		const replay = await module.schedule(input);
		expect(replay.items[0]).toMatchObject({ status: "succeeded", socialPostId: "original-post" });
		expect(results[1]).toMatchObject({ status: "posted", submissionEligible: false, frozen: results[0]!.frozen });
		expect(results[1]!.immutableRequestHash).toBe(results[0]!.immutableRequestHash);
		expect(await intentStore.count()).toBe(1);
		expect(mutableReads).toBe(1);
		expect(reviewAdmissions).toBe(1);
		expect(principalAdmissions).toBe(0);
	});

	test("keeps unknown admission running until the same request can replay its accepted post", async () => {
		let now = new Date("2026-09-02T10:00:00Z");
		let available = false;
		let admitted = false;
		let mutableChecks = 0;
		const module = createBulkSocialScheduling({
			store: createInMemoryBulkScheduleStore(() => now),
			authorize: async () => ({ actor: ACTOR, timeZone: INPUT.timeZone }),
			schedule: async () => {
				if (admitted) {
					if (!available) throw new Error("database unavailable");
					return { id: "original-post" };
				}
				mutableChecks += 1;
				admitted = true;
				throw new Error("response lost");
			},
			createId: () => crypto.randomUUID(), now: () => now,
		});
		const input = { ...INPUT, items: [INPUT.items[0]!] };
		await expect(module.schedule(input)).rejects.toMatchObject({ code: "campaign_schedule_item_failed" });
		const waiting = await module.schedule(input);
		expect(waiting.status).toBe("running");
		expect(waiting.items[0]?.status).toBe("processing");
		available = true;
		now = new Date("2026-09-02T10:11:00Z");
		const recovered = await module.schedule(input);
		expect(recovered.status).toBe("completed");
		expect(recovered.items[0]?.socialPostId).toBe("original-post");
		expect(mutableChecks).toBe(1);
	});

	test("replays partial results and gives an explicit corrected submission a new identity", async () => {
		const seen: string[] = [];
		let fail = true;
		const { module } = harness(async (item) => {
			seen.push(item.clientIdempotencyKey);
			if (item.clipId === CLIP_B && fail)
				throw new BulkSocialSchedulingError(
					"publication_provider_rate_limited",
					"Rate limited",
					true,
				);
			return { id: item.clientIdempotencyKey };
		});
		const first = await module.schedule(INPUT);
		const replay = await module.schedule(INPUT);
		expect(replay.items).toEqual(first.items);
		expect(seen).toHaveLength(2);
		fail = false;
		const corrected = await module.schedule({
			...INPUT,
			idempotencyKey: "00000000-0000-4000-8000-000000000014",
			items: [INPUT.items[1]!],
		});
		expect(corrected.counts.succeeded).toBe(1);
		expect(seen).toHaveLength(3);
		expect(seen[2]).not.toBe(seen[1]);
	});
	test("keeps distinct copy for accounts on the same platform and shares a single scheduled time", async () => {
		const seen: Array<{ caption: string; scheduledFor: Date }> = [];
		const { module } = harness(async (item) => {
			seen.push(item);
			return { id: item.clientIdempotencyKey };
		});
		await module.schedule({
			...INPUT,
			scheduleMode: "scheduled",
			items: [
				INPUT.items[0]!,
				{
					...INPUT.items[0]!,
					accountId: "00000000-0000-4000-8000-000000000030",
					copy: copy("Independent account wording"),
				},
			],
		});
		expect(seen.map((v) => v.caption)).toEqual([
			"First clip\n\n#Narriflow",
			"Independent account wording\n\n#Narriflow",
		]);
		expect(seen[0]!.scheduledFor).toEqual(seen[1]!.scheduledFor);
	});
});
