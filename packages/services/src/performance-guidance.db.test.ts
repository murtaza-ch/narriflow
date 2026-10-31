import {computeKnownGuidance} from "./publication-observation-test-support";
import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { randomUUID } from "node:crypto";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import type { ClipCategory, ClipFacts, SocialPlatform } from "@narriflow/validators";
import {
	computePerformanceGuidance,
	createPerformanceGuidance,
	GUIDANCE_REFRESH_MS,
	GUIDANCE_WINDOW_DAYS,
	guidancePromptLine,
	MINIMUM_GUIDANCE_WORKSPACE_POSTS,
	readAppliedGuidance,
	type GuidanceVideo,
} from "./performance-guidance";
import { COMPARISON_SLOT } from "./performance-capture-contract";
import { performanceService } from "./performance.service";

const databaseUrl = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_URL;
const databaseSchema = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_SCHEMA;
const dbDescribe =
	process.env.ALLOW_SOCIAL_PUBLICATION_DB_TESTS === "1" && databaseUrl
		? describe
		: describe.skip;

setDefaultTimeout(180_000);

const DAY = 86_400_000;

dbDescribe("Performance Guidance PostgreSQL invariants", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let previousGlobalPrisma: PrismaClient | undefined;
	const prismaGlobal = createDatabaseTestContext();
  const ownedWorkspaces:string[]=[];

	beforeAll(bindServiceTestEnvironment(prismaGlobal.bind(() => {
		pool = new Pool({ connectionString: databaseUrl!, max: 8 });
		prisma = new PrismaClient({
			adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined),
			transactionOptions: { maxWait: 120_000, timeout: 120_000 },
		});
		previousGlobalPrisma = prismaGlobal.client;
		prismaGlobal.client = prisma;
	})));

	afterAll(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		prismaGlobal.client = previousGlobalPrisma;
		await prisma?.$disconnect();
		await pool?.end();
	})));

	// The schema is shared with the other publication suites.
	beforeEach(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		await prisma.trackedVideo.deleteMany({where:{workspaceId:{in:ownedWorkspaces}}});
		await prisma.performanceGuidance.deleteMany({where:{workspaceId:{in:ownedWorkspaces}}});
    ownedWorkspaces.length=0;
	})));

	async function workspace() {
		const user = await prisma.user.create({ data: { clerkId: `guidance-db-test:${randomUUID()}` } });
		const created = await prisma.workspace.create({
			data: { name: "Guidance", ownerUserId: user.id, members: { create: { userId: user.id, role: "owner" } } },
		});
		ownedWorkspaces.push(created.id);
    return { user, workspaceId: created.id, scope: { actorUserId: user.id, workspaceId: created.id } };
	}

	const facts = (category: ClipCategory, platform: SocialPlatform): ClipFacts => ({
		viralityScore: 80, category, hookStrengthScore: 85, durationSec: 30, aspectRatio: "9:16", platform, postedHour: 9,
	});

	/** A Tracked Video of `clipId` with a 7-day reading. */
	async function post(
		workspaceId: string,
		category: ClipCategory,
		views: number | null,
		options: { platform?: SocialPlatform; clipId?: string | null; ageDays?: number; state?: "captured" | "skipped" } = {},
	) {
		const platform = options.platform ?? "youtube_shorts";
		const state = options.state ?? "captured";
		await prisma.trackedVideo.create({
			data: {
				workspaceId,
				platform,
				platformPostId: randomUUID(),
				clipId: options.clipId === undefined ? randomUUID() : options.clipId,
				publishedAt: new Date(Date.now() - (options.ageDays ?? 10) * DAY),
				clipFacts: facts(category, platform),
				clipFactsAt: new Date(),
				captures: { create: { slot: COMPARISON_SLOT, dueAt: new Date(), state, capturedAt: state === "captured" ? new Date() : null, views } },
			},
		});
	}
	const MIX: Array<[ClipCategory, number]> = [["story", 1_000], ["insight", 200], ["humor", 100]];
	/** `count` clips on YouTube: story 1000 views, insight 200, humor 100, in turn. */
	async function posts(workspaceId: string, count: number, options: { ageDays?: number } = {}) {
		for (let index = 0; index < count; index += 1) {
			const [category, views] = MIX[index % MIX.length]!;
			await post(workspaceId, category, views, options);
		}
	}
	const expectedFor = (count: number) =>
		computePerformanceGuidance(
			Array.from({ length: count }, (_, index): GuidanceVideo => {
				const [category, views] = MIX[index % MIX.length]!;
				return { clip: `c${index}`, platform: "youtube_shorts", facts: facts(category, "youtube_shorts"), views, likes: null, comments: null };
			}),
		);

	test("computes guidance for Workspaces with enough posts, about once a day", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const enough = await workspace();
		const few = await workspace();
		await posts(enough.workspaceId, MINIMUM_GUIDANCE_WORKSPACE_POSTS + 3);
		await posts(few.workspaceId, MINIMUM_GUIDANCE_WORKSPACE_POSTS - 1);

    let clock=new Date('2026-10-24T03:00:00.000Z');
    await computeKnownGuidance(prisma,enough.workspaceId,clock);

		const stored = await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: enough.workspaceId } });
		expect(stored.computedAt).toEqual(clock);
		expect(stored.attemptedAt).toEqual(clock);
		expect(stored.totalPosts).toBe(33);
		expect(await prisma.performanceGuidance.findUnique({ where: { workspaceId: few.workspaceId } })).toBeNull();

		// The stored result is the pure computation over the same posts.
		const expected = expectedFor(33);
		expect({ totalPosts: stored.totalPosts, platforms: stored.platforms, groups: stored.groups }).toEqual(expected);
		expect(expected.groups.length).toBeGreaterThan(0);

    // Exact same-night redelivery uses its receipt and cannot recompute.
    const firstAt=clock;
    clock=new Date(clock.getTime()+60_000);await computeKnownGuidance(prisma,enough.workspaceId,clock);
    expect((await prisma.performanceGuidance.findUniqueOrThrow({where:{workspaceId:enough.workspaceId}})).computedAt).toEqual(firstAt);
    // The next accepted nightly command reaches the newly qualifying Workspace.
    await posts(few.workspaceId,1);clock=new Date(firstAt.getTime()+GUIDANCE_REFRESH_MS);
    await computeKnownGuidance(prisma,enough.workspaceId,clock);await computeKnownGuidance(prisma,few.workspaceId,clock);

		const later = await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: enough.workspaceId } });
		expect(later.computedAt).toEqual(clock);
		expect(await prisma.performanceGuidance.findUnique({ where: { workspaceId: few.workspaceId } })).not.toBeNull();
	})));

	test("only videos from the last 180 days count, however many older ones there are", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const owner = await workspace();
		// 60 old story clips that went viral, then 36 recent ones with the usual mix.
		for (let index = 0; index < 60; index += 1) await post(owner.workspaceId, "story", 1_000_000, { ageDays: GUIDANCE_WINDOW_DAYS + 20 });
		await posts(owner.workspaceId, 36);
		await computeKnownGuidance(prisma,owner.workspaceId);
		const stored = await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: owner.workspaceId } });
		expect({ totalPosts: stored.totalPosts, platforms: stored.platforms, groups: stored.groups }).toEqual(expectedFor(36));

		// Too few recent videos: the old ones are enough tracked videos to look, but not to learn from.
		const stale = await workspace();
		for (let index = 0; index < 40; index += 1) await post(stale.workspaceId, "story", 1_000, { ageDays: GUIDANCE_WINDOW_DAYS + 1 });
		await posts(stale.workspaceId, 5);
		await computeKnownGuidance(prisma,stale.workspaceId);
		expect(await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: stale.workspaceId } })).toMatchObject({ totalPosts: 0, groups: [] });
	})));

	test("a clip posted to two platforms is one clip, from the clip frozen on its video", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const owner = await workspace();
		// 29 clips, each on YouTube Shorts and TikTok: 58 videos, but not 30 clips.
		for (let index = 0; index < 29; index += 1) {
			const clipId = randomUUID();
			await post(owner.workspaceId, "story", 100, { clipId, platform: "youtube_shorts" });
			await post(owner.workspaceId, "story", 1_000, { clipId, platform: "tiktok" });
		}
		await computeKnownGuidance(prisma,owner.workspaceId);
		expect(await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: owner.workspaceId } })).toMatchObject({ totalPosts: 29, groups: [] });
		// One more clip makes thirty.
		await post(owner.workspaceId, "story", 100, { platform: "youtube_shorts" });
		await computeKnownGuidance(prisma,owner.workspaceId,new Date(Date.now()+GUIDANCE_REFRESH_MS));
		const stored = await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: owner.workspaceId } });
		expect(stored.totalPosts).toBe(30);
		expect((stored.platforms as Array<{ platform: string }>).map((entry) => entry.platform)).toEqual(["tiktok", "youtube_shorts"]);
	})));

	test("a post whose 7-day reading was skipped, or is still waiting, is not counted", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const owner = await workspace();
		await posts(owner.workspaceId, 30);
		await post(owner.workspaceId, "story", null, { state: "skipped" });
		await computeKnownGuidance(prisma,owner.workspaceId);
		expect((await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: owner.workspaceId } })).totalPosts).toBe(30);
	})));

  test('a failed known Workspace command rolls back without blocking another and replays the same target after recovery',bindServiceTestEnvironment(prismaGlobal.bind(async()=>{
    const bad=await workspace(),good=await workspace();await posts(bad.workspaceId,31);await posts(good.workspaceId,31);
    const earlier=new Date('2026-10-22T03:00:00.000Z'),clock=new Date('2026-10-24T03:00:00.000Z');
    await prisma.performanceGuidance.create({data:{workspaceId:bad.workspaceId,computedAt:earlier,attemptedAt:earlier,totalPosts:31,platforms:[],groups:[]}});
    const failing=prisma.$extends({query:{trackedVideo:{async findMany({args,query}){const rows=await query(args);if(args.where?.workspaceId===bad.workspaceId)throw Error('boom');return rows;}}}}) as unknown as PrismaClient;
    await expect(computeKnownGuidance(failing,bad.workspaceId,clock)).rejects.toThrow('boom');
    await computeKnownGuidance(prisma,good.workspaceId,clock);
    expect(await prisma.performanceGuidance.findUniqueOrThrow({where:{workspaceId:good.workspaceId}})).toMatchObject({computedAt:clock,totalPosts:31});
    expect(await prisma.performanceGuidance.findUniqueOrThrow({where:{workspaceId:bad.workspaceId}})).toMatchObject({computedAt:earlier,attemptedAt:earlier,totalPosts:31});
    await computeKnownGuidance(prisma,bad.workspaceId,clock);
    expect(await prisma.performanceGuidance.findUniqueOrThrow({where:{workspaceId:bad.workspaceId}})).toMatchObject({computedAt:clock,attemptedAt:clock,totalPosts:31});
  })));

  test('a failed first computation invents no result and its same known command remains retryable',bindServiceTestEnvironment(prismaGlobal.bind(async()=>{
    const bad=await workspace();await posts(bad.workspaceId,31);
    const failing=prisma.$extends({query:{trackedVideo:{async findMany({args,query}){await query(args);throw Error('boom');}}}}) as unknown as PrismaClient;
    const clock=new Date();await expect(computeKnownGuidance(failing,bad.workspaceId,clock)).rejects.toThrow('boom');
    expect(await prisma.performanceGuidance.findUnique({where:{workspaceId:bad.workspaceId}})).toBeNull();expect(await readAppliedGuidance(prisma,bad.workspaceId)).toBeNull();
    await computeKnownGuidance(prisma,bad.workspaceId,clock);expect((await prisma.performanceGuidance.findUniqueOrThrow({where:{workspaceId:bad.workspaceId}})).totalPosts).toBe(31);
  })));

	test("the Workspace setting decides whether qualifying guidance is used, and null means the default", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const owner = await workspace();
		await posts(owner.workspaceId, 36);
		const guidance = createPerformanceGuidance({ prisma });
		expect(await guidance.promptLine(owner.workspaceId)).toBeNull();
		await computeKnownGuidance(prisma,owner.workspaceId);

		// Default: on once the data qualifies.
		expect((await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } })).usePerformanceGuidance).toBeNull();
		const applied = await readAppliedGuidance(prisma, owner.workspaceId);
		expect(applied?.guidance.groups.length).toBeGreaterThan(0);
		expect(await guidance.promptLine(owner.workspaceId)).toBe(guidancePromptLine(applied!.guidance));
		expect(await performanceService.guidance(owner.scope)).toMatchObject({ enabled: true, qualifies: true, applied: true, totalPosts: 36 });

		// Off.
		await performanceService.setGuidanceEnabled(owner.scope, false);
		expect(await readAppliedGuidance(prisma, owner.workspaceId)).toBeNull();
		expect(await guidance.promptLine(owner.workspaceId)).toBeNull();
		expect(await performanceService.guidance(owner.scope)).toMatchObject({ enabled: false, qualifies: true, applied: false });

		// On again, explicitly.
		await performanceService.setGuidanceEnabled(owner.scope, true);
		expect(await readAppliedGuidance(prisma, owner.workspaceId)).not.toBeNull();
	})));

	test("only people who manage the Workspace change the setting", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const owner = await workspace();
		const viewer = await prisma.user.create({ data: { clerkId: `guidance-viewer:${randomUUID()}` } });
		await prisma.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId: viewer.id, role: "viewer" } });
		await expect(performanceService.setGuidanceEnabled({ actorUserId: viewer.id, workspaceId: owner.workspaceId }, false)).rejects.toBeDefined();
		expect((await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } })).usePerformanceGuidance).toBeNull();
		// A viewer can still read what the guidance says.
		expect(await performanceService.guidance({ actorUserId: viewer.id, workspaceId: owner.workspaceId })).toMatchObject({ enabled: true, qualifies: false, applied: false, totalPosts: null });
	})));
});
