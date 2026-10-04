import { createHmac, randomUUID } from "node:crypto";
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
	publicationOperationLookupHash,
} from "./social-publication-attempt";
import { PublicationIntentConflictError, PublicationIntentStateError } from "./social-publication-scheduling";
import { createProductionSocialPublicationScheduling, prismaPublicationSchedulingStore } from "./social-publication-scheduling-runtime";
import { socialService } from "./social.service";
import {
	socialPublicationRecovery,
	SocialPublicationRecoveryError,
} from "./social-publication-recovery";
import { acceptTikTokPublicationWebhook } from "./social-publication-tiktok-webhook";
import { createProductionReviewApprovalGate } from "./review-approval-gate.prisma";

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
		await prisma.workspaceMember.create({
			data: {
				workspaceId: workspace.id,
				userId: user.id,
				role: "owner",
			},
		});
		const project = await prisma.project.create({
			data: {
				title: "Publication fixture",
				sourceMediaUrl: "r2://test/source.mp4",

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
				durationSec: 30,
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
			createdByUserId: fixture.user.id,
			workspaceId: fixture.workspace.id,
			projectId: fixture.project.id,
			clipId: fixture.clip.id,
			clientIdempotencyKey: input.key,
			immutableRequestHash: input.hash,
			status: "scheduled" as const,
			submissionEligible: true,
			reviewApprovalOverrideId: null,
			createdAt: new Date(),
			updatedAt: new Date(),
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
				durationSec: fixture.variant.durationSec,
				aspectRatio: "9:16" as const,
				caption: "Frozen caption",
				providerSettings: {},
				capabilityVersion: "youtube-v1",
				scheduledFor: input.scheduledFor,
			},
		};
	}

	async function attentionPublication(
		f: Awaited<ReturnType<typeof fixture>>,
		label: string,
	) {
		const now = new Date();
		const socialPostId = randomUUID();
		const candidate = frozenCandidate(f, {
			id: socialPostId,
			key: randomUUID(),
			hash: `attention-${label}`,
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
			claimantId: `attention-${label}`,
			now,
			config: claimConfig,
		});
		const attempt = await prisma.socialPublicationAttempt.findFirstOrThrow({
			where: { socialPostId },
		});
		const claim = claims.find((row) => row.attemptId === attempt.id);
		if (!claim) throw new Error("expected attention fixture claim");
		await prisma.$transaction([
			prisma.socialPublicationAttempt.update({
				where: { id: attempt.id },
				data: {
					phase: "needs_attention",
					outcome: "unknown",
					failureCode: "publication_outcome_unknown",
					failureDisposition: "attention",
					operationLookupHash: publicationOperationLookupHash(
						`attention:${socialPostId}`,
					),
					terminalAt: now,
					currentClaimId: null,
				},
			}),
			prisma.socialPost.update({
				where: { id: socialPostId },
				data: {
					status: "needs_attention",
					errorCode: "publication_outcome_unknown",
					errorDisposition: "attention",
					nextAttemptAt: null,
				},
			}),
			prisma.publicationClaim.delete({ where: { id: claim.claimId } }),
		]);
		return { socialPostId, attemptId: attempt.id, now };
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

	test("replays a concurrent committed intent after mutable admission rejects", async () => {
		const f = await fixture();
		const candidate = frozenCandidate(f, { id: randomUUID(), key: randomUUID(), hash: "mutable-race", accountId: f.firstAccount.id, scheduledFor: new Date(Date.now() + 3_600_000) });
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const continueFailure = new Promise<void>((resolve) => { release = resolve; });
		const request = { workspaceId: f.workspace.id, clientIdempotencyKey: candidate.clientIdempotencyKey, immutableRequestHash: candidate.immutableRequestHash };
		const rejected = prismaPublicationSchedulingStore.open({ ...request, create: async () => {
			entered();
			await continueFailure;
			throw new PublicationIntentStateError("editor_revision_conflict", "Revision changed during concurrent freeze");
		} });
		await started;
		const committed = await prismaPublicationSchedulingStore.open({ ...request, create: async () => candidate });
		release();
		expect(await rejected).toEqual(committed);
		expect(await prisma.socialPost.count({ where: { workspaceId: f.workspace.id, clientIdempotencyKey: candidate.clientIdempotencyKey } })).toBe(1);
	});

	test("replays every advanced post state without refreezing or reopening eligibility", async () => {
		const f = await fixture();
		const candidate = frozenCandidate(f, { id: randomUUID(), key: randomUUID(), hash: "advanced-replay", accountId: f.firstAccount.id, scheduledFor: new Date(Date.now() + 3_600_000) });
		const request = { workspaceId: f.workspace.id, clientIdempotencyKey: candidate.clientIdempotencyKey, immutableRequestHash: candidate.immutableRequestHash };
		const first = await prismaPublicationSchedulingStore.open({ ...request, create: async () => candidate });
		for (const status of ["publishing", "processing", "reconciling", "posted", "failed", "needs_attention", "inbox_delivered", "cancelled"] as const) {
			await prisma.socialPost.update({ where: { id: first.id }, data: { status } });
			const replay = await prismaPublicationSchedulingStore.open({ ...request, create: async () => { throw new Error("Committed post must not refreeze"); } });
			expect(replay).toMatchObject({ id: first.id, status, submissionEligible: false, frozen: first.frozen });
			expect(await prisma.socialPost.findUniqueOrThrow({ where: { id: first.id }, select: { status: true } })).toEqual({ status });
		}
		expect(await prisma.frozenPublicationState.count({ where: { socialPostId: first.id } })).toBe(1);
	});

	test("production admission replays before changed project, revision, account and elapsed schedule", async () => {
		const f = await fixture();
		const admission = createProductionSocialPublicationScheduling();
		const input = {
			actorUserId: f.user.id, workspaceId: f.workspace.id, projectId: f.project.id,
			clientIdempotencyKey: randomUUID(), clipId: f.clip.id, expectedEditorRevision: f.clip.editorRevision,
			clipExportId: f.clipExport.id, clipExportVariantId: f.variant.id, accountId: f.firstAccount.id,
			platform: "youtube_shorts" as const, caption: "Replay exact content", aspectRatio: "9:16" as const,
			resolution: "1080p" as const, scheduledFor: new Date(Date.now() - 60_000), immediate: true, providerSettings: {},
		};
		const first = await admission.schedule(input);
		await prisma.$transaction([
			prisma.clip.update({ where: { id: f.clip.id }, data: { editorRevision: { increment: 1 } } }),
			prisma.socialAccount.update({ where: { id: f.firstAccount.id }, data: { status: "expired", expiresAt: new Date(Date.now() - 60_000) } }),
			prisma.project.update({ where: { id: f.project.id }, data: { expiresAt: new Date(Date.now() - 60_000) } }),
			prisma.socialPost.update({ where: { id: first.id }, data: { status: "posted" } }),
		]);
		const replay = await admission.schedule(input);
		expect(replay).toMatchObject({ id: first.id, status: "posted", submissionEligible: false, frozen: first.frozen });
		await expect(admission.schedule({ ...input, deliveryMode: "tiktok_inbox" })).rejects.toBeInstanceOf(PublicationIntentConflictError);
	});

	test("production admission records the editor and preserves that creator across another editor and owner changes", async () => {
		const f = await fixture();
		const editor = await prisma.user.create({ data: { clerkId: `publication-editor:${randomUUID()}` } });
		const otherEditor = await prisma.user.create({ data: { clerkId: `publication-editor:${randomUUID()}` } });
		await prisma.workspaceMember.createMany({ data: [editor, otherEditor].map((user) => ({ workspaceId: f.workspace.id, userId: user.id, role: "editor" as const })) });
		const admission = createProductionSocialPublicationScheduling();
		const input = {
			actorUserId: editor.id, workspaceId: f.workspace.id, projectId: f.project.id,
			clientIdempotencyKey: randomUUID(), clipId: f.clip.id, expectedEditorRevision: f.clip.editorRevision,
			clipExportId: f.clipExport.id, clipExportVariantId: f.variant.id, accountId: f.firstAccount.id,
			platform: "youtube_shorts" as const, caption: "Admitted by editor", aspectRatio: "9:16" as const,
			resolution: "1080p" as const, scheduledFor: new Date(), immediate: true, providerSettings: {},
		};
		const first = await admission.schedule(input);
		expect(first.createdByUserId).toBe(editor.id);
		await prisma.workspace.update({ where: { id: f.workspace.id }, data: { ownerUserId: otherEditor.id } });
		await prisma.socialPost.update({ where: { id: first.id }, data: { status: "posted" } });
		const replay = await admission.schedule({ ...input, actorUserId: otherEditor.id });
		expect(replay).toMatchObject({ id: first.id, createdByUserId: editor.id, status: "posted", submissionEligible: false });
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: first.id } })).createdByUserId).toBe(editor.id);
		await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: editor.id } }, data: { role: "viewer" } });
		await expect(admission.schedule({ ...input, clientIdempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "workspace_access_denied" });
	});

	test("expired credential rejection does not mutate the account", async () => {
		const f = await fixture();
		await prisma.socialAccount.update({ where: { id: f.firstAccount.id }, data: { expiresAt: new Date(Date.now() - 60_000), refreshTokenEncrypted: null } });
		await expect(createProductionSocialPublicationScheduling().schedule({
			actorUserId: f.user.id, workspaceId: f.workspace.id, projectId: f.project.id,
			clientIdempotencyKey: randomUUID(), clipId: f.clip.id, expectedEditorRevision: f.clip.editorRevision,
			clipExportId: f.clipExport.id, clipExportVariantId: f.variant.id, accountId: f.firstAccount.id,
			platform: "youtube_shorts", caption: "Expired credential", aspectRatio: "9:16", resolution: "1080p",
			scheduledFor: new Date(Date.now() + 3_600_000), providerSettings: {},
		})).rejects.toMatchObject({ code: "social_account_expired" });
		expect(await prisma.socialAccount.findUniqueOrThrow({ where: { id: f.firstAccount.id }, select: { status: true } })).toEqual({ status: "active" });
	});

	test("cancel, list and metrics snapshots preserve the latest provider receipt fields", async () => {
		const f = await fixture();
		const candidate = frozenCandidate(f, { id: randomUUID(), key: randomUUID(), hash: "cancel-receipt", accountId: f.firstAccount.id, scheduledFor: new Date(Date.now() + 3_600_000) });
		const post = await prismaPublicationSchedulingStore.open({ workspaceId: f.workspace.id, clientIdempotencyKey: candidate.clientIdempotencyKey, immutableRequestHash: candidate.immutableRequestHash, create: async () => candidate });
		const frozen = await prisma.frozenPublicationState.findUniqueOrThrow({ where: { socialPostId: post.id } });
		await prisma.socialPublicationAttempt.create({ data: {
			socialPostId: post.id, frozenStateId: frozen.id, attemptNumber: 1, idempotencyKey: randomUUID(), phase: "failed",
			nextActionAt: new Date(), processingDeadline: new Date(), reconciliationDeadline: new Date(),
			receipt: { create: { platform: "youtube_shorts", receiptId: `receipt:${post.id}`, providerProcessingStatus: "failed", providerProcessingFailureCode: "video_processing_failed", providerVisibility: "unlisted" } },
		} });
		const expectedReceipt = { providerProcessingStatus: "failed", providerProcessingFailureCode: "video_processing_failed", providerVisibility: "unlisted" };
		const list = await socialService.listProjectPosts({ actorUserId: f.user.id, workspaceId: f.workspace.id }, f.project.id);
		expect(list.items.find((item) => item.id === post.id)).toMatchObject(expectedReceipt);
		expect(await socialService.recordMetricsForPostId(post.id, { views: 10, likes: 1, comments: 0, shares: 0, saves: 0 })).toMatchObject(expectedReceipt);
		expect(await socialService.cancelPost({ workspaceId: f.workspace.id, actorUserId: f.user.id }, f.project.id, post.id)).toMatchObject({ status: "cancelled", ...expectedReceipt });
	});

	test("admits distinct publications to one account at the same time", async () => {
		const f = await fixture();
		const scheduledFor = new Date(Date.now() + 3_600_000);
		const ids: string[] = [];
		for (let index = 0; index < 2; index++) {
			const candidate = frozenCandidate(f, {
				id: randomUUID(),
				key: randomUUID(),
				hash: `same-time-${index}`,
				accountId: f.firstAccount.id,
				scheduledFor,
			});
			const post = await prismaPublicationSchedulingStore.open({
				workspaceId: f.workspace.id,
				clientIdempotencyKey: candidate.clientIdempotencyKey,
				immutableRequestHash: candidate.immutableRequestHash,
				create: async () => candidate,
			});
			ids.push(post.id);
			expect(post.frozen.scheduledFor).toEqual(scheduledFor);
		}
		expect(new Set(ids).size).toBe(2);
		expect(
			await prisma.socialPost.count({
				where: { id: { in: ids }, status: "scheduled" },
			}),
		).toBe(2);
	});

	test("persists one idempotent override audit and links it to the Social Post", async () => {
		const f = await fixture();
		await prisma.project.update({
			where: { id: f.project.id },
			data: {
				brandProfileSnapshot: {
					version: 1,
					profileId: randomUUID(),
					profileRevision: 1,
					name: "Approval gate test",
					identity: {
						primaryColor: "#FFFFFF",
						secondaryColor: "#111522",
						accentColor: null,
						primaryLogoAssetId: null,
						alternateLogoAssetId: null,
					},
					voice: {
						audience: "",
						tone: [],
						preferredTerms: [],
						blockedTerms: [],
						hashtagGuidance: "",
					},
					approvalRule: "approval_required",
					style: null,
				},
			},
		});
		const key = randomUUID();
		const gate = createProductionReviewApprovalGate();
		const request = {
			principal: { kind: "workspace_user" as const, userId: f.user.id },
			workspaceId: f.workspace.id,
			projectId: f.project.id,
			exportIds: [f.clipExport.id],
			idempotencyKey: key,
		};

		await expect(gate.authorize(request)).rejects.toMatchObject({
			code: "review_approval_required",
		});
		const overridden = await gate.authorize({
			...request,
			overrideReason:
				"The client approved this launch outside the review room.",
		});
		const replay = await gate.authorize({
			...request,
			overrideReason:
				"The client approved this launch outside the review room.",
		});
		expect(replay).toEqual(overridden);
		const overrideId = overridden.items[0]?.overrideAuditId;
		expect(overrideId).toBeString();
		expect(
			await prisma.reviewApprovalOverride.count({
				where: { workspaceId: f.workspace.id, clientIdempotencyKey: key },
			}),
		).toBe(1);

		const candidate = {
			...frozenCandidate(f, {
				id: randomUUID(),
				key,
				hash: "override-frozen-request",
				accountId: f.firstAccount.id,
				scheduledFor: new Date(Date.now() + 3_600_000),
			}),
			reviewApprovalOverrideId: overrideId ?? null,
		};
		const post = await prismaPublicationSchedulingStore.open({
			workspaceId: f.workspace.id,
			clientIdempotencyKey: key,
			immutableRequestHash: candidate.immutableRequestHash,
			create: async () => candidate,
		});

		expect(post.reviewApprovalOverrideId).toBe(overrideId);
		expect(
			await prisma.socialPost.findUnique({
				where: { id: post.id },
				select: { reviewApprovalOverrideId: true },
			}),
		).toEqual({ reviewApprovalOverrideId: overrideId });
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
		const createdAttempt =
			await prisma.socialPublicationAttempt.findFirstOrThrow({
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
			new Date(
				result.nextActionAt.getTime() + claimConfig.processingDeadlineMs,
			),
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
						durationSec: f.variant.durationSec,
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
						durationSec: f.variant.durationSec,
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

	test("recovery authorizes the actual member and conceals inactive Projects", async () => {
		const f = await fixture();
		const target = await attentionPublication(f, "actor-scope");
		const editor = await prisma.user.create({ data: { clerkId: `recovery-editor:${randomUUID()}` } });
		const member = await prisma.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: editor.id, role: "viewer" } });
		const scope = { actorUserId: editor.id, workspaceId: f.workspace.id };
		const operations = [
			() => socialService.recheckPublication(scope, target.socialPostId, { reason: "Check exact provider state" }, f.project.id),
			() => socialService.confirmPublication(scope, target.socialPostId, { reason: "Confirm visible publication", evidenceKind: "manual_unvalidated", externalUrl: "https://youtube.com/shorts/actor-proof" }, f.project.id),
			() => socialService.republishPublication(scope, target.socialPostId, { reason: "Retry uncertain publication", duplicateRiskAcknowledged: true }, f.project.id),
			() => socialService.cancelPost(scope, f.project.id, target.socialPostId),
		];
		expect(await socialService.inspectPublication(scope, target.socialPostId, f.project.id)).toMatchObject({ id: target.socialPostId });
		for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: "workspace_access_denied" });
		await prisma.workspaceMember.delete({ where: { id: member.id } });
		for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: "workspace_access_denied" });
		await expect(socialService.inspectPublication(scope, target.socialPostId)).rejects.toMatchObject({ code: "workspace_access_denied" });
		await prisma.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: editor.id, role: "editor" } });
		for (const lifecycle of [{ expiresAt: new Date(Date.now() - 1000) }, { expiresAt: null, purgeStartedAt: new Date() }]) {
			await prisma.project.update({ where: { id: f.project.id }, data: lifecycle });
			await expect(socialService.inspectPublication(scope, target.socialPostId)).rejects.toMatchObject({ code: "social_publication_not_found" });
			for (const operation of operations.slice(0, 3)) await expect(operation()).rejects.toMatchObject({ code: "social_publication_not_found" });
			await expect(operations[3]!()).rejects.toMatchObject({ code: "social_post_not_found" });
		}
		expect(await prisma.publicationManualDecision.count({ where: { socialPostId: target.socialPostId } })).toBe(0);
		expect(await prisma.socialPost.findUnique({ where: { id: target.socialPostId } })).toMatchObject({ status: "needs_attention" });
		await prisma.project.update({ where: { id: f.project.id }, data: { expiresAt: null, purgeStartedAt: null } });
		expect(await operations[0]!()).toMatchObject({ status: "reconciling" });
		expect(await prisma.publicationManualDecision.findFirst({ where: { socialPostId: target.socialPostId } })).toMatchObject({ actorUserId: editor.id });
	});

	test("manual recheck reuses the uncertain attempt and records an audit decision", async () => {
		const f = await fixture();
		const target = await attentionPublication(f, "recheck");
		const result = await socialPublicationRecovery.recheck({
			workspaceId: f.workspace.id,
			projectId: f.project.id,
			actorUserId: f.user.id,
			socialPostId: target.socialPostId,
			reason: "Operator requested an exact provider status check",
			now: target.now,
		});

		expect(result).toMatchObject({
			attemptId: target.attemptId,
			status: "reconciling",
		});
		expect(
			await prisma.socialPublicationAttempt.count({
				where: { socialPostId: target.socialPostId },
			}),
		).toBe(1);
		expect(
			await prisma.publicationManualDecision.findFirstOrThrow({
				where: { socialPostId: target.socialPostId },
			}),
		).toMatchObject({
			kind: "recheck_requested",
			actorUserId: f.user.id,
			ownershipValidated: false,
		});
	});

	test("manual confirmation records labeled evidence without fabricating metrics", async () => {
		const f = await fixture();
		const target = await attentionPublication(f, "confirm");
		const result = await socialPublicationRecovery.confirmPublished({
			workspaceId: f.workspace.id,
			projectId: f.project.id,
			actorUserId: f.user.id,
			socialPostId: target.socialPostId,
			reason: "Editor found the exact Short on the selected channel",
			evidenceKind: "manual_unvalidated",
			externalUrl: "https://youtube.com/shorts/manual-proof",
			now: target.now,
		});

		expect(result).toMatchObject({ status: "posted", evidence: "manual" });
		expect(
			await prisma.providerReceipt.findUniqueOrThrow({
				where: { attemptId: target.attemptId },
			}),
		).toMatchObject({ metrics: null });
		expect(
			await prisma.socialPostMetric.count({
				where: { postId: target.socialPostId },
			}),
		).toBe(0);
		expect(
			await prisma.publicationManualDecision.findFirstOrThrow({
				where: { socialPostId: target.socialPostId },
			}),
		).toMatchObject({
			evidenceKind: "manual_unvalidated",
			ownershipValidated: false,
		});
	});

	test("concurrent manual decisions create one truth and preserve uncertain lineage", async () => {
		const f = await fixture();
		const target = await attentionPublication(f, "race");
		const outcomes = await Promise.allSettled([
			socialPublicationRecovery.confirmPublished({
				workspaceId: f.workspace.id,
				projectId: f.project.id,
				actorUserId: f.user.id,
				socialPostId: target.socialPostId,
				reason: "Confirmed on provider",
				evidenceKind: "manual_unvalidated",
				now: target.now,
			}),
			socialPublicationRecovery.publishAgain({
				workspaceId: f.workspace.id,
				projectId: f.project.id,
				actorUserId: f.user.id,
				socialPostId: target.socialPostId,
				reason: "Editor accepts the duplicate risk",
				duplicateRiskAcknowledged: true,
				now: target.now,
			}),
		]);

		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			await prisma.publicationManualDecision.count({
				where: { socialPostId: target.socialPostId },
			}),
		).toBe(1);
		const post = await prisma.socialPost.findUniqueOrThrow({
			where: { id: target.socialPostId },
		});
		expect(["posted", "scheduled"]).toContain(post.status);
		const attempts = await prisma.socialPublicationAttempt.findMany({
			where: { socialPostId: target.socialPostId },
			orderBy: { attemptNumber: "asc" },
		});
		expect(attempts[0]!.id).toBe(target.attemptId);
		if (post.status === "scheduled") {
			expect(attempts).toHaveLength(2);
			expect(attempts[0]!.phase).toBe("needs_attention");
			expect(attempts[0]!.operationLookupHash).toBeNull();
			expect(attempts[1]!.priorAttemptId).toBe(target.attemptId);
		} else {
			expect(attempts).toHaveLength(1);
			expect(attempts[0]!.phase).toBe("succeeded");
		}
	});

	test("recovery lookup is isolated by workspace and project", async () => {
		const f = await fixture();
		const target = await attentionPublication(f, "scope");
		await expect(
			socialPublicationRecovery.inspect({
				actorUserId: f.user.id,
				workspaceId: f.workspace.id,
				projectId: randomUUID(),
				socialPostId: target.socialPostId,
			}),
		).rejects.toBeInstanceOf(SocialPublicationRecoveryError);
	});

	test.each([
		"direct",
		"tiktok_inbox",
	] as const)("verified duplicate and out-of-order TikTok %s events settle delivery and retain publication evidence", async (deliveryMode) => {
		const f = await fixture();
		const now = new Date("2026-08-28T10:00:00.000Z");
		const publishId = `publish-${randomUUID()}`;
		const account = await prisma.socialAccount.create({
			data: {
				userId: f.user.id,
				workspaceId: f.workspace.id,
				createdByUserId: f.user.id,
				platform: "tiktok",
				providerAccountId: `tiktok:${randomUUID()}`,
				displayName: "TikTok fixture",
				handle: "@fixture",
				accessTokenEncrypted: "encrypted-test-token",
			},
		});
		const socialPostId = randomUUID();
		const base = frozenCandidate(f, {
			id: socialPostId,
			key: randomUUID(),
			hash: "tiktok-webhook",
			accountId: account.id,
			scheduledFor: new Date(now.getTime() - 1_000),
		});
		const candidate = {
			...base,
			frozen: {
				...base.frozen,
				deliveryMode,
				socialAccountId: account.id,
				platform: "tiktok" as const,
				capabilityVersion: "tiktok-v2",
			},
		};
		await prismaPublicationSchedulingStore.open({
			workspaceId: f.workspace.id,
			clientIdempotencyKey: candidate.clientIdempotencyKey,
			immutableRequestHash: candidate.immutableRequestHash,
			create: async () => candidate,
		});
		const claims = await claimDueSocialPublicationAttempts({
			claimantId: "tiktok-webhook-worker",
			now,
			config: claimConfig,
		});
		const attempt = await prisma.socialPublicationAttempt.findFirstOrThrow({
			where: { socialPostId },
		});
		const claim = claims.find((row) => row.attemptId === attempt.id);
		if (!claim) throw new Error("expected TikTok claim");
		await prisma.$transaction([
			prisma.publicationClaim.update({
				where: { id: claim.claimId },
				data: { releasedAt: now, accountSlotKey: null },
			}),
			prisma.socialPublicationAttempt.update({
				where: { id: attempt.id },
				data: {
					phase: "needs_attention",
					outcome: "unknown",
					failureCode: "tiktok_publication_outcome_unknown",
					failureDisposition: "attention",
					operationKind: "tiktok_processing",
					operationLookupHash: publicationOperationLookupHash(
						`tiktok:${publishId}`,
					),
					currentClaimId: null,
				},
			}),
			prisma.socialPost.update({
				where: { id: socialPostId },
				data: {
					status: "needs_attention",
					errorCode: "tiktok_publication_outcome_unknown",
					errorDisposition: "attention",
				},
			}),
		]);

		const clientSecret = "tiktok-webhook-test-secret";
		const timestamp = String(Math.floor(now.getTime() / 1000));
		const invoke = (event: string, content: Record<string, unknown>) => {
			const rawBody = JSON.stringify({
				client_key: "test-client",
				event,
				create_time: Number(timestamp),
				user_openid: account.providerAccountId,
				content: JSON.stringify({
					publish_id: publishId,
					publish_type:
						deliveryMode === "tiktok_inbox" ? "INBOX_SHARE" : "DIRECT_POST",
					...content,
				}),
			});
			const digest = createHmac("sha256", clientSecret)
				.update(`${timestamp}.${rawBody}`)
				.digest("hex");
			return acceptTikTokPublicationWebhook({
				rawBody,
				signature: `t=${timestamp},s=${digest}`,
				clientKey: "test-client",
				clientSecret,
				now,
			});
		};

		if (deliveryMode === "tiktok_inbox") {
			expect(await invoke("post.publish.inbox_delivered", {})).toMatchObject({
				kind: "inbox_delivered",
			});
			expect(
				await prisma.socialPost.findUnique({ where: { id: socialPostId } }),
			).toMatchObject({ status: "inbox_delivered", postedAt: null });
			expect(
				await prisma.projectAnalyticsEvent.count({
					where: { projectId: f.project.id, type: "social_posted" },
				}),
			).toBe(0);
			expect(
				await prisma.socialPublicationAttempt.findUnique({
					where: { id: attempt.id },
				}),
			).toMatchObject({ phase: "succeeded", currentClaimId: null });
		}

		expect(
			await invoke("post.publish.publicly_available", { post_id: "post-123" }),
		).toMatchObject({ kind: "posted", attemptId: attempt.id });
		expect(
			await invoke("post.publish.publicly_available", { post_id: "post-123" }),
		).toMatchObject({ kind: "already_settled", attemptId: attempt.id });
		expect(
			await invoke("post.publish.failed", { reason: "internal" }),
		).toMatchObject({ kind: "already_settled", attemptId: attempt.id });
		expect(
			await prisma.providerReceipt.count({ where: { attemptId: attempt.id } }),
		).toBe(1);
		expect(
			await prisma.publicationClaim.findUniqueOrThrow({
				where: { id: claim.claimId },
			}),
		).toMatchObject({ releasedAt: now, accountSlotKey: null });
		expect(
			await prisma.projectAnalyticsEvent.count({
				where: { projectId: f.project.id, type: "social_posted" },
			}),
		).toBe(1);
		expect(
			await prisma.socialPost.findUniqueOrThrow({
				where: { id: socialPostId },
			}),
		).toMatchObject({
			status: "posted",
			externalUrl: "https://www.tiktok.com/@fixture/video/post-123",
		});
		if (deliveryMode === "tiktok_inbox") {
			await invoke("post.publish.publicly_available", { post_id: "post-456" });
			await invoke("post.publish.complete", {});
			await invoke("post.publish.inbox_delivered", {});
			await invoke("post.publish.publicly_available", { post_id: "post-456" });
			expect(
				await prisma.publishedSocialVideo.count({ where: { socialPostId } }),
			).toBe(2);
			expect(
				await prisma.socialPost.findUnique({ where: { id: socialPostId } }),
			).toMatchObject({ status: "posted" });
			expect(
				await prisma.projectAnalyticsEvent.count({
					where: { projectId: f.project.id, type: "social_posted" },
				}),
			).toBe(1);
		}
	});
});
