import { performanceService } from "@narriflow/services";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { WhatWorked } from "./what-worked";

export default async function PerformancePage() {
	const appUser = await admitWorkspacePage("content.view");
	const [summary, guidance] = await Promise.all([
		performanceService.whatWorked(appUser),
		performanceService.guidance(appUser),
	]);
	return <WhatWorked summary={summary} guidance={guidance} />;
}
