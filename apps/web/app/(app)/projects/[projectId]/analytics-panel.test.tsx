import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnalyticsSnapshot, ClipSnapshot } from "@narriflow/validators";
import { AnalyticsPanel } from "./analytics-panel";

const clipId = "11111111-1111-4111-8111-111111111111";
const clips = [{ id: clipId, index: 0, title: "The origin story", hookText: "hook" }] as unknown as ClipSnapshot[];
const totals = {
	rendersCompleted: 1,
	downloadsOpened: 0,
	socialScheduled: 1,
	socialPosted: 2,
	socialFailed: 0,
	dubsCompleted: 0,
	dubDownloadsOpened: 0,
};

type Performance = AnalyticsSnapshot["postPerformance"];
type PostRow = Performance["posts"][number];

const post = (overrides: Partial<PostRow> = {}): PostRow => ({
	socialPostId: crypto.randomUUID(),
	clipId,
	platform: "youtube_shorts",
	postedAt: "2026-10-24T10:00:00.000Z",
	latestMetrics: null,
	...overrides,
});

const noPerformance: Performance = {
	measuredVideos: 0,
	totals: { views: 0, likes: 0, comments: 0, shares: 0 },
	posts: [],
};

function render(postPerformance: Performance, data: Partial<AnalyticsSnapshot> = {}) {
	const analytics: AnalyticsSnapshot = {
		projectId: "22222222-2222-4222-8222-222222222222",
		totals,
		byClip: [{ clipId, ...totals }],
		postPerformance,
		...data,
	};
	return renderToStaticMarkup(
		<ChakraProvider value={system}>
			<AnalyticsPanel analytics={analytics} clips={clips} />
		</ChakraProvider>,
	);
}

describe("Analytics panel post performance", () => {
	test("shows the Project totals and the latest counts per post, a dash for what the platform withholds", () => {
		const markup = render({
			measuredVideos: 150,
			// More posts than a page holds: the totals come from the whole Project.
			totals: { views: 3_200_000, likes: 104_000, comments: 8_000, shares: 0 },
			posts: [
				post({
					latestMetrics: {
						views: 1_482_310,
						likes: 52_744,
						comments: null,
						shares: null,
						saves: null,
						watchTimeSeconds: null,
						capturedAt: "2026-10-24T12:00:00.000Z",
					},
				}),
			],
		});
		expect(markup).toContain("Post performance");
		expect(markup).toContain("The origin story");
		expect(markup).toContain("3.2M views");
		expect(markup).toContain("across 150 measured videos");
		expect(markup).toContain("1.5M");
		expect(markup).toContain("52.7K");
		expect(markup).toContain("–");
	});

	test("a post without a reading says when to expect one, and a platform that isn't read says so", () => {
		const markup = render({
			...noPerformance,
			posts: [post(), post({ platform: "facebook_reels" })],
		});
		expect(markup).toContain("First reading about an hour after posting");
		expect(markup).toContain("Not measured on this platform");
		expect(markup).not.toContain("measured video");
	});

	test("with no published post the section is absent and the empty panel still renders", () => {
		expect(render(noPerformance)).not.toContain("Post performance");
		const empty = render(noPerformance, {
			byClip: [],
			totals: { ...totals, rendersCompleted: 0, socialScheduled: 0, socialPosted: 0 },
		});
		expect(empty).toContain("No activity yet");
		expect(empty).not.toContain("Post performance");
	});
});
