import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import type { ProposalInboxItem } from "@narriflow/services";
import type { SocialAccountSnapshot } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";
import type { UpgradePrompt } from "../../_components/upgrade";

mock.module("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
mock.module("./actions", () => ({
	acceptAllProposalsAction: async () => ({ ok: true }),
	acceptProposalAction: async () => ({ ok: true }),
	rejectProposalAction: async () => ({ ok: true }),
	tiktokAcceptanceOptionsAction: async () => ({ ok: true }),
	updateProposalCaptionAction: async () => ({ ok: true }),
	savePostingScheduleAction: async () => ({ ok: true }),
}));
const { ProposalsInbox } = await import("./proposals-inbox");
const { PostingScheduleEditor } = await import("./posting-schedule-editor");

const UPGRADE: UpgradePrompt = { tier: "creator", headline: "Upgrade to schedule posts" };

function proposal(overrides: Partial<ProposalInboxItem> = {}): ProposalInboxItem {
	return {
		proposalId: "00000000-0000-4000-8000-0000000000f1",
		projectId: "00000000-0000-4000-8000-0000000000f2",
		clipId: "00000000-0000-4000-8000-0000000000f3",
		socialAccountId: "00000000-0000-4000-8000-0000000000f4",
		platform: "youtube_shorts",
		caption: "A caption",
		source: "finishing",
		exportId: "00000000-0000-4000-8000-0000000000f5",
		exportVariantId: "00000000-0000-4000-8000-0000000000f6",
		aspectRatio: "9:16",
		createdAt: "2026-10-20T00:00:00.000Z",
		projectTitle: "Episode 12",
		clipTitle: "Best moment",
		accountDisplayName: "Show channel",
		accountHandle: null,
		accountStatus: "active",
		hasPostingSchedule: true,
		durationSec: 30,
		nextSlot: "2026-10-28T09:00:00.000Z",
		...overrides,
	};
}

const wrap = (node: React.ReactNode) => renderToStaticMarkup(<ChakraProvider value={system}>{node}</ChakraProvider>);
const inbox = (proposals: ProposalInboxItem[], canManage = true, scheduleUpgrade: UpgradePrompt | null = null) =>
	wrap(<ProposalsInbox proposals={proposals} timeZone="UTC" canManage={canManage} scheduleUpgrade={scheduleUpgrade} />);

describe("Publishing queue", () => {
	test("an empty inbox points managers to Finishing", () => {
		expect(inbox([])).toContain('href="/recipes"');
		expect(inbox([], false)).not.toContain('href="/recipes"');
	});

	test("a blocked proposal links to what unblocks it", () => {
		const reconnect = inbox([proposal({ accountStatus: "revoked" })]);
		expect(reconnect).toContain('href="/settings/social-accounts"');
		expect(reconnect).toContain("Reconnect this account");
		const slots = inbox([proposal({ hasPostingSchedule: false })]);
		expect(slots).toContain('href="#posting-schedule"');
		expect(slots).toContain("Add posting slots to this account");
	});

	test("below Creator, Accept offers the upgrade instead of failing", () => {
		const locked = inbox([proposal(), proposal({ proposalId: "00000000-0000-4000-8000-0000000000f9" })], true, UPGRADE);
		expect(locked).toContain("(needs Creator)");
		expect(locked).toContain('aria-haspopup="dialog"');
		expect(inbox([proposal()])).not.toContain("(needs Creator)");
	});

	test("below Creator, saving posting slots offers the upgrade", () => {
		const account = {
			id: "00000000-0000-4000-8000-0000000000f4",
			platform: "youtube_shorts",
			displayName: "Show channel",
			handle: null,
			status: "active",
			postingSchedule: { slots: [{ weekday: "mon", time: "09:00" }] },
		} as unknown as SocialAccountSnapshot;
		const html = wrap(<PostingScheduleEditor accounts={[account]} timeZone="UTC" canManage scheduleUpgrade={UPGRADE} />);
		expect(html).toContain("Posting slots need the Creator plan.");
		expect(html).toContain("(needs Creator)");
	});
});
