import { describe, expect, test } from "bun:test";
import type { ClipCategory, ClipFacts, PerformanceGuidance, SocialPlatform } from "@narriflow/validators";
import {
	computePerformanceGuidance,
	createPerformanceGuidance,
	guidanceGroupLabel,
	guidancePromptLine,
	liftFactor,
	MAXIMUM_LIFT_FACTOR,
	MAXIMUM_REORDER_SCORE_GAP,
	MINIMUM_GUIDANCE_GROUP_POSTS,
	MINIMUM_GUIDANCE_WORKSPACE_POSTS,
	MINIMUM_LIFT_FACTOR,
	rankClips,
	readAppliedGuidance,
	type AppliedGuidance,
	type GuidanceVideo,
	type RankableClip,
} from "./performance-guidance";

const facts = (category: ClipCategory, overrides: Partial<ClipFacts> = {}): ClipFacts => ({
	viralityScore: 80,
	category,
	hookStrengthScore: 85,
	durationSec: 30,
	aspectRatio: "9:16",
	platform: "youtube_shorts",
	postedHour: 9,
	...overrides,
});

let nextClip = 0;
/** `count` videos of distinct clips (or of the given clip) on one platform. */
function posts(
	count: number,
	views: number,
	category: ClipCategory,
	options: { platform?: SocialPlatform; clip?: string; durationSec?: number } = {},
): GuidanceVideo[] {
	return Array.from({ length: count }, () => ({
		clip: options.clip ?? `clip-${nextClip++}`,
		platform: options.platform ?? "youtube_shorts",
		facts: facts(category, { durationSec: options.durationSec ?? 30 }),
		views,
		likes: null,
		comments: null,
	}));
}

/** 40 clips on one platform: story 15 at 1000 views, insight 15 at 200, humor 10 at 100. The platform's typical post is 200. */
const WORKSPACE = [...posts(15, 1_000, "story"), ...posts(15, 200, "insight"), ...posts(10, 100, "humor")];
const group = (guidance: PerformanceGuidance, dimension: "category" | "duration", key: string) =>
	guidance.groups.find((entry) => entry.dimension === dimension && entry.key === key);

