import { describe, expect, test } from "bun:test";

import {
	GeneratedMediaWorker,
	GeneratedMediaService,
	createGeneratedMediaPromptProtection,
	createInMemoryGeneratedMediaStore,
	type GeneratedMediaAssetIngestor,
	type GeneratedMediaEventSink,
	type GeneratedMediaProvider,
	type GeneratedMediaStore,
} from "./generated-media";

const scope = {
	actorUserId: "00000000-0000-4000-8000-000000000001",
	workspaceId: "00000000-0000-4000-8000-000000000002",
	workspaceOwnerUserId: "00000000-0000-4000-8000-000000000001",
	role: "owner" as const,
	status: "active" as const,
	pricingTier: "creator",
	isPersonalWorkspace: true,
};

const request = {
	idempotencyKey: "00000000-0000-4000-8000-000000000003",
	projectId: "00000000-0000-4000-8000-000000000004",
	clipId: "00000000-0000-4000-8000-000000000005",
	kind: "image" as const,
	prompt: "A quiet recording studio at dawn",
	derivedContext: "The speaker describes finding focus before the city wakes.",
	promptOrigin: {
		kind: "transcript_selection" as const,
		sourceIds: [
			"clip:00000000-0000-4000-8000-000000000005:transcript:utterance-2",
		],
	},
	aspectRatio: "9:16" as const,
	style: "editorial" as const,
};

function createProvider(alias = "openai"): GeneratedMediaProvider & {
	submissions: number;
	polls: number;
} {
	return {
		alias,
		submissions: 0,
		polls: 0,
		async submit() {
			this.submissions += 1;
			return {
				state: "completed",
				providerReference: "provider-request-1",
				resultReference: "provider-result-1",
				moderation: { outcome: "passed" },
				usage: { units: 1 },
			};
		},
		async poll() {
			this.polls += 1;
			throw new Error("image submission is synchronous");
		},
		async cancel() {
			return { state: "unsupported" };
		},
		async retrieve() {
			return {
				kind: "inline",
				contentType: "image/png",
				bytes: new Uint8Array([137, 80, 78, 71]),
			};
		},
	};
}

const config = {
	image: {
		enabled: true as const,
		provider: "openai",
		model: "configured-image-model",
		maxConcurrency: 2,
		usageUnits: 1,
		maxOutputBytes: 16 * 1024 * 1024,
	},
	video: { enabled: false as const, reason: "entry_gate_closed" },
};

const promptProtection = createGeneratedMediaPromptProtection({
	activeKeyVersion: "test-primary",
	encryptionKeys: {
		"test-primary": "test-encryption-key-with-at-least-32-characters",
	},
	fingerprintKey: "test-fingerprint-key-with-at-least-32-characters",
});

function createIngestor(): GeneratedMediaAssetIngestor & { ingestions: number } {
	return {
		ingestions: 0,
		async ingest(input) {
			this.ingestions += 1;
			return {
				storageKey: input.storageKey,
				contentType: "image/png",
				sizeBytes: 4,
				width: 1080,
				height: 1920,
				durationSec: null,
				hasAudio: null,
				videoCodec: null,
				audioCodec: null,
				fingerprint: "image-fingerprint",
			};
		},
	};
}

async function expectSettlement(
	service: GeneratedMediaService,
	expected: {
		image: { reservedUnits: number; finalizedUnits: number; releasedUnits: number };
		video: { reservedUnits: number; finalizedUnits: number; releasedUnits: number };
	},
) {
	const summary = await service.usageSummary(scope);
	expect(summary.image.settlement).toEqual(expected.image);
	expect(summary.video.settlement).toEqual(expected.video);
}

