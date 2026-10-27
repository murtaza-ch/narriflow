import { performanceService, socialOAuthService } from "@narriflow/services";
import { performanceSyncAvailable, workspaceAllowsCapability } from "@narriflow/validators";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { WhatWorked, type EmptyNextStep } from "./what-worked";

export default async function PerformancePage() {
	const appUser = await admitWorkspacePage("content.view");
	const [summary, guidance, accounts] = await Promise.all([
		performanceService.whatWorked(appUser),
		performanceService.guidance(appUser),
		socialOAuthService.listAccounts(appUser),
	]);
	// Measuring needs a post from a connected YouTube or TikTok account.
	const measurable = accounts.some((account) => account.publishingEligible && performanceSyncAvailable(account.platform));
	const emptyNextStep: EmptyNextStep = !workspaceAllowsCapability(appUser.workspace, "publishing.manage")
		? null
		: measurable
			? "publish"
			: workspaceAllowsCapability(appUser.workspace, "social.manage")
				? "connect"
				: "ask";
	return <WhatWorked summary={summary} guidance={guidance} emptyNextStep={emptyNextStep} />;
}