describe("computing Performance Guidance", () => {
	test("is empty below the Workspace threshold, counting distinct clips, but still reports the sample", () => {
		const guidance = computePerformanceGuidance(WORKSPACE.slice(0, MINIMUM_GUIDANCE_WORKSPACE_POSTS - 1));
		expect(guidance.groups).toEqual([]);
		expect(guidance.totalPosts).toBe(MINIMUM_GUIDANCE_WORKSPACE_POSTS - 1);
	});

	test("starts at exactly the Workspace threshold", () => {
		const exactly = [...posts(10, 1_000, "story"), ...posts(10, 200, "insight"), ...posts(10, 100, "humor")];
		expect(computePerformanceGuidance(exactly).totalPosts).toBe(MINIMUM_GUIDANCE_WORKSPACE_POSTS);
		expect(computePerformanceGuidance(exactly).groups.length).toBeGreaterThan(0);
	});

	test("only counts groups with enough distinct clips", () => {
		const nine = computePerformanceGuidance([...posts(MINIMUM_GUIDANCE_GROUP_POSTS - 1, 5_000, "story"), ...posts(30, 200, "insight")]);
		expect(group(nine, "category", "story")).toBeUndefined();
		expect(group(nine, "category", "insight")?.posts).toBe(30);
		const ten = computePerformanceGuidance([...posts(MINIMUM_GUIDANCE_GROUP_POSTS, 5_000, "story"), ...posts(30, 200, "insight")]);
		expect(group(ten, "category", "story")?.posts).toBe(MINIMUM_GUIDANCE_GROUP_POSTS);
	});

	test("a clip posted to several platforms counts once toward every threshold", () => {
		// Five story clips, each on both platforms: ten videos, five clips.
		const crossPosted = Array.from({ length: 5 }, (_, index) => [
			...posts(1, 1_000, "story", { clip: `cross-${index}`, platform: "youtube_shorts" }),
			...posts(1, 10_000, "story", { clip: `cross-${index}`, platform: "tiktok" }),
		]).flat();
		const others = [...posts(20, 200, "insight"), ...posts(20, 2_000, "insight", { platform: "tiktok" })];
		const guidance = computePerformanceGuidance([...crossPosted, ...others]);
		expect(guidance.totalPosts).toBe(45);
		expect(group(guidance, "category", "story")).toBeUndefined();
		expect(group(guidance, "category", "insight")?.posts).toBe(40);

		// 29 clips each posted to two platforms is 58 videos but not 30 clips.
		const twentyNine = Array.from({ length: 29 }, (_, index) => [
			...posts(1, 100, "story", { clip: `c-${index}`, platform: "youtube_shorts" }),
			...posts(1, 1_000, "story", { clip: `c-${index}`, platform: "tiktok" }),
		]).flat();
		const short = computePerformanceGuidance(twentyNine);
		expect(short.totalPosts).toBe(29);
		expect(short.groups).toEqual([]);
	});

	test("a lift is the median of views over the platform's typical post, pulled toward 1 by how few clips there are", () => {
		const guidance = computePerformanceGuidance(WORKSPACE);
		expect(guidance.totalPosts).toBe(40);
		expect(guidance.platforms).toEqual([{ platform: "youtube_shorts", posts: 40, medianViews: 200 }]);
		// Raw ratios 5, 1 and 0.5, shrunk by n / (n + 20): 15 clips -> 15/35, 10 clips -> 10/30.
		expect(group(guidance, "category", "story")).toMatchObject({ posts: 15, lift: 2.71 });
		expect(group(guidance, "category", "insight")).toMatchObject({ posts: 15, lift: 1 });
		expect(group(guidance, "category", "humor")).toMatchObject({ posts: 10, lift: 0.83 });
		expect(group(guidance, "duration", "20-40")).toMatchObject({ posts: 40, lift: 1 });
	});

	test("hook strength is not a grouping", () => {
		const dimensions = new Set(computePerformanceGuidance(WORKSPACE).groups.map((entry) => entry.dimension));
		expect([...dimensions].sort()).toEqual(["category", "duration"]);
	});

	test("a small group's lift moves less than a large group's with the same raw ratio", () => {
		// Story clips get twice the platform's typical post (100 views) in both Workspaces.
		const small = computePerformanceGuidance([...posts(10, 200, "story"), ...posts(30, 100, "insight")]);
		expect(group(small, "category", "story")?.lift).toBe(1.33); // 1 + 1 x 10/30
		const large = computePerformanceGuidance([...posts(60, 200, "story"), ...posts(100, 100, "insight")]);
		expect(group(large, "category", "story")?.lift).toBe(1.75); // 1 + 1 x 60/80
	});

	test("platforms with a 10x audience gap are never pooled: with the same behavior on each, every lift is 1", () => {
		// TikTok is mostly story, YouTube mostly humor, and views depend only on the platform.
		const guidance = computePerformanceGuidance([
			...posts(24, 1_000, "story", { platform: "tiktok" }),
			...posts(6, 1_000, "humor", { platform: "tiktok" }),
			...posts(6, 100, "story", { platform: "youtube_shorts" }),
			...posts(24, 100, "humor", { platform: "youtube_shorts" }),
		]);
		expect(guidance.groups.length).toBeGreaterThan(0);
		for (const entry of guidance.groups) expect(entry.lift).toBeCloseTo(1, 5);
		expect(guidance.platforms.map((entry) => [entry.platform, entry.medianViews])).toEqual([["tiktok", 1_000], ["youtube_shorts", 100]]);
	});

	test("with the same mix on both platforms the lifts agree too", () => {
		const platform = (name: SocialPlatform, scale: number) => [
			...posts(12, 10 * scale, "story", { platform: name }),
			...posts(12, 10 * scale, "humor", { platform: name }),
		];
		const guidance = computePerformanceGuidance([...platform("tiktok", 10), ...platform("youtube_shorts", 1)]);
		expect(guidance.groups.every((entry) => Math.abs(entry.lift - 1) < 0.001)).toBe(true);
	});

	test("a real difference inside each platform survives the normalisation", () => {
		const platform = (name: SocialPlatform, scale: number) => [
			...posts(12, 300 * scale, "story", { platform: name }),
			...posts(12, 100 * scale, "humor", { platform: name }),
		];
		const guidance = computePerformanceGuidance([...platform("tiktok", 10), ...platform("youtube_shorts", 1)]);
		expect(group(guidance, "category", "story")!.lift).toBeGreaterThan(1);
		expect(group(guidance, "category", "humor")!.lift).toBeLessThan(1);
	});

	test("a platform with too few measured posts, or no views to divide by, is left out", () => {
		const base = computePerformanceGuidance(WORKSPACE);
		const tiny = posts(MINIMUM_GUIDANCE_GROUP_POSTS - 1, 5_000_000, "story", { platform: "tiktok" });
		expect(computePerformanceGuidance([...WORKSPACE, ...tiny])).toEqual(base);
		const silent = posts(30, 0, "story", { platform: "tiktok" });
		expect(computePerformanceGuidance([...WORKSPACE, ...silent])).toEqual(base);
	});

	test("ignores posts whose clip was gone before they were first measured", () => {
		const orphans: GuidanceVideo[] = Array.from({ length: 50 }, (_, index) => ({ clip: `orphan-${index}`, platform: "tiktok", facts: null, views: 99_999, likes: null, comments: null }));
		expect(computePerformanceGuidance([...WORKSPACE, ...orphans])).toEqual(computePerformanceGuidance(WORKSPACE));
	});

	test("the same data always gives the same guidance, in any input order", () => {
		const reversed = [...WORKSPACE].reverse();
		const interleaved = WORKSPACE.filter((_, index) => index % 2 === 0).concat(WORKSPACE.filter((_, index) => index % 2 === 1));
		const expected = computePerformanceGuidance(WORKSPACE);
		expect(computePerformanceGuidance(reversed)).toEqual(expected);
		expect(computePerformanceGuidance(interleaved)).toEqual(expected);
	});
});

