import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import type { GuidanceView, PerformanceSummaryView } from "@/lib/publishing-client";
import {
	emptySummary,
	littleSummary,
	manyGuidance,
	manySummary,
	realSummary,
	waitingSummary,
} from "./what-worked.fixtures";
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

function render(summary: PerformanceSummaryView, guidance: GuidanceView = noGuidance) {
	return renderToStaticMarkup(
		<ChakraProvider value={system}>
			<WhatWorked summary={summary} guidance={guidance} />
		</ChakraProvider>,
	);
}

describe("What worked", () => {
	test("empty data says no posts are measured and names the platforms it can't read", () => {
		const markup = render(emptySummary);
		expect(markup).toContain("No posts measured yet");
		expect(markup).toContain("Facebook Reels");
		expect(markup).not.toContain("Median views");
	});

	test("the empty page names the next step for who is looking", () => {
		const empty = emptySummary;
		const page = (emptyNextStep: "publish" | "connect" | "ask" | null) =>
			renderToStaticMarkup(
				<ChakraProvider value={system}>
					<WhatWorked summary={empty} guidance={noGuidance} emptyNextStep={emptyNextStep} />
				</ChakraProvider>,
			);
		expect(page("connect")).toContain('href="/settings/social-accounts"');
		expect(page("publish")).toContain('href="/projects"');
		expect(page("ask")).toContain("Ask a workspace owner or admin to connect");
		expect(page(null)).not.toContain('href="/settings/social-accounts"');
		expect(page(null)).not.toContain("Ask a workspace owner");
	});

	test("a video still waiting for its 7-day reading is not an empty page", () => {
		const markup = render(waitingSummary);
		expect(markup).not.toContain("No posts measured yet");
		expect(markup).toContain("2 videos are younger than 7 days");
		expect(markup).toContain("Too little data to compare yet");
	});

	test("too little data is stated plainly, with the sample size", () => {
		const markup = render(littleSummary);
		expect(markup).toContain("Too little data to compare yet");
		expect(markup).toContain("2 videos have been measured");
		// Groups still show their sample sizes.
		expect(markup).toContain("Median views");
	});

	test("real data lists totals and medians with sample sizes for every grouping", () => {
		const markup = render(realSummary);
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
		const view = (overrides: Partial<GuidanceView> = {}): GuidanceView => ({
			...noGuidance,
			enabled: true,
			qualifies: true,
			applied: true,
			computedAt: "2026-10-24T03:00:00.000Z",
			totalPosts: manyGuidance.totalPosts,
			platforms: [...manyGuidance.platforms, { platform: "tiktok", posts: 12, medianViews: 3_100 }],
			groups: manyGuidance.groups,
			...overrides,
		});

		test("explains current guidance: sample sizes, lifts, a typical post per platform, and how it is used", () => {
			const markup = render(manySummary, view());
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
			const markup = render(manySummary, view({ enabled: false, applied: false }));
			expect(markup).toContain("switched off in Workspace settings");
			expect(markup).toContain("Use my performance data to pick clips: off");
		});

		test("says plainly what it needs when there is too little data", () => {
			const markup = render(littleSummary, { ...noGuidance, totalPosts: 2 });
			expect(markup).toContain("Not enough data yet.");
			expect(markup).toContain("2 clips counted at the last check");
			expect(markup).toContain("Only clips you posted from Narriflow to YouTube Shorts and TikTok are measured");
			expect(markup).toContain("30 clips with a 7-day reading");
			expect(markup).toContain("at least 10 clips");
			expect(markup).toContain("picked on their own score");
		});
	});
});
