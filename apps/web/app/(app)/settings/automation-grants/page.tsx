import { Stack } from "@chakra-ui/react";
import { autopilotService, hasFeature, socialOAuthService, standingGrants } from "@narriflow/services";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { GrantsPanel } from "./grants-panel";

export default async function AutomationGrantsPage({ searchParams }: { searchParams: Promise<{ rule?: string }> }) {
	const appUser = await admitWorkspacePage("content.view");
	const [grants, rules, accounts, params] = await Promise.all([
		standingGrants.list(appUser),
		autopilotService.listRules(appUser),
		socialOAuthService.listAccounts(appUser),
		searchParams,
	]);
	return (
		<Stack gap="8">
			<PageHeader
				title="Automation grants"
				description="A grant lets one Autopilot rule's output go out without a click, within caps and until it expires. Brand approval rules still apply."
			/>
			<GrantsPanel
				grants={grants}
				rules={rules.map(({ id, name }) => ({ id, name }))}
				// TikTok needs the creator's choices on every post, so it can't hold a grant;
				// nor can an account the plan doesn't publish to.
				accounts={accounts
					.filter((account) => account.status === "active" && account.publishingEligible && account.platform !== "tiktok")
					.map(({ id, displayName, handle, platform }) => ({ id, label: `${displayName}${handle ? ` (${handle})` : ""}`, platform }))}
				canManage={workspaceAllowsCapability({ role: appUser.role, status: appUser.status }, "workspace.manage")}
				reviewAvailable={hasFeature(appUser.pricingTier, "review.rooms")}
				// Grants belong to Autopilot rules, so a plan without Autopilot offers the upgrade.
				autopilotUpgrade={featureUpgradePrompt(appUser.pricingTier, "automation.autopilot", "Upgrade to publish automatically")}
				reviewUpgrade={featureUpgradePrompt(appUser.pricingTier, "review.rooms", "Upgrade to send review rounds")}
				access={{ role: appUser.role, status: appUser.status }}
				initialRuleId={rules.some((rule) => rule.id === params.rule) ? (params.rule ?? null) : null}
			/>
		</Stack>
	);
}
