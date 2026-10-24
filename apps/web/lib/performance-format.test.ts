import { describe, expect, test } from "bun:test";
import { describeCounts, formatCount, sumLatestCounts } from "./performance-format";

const reading = (views: number | null, likes: number | null) => ({
	latestMetrics: {
		views,
		likes,
		comments: null,
		shares: null,
		saves: null,
		watchTimeSeconds: null,
		capturedAt: "2026-10-24T10:00:00.000Z",
	},
});

describe("performance counts", () => {
	test("formats compactly and keeps small counts exact", () => {
		expect(formatCount(950)).toBe("950");
		expect(formatCount(1_482_310)).toBe("1.5M");
	});

	test("describes what the platform reports and keeps a real zero", () => {
		expect(describeCounts({ views: 1_200, likes: 56, comments: null, shares: null })).toBe(
			"1.2K views · 56 likes",
		);
		expect(describeCounts({ views: 1, likes: 0, comments: 1, shares: null })).toBe(
			"1 view · 0 likes · 1 comment",
		);
		expect(describeCounts({ views: null, likes: null, comments: null, shares: null })).toBe("");
	});

	test("sums the posts that have a reading and ignores the rest", () => {
		expect(sumLatestCounts([{ latestMetrics: null }])).toBeNull();
		expect(
			sumLatestCounts([reading(100, 4), { latestMetrics: null }, reading(50, null)]),
		).toEqual({ views: 150, likes: 4, comments: null, shares: null });
	});
});
