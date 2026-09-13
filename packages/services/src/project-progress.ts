import { Prisma, type IngestStatus } from "@prisma/client";

export type ProjectListProgressStatus =
	| "ready"
	| "processing"
	| "queued"
	| "failed";

export interface ProjectListProgress {
	status: ProjectListProgressStatus;
	label: string;
	active: boolean;
}

export interface ProjectListWorkflowRun {
	stage: string;
	status: string;
	updatedAt: Date | string;
}

const ACTIVE_WORKFLOW_STATUSES = new Set(["queued", "running", "waiting"]);

const WORKFLOW_PROGRESS_LABELS: Record<string, { active: string; queued: string }> = {
	stt: { active: "Transcribing", queued: "Transcription queued" },
	moment_detection: { active: "Detecting", queued: "Detection queued" },
	clip_rendering: { active: "Rendering", queued: "Render queued" },
	dubbing: { active: "Dubbing", queued: "Dub queued" },
};

function workflowProgressLabel(stage: string, status: string) {
	const label = WORKFLOW_PROGRESS_LABELS[stage];
	if (label) return status === "queued" ? label.queued : label.active;
	const readable = stage
		.split("_")
		.filter(Boolean)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join(" ");
	return status === "queued" ? `${readable} queued` : `${readable} in progress`;
}

/** The one relevant Workflow Run: an active run wins; otherwise use the
 * newest terminal run. Both the query adapter and detail snapshot use this
 * ordering, while callers retain the separate lifecycle records. */
export function resolveProjectProgressRun(
	workflowRuns: readonly ProjectListWorkflowRun[],
): ProjectListWorkflowRun | null {
	const newestFirst = [...workflowRuns].sort(
		(left, right) =>
			new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
	);
	return (
		newestFirst.find((run) => ACTIVE_WORKFLOW_STATUSES.has(run.status)) ??
		newestFirst[0] ??
		null
	);
}

/** Product progress joins intake and the one relevant Workflow Run only for
 * list/detail presentation. It never changes either underlying lifecycle. */
export function deriveProjectListProgress(input: {
	ingestStatus: IngestStatus;
	workflowRuns: readonly ProjectListWorkflowRun[];
}): ProjectListProgress {
	if (input.ingestStatus === "failed") {
		return { status: "failed", label: "Import failed", active: false };
	}
	if (input.ingestStatus === "queued" || input.ingestStatus === "pending") {
		return { status: "queued", label: "Import queued", active: true };
	}
	if (input.ingestStatus !== "ready") {
		return { status: "processing", label: "Importing", active: true };
	}

	const workflowRun = resolveProjectProgressRun(input.workflowRuns);
	if (workflowRun?.status === "queued" || workflowRun?.status === "running" || workflowRun?.status === "waiting") {
		return {
			status: workflowRun.status === "queued" ? "queued" : "processing",
			label: workflowProgressLabel(workflowRun.stage, workflowRun.status),
			active: true,
		};
	}
	if (workflowRun?.status === "failed") {
		return { status: "failed", label: `${workflowProgressLabel(workflowRun.stage, "running")} failed`, active: false };
	}
	if (workflowRun?.status === "partial") {
		return { status: "ready", label: "Partially ready", active: false };
	}
	return { status: "ready", label: "Ready", active: false };
}

/** SQL ordering for the same relevant-run choice used above. */
export function projectProgressWorkflowOrderSql() {
	return Prisma.sql`CASE WHEN status IN ('queued', 'running', 'waiting') THEN 0 ELSE 1 END, "updatedAt" DESC, id DESC`;
}

/** SQL status expression for the same product progress status used above. */
export function projectProgressStatusSql(input: {
	ingestStatus: Prisma.Sql;
	workflowStatus: Prisma.Sql;
}) {
	return Prisma.sql`
		CASE
			WHEN ${input.ingestStatus} = 'failed' THEN 'failed'
			WHEN ${input.ingestStatus} IN ('queued', 'pending') THEN 'queued'
			WHEN ${input.ingestStatus} <> 'ready' THEN 'processing'
			WHEN ${input.workflowStatus} = 'queued' THEN 'queued'
			WHEN ${input.workflowStatus} IN ('running', 'waiting') THEN 'processing'
			WHEN ${input.workflowStatus} = 'failed' THEN 'failed'
			ELSE 'ready'
		END
	`;
}
