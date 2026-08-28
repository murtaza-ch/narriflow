import { describe, expect, test } from "bun:test";
import {
	createDeterministicPublicationPlatform,
	createPublicationPlatformRegistry,
} from "./social-publication-platform";
import {
	createInMemorySocialPublicationAttemptStore,
	createSocialPublicationAttempt,
	PublicationClaimLostError,
	type PublicationAttemptSeed,
} from "./social-publication-attempt";

const seed: PublicationAttemptSeed = {
	socialPost: {
		id: "post-1",
		workspaceId: "workspace-1",
		projectId: "project-1",
		status: "publishing",
		scheduledFor: new Date("2026-08-28T10:00:00.000Z"),
	},
	frozen: {
		clipExportId: "export-1",
		clipExportVariantId: "variant-1",
		editorRevision: 7,
		exportFingerprint: "fingerprint-1",
		storageKey: "projects/project-1/exports/export-1/variant-1.mp4",
		sizeBytes: 42_000,
		aspectRatio: "9:16",
		caption: "Approved caption",
		providerSettings: {},
		socialAccountId: null,
		platform: "youtube_shorts",
		capabilityVersion: "deterministic-v1",
		scheduledFor: new Date("2026-08-28T10:00:00.000Z"),
	},
	attempt: {
		id: "attempt-1",
		attemptNumber: 1,
		priorAttemptId: null,
		idempotencyKey: "publication-attempt-1",
		phase: "claimed",
		outcome: null,
		nextActionAt: new Date("2026-08-28T10:00:00.000Z"),
		providerCallCount: 0,
		startedAt: new Date("2026-08-28T10:00:00.000Z"),
		processingDeadline: new Date("2026-08-29T10:00:00.000Z"),
		reconciliationDeadline: new Date("2026-08-30T10:00:00.000Z"),
	},
	claim: {
		id: "claim-1",
		claimantId: "worker-1",
		leaseExpiresAt: new Date("2026-08-28T10:01:00.000Z"),
		heartbeatAt: new Date("2026-08-28T10:00:00.000Z"),
	},
};

function createAttemptHarness(
	platform = createDeterministicPublicationPlatform([
		{
			kind: "accepted" as const,
			receipt: {
				receiptId: "provider-receipt-1",
				platformPostId: "provider-post-1",
				externalUrl: "https://social.example/provider-post-1",
				metrics: null,
			},
		},
	]),
	attemptSeed: PublicationAttemptSeed = seed,
	providerCallBudget = 12,
	retryOverrides: Partial<{
		maxAttempts: number;
		maxElapsedMs: number;
		baseDelayMs: number;
		maxDelayMs: number;
		jitterRatio: number;
	}> = {},
) {
	const store = createInMemorySocialPublicationAttemptStore([attemptSeed]);
	const diagnostics: Array<Record<string, unknown>> = [];
	const attempt = createSocialPublicationAttempt({
		store,
		platforms: createPublicationPlatformRegistry({ youtube_shorts: platform }),
		credentials: { load: async () => null },
		checkpointCipher: {
			seal: (value) => `sealed:${JSON.stringify(value)}`,
			open: (value) => JSON.parse(value.slice("sealed:".length)),
		},
		clock: { now: () => new Date("2026-08-28T10:00:10.000Z") },
		diagnostics: { record: (event) => diagnostics.push(event) },
		retry: {
			maxAttempts: 3,
			maxElapsedMs: 60 * 60_000,
			baseDelayMs: 30_000,
			maxDelayMs: 5 * 60_000,
			jitterRatio: 0,
			random: () => 0.5,
			...retryOverrides,
		},
		providerCallBudget,
		processingDeadlineMs: 60 * 60_000,
		reconciliationDeadlineMs: 2 * 60 * 60_000,
	});
	return { attempt, store, diagnostics };
}

