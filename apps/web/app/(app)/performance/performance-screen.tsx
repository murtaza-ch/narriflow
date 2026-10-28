"use client";

import type { WorkspaceScope } from "@narriflow/api-client";
import { useQueries } from "@tanstack/react-query";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { publishingQueries } from "@/lib/publishing-client";
import { PublishingLoadError } from "@/lib/publishing-load-error";
import PerformanceLoading from "./loading";
import { WhatWorked } from "./what-worked";

/** What worked for the selected Workspace: both reads start together, with no server data. */
export function PerformanceScreen() {
	const scope = useWorkspaceScope();
	if (!scope) return <PerformanceLoading />;
	return <PerformanceContent key={scope.workspaceId} scope={scope} />;
}

function PerformanceContent({ scope }: { scope: WorkspaceScope }) {
	const runtime = useApiRuntime();
	const [summary, guidance] = useQueries({
		queries: [publishingQueries.whatWorked(runtime, scope), publishingQueries.guidance(runtime, scope)],
	});
	const failed = summary.isError ? summary : guidance.isError ? guidance : null;
	if (failed) {
		return (
			<PublishingLoadError
				error={failed.error}
				title="What worked"
				description="How your clips perform on YouTube Shorts and TikTok."
				what="Performance"
				onRetry={() => {
					void summary.refetch();
					void guidance.refetch();
				}}
			/>
		);
	}
	if (!summary.data || !guidance.data) return <PerformanceLoading />;
	return (
		<WhatWorked
			summary={summary.data.summary}
			guidance={guidance.data.guidance}
			emptyNextStep={summary.data.emptyNextStep}
		/>
	);
}
