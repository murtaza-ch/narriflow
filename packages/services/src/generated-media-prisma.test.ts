import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
	createPrismaGeneratedMediaStore,
	generatedMediaTerminalAnalyticsEventId,
} from "./generated-media-prisma";

function queuedJob(id: string, workspaceId: string, createdAt: Date) {
	return {
		id,
		workspaceId,
		projectId: "00000000-0000-4000-8000-000000000101",
		clipId: null,
		actorUserId: "00000000-0000-4000-8000-000000000102",
		ownerUserId: null,
		ownerWorkspaceId: workspaceId,
		kind: "image",
		status: "queued",
		idempotencyKey: id,
		requestFingerprint: id,
		provider: "openai",
		model: "configured-model",
		promptCiphertext: "protected",
		promptFingerprint: id,
		promptKeyVersion: "test-primary",
		promptOriginKind: "manual",
		promptOriginSourceIds: [],
		aspectRatio: "9:16",
		style: "editorial",
		durationSec: null,
		seed: null,
		title: null,
		providerReference: null,
		resultReference: null,
		providerUsageUnits: null,
		moderationOutcome: "pending",
		moderationStage: null,
		moderationCategories: null,
		attemptCount: 0,
		claimId: null,
		claimOwner: null,
		claimExpiresAt: null,
		submissionStartedAt: null,
		nextAttemptAt: createdAt,
		nextPollAt: null,
		cancelRequestedAt: null,
		errorCode: null,
		stagedStorageKey: null,
		stagedContentType: null,
		stagedSizeBytes: null,
		stagedWidth: null,
		stagedHeight: null,
		stagedDurationSec: null,
		stagedHasAudio: null,
		stagedVideoCodec: null,
		stagedAudioCodec: null,
		stagedFingerprint: null,
		resultAssetId: null,
		insertionCount: 0,
		lastInsertionKind: null,
		lastInsertedAt: null,
		completedAt: null,
		createdAt,
		updatedAt: createdAt,
	};
}

const reserveScope = {
	actorUserId: "00000000-0000-4000-8000-000000000102",
	workspaceId: "00000000-0000-4000-8000-000000000201",
	workspaceOwnerUserId: "00000000-0000-4000-8000-000000000102",
	role: "owner" as const,
	status: "active" as const,
	pricingTier: "free",
	isPersonalWorkspace: true,
};

function reserveInput(requestFingerprint: string) {
	const now = new Date("2026-08-31T12:00:00.000Z");
	return {
		scope: reserveScope,
		request: {
			idempotencyKey: "00000000-0000-4000-8000-000000000301",
			projectId: "00000000-0000-4000-8000-000000000101",
			clipId: null,
			kind: "image" as const,
			prompt: "A quiet recording studio at dawn",
			derivedContext: null,
			promptOrigin: { kind: "manual" as const, sourceIds: [] },
			aspectRatio: "9:16" as const,
			style: "editorial" as const,
			durationSec: null,
			seed: null,
			title: null,
		},
		requestFingerprint,
		promptFingerprint: "prompt-fingerprint",
		promptCiphertext: "protected",
		promptKeyVersion: "test-primary",
		provider: "openai",
		model: "configured-model",
		usageUnits: 1,
		usageWindow: {
			policy: "trial_metered" as const,
			allowance: {
				period: "lifetime" as const,
				limitUnits: 1,
				startsAt: null,
				endsAt: null,
			},
			dailyAbuse: {
				period: "calendar_day_utc" as const,
				limitUnits: 40,
				startsAt: new Date("2026-08-31T00:00:00.000Z"),
				endsAt: new Date("2026-09-01T00:00:00.000Z"),
			},
		},
		now,
	};
}

