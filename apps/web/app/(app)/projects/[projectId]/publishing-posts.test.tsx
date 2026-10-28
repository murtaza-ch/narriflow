import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import type { SocialPostSnapshot } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";
import { PublishingPosts } from "./publishing-posts";

const post = {
	id: "33333333-3333-4333-8333-333333333333",
	projectId: "22222222-2222-4222-8222-222222222222",
	clipId: null,
	accountId: null,
	accountDisplayName: "Studio channel",
	accountHandle: null,
	platform: "youtube_shorts",
	deliveryMode: "direct",
	status: "needs_attention",
	caption: "Caption",
	aspectRatio: null,
	scheduledFor: null,
	postedAt: null,
	externalUrl: null,
	errorCode: "social_account_reconnect_required",
	errorDisposition: null,
	nextAttemptAt: null,
	providerProcessingStatus: null,
	providerProcessingFailureCode: null,
	providerVisibility: null,
	allowedActions: ["confirm_published"],
	reconnectRequired: true,
	latestMetrics: null,
	createdAt: "2026-10-01T00:00:00.000Z",
} as unknown as SocialPostSnapshot;

function render(snapshot: SocialPostSnapshot, canManage: boolean) {
	return renderPosts([snapshot], canManage);
}

function renderPosts(posts: SocialPostSnapshot[], canManage: boolean, filterable = false) {
	return renderToStaticMarkup(
		<ChakraProvider value={system}>
			<PublishingPosts
				projectId={post.projectId}
				posts={posts}
				filterable={filterable}
				clips={[]}
				refresh={async () => {}}
				loadOlderPosts={async () => {}}
				nextCursor={null}
				compose={() => {}}
				canManage={canManage}
				timeZone="UTC"
			/>
		</ChakraProvider>,
	);
}

describe("publishing post actions", () => {
	test("an editor is told whom to ask instead of offered a reconnect they cannot do", () => {
		const html = render(post, true);
		expect(html).toContain("Confirm published");
		expect(html).toContain("Ask an owner or admin to reconnect this account");
		expect(html).not.toContain("Reconnect account");
	});

	test("an owner or admin gets the reconnect link", () => {
		const html = render({ ...post, allowedActions: ["confirm_published", "reconnect_account"] }, true);
		expect(html).toContain("Reconnect account");
		expect(html).not.toContain("Ask an owner or admin");
	});

	test("a viewer sees neither actions nor the request", () => {
		const html = render({ ...post, allowedActions: [] }, false);
		expect(html).not.toContain("Confirm published");
		expect(html).not.toContain("Reconnect account");
		expect(html).not.toContain("Ask an owner or admin");
	});
});

describe("project Posts tab", () => {
	test("a project with no posts shows the intro and no zeroed filter tabs", () => {
		const html = renderPosts([], true, true);
		expect(html).toContain("Publish clips and track every post");
		expect(html).toContain("Choose a clip");
		expect(html).not.toContain("Filter posts");
		expect(html).not.toContain("Needs attention");
	});

	test("a viewer with no posts is not offered a clip to publish", () => {
		const html = renderPosts([], false, true);
		expect(html).toContain("Nothing published yet");
		expect(html).not.toContain("Choose a clip");
	});

	test("filter tabs list All and only the categories that have posts", () => {
		const html = renderPosts([post], true, true);
		expect(html).toContain("All posts");
		expect(html).toContain("Needs attention");
		expect(html).not.toContain("Scheduled");
		expect(html).not.toContain("TikTok inbox");
	});
});
