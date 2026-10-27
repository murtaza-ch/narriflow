import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { buildGenerationContentPack } from "@narriflow/validators";
import { autopilotService } from "./autopilot.service";
import { recipeService } from "./recipe.service";
import { publishingQueue } from "./publishing-queue.service";
import { ReviewNotificationService, createReviewNotificationStore, type ReviewNotificationMailInput } from "./review-notification.service";
import { claimDueSocialPublicationAttempts, prismaSocialPublicationAttemptStore } from "./social-publication-attempt";
import { socialPublicationRecovery } from "./social-publication-recovery";
import { emitSocialPostFinished } from "./social-post-finished";
import { socialOAuthService } from "./social-oauth.service";
import { createStandingGrants, ruleFingerprint } from "./standing-grant";
import { acceptProposalUnderGrant, getStandingGrantMaintenance, reviewerOptOut, sendReviewRoundUnderGrant, standingGrants } from "./standing-grant-runtime";
import { workspaceMembershipService } from "./workspace-membership.service";
import { workspaceService } from "./workspace.service";
import { listWorkspaceEvents } from "./workspace-event";
import { signReviewOptOutToken } from "./review-opt-out";
import { reviewDeliverySecret } from "./review.service";

const databaseUrl = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_URL;
const databaseSchema = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_SOCIAL_PUBLICATION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY ??= "standing-grant-test-key-not-a-secret";

const EVERY_DAY = {
	slots: (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).flatMap((weekday) => [
		{ weekday, time: "09:00" },
		{ weekday, time: "17:00" },
	]),
};

const claimConfig = {
	batchSize: 20,
	leaseMs: 60_000,
	processingDeadlineMs: 3_600_000,
	reconciliationDeadlineMs: 7_200_000,
	providerCallBudget: 12,
};

const APPROVAL_REQUIRED_SNAPSHOT = {
	version: 1, profileId: randomUUID(), profileRevision: 1, name: "Approval required",
	identity: { primaryColor: "#FFFFFF", secondaryColor: "#111522", accentColor: null, primaryLogoAssetId: null, alternateLogoAssetId: null },
	voice: { audience: "", tone: [], preferredTerms: [], blockedTerms: [], hashtagGuidance: "" },
	approvalRule: "approval_required", style: null, audio: { music: [], sfx: [] },
};

