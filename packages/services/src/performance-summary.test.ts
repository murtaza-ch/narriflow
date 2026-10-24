import { describe, expect, test } from "bun:test";
import type { ClipFacts } from "@narriflow/validators";
import {
	combineLatestCaptures,
	MINIMUM_GROUP_VIDEOS,
	MINIMUM_MEASURED_VIDEOS,
	summarizePerformance,
	type PerformanceVideo,
} from "./performance-summary";

const capture = (
	views: number | null,
	capturedAt: string | null,
	extra: { likes?: number | null; shares?: number | null } = {},
) => ({
	views,
	likes: extra.likes ?? null,
	comments: null,
	shares: extra.shares ?? null,
	saves: null,
	watchTimeSeconds: null,
	capturedAt: capturedAt ? new Date(capturedAt) : null,
});

describe("latest counts for one post", () => {
	test("no capture means no counts", () => {
		expect(combineLatestCaptures([])).toBeNull();
		expect(combineLatestCaptures([{ captures: [] }])).toBeNull();
	});

	test("sums the newest capture of each video and reports the newest time", () => {
		expect(
			combineLatestCaptures([
				{ captures: [capture(100, "2026-10-24T10:00:00.000Z", { likes: 5 })] },
				{ captures: [capture(40, "2026-10-24T12:00:00.000Z", { likes: 1, shares: 2 })] },
			]),
		).toEqual({
			views: 140,
			likes: 6,
			comments: null,
			shares: 2,
			saves: null,
			watchTimeSeconds: null,
			capturedAt: "2026-10-24T12:00:00.000Z",
		});
	});
});

const facts = (overrides: Partial<ClipFacts> = {}): ClipFacts => ({
	viralityScore: 80,
	category: "insight",
	hookStrengthScore: 85,
	durationSec: 30,
	aspectRatio: "9:16",
	platform: "youtube_shorts",
	postedHour: 9,
	...overrides,
});

const video = (
	views: number,
	overrides: Partial<PerformanceVideo> = {},
): PerformanceVideo => ({
	platform: "youtube_shorts",
	facts: facts(),
	views,
	likes: Math.round(views / 10),
	comments: 1,
	...overrides,
});

describe("what worked", () => {
	test("says there is too little data below the minimum, and still reports totals", () => {
		const summary = summarizePerformance([video(100), video(300)], 3);
		expect(summary).toMatchObject({
			measuredVideos: 2,
			waitingVideos: 3,
			enough: false,
			minimumVideos: MINIMUM_MEASURED_VIDEOS,
			totals: { views: 400, likes: 40, comments: 2 },
		});
	});

	test("empty data is not enough and has no groups", () => {
		const summary = summarizePerformance([], 0);
		expect(summary.enough).toBe(false);
		expect(summary.totals).toEqual({ views: 0, likes: 0, comments: 0 });
		expect(summary.dimensions.every((dimension) => dimension.groups.length === 0)).toBe(true);
	});

	test("groups by category, hook band, length band, platform and hour with totals, medians and sample sizes", () => {
		const videos = [
			video(100, { facts: facts({ category: "story", hookStrengthScore: 55, durationSec: 15, postedHour: 8 }) }),
			video(300, { facts: facts({ category: "story", hookStrengthScore: 61, durationSec: 25, postedHour: 8 }) }),
			video(900, { facts: facts({ category: "story", hookStrengthScore: 79, durationSec: 59, postedHour: 18 }) }),
			video(1000, { platform: "tiktok", facts: facts({ category: "humor", hookStrengthScore: 80, durationSec: 61, postedHour: 18, platform: "tiktok" }) }),
			video(2000, { platform: "tiktok", facts: facts({ category: "humor", hookStrengthScore: 95, durationSec: 40, postedHour: 0, platform: "tiktok" }) }),
		];
		const summary = summarizePerformance(videos, 0);
		const dimension = (id: string) => summary.dimensions.find((entry) => entry.id === id)!.groups;

		expect(summary.enough).toBe(true);
		// Sorted by median views: humor (1500) before story (300).
		expect(dimension("category").map((g) => [g.key, g.videos, g.views.total, g.views.median, g.enough])).toEqual([
			["humor", 2, 3000, 1500, false],
			["story", 3, 1300, 300, true],
		]);
		expect(dimension("hook").map((g) => [g.label, g.videos])).toEqual([
			["Below 60", 1],
			["60 to 79", 2],
			["80 and above", 2],
		]);
		expect(dimension("duration").map((g) => [g.label, g.videos])).toEqual([
			["Under 20 seconds", 1],
			["20 to 40 seconds", 1],
			["40 to 60 seconds", 2],
			["Over 60 seconds", 1],
		]);
		expect(dimension("platform").map((g) => [g.key, g.videos])).toEqual([
			["tiktok", 2],
			["youtube_shorts", 3],
		]);
		expect(dimension("hour").map((g) => [g.label, g.videos])).toEqual([
			["12 AM", 1],
			["8 AM", 2],
			["6 PM", 2],
		]);
		expect(MINIMUM_GROUP_VIDEOS).toBe(3);
	});

	test("the median of an even group averages the middle pair", () => {
		const summary = summarizePerformance([video(10), video(20), video(30), video(100)], 0);
		const platform = summary.dimensions.find((entry) => entry.id === "platform")!.groups[0]!;
		expect(platform.views).toEqual({ total: 160, median: 25 });
	});

	test("a video without frozen facts still counts in totals and its platform", () => {
		const summary = summarizePerformance([video(500, { facts: null })], 0);
		expect(summary.totals.views).toBe(500);
		expect(summary.dimensions.find((entry) => entry.id === "platform")!.groups).toHaveLength(1);
		expect(summary.dimensions.find((entry) => entry.id === "category")!.groups).toHaveLength(0);
	});

	test("a count the platform doesn't report is left out of its statistic, not read as zero", () => {
		const summary = summarizePerformance(
			[video(10, { likes: null, comments: null }), video(20, { likes: null, comments: null })],
			0,
		);
		const group = summary.dimensions.find((entry) => entry.id === "platform")!.groups[0]!;
		expect(group.likes).toBeNull();
		expect(group.comments).toBeNull();
		expect(group.views.total).toBe(30);
	});
});
