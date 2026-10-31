import type { RenderGroupLifecycle, WorkflowAttemptRef, WorkflowAttemptContext, getWorkflowRunLifecycle, clipService } from "@narriflow/services";
import { executeRenderGroup } from "../../media/src/render-group-executor";
export { asAttemptLost, renderGroupExecutionAttempt, newRenderGroupLedger, renderGroupAttemptLifecycle, type RenderGroupLedger } from "../../media/src/render-group-executor";

/** The pre-cutover queue adapter. Native execution owns no queue or database defaults. */
export async function executeNextRenderGroup(input: Omit<Parameters<typeof executeRenderGroup>[0], "group" | "groups"> & {
 groups: Parameters<typeof executeRenderGroup>[0]["groups"] & Pick<RenderGroupLifecycle, "claim">;
}): Promise<0 | 1> {
 if (input.signal?.aborted || input.canStart?.() === false) return 0;
 const group = await input.groups.claim();
 if (!group) return 0;
 return executeRenderGroup({ ...input, group });
}

/**
 * Coordinator attempt for a clip_rendering run: freeze and admit the group
 * partition, then keep the parent lease alive while replicas render groups.
 * Returns the parent's terminal settlement. It performs no media work.
 */
export async function coordinateRenderWorkSet(input: {
	attempt: WorkflowAttemptRef;
	context: WorkflowAttemptContext;
	lifecycle: Pick<
		ReturnType<typeof getWorkflowRunLifecycle>,
		"beginRenderWorkSet" | "admitRenderGroups" | "settleRenderWorkSet"
	>;
	state: Pick<typeof clipService, "planRenderGroups">;
	pollIntervalMs: number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
	const { attempt, context, lifecycle } = input;
	const sleep = input.sleep ?? sleepUnlessAborted;
	context.signal.throwIfAborted();
	await lifecycle.beginRenderWorkSet(attempt);
	const groups = await input.state.planRenderGroups(attempt.projectId, attempt.workflowRunId);
	if (groups) await lifecycle.admitRenderGroups(attempt, groups);
	for (;;) {
		context.signal.throwIfAborted();
		const outcome = await lifecycle.settleRenderWorkSet(attempt);
		if (outcome.status !== "pending") return outcome;
		await sleep(input.pollIntervalMs, context.signal);
	}
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