function quotaLockRacePrisma(existingFingerprint: string) {
	const existing = queuedJob(
		"00000000-0000-4000-8000-000000000301",
		reserveScope.workspaceId,
		new Date("2026-08-31T12:00:00.000Z"),
	);
	existing.requestFingerprint = existingFingerprint;
	let replayReads = 0;
	let aggregateCalls = 0;
	const generatedMediaJob = {
		async findUnique() {
			replayReads += 1;
			return replayReads === 1 ? null : existing;
		},
	};
	const tx = {
		project: { async findFirst() { return { id: existing.projectId }; } },
		generatedMediaJob,
		generationUsageReservation: {
			async aggregate() {
				aggregateCalls += 1;
				throw new Error("quota aggregates must not run for an idempotent replay");
			},
		},
		async $queryRaw() {
			return [{ locked: true }];
		},
	};
	const prisma = {
		generatedMediaJob,
		async $transaction(operation: (client: typeof tx) => Promise<unknown>) {
			return operation(tx);
		},
	} as unknown as PrismaClient;
	return {
		prisma,
		reads: () => replayReads,
		aggregates: () => aggregateCalls,
	};
}

function publicationPrisma(
	collision: "uploaded" | "extracted",
	analyticsFailure?: Error,
) {
	const now = new Date("2026-08-31T12:00:00.000Z");
	const job = {
		...queuedJob(
			"00000000-0000-4000-8000-000000000401",
			reserveScope.workspaceId,
			now,
		),
		status: "running",
		claimId: "00000000-0000-4000-8000-000000000402",
		ownerWorkspaceId: reserveScope.workspaceId,
		providerUsageUnits: 1,
		resultReference:
			"generated-media/provider-results/00000000-0000-4000-8000-000000000401.png",
		moderationOutcome: "passed",
		attemptCount: 1,
		stagedStorageKey:
			"generated-media/assets/workspace/00000000-0000-4000-8000-000000000201/job-1/attempt-1.png",
		stagedContentType: "image/png",
		stagedSizeBytes: 128n,
		stagedWidth: 1024,
		stagedHeight: 1536,
		stagedDurationSec: null,
		stagedHasAudio: null,
		stagedVideoCodec: null,
		stagedAudioCodec: null,
		stagedFingerprint: "a".repeat(64),
		usage: {
			status: "reserved",
			reservedUnits: 1,
		},
	};
	const collidingAsset = {
		id: "00000000-0000-4000-8000-000000000403",
		workspaceId: reserveScope.workspaceId,
		userId: null,
		storageKey: `${collision}/original.png`,
		fingerprint: job.stagedFingerprint,
		provenance: collision,
		deletedAt: null,
	};
	const createdAsset = {
		...collidingAsset,
		id: "00000000-0000-4000-8000-000000000404",
		storageKey: job.stagedStorageKey,
		provenance: "generated",
	};
	let assetWhere: Record<string, unknown> | null = null;
	let assetCreateCalls = 0;
	let jobUpdate: Record<string, unknown> | null = null;
	const analyticsRows: Array<Record<string, unknown>> = [];
	const cleanupAdmissions: unknown[] = [];
	const tx = {
		generatedMediaJob: {
			findFirst: async () => job,
			update: async ({ data }: { data: Record<string, unknown> }) => {
				jobUpdate = data;
				return { ...job, ...data };
			},
		},
		visualAsset: {
			findFirst: async ({ where }: { where: Record<string, unknown> }) => {
				assetWhere = where;
				const accepted = (where.provenance as { in?: string[] } | undefined)?.in;
				return accepted?.includes(collision) ? collidingAsset : null;
			},
			create: async () => {
				assetCreateCalls += 1;
				return createdAsset;
			},
			update: async () => collidingAsset,
		},
		generationUsageReservation: { update: async () => ({}) },
		workspace: {
			findUnique: async () => ({ pricingTier: "creator" }),
		},
		projectAnalyticsEvent: {
			create: async ({ data }: { data: Record<string, unknown> }) => {
				if (analyticsFailure) throw analyticsFailure;
				analyticsRows.push(data);
				return data;
			},
		},
		mediaCleanupObligation: {
			createMany: async (input: unknown) => {
				cleanupAdmissions.push(input);
				return { count: 2 };
			},
		},
	};
	const prisma = {
		$transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
			operation(tx),
	} as unknown as PrismaClient;
	return {
		store: createPrismaGeneratedMediaStore(prisma),
		claim: {
			jobId: job.id,
			claimId: job.claimId!,
		} as Parameters<ReturnType<typeof createPrismaGeneratedMediaStore>["publishAsset"]>[0]["claim"],
		now,
		assetWhere: () => assetWhere,
		assetCreateCalls: () => assetCreateCalls,
		jobUpdate: () => jobUpdate,
		analyticsRows,
		cleanupAdmissions,
		collidingAsset,
		createdAsset,
	};
}