dbDescribe("Standing Grant PostgreSQL invariants", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let previousGlobalPrisma: PrismaClient | undefined;
	let previousReviewSecret: string | undefined;
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
		previousReviewSecret = process.env.REVIEW_ACCESS_SECRET;
		process.env.REVIEW_ACCESS_SECRET = "standing-grant-review-secret-0123456789abcdef";
	});

	afterAll(async () => {
		prismaGlobal.narriflowPrismaClient = previousGlobalPrisma;
		if (previousReviewSecret === undefined) delete process.env.REVIEW_ACCESS_SECRET;
		else process.env.REVIEW_ACCESS_SECRET = previousReviewSecret;
		await prisma?.$disconnect();
		await pool?.end();
	});

	/** A Workspace whose Autopilot rule imported a Project with a finished export, a YouTube account that has slots, and a TikTok account. */
	async function fixture(options: { tier?: "business" | "pro" | "creator" | "free" } = {}) {
		const suffix = randomUUID();
		const user = (role: string) => prisma.user.create({ data: { clerkId: `grant-db-${role}:${suffix}`, primaryEmail: `${role}-${suffix}@example.test`, emailVerifiedAt: new Date() } });
		const [owner, editor, admin] = [await user("owner"), await user("editor"), await user("admin")];
		const workspace = await prisma.workspace.create({ data: { name: "Grant DB test", ownerUserId: owner.id, personalOwnerUserId: owner.id, pricingTier: options.tier ?? "business" } });
		await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "owner" } });
		await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: editor.id, role: "editor" } });
		await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: admin.id, role: "admin" } });
		const recipe = await prisma.recipe.create({
			data: { workspaceId: workspace.id, createdByUserId: owner.id, name: "Weekly settings", contentPack: buildGenerationContentPack() as object },
		});
		const rule = await prisma.autopilotRule.create({
			data: { workspaceId: workspace.id, createdByUserId: owner.id, name: "Weekly show", rssUrl: `https://feeds.example.test/${suffix}.xml`, recipeId: recipe.id },
		});
		const account = await prisma.socialAccount.create({
			data: {
				userId: owner.id, workspaceId: workspace.id, createdByUserId: owner.id, platform: "youtube_shorts", providerAccountId: `grant-yt:${suffix}`,
				displayName: "Grant YouTube", accessTokenEncrypted: "encrypted-test-token", scopes: ["video.upload", "video.publish"], postingSchedule: EVERY_DAY,
			},
		});
		const tiktok = await prisma.socialAccount.create({
			data: {
				userId: owner.id, workspaceId: workspace.id, createdByUserId: owner.id, platform: "tiktok", providerAccountId: `grant-tt:${suffix}`,
				displayName: "Grant TikTok", accessTokenEncrypted: "encrypted-test-token", scopes: ["video.upload", "video.publish"], postingSchedule: EVERY_DAY,
			},
		});
		const generated = await generation({ workspaceId: workspace.id, ownerId: owner.id, ruleId: rule.id });
		const finishing = await finishingRow({ workspaceId: workspace.id, ownerId: owner.id, projectId: generated.project.id, ruleId: rule.id });
		return { owner, editor, admin, workspace, recipe, rule, account, tiktok, finishing, ...generated };
	}
	type Fixture = Awaited<ReturnType<typeof fixture>>;

	/** One Project the rule imported, with a clip and its finished export. */
	async function generation(input: { workspaceId: string; ownerId: string; ruleId: string }) {
		const suffix = randomUUID();
		const project = await prisma.project.create({
			data: { title: "Grant fixture", sourceMediaUrl: "r2://test/source.mp4", workspaceId: input.workspaceId, createdByUserId: input.ownerId },
		});
		await prisma.autopilotEpisode.create({ data: { ruleId: input.ruleId, episodeId: suffix, projectId: project.id } });
		const run = await prisma.workflowRun.create({ data: { projectId: project.id, idempotencyKey: `grant:${suffix}`, stage: "clip_rendering", status: "completed" } });
		const clip = await prisma.clip.create({
			data: {
				projectId: project.id, workflowRunId: run.id, index: 0, startSec: 0, endSec: 30, hookText: "Grant test clip", reasoning: "Fixture",
				category: "hook", transcriptSlice: [], viralityScore: 80, hookStrengthScore: 80, emotionalIntensityScore: 70, pacingScore: 70,
				durationOptimalityScore: 80, tiktokScore: 80, youtubeScore: 80, instagramScore: 80, llmProvider: "test", llmModel: "test",
			},
		});
		const clipExport = await prisma.clipExport.create({
			data: {
				projectId: project.id, workspaceId: input.workspaceId, createdByUserId: input.ownerId, clipId: clip.id, editorRevision: clip.editorRevision,
				fingerprint: `grant:${suffix}`, resolution: "1080p", watermark: false, status: "ready", progress: 100, completedAt: new Date(),
			},
		});
		const variant = await prisma.clipExportVariant.create({
			data: {
				exportId: clipExport.id, aspectRatio: "ratio_9_16", resolution: "1080p", watermark: false, status: "completed",
				storageKey: `tests/${suffix}.mp4`, sizeBytes: 1_024n, durationSec: 30, completedAt: new Date(),
			},
		});
		return { project, clip, clipExport, variant };
	}

	/** A finishing row for a generation. The Autopilot import is what names the rule on it; a request's finishing names none. */
	async function finishingRow(input: { workspaceId: string; ownerId: string; projectId: string; ruleId: string | null }) {
		const stt = await prisma.workflowRun.create({ data: { projectId: input.projectId, idempotencyKey: `grant-stt:${randomUUID()}`, stage: "stt", status: "completed" } });
		return prisma.generationFinishing.create({
			data: {
				workspaceId: input.workspaceId, projectId: input.projectId, originRunId: stt.id, actorUserId: input.ownerId, state: "running", autopilotRuleId: input.ruleId,
				settings: { topClips: 1, minScore: 0, aspectRatios: ["9:16"], resolution: "1080p", copyPlatforms: [], delivery: "send_review_round", queueAccountIds: [] },
			},
		});
	}
	const finishingFor = (f: Fixture, generated: { project: { id: string } } = f, ruleId: string | null = f.rule.id) =>
		finishingRow({ workspaceId: f.workspace.id, ownerId: f.owner.id, projectId: generated.project.id, ruleId });

	const scope = (f: Fixture, user: "owner" | "editor" | "admin" = "owner") => ({ actorUserId: f[user].id, workspaceId: f.workspace.id });
	const publishTerms = (f: Fixture, terms: { dailyCap?: number; weeklyCap?: number } = {}) =>
		({ kind: "publish", autopilotRuleId: f.rule.id, socialAccountId: f.account.id, dailyCap: terms.dailyCap ?? 3, weeklyCap: terms.weeklyCap ?? 10, expiresInDays: 30 }) as const;
	const publishGrant = (f: Fixture, terms: { dailyCap?: number; weeklyCap?: number } = {}) => standingGrants.create(scope(f), publishTerms(f, terms));
	const reviewGrant = (f: Fixture, terms: { dailyCap?: number; weeklyCap?: number; reviewers?: string[] } = {}) =>
		standingGrants.create(scope(f), { kind: "review_send", autopilotRuleId: f.rule.id, reviewerEmails: terms.reviewers ?? ["Client@Example.test", "editor@example.test"], dailyCap: terms.dailyCap ?? 3, weeklyCap: terms.weeklyCap ?? 10, expiresInDays: 30 });
	const renewTerms = { dailyCap: 3, weeklyCap: 10, expiresInDays: 30 };
	const grantRow = (id: string) => prisma.standingGrant.findUniqueOrThrow({ where: { id } });
	const grantEvents = async (workspaceId: string, type: "grant.paused" | "grant.expired") => (await listWorkspaceEvents(prisma, { workspaceId }, { types: [type] })).data;

	async function propose(f: Fixture, accountId = f.account.id) {
		const result = await publishingQueue.propose(
			scope(f),
			{ clipId: f.clip.id, exportId: f.clipExport.id, socialAccountId: accountId, caption: "Draft caption" },
			{ source: "finishing", mutation: { clientIdempotencyKey: randomUUID() } },
		);
		return result.proposal.proposalId;
	}
	const accept = (f: Fixture, proposalId: string, finishingId = f.finishing.id) =>
		acceptProposalUnderGrant({ finishingId, workspaceId: f.workspace.id, projectId: f.project.id, proposalId });
	const post = (id: string) => prisma.socialPost.findUniqueOrThrow({ where: { id }, include: { proposal: true, frozenState: true } });
	/** Far enough ahead that every slot has come due, and still inside a 30-day grant. */
	const later = () => new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
	/** Other tests leave pause notices pending in the shared schema; a pass would stop at the first it can't send. */
	const clearOtherNotices = (except: string[]) => prisma.standingGrant.updateMany({ where: { id: { notIn: except }, pauseNoticePending: true }, data: { pauseNoticePending: false } });

	async function settle(postId: string, status: "failed" | "needs_attention") {
		await prisma.socialPost.update({ where: { id: postId }, data: { status } });
		await prisma.$transaction((tx) => emitSocialPostFinished(tx, { socialPostId: postId }));
	}

	test("only Owners and Admins grant, TikTok can't hold a grant, and a destination takes one grant", async () => {
		const f = await fixture();
		const terms = { dailyCap: 2, weeklyCap: 5, expiresInDays: 30 };
		await expect(standingGrants.create(scope(f, "editor"), { kind: "publish", autopilotRuleId: f.rule.id, socialAccountId: f.account.id, ...terms }))
			.rejects.toMatchObject({ code: "workspace_access_denied" });
		await expect(standingGrants.create(scope(f), { kind: "publish", autopilotRuleId: f.rule.id, socialAccountId: f.tiktok.id, ...terms }))
			.rejects.toMatchObject({ code: "standing_grant_tiktok_excluded" });
		await expect(standingGrants.create(scope(f), { kind: "publish", autopilotRuleId: randomUUID(), socialAccountId: f.account.id, ...terms }))
			.rejects.toMatchObject({ code: "standing_grant_rule_not_found" });
		await expect(standingGrants.create(scope(f), { kind: "publish", autopilotRuleId: f.rule.id, socialAccountId: randomUUID(), ...terms }))
			.rejects.toMatchObject({ code: "standing_grant_account_unavailable" });
		expect(await prisma.standingGrant.count({ where: { workspaceId: f.workspace.id } })).toBe(0);

		const { id } = await publishGrant(f);
		expect(await grantRow(id)).toMatchObject({ kind: "publish", status: "active", revision: 1, grantedByUserId: f.owner.id, socialAccountId: f.account.id, ruleFingerprint: await ruleFingerprint(prisma, f.rule.id) });
		await expect(publishGrant(f)).rejects.toMatchObject({ code: "standing_grant_duplicate" });
		// Two requests at once make one grant.
		const other = await fixture();
		const results = await Promise.allSettled([publishGrant(other), publishGrant(other)]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(await prisma.standingGrant.count({ where: { workspaceId: other.workspace.id } })).toBe(1);

		// The expiry can't be beyond 90 days, and weekly can't be under daily.
		await expect(standingGrants.create(scope(f), { kind: "review_send", autopilotRuleId: f.rule.id, reviewerEmails: ["a@example.test"], dailyCap: 1, weeklyCap: 1, expiresInDays: 91 })).rejects.toThrow();
		await expect(standingGrants.create(scope(f), { kind: "review_send", autopilotRuleId: f.rule.id, reviewerEmails: ["a@example.test"], dailyCap: 3, weeklyCap: 2, expiresInDays: 30 })).rejects.toThrow();

		// Members can see grants, with their history.
		const seen = await standingGrants.list(scope(f, "editor"));
		expect(seen.find((grant) => grant.id === id)).toMatchObject({ status: "active", usedDay: 0, usedWeek: 0, ruleName: "Weekly show", history: [{ kind: "created", actorName: expect.any(String) }] });
	});

	test("the maintenance sweep pauses grants the plan no longer covers, and an upgrade leaves them paused", async () => {
		const f = await fixture({ tier: "pro" });
		const { id } = await publishGrant(f);
		await getStandingGrantMaintenance(() => null).expireDue();
		expect(await grantRow(id)).toMatchObject({ status: "active" });
		await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "creator" } });
		await getStandingGrantMaintenance(() => null).expireDue();
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "plan_lost" });
		await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "pro" } });
		await getStandingGrantMaintenance(() => null).expireDue();
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "plan_lost" });
		await expect(standingGrants.renew(scope(f), { grantId: id, ...renewTerms })).resolves.toBeUndefined();
		expect(await grantRow(id)).toMatchObject({ status: "active" });
	});

	test("a review-send grant needs Business, and a publish grant needs Pro and an account the plan publishes to", async () => {
		const pro = await fixture({ tier: "pro" });
		await expect(reviewGrant(pro)).rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "review.rooms", requiredTier: "business" } });
		await expect(publishGrant(pro)).resolves.toBeDefined();
		const creator = await fixture({ tier: "creator" });
		await expect(publishGrant(creator)).rejects.toMatchObject({ code: "plan_feature_required", details: { feature: "campaign.operations", requiredTier: "pro" } });
	});

	test("members see that reviewers exist but not who they are, and every grant gets its own usage", async () => {
		const f = await fixture();
		const post1 = await publishGrant(f, { dailyCap: 5 });
		const review = await reviewGrant(f);
		expect(await accept(f, await propose(f))).toBe("accepted");
		expect(await sendReviewRoundUnderGrant({ finishingId: f.finishing.id, workspaceId: f.workspace.id, projectId: f.project.id, exportIds: [f.clipExport.id] })).toEqual({ sent: true });

		const asManager = await standingGrants.list(scope(f, "admin"));
		const asMember = await standingGrants.list(scope(f, "editor"));
		for (const view of [asManager, asMember]) {
			expect(view.find((grant) => grant.id === post1.id)).toMatchObject({ usedDay: 1, usedWeek: 1, sent: [{ kind: "post" }] });
			expect(view.find((grant) => grant.id === review.id)).toMatchObject({ usedDay: 1, usedWeek: 1, reviewerCount: 2, sent: [{ kind: "round" }] });
		}
		expect(asManager.find((grant) => grant.id === review.id)?.reviewerEmails).toEqual(["client@example.test", "editor@example.test"]);
		expect(asMember.find((grant) => grant.id === review.id)).toMatchObject({ reviewerEmails: [], optedOut: [] });
	});

	test("proposals are accepted into slots within the daily cap, and over it they stay proposals", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f, { dailyCap: 2, weeklyCap: 10 });
		const proposals = [await propose(f), await propose(f), await propose(f)];

		expect(await accept(f, proposals[0]!)).toBe("accepted");
		expect(await accept(f, proposals[1]!)).toBe("accepted");
		expect(await accept(f, proposals[2]!)).toBe("standing_grant_cap_reached");

		const accepted = await Promise.all(proposals.map(post));
		expect(accepted.map((entry) => entry.status)).toEqual(["scheduled", "scheduled", "draft"]);
		// Each accepted post records the grant and revision as its evidence, and the granter as who accepted it.
		for (const entry of accepted.slice(0, 2)) {
			expect(entry).toMatchObject({ standingGrantId: id, standingGrantRevision: 1, reviewApprovalOverrideId: null });
			expect(entry.proposal).toMatchObject({ acceptedByUserId: f.owner.id });
			expect(entry.scheduledFor).not.toBeNull();
		}
		expect(accepted[0]!.scheduledFor!.getTime()).not.toBe(accepted[1]!.scheduledFor!.getTime());
		expect(accepted[2]).toMatchObject({ standingGrantId: null, scheduledFor: null });
		expect((await standingGrants.list(scope(f))).find((grant) => grant.id === id)).toMatchObject({ usedDay: 2, usedWeek: 2 });

		// The refused proposal is still there for a person, who is not held to the cap.
		const byPerson = await publishingQueue.accept(scope(f), proposals[2]!);
		expect(byPerson.status).toBe("scheduled");
		expect(await post(proposals[2]!)).toMatchObject({ standingGrantId: null });

		// A repeat of an accepted proposal finds it accepted, and takes no more of the cap.
		expect(await accept(f, proposals[0]!)).toBe("accepted");
		expect((await standingGrants.list(scope(f))).find((grant) => grant.id === id)).toMatchObject({ usedDay: 2 });
	});

	test("the weekly cap holds after the day's has cleared", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f, { dailyCap: 2, weeklyCap: 3 });
		const first = [await propose(f), await propose(f)];
		for (const proposalId of first) expect(await accept(f, proposalId)).toBe("accepted");
		// Two days on, the day is clear and the week holds those two.
		await prisma.socialPostProposal.updateMany({ where: { socialPostId: { in: first } }, data: { acceptedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } });
		expect((await standingGrants.list(scope(f))).find((grant) => grant.id === id)).toMatchObject({ usedDay: 0, usedWeek: 2 });
		expect(await accept(f, await propose(f))).toBe("accepted");
		expect(await accept(f, await propose(f))).toBe("standing_grant_cap_reached");
	});

	test("concurrent proposals never take more than the cap", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f, { dailyCap: 2, weeklyCap: 10 });
		const proposals = await Promise.all(Array.from({ length: 5 }, () => propose(f)));
		const outcomes = await Promise.all(proposals.map((proposalId) => accept(f, proposalId)));
		expect(outcomes.filter((outcome) => outcome === "accepted")).toHaveLength(2);
		expect(outcomes.filter((outcome) => outcome === "standing_grant_cap_reached")).toHaveLength(3);
		expect(await prisma.socialPost.count({ where: { standingGrantId: id, status: "scheduled" } })).toBe(2);
		expect(await prisma.socialPost.count({ where: { id: { in: proposals }, status: "draft" } })).toBe(3);
	});

	test("an approval-required brand still needs an approved round, and the grant overrides nothing", async () => {
		const f = await fixture();
		await prisma.project.update({ where: { id: f.project.id }, data: { brandProfileSnapshot: APPROVAL_REQUIRED_SNAPSHOT } });
		const { id } = await publishGrant(f);
		const proposalId = await propose(f);

		expect(await accept(f, proposalId)).toBe("review_approval_required");
		expect(await post(proposalId)).toMatchObject({ status: "draft", standingGrantId: null });
		expect(await prisma.reviewApprovalOverride.count({ where: { workspaceId: f.workspace.id } })).toBe(0);

		// A round that approved this export is what the rule asks for.
		await prisma.reviewRound.create({
			data: {
				workspaceId: f.workspace.id, projectId: f.project.id, createdByUserId: f.owner.id, revision: 1, status: "open", title: "Client round",
				accessTokenHash: randomUUID(), deliveryTokenEncrypted: "unused", recipientEmails: [], approvalRequired: true,
				items: { create: { clipId: f.clip.id, exportId: f.clipExport.id, editorRevision: f.clipExport.editorRevision, position: 0, selectedVariantIds: [f.variant.id], required: true, currentDecision: "approved" } },
			},
		});
		expect(await accept(f, proposalId)).toBe("accepted");
		expect(await post(proposalId)).toMatchObject({ status: "scheduled", standingGrantId: id, reviewApprovalOverrideId: null });
		expect(await prisma.reviewApprovalOverride.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
	});

	test("only an active, unexpired grant of the right rule and account accepts, and TikTok never does", async () => {
		const f = await fixture();
		const proposalId = await propose(f);
		expect(await accept(f, proposalId)).toBe("no_grant");

		const { id } = await publishGrant(f);
		await standingGrants.pause(scope(f), id);
		expect(await accept(f, proposalId)).toBe("no_grant");
		await standingGrants.renew(scope(f), { grantId: id, ...renewTerms });
		await prisma.standingGrant.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
		expect(await accept(f, proposalId)).toBe("no_grant");
		await prisma.standingGrant.update({ where: { id }, data: { expiresAt: new Date(Date.now() + 60_000) } });
		expect(await accept(f, proposalId)).toBe("accepted");

		// A TikTok proposal always waits for the creator's choices, even if a grant row existed.
		await prisma.standingGrant.create({
			data: {
				workspaceId: f.workspace.id, kind: "publish", autopilotRuleId: f.rule.id, socialAccountId: f.tiktok.id, dailyCap: 5, weeklyCap: 5,
				expiresAt: new Date(Date.now() + 60_000), grantedByUserId: f.owner.id, ruleFingerprint: (await ruleFingerprint(prisma, f.rule.id))!,
			},
		});
		const tiktokProposal = await propose(f, f.tiktok.id);
		expect(await accept(f, tiktokProposal)).toBe("tiktok_excluded");
		expect(await post(tiktokProposal)).toMatchObject({ status: "draft", standingGrantId: null });
	});

	test("a request's finishing for a rule's Project is never covered by that rule's grants", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f);
		const review = await reviewGrant(f);
		// generate_clips on a Project the rule imported freezes its own finishing, which names no rule.
		const requested = await finishingFor(f, f, null);
		const proposalId = await propose(f);
		expect(await accept(f, proposalId, requested.id)).toBe("no_grant");
		expect(await post(proposalId)).toMatchObject({ status: "draft", standingGrantId: null });
		expect(await sendReviewRoundUnderGrant({ finishingId: requested.id, workspaceId: f.workspace.id, projectId: f.project.id, exportIds: [f.clipExport.id] }))
			.toEqual({ sent: false, reason: "review_not_sent_no_grant" });
		// The row the rule's own import froze is covered by both.
		expect(await accept(f, proposalId)).toBe("accepted");
		expect(await post(proposalId)).toMatchObject({ standingGrantId: id });
		expect(await sendReviewRoundUnderGrant({ finishingId: f.finishing.id, workspaceId: f.workspace.id, projectId: f.project.id, exportIds: [f.clipExport.id] })).toEqual({ sent: true });
		expect(await prisma.reviewRound.count({ where: { standingGrantId: review.id } })).toBe(1);
	});

	test("an edit to the rule pauses its grants, and renewing approves the new settings", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f);
		const bound = (await grantRow(id)).ruleFingerprint;
		// Renaming changes nothing the grant depends on.
		await autopilotService.updateRule(scope(f, "editor"), f.rule.id, { name: "Renamed show" });
		expect(await grantRow(id)).toMatchObject({ status: "active", ruleFingerprint: bound });

		// An Editor can edit a rule, but not widen what a grant allows.
		await autopilotService.updateRule(scope(f, "editor"), f.rule.id, { titlePrefix: "Now: " });
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "rule_changed", pauseNoticePending: true });
		expect((await grantEvents(f.workspace.id, "grant.paused")).map((event) => event.subject)).toEqual([{ grantId: id, kind: "publish", autopilotRuleId: f.rule.id, reason: "rule_changed" }]);
		const proposalId = await propose(f);
		expect(await accept(f, proposalId)).toBe("no_grant");

		await standingGrants.renew(scope(f), { grantId: id, ...renewTerms });
		expect((await grantRow(id)).ruleFingerprint).not.toBe(bound);
		expect(await accept(f, proposalId)).toBe("accepted");
	});

	test("a Recipe content edit pauses the grants of the rules that use it; a rename does not", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f);
		const review = await reviewGrant(f);
		const bound = (await grantRow(id)).ruleFingerprint;
		const read = () => prisma.recipe.findUniqueOrThrow({ where: { id: f.recipe.id } });

		// A rename moves the Recipe's edit revision, not its content revision, and not the fingerprint.
		await recipeService.update(scope(f, "editor"), f.recipe.id, { expectedRevision: 1, name: "Renamed settings" });
		expect(await read()).toMatchObject({ name: "Renamed settings", revision: 2, contentRevision: 1 });
		expect(await grantRow(id)).toMatchObject({ status: "active", ruleFingerprint: bound });
		expect((await grantRow(review.id)).status).toBe("active");
		expect(await ruleFingerprint(prisma, f.rule.id)).toBe(bound);
		// Renaming the rule is no change either.
		await autopilotService.updateRule(scope(f, "editor"), f.rule.id, { name: "Renamed rule" });
		expect(await ruleFingerprint(prisma, f.rule.id)).toBe(bound);

		// Content an editor changes in the Recipe pauses every grant covering a rule that uses it, with the notice and audit path.
		await recipeService.update(scope(f, "editor"), f.recipe.id, { expectedRevision: 2, contentPack: buildGenerationContentPack({ clipCountTarget: 12 }) });
		expect(await read()).toMatchObject({ revision: 3, contentRevision: 2 });
		for (const granted of [id, review.id]) {
			expect(await grantRow(granted)).toMatchObject({ status: "paused", pausedReason: "rule_changed", pauseNoticePending: true });
		}
		const paused = (await grantEvents(f.workspace.id, "grant.paused")).map((event) => event.subject);
		expect(paused).toHaveLength(2);
		expect(paused).toEqual(expect.arrayContaining([
			{ grantId: id, kind: "publish", autopilotRuleId: f.rule.id, reason: "rule_changed" },
			{ grantId: review.id, kind: "review_send", autopilotRuleId: f.rule.id, reason: "rule_changed" },
		]));
		expect(await accept(f, await propose(f))).toBe("no_grant");

		// Renewing approves the Recipe as it is now.
		await standingGrants.renew(scope(f), { grantId: id, ...renewTerms });
		expect((await grantRow(id)).ruleFingerprint).not.toBe(bound);
	});

	test("pointing a rule at another Recipe pauses its grants", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f);
		const other = await prisma.recipe.create({ data: { workspaceId: f.workspace.id, createdByUserId: f.owner.id, name: "Other", contentPack: buildGenerationContentPack() as object } });
		await autopilotService.updateRule(scope(f, "editor"), f.rule.id, { recipeId: other.id });
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "rule_changed" });
	});

	test("a rule changed behind the service's back is caught when the grant is next used, and a Brand Profile that stops requiring approval counts", async () => {
		const f = await fixture();
		const profile = await prisma.brandProfile.create({
			data: { workspaceId: f.workspace.id, createdByUserId: f.owner.id, updatedByUserId: f.owner.id, name: "Client", slug: `client-${randomUUID()}`, visualIdentity: {}, voiceGuidance: {}, approvalRule: "approval_required" },
		});
		await prisma.recipe.update({ where: { id: f.recipe.id }, data: { brandProfileId: profile.id } });
		const { id } = await publishGrant(f);
		const proposalId = await propose(f);

		// The profile that required a client's approval stops requiring it.
		await prisma.brandProfile.update({ where: { id: profile.id }, data: { approvalRule: "none" } });
		expect(await accept(f, proposalId)).toBe("standing_grant_rule_changed");
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "rule_changed" });
		expect(await post(proposalId)).toMatchObject({ status: "draft", standingGrantId: null });

		// So does pointing the rule at no profile at all, and the review path reads the same fingerprint.
		await standingGrants.renew(scope(f), { grantId: id, ...renewTerms });
		await prisma.recipe.update({ where: { id: f.recipe.id }, data: { brandProfileId: null } });
		expect(await accept(f, proposalId)).toBe("standing_grant_rule_changed");
		const review = await reviewGrant(f);
		// A Recipe revision bump the service didn't make (so no eager pause) is caught at delivery.
		await prisma.recipe.update({ where: { id: f.recipe.id }, data: { contentRevision: { increment: 1 } } });
		expect(await sendReviewRoundUnderGrant({ finishingId: f.finishing.id, workspaceId: f.workspace.id, projectId: f.project.id, exportIds: [f.clipExport.id] }))
			.toEqual({ sent: false, reason: "review_not_sent_changed" });
		expect((await grantRow(review.id)).status).toBe("paused");
		expect(await prisma.reviewRound.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
	});

	test("a failed or needs-attention post a grant accepted pauses that grant, once, and tells its granter", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f);
		const byPerson = await publishingQueue.accept(scope(f), await propose(f));
		const proposalId = await propose(f);
		expect(await accept(f, proposalId)).toBe("accepted");

		// A post a person accepted doesn't pause the grant.
		await settle(byPerson.socialPostId, "failed");
		expect((await grantRow(id)).status).toBe("active");

		await settle(proposalId, "failed");
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "post_failed", pauseNoticePending: true });
		expect((await prisma.standingGrantEvent.findMany({ where: { grantId: id, kind: "paused" } }))).toMatchObject([{ revision: 1, reason: "post_failed", actorUserId: null }]);
		// The grant's event and the post's are written together, and a replay adds neither.
		await prisma.$transaction((tx) => emitSocialPostFinished(tx, { socialPostId: proposalId }));
		const paused = await grantEvents(f.workspace.id, "grant.paused");
		expect(paused.map((event) => event.subject)).toEqual([{ grantId: id, kind: "publish", autopilotRuleId: f.rule.id, reason: "post_failed" }]);
		const finished = (await listWorkspaceEvents(prisma, { workspaceId: f.workspace.id }, { types: ["social_post.finished"] })).data;
		expect(finished.filter((event) => (event.subject as { socialPostId: string }).socialPostId === proposalId)).toHaveLength(1);

		// A paused grant accepts nothing more: the next proposal waits for a person.
		const next = await propose(f);
		expect(await accept(f, next)).toBe("no_grant");

		// The granter hears once. A send that is skipped is tried again.
		const sent: Array<{ to: string; grantId: string; reason: string; idempotencyKey: string }> = [];
		let clock = new Date();
		let answer: { sent: true } | { sent: false; reason: string } = { sent: false, reason: "emails_disabled" };
		const notifier = createStandingGrants({
			prisma,
			requireActor: (userId, workspaceId, capability) => workspaceService.requireActor(userId, workspaceId, capability),
			now: () => clock,
			notifyPaused: async (notice) => {
				sent.push(notice);
				return answer;
			},
		});
		await clearOtherNotices([id]);
		await notifier.notifyPaused(100);
		expect((await grantRow(id)).pauseNoticePending).toBe(true);
		clock = new Date(Date.now() + 10 * 60_000);
		answer = { sent: true };
		await notifier.notifyPaused(100);
		await notifier.notifyPaused(100);
		const mine = sent.filter((notice) => notice.grantId === id);
		expect(mine).toHaveLength(2);
		expect(mine[1]).toMatchObject({ to: f.owner.primaryEmail, ruleName: "Weekly show", destination: "Grant YouTube", idempotencyKey: `standing-grant-paused:${id}:1` });
		expect(await grantRow(id)).toMatchObject({ pauseNoticePending: false, pauseNoticeLeaseUntil: null });

		// Renewing resumes it under a new revision.
		await standingGrants.renew(scope(f), { grantId: id, ...renewTerms });
		expect(await grantRow(id)).toMatchObject({ status: "active", revision: 2, pausedReason: null });
		expect(await accept(f, next)).toBe("accepted");
		expect(await post(next)).toMatchObject({ standingGrantRevision: 2 });
		// A late outcome of a post accepted under the earlier revision doesn't pause the renewed grant.
		await settle(proposalId, "needs_attention");
		expect((await grantRow(id)).status).toBe("active");
		await settle(next, "needs_attention");
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "post_needs_attention" });
		expect(await grantEvents(f.workspace.id, "grant.paused")).toHaveLength(2);
	});

	test("a notice stays pending until it is sent: a failing send is retried, and a grant that moved on is not announced", async () => {
		const f = await fixture();
		const failing = await publishGrant(f);
		const renewed = await standingGrants.create(scope(f), { kind: "review_send", autopilotRuleId: f.rule.id, reviewerEmails: ["a@example.test"], ...renewTerms });
		const sweeper = createStandingGrants({ prisma, requireActor: (userId, workspaceId, capability) => workspaceService.requireActor(userId, workspaceId, capability) });
		await sweeper.pauseBySystem(failing.id, "post_failed");
		await sweeper.pauseBySystem(renewed.id, "post_failed");
		await clearOtherNotices([failing.id, renewed.id]);

		const sent: string[] = [];
		let clock = new Date();
		let throwOnce = true;
		const notifier = createStandingGrants({
			prisma,
			requireActor: (userId, workspaceId, capability) => workspaceService.requireActor(userId, workspaceId, capability),
			now: () => clock,
			log: () => {},
			notifyPaused: async (notice) => {
				if (notice.grantId === failing.id && throwOnce) {
					throwOnce = false;
					throw new Error("provider down");
				}
				sent.push(notice.grantId);
				return { sent: true };
			},
		});
		// One is renewed and one expires before any worker gets to them: neither is announced as paused.
		await standingGrants.renew(scope(f), { grantId: renewed.id, ...renewTerms });
		await notifier.notifyPaused(100);
		// The send that threw is still pending, held under its lease, and goes out once the lease has run out.
		expect(await grantRow(failing.id)).toMatchObject({ pauseNoticePending: true });
		expect(sent).not.toContain(failing.id);
		expect(sent).not.toContain(renewed.id);
		clock = new Date(Date.now() + 10 * 60_000);
		await notifier.notifyPaused(100);
		expect(sent.filter((id) => id === failing.id)).toHaveLength(1);
		expect(await grantRow(failing.id)).toMatchObject({ pauseNoticePending: false });

		// A paused grant that has since expired gets no "paused" email either.
		const expiring = await fixture();
		const lapsing = await publishGrant(expiring);
		await sweeper.pauseBySystem(lapsing.id, "post_failed");
		await prisma.standingGrant.update({ where: { id: lapsing.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
		await sweeper.expireDue();
		await clearOtherNotices([lapsing.id]);
		await notifier.notifyPaused(100);
		expect(sent).not.toContain(lapsing.id);
		expect((await grantRow(lapsing.id)).pauseNoticePending).toBe(false);
	});

	test("the real publisher's failure and uncertainty settle through the grant hook, and recovery doesn't resume the grant", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f, { dailyCap: 5 });
		const uncertain = await propose(f);
		expect(await accept(f, uncertain)).toBe("accepted");

		// The publisher claims the post and can't tell whether it was published.
		const claims = await claimDueSocialPublicationAttempts({ claimantId: "grant-worker", now: later(), config: claimConfig });
		const attempt = await prisma.socialPublicationAttempt.findFirstOrThrow({ where: { socialPostId: uncertain } });
		const owned = claims.find((claim) => claim.attemptId === attempt.id);
		if (!owned) throw new Error("expected the post to be claimed");
		await prismaSocialPublicationAttemptStore.settleUnknown({ owned, code: "publication_outcome_unknown", operation: null, sealedState: null, canReconcile: false, nextActionAt: null, now: later() });
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "post_needs_attention", pauseNoticePending: true });
		// The grant's pause is written with the post's own event, which follows it.
		const feed = (await listWorkspaceEvents(prisma, { workspaceId: f.workspace.id }, { types: ["grant.paused", "social_post.finished"] })).data;
		expect(feed.map((event) => event.type)).toEqual(["grant.paused", "social_post.finished"]);

		// A person confirms it was posted. That is the post's recovery, not the grant's: it stays paused.
		await socialPublicationRecovery.confirmPublished({
			workspaceId: f.workspace.id, projectId: f.project.id, actorUserId: f.owner.id, socialPostId: uncertain,
			reason: "Editor found the exact Short on the selected channel", evidenceKind: "manual_unvalidated", externalUrl: "https://youtube.com/shorts/grant-proof", now: later(),
		});
		expect((await grantRow(id)).status).toBe("paused");

		// Renewed, the next post fails in the claim itself, because its account was disconnected.
		await standingGrants.renew(scope(f), { grantId: id, ...renewTerms });
		const failing = await propose(f);
		expect(await accept(f, failing)).toBe("accepted");
		await prisma.socialAccount.update({ where: { id: f.account.id }, data: { status: "revoked" } });
		await claimDueSocialPublicationAttempts({ claimantId: "grant-worker-2", now: later(), config: claimConfig });
		await claimDueSocialPublicationAttempts({ claimantId: "grant-worker-3", now: later(), config: claimConfig });
		expect(await post(failing)).toMatchObject({ status: "failed" });
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "post_failed", revision: 2 });
		expect(await grantEvents(f.workspace.id, "grant.paused")).toHaveLength(2);
	});

	test("a paused grant holds its scheduled posts, and renewing lets them go", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f);
		const proposalId = await propose(f);
		expect(await accept(f, proposalId)).toBe("accepted");
		const attempts = () => prisma.socialPublicationAttempt.count({ where: { socialPostId: proposalId } });

		await standingGrants.pause(scope(f), id);
		await claimDueSocialPublicationAttempts({ claimantId: "held", now: later(), config: claimConfig });
		expect(await attempts()).toBe(0);
		// Held, not failed: it is still the scheduled post it was.
		expect(await post(proposalId)).toMatchObject({ status: "scheduled", standingGrantId: id });

		await standingGrants.renew(scope(f), { grantId: id, ...renewTerms });
		await claimDueSocialPublicationAttempts({ claimantId: "released", now: later(), config: claimConfig });
		expect(await attempts()).toBe(1);
	});

	test("a revoked or expired grant gives its unstarted posts back to the proposal inbox, and a person can accept them again", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f, { dailyCap: 5 });
		const [waiting, started] = [await propose(f), await propose(f)];
		expect(await accept(f, waiting)).toBe("accepted");
		expect(await accept(f, started)).toBe("accepted");
		// The publisher is already working on one of them.
		const claims = await claimDueSocialPublicationAttempts({ claimantId: "grant-started", now: later(), config: claimConfig });
		expect(claims.length).toBeGreaterThan(0);
		await prisma.socialPublicationAttempt.deleteMany({ where: { socialPostId: waiting } });
		await prisma.socialPost.update({ where: { id: waiting }, data: { status: "scheduled" } });

		await standingGrants.revoke(scope(f), id);
		expect(await post(waiting)).toMatchObject({ status: "draft", scheduledFor: null, standingGrantId: null, standingGrantRevision: null, frozenState: null, proposal: { acceptedAt: null, acceptedByUserId: null } });
		// An attempt that has begun can't be taken back; it finishes.
		expect(await post(started)).toMatchObject({ standingGrantId: id });
		expect(await prisma.standingGrantEvent.findMany({ where: { grantId: id, kind: "returned" } })).toMatchObject([{ reason: expect.stringContaining("1 scheduled post returned") }]);
		await claimDueSocialPublicationAttempts({ claimantId: "after-revoke", now: later(), config: claimConfig });
		expect(await prisma.socialPublicationAttempt.count({ where: { socialPostId: waiting } })).toBe(0);
		expect((await publishingQueue.listProposals(scope(f))).map((proposal) => proposal.proposalId)).toContain(waiting);
		const again = await publishingQueue.accept(scope(f), waiting);
		expect(again).toMatchObject({ status: "scheduled", replayed: false });
		expect(await post(waiting)).toMatchObject({ standingGrantId: null });

		// Expiry does the same: the post waits first, then the sweep returns it.
		const g = await fixture();
		const expiring = await publishGrant(g);
		const inFlight = await propose(g);
		expect(await accept(g, inFlight)).toBe("accepted");
		await prisma.standingGrant.update({ where: { id: expiring.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
		await claimDueSocialPublicationAttempts({ claimantId: "expired-held", now: later(), config: claimConfig });
		expect(await prisma.socialPublicationAttempt.count({ where: { socialPostId: inFlight } })).toBe(0);
		expect(await post(inFlight)).toMatchObject({ status: "scheduled" });
		await createStandingGrants({ prisma, requireActor: (userId, workspaceId, capability) => workspaceService.requireActor(userId, workspaceId, capability) }).expireDue();
		expect(await post(inFlight)).toMatchObject({ status: "draft", standingGrantId: null, scheduledFor: null });
	});

	test("a person can pause, renew and revoke, and each leaves its audit line", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f);
		await standingGrants.pause(scope(f), id);
		await expect(standingGrants.pause(scope(f), id)).rejects.toMatchObject({ code: "standing_grant_not_active" });
		await expect(standingGrants.pause(scope(f, "editor"), id)).rejects.toMatchObject({ code: "workspace_access_denied" });
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "manual", pauseNoticePending: false });
		expect((await grantEvents(f.workspace.id, "grant.paused")).map((event) => event.subject)).toMatchObject([{ grantId: id, reason: "manual" }]);

		await standingGrants.renew(scope(f), { grantId: id, dailyCap: 4, weeklyCap: 12, expiresInDays: 60 });
		expect(await grantRow(id)).toMatchObject({ status: "active", revision: 2, dailyCap: 4, weeklyCap: 12 });
		await standingGrants.revoke(scope(f), id);
		await standingGrants.revoke(scope(f), id);
		expect(await grantRow(id)).toMatchObject({ status: "revoked" });
		await expect(standingGrants.renew(scope(f), { grantId: id, dailyCap: 1, weeklyCap: 1, expiresInDays: 7 })).rejects.toMatchObject({ code: "standing_grant_closed" });
		expect((await prisma.standingGrantEvent.findMany({ where: { grantId: id }, orderBy: { createdAt: "asc" } })).map((event) => event.kind)).toEqual(["created", "paused", "renewed", "revoked"]);
		// A revoked destination can be granted again.
		await publishGrant(f);
	});

	test("renewing can't leave two live grants for one destination", async () => {
		const f = await fixture();
		const first = await publishGrant(f);
		await prisma.standingGrant.update({ where: { id: first.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
		const sweeper = createStandingGrants({ prisma, requireActor: (userId, workspaceId, capability) => workspaceService.requireActor(userId, workspaceId, capability) });
		await sweeper.expireDue();
		expect((await grantRow(first.id)).status).toBe("expired");

		// The lapsed destination is granted again; the old grant can't come back beside it.
		const second = await publishGrant(f);
		await expect(standingGrants.renew(scope(f), { grantId: first.id, ...renewTerms })).rejects.toMatchObject({ code: "standing_grant_duplicate" });
		expect((await grantRow(first.id)).status).toBe("expired");
		// Renewing the live one is fine, and a pause doesn't free the destination either.
		await standingGrants.pause(scope(f), second.id);
		await expect(standingGrants.renew(scope(f), { grantId: first.id, ...renewTerms })).rejects.toMatchObject({ code: "standing_grant_duplicate" });
		await standingGrants.renew(scope(f), { grantId: second.id, ...renewTerms });
		expect(await prisma.standingGrant.count({ where: { autopilotRuleId: f.rule.id, status: { in: ["active", "paused"] } } })).toBe(1);

		// Two renewals at once of grants for one destination can't both succeed either.
		const g = await fixture();
		const lapsed = await publishGrant(g);
		await prisma.standingGrant.update({ where: { id: lapsed.id }, data: { status: "revoked" } });
		const a = await publishGrant(g);
		await prisma.standingGrant.update({ where: { id: a.id }, data: { status: "expired", expiresAt: new Date(Date.now() - 1_000) } });
		const b = await publishGrant(g);
		await prisma.standingGrant.update({ where: { id: b.id }, data: { status: "expired", expiresAt: new Date(Date.now() - 1_000) } });
		const outcomes = await Promise.allSettled([a, b].map(({ id }) => standingGrants.renew(scope(g), { grantId: id, ...renewTerms })));
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(await prisma.standingGrant.count({ where: { autopilotRuleId: g.rule.id, status: "active" } })).toBe(1);
	});

	test("the maintenance sweep expires grants once, and renewing brings one back", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f);
		const { id: pausedId } = await reviewGrant(f);
		await standingGrants.pause(scope(f), pausedId);
		const past = { expiresAt: new Date(Date.now() - 60_000) };
		await prisma.standingGrant.updateMany({ where: { id: { in: [id, pausedId] } }, data: past });

		const sweeper = createStandingGrants({ prisma, requireActor: (userId, workspaceId, capability) => workspaceService.requireActor(userId, workspaceId, capability) });
		expect(await sweeper.expireDue()).toBeGreaterThanOrEqual(2);
		expect(await sweeper.expireDue()).toBe(0);
		expect((await grantRow(id)).status).toBe("expired");
		expect((await grantRow(pausedId)).status).toBe("expired");
		const events = await grantEvents(f.workspace.id, "grant.expired");
		expect(events.map((event) => event.subject).sort((a, b) => (a as { grantId: string }).grantId.localeCompare((b as { grantId: string }).grantId)))
			.toEqual([{ grantId: id, kind: "publish", autopilotRuleId: f.rule.id }, { grantId: pausedId, kind: "review_send", autopilotRuleId: f.rule.id }]
				.sort((a, b) => a.grantId.localeCompare(b.grantId)));

		await standingGrants.renew(scope(f), { grantId: id, ...renewTerms });
		expect(await grantRow(id)).toMatchObject({ status: "active", revision: 2 });
		expect(await accept(f, await propose(f))).toBe("accepted");
	});

	test("a granter who is no longer an Owner or Admin pauses the grant instead of acting", async () => {
		const f = await fixture();
		const { id } = await publishGrant(f);
		await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.owner.id } }, data: { role: "editor" } });
		const proposalId = await propose(f);
		expect(await accept(f, proposalId)).toBe("granter_unavailable");
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "granter_unavailable", pauseNoticePending: true });
		expect(await post(proposalId)).toMatchObject({ status: "draft" });
	});

	test("demoting or removing a granter pauses what they granted in the same transaction", async () => {
		const f = await fixture();
		const byAdmin = await standingGrants.create(scope(f, "admin"), publishTerms(f));
		const byAdminReview = await standingGrants.create(scope(f, "admin"), { kind: "review_send", autopilotRuleId: f.rule.id, reviewerEmails: ["a@example.test"], ...renewTerms });
		const byOwner = await standingGrants.create(scope(f), { kind: "review_send", autopilotRuleId: f.rule.id, reviewerEmails: ["b@example.test"], ...renewTerms }).catch(() => null);
		const member = await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: f.workspace.id, userId: f.admin.id } });

		// Promoting or keeping an Admin changes nothing.
		await workspaceMembershipService.changeRole(f.owner.id, f.workspace.id, member.id, "admin");
		expect((await grantRow(byAdmin.id)).status).toBe("active");

		await workspaceMembershipService.changeRole(f.owner.id, f.workspace.id, member.id, "editor");
		for (const grant of [byAdmin, byAdminReview]) {
			expect(await grantRow(grant.id)).toMatchObject({ status: "paused", pausedReason: "granter_unavailable", pauseNoticePending: true });
		}
		const paused = await grantEvents(f.workspace.id, "grant.paused");
		expect(paused.map((event) => (event.subject as { grantId: string }).grantId).sort()).toEqual([byAdmin.id, byAdminReview.id].sort());
		// The Owner's own grant, if the destination let them make one, is untouched.
		if (byOwner) expect((await grantRow(byOwner.id)).status).toBe("active");

		// Removal does the same for someone else who granted.
		const g = await fixture();
		const removed = await standingGrants.create(scope(g, "admin"), publishTerms(g));
		await prisma.workspaceBillingAccount.create({ data: { workspaceId: g.workspace.id } });
		const adminMember = await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: g.workspace.id, userId: g.admin.id } });
		await workspaceMembershipService.removeMember(g.owner.id, g.workspace.id, adminMember.id);
		expect(await grantRow(removed.id)).toMatchObject({ status: "paused", pausedReason: "granter_unavailable" });
		expect(await grantEvents(g.workspace.id, "grant.paused")).toHaveLength(1);
	});

	test("deleting a rule or disconnecting an account revokes its grants and keeps them as the audit trail", async () => {
		const f = await fixture();
		const published = await publishGrant(f);
		const review = await reviewGrant(f);
		const proposalId = await propose(f);
		expect(await accept(f, proposalId)).toBe("accepted");

		await autopilotService.deleteRule(scope(f, "editor"), f.rule.id);
		expect(await prisma.autopilotRule.count({ where: { id: f.rule.id } })).toBe(0);
		for (const grant of [published, review]) {
			expect(await grantRow(grant.id)).toMatchObject({ status: "revoked", autopilotRuleId: null, workspaceId: f.workspace.id });
			expect((await prisma.standingGrantEvent.findMany({ where: { grantId: grant.id }, orderBy: { createdAt: "asc" } })).map((event) => [event.kind, event.reason]))
				.toEqual(expect.arrayContaining([["created", null], ["revoked", "rule_deleted"]]));
		}
		// What the grant had scheduled went back to the inbox, and the list still names the grant.
		expect(await post(proposalId)).toMatchObject({ status: "draft", standingGrantId: null });
		expect((await standingGrants.list(scope(f))).find((grant) => grant.id === published.id)).toMatchObject({ status: "revoked", ruleName: "Deleted rule", autopilotRuleId: null });

		const g = await fixture();
		const forAccount = await publishGrant(g);
		await socialOAuthService.disconnectAccount(scope(g), g.account.id);
		expect(await grantRow(forAccount.id)).toMatchObject({ status: "revoked", socialAccountId: g.account.id });
		expect((await prisma.standingGrantEvent.findMany({ where: { grantId: forAccount.id, kind: "revoked" } }))).toMatchObject([{ reason: "account_disconnected" }]);
		// Even a hard delete of the account can't take the grant and its trail with it.
		await prisma.socialAccount.delete({ where: { id: g.account.id } });
		expect(await grantRow(forAccount.id)).toMatchObject({ status: "revoked", socialAccountId: null });
		expect(await prisma.standingGrantEvent.count({ where: { grantId: forAccount.id } })).toBe(2);
	});

	test("a review-send grant sends one round per finished generation, within its caps", async () => {
		const f = await fixture();
		const { id } = await reviewGrant(f, { dailyCap: 1, weeklyCap: 5 });
		const finishing = f.finishing;
		const input = (row: { id: string }, project = f.project, exportId = f.clipExport.id) => ({ finishingId: row.id, workspaceId: f.workspace.id, projectId: project.id, exportIds: [exportId] });

		expect(await sendReviewRoundUnderGrant(input(finishing))).toEqual({ sent: true });
		const rounds = await prisma.reviewRound.findMany({ where: { workspaceId: f.workspace.id }, include: { items: true, notificationLedgers: true } });
		expect(rounds).toHaveLength(1);
		expect(rounds[0]).toMatchObject({
			finishingId: finishing.id, standingGrantId: id, standingGrantRevision: 1, createdByUserId: f.owner.id, status: "open", approvalRequired: false,
			recipientEmails: ["client@example.test", "editor@example.test"],
		});
		expect(rounds[0]!.items).toMatchObject([{ clipId: f.clip.id, exportId: f.clipExport.id, selectedVariantIds: [f.variant.id], required: true }]);
		expect(rounds[0]!.notificationLedgers.map((ledger) => ledger.recipientEmail).sort()).toEqual(["client@example.test", "editor@example.test"]);

		// A re-claim of the same finishing finds its round and sends nothing more, even at once.
		const again = await Promise.all([sendReviewRoundUnderGrant(input(finishing)), sendReviewRoundUnderGrant(input(finishing))]);
		expect(again).toEqual([{ sent: true }, { sent: true }]);
		expect(await prisma.reviewRound.count({ where: { workspaceId: f.workspace.id } })).toBe(1);

		// The daily cap counts rounds: another generation's round waits for a person.
		const second = await generation({ workspaceId: f.workspace.id, ownerId: f.owner.id, ruleId: f.rule.id });
		const secondFinishing = await finishingFor(f, second);
		expect(await sendReviewRoundUnderGrant(input(secondFinishing, second.project, second.clipExport.id))).toEqual({ sent: false, reason: "review_not_sent_cap" });
		expect(await prisma.reviewRound.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
		expect((await standingGrants.list(scope(f))).find((grant) => grant.id === id)).toMatchObject({ usedDay: 1, usedWeek: 1, sent: [{ kind: "round", projectId: f.project.id }] });
	});

	test("rounds from different finishings at the cap never send more than the cap", async () => {
		const f = await fixture();
		const { id } = await reviewGrant(f, { dailyCap: 1, weeklyCap: 5 });
		const generations = await Promise.all(Array.from({ length: 4 }, () => generation({ workspaceId: f.workspace.id, ownerId: f.owner.id, ruleId: f.rule.id })));
		const finishings = await Promise.all(generations.map((generated) => finishingFor(f, generated)));
		const outcomes = await Promise.all(finishings.map((row, index) =>
			sendReviewRoundUnderGrant({ finishingId: row.id, workspaceId: f.workspace.id, projectId: generations[index]!.project.id, exportIds: [generations[index]!.clipExport.id] })));
		expect(outcomes.filter((outcome) => outcome.sent)).toHaveLength(1);
		expect(outcomes.filter((outcome) => !outcome.sent)).toEqual([
			{ sent: false, reason: "review_not_sent_cap" },
			{ sent: false, reason: "review_not_sent_cap" },
			{ sent: false, reason: "review_not_sent_cap" },
		]);
		expect(await prisma.reviewRound.count({ where: { standingGrantId: id } })).toBe(1);
	});

	test("a review round follows the Brand Profile's approval rule, and is skipped below Business, without a grant, or when the granter is gone", async () => {
		const f = await fixture();
		await prisma.project.update({ where: { id: f.project.id }, data: { brandProfileSnapshot: APPROVAL_REQUIRED_SNAPSHOT } });
		const base = { workspaceId: f.workspace.id, projectId: f.project.id, exportIds: [f.clipExport.id] };

		expect(await sendReviewRoundUnderGrant({ ...base, finishingId: (await finishingFor(f)).id })).toEqual({ sent: false, reason: "review_not_sent_no_grant" });
		const { id } = await reviewGrant(f);
		const approvalFinishing = await finishingFor(f);
		expect(await sendReviewRoundUnderGrant({ ...base, finishingId: approvalFinishing.id })).toEqual({ sent: true });
		expect(await prisma.reviewRound.findUniqueOrThrow({ where: { finishingId: approvalFinishing.id } })).toMatchObject({ approvalRequired: true });

		// A downgrade since the grant was made skips the step with a reason and pauses the grant.
		await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "pro" } });
		const downgraded = await finishingFor(f);
		expect(await sendReviewRoundUnderGrant({ ...base, finishingId: downgraded.id })).toEqual({ sent: false, reason: "review_not_sent_plan" });
		expect(await prisma.reviewRound.count({ where: { finishingId: downgraded.id } })).toBe(0);
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "plan_lost", pauseNoticePending: true });

		// Upgrading again doesn't resume automatic client sends; the Owner renews it.
		await prisma.workspace.update({ where: { id: f.workspace.id }, data: { pricingTier: "business" } });
		expect(await sendReviewRoundUnderGrant({ ...base, finishingId: (await finishingFor(f)).id })).toEqual({ sent: false, reason: "review_not_sent_no_grant" });
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "plan_lost" });
		await standingGrants.renew(scope(f), { grantId: id, ...renewTerms });
		expect(await grantRow(id)).toMatchObject({ status: "active", pausedReason: null });

		await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: f.owner.id } }, data: { role: "editor" } });
		expect(await sendReviewRoundUnderGrant({ ...base, finishingId: (await finishingFor(f)).id })).toEqual({ sent: false, reason: "review_not_sent_granter" });
		expect(await grantRow(id)).toMatchObject({ status: "paused", pausedReason: "granter_unavailable" });
	});

	test("a reviewer's opt-out link is signed, one-click, and honored by every grant of the Workspace", async () => {
		const f = await fixture();
		const { id } = await reviewGrant(f, { reviewers: ["client@example.test", "boss@example.test"] });
		const secret = reviewDeliverySecret();
		const token = signReviewOptOutToken({ workspaceId: f.workspace.id, email: "Client@Example.test" }, secret);

		// Only a token this server signed opts anyone out.
		expect(await reviewerOptOut.preview(`${token}x`)).toBeNull();
		expect(await reviewerOptOut.confirm("not-a-token")).toBeNull();
		expect(await reviewerOptOut.confirm(signReviewOptOutToken({ workspaceId: f.workspace.id, email: "client@example.test" }, "another-secret-0123456789abcdef0123456789"))).toBeNull();
		expect(await prisma.reviewerOptOut.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
		expect(await reviewerOptOut.preview(token)).toEqual({ workspaceName: "Grant DB test", email: "client@example.test" });
		expect(await reviewerOptOut.confirm(token)).toEqual({ workspaceName: "Grant DB test" });
		expect(await reviewerOptOut.confirm(token)).toEqual({ workspaceName: "Grant DB test" });
		expect(await prisma.reviewerOptOut.findMany({ where: { workspaceId: f.workspace.id } })).toMatchObject([{ email: "client@example.test" }]);

		// The next round skips them, the grant says so to managers, and the other reviewer still gets it.
		expect(await sendReviewRoundUnderGrant({ finishingId: f.finishing.id, workspaceId: f.workspace.id, projectId: f.project.id, exportIds: [f.clipExport.id] })).toEqual({ sent: true });
		const round = await prisma.reviewRound.findUniqueOrThrow({ where: { finishingId: f.finishing.id }, include: { notificationLedgers: true } });
		expect(round.recipientEmails).toEqual(["boss@example.test"]);
		expect(round.notificationLedgers.map((ledger) => ledger.recipientEmail)).toEqual(["boss@example.test"]);
		expect((await standingGrants.list(scope(f))).find((grant) => grant.id === id)?.optedOut).toEqual(["client@example.test"]);
		expect((await standingGrants.list(scope(f, "editor"))).find((grant) => grant.id === id)?.optedOut).toEqual([]);

		// With everyone opted out there is nobody to ask.
		await reviewerOptOut.confirm(signReviewOptOutToken({ workspaceId: f.workspace.id, email: "boss@example.test" }, secret));
		const next = await generation({ workspaceId: f.workspace.id, ownerId: f.owner.id, ruleId: f.rule.id });
		expect(await sendReviewRoundUnderGrant({ finishingId: (await finishingFor(f, next)).id, workspaceId: f.workspace.id, projectId: next.project.id, exportIds: [next.clipExport.id] }))
			.toEqual({ sent: false, reason: "review_not_sent_opted_out" });
		// Another Workspace's reviewers are its own business.
		const other = await fixture();
		await reviewGrant(other, { reviewers: ["client@example.test"] });
		expect(await sendReviewRoundUnderGrant({ finishingId: other.finishing.id, workspaceId: other.workspace.id, projectId: other.project.id, exportIds: [other.clipExport.id] })).toEqual({ sent: true });
	});

	test("review emails sent by a grant carry the opt-out link, and a round a person sends does not", async () => {
		const f = await fixture();
		await reviewGrant(f, { reviewers: ["client@example.test"] });
		expect(await sendReviewRoundUnderGrant({ finishingId: f.finishing.id, workspaceId: f.workspace.id, projectId: f.project.id, exportIds: [f.clipExport.id] })).toEqual({ sent: true });
		const byPerson = await prisma.reviewRound.create({
			data: {
				workspaceId: f.workspace.id, projectId: f.project.id, createdByUserId: f.owner.id, revision: 99, status: "open", title: "By hand",
				accessTokenHash: randomUUID(), deliveryTokenEncrypted: (await prisma.reviewRound.findUniqueOrThrow({ where: { finishingId: f.finishing.id } })).deliveryTokenEncrypted,
				recipientEmails: ["client@example.test"],
				notificationLedgers: { create: { recipientEmail: "client@example.test", kind: "round_sent", scopeKey: "round" } },
			},
		});

		const mails: ReviewNotificationMailInput[] = [];
		const service = new ReviewNotificationService({
			store: createReviewNotificationStore(),
			mailer: async (mail) => {
				mails.push(mail);
				return { sent: true, id: `mail-${mails.length}` };
			},
		});
		// Only this Workspace's rows: other tests leave rows of their own.
		const ledger = await prisma.reviewNotificationLedger.findMany({ where: { reviewRound: { workspaceId: f.workspace.id } }, select: { id: true, reviewRoundId: true } });
		await prisma.reviewNotificationLedger.updateMany({ where: { id: { notIn: ledger.map((row) => row.id) }, status: "pending" }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
		await service.deliverDue(500, "https://app.narriflow.test");
		const sentByGrant = mails.find((mail) => mail.roundTitle.endsWith("clips for review"));
		const sentByHand = mails.find((mail) => mail.roundTitle === "By hand");
		expect(sentByGrant?.optOut?.workspaceName).toBe("Grant DB test");
		const url = new URL(sentByGrant!.optOut!.url);
		expect(`${url.origin}${url.pathname}`).toBe("https://app.narriflow.test/review/opt-out");
		expect(await reviewerOptOut.preview(url.searchParams.get("token")!)).toEqual({ workspaceName: "Grant DB test", email: "client@example.test" });
		expect(sentByHand).toBeDefined();
		expect(sentByHand?.optOut).toBeUndefined();
		expect(byPerson.standingGrantId).toBeNull();
	});
});