describe("GeneratedMediaService", () => {
	test("snapshots generated-media ownership from workspace identity, not pricing tier", async () => {
		const now = new Date("2026-08-31T12:00:00.000Z");
		const claimFor = async (inputScope: typeof scope) => {
			const store = createInMemoryGeneratedMediaStore();
			const provider = createProvider();
			const service = new GeneratedMediaService({
				store,
				providers: new Map([[provider.alias, provider]]),
				config,
				promptProtection,
				now: () => now,
			});
			await service.submit(inputScope, request);
			return store.claimNext({
				workerId: "stable-owner-worker",
				now,
				leaseMs: 60_000,
				enabledKinds: ["image"],
				maxConcurrency: { image: 1 },
			});
		};

		expect(
			await claimFor({ ...scope, pricingTier: "business" }),
		).toMatchObject({
			ownerUserId: scope.workspaceOwnerUserId,
			ownerWorkspaceId: null,
		});
		expect(
			await claimFor({
				...scope,
				isPersonalWorkspace: false,
				pricingTier: "business",
			}),
		).toMatchObject({
			ownerUserId: null,
			ownerWorkspaceId: scope.workspaceId,
		});
	});

	test("requires processing consumption authority at the service seam", async () => {
		const provider = createProvider();
		const service = new GeneratedMediaService({
			store: createInMemoryGeneratedMediaStore(),
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});

		await expect(
			service.submit({ ...scope, status: "restricted" }, request),
		).rejects.toMatchObject({ code: "generated_media_forbidden" });
		expect(provider.submissions).toBe(0);
	});

	test("reserves usage once and defers provider work to the worker", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});

		const first = await service.submit(scope, request);
		const replay = await service.submit(scope, request);

		expect(replay.id).toBe(first.id);
		expect(replay.replayed).toBe(true);
		expect(provider.submissions).toBe(0);
		await expectSettlement(service, {
			image: { reservedUnits: 1, finalizedUnits: 0, releasedUnits: 0 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("admits exactly one Free image trial across concurrent commands", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});
		const freeScope = { ...scope, pricingTier: "free" };

		const outcomes = await Promise.allSettled([
			service.submit(freeScope, request),
			service.submit(freeScope, {
				...request,
				idempotencyKey: "00000000-0000-4000-8000-000000000006",
			}),
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toMatchObject([
			{ reason: { code: "generated_media_usage_exhausted" } },
		]);
		expect(provider.submissions).toBe(0);
	});

	test("reports bounded daily metered availability and resets admission at UTC midnight", async () => {
		let now = new Date("2026-08-31T12:00:00.000Z");
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config: {
				...config,
				image: {
					...config.image,
					dailyUsageLimit: 2,
					dailyAbuseLimit: 3,
				},
			},
			promptProtection,
			now: () => now,
		});

		await service.submit(scope, request);
		expect((await service.usageSummary(scope)).image).toEqual({
			policy: "metered",
			allowance: {
				period: "calendar_day_utc",
				limitUnits: 2,
				committedUnits: 1,
				availableUnits: 1,
				resetsAt: "2026-09-01T00:00:00.000Z",
			},
			dailyAbuse: {
				limitUnits: 3,
				admittedUnits: 1,
				availableUnits: 2,
				resetsAt: "2026-09-01T00:00:00.000Z",
			},
			settlement: { reservedUnits: 1, finalizedUnits: 0, releasedUnits: 0 },
		});
		await service.submit(scope, {
			...request,
			idempotencyKey: "00000000-0000-4000-8000-000000000007",
		});
		await expect(
			service.submit(scope, {
				...request,
				idempotencyKey: "00000000-0000-4000-8000-000000000008",
			}),
		).rejects.toMatchObject({ code: "generated_media_usage_exhausted" });

		now = new Date("2026-09-01T00:00:00.000Z");
		await expect(
			service.submit(scope, {
				...request,
				idempotencyKey: "00000000-0000-4000-8000-000000000009",
			}),
		).resolves.toMatchObject({ status: "queued" });
	});

	test("publishes one Visual Asset and finalizes usage exactly once", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const ingestor = createIngestor();
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor,
			workerId: "test-worker",
		});

		const submitted = await service.submit(scope, request);
		expect(await worker.processNext()).toBe(1);
		expect(await worker.processNext()).toBe(0);

		const completed = await service.get(scope, submitted.id);
		expect(completed.status).toBe("completed");
		expect(completed.resultAssetId).not.toBeNull();
		expect(provider.submissions).toBe(1);
		expect(ingestor.ingestions).toBe(1);
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 1, releasedUnits: 0 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("settles two jobs that produce the same owner fingerprint onto one asset", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const providers = new Map([[provider.alias, provider]]);
		const service = new GeneratedMediaService({
			store,
			providers,
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers,
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "same-fingerprint-worker",
		});
		const first = await service.submit(scope, request);
		const second = await service.submit(scope, {
			...request,
			idempotencyKey: "00000000-0000-4000-8000-000000000018",
		});

		await worker.processNext();
		await worker.processNext();

		const [firstCompleted, secondCompleted] = await Promise.all([
			service.get(scope, first.id),
			service.get(scope, second.id),
		]);
		expect(firstCompleted.resultAssetId).not.toBeNull();
		expect(secondCompleted.resultAssetId).toBe(firstCompleted.resultAssetId);
		expect((await service.usageSummary(scope)).image.settlement.finalizedUnits).toBe(2);
	});

	test("releases usage for a normalized moderation rejection", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		provider.submit = async () => ({
			state: "rejected",
			providerReference: "request-rejected",
			moderation: {
				outcome: "rejected",
				stage: "input",
				categories: ["violence"],
			},
			errorCode: "generated_media_rejected",
		});
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "test-worker",
		});

		const submitted = await service.submit(scope, request);
		await worker.processNext();

		expect(await service.get(scope, submitted.id)).toMatchObject({
			status: "rejected",
			errorCode: "generated_media_rejected",
			moderation: { outcome: "rejected", stage: "input" },
		});
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 1 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("restores the Free trial after a released rejection", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		provider.submit = async () => ({
			state: "rejected",
			providerReference: "request-rejected",
			moderation: { outcome: "rejected", stage: "input" },
			errorCode: "generated_media_rejected",
		});
		const providers = new Map([[provider.alias, provider]]);
		const service = new GeneratedMediaService({
			store,
			providers,
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers,
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "free-trial-release-worker",
		});
		const freeScope = { ...scope, pricingTier: "free" };

		await service.submit(freeScope, request);
		await worker.processNext();

		await expect(
			service.submit(freeScope, {
				...request,
				idempotencyKey: "00000000-0000-4000-8000-000000000014",
			}),
		).resolves.toMatchObject({ status: "queued" });
	});

	test("releases usage for a known terminal provider failure", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		provider.submit = async () => ({
			state: "failed",
			providerReference: "provider-request-invalid",
			errorCode: "generated_media_provider_validation_failed",
			retry: "terminal",
		});
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "terminal-failure-worker",
		});

		const submitted = await service.submit(scope, request);
		await worker.processNext();

		expect(await service.get(scope, submitted.id)).toMatchObject({
			status: "failed",
			errorCode: "generated_media_provider_validation_failed",
		});
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 1 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("restores paid allowance after failure while preserving the daily abuse ceiling", async () => {
		const now = new Date("2026-08-31T12:00:00.000Z");
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		provider.submit = async () => ({
			state: "failed",
			providerReference: null,
			errorCode: "generated_media_provider_validation_failed",
			retry: "terminal",
		});
		const boundedConfig = {
			...config,
			image: {
				...config.image,
				dailyUsageLimit: 1,
				dailyAbuseLimit: 2,
			},
		};
		const providers = new Map([[provider.alias, provider]]);
		const service = new GeneratedMediaService({
			store,
			providers,
			config: boundedConfig,
			promptProtection,
			now: () => now,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers,
			config: boundedConfig,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "paid-abuse-worker",
			now: () => now,
		});

		await service.submit(scope, request);
		await worker.processNext();
		expect((await service.usageSummary(scope)).image).toMatchObject({
			allowance: { committedUnits: 0, availableUnits: 1 },
			dailyAbuse: { admittedUnits: 1, availableUnits: 1 },
			settlement: { releasedUnits: 1 },
		});
		await service.submit(scope, {
			...request,
			idempotencyKey: "00000000-0000-4000-8000-000000000015",
		});
		await worker.processNext();
		await expect(
			service.submit(scope, {
				...request,
				idempotencyKey: "00000000-0000-4000-8000-000000000016",
			}),
		).rejects.toMatchObject({ code: "generated_media_usage_exhausted" });
	});

	test("holds a nonpollable unknown outcome for reconciliation without blocking later work", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		provider.submit = async () => {
			provider.submissions += 1;
			if (provider.submissions === 1) {
				throw new Error("socket closed after request dispatch");
			}
			return {
				state: "completed",
				providerReference: "provider-request-2",
				resultReference: "provider-result-2",
				moderation: { outcome: "passed" },
				usage: { units: 1 },
			};
		};
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "test-worker",
		});

		const submitted = await service.submit(scope, request);
		await worker.processNext();
		expect(await service.get(scope, submitted.id)).toMatchObject({
			status: "reconciliation_required",
			errorCode: "generated_media_outcome_unknown",
		});

		const later = await service.submit(scope, {
			...request,
			idempotencyKey: "00000000-0000-4000-8000-000000000010",
		});
		expect(await worker.processNext()).toBe(1);
		expect(await service.get(scope, later.id)).toMatchObject({ status: "completed" });
		expect(provider.submissions).toBe(2);
		expect((await service.usageSummary(scope)).image).toMatchObject({
			allowance: { committedUnits: 2 },
			dailyAbuse: { admittedUnits: 2 },
			settlement: { reservedUnits: 1, finalizedUnits: 1, releasedUnits: 0 },
		});
	});

	test("does not poll, refund, or resubmit a successful response with uncertain staged output", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const resultReference =
			"generated-media/provider-results/00000000-0000-4000-8000-000000000003.png";
		provider.submit = async () => {
			provider.submissions += 1;
			return {
				state: "failed",
				providerReference: "provider-success-response",
				resultReference,
				moderation: { outcome: "passed" },
				usage: { units: 1 },
				errorCode: "generated_media_malformed_output",
				retry: "unknown",
			};
		};
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "uncertain-success-worker",
		});

		const submitted = await service.submit(scope, request);
		expect(await worker.processNext()).toBe(1);
		expect(await service.get(scope, submitted.id)).toMatchObject({
			status: "reconciliation_required",
			errorCode: "generated_media_malformed_output",
		});
		expect(await store.referencedStorageKeys("generated-media/provider-results/")).toEqual(
			new Set([resultReference]),
		);
		expect((await service.usageSummary(scope)).image.settlement).toEqual({
			reservedUnits: 1,
			finalizedUnits: 0,
			releasedUnits: 0,
		});
		expect(await worker.processNext()).toBe(0);
		expect(provider.submissions).toBe(1);
		expect(provider.polls).toBe(0);
	});

	test("retains confirmed provider evidence and usage when successful units cannot settle", async () => {
		let now = new Date("2026-08-31T12:00:00.000Z");
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const resultReference =
			"generated-media/provider-results/00000000-0000-4000-8000-000000000003.png";
		provider.submit = async () => ({
			state: "completed",
			providerReference: "provider-confirmed-success",
			resultReference,
			moderation: { outcome: "passed" },
			usage: { units: 2 },
		});
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			now: () => now,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "usage-reconciliation-worker",
			now: () => now,
		});

		const submitted = await service.submit(scope, request);
		await worker.processNext();

		expect(await service.get(scope, submitted.id)).toMatchObject({
			status: "reconciliation_required",
			errorCode: "generated_media_usage_invalid",
		});
		expect((await service.usageSummary(scope)).image.settlement).toEqual({
			reservedUnits: 1,
			finalizedUnits: 0,
			releasedUnits: 0,
		});
		expect(await store.referencedStorageKeys("generated-media/provider-results/")).toEqual(
			new Set([resultReference]),
		);
		now = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000 + 1);
		expect(await store.purgeExpiredPrompts(now, 100)).toBe(1);
	});

	test("fails corrupted protected prompt material without calling the provider", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection: {
				...promptProtection,
				open() {
					throw new Error("ciphertext authentication failed");
				},
			},
			ingestor: createIngestor(),
			workerId: "prompt-corruption-worker",
		});

		const submitted = await service.submit(scope, request);
		await worker.processNext();

		expect(await service.get(scope, submitted.id)).toMatchObject({
			status: "failed",
			errorCode: "generated_media_prompt_unreadable",
		});
		expect(provider.submissions).toBe(0);
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 1 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("authenticates the protected prompt before committing the provider boundary", async () => {
		const durableStore = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		let promptAuthenticated = false;
		const orderedStore: GeneratedMediaStore = {
			...durableStore,
			beginSubmission(input) {
				if (!promptAuthenticated) {
					throw new Error("submission boundary committed before prompt authentication");
				}
				return durableStore.beginSubmission(input);
			},
		};
		const authenticatedProtection = {
			...promptProtection,
			open(...input: Parameters<typeof promptProtection.open>) {
				const value = promptProtection.open(...input);
				promptAuthenticated = true;
				return value;
			},
		};
		const service = new GeneratedMediaService({
			store: orderedStore,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection: authenticatedProtection,
		});
		const worker = new GeneratedMediaWorker({
			store: orderedStore,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection: authenticatedProtection,
			ingestor: createIngestor(),
			workerId: "prompt-boundary-worker",
		});

		await service.submit(scope, request);

		await expect(worker.processNext()).resolves.toBe(1);
		expect(provider.submissions).toBe(1);
	});

	test("cancels a queued job without contacting the provider", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});

		const submitted = await service.submit(scope, request);
		const cancelled = await service.cancel(scope, submitted.id);

		expect(cancelled.status).toBe("cancelled");
		expect(provider.submissions).toBe(0);
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 1 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("cancels atomically when cancellation wins the pre-submit checkpoint", async () => {
		const durableStore = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const racingStore: GeneratedMediaStore = {
			...durableStore,
			async beginSubmission(input) {
				await durableStore.requestCancellation({
					scope,
					jobId: input.claim.jobId,
					now: input.now,
					promptRetentionMs: 30 * 24 * 60 * 60 * 1000,
				});
				return durableStore.beginSubmission(input);
			},
		};
		const service = new GeneratedMediaService({
			store: racingStore,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store: racingStore,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "cancel-checkpoint-worker",
		});

		const submitted = await service.submit(scope, request);
		await worker.processNext();

		expect(provider.submissions).toBe(0);
		expect(await service.get(scope, submitted.id)).toMatchObject({
			status: "cancelled",
			errorCode: "generated_media_cancelled",
		});
	});

	test("polls asynchronous video without holding a worker claim", async () => {
		let now = new Date("2026-08-31T12:00:00.000Z");
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider("approved-video");
		provider.submit = async () => {
			provider.submissions += 1;
			return {
				state: "waiting",
				providerReference: "video-job-1",
				nextPollAt: new Date(now.getTime() + 5_000),
				moderation: { outcome: "passed" },
			};
		};
		provider.poll = async () => {
			provider.polls += 1;
			return {
				state: "completed",
				providerReference: "video-job-1",
				resultReference: "video-result-1",
				moderation: { outcome: "passed" },
				usage: { units: 6 },
			};
		};
		provider.retrieve = async () => ({
			kind: "inline",
			contentType: "video/mp4",
			bytes: new Uint8Array([0, 0, 0, 24]),
		});
		const videoConfig = {
			image: { enabled: false as const, reason: "image_disabled" },
			video: {
				enabled: true as const,
				provider: "approved-video",
				model: "configured-video-model",
				maxConcurrency: 1,
				usageUnits: 6,
				maxOutputBytes: 64 * 1024 * 1024,
				maxDurationSec: 8,
				supportedAspectRatios: ["9:16" as const],
			},
		};
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config: videoConfig,
			promptProtection,
			now: () => now,
		});
		const ingestor: GeneratedMediaAssetIngestor = {
			async ingest(input) {
				return {
					storageKey: input.storageKey,
					contentType: "video/mp4",
					sizeBytes: 4,
					width: 1080,
					height: 1920,
					durationSec: 8,
					hasAudio: true,
					videoCodec: "h264",
					audioCodec: "aac",
					fingerprint: "video-fingerprint",
				};
			},
		};
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config: videoConfig,
			promptProtection,
			ingestor,
			workerId: "video-worker",
			now: () => now,
		});
		const submitted = await service.submit(
			{ ...scope, pricingTier: "pro" },
			{
				...request,
				idempotencyKey: "00000000-0000-4000-8000-000000000099",
				kind: "video",
				durationSec: 8,
			},
		);

		expect(await worker.processNext()).toBe(1);
		expect((await service.get(scope, submitted.id)).status).toBe("waiting");
		expect(await worker.processNext()).toBe(0);
		now = new Date(now.getTime() + 5_000);
		expect(await worker.processNext()).toBe(1);

		expect(await service.get(scope, submitted.id)).toMatchObject({
			status: "completed",
		});
		expect(provider.submissions).toBe(1);
		expect(provider.polls).toBe(1);
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
			video: { reservedUnits: 0, finalizedUnits: 6, releasedUnits: 0 },
		});
	});

	test("validates video duration before reserving usage", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider("approved-video");
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config: {
				image: { enabled: false, reason: "image_disabled" },
				video: {
					enabled: true,
					provider: provider.alias,
					model: "configured-video-model",
					maxConcurrency: 1,
					usageUnits: 6,
					maxOutputBytes: 64 * 1024 * 1024,
					maxDurationSec: 8,
					supportedAspectRatios: ["9:16"],
				},
			},
			promptProtection,
		});

		await expect(
			service.submit(
				{ ...scope, pricingTier: "pro" },
				{ ...request, kind: "video", durationSec: 12 },
			),
		).rejects.toMatchObject({ code: "generated_media_not_configured" });
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("retries a provider-declared safe failure without double settlement", async () => {
		let now = new Date("2026-08-31T12:00:00.000Z");
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		provider.submit = async () => {
			provider.submissions += 1;
			if (provider.submissions === 1) {
				return {
					state: "failed",
					providerReference: null,
					errorCode: "generated_media_rate_limited",
					retry: "safe",
				};
			}
			return {
				state: "completed",
				providerReference: "provider-request-retry",
				resultReference: "provider-result-retry",
				moderation: { outcome: "passed" },
				usage: { units: 1 },
			};
		};
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			now: () => now,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "retry-worker",
			now: () => now,
			retryDelayMs: () => 5_000,
		});

		const submitted = await service.submit(scope, request);
		expect(await worker.processNext()).toBe(1);
		expect((await service.get(scope, submitted.id)).status).toBe("queued");
		expect(await worker.processNext()).toBe(0);
		now = new Date(now.getTime() + 5_000);
		expect(await worker.processNext()).toBe(1);

		expect(provider.submissions).toBe(2);
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 1, releasedUnits: 0 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("releases usage after provider-confirmed cancellation", async () => {
		let cancellations = 0;
		const now = new Date("2026-08-31T12:00:00.000Z");
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		provider.submit = async () => ({
			state: "waiting",
			providerReference: "async-image-1",
			nextPollAt: new Date(now.getTime() + 60_000),
			moderation: { outcome: "passed" },
		});
		provider.cancel = async () => {
			cancellations += 1;
			return { state: "cancelled" };
		};
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			now: () => now,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "cancel-worker",
			now: () => now,
		});

		const submitted = await service.submit(scope, request);
		await worker.processNext();
		await service.cancel(scope, submitted.id);
		await worker.processNext();

		expect(cancellations).toBe(1);
		expect((await service.get(scope, submitted.id)).status).toBe("cancelled");
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 1 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("adopts a late completion when provider cancellation is unsupported", async () => {
		const now = new Date("2026-08-31T12:00:00.000Z");
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		provider.submit = async () => ({
			state: "waiting",
			providerReference: "async-image-2",
			nextPollAt: new Date(now.getTime() + 60_000),
			moderation: { outcome: "passed" },
		});
		provider.poll = async () => ({
			state: "completed",
			providerReference: "async-image-2",
			resultReference: "provider-result-late",
			moderation: { outcome: "passed" },
			usage: { units: 1 },
		});
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			now: () => now,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "late-completion-worker",
			now: () => now,
		});

		const submitted = await service.submit(scope, request);
		await worker.processNext();
		await service.cancel(scope, submitted.id);
		await worker.processNext();

		expect((await service.get(scope, submitted.id)).status).toBe("completed");
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 1, releasedUnits: 0 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("backs off a transient poll without resubmitting the provider job", async () => {
		let now = new Date("2026-08-31T12:00:00.000Z");
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		provider.submit = async () => {
			provider.submissions += 1;
			return {
				state: "waiting",
				providerReference: "async-image-retry",
				nextPollAt: new Date(now.getTime() + 5_000),
				moderation: { outcome: "passed" },
			};
		};
		provider.poll = async () => {
			provider.polls += 1;
			if (provider.polls === 1) {
				return {
					state: "failed",
					providerReference: "async-image-retry",
					errorCode: "generated_media_rate_limited",
					retry: "safe",
				};
			}
			return {
				state: "completed",
				providerReference: "async-image-retry",
				resultReference: "provider-result-after-poll-retry",
				moderation: { outcome: "passed" },
				usage: { units: 1 },
			};
		};
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			now: () => now,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "poll-retry-worker",
			now: () => now,
			retryDelayMs: () => 5_000,
		});

		const submitted = await service.submit(scope, request);
		await worker.processNext();
		now = new Date(now.getTime() + 5_000);
		await worker.processNext();
		expect(await service.get(scope, submitted.id)).toMatchObject({
			status: "waiting",
			errorCode: "generated_media_rate_limited",
		});
		expect(await worker.processNext()).toBe(0);
		now = new Date(now.getTime() + 5_000);
		await worker.processNext();

		expect((await service.get(scope, submitted.id)).status).toBe("completed");
		expect(provider.submissions).toBe(1);
		expect(provider.polls).toBe(2);
	});

	test("resumes a staged asset after a database publication crash", async () => {
		let now = new Date("2026-08-31T12:00:00.000Z");
		const durableStore = createInMemoryGeneratedMediaStore();
		let crashPublication = true;
		const store: GeneratedMediaStore = {
			...durableStore,
			async publishAsset(input) {
				if (crashPublication) {
					crashPublication = false;
					throw new Error("database unavailable before publication");
				}
				return durableStore.publishAsset(input);
			},
		};
		const provider = createProvider();
		const ingestor = createIngestor();
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			now: () => now,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor,
			workerId: "recovery-worker",
			now: () => now,
			leaseMs: 1_000,
		});

		const submitted = await service.submit(scope, request);
		await expect(worker.processNext()).rejects.toThrow(
			"database unavailable before publication",
		);
		now = new Date(now.getTime() + 1_001);
		expect(await worker.processNext()).toBe(1);

		expect((await service.get(scope, submitted.id)).status).toBe("completed");
		expect(provider.submissions).toBe(1);
		expect(ingestor.ingestions).toBe(1);
		await expectSettlement(service, {
			image: { reservedUnits: 0, finalizedUnits: 1, releasedUnits: 0 },
			video: { reservedUnits: 0, finalizedUnits: 0, releasedUnits: 0 },
		});
	});

	test("emits sanitized completion and explicit insertion events", async () => {
		const completed: Parameters<GeneratedMediaEventSink["recordCompleted"]>[0][] = [];
		const inserted: Parameters<GeneratedMediaEventSink["recordInserted"]>[0][] = [];
		const events: GeneratedMediaEventSink = {
			async recordCompleted(event) {
				completed.push(event);
			},
			async recordInserted(event) {
				inserted.push(event);
			},
		};
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			events,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "analytics-worker",
			events,
		});

		const submitted = await service.submit(scope, request);
		await worker.processNext();
		await service.recordInsertion(scope, {
			jobId: submitted.id,
			kind: "scene_block",
		});

		expect(completed).toHaveLength(1);
		expect(inserted).toMatchObject([
			{ insertionAction: "scene_block", outcome: "succeeded" },
		]);
		const serialized = JSON.stringify({ completed, inserted });
		expect(serialized).not.toContain(request.prompt);
		expect(serialized).not.toContain(request.derivedContext);
		expect(serialized).not.toContain("url");
	});

	test("suppresses post-commit completion delivery for a transactional store", async () => {
		const durableStore = createInMemoryGeneratedMediaStore();
		const store: GeneratedMediaStore = {
			...durableStore,
			terminalAnalyticsDelivery: "transactional",
		};
		let completionCalls = 0;
		const provider = createProvider();
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "transactional-analytics-worker",
			events: {
				async recordCompleted() {
					completionCalls += 1;
				},
				async recordInserted() {},
			},
		});

		const submitted = await service.submit(scope, request);
		await expect(worker.processNext()).resolves.toBe(1);
		expect(completionCalls).toBe(0);
		expect((await service.get(scope, submitted.id)).status).toBe("completed");
	});

	test("does not swallow a non-transactional completion delivery failure", async () => {
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		const service = new GeneratedMediaService({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers: new Map([[provider.alias, provider]]),
			config,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "strict-analytics-worker",
			events: {
				async recordCompleted() {
					throw new Error("analytics unavailable");
				},
				async recordInserted() {},
			},
		});

		await service.submit(scope, request);
		await expect(worker.processNext()).rejects.toThrow("analytics unavailable");
	});

	test("enforces configured concurrency per workspace without blocking another tenant", async () => {
		const now = new Date("2026-08-31T12:00:00.000Z");
		const store = createInMemoryGeneratedMediaStore();
		const provider = createProvider();
		provider.submit = async () => {
			provider.submissions += 1;
			return {
				state: "waiting",
				providerReference: `async-image-${provider.submissions}`,
				nextPollAt: new Date(now.getTime() + 60_000),
				moderation: { outcome: "passed" },
			};
		};
		const boundedConfig = {
			...config,
			image: { ...config.image, maxConcurrency: 1 },
		};
		const providers = new Map([[provider.alias, provider]]);
		const service = new GeneratedMediaService({
			store,
			providers,
			config: boundedConfig,
			promptProtection,
			now: () => now,
		});
		const worker = new GeneratedMediaWorker({
			store,
			providers,
			config: boundedConfig,
			promptProtection,
			ingestor: createIngestor(),
			workerId: "concurrency-worker",
			now: () => now,
		});
		const first = await service.submit(scope, request);
		const second = await service.submit(scope, {
			...request,
			idempotencyKey: "00000000-0000-4000-8000-000000000011",
		});
		const otherScope = {
			...scope,
			workspaceId: "00000000-0000-4000-8000-000000000012",
		};
		const other = await service.submit(otherScope, {
			...request,
			idempotencyKey: "00000000-0000-4000-8000-000000000013",
		});

		expect(await worker.processNext()).toBe(1);
		expect(await worker.processNext()).toBe(1);

		expect((await service.get(scope, first.id)).status).toBe("waiting");
		expect((await service.get(scope, second.id)).status).toBe("queued");
		expect((await service.get(otherScope, other.id)).status).toBe("waiting");
		expect(provider.submissions).toBe(2);
	});
});