describe("group names", () => {
	test("are built from the key, and an unknown key has none", () => {
		expect(guidanceGroupLabel({ dimension: "category", key: "story" })).toBe("Story");
		expect(guidanceGroupLabel({ dimension: "duration", key: "40-60" })).toBe("40 to 60 seconds");
		expect(guidanceGroupLabel({ dimension: "category", key: "nonsense" })).toBeNull();
		expect(guidanceGroupLabel({ dimension: "duration", key: "forever" })).toBeNull();
	});
});

describe("the moment-detection line", () => {
	const guidance = computePerformanceGuidance(WORKSPACE);

	test("is one line naming the top two and the bottom one with their lifts", () => {
		const line = guidancePromptLine(guidance)!;
		expect(line).not.toContain("\n");
		expect(line.startsWith("- ")).toBe(true);
		expect(line).toContain("among 40 clips you posted from Narriflow");
		// Story 2.71x, then a tie at 1x broken by dimension order; humor is the weakest.
		expect(line).toContain("strongest Category Story 2.71x, Category Insight 1x; weakest Category Humor 0.83x.");
		expect(line).toContain("same scale");
		expect(line).not.toMatch(/hook/i);
	});

	test("is the same line every time", () => {
		expect(guidancePromptLine(computePerformanceGuidance([...WORKSPACE].reverse()))).toBe(guidancePromptLine(guidance)!);
	});

	test("is absent without qualifying data", () => {
		expect(guidancePromptLine(null)).toBeNull();
		expect(guidancePromptLine(computePerformanceGuidance(WORKSPACE.slice(0, 29)))).toBeNull();
	});

	test("names no weakest group when only two groups qualify", () => {
		const two: PerformanceGuidance = {
			totalPosts: 30,
			platforms: [{ platform: "youtube_shorts", posts: 30, medianViews: 100 }],
			groups: [
				{ dimension: "category", key: "story", posts: 15, lift: 2 },
				{ dimension: "duration", key: "20-40", posts: 30, lift: 1 },
			],
		};
		const line = guidancePromptLine(two)!;
		expect(line).toContain("strongest Category Story 2x, Length 20 to 40 seconds 1x.");
		expect(line).not.toContain("weakest");
	});
});

describe("the finishing factor", () => {
	const guidance = computePerformanceGuidance(WORKSPACE);
	const clip = (overrides: Partial<RankableClip> = {}): RankableClip => ({
		index: 0,
		viralityScore: 80,
		category: "insight",
		durationSec: 30,
		...overrides,
	});
	const only = (...groups: PerformanceGuidance["groups"]): PerformanceGuidance => ({ totalPosts: 30, platforms: [], groups });

	test("is the mean lift of the clip's qualifying groups", () => {
		// Story 2.71x and the length band 1x: mean 1.855, held at the ceiling.
		expect(liftFactor(clip({ category: "story" }), guidance).factor).toBe(MAXIMUM_LIFT_FACTOR);
		expect(liftFactor(clip(), guidance)).toMatchObject({ factor: 1 });
		const mild = only({ dimension: "category", key: "insight", posts: 15, lift: 1.2 }, { dimension: "duration", key: "20-40", posts: 15, lift: 1.1 });
		expect(liftFactor(clip(), mild).factor).toBe(1.15);
	});

	test("hook strength plays no part", () => {
		const mild = only({ dimension: "category", key: "insight", posts: 15, lift: 1.2 });
		expect(liftFactor({ ...clip(), hookStrengthScore: 5 } as RankableClip, mild)).toEqual(liftFactor({ ...clip(), hookStrengthScore: 99 } as RankableClip, mild));
	});

	test("never leaves 0.8 to 1.25, however extreme the lift", () => {
		const extreme = (lift: number) => only({ dimension: "category", key: "insight", posts: 30, lift });
		expect(liftFactor(clip(), extreme(40)).factor).toBe(MAXIMUM_LIFT_FACTOR);
		expect(liftFactor(clip(), extreme(0)).factor).toBe(MINIMUM_LIFT_FACTOR);
		expect(liftFactor(clip(), extreme(0.9)).factor).toBe(0.9);
		expect(MINIMUM_LIFT_FACTOR).toBe(0.8);
		expect(MAXIMUM_LIFT_FACTOR).toBe(1.25);
	});

	test("is 1 for a clip outside every qualifying group", () => {
		expect(liftFactor(clip({ category: "tutorial", durationSec: 75 }), guidance)).toEqual({ factor: 1, groups: [] });
	});
});

