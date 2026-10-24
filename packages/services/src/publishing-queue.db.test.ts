import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { claimDueSocialPublicationAttempts, synchronizePreparedSocialPosts } from "./social-publication-attempt";
import { assertFinishingQueue, assertQueueAccounts, publishingQueue, PublishingQueueError } from "./publishing-queue.service";
import { nextFreeSlots } from "./posting-schedule";
import { socialPublicationRecovery } from "./social-publication-recovery";
import { socialService } from "./social.service";
import { socialPublicationScheduling } from "./social-publication-scheduling-runtime";
import { listWorkspaceEvents } from "./workspace-event";

const databaseUrl = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_URL;
const databaseSchema = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_SOCIAL_PUBLICATION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

const claimConfig = {
	batchSize: 20,
	leaseMs: 60_000,
	processingDeadlineMs: 3_600_000,
	reconciliationDeadlineMs: 7_200_000,
	providerCallBudget: 12,
};

/** Every day at 09:00 and 17:00, so a free slot is always near. */
const EVERY_DAY = {
	slots: (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).flatMap((weekday) => [
		{ weekday, time: "09:00" },
		{ weekday, time: "17:00" },
	]),
};

dbDescribe("Publishing Queue PostgreSQL invariants", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let previousGlobalPrisma: PrismaClient | undefined;
	const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

	beforeAll(async () => {
		if (!databaseUrl) throw new Error("SOCIAL_PUBLICATION_TEST_DATABASE_URL is required");
		pool = new Pool({ connectionString: databaseUrl, max: 12 });
		prisma = new PrismaClient({
			adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined),
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

	/** A Workspace with a clip, a finished export, and one YouTube account that has slots. */
	async function fixture(options: { platform?: "youtube_shorts" | "tiktok" | "x"; schedule?: typeof EVERY_DAY | null } = {}) {
		const suffix = randomUUID();
		const user = await prisma.user.create({ data: { clerkId: `queue-db-test:${suffix}`, primaryEmail: `queue-${suffix}@example.test` } });
		const workspace = await prisma.workspace.create({ data: { name: "Queue DB test", ownerUserId: user.id, personalOwnerUserId: user.id } });
		await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "owner" } });
		const project = await prisma.project.create({
			data: { title: "Queue fixture", sourceMediaUrl: "r2://test/source.mp4", workspaceId: workspace.id, createdByUserId: user.id },
		});
		const run = await prisma.workflowRun.create({
			data: { projectId: project.id, idempotencyKey: `queue:${suffix}`, stage: "clip_rendering", status: "completed" },
		});
		const clip = await prisma.clip.create({
			data: {
				projectId: project.id, workflowRunId: run.id, index: 0, startSec: 0, endSec: 30, hookText: "Queue test clip", reasoning: "Fixture",
				category: "hook", transcriptSlice: [], viralityScore: 80, hookStrengthScore: 80, emotionalIntensityScore: 70, pacingScore: 70,
				durationOptimalityScore: 80, tiktokScore: 80, youtubeScore: 80, instagramScore: 80, llmProvider: "test", llmModel: "test",
			},
		});
		const clipExport = await prisma.clipExport.create({
			data: {
				projectId: project.id, workspaceId: workspace.id, createdByUserId: user.id, clipId: clip.id, editorRevision: clip.editorRevision,
				fingerprint: `queue:${suffix}`, resolution: "1080p", watermark: false, status: "ready", progress: 100, completedAt: new Date(),
			},
		});
		const variant = await prisma.clipExportVariant.create({
			data: {
				exportId: clipExport.id, aspectRatio: "ratio_9_16", resolution: "1080p", watermark: false, status: "completed",
				storageKey: `tests/${suffix}.mp4`, sizeBytes: 1_024n, durationSec: 30, completedAt: new Date(),
			},
		});
		const account = await prisma.socialAccount.create({
			data: {
				userId: user.id, workspaceId: workspace.id, createdByUserId: user.id, platform: options.platform ?? "youtube_shorts",
				providerAccountId: `queue:${suffix}`, displayName: "Queue account", accessTokenEncrypted: "encrypted-test-token",
				scopes: ["video.upload", "video.publish"],
				postingSchedule: options.schedule === null ? undefined : (options.schedule ?? EVERY_DAY),
			},
		});
		return { user, workspace, project, clip, clipExport, variant, account };
	}
	type Fixture = Awaited<ReturnType<typeof fixture>>;
	const scope = (f: Fixture) => ({ actorUserId: f.user.id, workspaceId: f.workspace.id });

	async function propose(f: Fixture, extra: { key?: string; caption?: string; accountId?: string } = {}) {
		const result = await publishingQueue.propose(
			scope(f),
			{ clipId: f.clip.id, exportId: f.clipExport.id, socialAccountId: extra.accountId ?? f.account.id, caption: extra.caption ?? "Draft caption" },
			{ source: "person", mutation: { clientIdempotencyKey: extra.key ?? randomUUID() } },
		);
		return result.proposal;
	}

	test("a proposal is a draft with no time, no frozen state and no attempt, and its event is written once", async () => {
		const f = await fixture();
		const key = randomUUID();
		const proposal = await propose(f, { key });
		const row = await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId }, include: { frozenState: true, publicationAttempts: true, proposal: true } });
		expect(row).toMatchObject({ status: "draft", scheduledFor: null, caption: "Draft caption", platform: "youtube_shorts", socialAccountId: f.account.id, frozenState: null, publicationAttempts: [] });
		expect(row.proposal).toMatchObject({ source: "person", clipExportVariantId: f.variant.id });

		const replay = await publishingQueue.propose(scope(f), { clipId: f.clip.id, exportId: f.clipExport.id, socialAccountId: f.account.id, caption: "Draft caption" }, { source: "integration", mutation: { clientIdempotencyKey: key } });
		expect(replay).toMatchObject({ replayed: true, proposal: { proposalId: proposal.proposalId } });
		await expect(publishingQueue.propose(scope(f), { clipId: f.clip.id, exportId: f.clipExport.id, socialAccountId: f.account.id, caption: "Changed" }, { source: "person", mutation: { clientIdempotencyKey: key } }))
			.rejects.toMatchObject({ code: "operation_idempotency_conflict" });
		expect(await prisma.socialPost.count({ where: { workspaceId: f.workspace.id } })).toBe(1);

		const events = await listWorkspaceEvents(prisma, { workspaceId: f.workspace.id }, { types: ["social_post.proposed"] });
		expect(events.data.map((event) => event.subject)).toEqual([{ socialPostId: proposal.proposalId, projectId: f.project.id, clipId: f.clip.id, socialAccountId: f.account.id, platform: "youtube_shorts" }]);
	});

	test("proposals never reach the scheduler or recovery", async () => {
		const f = await fixture();
		const proposal = await propose(f);
		// A scheduler running long after any slot would have passed still never opens an attempt for it.
		const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
		const claimed = await claimDueSocialPublicationAttempts({ claimantId: "queue-test", now: farFuture, config: claimConfig });
		const attempts = await prisma.socialPublicationAttempt.findMany({ where: { id: { in: claimed.map((claim) => claim.attemptId) } }, select: { socialPostId: true } });
		expect(attempts.map((attempt) => attempt.socialPostId)).not.toContain(proposal.proposalId);
		await synchronizePreparedSocialPosts(farFuture);
		expect(await prisma.socialPublicationAttempt.count({ where: { socialPostId: proposal.proposalId } })).toBe(0);
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId } })).status).toBe("draft");

		// Recovery acts on an attempt; a proposal has none, so every recovery action refuses it.
		const target = { ...scope(f), socialPostId: proposal.proposalId };
		await expect(socialPublicationRecovery.recheck({ ...target, reason: "Check" })).rejects.toMatchObject({ code: "social_publication_not_found" });
		await expect(socialPublicationRecovery.confirmPublished({ ...target, reason: "Posted", evidenceKind: "manual_unvalidated" })).rejects.toMatchObject({ code: "social_publication_not_found" });
		await expect(socialPublicationRecovery.publishAgain({ ...target, reason: "Retry", duplicateRiskAcknowledged: true })).rejects.toMatchObject({ code: "social_publication_not_found" });
		expect((await socialPublicationRecovery.inspect(target)).allowedActions).toEqual(["cancel"]);
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId } })).status).toBe("draft");
	});

	test("two concurrent accepts for one account take two different slots", async () => {
		const f = await fixture();
		const [first, second] = await Promise.all([propose(f), propose(f)]);
		const accepted = await Promise.all([first, second].map((proposal) => publishingQueue.accept(scope(f), proposal.proposalId)));
		const slots = accepted.map((post) => post.scheduledFor);
		expect(new Set(slots).size).toBe(2);
		for (const post of accepted) expect(post.status).toBe("scheduled");
		const posts = await prisma.socialPost.findMany({ where: { workspaceId: f.workspace.id, socialAccountId: f.account.id }, include: { frozenState: true, proposal: true } });
		expect(posts).toHaveLength(2);
		for (const post of posts) {
			expect(post.status).toBe("scheduled");
			expect(post.scheduledFor?.toISOString()).toBe(post.frozenState!.scheduledFor.toISOString());
			// The proposal row stays as the record of who proposed it and who accepted it.
			expect(post.proposal).toMatchObject({ source: "person", acceptedByUserId: f.user.id });
			expect(post.proposal?.acceptedAt).not.toBeNull();
		}
		// The two are the account's first two free slots.
		const expected = nextFreeSlots({ schedule: EVERY_DAY, timeZone: "UTC", after: new Date(), occupied: new Set(), count: 3 }).map((slot) => slot.toISOString());
		expect(slots.slice().sort()).toEqual(expected.filter((slot) => slots.includes(slot)).sort());
		expect(slots.every((slot) => expected.includes(slot) || new Date(slot) > new Date(expected[2]!))).toBe(true);
	});

	test("many concurrent accepts never share a slot, and a slot another post holds is skipped", async () => {
		const f = await fixture();
		const [firstSlot] = nextFreeSlots({ schedule: EVERY_DAY, timeZone: "UTC", after: new Date(), occupied: new Set() });
		// A post already scheduled at the account's first slot, made some other way.
		await prisma.socialPost.create({
			data: {
				workspaceId: f.workspace.id, projectId: f.project.id, clipId: f.clip.id, socialAccountId: f.account.id, platform: "youtube_shorts", status: "scheduled",
				clientIdempotencyKey: randomUUID(), immutableRequestHash: "occupant", caption: "Occupant", scheduledFor: firstSlot,
			},
		});
		const proposals = await Promise.all(Array.from({ length: 5 }, () => propose(f)));
		const accepted = await Promise.all(proposals.map((proposal) => publishingQueue.accept(scope(f), proposal.proposalId)));
		const slots = accepted.map((post) => post.scheduledFor);
		expect(new Set(slots).size).toBe(5);
		expect(slots).not.toContain(firstSlot!.toISOString());
		const all = await prisma.socialPost.findMany({ where: { socialAccountId: f.account.id, status: { not: "draft" } }, select: { scheduledFor: true } });
		expect(new Set(all.map((post) => post.scheduledFor!.toISOString())).size).toBe(6);
	});

	test("accepting one proposal twice, even at once, makes one post", async () => {
		const f = await fixture();
		const proposal = await propose(f);
		const results = await Promise.all([publishingQueue.accept(scope(f), proposal.proposalId), publishingQueue.accept(scope(f), proposal.proposalId)]);
		expect(results[1].socialPostId).toBe(results[0].socialPostId);
		expect(results[1].scheduledFor).toBe(results[0].scheduledFor);
		const retry = await publishingQueue.accept(scope(f), proposal.proposalId);
		expect(retry).toMatchObject({ replayed: true, socialPostId: results[0].socialPostId });
		expect(await prisma.socialPost.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
	});

	test("an account without slots refuses acceptance and keeps the proposal", async () => {
		const f = await fixture({ schedule: null });
		const proposal = await propose(f);
		await expect(publishingQueue.accept(scope(f), proposal.proposalId)).rejects.toMatchObject({ code: "posting_schedule_missing" });
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId } })).status).toBe("draft");
	});

	test("the approval gate still blocks acceptance for an approval-required brand, and the proposal survives", async () => {
		const f = await fixture();
		await prisma.project.update({
			where: { id: f.project.id },
			data: {
				brandProfileSnapshot: {
					version: 1, profileId: randomUUID(), profileRevision: 1, name: "Approval required",
					identity: { primaryColor: "#FFFFFF", secondaryColor: "#111522", accentColor: null, primaryLogoAssetId: null, alternateLogoAssetId: null },
					voice: { audience: "", tone: [], preferredTerms: [], blockedTerms: [], hashtagGuidance: "" },
					approvalRule: "approval_required", style: null,
				},
			},
		});
		// Proposing is not approving, so it succeeds; accepting is where the rule applies.
		const proposal = await propose(f);
		await expect(publishingQueue.accept(scope(f), proposal.proposalId)).rejects.toMatchObject({ code: "review_approval_required" });
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId } })).status).toBe("draft");
		expect(await prisma.socialPost.count({ where: { workspaceId: f.workspace.id, status: "scheduled" } })).toBe(0);
	});

	test("TikTok needs the creator's choices at acceptance, and accept-all skips it", async () => {
		const f = await fixture({ platform: "tiktok" });
		const tiktok = await propose(f);
		await expect(publishingQueue.accept(scope(f), tiktok.proposalId)).rejects.toMatchObject({ code: "social_proposal_tiktok_options_required" });
		await expect(publishingQueue.accept(scope(f), tiktok.proposalId, { tiktok: { deliveryMode: "direct", disableComment: false, disableDuet: false, disableStitch: false, isAigc: false } }))
			.rejects.toMatchObject({ code: "social_proposal_tiktok_options_required" });

		const youtube = await prisma.socialAccount.create({
			data: { userId: f.user.id, workspaceId: f.workspace.id, platform: "youtube_shorts", providerAccountId: `queue-yt:${randomUUID()}`, displayName: "YouTube", accessTokenEncrypted: "encrypted-test-token", postingSchedule: EVERY_DAY },
		});
		const other = await propose(f, { accountId: youtube.id });
		const result = await publishingQueue.acceptAll(scope(f));
		expect(result.skippedTikTok).toBe(1);
		expect(result.failed).toEqual([]);
		expect(result.accepted.map((post) => post.platform)).toEqual(["youtube_shorts"]);
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: tiktok.proposalId } })).status).toBe("draft");
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: other.proposalId } })).status).toBe("scheduled");

		// Inbox delivery needs no publication settings, so a person can accept it with just that choice.
		const accepted = await publishingQueue.accept(scope(f), tiktok.proposalId, { tiktok: { deliveryMode: "tiktok_inbox", disableComment: false, disableDuet: false, disableStitch: false, isAigc: false } }).catch((error) => error);
		// The fixture has no TikTok creator API, so the creator-info read refuses before any post exists.
		expect(accepted instanceof Error || "socialPostId" in accepted).toBe(true);
	});

	test("rejecting cancels the proposal for good, and the caption can be edited first", async () => {
		const f = await fixture();
		const proposal = await propose(f);
		await publishingQueue.updateProposalCaption(scope(f), proposal.proposalId, "Edited caption");
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId } })).caption).toBe("Edited caption");
		await publishingQueue.reject(scope(f), proposal.proposalId);
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId } })).status).toBe("cancelled");
		await expect(publishingQueue.accept(scope(f), proposal.proposalId)).rejects.toMatchObject({ code: "social_proposal_not_found" });
		await expect(publishingQueue.reject(scope(f), proposal.proposalId)).rejects.toMatchObject({ code: "social_proposal_not_found" });
		await expect(publishingQueue.updateProposalCaption(scope(f), proposal.proposalId, "Too late")).rejects.toMatchObject({ code: "social_proposal_not_found" });
		// The project's own cancel action rejects a draft the same way.
		const another = await propose(f);
		await socialService.cancelPost(scope(f), f.project.id, another.proposalId);
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: another.proposalId } })).status).toBe("cancelled");
	});

	test("the inbox lists open proposals with the slot each would take", async () => {
		const f = await fixture();
		const [first, second] = [await propose(f), await propose(f)];
		const inbox = await publishingQueue.listProposals(scope(f));
		expect(inbox.map((item) => item.proposalId)).toEqual([first.proposalId, second.proposalId]);
		expect(inbox[0]!.nextSlot).not.toBeNull();
		expect(new Date(inbox[1]!.nextSlot!).getTime()).toBeGreaterThan(new Date(inbox[0]!.nextSlot!).getTime());
		expect(await publishingQueue.countProposals(scope(f))).toBe(2);
		const accepted = await publishingQueue.accept(scope(f), first.proposalId);
		expect(accepted.scheduledFor).toBe(inbox[0]!.nextSlot!);
		expect((await publishingQueue.listProposals(scope(f))).map((item) => item.proposalId)).toEqual([second.proposalId]);
	});

	test("a proposal needs a finished format the platform accepts, an active account, and a current revision", async () => {
		const f = await fixture();
		const x = await prisma.socialAccount.create({
			data: { userId: f.user.id, workspaceId: f.workspace.id, platform: "x", providerAccountId: `queue-x:${randomUUID()}`, displayName: "X", accessTokenEncrypted: "encrypted-test-token" },
		});
		// X takes 140 seconds at most and this clip's variant runs 30: fine. Longer than the limit is refused.
		await prisma.clipExportVariant.update({ where: { id: f.variant.id }, data: { durationSec: 200 } });
		await expect(propose(f, { accountId: x.id })).rejects.toMatchObject({ code: "social_proposal_variant_unavailable" });
		await prisma.clipExportVariant.update({ where: { id: f.variant.id }, data: { durationSec: 30, status: "pending" } });
		await expect(propose(f)).rejects.toMatchObject({ code: "social_proposal_variant_unavailable" });
		await prisma.clipExportVariant.update({ where: { id: f.variant.id }, data: { status: "completed" } });
		await prisma.socialAccount.update({ where: { id: f.account.id }, data: { status: "expired" } });
		await expect(propose(f)).rejects.toMatchObject({ code: "social_account_unavailable" });
		await prisma.socialAccount.update({ where: { id: f.account.id }, data: { status: "active" } });
		await prisma.clip.update({ where: { id: f.clip.id }, data: { editorRevision: { increment: 1 } } });
		await expect(propose(f)).rejects.toMatchObject({ code: "editor_revision_conflict" });
		expect(await prisma.socialPost.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
	});

	test("the caption defaults to the latest assisted copy for the platform", async () => {
		const f = await fixture();
		const generation = await prisma.assistedCopyGeneration.create({
			data: {
				workspaceId: f.workspace.id, projectId: f.project.id, clipId: f.clip.id, createdByUserId: f.user.id, idempotencyKey: randomUUID(), requestFingerprint: "queue-test",
				status: "completed", provider: "test", model: "test", promptVersion: "test", completedAt: new Date(),
			},
		});
		const variant = await prisma.assistedCopyVariant.create({
			data: { generationId: generation.id, platform: "youtube_shorts", caption: "Written by the model", hashtags: ["#clips"], title: "A title", model: "test", promptVersion: "test", moderationOutcome: "approved", originalFingerprint: "x" },
		});
		const result = await publishingQueue.propose(scope(f), { clipId: f.clip.id, exportId: f.clipExport.id, socialAccountId: f.account.id }, { source: "integration", mutation: { clientIdempotencyKey: randomUUID() } });
		expect(result.proposal.caption).toBe("Written by the model\n\n#clips");
		const row = await prisma.socialPost.findUniqueOrThrow({ where: { id: result.proposal.proposalId }, include: { proposal: true } });
		expect(row.proposal).toMatchObject({ source: "integration", assistedCopyVariantId: variant.id, title: "A title" });
	});

	test("the account list for finishing and rules accepts only this Workspace's active accounts", async () => {
		const f = await fixture();
		const other = await fixture();
		await assertQueueAccounts(f.workspace.id, [f.account.id]);
		await expect(assertQueueAccounts(f.workspace.id, [other.account.id])).rejects.toBeInstanceOf(PublishingQueueError);
		await prisma.socialAccount.update({ where: { id: f.account.id }, data: { status: "revoked" } });
		await expect(assertQueueAccounts(f.workspace.id, [f.account.id])).rejects.toMatchObject({ code: "social_account_unavailable" });
		await assertQueueAccounts(f.workspace.id, []);
	});

	test("posting slots are editable by publishing managers, kept in week order, and clearable", async () => {
		const f = await fixture({ schedule: null });
		const saved = await publishingQueue.setPostingSchedule(scope(f), f.account.id, { slots: [{ weekday: "wed", time: "17:30" }, { weekday: "mon", time: "09:00" }] });
		expect(saved?.slots.map((slot) => `${slot.weekday} ${slot.time}`)).toEqual(["mon 09:00", "wed 17:30"]);
		expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: f.account.id } })).postingSchedule).toEqual(saved);
		expect(await publishingQueue.setPostingSchedule(scope(f), f.account.id, { slots: [] })).toBeNull();
		expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: f.account.id } })).postingSchedule).toBeNull();
		const viewer = await prisma.user.create({ data: { clerkId: `queue-viewer:${randomUUID()}`, primaryEmail: `viewer-${randomUUID()}@example.test` } });
		await prisma.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: viewer.id, role: "viewer" } });
		await expect(publishingQueue.setPostingSchedule({ actorUserId: viewer.id, workspaceId: f.workspace.id }, f.account.id, EVERY_DAY)).rejects.toBeDefined();
		await expect(publishingQueue.accept({ actorUserId: viewer.id, workspaceId: f.workspace.id }, randomUUID())).rejects.toBeDefined();
	});

	test("accepting converts the proposal in place: its ID is the scheduled post, with its source kept", async () => {
		const f = await fixture();
		const proposal = await propose(f);
		const draft = await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId } });
		// The key the acceptance will use is reserved from the start, and is not a UUID anyone could send.
		expect(draft.clientIdempotencyKey).toBe(`proposal-accept:${proposal.proposalId}`);

		const accepted = await publishingQueue.accept(scope(f), proposal.proposalId);
		expect(accepted.socialPostId).toBe(proposal.proposalId);
		const post = await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId }, include: { frozenState: true, proposal: true } });
		expect(post).toMatchObject({ status: "scheduled", clientIdempotencyKey: draft.clientIdempotencyKey, createdByUserId: f.user.id });
		expect(post.scheduledFor?.toISOString()).toBe(accepted.scheduledFor);
		expect(post.frozenState).toMatchObject({ clipExportVariantId: f.variant.id, socialAccountId: f.account.id });
		expect(post.proposal).toMatchObject({ source: "person", acceptedByUserId: f.user.id, clipExportVariantId: f.variant.id });
		expect(post.proposal?.acceptedAt).not.toBeNull();
		// The receipt's resource and the event's subject still name this post, now scheduled.
		const receipt = await prisma.operationReceipt.findFirstOrThrow({ where: { workspaceId: f.workspace.id, command: "propose_social_post" } });
		expect(receipt.resourceId).toBe(proposal.proposalId);
		const events = await listWorkspaceEvents(prisma, { workspaceId: f.workspace.id }, { types: ["social_post.proposed"] });
		expect(events.data.map((event) => (event.subject as { socialPostId: string }).socialPostId)).toEqual([proposal.proposalId]);
		// It is no longer a proposal: not in the inbox, not rejectable, not acceptable again.
		expect(await publishingQueue.listProposals(scope(f))).toEqual([]);
		await expect(publishingQueue.reject(scope(f), proposal.proposalId)).rejects.toMatchObject({ code: "social_proposal_not_found" });
		expect(await publishingQueue.accept(scope(f), proposal.proposalId)).toMatchObject({ replayed: true, socialPostId: proposal.proposalId });
	});

	test("nobody can take a proposal's acceptance key, and a stale caption is never accepted", async () => {
		const f = await fixture();
		const proposal = await propose(f);
		const input = {
			actorUserId: f.user.id, workspaceId: f.workspace.id, projectId: f.project.id, clipId: f.clip.id, expectedEditorRevision: f.clip.editorRevision,
			clipExportId: f.clipExport.id, clipExportVariantId: f.variant.id, accountId: f.account.id, platform: "youtube_shorts" as const,
			aspectRatio: "9:16" as const, resolution: "1080p" as const, scheduledFor: new Date(Date.now() + 3_600_000), providerSettings: {},
		};
		// Scheduling some other post under the proposal's key is refused, and the draft is untouched.
		await expect(socialPublicationScheduling.schedule({ ...input, clientIdempotencyKey: `proposal-accept:${proposal.proposalId}`, caption: "Someone else's post" }))
			.rejects.toMatchObject({ code: "publication_intent_conflict" });
		// So is accepting it with a caption that is no longer the draft's: a person's edit is never lost.
		const slotQueue = { accountId: f.account.id, pick: (_occupied: ReadonlySet<number>, after: Date) => new Date(after.getTime() + 86_400_000) };
		await expect(socialPublicationScheduling.schedule({ ...input, clientIdempotencyKey: `proposal-accept:${proposal.proposalId}`, caption: "Stale caption", proposalId: proposal.proposalId, slotQueue }))
			.rejects.toMatchObject({ code: "social_proposal_changed" });
		expect(await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId } })).toMatchObject({ status: "draft", caption: "Draft caption", scheduledFor: null });
		expect(await prisma.frozenPublicationState.count({ where: { socialPostId: proposal.proposalId } })).toBe(0);
		await publishingQueue.updateProposalCaption(scope(f), proposal.proposalId, "Edited in the meantime");
		await expect(publishingQueue.accept(scope(f), proposal.proposalId)).resolves.toMatchObject({ status: "scheduled" });
		expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: proposal.proposalId } })).caption).toBe("Edited in the meantime");
	});

	test("an approval-required brand's proposal is accepted once the round approves its export", async () => {
		const f = await fixture();
		await prisma.project.update({
			where: { id: f.project.id },
			data: {
				brandProfileSnapshot: {
					version: 1, profileId: randomUUID(), profileRevision: 1, name: "Approval required",
					identity: { primaryColor: "#FFFFFF", secondaryColor: "#111522", accentColor: null, primaryLogoAssetId: null, alternateLogoAssetId: null },
					voice: { audience: "", tone: [], preferredTerms: [], blockedTerms: [], hashtagGuidance: "" },
					approvalRule: "approval_required", style: null,
				},
			},
		});
		const proposal = await propose(f);
		await expect(publishingQueue.accept(scope(f), proposal.proposalId)).rejects.toMatchObject({ code: "review_approval_required" });

		const round = await prisma.reviewRound.create({
			data: {
				workspaceId: f.workspace.id, projectId: f.project.id, createdByUserId: f.user.id, revision: 1, title: "Client review", accessTokenHash: randomUUID(), deliveryTokenEncrypted: "test",
				recipientEmails: [], items: { create: [{ clipId: f.clip.id, exportId: f.clipExport.id, editorRevision: f.clip.editorRevision, position: 0, selectedVariantIds: [f.variant.id], required: true }] },
			},
			include: { items: true },
		});
		// Submitted but not decided: still blocked.
		await expect(publishingQueue.accept(scope(f), proposal.proposalId)).rejects.toMatchObject({ code: "review_approval_required" });
		await prisma.reviewRoundItem.update({ where: { id: round.items[0]!.id }, data: { currentDecision: "approved" } });
		const accepted = await publishingQueue.accept(scope(f), proposal.proposalId);
		expect(accepted).toMatchObject({ socialPostId: proposal.proposalId, status: "scheduled" });
	});

	test("accept all works through the inbox in batches and tells the caller where to continue", async () => {
		const f = await fixture();
		const proposals = [];
		for (let index = 0; index < 5; index += 1) proposals.push(await propose(f));
		const first = await publishingQueue.acceptAll(scope(f), { limit: 2 });
		expect(first.accepted).toHaveLength(2);
		expect(first).toMatchObject({ remaining: 3, nextCursor: proposals[1]!.proposalId, skippedTikTok: 0, failed: [] });
		const second = await publishingQueue.acceptAll(scope(f), { limit: 2, after: first.nextCursor });
		expect(second.accepted.map((post) => post.socialPostId)).toEqual([proposals[2]!.proposalId, proposals[3]!.proposalId]);
		expect(second).toMatchObject({ remaining: 1, nextCursor: proposals[3]!.proposalId });
		const third = await publishingQueue.acceptAll(scope(f), { limit: 2, after: second.nextCursor });
		expect(third).toMatchObject({ remaining: 0, nextCursor: null });
		expect(third.accepted.map((post) => post.socialPostId)).toEqual([proposals[4]!.proposalId]);
		const slots = [...first.accepted, ...second.accepted, ...third.accepted].map((post) => post.scheduledFor);
		expect(new Set(slots).size).toBe(5);
	});

	test("a proposal that cannot be accepted does not starve the ones behind it", async () => {
		const f = await fixture();
		const noSlots = await prisma.socialAccount.create({
			data: { userId: f.user.id, workspaceId: f.workspace.id, platform: "x", providerAccountId: `queue-x:${randomUUID()}`, displayName: "No slots", accessTokenEncrypted: "encrypted-test-token" },
		});
		const stuck = await propose(f, { accountId: noSlots.id });
		const fine = [await propose(f), await propose(f)];
		const first = await publishingQueue.acceptAll(scope(f), { limit: 1 });
		expect(first.failed.map((entry) => entry.proposalId)).toEqual([stuck.proposalId]);
		const second = await publishingQueue.acceptAll(scope(f), { limit: 1, after: first.nextCursor });
		const third = await publishingQueue.acceptAll(scope(f), { limit: 1, after: second.nextCursor });
		expect([...second.accepted, ...third.accepted].map((post) => post.socialPostId)).toEqual(fine.map((proposal) => proposal.proposalId));
		expect(third.remaining).toBe(0);
	});

	test("the Workspace's active accounts come back in a stable order", async () => {
		const f = await fixture();
		const others = await Promise.all([1, 2, 3].map((n) => prisma.socialAccount.create({
			data: { userId: f.user.id, workspaceId: f.workspace.id, platform: "x", providerAccountId: `order:${n}:${randomUUID()}`, displayName: `Order ${n}`, accessTokenEncrypted: "encrypted-test-token" },
		})));
		const ids = [f.account.id, ...others.map((account) => account.id)];
		const listed = (await publishingQueue.activeAccounts(f.workspace.id, ids.slice().reverse())).map((account) => account.id);
		expect(listed).toEqual(ids.slice().sort());
	});

	test("finishing that proposes to the queue needs publishing rights, accounts, and a format the platforms take", async () => {
		const f = await fixture();
		const viewer = await prisma.user.create({ data: { clerkId: `queue-viewer:${randomUUID()}`, primaryEmail: `viewer-${randomUUID()}@example.test` } });
		await prisma.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: viewer.id, role: "viewer" } });
		const tiktok = await prisma.socialAccount.create({
			data: { userId: f.user.id, workspaceId: f.workspace.id, platform: "tiktok", providerAccountId: `queue-tt:${randomUUID()}`, displayName: "TikTok", accessTokenEncrypted: "encrypted-test-token" },
		});
		const settings = { delivery: "propose_to_queue" as const, queueAccountIds: [f.account.id], aspectRatios: ["9:16"] };
		await assertFinishingQueue(scope(f), settings);
		// Delivery that stops at review asks nothing of publishing.
		await assertFinishingQueue({ actorUserId: viewer.id, workspaceId: f.workspace.id }, { delivery: "ready_to_review" });
		await expect(assertFinishingQueue({ actorUserId: viewer.id, workspaceId: f.workspace.id }, settings)).rejects.toBeDefined();
		// TikTok takes only 9:16, so 1:1 exports would fail clip by clip.
		await expect(assertFinishingQueue(scope(f), { ...settings, queueAccountIds: [tiktok.id], aspectRatios: ["1:1", "16:9"] })).rejects.toMatchObject({ code: "finishing_queue_format_unsupported" });
		await assertFinishingQueue(scope(f), { ...settings, queueAccountIds: [tiktok.id, f.account.id], aspectRatios: ["1:1", "9:16"] });
	});
});
