import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClipFacts } from "@narriflow/validators";
import {
	computePerformanceGuidance,
	guidanceGroupLabel,
	summarizePerformance,
	type GuidanceVideo,
	type GuidanceView,
	type PerformanceVideo,
} from "@narriflow/services";
import { WhatWorked } from "./what-worked";

const noGuidance: GuidanceView = {
	enabled: true,
	qualifies: false,
	applied: false,
	computedAt: null,
	totalPosts: null,
	platforms: [],
	groups: [],
	minimumWorkspacePosts: 30,
	minimumGroupPosts: 10,
	minimumPlatformPosts: 10,
	windowDays: 180,
	minimumFactor: 0.8,
	maximumFactor: 1.25,
	maximumScoreGap: 15,
};

function render(summary: ReturnType<typeof summarizePerformance>, guidance: GuidanceView = noGuidance) {
	return renderToStaticMarkup(
		<ChakraProvider value={system}>
			<WhatWorked summary={summary} guidance={guidance} />
		</ChakraProvider>,
	);
}

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

const video = (views: number, overrides: Partial<PerformanceVideo> = {}): PerformanceVideo => ({
	platform: "youtube_shorts",
	facts: facts(),
	views,
	likes: Math.round(views / 10),
	comments: 2,
	...overrides,
});

describe("What worked", () => {
	test("empty data says no posts are measured and names the platforms it can't read", () => {
		const markup = render(summarizePerformance([], 0));
		expect(markup).toContain("No posts measured yet");
		expect(markup).toContain("Facebook Reels");
		expect(markup).not.toContain("Median views");
	});

	test("a video still waiting for its 7-day reading is not an empty page", () => {
		const markup = render(summarizePerformance([], 2));
		expect(markup).not.toContain("No posts measured yet");
		expect(markup).toContain("2 videos are younger than 7 days");
		expect(markup).toContain("Too little data to compare yet");
	});

	test("too little data is stated plainly, with the sample size", () => {
		const markup = render(summarizePerformance([video(100), video(300)], 0));
		expect(markup).toContain("Too little data to compare yet");
		expect(markup).toContain("2 videos have been measured");
		// Groups still show their sample sizes.
		expect(markup).toContain("Median views");
	});

	test("real data lists totals and medians with sample sizes for every grouping", () => {
		const markup = render(
			summarizePerformance(
				[
					video(100, { facts: facts({ category: "story", postedHour: 8 }) }),
					video(300, { facts: facts({ category: "story", postedHour: 8 }) }),
					video(900, { facts: facts({ category: "story", postedHour: 18, hookStrengthScore: 55 }) }),
					video(1_000, {
						platform: "tiktok",
						facts: facts({ category: "humor", platform: "tiktok", durationSec: 45, postedHour: 18 }),
					}),
					video(2_000, {
						platform: "tiktok",
						facts: facts({ category: "humor", platform: "tiktok", durationSec: 45, postedHour: 18 }),
					}),
				],
				1,
			),
		);
		expect(markup).not.toContain("Too little data to compare yet");
		for (const heading of ["Category", "Hook strength", "Length", "Platform", "Posted hour"]) {
			expect(markup).toContain(heading);
		}
		// Totals: 4,300 views over five videos.
		expect(markup).toContain("4,300");
		expect(markup).toContain("Humor");
		expect(markup).toContain("TikTok");
		expect(markup).toContain("YouTube Shorts");
		expect(markup).toContain("6 PM");
		expect(markup).toContain("40 to 60 seconds");
		expect(markup).toContain("1 video is younger than 7 days");
	});

	describe("audience data", () => {
		const guidanceVideo = (views: number, category: ClipFacts["category"], index: number): GuidanceVideo => ({
			...video(views, { facts: facts({ category }) }),
			clip: `clip-${index}`,
		});
		const many = [
			...Array.from({ length: 15 }, (_, index) => guidanceVideo(1_000, "story", index)),
			...Array.from({ length: 15 }, (_, index) => guidanceVideo(200, "insight", 100 + index)),
			...Array.from({ length: 10 }, (_, index) => guidanceVideo(100, "humor", 200 + index)),
		];
		const guidance = computePerformanceGuidance(many);
		const view = (overrides: Partial<GuidanceView> = {}): GuidanceView => ({
			...noGuidance,
			enabled: true,
			qualifies: true,
			applied: true,
			computedAt: "2026-10-24T03:00:00.000Z",
			totalPosts: guidance.totalPosts,
			platforms: [...guidance.platforms, { platform: "tiktok", posts: 12, medianViews: 3_100 }],
			groups: guidance.groups
				.map((group) => ({ ...group, label: guidanceGroupLabel(group)! }))
				.sort((left, right) => right.lift - left.lift),
			...overrides,
		});

		test("explains current guidance: sample sizes, lifts, a typical post per platform, and how it is used", () => {
			const markup = render(summarizePerformance(many, 0), view());
			expect(markup).toContain("Your audience data");
			expect(markup).toContain("Narriflow is using this to pick clips.");
			expect(markup).toContain("Computed Oct 24 among 40 clips you posted from Narriflow in the last 180 days");
			expect(markup).toContain("Typical post at 7 days: YouTube Shorts 200 views, TikTok 3,100 views.");
			expect(markup).toContain("Category: Story");
			expect(markup).toContain("15 clips");
			expect(markup).toContain("2.71x");
			expect(markup).toContain("0.83x");
			expect(markup).toContain("from 0.8 to 1.25");
			expect(markup).toContain("within 15 points");
			expect(markup).toContain("Hook strength is not a group");
			expect(markup).toContain("Scores themselves never change");
			expect(markup).toContain("Use my performance data to pick clips: on");
		});

		test("says when it is switched off", () => {
			const markup = render(summarizePerformance(many, 0), view({ enabled: false, applied: false }));
			expect(markup).toContain("switched off in Workspace settings");
			expect(markup).toContain("Use my performance data to pick clips: off");
		});

		test("says plainly what it needs when there is too little data", () => {
			const markup = render(summarizePerformance([video(100), video(300)], 0), { ...noGuidance, totalPosts: 2 });
			expect(markup).toContain("Not enough data yet.");
			expect(markup).toContain("2 clips counted at the last check");
			expect(markup).toContain("Only clips you posted from Narriflow to YouTube Shorts and TikTok are measured");
			expect(markup).toContain("30 clips with a 7-day reading");
			expect(markup).toContain("at least 10 clips");
			expect(markup).toContain("picked on their own score");
		});
	});
});
