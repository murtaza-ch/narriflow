import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import type { ClipSnapshot } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
const { DubbingPanel } = await import("./dubbing-panel");
const { ContentSuitePanel } = await import("./content-suite-panel");
const { ReviewPanel } = await import("./review-panel");
const { UpgradeProvider } = await import("../../_components/upgrade");

const projectId = "22222222-2222-4222-8222-222222222222";
const rendered = {
	id: "11111111-1111-4111-8111-111111111111",
	index: 0,
	durationSec: 40,
	renderVariants: [{ aspectRatio: "9:16", hasAsset: true }],
} as unknown as ClipSnapshot;
const proPrompt = { tier: "pro" as const, headline: "Upgrade to dub your clips" };

function dubbing(props: Partial<Parameters<typeof DubbingPanel>[0]>) {
	return renderToStaticMarkup(
		<ChakraProvider value={system}>
			<DubbingPanel
				projectId={projectId}
				clips={[rendered]}
				dubs={[]}
				allowance={null}
				planRequirement={null}
				upgrade={null}
				canEdit
				{...props}
			/>
		</ChakraProvider>,
	);
}

function contentSuite(props: Partial<Parameters<typeof ContentSuitePanel>[0]>) {
	return renderToStaticMarkup(
		<ChakraProvider value={system}>
			<ContentSuitePanel projectId={projectId} transcriptReady planRequirement={null} upgrade={null} canEdit {...props} />
		</ChakraProvider>,
	);
}

describe("Dubbing panel", () => {
	test("a plan without dubbing keeps Generate dub clickable and names the plan", () => {
		const html = dubbing({ planRequirement: "Voice-over dubbing needs the Pro plan.", upgrade: proPrompt });
		expect(html).toContain("Generate dub");
		expect(html).toContain("(needs Pro)");
		expect(html).toContain("Voice-over dubbing needs the Pro plan.");
	});

	test("with nothing rendered it points to the clips to render", () => {
		const html = dubbing({ clips: [] });
		expect(html).toContain("Render a clip first.");
		expect(html).toContain(`href="/projects/${projectId}"`);
	});

	test("the summary names the clip by its title and the allowance shows as a meter", () => {
		const titled = { ...rendered, index: 4, title: "Big screen, big drain" } as unknown as ClipSnapshot;
		const html = dubbing({
			clips: [titled],
			allowance: { remaining: 12, limit: 30, maxClipSeconds: 180, renewsAt: null } as unknown as Parameters<typeof DubbingPanel>[0]["allowance"],
		});
		expect(html).toContain("05 · Big screen, big drain");
		expect(html).toContain("12 of 30 left this month");
		expect(html).toContain('role="meter"');
	});

	test("a finished dub keeps its video and audio downloads", () => {
		const dub = {
			id: "33333333-3333-4333-8333-333333333333",
			clipId: rendered.id,
			aspectRatio: "9:16",
			targetLanguageCode: "es",
			voice: "marin",
			status: "completed",
			durationSec: 42,
			errorCode: null,
		} as unknown as Parameters<typeof DubbingPanel>[0]["dubs"][number];
		const html = dubbing({ dubs: [dub] });
		expect(html).toContain("Spanish");
		expect(html).toContain("Marin");
		expect(html).toContain("0:42");
		expect(html).toContain(">Video<");
		expect(html).toContain(">Audio<");
		expect(html).not.toContain("No dubs yet");
	});

	test("with no dubs it says what a dub comes with", () => {
		const html = dubbing({});
		expect(html).toContain("No dubs yet");
		expect(html).toContain("narration-only audio file");
	});

	test("a member who can't edit sees finished dubs only, with no upgrade offer", () => {
		const html = dubbing({ canEdit: false, planRequirement: "Voice-over dubbing needs the Pro plan.", upgrade: proPrompt });
		expect(html).not.toContain("Generate dub");
		expect(html).not.toContain("needs Pro");
		expect(html).toContain("Voiceover dubs made from this project");
	});
});

describe("Repurpose panel", () => {
	test("a plan without repurposing shows a locked Generate assets", () => {
		const html = contentSuite({
			planRequirement: "Content repurposing needs the Creator plan.",
			upgrade: { tier: "creator", headline: "Upgrade to repurpose your videos" },
		});
		expect(html).toContain("Generate assets");
		expect(html).toContain("(needs Creator)");
	});

	test("a member who can't edit gets no generate action or upgrade offer", () => {
		const html = contentSuite({
			canEdit: false,
			planRequirement: "Content repurposing needs the Creator plan.",
			upgrade: { tier: "creator", headline: "Upgrade to repurpose your videos" },
		});
		expect(html).not.toContain("Generate assets");
		expect(html).not.toContain("needs the Creator plan");
	});
});

describe("Review panel", () => {
	const room = { project: { title: "Show", workspace: { name: "Team" }, approvalRequiredByDefault: false }, candidates: [], rounds: [] };

	test("a plan without review rooms locks the first step, before any form", () => {
		const html = renderToStaticMarkup(
			<ChakraProvider value={system}>
				<UpgradeProvider currentTier="pro" billingMode="change_plan" canManageBilling>
					<ReviewPanel projectId={projectId} initialData={room} canManage />
				</UpgradeProvider>
			</ChakraProvider>,
		);
		expect(html).toContain("Start a review round");
		expect(html).toContain("(needs Business)");
		expect(html).not.toContain("Export a clip first");
	});

	test("on Business the start step names the missing export", () => {
		const html = renderToStaticMarkup(
			<ChakraProvider value={system}>
				<UpgradeProvider currentTier="business" billingMode="change_plan" canManageBilling>
					<ReviewPanel projectId={projectId} initialData={room} canManage />
				</UpgradeProvider>
			</ChakraProvider>,
		);
		expect(html).not.toContain("needs Business");
		expect(html).toContain("Export a clip first");
	});
});