describe("Social Publication Attempt", () => {
	test("atomically settles accepted evidence and replays without another provider call", async () => {
		let providerCalls = 0;
		const platform = createDeterministicPublicationPlatform([
			{
				kind: "accepted",
				receipt: {
					receiptId: "provider-receipt-1",
					platformPostId: "provider-post-1",
					externalUrl: "https://social.example/provider-post-1",
					metrics: null,
				},
			},
		]);
		const countedPlatform = {
			...platform,
			async publish(...args: Parameters<typeof platform.publish>) {
				providerCalls += 1;
				return platform.publish(...args);
			},
		};
		const { attempt, store } = createAttemptHarness(countedPlatform);
		const owned = { attemptId: "attempt-1", claimId: "claim-1" };

		const first = await attempt.execute({
			attempt: owned,
			signal: new AbortController().signal,
		});
		const replay = await attempt.execute({
			attempt: owned,
			signal: new AbortController().signal,
		});

		expect(first).toEqual({
			kind: "posted",
			attemptId: "attempt-1",
			socialPostId: "post-1",
			externalUrl: "https://social.example/provider-post-1",
		});
		expect(replay).toEqual(first);
		expect(providerCalls).toBe(1);
		expect(await store.inspect("attempt-1")).toMatchObject({
			attempt: { phase: "succeeded", outcome: "accepted" },
			socialPost: { status: "posted" },
			receipt: {
				receiptId: "provider-receipt-1",
				platformPostId: "provider-post-1",
			},
			analyticsIntent: { kind: "social_posted" },
			claim: null,
		});
	});

	test("a lost response after submission retains evidence for reconciliation", async () => {
		const platform = createDeterministicPublicationPlatform(
			[
				{
					kind: "accepted",
					receipt: {
						receiptId: "unreachable",
						platformPostId: "unreachable",
						externalUrl: null,
						metrics: null,
					},
				},
			],
			{ failurePoint: "after_submission" },
		);
		const { attempt, store } = createAttemptHarness(platform);

		await expect(
			attempt.execute({
				attempt: { attemptId: "attempt-1", claimId: "claim-1" },
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({
			kind: "reconciling",
			attemptId: "attempt-1",
			socialPostId: "post-1",
			nextActionAt: new Date("2026-08-28T10:00:40.000Z"),
		});
		const state = await store.inspect("attempt-1");
		expect(state).toMatchObject({
			attempt: { phase: "reconciling", outcome: "unknown" },
			socialPost: { status: "reconciling" },
			receipt: null,
			claim: null,
		});
		expect(JSON.stringify(state)).not.toContain('deterministic":true');
	});

	test("a reclaimed submitted attempt without recovery never republishes", async () => {
		let publishCalls = 0;
		const platform = {
			capabilities: {
				...createDeterministicPublicationPlatform([]).capabilities,
				recovery: "none" as const,
				idempotency: "none" as const,
			},
			async publish() {
				publishCalls += 1;
				throw new Error("must not publish");
			},
		};
		const recoveredSeed: PublicationAttemptSeed = {
			...seed,
			attempt: { ...seed.attempt, phase: "submission_started" },
			checkpointKind: "submission_started",
			sealedCheckpoint: 'sealed:{"providerOperation":"unrecoverable"}',
		};
		const { attempt, store } = createAttemptHarness(platform, recoveredSeed);

		await expect(
			attempt.execute({
				attempt: { attemptId: "attempt-1", claimId: "claim-1" },
				signal: new AbortController().signal,
			}),
		).resolves.toMatchObject({
			kind: "needs_attention",
			code: "publication_recovery_unavailable_after_submission",
		});
		expect(publishCalls).toBe(0);
		expect(await store.inspect("attempt-1")).toMatchObject({
			attempt: { phase: "needs_attention", outcome: "unknown" },
			socialPost: { status: "needs_attention" },
		});
	});

	test("a transient reconciliation failure preserves the durable operation", async () => {
		let publishCalls = 0;
		let reconcileCalls = 0;
		const platform = {
			capabilities: createDeterministicPublicationPlatform([]).capabilities,
			async publish() {
				publishCalls += 1;
				throw new Error("must not publish");
			},
			async reconcile() {
				reconcileCalls += 1;
				throw new Error("temporary receiver failure");
			},
		};
		const recoveredSeed: PublicationAttemptSeed = {
			...seed,
			socialPost: { ...seed.socialPost, status: "processing" },
			attempt: { ...seed.attempt, phase: "processing", outcome: "pending" },
			checkpointKind: "provider_processing",
			sealedCheckpoint: 'sealed:{"operationId":"provider-operation-1"}',
		};
		const { attempt, store } = createAttemptHarness(platform, recoveredSeed);

		await expect(
			attempt.execute({
				attempt: { attemptId: "attempt-1", claimId: "claim-1" },
				signal: new AbortController().signal,
			}),
		).resolves.toMatchObject({ kind: "reconciling" });
		expect(publishCalls).toBe(0);
		expect(reconcileCalls).toBe(1);
		expect(await store.inspect("attempt-1")).toMatchObject({
			attempt: { phase: "reconciling", outcome: "unknown" },
			socialPost: { status: "reconciling" },
		});
	});

	test("a stale claim cannot checkpoint or settle after takeover", async () => {
		const { attempt, store } = createAttemptHarness();
		await store.takeOver("attempt-1", {
			id: "claim-2",
			claimantId: "worker-2",
			heartbeatAt: new Date("2026-08-28T10:02:00.000Z"),
			leaseExpiresAt: new Date("2026-08-28T10:03:00.000Z"),
		});

		await expect(
			attempt.execute({
				attempt: { attemptId: "attempt-1", claimId: "claim-1" },
				signal: new AbortController().signal,
			}),
		).rejects.toBeInstanceOf(PublicationClaimLostError);
		expect(await store.inspect("attempt-1")).toMatchObject({
			attempt: { phase: "claimed", outcome: null },
			socialPost: { status: "publishing" },
			receipt: null,
			claim: { id: "claim-2" },
		});
	});

	test("releases pending provider work and reconciles the same operation", async () => {
		const platform = createDeterministicPublicationPlatform([
			{
				kind: "pending",
				receiptId: "provider-operation-1",
				operation: {
					kind: "provider_processing",
					state: { operationId: "provider-operation-1" },
				},
				nextCheckAt: new Date("2026-08-28T10:05:00.000Z"),
			},
			{
				kind: "accepted",
				receipt: {
					receiptId: "provider-operation-1",
					platformPostId: "provider-post-1",
					externalUrl: null,
					metrics: null,
				},
			},
		]);
		const { attempt, store } = createAttemptHarness(platform);

		expect(
			await attempt.execute({
				attempt: { attemptId: "attempt-1", claimId: "claim-1" },
				signal: new AbortController().signal,
			}),
		).toEqual({
			kind: "processing",
			attemptId: "attempt-1",
			socialPostId: "post-1",
			nextActionAt: new Date("2026-08-28T10:05:00.000Z"),
		});
		expect(await store.inspect("attempt-1")).toMatchObject({
			attempt: { phase: "processing", outcome: "pending" },
			socialPost: { status: "processing" },
			claim: null,
		});

		await store.takeOver("attempt-1", {
			id: "claim-2",
			claimantId: "worker-2",
			heartbeatAt: new Date("2026-08-28T10:05:00.000Z"),
			leaseExpiresAt: new Date("2026-08-28T10:06:00.000Z"),
		});
		expect(
			await attempt.execute({
				attempt: { attemptId: "attempt-1", claimId: "claim-2" },
				signal: new AbortController().signal,
			}),
		).toMatchObject({ kind: "posted", externalUrl: null });
	});

	test("never schedules a provider processing check beyond its deadline", async () => {
		const platform = createDeterministicPublicationPlatform([
			{
				kind: "pending",
				receiptId: "provider-operation-deadline",
				operation: {
					kind: "provider_processing",
					state: { operationId: "provider-operation-deadline" },
				},
				nextCheckAt: new Date("2026-08-28T10:05:00.000Z"),
			},
		]);
		const deadlineSeed: PublicationAttemptSeed = {
			...seed,
			attempt: {
				...seed.attempt,
				processingDeadline: new Date("2026-08-28T10:00:30.000Z"),
			},
		};
		const { attempt } = createAttemptHarness(platform, deadlineSeed);

		const result = await attempt.execute({
			attempt: { attemptId: "attempt-1", claimId: "claim-1" },
			signal: new AbortController().signal,
		});
		expect(result.kind).toBe("processing");
		if (result.kind !== "processing") throw new Error("expected processing");
		expect(result.nextActionAt.toISOString()).toBe(
			"2026-08-28T10:00:30.000Z",
		);
	});

	test("creates a linked bounded retry only for a definitive pre-submission failure", async () => {
		const platform = createDeterministicPublicationPlatform(
			[
				{
					kind: "accepted",
					receipt: {
						receiptId: "unreachable",
						platformPostId: null,
						externalUrl: null,
						metrics: null,
					},
				},
			],
			{ failurePoint: "before_submission" },
		);
		const { attempt, store, diagnostics } = createAttemptHarness(platform);

		const result = await attempt.execute({
			attempt: { attemptId: "attempt-1", claimId: "claim-1" },
			signal: new AbortController().signal,
		});

		expect(result).toEqual({
			kind: "retry_scheduled",
			attemptId: "attempt-1",
			socialPostId: "post-1",
			nextAttemptId: "attempt-2",
			nextActionAt: new Date("2026-08-28T10:00:40.000Z"),
		});
		expect(await store.inspect("attempt-1")).toMatchObject({
			attempt: {
				phase: "failed",
				outcome: "failed",
				failureDisposition: "safe_retry",
			},
			socialPost: {
				status: "scheduled",
				nextAttemptAt: new Date("2026-08-28T10:00:40.000Z"),
			},
			claim: null,
		});
		expect(await store.inspect("attempt-2")).toMatchObject({
			attempt: {
				attemptNumber: 2,
				priorAttemptId: "attempt-1",
				phase: "retry_scheduled",
				processingDeadline: new Date("2026-08-28T11:00:40.000Z"),
				reconciliationDeadline: new Date("2026-08-28T12:00:40.000Z"),
			},
			socialPost: { id: "post-1", status: "scheduled" },
		});
		expect(diagnostics.at(-1)).toMatchObject({
			message: "social_publication_attempt_failed",
			workspaceId: "workspace-1",
			platform: "youtube_shorts",
			phase: "retry_scheduled",
			operation: "publish",
			outcome: "retry_scheduled",
			disposition: "safe_retry",
			errorCode: "deterministic_before_submission",
			retryAt: "2026-08-28T10:00:40.000Z",
			elapsedMs: 0,
		});
	});

	test("does not schedule backoff beyond the retry lineage elapsed cap", async () => {
		const platform = createDeterministicPublicationPlatform(
			[
				{
					kind: "accepted",
					receipt: {
						receiptId: "unreachable",
						platformPostId: null,
						externalUrl: null,
						metrics: null,
					},
				},
			],
			{ failurePoint: "before_submission" },
		);
		const { attempt, store } = createAttemptHarness(platform, seed, 12, {
			maxElapsedMs: 15_000,
			baseDelayMs: 30_000,
		});

		await expect(
			attempt.execute({
				attempt: { attemptId: "attempt-1", claimId: "claim-1" },
				signal: new AbortController().signal,
			}),
		).resolves.toMatchObject({ kind: "failed" });
		expect(await store.inspect("attempt-2")).toBeNull();
	});

	test("bounds actual outbound provider calls within one execution", async () => {
		const platform = {
			capabilities: {
				...createDeterministicPublicationPlatform([]).capabilities,
				maxProviderCalls: 10,
			},
			async publish(
				_input: Parameters<
					ReturnType<typeof createDeterministicPublicationPlatform>["publish"]
				>[0],
				context: Parameters<
					ReturnType<typeof createDeterministicPublicationPlatform>["publish"]
				>[1],
			) {
				await context.providerCall?.();
				await context.providerCall?.();
				throw new Error("unreachable");
			},
		};
		const { attempt, store } = createAttemptHarness(platform, seed, 1);

		await expect(
			attempt.execute({
				attempt: { attemptId: "attempt-1", claimId: "claim-1" },
				signal: new AbortController().signal,
			}),
		).resolves.toMatchObject({
			kind: "failed",
			code: "publication_provider_call_budget_exhausted",
		});
		expect(await store.inspect("attempt-1")).toMatchObject({
			attempt: { providerCallCount: 1, phase: "failed" },
			socialPost: { status: "failed" },
		});
	});

	test("attention dispositions and unsafe retry claims become Needs attention", async () => {
		for (const scenario of [
			{ disposition: "attention" as const, checkpoint: false },
			{ disposition: "safe_retry" as const, checkpoint: true },
		]) {
			const platform = {
				capabilities: createDeterministicPublicationPlatform([]).capabilities,
				async publish(
					_input: Parameters<
						ReturnType<typeof createDeterministicPublicationPlatform>["publish"]
					>[0],
					context: Parameters<
						ReturnType<typeof createDeterministicPublicationPlatform>["publish"]
					>[1],
				) {
					if (scenario.checkpoint) {
						await context.checkpoint({
							kind: "submission_started",
							state: { request: "sent" },
						});
					}
					return {
						kind: "failed" as const,
						failure: {
							code: "receiver_requires_attention",
							phase: "submission" as const,
							disposition: scenario.disposition,
							retryAfterMs: null,
						},
					};
				},
			};
			const { attempt, store, diagnostics } = createAttemptHarness(platform);
			await expect(
				attempt.execute({
					attempt: { attemptId: "attempt-1", claimId: "claim-1" },
					signal: new AbortController().signal,
				}),
			).resolves.toMatchObject({
				kind: "needs_attention",
				code: "receiver_requires_attention",
			});
			expect(await store.inspect("attempt-1")).toMatchObject({
				attempt: { phase: "needs_attention" },
				socialPost: { status: "needs_attention" },
				claim: null,
			});
			expect(diagnostics.at(-1)).toMatchObject({
				phase: "needs_attention",
				outcome: "failed",
				disposition: "attention",
				errorCode: "receiver_requires_attention",
			});
		}
	});

	test("aborting owned work releases it without recording a provider failure", async () => {
		const controller = new AbortController();
		controller.abort();
		const { attempt, store } = createAttemptHarness();

		await expect(
			attempt.execute({
				attempt: { attemptId: "attempt-1", claimId: "claim-1" },
				signal: controller.signal,
			}),
		).resolves.toEqual({
			kind: "interrupted",
			attemptId: "attempt-1",
			socialPostId: "post-1",
		});
		expect(await store.inspect("attempt-1")).toMatchObject({
			attempt: { phase: "claimed", outcome: null },
			socialPost: { status: "publishing" },
			claim: null,
		});
	});
});
