import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import type { StandingGrantView } from "@narriflow/validators";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { GrantsPanel, type GrantsPanelApi } from "./grants-panel";

/** Nothing here is called while the panel is only rendered. */
const unused = async (): Promise<never> => {
	throw new Error("not used while rendering");
};
const api: GrantsPanelApi = {
	actions: {
		createRule: unused,
		updateRule: unused,
		deleteRule: unused,
		takeOverRule: unused,
		runRuleNow: unused,
		createGrant: unused,
		renewGrant: unused,
		pauseGrant: unused,
		revokeGrant: unused,
		disconnectZoom: unused,
		startZoomOAuth: unused,
	},
	changed: async () => {},
};

const RULE_ID = "00000000-0000-4000-8000-0000000000a1";

function grant(overrides: Partial<StandingGrantView>): StandingGrantView {
	return {
		id: "00000000-0000-4000-8000-0000000000d1",
		kind: "publish",
		status: "active",
		revision: 2,
		autopilotRuleId: RULE_ID,
		ruleName: "Weekly show",
		socialAccountId: "00000000-0000-4000-8000-0000000000b1",
		accountLabel: "Show channel (@show)",
		reviewerEmails: [],
		reviewerCount: 0,
		optedOut: [],
		dailyCap: 3,
		weeklyCap: 10,
		usedDay: 1,
		usedWeek: 4,
		expiresAt: "2026-11-20T00:00:00.000Z",
		pausedReason: null,
		pausedMessage: null,
		grantedByName: "Dana Lee",
		createdAt: "2026-10-20T00:00:00.000Z",
		history: [{ kind: "created", revision: 1, reason: null, actorName: "Dana Lee", at: "2026-10-20T00:00:00.000Z" }],
		sent: [],
		...overrides,
	};
}

function render(grants: StandingGrantView[], canManage: boolean, access?: { role: "owner" | "admin" | "editor" | "viewer"; status: "active" | "pending_payment" | "restricted" }) {
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
		<ChakraProvider value={system}>
			<GrantsPanel api={api} grants={grants} rules={[{ id: RULE_ID, name: "Weekly show" }]} accounts={[]} canManage={canManage} reviewAvailable access={access} initialRuleId={null} />
		</ChakraProvider>
		</QueryClientProvider>,
	);
}

describe("Automation grants panel", () => {
	test("lists a grant with its destination, usage against its caps, expiry and who it acts for", () => {
		const html = render([grant({})], true);
		expect(html).toContain("Weekly show");
		expect(html).toContain("Posts into Show channel (@show)&#x27;s queue");
		expect(html).toContain("Last 24 hours 1 of 3");
		expect(html).toContain("Last 7 days 4 of 10");
		expect(html).toContain("Expires Nov 20, 2026");
		expect(html).toContain("Revision 2, for Dana Lee");
		expect(html).toContain("Active");
	});

	test("a review grant counts its reviewers, and a paused grant says why", () => {
		const html = render([grant({ kind: "review_send", socialAccountId: null, accountLabel: null, reviewerEmails: ["a@example.test", "b@example.test"], reviewerCount: 2, optedOut: ["b@example.test"], status: "paused", pausedReason: "post_failed", pausedMessage: "A post accepted under this grant failed, so it paused." })], true);
		expect(html).toContain("Sends review rounds to 2 reviewers");
		expect(html).toContain("Opted out of automated review requests, so skipped: b@example.test");
		expect(html).toContain("Paused");
		expect(html).toContain("A post accepted under this grant failed, so it paused.");
	});

	test("an Owner or Admin can create and manage; a member sees the grants without the controls", () => {
		const manager = render([grant({})], true);
		expect(manager).toContain("New grant");
		expect(manager).toContain("Weekly show grant actions");
		const member = render([grant({})], false);
		expect(member).not.toContain("New grant");
		expect(member).not.toContain("grant actions");
		expect(member).toContain("Only Owners and Admins can grant");
		expect(member).toContain("Weekly show");
	});

	test("a restricted owner is told to fix billing, not that only owners may grant", () => {
		const html = render([grant({})], false, { role: "owner", status: "restricted" });
		expect(html).toContain("Fix billing to manage grants.");
		expect(html).toContain('href="/settings/billing"');
		expect(html).not.toContain("Only Owners and Admins can grant");
	});

	test("with no grants it says everything waits for a click", () => {
		const html = render([], true);
		expect(html).toContain("No automation grants");
		expect(html).toContain("waits for a person");
	});

	test("an expired grant reads as expired and a revoked one has no actions", () => {
		const expired = render([grant({ status: "expired" })], true);
		expect(expired).toContain("Expired");
		expect(expired).toContain("Expired Nov 20, 2026");
		const revoked = render([grant({ status: "revoked" })], true);
		expect(revoked).toContain("Revoked");
		expect(revoked).not.toContain("grant actions");
	});
});