describe("ranking clips for finishing", () => {
	const computedAt = new Date("2026-10-24T03:00:00.000Z");
	// Story is at the ceiling (1.25) and humor at the floor (0.8); insight has no group.
	const extremes: AppliedGuidance = {
		computedAt,
		guidance: {
			totalPosts: 40,
			platforms: [],
			groups: [
				{ dimension: "category", key: "story", posts: 15, lift: 1.5 },
				{ dimension: "category", key: "humor", posts: 15, lift: 0.5 },
			],
		},
	};
	type Ranked = RankableClip & { id: string };
	const clip = (id: string, viralityScore: number, category: ClipCategory, index = 0): Ranked => ({ id, index, viralityScore, category, durationSec: 30 });
	const order = (clips: Ranked[], applied: AppliedGuidance | null) => rankClips(clips, applied).map(({ clip: ranked }) => ranked.id);

	test("without guidance it is the plain score, then detection order", () => {
		const tied = [clip("a", 90, "humor", 0), clip("b", 80, "story", 1), clip("c", 85, "insight", 2), clip("d", 90, "insight", 3)];
		const ranked = rankClips(tied, null);
		expect(ranked.map(({ clip: found }) => found.id)).toEqual(["a", "d", "c", "b"]);
		expect(ranked.every(({ ranking }) => ranking === null)).toBe(true);
	});

	test("with guidance, close scores are reordered by score times factor, and the factor is recorded", () => {
		const ranked = rankClips([clip("a", 90, "humor"), clip("b", 80, "story", 1), clip("c", 85, "insight", 2)], extremes);
		// b: 80 x 1.25 = 100; c: 85; a: 90 x 0.8 = 72. All within 15 points of each other.
		expect(ranked.map(({ clip: found }) => found.id)).toEqual(["b", "c", "a"]);
		expect(ranked[0]!.ranking).toEqual({
			score: 80,
			factor: 1.25,
			groups: [{ dimension: "category", label: "Category Story", lift: 1.5 }],
			guidanceComputedAt: computedAt.toISOString(),
		});
		expect(ranked[2]!.ranking).toMatchObject({ score: 90, factor: 0.8 });
	});

	test("worst case at both caps: a clip 15 points behind can pass, one 16 behind cannot", () => {
		// Story at 1.25 against humor at 0.8 is a 1.5625 swing: 78 x 1.25 = 97.5 beats 93 x 0.8 = 74.4.
		expect(order([clip("humor", 93, "humor"), clip("story", 78, "story", 1)], extremes)).toEqual(["story", "humor"]);
		// One more point and the plain order stands: 77 x 1.25 = 96.25 would otherwise still win.
		expect(order([clip("humor", 93, "humor"), clip("story", 77, "story", 1)], extremes)).toEqual(["humor", "story"]);
		// And the extreme the old rule allowed, a 60 over a 93, is gone.
		expect(order([clip("humor", 93, "humor"), clip("story", 60, "story", 1)], extremes)).toEqual(["humor", "story"]);
		expect(MAXIMUM_REORDER_SCORE_GAP).toBe(15);
	});

	test("a clip never overtakes one more than 15 points above it, even through a chain of close ones", () => {
		// C (70, story) beats A (90, humor) on adjusted score, but is 20 points behind it.
		const ranked = order([clip("a", 90, "humor"), clip("b", 80, "insight", 1), clip("c", 70, "story", 2)], extremes);
		expect(ranked).toEqual(["b", "a", "c"]);
	});

	test("for any mix of scores and factors, every pair it reorders is within 15 points", () => {
		const scores = [97, 93, 88, 84, 80, 78, 77, 71, 66, 62, 60, 55];
		const categories: ClipCategory[] = ["story", "humor", "insight"];
		let seed = 12345;
		const next = () => (seed = (seed * 48271) % 2147483647);
		for (let round = 0; round < 200; round += 1) {
			const clips = scores.map((score, index) => clip(`c${index}`, score, categories[next() % 3]!, index));
			const ranked = rankClips(clips, extremes).map(({ clip: found }) => found);
			ranked.forEach((ahead, position) => {
				for (const behind of ranked.slice(position + 1)) {
					if (behind.viralityScore > ahead.viralityScore) expect(behind.viralityScore - ahead.viralityScore).toBeLessThanOrEqual(MAXIMUM_REORDER_SCORE_GAP);
				}
			});
			expect(ranked.map((found) => found.id).sort()).toEqual(clips.map((found) => found.id).sort());
		}
	});

	test("the same inputs rank the same way", () => {
		const clips = [clip("a", 90, "humor"), clip("b", 80, "story", 1), clip("c", 85, "insight", 2)];
		expect(order([...clips].reverse(), extremes)).toEqual(order(clips, extremes));
	});
});

