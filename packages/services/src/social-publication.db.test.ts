import { randomUUID } from "node:crypto";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
	claimDueSocialPublicationAttempts,
	heartbeatSocialPublicationClaim,
	prismaSocialPublicationAttemptStore,
	PublicationClaimLostError,
	ProviderReceiptConflictError,
} from "./social-publication-attempt";
import {
	prismaPublicationSchedulingStore,
	PublicationIntentConflictError,
} from "./social-publication-scheduling";

const databaseUrl = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_URL;
const databaseSchema = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_SCHEMA;
const enabled =
	process.env.ALLOW_SOCIAL_PUBLICATION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

function assertSafeDatabase(url: string) {
	const parsed = new URL(url);
	const local =
		parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
	const namedTestDatabase = parsed.pathname.toLowerCase().includes("test");
	const isolatedSchema = databaseSchema?.startsWith("social_publication_test_");
	if (!local && !namedTestDatabase && !isolatedSchema) {
		throw new Error(
			"Social Publication DB tests require an isolated test database",
		);
	}
}

const claimConfig = {
	batchSize: 20,
	leaseMs: 60_000,
	processingDeadlineMs: 3_600_000,
	reconciliationDeadlineMs: 7_200_000,
	providerCallBudget: 12,
};

dbDescribe("Social Publication PostgreSQL invariants", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let previousGlobalPrisma: PrismaClient | undefined;
	const prismaGlobal = globalThis as unknown as {
		narriflowPrismaClient?: PrismaClient;
	};

	beforeAll(async () => {
		if (!databaseUrl)
			throw new Error("SOCIAL_PUBLICATION_TEST_DATABASE_URL is required");
		assertSafeDatabase(databaseUrl);
		pool = new Pool({ connectionString: databaseUrl, max: 12 });
		prisma = new PrismaClient({
			adapter: new PrismaPg(
				pool,
				databaseSchema ? { schema: databaseSchema } : undefined,
			),
			transactionOptions: { maxWait: 120_000, timeout: 120_000 },
		});
		previousGlobalPrisma = prismaGlobal.narriflowPrismaClient;
		prismaGlobal.narriflowPrismaClient = prisma;
	});

	afterAll(async () => {
		prismaGlobal.narriflowPrismaClient = previousGlobalPrisma;
		await prisma?.$disconnect();
		await pool?.end();
	});

	async function fixture() {
		const suffix = randomUUID();
		const user = await prisma.user.create({
			data: {
				clerkId: `social-publication-db-test:${suffix}`,
				primaryEmail: `social-${suffix}@example.test`,
			},
		});
		const workspace = await prisma.workspace.create({
			data: {
				name: "Social Publication DB test",
				ownerUserId: user.id,
				personalOwnerUserId: user.id,
			},
		});
		const project = await prisma.project.create({
			data: {
				title: "Publication fixture",
				sourceMediaUrl: "r2://test/source.mp4",
				userId: user.id,
				workspaceId: workspace.id,
				createdByUserId: user.id,
			},
		});
		const workflowRun = await prisma.workflowRun.create({
			data: {
				projectId: project.id,
				idempotencyKey: `social-publication:${suffix}`,
				stage: "clip_rendering",
				status: "completed",
				lifecycleVersion: 2,
			},
		});
		const clip = await prisma.clip.create({
			data: {
				projectId: project.id,
				workflowRunId: workflowRun.id,
				index: 0,
				startSec: 0,
				endSec: 30,
				hookText: "Publication test clip",
				reasoning: "Fixture",
				category: "hook",
				transcriptSlice: [],
				viralityScore: 80,
				hookStrengthScore: 80,
				emotionalIntensityScore: 70,
				pacingScore: 70,
				durationOptimalityScore: 80,
				tiktokScore: 80,
				youtubeScore: 80,
				instagramScore: 80,
				llmProvider: "test",
				llmModel: "test",
			},
		});
		const clipExport = await prisma.clipExport.create({
			data: {
				projectId: project.id,
				workspaceId: workspace.id,
				createdByUserId: user.id,
				clipId: clip.id,
				editorRevision: clip.editorRevision,
				fingerprint: `social-publication:${suffix}`,
				resolution: "1080p",
				watermark: false,
				status: "ready",
				progress: 100,
				completedAt: new Date(),
			},
		});
		const variant = await prisma.clipExportVariant.create({
			data: {
				exportId: clipExport.id,
				aspectRatio: "ratio_9_16",
				resolution: "1080p",
				watermark: false,
				status: "completed",
				storageKey: `tests/${suffix}.mp4`,
				sizeBytes: 1_024n,
				completedAt: new Date(),
			},
		});
		const firstAccount = await prisma.socialAccount.create({
			data: {
				userId: user.id,
				workspaceId: workspace.id,
				createdByUserId: user.id,
				platform: "youtube_shorts",
				providerAccountId: `youtube:${suffix}:1`,
				displayName: "First account",
				accessTokenEncrypted: "encrypted-test-token",
			},
		});
		const secondAccount = await prisma.socialAccount.create({
			data: {
				userId: user.id,
				workspaceId: workspace.id,
				createdByUserId: user.id,
				platform: "youtube_shorts",
				providerAccountId: `youtube:${suffix}:2`,
				displayName: "Second account",
				accessTokenEncrypted: "encrypted-test-token",
			},
		});
		return {
			user,
			workspace,
			project,
			clip,
			clipExport,
			variant,
			firstAccount,
			secondAccount,
		};
	}

	function frozenCandidate(
		fixture: Awaited<ReturnType<typeof fixture>>,
		input: {
			id: string;
			key: string;
			hash: string;
			accountId: string;
			scheduledFor: Date;
		},
	) {
		return {
			id: input.id,
			workspaceId: fixture.workspace.id,
			ownerUserId: fixture.user.id,
			projectId: fixture.project.id,
			clipId: fixture.clip.id,
			clientIdempotencyKey: input.key,
			immutableRequestHash: input.hash,
			status: "scheduled" as const,
			submissionEligible: true,
			createdAt: new Date(),
			frozen: {
				id: randomUUID(),
				socialPostId: input.id,
				clipExportId: fixture.clipExport.id,
				clipExportVariantId: fixture.variant.id,
				socialAccountId: input.accountId,
				platform: "youtube_shorts" as const,
				editorRevision: fixture.clip.editorRevision,
				exportFingerprint: fixture.clipExport.fingerprint,
				storageKey: fixture.variant.storageKey,
				sizeBytes: Number(fixture.variant.sizeBytes),
				aspectRatio: "9:16" as const,
				caption: "Frozen caption",
				providerSettings: {},
				capabilityVersion: "youtube-v1",
				scheduledFor: input.scheduledFor,
			},
		};
	}

	test("concurrent scheduling replays one frozen intent and rejects key drift", async () => {
		const f = await fixture();
		const id = randomUUID();
		const key = randomUUID();
		const hash = "frozen-request-hash";
		const scheduledFor = new Date(Date.now() + 3_600_000);
		const candidate = frozenCandidate(f, {
			id,
			key,
			hash,
			accountId: f.firstAccount.id,
			scheduledFor,
		});
		const open = () =>
			prismaPublicationSchedulingStore.open({
				workspaceId: f.workspace.id,
				clientIdempotencyKey: key,
				immutableRequestHash: hash,
				create: async () => candidate,
			});

		const [first, second] = await Promise.all([open(), open()]);
		expect(first.id).toBe(id);
		expect(second.id).toBe(id);
		expect(
			await prisma.socialPost.count({
				where: { workspaceId: f.workspace.id, clientIdempotencyKey: key },
			}),
		).toBe(1);
		expect(
			await prisma.frozenPublicationState.count({
				where: { socialPostId: id },
			}),
		).toBe(1);
		await expect(
			prismaPublicationSchedulingStore.open({
				workspaceId: f.workspace.id,
				clientIdempotencyKey: key,
				immutableRequestHash: "changed-request-hash",
				create: async () => ({
					...candidate,
					immutableRequestHash: "changed-request-hash",
				}),
			}),
		).rejects.toBeInstanceOf(PublicationIntentConflictError);
	});

	test("claims one pre-submission slot per account while unrelated accounts progress", async () => {
		const f = await fixture();
		const now = new Date();
		const dueOffsetsMs = [-300_000, -160_000, -20_000];
		for (const [index, accountId] of [
			f.firstAccount.id,
			f.firstAccount.id,
			f.secondAccount.id,
		].entries()) {
			const id = randomUUID();
			const candidate = frozenCandidate(f, {
				id,
				key: randomUUID(),
				hash: `claim-hash-${index}`,
				accountId,
				scheduledFor: new Date(now.getTime() + dueOffsetsMs[index]!),
			});
			await prismaPublicationSchedulingStore.open({
				workspaceId: f.workspace.id,
				clientIdempotencyKey: candidate.clientIdempotencyKey,
				immutableRequestHash: candidate.immutableRequestHash,
				create: async () => candidate,
			});
		}

		const claimedBatches = await Promise.all([
			claimDueSocialPublicationAttempts({
				claimantId: "worker-a",
				now,
				config: claimConfig,
			}),
			claimDueSocialPublicationAttempts({
				claimantId: "worker-b",
				now,
				config: claimConfig,
			}),
		]);
		const claims = claimedBatches.flat();
		expect(new Set(claims.map((claim) => claim.attemptId)).size).toBe(2);
		const activeClaims = await prisma.publicationClaim.findMany({
			where: { releasedAt: null },
			select: { accountSlotKey: true },
		});
		expect(activeClaims).toHaveLength(2);
		expect(
			new Set(activeClaims.map((claim) => claim.accountSlotKey)).size,
		).toBe(2);
		const createdAttempt = await prisma.socialPublicationAttempt.findFirstOrThrow({
			where: { id: claims[0]!.attemptId },
			select: { processingDeadline: true, reconciliationDeadline: true },
		});
		expect(createdAttempt.processingDeadline).toEqual(
			new Date(now.getTime() + claimConfig.processingDeadlineMs),
		);
		expect(createdAttempt.reconciliationDeadline).toEqual(
			new Date(now.getTime() + claimConfig.reconciliationDeadlineMs),
		);
	});

	test("receipt settlement is atomic, replayable, conflict-safe, and fences stale claims", async () => {
		const f = await fixture();
		const now = new Date();
		const id = randomUUID();
		const candidate = frozenCandidate(f, {
			id,
			key: randomUUID(),
			hash: "receipt-hash",
			accountId: f.firstAccount.id,
			scheduledFor: new Date(now.getTime() - 1_000),
		});
		await prismaPublicationSchedulingStore.open({
			workspaceId: f.workspace.id,
			clientIdempotencyKey: candidate.clientIdempotencyKey,
			immutableRequestHash: candidate.immutableRequestHash,
			create: async () => candidate,
		});
		const [owned] = await claimDueSocialPublicationAttempts({
			claimantId: "receipt-worker",
			now,
			config: claimConfig,
		});
		if (!owned) throw new Error("expected claim");
		const accepted = {
			kind: "accepted" as const,
			receipt: {
				receiptId: "provider-operation-1",
				platformPostId: "provider-post-1",
				externalUrl: "https://provider.example/posts/1",
				metrics: {
					views: 10,
					likes: 2,
					comments: 1,
					shares: 0,
					saves: 3,
					watchTimeSeconds: 42,
				},
			},
		};

		const settled = await prismaSocialPublicationAttemptStore.settleAccepted({
			owned,
			result: accepted,
			now,
		});
		expect(settled.kind).toBe("posted");
		expect(
			(await prisma.socialPost.findUniqueOrThrow({ where: { id } })).status,
		).toBe("posted");
		expect(
			await prisma.providerReceipt.count({
				where: { attemptId: owned.attemptId },
			}),
		).toBe(1);
		expect(
			await prisma.publicationAnalyticsIntent.count({
				where: { attemptId: owned.attemptId },
			}),
		).toBe(1);
		expect(
			await prisma.projectAnalyticsEvent.count({
				where: { projectId: f.project.id, type: "social_posted" },
			}),
		).toBe(1);
		expect(await prisma.socialPostMetric.count({ where: { postId: id } })).toBe(
			1,
		);
		await expect(
			prismaSocialPublicationAttemptStore.settleAccepted({
				owned,
				result: accepted,
				now,
			}),
		).resolves.toMatchObject({ kind: "posted", socialPostId: id });
		await expect(
			prismaSocialPublicationAttemptStore.settleAccepted({
				owned,
				result: {
					...accepted,
					receipt: { ...accepted.receipt, receiptId: "conflict" },
				},
				now,
			}),
		).rejects.toBeInstanceOf(ProviderReceiptConflictError);
		await expect(
			prismaSocialPublicationAttemptStore.checkpoint({
				owned,
				operationKind: "submission_started",
				sealedState: "sealed",
				now,
			}),
		).rejects.toBeInstanceOf(PublicationClaimLostError);
	});

	test("a provider receipt cannot settle two attempts and the losing transaction rolls back", async () => {
		const f = await fixture();
		const now = new Date();
		const firstPostId = randomUUID();
		const secondPostId = randomUUID();
		const candidates = [
			frozenCandidate(f, {
				id: firstPostId,
				key: randomUUID(),
				hash: "shared-receipt-first",
				accountId: f.firstAccount.id,
				scheduledFor: new Date(now.getTime() - 2_000),
			}),
			frozenCandidate(f, {
				id: secondPostId,
				key: randomUUID(),
				hash: "shared-receipt-second",
				accountId: f.secondAccount.id,
				scheduledFor: new Date(now.getTime() - 1_000),
			}),
		];
		for (const candidate of candidates) {
			await prismaPublicationSchedulingStore.open({
				workspaceId: f.workspace.id,
				clientIdempotencyKey: candidate.clientIdempotencyKey,
				immutableRequestHash: candidate.immutableRequestHash,
				create: async () => candidate,
			});
		}
		const claims = await claimDueSocialPublicationAttempts({
			claimantId: "shared-receipt-worker",
			now,
			config: claimConfig,
		});
		const attempts = await prisma.socialPublicationAttempt.findMany({
			where: { socialPostId: { in: [firstPostId, secondPostId] } },
			select: { id: true, socialPostId: true },
		});
		const claimFor = (socialPostId: string) => {
			const attempt = attempts.find((row) => row.socialPostId === socialPostId);
			const claim = claims.find((row) => row.attemptId === attempt?.id);
			if (!claim) throw new Error(`expected claim for ${socialPostId}`);
			return claim;
		};
		const accepted = {
			kind: "accepted" as const,
			receipt: {
				receiptId: "provider-shared-operation",
				platformPostId: "provider-shared-post",
				externalUrl: "https://provider.example/posts/shared",
			},
		};

		await prismaSocialPublicationAttemptStore.settleAccepted({
			owned: claimFor(firstPostId),
			result: accepted,
			now,
		});
		const losingClaim = claimFor(secondPostId);
		await expect(
			prismaSocialPublicationAttemptStore.settleAccepted({
				owned: losingClaim,
				result: accepted,
				now,
			}),
		).rejects.toBeInstanceOf(ProviderReceiptConflictError);

		expect(
			await prisma.providerReceipt.count({
				where: {
					platform: "youtube_shorts",
					receiptId: accepted.receipt.receiptId,
				},
			}),
		).toBe(1);
		const losingAttempt =
			await prisma.socialPublicationAttempt.findUniqueOrThrow({
				where: { id: losingClaim.attemptId },
			});
		expect(losingAttempt.phase).toBe("claimed");
		expect(losingAttempt.currentClaimId).toBe(losingClaim.claimId);
		expect(
			(
				await prisma.socialPost.findUniqueOrThrow({
					where: { id: secondPostId },
				})
			).status,
		).toBe("publishing");
		expect(
			await prisma.publicationAnalyticsIntent.count({
				where: { attemptId: losingClaim.attemptId },
			}),
		).toBe(0);
	});

	test("a safe pre-submission failure creates bounded linked retry lineage", async () => {
		const f = await fixture();
		const now = new Date();
		const id = randomUUID();
		const candidate = frozenCandidate(f, {
			id,
			key: randomUUID(),
			hash: "retry-hash",
			accountId: f.firstAccount.id,
			scheduledFor: new Date(now.getTime() - 1_000),
		});
		await prismaPublicationSchedulingStore.open({
			workspaceId: f.workspace.id,
			clientIdempotencyKey: candidate.clientIdempotencyKey,
			immutableRequestHash: candidate.immutableRequestHash,
			create: async () => candidate,
		});
		const claims = await claimDueSocialPublicationAttempts({
			claimantId: "retry-worker",
			now,
			config: { ...claimConfig, batchSize: 100 },
		});
		const attempt = await prisma.socialPublicationAttempt.findFirstOrThrow({
			where: { socialPostId: id },
			select: { id: true },
		});
		const owned = claims.find((claim) => claim.attemptId === attempt.id);
		if (!owned) throw new Error("expected claim");

		const result = await prismaSocialPublicationAttemptStore.settleFailed({
			owned,
			code: "provider_rate_limited",
			phase: "preparation",
			disposition: "safe_retry",
			retryAfterMs: null,
			submissionMayHaveStarted: false,
			now,
			retry: {
				maxAttempts: 3,
				maxElapsedMs: 3_600_000,
				baseDelayMs: 1_000,
				maxDelayMs: 10_000,
				jitterRatio: 0,
				random: () => 0.5,
			},
			processingDeadlineMs: claimConfig.processingDeadlineMs,
			reconciliationDeadlineMs: claimConfig.reconciliationDeadlineMs,
		});
		expect(result.kind).toBe("retry_scheduled");
		if (result.kind !== "retry_scheduled") throw new Error("expected retry");
		const retry = await prisma.socialPublicationAttempt.findUniqueOrThrow({
			where: { id: result.nextAttemptId },
		});
		expect(retry.priorAttemptId).toBe(owned.attemptId);
		expect(retry.attemptNumber).toBe(2);
		expect(retry.idempotencyKey).not.toBe(`publication:${id}:1`);
		expect(retry.processingDeadline).toEqual(
			new Date(result.nextActionAt.getTime() + claimConfig.processingDeadlineMs),
		);
		expect(retry.reconciliationDeadline).toEqual(
			new Date(
				result.nextActionAt.getTime() + claimConfig.reconciliationDeadlineMs,
			),
		);
		expect(
			(await prisma.socialPost.findUniqueOrThrow({ where: { id } })).status,
		).toBe("scheduled");

		const secondClaims = await claimDueSocialPublicationAttempts({
			claimantId: "retry-worker-second-attempt",
			now: result.nextActionAt,
			config: { ...claimConfig, batchSize: 100 },
		});
		const secondOwned = secondClaims.find(
			(claim) => claim.attemptId === result.nextAttemptId,
		);
		if (!secondOwned) throw new Error("expected linked retry claim");
		await expect(
			prismaSocialPublicationAttemptStore.settleFailed({
				owned: secondOwned,
				code: "provider_rate_limited_again",
				phase: "preparation",
				disposition: "safe_retry",
				retryAfterMs: 10_000,
				submissionMayHaveStarted: false,
				now: result.nextActionAt,
				retry: {
					maxAttempts: 3,
					maxElapsedMs: 1_500,
					baseDelayMs: 1_000,
					maxDelayMs: 10_000,
					jitterRatio: 0,
					random: () => 0.5,
				},
				processingDeadlineMs: claimConfig.processingDeadlineMs,
				reconciliationDeadlineMs: claimConfig.reconciliationDeadlineMs,
			}),
		).resolves.toMatchObject({ kind: "failed" });
		expect(
			await prisma.socialPublicationAttempt.count({
				where: { socialPostId: id },
			}),
		).toBe(2);
	});

	test("heartbeat extension fences takeover until expiry and stale owners stay fenced", async () => {
		const f = await fixture();
		const now = new Date("2026-08-28T10:00:00.000Z");
		const id = randomUUID();
		const candidate = frozenCandidate(f, {
			id,
			key: randomUUID(),
			hash: "heartbeat-hash",
			accountId: f.firstAccount.id,
			scheduledFor: new Date(now.getTime() - 1_000),
		});
		await prismaPublicationSchedulingStore.open({
			workspaceId: f.workspace.id,
			clientIdempotencyKey: candidate.clientIdempotencyKey,
			immutableRequestHash: candidate.immutableRequestHash,
			create: async () => candidate,
		});
		const firstClaims = await claimDueSocialPublicationAttempts({
			claimantId: "heartbeat-worker-a",
			now,
			config: claimConfig,
		});
		const attempt = await prisma.socialPublicationAttempt.findFirstOrThrow({
			where: { socialPostId: id },
		});
		const first = firstClaims.find((claim) => claim.attemptId === attempt.id);
		if (!first) throw new Error("expected first claim");
		const heartbeatAt = new Date(now.getTime() + 30_000);
		await prismaSocialPublicationAttemptStore.loadOwned(first, now);
		await heartbeatSocialPublicationClaim({
			owned: first,
			now: heartbeatAt,
			leaseMs: 60_000,
		});

		const early = await claimDueSocialPublicationAttempts({
			claimantId: "heartbeat-worker-b",
			now: new Date(now.getTime() + 61_000),
			config: claimConfig,
		});
		expect(early.some((claim) => claim.attemptId === attempt.id)).toBe(false);
		const takeoverAt = new Date(now.getTime() + 91_000);
		const replacementClaims = await claimDueSocialPublicationAttempts({
			claimantId: "heartbeat-worker-b",
			now: takeoverAt,
			config: claimConfig,
		});
		const replacement = replacementClaims.find(
			(claim) => claim.attemptId === attempt.id,
		);
		if (!replacement) throw new Error("expected replacement claim");
		expect(replacement.claimId).not.toBe(first.claimId);
		await expect(
			heartbeatSocialPublicationClaim({
				owned: first,
				now: takeoverAt,
				leaseMs: 60_000,
			}),
		).rejects.toBeInstanceOf(PublicationClaimLostError);
		await expect(
			heartbeatSocialPublicationClaim({
				owned: replacement,
				now: takeoverAt,
				leaseMs: 60_000,
			}),
		).resolves.toBeUndefined();
	});

	test("cancellation and claim admission cannot resurrect a cancelled Social Post", async () => {
		const f = await fixture();
		const now = new Date();
		const id = randomUUID();
		const candidate = frozenCandidate(f, {
			id,
			key: randomUUID(),
			hash: "cancel-race-hash",
			accountId: f.firstAccount.id,
			scheduledFor: new Date(now.getTime() - 1_000),
		});
		await prismaPublicationSchedulingStore.open({
			workspaceId: f.workspace.id,
			clientIdempotencyKey: candidate.clientIdempotencyKey,
			immutableRequestHash: candidate.immutableRequestHash,
			create: async () => candidate,
		});

		await Promise.allSettled([
			prismaPublicationSchedulingStore.cancel({
				workspaceId: f.workspace.id,
				postId: id,
				now,
			}),
			claimDueSocialPublicationAttempts({
				claimantId: "cancel-race-worker",
				now,
				config: claimConfig,
			}),
		]);
		const post = await prisma.socialPost.findUniqueOrThrow({ where: { id } });
		expect(["cancelled", "publishing"]).toContain(post.status);
		if (post.status === "cancelled") {
			expect(
				await prisma.socialPublicationAttempt.count({
					where: { socialPostId: id },
				}),
			).toBe(0);
			expect(
				await prisma.publicationClaim.count({
					where: { attempt: { socialPostId: id } },
				}),
			).toBe(0);
		}
	});

	test("keyset scanning reaches an unrelated account beyond several blocked pages", async () => {
		const f = await fixture();
		const now = new Date("2026-08-28T10:00:00.000Z");
		const base = new Date("2020-01-01T00:00:00.000Z");
		const blocked = Array.from({ length: 45 }, (_, index) => ({
			postId: randomUUID(),
			frozenId: randomUUID(),
			attemptId: randomUUID(),
			index,
		}));
		const unrelated = {
			postId: randomUUID(),
			frozenId: randomUUID(),
			attemptId: randomUUID(),
		};
		await prisma.$transaction(async (tx) => {
			await tx.socialPost.createMany({
				data: [
					...blocked.map((row, index) => ({
						id: row.postId,
						projectId: f.project.id,
						workspaceId: f.workspace.id,
						createdByUserId: f.user.id,
						clipId: f.clip.id,
						socialAccountId: f.firstAccount.id,
						platform: "youtube_shorts" as const,
						status: "publishing" as const,
						clientIdempotencyKey: randomUUID(),
						immutableRequestHash: `fairness-blocked-${index}`,
						caption: `Fairness blocked ${index}`,
						aspectRatio: "ratio_9_16" as const,
						scheduledFor: base,
					})),
					{
						id: unrelated.postId,
						projectId: f.project.id,
						workspaceId: f.workspace.id,
						createdByUserId: f.user.id,
						clipId: f.clip.id,
						socialAccountId: f.secondAccount.id,
						platform: "youtube_shorts" as const,
						status: "publishing" as const,
						clientIdempotencyKey: randomUUID(),
						immutableRequestHash: "fairness-unrelated",
						caption: "Fairness unrelated",
						aspectRatio: "ratio_9_16" as const,
						scheduledFor: base,
					},
				],
			});
			await tx.frozenPublicationState.createMany({
				data: [
					...blocked.map((row) => ({
						id: row.frozenId,
						socialPostId: row.postId,
						clipExportId: f.clipExport.id,
						clipExportVariantId: f.variant.id,
						socialAccountId: f.firstAccount.id,
						platform: "youtube_shorts" as const,
						editorRevision: f.clip.editorRevision,
						exportFingerprint: f.clipExport.fingerprint,
						storageKey: f.variant.storageKey,
						sizeBytes: f.variant.sizeBytes,
						aspectRatio: "ratio_9_16" as const,
						caption: "Frozen fairness fixture",
						providerSettings: {},
						capabilityVersion: "youtube-v1",
						scheduledFor: base,
						mediaReadyAt: base,
					})),
					{
						id: unrelated.frozenId,
						socialPostId: unrelated.postId,
						clipExportId: f.clipExport.id,
						clipExportVariantId: f.variant.id,
						socialAccountId: f.secondAccount.id,
						platform: "youtube_shorts" as const,
						editorRevision: f.clip.editorRevision,
						exportFingerprint: f.clipExport.fingerprint,
						storageKey: f.variant.storageKey,
						sizeBytes: f.variant.sizeBytes,
						aspectRatio: "ratio_9_16" as const,
						caption: "Frozen unrelated fixture",
						providerSettings: {},
						capabilityVersion: "youtube-v1",
						scheduledFor: base,
						mediaReadyAt: base,
					},
				],
			});
			await tx.socialPublicationAttempt.createMany({
				data: [
					...blocked.map((row, index) => ({
						id: row.attemptId,
						socialPostId: row.postId,
						frozenStateId: row.frozenId,
						attemptNumber: 1,
						idempotencyKey: `fairness-blocked-${row.attemptId}`,
						phase: "claimed" as const,
						nextActionAt: new Date(base.getTime() + index),
						processingDeadline: new Date(now.getTime() + 3_600_000),
						reconciliationDeadline: new Date(now.getTime() + 7_200_000),
					})),
					{
						id: unrelated.attemptId,
						socialPostId: unrelated.postId,
						frozenStateId: unrelated.frozenId,
						attemptNumber: 1,
						idempotencyKey: `fairness-unrelated-${unrelated.attemptId}`,
						phase: "claimed" as const,
						nextActionAt: new Date(base.getTime() + blocked.length + 1),
						processingDeadline: new Date(now.getTime() + 3_600_000),
						reconciliationDeadline: new Date(now.getTime() + 7_200_000),
					},
				],
			});
			const claimId = randomUUID();
			await tx.publicationClaim.create({
				data: {
					id: claimId,
					attemptId: blocked[0]!.attemptId,
					claimantId: "fairness-blocker",
					accountSlotKey: f.firstAccount.id,
					heartbeatAt: now,
					leaseExpiresAt: new Date(now.getTime() + 60_000),
				},
			});
			await tx.socialPublicationAttempt.update({
				where: { id: blocked[0]!.attemptId },
				data: { currentClaimId: claimId },
			});
		});

		const claims = await claimDueSocialPublicationAttempts({
			claimantId: "fairness-worker",
			now,
			config: { ...claimConfig, batchSize: 2 },
		});
		expect(
			claims.some((claim) => claim.attemptId === unrelated.attemptId),
		).toBe(true);
	});
});
