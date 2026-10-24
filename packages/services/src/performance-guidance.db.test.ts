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
import { COMPARISON_SLOT } from "./performance-sync";
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
	const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

	beforeAll(() => {
		pool = new Pool({ connectionString: databaseUrl!, max: 8 });
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

	// The schema is shared with the other publication suites.
	beforeEach(async () => {
		await prisma.trackedVideo.deleteMany();
		await prisma.performanceGuidance.deleteMany();
	});

	async function workspace() {
		const user = await prisma.user.create({ data: { clerkId: `guidance-db-test:${randomUUID()}` } });
		const created = await prisma.workspace.create({
			data: { name: "Guidance", ownerUserId: user.id, members: { create: { userId: user.id, role: "owner" } } },
		});
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

	test("computes guidance for Workspaces with enough posts, about once a day", async () => {
		const enough = await workspace();
		const few = await workspace();
		await posts(enough.workspaceId, MINIMUM_GUIDANCE_WORKSPACE_POSTS + 3);
		await posts(few.workspaceId, MINIMUM_GUIDANCE_WORKSPACE_POSTS - 1);

		let clock = new Date("2026-10-24T03:00:00.000Z");
		const guidance = createPerformanceGuidance({ prisma, now: () => clock });
		expect(await guidance.refreshStale()).toBe(1);

		const stored = await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: enough.workspaceId } });
		expect(stored.computedAt).toEqual(clock);
		expect(stored.attemptedAt).toEqual(clock);
		expect(stored.totalPosts).toBe(33);
		expect(await prisma.performanceGuidance.findUnique({ where: { workspaceId: few.workspaceId } })).toBeNull();

		// The stored result is the pure computation over the same posts.
		const expected = expectedFor(33);
		expect({ totalPosts: stored.totalPosts, platforms: stored.platforms, groups: stored.groups }).toEqual(expected);
		expect(expected.groups.length).toBeGreaterThan(0);

		// Not again until a day has passed.
		clock = new Date(clock.getTime() + GUIDANCE_REFRESH_MS - 60_000);
		expect(await guidance.refreshStale()).toBe(0);

		// New posts arrive, and the Workspace that was short gets there.
		await posts(few.workspaceId, 1);
		clock = new Date(clock.getTime() + 2 * 60_000);
		expect(await guidance.refreshStale()).toBe(2);
		const later = await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: enough.workspaceId } });
		expect(later.computedAt).toEqual(clock);
		expect(await prisma.performanceGuidance.findUnique({ where: { workspaceId: few.workspaceId } })).not.toBeNull();
	});

	test("only videos from the last 180 days count, however many older ones there are", async () => {
		const owner = await workspace();
		// 60 old story clips that went viral, then 36 recent ones with the usual mix.
		for (let index = 0; index < 60; index += 1) await post(owner.workspaceId, "story", 1_000_000, { ageDays: GUIDANCE_WINDOW_DAYS + 20 });
		await posts(owner.workspaceId, 36);
		await createPerformanceGuidance({ prisma }).refresh(owner.workspaceId);
		const stored = await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: owner.workspaceId } });
		expect({ totalPosts: stored.totalPosts, platforms: stored.platforms, groups: stored.groups }).toEqual(expectedFor(36));

		// Too few recent videos: the old ones are enough tracked videos to look, but not to learn from.
		const stale = await workspace();
		for (let index = 0; index < 40; index += 1) await post(stale.workspaceId, "story", 1_000, { ageDays: GUIDANCE_WINDOW_DAYS + 1 });
		await posts(stale.workspaceId, 5);
		await createPerformanceGuidance({ prisma }).refresh(stale.workspaceId);
		expect(await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: stale.workspaceId } })).toMatchObject({ totalPosts: 0, groups: [] });
	});

	test("a clip posted to two platforms is one clip, from the clip frozen on its video", async () => {
		const owner = await workspace();
		// 29 clips, each on YouTube Shorts and TikTok: 58 videos, but not 30 clips.
		for (let index = 0; index < 29; index += 1) {
			const clipId = randomUUID();
			await post(owner.workspaceId, "story", 100, { clipId, platform: "youtube_shorts" });
			await post(owner.workspaceId, "story", 1_000, { clipId, platform: "tiktok" });
		}
		await createPerformanceGuidance({ prisma }).refresh(owner.workspaceId);
		expect(await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: owner.workspaceId } })).toMatchObject({ totalPosts: 29, groups: [] });
		// One more clip makes thirty.
		await post(owner.workspaceId, "story", 100, { platform: "youtube_shorts" });
		await createPerformanceGuidance({ prisma }).refresh(owner.workspaceId);
		const stored = await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: owner.workspaceId } });
		expect(stored.totalPosts).toBe(30);
		expect((stored.platforms as Array<{ platform: string }>).map((entry) => entry.platform)).toEqual(["tiktok", "youtube_shorts"]);
	});

	test("a post whose 7-day reading was skipped, or is still waiting, is not counted", async () => {
		const owner = await workspace();
		await posts(owner.workspaceId, 30);
		await post(owner.workspaceId, "story", null, { state: "skipped" });
		await createPerformanceGuidance({ prisma }).refresh(owner.workspaceId);
		expect((await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: owner.workspaceId } })).totalPosts).toBe(30);
	});

	test("a Workspace that fails is stamped as tried and cannot hold up the others", async () => {
		const bad = await workspace();
		const good = await workspace();
		await posts(bad.workspaceId, 31);
		await posts(good.workspaceId, 31);
		// The bad Workspace already has a result from yesterday; the good one has none.
		const earlier = new Date("2026-10-22T03:00:00.000Z");
		await prisma.performanceGuidance.create({ data: { workspaceId: bad.workspaceId, computedAt: earlier, attemptedAt: earlier, totalPosts: 31, platforms: [], groups: [] } });
		const failing = new Proxy(prisma, {
			get(target, property) {
				if (property === "trackedVideo") {
					return { findMany: (args: { where: { workspaceId: string } }) => (args.where.workspaceId === bad.workspaceId ? Promise.reject(new Error("boom")) : target.trackedVideo.findMany(args as never)) };
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const clock = new Date("2026-10-24T03:00:00.000Z");
		const guidance = createPerformanceGuidance({ prisma: failing, now: () => clock });
		const warn = console.warn;
		console.warn = () => {};
		try {
			// One at a time: whichever goes first, the next tick reaches the other.
			expect(await guidance.refreshStale(1)).toBe(1);
			expect(await guidance.refreshStale(1)).toBe(0);
			expect(await guidance.refreshStale(1)).toBe(0);
		} finally {
			console.warn = warn;
		}
		const goodRow = await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: good.workspaceId } });
		expect(goodRow.computedAt).toEqual(clock);
		expect(goodRow.totalPosts).toBe(31);
		// The failure kept what was computed before, and only moved the time of the try.
		const badRow = await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: bad.workspaceId } });
		expect(badRow.computedAt).toEqual(earlier);
		expect(badRow.attemptedAt).toEqual(clock);
		// It is tried again a day later, not on every tick.
		const later = createPerformanceGuidance({ prisma, now: () => new Date(clock.getTime() + GUIDANCE_REFRESH_MS + 1_000) });
		expect(await later.refreshStale()).toBe(2);
	});

	test("a Workspace that has never been computed and fails gets an empty, honest row", async () => {
		const bad = await workspace();
		await posts(bad.workspaceId, 31);
		const failing = new Proxy(prisma, {
			get(target, property) {
				if (property === "trackedVideo") return { findMany: () => Promise.reject(new Error("boom")) };
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const warn = console.warn;
		console.warn = () => {};
		try {
			expect(await createPerformanceGuidance({ prisma: failing }).refreshStale()).toBe(0);
		} finally {
			console.warn = warn;
		}
		expect(await prisma.performanceGuidance.findUniqueOrThrow({ where: { workspaceId: bad.workspaceId } })).toMatchObject({ totalPosts: 0, platforms: [], groups: [] });
		expect(await readAppliedGuidance(prisma, bad.workspaceId)).toBeNull();
	});

	test("the Workspace setting decides whether qualifying guidance is used, and null means the default", async () => {
		const owner = await workspace();
		await posts(owner.workspaceId, 36);
		const guidance = createPerformanceGuidance({ prisma });
		expect(await guidance.promptLine(owner.workspaceId)).toBeNull();
		await guidance.refresh(owner.workspaceId);

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
	});

	test("only people who manage the Workspace change the setting", async () => {
		const owner = await workspace();
		const viewer = await prisma.user.create({ data: { clerkId: `guidance-viewer:${randomUUID()}` } });
		await prisma.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId: viewer.id, role: "viewer" } });
		await expect(performanceService.setGuidanceEnabled({ actorUserId: viewer.id, workspaceId: owner.workspaceId }, false)).rejects.toBeDefined();
		expect((await prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } })).usePerformanceGuidance).toBeNull();
		// A viewer can still read what the guidance says.
		expect(await performanceService.guidance({ actorUserId: viewer.id, workspaceId: owner.workspaceId })).toMatchObject({ enabled: true, qualifies: false, applied: false, totalPosts: null });
	});
});