function terminalTransitionPrisma(
	jobOverrides: Record<string, unknown> = {},
	analyticsFailure?: Error,
) {
	const now = new Date("2026-08-31T12:00:00.000Z");
	const job = {
		...queuedJob(
			"00000000-0000-4000-8000-000000000501",
			reserveScope.workspaceId,
			new Date("2026-08-31T11:59:00.000Z"),
		),
		status: "running",
		claimId: "00000000-0000-4000-8000-000000000502",
		claimOwner: "worker-1",
		claimExpiresAt: new Date("2026-08-31T12:05:00.000Z"),
		attemptCount: 2,
		usage: { status: "reserved", reservedUnits: 1 },
		...jobOverrides,
	};
	const jobUpdates: Array<Record<string, unknown>> = [];
	const usageUpdates: Array<Record<string, unknown>> = [];
	const analyticsRows: Array<Record<string, unknown>> = [];
	const tx = {
		generatedMediaJob: {
			findFirst: async () => job,
			update: async ({ data }: { data: Record<string, unknown> }) => {
				jobUpdates.push(data);
				return { ...job, ...data };
			},
			updateMany: async () => ({ count: 1 }),
		},
		generationUsageReservation: {
			update: async ({ data }: { data: Record<string, unknown> }) => {
				usageUpdates.push(data);
				return data;
			},
		},
		workspace: { findUnique: async () => ({ pricingTier: "pro" }) },
		projectAnalyticsEvent: {
			create: async ({ data }: { data: Record<string, unknown> }) => {
				if (analyticsFailure) throw analyticsFailure;
				analyticsRows.push(data);
				return data;
			},
		},
	};
	const prisma = {
		$transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
			operation(tx),
	} as unknown as PrismaClient;
	return {
		store: createPrismaGeneratedMediaStore(prisma),
		claim: {
			jobId: job.id,
			claimId: job.claimId,
		} as Parameters<ReturnType<typeof createPrismaGeneratedMediaStore>["markTerminal"]>[0]["claim"],
		job,
		now,
		jobUpdates,
		usageUpdates,
		analyticsRows,
	};
}