describe("guidance in force", () => {
	const guidance = computePerformanceGuidance(WORKSPACE);
	const computedAt = new Date("2026-10-24T03:00:00.000Z");
	const prismaWith = (row: { usePerformanceGuidance: boolean | null; performanceGuidance: unknown } | null) =>
		({ workspace: { findUnique: async () => row } }) as never;
	const stored = { ...guidance, computedAt };

	test("the default setting (null) uses qualifying guidance, and an explicit yes does too", async () => {
		for (const setting of [null, true]) {
			const applied = await readAppliedGuidance(prismaWith({ usePerformanceGuidance: setting, performanceGuidance: stored }), "w");
			expect(applied).toEqual({ guidance, computedAt });
		}
	});

	test("an explicit no uses nothing", async () => {
		expect(await readAppliedGuidance(prismaWith({ usePerformanceGuidance: false, performanceGuidance: stored }), "w")).toBeNull();
	});

	test("data that has not qualified, or does not exist, uses nothing", async () => {
		const unqualified = { ...computePerformanceGuidance(WORKSPACE.slice(0, 10)), computedAt };
		expect(await readAppliedGuidance(prismaWith({ usePerformanceGuidance: null, performanceGuidance: unqualified }), "w")).toBeNull();
		expect(await readAppliedGuidance(prismaWith({ usePerformanceGuidance: null, performanceGuidance: null }), "w")).toBeNull();
		expect(await readAppliedGuidance(prismaWith(null), "w")).toBeNull();
	});

	test("stored labels are not trusted: a stored shape with its own label text is refused, and unknown keys are dropped", async () => {
		const withLabel = { ...stored, groups: stored.groups.map((entry) => ({ ...entry, label: "Anything at all" })) };
		expect(await readAppliedGuidance(prismaWith({ usePerformanceGuidance: null, performanceGuidance: withLabel }), "w")).toBeNull();
		const oneUnknown = { ...stored, groups: [...stored.groups, { dimension: "category", key: "retired-category", posts: 12, lift: 3 }] };
		const applied = await readAppliedGuidance(prismaWith({ usePerformanceGuidance: null, performanceGuidance: oneUnknown }), "w");
		expect(applied?.guidance.groups).toEqual(guidance.groups);
		const onlyUnknown = { ...stored, groups: [{ dimension: "category", key: "retired-category", posts: 12, lift: 3 }] };
		expect(await readAppliedGuidance(prismaWith({ usePerformanceGuidance: null, performanceGuidance: onlyUnknown }), "w")).toBeNull();
	});

	test("the prompt line needs qualifying data and the setting on", async () => {
		const promptLine = (row: Parameters<typeof prismaWith>[0]) =>
			createPerformanceGuidance({ prisma: prismaWith(row) as never }).promptLine("w");
		expect(await promptLine({ usePerformanceGuidance: null, performanceGuidance: stored })).toBe(guidancePromptLine(guidance)!);
		expect(await promptLine({ usePerformanceGuidance: true, performanceGuidance: stored })).toBe(guidancePromptLine(guidance)!);
		expect(await promptLine({ usePerformanceGuidance: false, performanceGuidance: stored })).toBeNull();
		expect(await promptLine({ usePerformanceGuidance: null, performanceGuidance: { ...computePerformanceGuidance([]), computedAt } })).toBeNull();
		expect(await promptLine(null)).toBeNull();
	});
});
