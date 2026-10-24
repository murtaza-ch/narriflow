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
import { clipFactsSchema } from "@narriflow/validators";
import { analyticsService } from "./analytics.service";
import {
	CAPTURE_OFFSETS_MINUTES,
	COMPARISON_SLOT,
	createPerformanceSync,
} from "./performance-sync";
import { msUntilQuotaReset } from "./performance-providers";
import { performanceService } from "./performance.service";
import { socialService } from "./social.service";

const databaseUrl = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_URL;
const databaseSchema = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_SCHEMA;
const dbDescribe =
	process.env.ALLOW_SOCIAL_PUBLICATION_DB_TESTS === "1" && databaseUrl
		? describe
		: describe.skip;

setDefaultTimeout(180_000);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Platform = "youtube_shorts" | "tiktok";

function json(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

/** A YouTube that knows these videos' view counts and records each call. */
function youtube(views: Record<string, number>) {
	const calls: string[][] = [];
	const fetcher = (async (url: string | URL | Request) => {
		const ids = new URL(String(url)).searchParams.get("id")!.split(",");
		calls.push(ids);
		return json({
			items: ids
				.filter((id) => id in views)
				.map((id) => ({ id, statistics: { viewCount: String(views[id]), likeCount: "3" } })),
		});
	}) as typeof fetch;
	return { fetcher, calls };
}

const accountsStub = (calls: string[] = []) => ({
	async getPublishAccount(accountId: string) {
		calls.push(accountId);
		return { accessToken: `token:${accountId}` };
	},
});

dbDescribe("Performance sync PostgreSQL invariants", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let previousGlobalPrisma: PrismaClient | undefined;
	const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl!, max: 12 });
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

	// The schema is disposable and shared with the other publication suites;
	// start each test with no tracked or published videos so a test's calls
	// only ever see its own videos.
	beforeEach(async () => {
		await prisma.trackedVideo.deleteMany();
		await prisma.publishedSocialVideo.deleteMany();
	});

	function sync(
		fetcher: typeof fetch,
		options: { now?: () => Date; accounts?: { getPublishAccount(id: string): Promise<{ accessToken: string }> } } = {},
	) {
		return createPerformanceSync({
			prisma,
			fetch: fetcher,
			accounts: options.accounts ?? accountsStub(),
			now: options.now,
			log: () => {},
		});
	}

	async function fixture(platform: Platform = "youtube_shorts") {
		const suffix = randomUUID();
		const user = await prisma.user.create({
			data: { clerkId: `performance-db-test:${suffix}` },
		});
		const workspace = await prisma.workspace.create({
			data: {
				name: "Performance DB test",
				ownerUserId: user.id,
				personalOwnerUserId: user.id,
				timezone: "America/New_York",
				members: { create: { userId: user.id, role: "owner" } },
			},
		});
		const project = await prisma.project.create({
			data: {
				title: "Performance fixture",
				sourceMediaUrl: "r2://test/source.mp4",
				workspaceId: workspace.id,
				createdByUserId: user.id,
			},
		});
		const workflowRun = await prisma.workflowRun.create({
			data: {
				projectId: project.id,
				idempotencyKey: `performance:${suffix}`,
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
				hookText: "Performance test clip",
				reasoning: "Fixture",
				category: "insight",
				transcriptSlice: [],
				viralityScore: 80,
				hookStrengthScore: 85,
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
				fingerprint: `performance:${suffix}`,
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
				durationSec: 28,
				completedAt: new Date(),
			},
		});
		const account = await newAccount({ user, workspace }, platform);
		return { user, workspace, project, clip, clipExport, variant, account, platform };
	}

	type Fixture = Awaited<ReturnType<typeof fixture>>;

	function newAccount(
		f: Pick<Fixture, "user" | "workspace">,
		platform: Platform,
	) {
		return prisma.socialAccount.create({
			data: {
				userId: f.user.id,
				workspaceId: f.workspace.id,
				createdByUserId: f.user.id,
				platform,
				providerAccountId: `${platform}:${randomUUID()}`,
				displayName: "Performance account",
				accessTokenEncrypted: "encrypted-test-token",
			},
		});
	}

	/** A Social Post the platform accepted, with its verified Published Social Video. */
	async function published(
		f: Fixture,
		input: {
			platformPostId: string;
			publishedAt: Date;
			account?: { id: string };
			platform?: Platform;
			verified?: boolean;
			/** The privacy the platform reported on the receipt. */
			visibility?: string;
		},
	) {
		const platform = input.platform ?? f.platform;
		const post = await prisma.socialPost.create({
			data: {
				projectId: f.project.id,
				workspaceId: f.workspace.id,
				createdByUserId: f.user.id,
				clipId: f.clip.id,
				socialAccountId: (input.account ?? f.account).id,
				platform,
				status: "posted",
				clientIdempotencyKey: randomUUID(),
				immutableRequestHash: randomUUID(),
				caption: "Posted",
				postedAt: input.publishedAt,
				frozenState: {
					create: {
						clipExportId: f.clipExport.id,
						clipExportVariantId: f.variant.id,
						socialAccountId: (input.account ?? f.account).id,
						platform,
						editorRevision: f.clip.editorRevision,
						exportFingerprint: f.clipExport.fingerprint,
						durationSec: 28,
						aspectRatio: "ratio_9_16",
						caption: "Posted",
						providerSettings: {},
						capabilityVersion: "test",
						scheduledFor: input.publishedAt,
					},
				},
			},
			include: { frozenState: true },
		});
		if (input.visibility) {
			await prisma.socialPublicationAttempt.create({
				data: {
					socialPostId: post.id,
					frozenStateId: post.frozenState!.id,
					attemptNumber: 1,
					idempotencyKey: randomUUID(),
					phase: "succeeded",
					nextActionAt: input.publishedAt,
					processingDeadline: input.publishedAt,
					reconciliationDeadline: input.publishedAt,
					receipt: {
						create: {
							platform,
							receiptId: `receipt:${input.platformPostId}`,
							platformPostId: input.platformPostId,
							providerVisibility: input.visibility,
						},
					},
				},
			});
		}
		if (input.verified !== false) {
			await prisma.publishedSocialVideo.create({
				data: {
					socialPostId: post.id,
					platformPostId: input.platformPostId,
					publishedAt: input.publishedAt,
				},
			});
		}
		return post;
	}

	const trackedFor = (platformPostId: string) =>
		prisma.trackedVideo.findFirstOrThrow({
			where: { platformPostId },
			include: { captures: { orderBy: { slot: "asc" } } },
		});

	test("tracking is idempotent: one Tracked Video and five slots per verified video, however many workers schedule it", async () => {
		const f = await fixture();
		const publishedAt = new Date(Date.now() - 2 * HOUR);
		await published(f, { platformPostId: "idempotent-1", publishedAt });
		// Not captured: an inbox delivery no creator has published yet, a platform
		// this ticket doesn't read, and a video older than the last slot.
		await published(f, { platformPostId: "inbox-1", publishedAt, verified: false });
		const instagram = await prisma.socialPost.create({
			data: {
				projectId: f.project.id,
				workspaceId: f.workspace.id,
				platform: "instagram_reels",
				status: "posted",
				clientIdempotencyKey: randomUUID(),
				immutableRequestHash: randomUUID(),
				caption: "Instagram",
			},
		});
		await prisma.publishedSocialVideo.create({
			data: { socialPostId: instagram.id, platformPostId: "instagram-1", publishedAt },
		});
		await published(f, {
			platformPostId: "ancient-1",
			publishedAt: new Date(Date.now() - 40 * DAY),
		});

		await Promise.all(
			Array.from({ length: 4 }, () => sync(youtube({}).fetcher).scheduleTrackedVideos()),
		);
		await sync(youtube({}).fetcher).scheduleTrackedVideos();

		expect(await prisma.trackedVideo.count()).toBe(1);
		const tracked = await trackedFor("idempotent-1");
		expect(tracked).toMatchObject({
			workspaceId: f.workspace.id,
			socialAccountId: f.account.id,
			platform: "youtube_shorts",
		});
		expect(tracked.captures.map((capture) => capture.slot)).toEqual([0, 1, 2, 3, 4]);
		expect(
			tracked.captures.map(
				(capture) => (capture.dueAt.getTime() - tracked.publishedAt.getTime()) / 60_000,
			),
		).toEqual([...CAPTURE_OFFSETS_MINUTES]);
		expect(new Set(tracked.captures.map((capture) => capture.state))).toEqual(
			new Set(["scheduled"]),
		);
	});

	test("only public videos are tracked", async () => {
		const f = await fixture();
		const publishedAt = new Date(Date.now() - 2 * HOUR);
		await published(f, { platformPostId: "public-1", publishedAt, visibility: "public" });
		await published(f, { platformPostId: "private-1", publishedAt, visibility: "private" });
		await published(f, { platformPostId: "unlisted-1", publishedAt, visibility: "unlisted" });

		await sync(youtube({}).fetcher).scheduleTrackedVideos();

		expect(
			(await prisma.trackedVideo.findMany({ select: { platformPostId: true } })).map(
				(video) => video.platformPostId,
			),
		).toEqual(["public-1"]);
	});

	test("two workers racing for one due capture capture it once", async () => {
		const f = await fixture();
		await published(f, { platformPostId: "race-1", publishedAt: new Date(Date.now() - 2 * HOUR) });
		await sync(youtube({}).fetcher).scheduleTrackedVideos();

		const platform = youtube({ "race-1": 500 });
		const results = await Promise.all([
			sync(platform.fetcher).captureDue(),
			sync(platform.fetcher).captureDue(),
		]);

		expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
		expect(platform.calls).toEqual([["race-1"]]);
		const { captures } = await trackedFor("race-1");
		expect(captures.map((capture) => capture.state)).toEqual([
			"captured",
			"scheduled",
			"scheduled",
			"scheduled",
			"scheduled",
		]);
		expect(captures[0]).toMatchObject({
			views: 500,
			likes: 3,
			comments: null,
			shares: null,
			apiVersion: "v3",
			leaseOwner: null,
			leaseExpiresAt: null,
		});
		expect(captures[0]!.raw).toEqual({ viewCount: "500", likeCount: "3" });
	});

	test("a worker that lost its lease cannot overwrite the capture that replaced it", async () => {
		const f = await fixture();
		const startedAt = new Date();
		await published(f, { platformPostId: "fence-1", publishedAt: new Date(startedAt.getTime() - 2 * HOUR) });
		await sync(youtube({}).fetcher).scheduleTrackedVideos();

		let release!: () => void;
		let reading!: () => void;
		const readingStarted = new Promise<void>((resolve) => (reading = resolve));
		const slow = (async () => {
			reading();
			await new Promise<void>((resolve) => (release = resolve));
			return json({ items: [{ id: "fence-1", statistics: { viewCount: "111" } }] });
		}) as typeof fetch;
		const stale = sync(slow, { now: () => startedAt }).captureDue();
		await readingStarted;

		// The first lease has expired, so a second worker takes the capture over.
		const fresh = youtube({ "fence-1": 222 });
		const later = () => new Date(startedAt.getTime() + 10 * 60_000);
		expect(await sync(fresh.fetcher, { now: later }).captureDue()).toBe(1);

		release();
		expect(await stale).toBe(0);
		const { captures } = await trackedFor("fence-1");
		expect(captures[0]).toMatchObject({ state: "captured", views: 222 });
	});

	test("a post whose slots all fell due is read once, at the newest slot", async () => {
		const f = await fixture();
		const start = new Date();
		await published(f, { platformPostId: "backfill-1", publishedAt: new Date(start.getTime() - 4 * DAY) });
		await sync(youtube({}).fetcher).scheduleTrackedVideos();

		const platform = youtube({ "backfill-1": 640 });
		// 1 hour, 24 hours and 3 days are all due: one is captured, two are missed.
		expect(await sync(platform.fetcher, { now: () => start }).captureDue()).toBe(3);

		expect(platform.calls).toEqual([["backfill-1"]]);
		const { captures } = await trackedFor("backfill-1");
		expect(captures.map((capture) => [capture.state, capture.skipReason, capture.views])).toEqual([
			["skipped", "missed", null],
			["skipped", "missed", null],
			["captured", null, 640],
			["scheduled", null, null],
			["scheduled", null, null],
		]);
	});

	test("batches due captures per account", async () => {
		const f = await fixture();
		const second = await newAccount(f, "youtube_shorts");
		const publishedAt = new Date(Date.now() - 2 * HOUR);
		for (const id of ["a-1", "a-2", "a-3"]) await published(f, { platformPostId: id, publishedAt });
		await published(f, { platformPostId: "b-1", publishedAt, account: second });
		const worker = sync(youtube({}).fetcher);
		await worker.scheduleTrackedVideos();

		const platform = youtube({ "a-1": 1, "a-2": 2, "a-3": 3, "b-1": 4 });
		const lookups: string[] = [];
		expect(
			await sync(platform.fetcher, { accounts: accountsStub(lookups) }).captureDue(),
		).toBe(4);
		expect(platform.calls.map((ids) => ids.sort())).toEqual(
			expect.arrayContaining([["a-1", "a-2", "a-3"], ["b-1"]]),
		);
		expect(platform.calls).toHaveLength(2);
		expect(lookups.sort()).toEqual([f.account.id, second.id].sort());
	});

	test("TikTok batches at the documented 20 IDs per query", async () => {
		const f = await fixture("tiktok");
		const publishedAt = new Date(Date.now() - 2 * HOUR);
		for (let index = 0; index < 21; index += 1) {
			await published(f, { platformPostId: `70000000000000000${String(index).padStart(2, "0")}`, publishedAt });
		}
		await sync(youtube({}).fetcher).scheduleTrackedVideos();
		const sizes: number[] = [];
		const tiktok = (async (_url: string | URL | Request, init?: RequestInit) => {
			const ids = JSON.parse(String(init?.body)).filters.video_ids as string[];
			sizes.push(ids.length);
			return json({
				data: { videos: ids.map((id) => ({ id, view_count: 10, like_count: 1, comment_count: 0, share_count: 2 })) },
				error: { code: "ok", message: "", log_id: "l" },
			});
		}) as typeof fetch;

		expect(await sync(tiktok).captureDue()).toBe(21);
		expect(sizes.sort((a, b) => b - a)).toEqual([20, 1]);
		expect(
			await prisma.performanceCapture.count({ where: { state: "captured", shares: 2 } }),
		).toBe(21);
	});

	test("clip facts freeze when the video is first tracked and survive Project deletion with the history", async () => {
		const f = await fixture();
		const clockStart = new Date();
		const publishedAt = new Date(clockStart.getTime() - 2 * HOUR);
		const post = await published(f, { platformPostId: "history-1", publishedAt });
		await sync(youtube({}).fetcher).scheduleTrackedVideos();

		// Frozen before any reading exists.
		const tracked = await trackedFor("history-1");
		expect(clipFactsSchema.parse(tracked.clipFacts)).toEqual({
			viralityScore: 80,
			category: "insight",
			hookStrengthScore: 85,
			durationSec: 28,
			aspectRatio: "9:16",
			platform: "youtube_shorts",
			postedHour: Number(
				new Intl.DateTimeFormat("en-US", {
					timeZone: "America/New_York",
					hour: "numeric",
					hourCycle: "h23",
				}).format(publishedAt),
			),
		});
		expect(tracked.clipFactsAt).not.toBeNull();
		expect(tracked.captures.every((capture) => capture.state === "scheduled")).toBe(true);

		// The clip is rescored before the first reading, and the scheduler runs
		// again: the snapshot keeps the facts of publication.
		await prisma.clip.update({
			where: { id: f.clip.id },
			data: { viralityScore: 10, category: "humor", hookStrengthScore: 5 },
		});
		await sync(youtube({}).fetcher).scheduleTrackedVideos();
		expect((await trackedFor("history-1")).clipFacts).toEqual(tracked.clipFacts);

		await sync(youtube({ "history-1": 100 }).fetcher, { now: () => clockStart }).captureDue();
		expect(
			(await socialService.listProjectPosts(
				{ actorUserId: f.user.id, workspaceId: f.workspace.id },
				f.project.id,
			)).items.find((item) => item.id === post.id)?.latestMetrics,
		).toMatchObject({ views: 100, likes: 3, comments: null });
		expect(
			(await analyticsService.getProjectAnalytics(
				{ actorUserId: f.user.id, workspaceId: f.workspace.id },
				f.project.id,
			)).postPerformance,
		).toMatchObject({
			measuredVideos: 1,
			totals: { views: 100, likes: 3, comments: 0, shares: 0 },
			posts: [{ socialPostId: post.id, latestMetrics: { views: 100 } }],
		});

		const dayTwo = () => new Date(clockStart.getTime() + 26 * HOUR);
		await sync(youtube({ "history-1": 900 }).fetcher, { now: dayTwo }).captureDue();

		// Deleting the Project cascades the Social Post but not the history.
		await prisma.project.delete({ where: { id: f.project.id } });
		expect(await prisma.socialPost.count({ where: { id: post.id } })).toBe(0);
		const detached = await trackedFor("history-1");
		expect(detached.socialPostId).toBeNull();
		expect(detached.workspaceId).toBe(f.workspace.id);
		expect(detached.clipFacts).toEqual(tracked.clipFacts);
		expect(
			detached.captures.filter((capture) => capture.state === "captured").map((capture) => capture.views),
		).toEqual([100, 900]);

		// Later slots keep capturing without the Project; the 7-day reading feeds the view.
		const dayFour = () => new Date(clockStart.getTime() + 3 * DAY + 2 * HOUR);
		await sync(youtube({ "history-1": 1_500 }).fetcher, { now: dayFour }).captureDue();
		const dayEight = () => new Date(clockStart.getTime() + 8 * DAY);
		await sync(youtube({ "history-1": 2_000 }).fetcher, { now: dayEight }).captureDue();
		expect(
			(await trackedFor("history-1")).captures
				.filter((capture) => capture.state === "captured")
				.map((capture) => capture.views),
		).toEqual([100, 900, 1_500, 2_000]);
		const summary = await performanceService.whatWorked({
			actorUserId: f.user.id,
			workspaceId: f.workspace.id,
		});
		expect(summary).toMatchObject({ measuredVideos: 1, waitingVideos: 0, totals: { views: 2_000 } });
		// Grouped by the facts frozen at publication, not the rescored clip.
		expect(
			summary.dimensions.find((dimension) => dimension.id === "category")!.groups.map((group) => group.key),
		).toEqual(["insight"]);
	});

	test("What worked compares the 7-day capture and counts only videos still waiting for it", async () => {
		const f = await fixture();
		const start = new Date();
		const actor = { actorUserId: f.user.id, workspaceId: f.workspace.id };
		await published(f, { platformPostId: "young-1", publishedAt: new Date(start.getTime() - 2 * DAY) });
		await published(f, { platformPostId: "old-1", publishedAt: new Date(start.getTime() - 8 * DAY) });
		await published(f, { platformPostId: "lost-1", publishedAt: new Date(start.getTime() - 8 * DAY) });
		await sync(youtube({}).fetcher).scheduleTrackedVideos();

		// young-1 is two days old; old-1 reads at its newest due slot (the 7-day
		// one); lost-1 is gone from the platform, so its 7-day capture is skipped.
		await sync(youtube({ "young-1": 50, "old-1": 700 }).fetcher, { now: () => start }).captureDue();

		const summary = await performanceService.whatWorked(actor);
		expect(summary).toMatchObject({
			measuredVideos: 1,
			waitingVideos: 1,
			totals: { views: 700 },
		});
		const lost = await trackedFor("lost-1");
		expect(lost.captures[COMPARISON_SLOT]).toMatchObject({
			state: "skipped",
			skipReason: "video_unavailable",
		});

		// A skipped 7-day capture is not waiting: once young-1 reads at 7 days, nothing waits.
		const sevenDays = () => new Date(start.getTime() + 6 * DAY);
		await sync(youtube({ "young-1": 90, "old-1": 800 }).fetcher, { now: sevenDays }).captureDue();
		expect(await performanceService.whatWorked(actor)).toMatchObject({
			measuredVideos: 2,
			waitingVideos: 0,
			totals: { views: 790 },
		});
	});

	test("Project totals aggregate every post, not the first page", async () => {
		const f = await fixture();
		const publishedAt = new Date(Date.now() - 2 * HOUR);
		const posts = Array.from({ length: 105 }, (_, index) => ({
			id: randomUUID(),
			projectId: f.project.id,
			workspaceId: f.workspace.id,
			clipId: f.clip.id,
			socialAccountId: f.account.id,
			platform: "youtube_shorts" as const,
			status: "posted" as const,
			clientIdempotencyKey: randomUUID(),
			immutableRequestHash: `page-${index}`,
			caption: "Posted",
			postedAt: new Date(publishedAt.getTime() + index),
		}));
		await prisma.socialPost.createMany({ data: posts });
		const videos = posts.map((post) => ({
			id: randomUUID(),
			workspaceId: f.workspace.id,
			socialAccountId: f.account.id,
			socialPostId: post.id,
			platform: "youtube_shorts" as const,
			platformPostId: `page-${post.id}`,
			publishedAt,
		}));
		await prisma.trackedVideo.createMany({ data: videos });
		await prisma.performanceCapture.createMany({
			data: videos.flatMap((video) => [
				// An older reading must not be added to the newer one.
				{ trackedVideoId: video.id, slot: 0, dueAt: publishedAt, state: "captured" as const, capturedAt: new Date(publishedAt.getTime() + 1_000), views: 5, likes: 1 },
				{ trackedVideoId: video.id, slot: 1, dueAt: publishedAt, state: "captured" as const, capturedAt: new Date(publishedAt.getTime() + 2_000), views: 10, likes: 2, comments: 1 },
			]),
		});

		const { postPerformance } = await analyticsService.getProjectAnalytics(
			{ actorUserId: f.user.id, workspaceId: f.workspace.id },
			f.project.id,
		);
		expect(postPerformance.measuredVideos).toBe(105);
		expect(postPerformance.totals).toEqual({ views: 1_050, likes: 210, comments: 105, shares: 0 });
		expect(postPerformance.posts).toHaveLength(100);
	});

	test("a disconnected, expired or unauthorized grant skips the capture with a reason and never touches the Social Post", async () => {
		const f = await fixture();
		const publishedAt = new Date(Date.now() - 2 * HOUR);
		const gone = await newAccount(f, "youtube_shorts");
		const expired = await newAccount(f, "youtube_shorts");
		const rejected = await newAccount(f, "youtube_shorts");
		const unauthorized = await newAccount(f, "youtube_shorts");
		const reconnected = await newAccount(f, "youtube_shorts");
		const posts = {
			gone: await published(f, { platformPostId: "gone-1", publishedAt, account: gone }),
			expired: await published(f, { platformPostId: "expired-1", publishedAt, account: expired }),
			rejected: await published(f, { platformPostId: "rejected-1", publishedAt, account: rejected }),
			unauthorized: await published(f, { platformPostId: "unauthorized-1", publishedAt, account: unauthorized }),
			reconnected: await published(f, { platformPostId: "reconnected-1", publishedAt, account: reconnected }),
		};
		await sync(youtube({}).fetcher).scheduleTrackedVideos();
		const accounts = {
			async getPublishAccount(accountId: string) {
				if (accountId === gone.id) throw Object.assign(new Error("gone"), { code: "social_account_missing" });
				if (accountId === expired.id) throw Object.assign(new Error("expired"), { code: "social_account_expired" });
				// The provider rejected the refresh token: a reconnect, not a transient failure.
				if (accountId === rejected.id) {
					throw Object.assign(new Error("rejected"), { code: "social_oauth_http_failed", status: 400 });
				}
				return { accessToken: `token:${accountId}` };
			},
		};
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			const token = (init?.headers as Record<string, string>).Authorization;
			if (token.endsWith(unauthorized.id)) {
				return json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, { status: 403 });
			}
			const id = new URL(String(url)).searchParams.get("id")!;
			return json({ items: [{ id, statistics: { viewCount: "7" } }] });
		}) as typeof fetch;

		expect(await sync(fetcher, { accounts }).captureDue()).toBe(5);

		const slotZero = async (platformPostId: string) =>
			(await trackedFor(platformPostId)).captures[0]!;
		expect(await slotZero("gone-1")).toMatchObject({ state: "skipped", skipReason: "account_disconnected" });
		expect(await slotZero("expired-1")).toMatchObject({ state: "skipped", skipReason: "grant_expired" });
		expect(await slotZero("rejected-1")).toMatchObject({ state: "skipped", skipReason: "grant_expired" });
		expect(await slotZero("unauthorized-1")).toMatchObject({ state: "skipped", skipReason: "permission_missing" });
		expect(await slotZero("reconnected-1")).toMatchObject({ state: "captured", views: 7 });
		// The next slot is still scheduled: reconnecting the account resumes capture.
		expect((await trackedFor("gone-1")).captures[1]).toMatchObject({ state: "scheduled", skipReason: null });
		for (const post of Object.values(posts)) {
			expect(await prisma.socialPost.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({
				status: "posted",
				errorCode: null,
			});
		}
	});

	test("a video the platform no longer returns is skipped, not retried", async () => {
		const f = await fixture();
		await published(f, { platformPostId: "deleted-1", publishedAt: new Date(Date.now() - 2 * HOUR) });
		await sync(youtube({}).fetcher).scheduleTrackedVideos();
		expect(await sync(youtube({}).fetcher).captureDue()).toBe(1);
		expect((await trackedFor("deleted-1")).captures[0]).toMatchObject({
			state: "skipped",
			skipReason: "video_unavailable",
		});
	});

	test("an exception inside one batch spends an attempt on that batch and leaves the others to finish", async () => {
		const f = await fixture();
		const broken = await newAccount(f, "youtube_shorts");
		const start = new Date();
		await published(f, { platformPostId: "broken-1", publishedAt: new Date(start.getTime() - 3 * HOUR), account: broken });
		await published(f, { platformPostId: "fine-1", publishedAt: new Date(start.getTime() - 2 * HOUR) });
		await sync(youtube({}).fetcher).scheduleTrackedVideos();

		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			if ((init?.headers as Record<string, string>).Authorization.endsWith(broken.id)) {
				// A response that blows up when the reader inspects it.
				return {
					get ok(): boolean {
						throw new Error("socket closed mid-response");
					},
				} as unknown as Response;
			}
			const id = new URL(String(url)).searchParams.get("id")!;
			return json({ items: [{ id, statistics: { viewCount: "9" } }] });
		}) as typeof fetch;

		// The broken account's batch is first in line, yet the other one still captures.
		expect(await sync(fetcher, { now: () => start }).captureDue()).toBe(1);
		expect((await trackedFor("fine-1")).captures[0]).toMatchObject({ state: "captured", views: 9 });
		expect((await trackedFor("broken-1")).captures[0]).toMatchObject({
			state: "scheduled",
			attempts: 1,
			leaseOwner: null,
		});
		expect((await trackedFor("broken-1")).captures[0]!.dueAt.getTime()).toBeGreaterThan(start.getTime());
	});

	test("a rate limit backs off the batch, spares the platform for the run, and gives up after the budget", async () => {
		const f = await fixture();
		const second = await newAccount(f, "youtube_shorts");
		const start = new Date();
		const publishedAt = new Date(start.getTime() - 2 * HOUR);
		await published(f, { platformPostId: "limited-1", publishedAt });
		await published(f, { platformPostId: "limited-2", publishedAt, account: second });
		await sync(youtube({}).fetcher).scheduleTrackedVideos();

		let calls = 0;
		const limited = (async () => {
			calls += 1;
			return new Response("slow down", { status: 429, headers: { "retry-after": "1800" } });
		}) as typeof fetch;
		const worker = sync(limited, { now: () => start });
		expect(await worker.captureDue()).toBe(0);

		// One call hit the limit; the other account's batch was left alone.
		expect(calls).toBe(1);
		const rows = (
			await Promise.all(["limited-1", "limited-2"].map(async (id) => (await trackedFor(id)).captures[0]!))
		).sort((left, right) => right.attempts - left.attempts);
		expect(rows[0]).toMatchObject({ state: "scheduled", attempts: 1, leaseOwner: null });
		expect(rows[0]!.dueAt.getTime()).toBeGreaterThanOrEqual(start.getTime() + 1_800_000);
		expect(rows[1]).toMatchObject({ state: "scheduled", attempts: 0 });

		// A capture that has used its budget is skipped, not retried forever.
		await prisma.performanceCapture.update({
			where: { id: rows[1]!.id },
			data: { dueAt: new Date(start.getTime() + DAY) },
		});
		await prisma.performanceCapture.update({
			where: { id: rows[0]!.id },
			data: { attempts: 9, dueAt: start },
		});
		await worker.captureDue();
		expect(await prisma.performanceCapture.findUniqueOrThrow({ where: { id: rows[0]!.id } })).toMatchObject({
			state: "skipped",
			skipReason: "rate_limited",
		});
	});

	test("a YouTube daily quota waits for the next reset without spending the attempt budget", async () => {
		const f = await fixture();
		const start = new Date();
		await published(f, { platformPostId: "quota-1", publishedAt: new Date(start.getTime() - 2 * HOUR) });
		await sync(youtube({}).fetcher).scheduleTrackedVideos();
		const exhausted = (async () =>
			json({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }, { status: 403 })) as typeof fetch;

		await sync(exhausted, { now: () => start }).captureDue();

		const capture = (await trackedFor("quota-1")).captures[0]!;
		expect(capture).toMatchObject({ state: "scheduled", attempts: 0, leaseOwner: null });
		expect(capture.dueAt.getTime()).toBe(start.getTime() + msUntilQuotaReset(start));
	});
});