describe("Prisma generated-media store", () => {
	test("uses one deterministic terminal analytics identity per job", () => {
		const jobId = "00000000-0000-4000-8000-000000000501";
		const eventId = generatedMediaTerminalAnalyticsEventId(jobId);
		expect(eventId).toMatch(/^[a-f0-9-]{36}$/);
		expect(generatedMediaTerminalAnalyticsEventId(jobId)).toBe(eventId);
		expect(generatedMediaTerminalAnalyticsEventId(crypto.randomUUID())).not.toBe(
			eventId,
		);
	});

	test("replays a concurrent identical Free request after waiting for the quota lock", async () => {
		const race = quotaLockRacePrisma("same-fingerprint");
		const store = createPrismaGeneratedMediaStore(race.prisma);

		await expect(store.reserve(reserveInput("same-fingerprint"))).resolves.toMatchObject({
			replayed: true,
			job: {
				id: "00000000-0000-4000-8000-000000000301",
				replayed: true,
			},
		});
		expect(race.reads()).toBe(2);
		expect(race.aggregates()).toBe(0);
	});

	test("rejects a changed fingerprint discovered after the quota lock", async () => {
		const race = quotaLockRacePrisma("original-fingerprint");
		const store = createPrismaGeneratedMediaStore(race.prisma);

		await expect(
			store.reserve(reserveInput("changed-fingerprint")),
		).rejects.toMatchObject({ code: "generated_media_idempotency_conflict" });
		expect(race.reads()).toBe(2);
		expect(race.aggregates()).toBe(0);
	});

	test("claims an eligible tenant after a full page belongs to a capped tenant", async () => {
		const now = new Date("2026-08-31T12:00:00.000Z");
		const cappedWorkspace = "00000000-0000-4000-8000-000000000201";
		const eligibleWorkspace = "00000000-0000-4000-8000-000000000202";
		const firstPage = Array.from({ length: 25 }, (_, index) =>
			queuedJob(
				`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
				cappedWorkspace,
				new Date(now.getTime() + index),
			),
		);
		const eligible = queuedJob(
			"00000000-0000-4000-8000-000000000299",
			eligibleWorkspace,
			new Date(now.getTime() + 100),
		);
		let claimedId: string | null = null;
		const tx = {
			generatedMediaJob: {
				async findMany(input: { cursor?: { id: string } }) {
					return input.cursor ? [eligible] : firstPage;
				},
				async count(input: { where: { workspaceId: string } }) {
					return input.where.workspaceId === cappedWorkspace ? 1 : 0;
				},
				async updateMany(input: { where: { id: string }; data: { claimId: string } }) {
					claimedId = input.where.id;
					eligible.claimId = input.data.claimId;
					eligible.status = "running";
					return { count: 1 };
				},
				async findUniqueOrThrow() {
					return {
						...eligible,
						usage: {
							reservedUnits: 1,
						},
					};
				},
			},
		};
		const prisma = {
			async $transaction(operation: (client: typeof tx) => Promise<unknown>) {
				return operation(tx);
			},
		} as unknown as PrismaClient;
		const store = createPrismaGeneratedMediaStore(prisma);

		const claim = await store.claimNext({
			workerId: "worker-1",
			now,
			leaseMs: 60_000,
			enabledKinds: ["image"],
			maxConcurrency: { image: 1 },
		});

		expect(claim?.workspaceId).toBe(eligibleWorkspace);
		expect(claimedId).toBe(eligible.id);
	});

	test("adopts the exact upload obligation in the staged-reference transaction", async () => {
		const now = new Date("2026-08-31T12:00:00.000Z");
		const events: unknown[] = [];
		const tx = {
			generatedMediaJob: {
				async updateMany(input: unknown) {
					events.push({ stage: input });
					return { count: 1 };
				},
			},
			mediaCleanupObligation: {
				async updateMany(input: unknown) {
					events.push({ adopt: input });
					return { count: 1 };
				},
				async count() {
					return 0;
				},
			},
		};
		const prisma = {
			async $transaction(operation: (client: typeof tx) => Promise<unknown>) {
				return operation(tx);
			},
		} as unknown as PrismaClient;
		const store = createPrismaGeneratedMediaStore(prisma);
		const storageKey =
			"generated-media/assets/workspace/00000000-0000-4000-8000-000000000201/job-1/attempt-1.png";

		await store.stageAsset({
			claim: {
				jobId: "00000000-0000-4000-8000-000000000401",
				claimId: "00000000-0000-4000-8000-000000000402",
			} as Parameters<typeof store.stageAsset>[0]["claim"],
			asset: {
				storageKey,
				contentType: "image/png",
				sizeBytes: 128,
				width: 1024,
				height: 1536,
				durationSec: null,
				hasAudio: null,
				videoCodec: null,
				audioCodec: null,
				fingerprint: "a".repeat(64),
			},
			now,
		});

		expect(events).toHaveLength(2);
		expect(events[1]).toEqual({
			adopt: expect.objectContaining({
				where: expect.objectContaining({
					origin: "generated_media_ingestion",
					cleanupClass: "generated_media_asset_upload",
					objectKey: storageKey,
				}),
				data: expect.objectContaining({
					failureCode: "generated_media_asset_referenced",
				}),
			}),
		});
	});

	test("adopts stored provider evidence in the result-reference transaction", async () => {
		const now = new Date("2026-08-31T12:00:00.000Z");
		const events: string[] = [];
		const reference =
			"generated-media/provider-results/00000000-0000-4000-8000-000000000401.png";
		const tx = {
			generatedMediaJob: {
				async updateMany() {
					events.push("reference");
					return { count: 1 };
				},
			},
			mediaCleanupObligation: {
				async createMany() {
					events.push("admit");
					return { count: 1 };
				},
				async updateMany() {
					events.push("adopt");
					return { count: 1 };
				},
				async count() {
					return 0;
				},
			},
		};
		const prisma = {
			async $transaction(operation: (client: typeof tx) => Promise<unknown>) {
				return operation(tx);
			},
		} as unknown as PrismaClient;
		const store = createPrismaGeneratedMediaStore(prisma);

		await store.recordProviderResult({
			claim: {
				jobId: "00000000-0000-4000-8000-000000000401",
				claimId: "00000000-0000-4000-8000-000000000402",
				projectId: "00000000-0000-4000-8000-000000000101",
				clipId: null,
			} as Parameters<typeof store.recordProviderResult>[0]["claim"],
			providerReference: "provider-request-1",
			resultReference: reference,
			moderation: { outcome: "passed" },
			usageUnits: 1,
			now,
		});

		expect(events).toEqual(["reference", "admit", "adopt"]);
	});

	test("reuses an identical uploaded asset as the exact generated job result", async () => {
		const fixture = publicationPrisma("uploaded");
		expect(fixture.store.terminalAnalyticsDelivery).toBe("transactional");

		await expect(fixture.store.publishAsset({
			claim: fixture.claim,
			now: fixture.now,
			promptRetentionMs: 60_000,
		})).resolves.toEqual({
			assetId: fixture.collidingAsset.id,
			replayed: true,
		});
		expect(fixture.assetWhere()).toMatchObject({
			workspaceId: reserveScope.workspaceId,
			fingerprint: "a".repeat(64),
			provenance: { in: ["uploaded", "generated"] },
		});
		expect(fixture.assetCreateCalls()).toBe(0);
		expect(fixture.jobUpdate()).toMatchObject({
			status: "completed",
			resultAssetId: fixture.collidingAsset.id,
			stagedFingerprint: "a".repeat(64),
		});
		expect(fixture.analyticsRows).toHaveLength(1);
		expect(fixture.cleanupAdmissions).toEqual([
			{
				data: [
					{
						origin: "generated_media_ingestion",
						cleanupClass: "generated_media_redundant_asset",
						projectId: "00000000-0000-4000-8000-000000000101",
						clipId: null,
						objectKey:
							"generated-media/assets/workspace/00000000-0000-4000-8000-000000000201/job-1/attempt-1.png",
						nextAttemptAt: fixture.now,
					},
					{
						origin: "generated_media_ingestion",
						cleanupClass: "generated_media_consumed_provider_result",
						projectId: "00000000-0000-4000-8000-000000000101",
						clipId: null,
						objectKey:
							"generated-media/provider-results/00000000-0000-4000-8000-000000000401.png",
						nextAttemptAt: fixture.now,
					},
				],
				skipDuplicates: true,
			},
		]);
		expect(fixture.analyticsRows[0]).toMatchObject({
			projectId: "00000000-0000-4000-8000-000000000101",
			clipId: null,
			type: "generated_asset_completed",
			metadata: {
				kind: "image",
				status: "completed",
				outcome: "succeeded",
				usageUnits: 1,
				planTier: "creator",
			},
		});
		expect(JSON.stringify(fixture.analyticsRows)).not.toContain("protected");
	});

	test("does not publish an extracted collision as the generated job result", async () => {
		const fixture = publicationPrisma("extracted");

		await expect(fixture.store.publishAsset({
			claim: fixture.claim,
			now: fixture.now,
			promptRetentionMs: 60_000,
		})).resolves.toEqual({
			assetId: fixture.createdAsset.id,
			replayed: false,
		});
		expect(fixture.assetCreateCalls()).toBe(1);
		expect(fixture.jobUpdate()).toMatchObject({
			status: "completed",
			resultAssetId: fixture.createdAsset.id,
		});
	});

	test("fails publication when its atomic completion event cannot commit", async () => {
		const fixture = publicationPrisma(
			"uploaded",
			new Error("analytics unavailable"),
		);
		await expect(fixture.store.publishAsset({
			claim: fixture.claim,
			now: fixture.now,
			promptRetentionMs: 60_000,
		})).rejects.toThrow("analytics unavailable");
	});

	test("records every known terminal non-success in the authoritative transaction", async () => {
		for (const [status, moderationOutcome] of [
			["failed", "passed"],
			["rejected", "rejected"],
			["cancelled", "pending"],
		] as const) {
			const fixture = terminalTransitionPrisma();
			await fixture.store.markTerminal({
				claim: fixture.claim,
				status,
				errorCode: `generated_media_${status}`,
				moderation: { outcome: moderationOutcome },
				now: fixture.now,
				promptRetentionMs: 60_000,
			});

			expect(fixture.jobUpdates).toHaveLength(1);
			expect(fixture.usageUpdates).toEqual([
				expect.objectContaining({ status: "released", releasedUnits: 1 }),
			]);
			expect(fixture.analyticsRows).toHaveLength(1);
			expect(fixture.analyticsRows[0]).toMatchObject({
				id: expect.stringMatching(/^[a-f0-9-]{36}$/),
				projectId: fixture.job.projectId,
				type: "generated_asset_completed",
				metadata: {
					kind: "image",
					providerAlias: "openai",
					modelAlias: "configured-model",
					status,
					latencyBucket: "under_5m",
					retryCount: 1,
					moderationOutcome,
					usageUnits: 0,
					outcome: status,
					planTier: "pro",
				},
			});
			expect(JSON.stringify(fixture.analyticsRows)).not.toContain("protected");
		}
	});

	test("makes queued and claimed cancellation analytics part of their state transactions", async () => {
		const queued = terminalTransitionPrisma({
			status: "queued",
			claimId: null,
			claimOwner: null,
			claimExpiresAt: null,
			attemptCount: 0,
			submissionStartedAt: null,
		});
		await queued.store.requestCancellation({
			scope: reserveScope,
			jobId: queued.job.id,
			now: queued.now,
			promptRetentionMs: 60_000,
		});
		expect(queued.analyticsRows[0]).toMatchObject({
			metadata: { status: "cancelled", outcome: "cancelled", usageUnits: 0 },
		});

		const claimed = terminalTransitionPrisma({
			cancelRequestedAt: new Date("2026-08-31T11:59:30.000Z"),
		});
		await expect(claimed.store.beginSubmission({
			claim: claimed.claim,
			now: claimed.now,
			promptRetentionMs: 60_000,
		})).resolves.toBe("cancelled");
		expect(claimed.analyticsRows[0]).toMatchObject({
			metadata: { status: "cancelled", outcome: "cancelled", usageUnits: 0 },
		});
	});

	test("fails the terminal transition when its durable analytics write fails", async () => {
		const fixture = terminalTransitionPrisma(
			{},
			new Error("analytics unavailable"),
		);
		await expect(fixture.store.markTerminal({
			claim: fixture.claim,
			status: "failed",
			errorCode: "generated_media_failed",
			now: fixture.now,
			promptRetentionMs: 60_000,
		})).rejects.toThrow("analytics unavailable");
	});
});
