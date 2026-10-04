import type { IngestStatus } from "./ingest";

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
	id: string;
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
			Number(ACTIVE_WORKFLOW_STATUSES.has(right.status)) - Number(ACTIVE_WORKFLOW_STATUSES.has(left.status)) ||
			new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() ||
			(left.id === right.id ? 0 : left.id < right.id ? 1 : -1),
	);
	return newestFirst[0] ?? null;
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


export type PipelineStepState = "done" | "active" | "failed" | "todo";

const INGEST_STAGE_WORDS: Record<string, string> = {
  pending: "Queued",
  uploading: "Uploading",
  queued: "Queued",
  downloading: "Downloading",
  normalizing: "Normalizing",
  ready: "Ready",
};

export function ingestStageWord(ingestStatus: string): string {
  return INGEST_STAGE_WORDS[ingestStatus] ?? "Queued";
}

export type ProcessingStageStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "partial"
  | "failed"
  | null;

/** A single pipeline stage's resolved state — the caller (a client
 *  component with access to live SSE data) merges server-rendered truth
 *  with any fresher event for the same stage before calling
 *  deriveProcessingChecklist; this type is intentionally source-agnostic. */
export interface ProcessingStageInput {
  status: ProcessingStageStatus;
  progress: number;
  errorCode: string | null;
}

export type ProcessingNodeId =
  | "import"
  | "transcribe"
  | "detect"
  | "render"
  | "done";

export interface ProcessingNode {
  id: ProcessingNodeId;
  label: string;
  state: PipelineStepState;
  /** "est. 43%" (transcribe, elapsed-time based), "67%" (detect/render), or
   *  an ingest stage word — null when there's nothing to show. */
  detail: string | null;
  errorCode: string | null;
}

export interface ProcessingChecklistInput {
  ingestStatus: string;
  transcribe: ProcessingStageInput;
  detect: ProcessingStageInput;
  render: ProcessingStageInput;
  mode: "clip" | "caption_only";
}

const DONE_COPY = {
  clipAutoRender: "All done — your clips are rendered and ready.",
  captionOnly: "Your captioned video is ready.",
} as const;

/**
 * Vertical checklist stepper for the processing panel: Import -> Transcribe
 * -> Find best moments -> Render -> Done. The caller owns merging
 * server-rendered state with any live SSE event for freshness.
 */
export function deriveProcessingChecklist(
  input: ProcessingChecklistInput,
): ProcessingNode[] {

  const importState: PipelineStepState =
    input.ingestStatus === "ready"
      ? "done"
      : input.ingestStatus === "failed"
        ? "failed"
        : "active";

  const transcribeState: PipelineStepState = stageToStepState(input.transcribe);
  const detectState: PipelineStepState = stageToStepState(input.detect);
  const renderState: PipelineStepState = stageToStepState(input.render);

  const renderLabel =
    input.mode === "caption_only" ? "Render (captioned video)" : "Render";

  const doneCopy =
    input.mode === "caption_only"
      ? DONE_COPY.captionOnly
      : DONE_COPY.clipAutoRender;

  const isDone = importState === "done" && transcribeState === "done"
    && detectState === "done" && renderState === "done";

  const nodes: ProcessingNode[] = [
    {
      id: "import",
      label: "Import",
      state: importState,
      detail: importState === "active" ? ingestStageWord(input.ingestStatus) : null,
      errorCode: null,
    },
    {
      id: "transcribe",
      label: "Transcribe",
      state: transcribeState,
      detail:
        transcribeState === "active" &&
        input.transcribe.progress > 0 &&
        input.transcribe.progress < 100
          ? `est. ${Math.round(input.transcribe.progress)}%`
          : null,
      errorCode: input.transcribe.errorCode,
    },
    {
      id: "detect",
      label: "Find best moments",
      state: detectState,
      detail:
        detectState === "active" &&
        input.detect.progress > 0 &&
        input.detect.progress < 100
          ? `${Math.round(input.detect.progress)}%`
          : null,
      errorCode: input.detect.errorCode,
    },
  ];

  nodes.push({
    id: "render",
    label: renderLabel,
    state: renderState,
    detail:
      renderState === "active" &&
      input.render.progress > 0 &&
      input.render.progress < 100
        ? `${Math.round(input.render.progress)}%`
        : null,
    errorCode: input.render.errorCode,
  });

  nodes.push({
    id: "done",
    label: "Done",
    state: isDone ? "done" : "todo",
    detail: isDone ? doneCopy : null,
    errorCode: null,
  });

  return nodes;
}

function stageToStepState(stage: ProcessingStageInput): PipelineStepState {
  if (stage.status === "completed" || stage.status === "partial") return "done";
  if (stage.status === "failed") return "failed";
  if (
    stage.status === "queued" ||
    stage.status === "running" ||
    stage.status === "waiting"
  ) {
    return "active";
  }
  return "todo";
}

/** Resolve stored stage facts once for both the header and processing checklist. */
export function deriveProjectPipeline(input: {
  ingestStatus: string;
  transcript: { status: string; errorCode?: string | null } | null;
  clipCount: number;
  latestRun: { stage: string; status: string; progress: number; errorCode: string | null } | null;
  renderVariants: readonly { status: string; hasAsset: boolean }[];
  socialPosts: readonly { status: string; clipId?: string | null }[];
}) {
  const stageFromRun = (stage: string): ProcessingStageInput | null =>
    input.latestRun?.stage === stage
      ? { status: input.latestRun.status as ProcessingStageStatus, progress: input.latestRun.progress, errorCode: input.latestRun.errorCode }
      : null;
  const transcribe: ProcessingStageInput = stageFromRun("stt") ?? {
    status: input.transcript?.status === "completed" ? "completed"
      : input.transcript?.status === "failed" ? "failed"
      : input.transcript?.status === "queued" ? "queued"
      : input.transcript?.status === "processing" ? "running" : null,
    progress: input.transcript?.status === "completed" ? 100 : 0,
    errorCode: input.transcript?.errorCode ?? null,
  };
  const detect: ProcessingStageInput = stageFromRun("moment_detection") ?? {
    status: input.clipCount > 0 ? "completed" : null,
    progress: input.clipCount > 0 ? 100 : 0,
    errorCode: null,
  };
  const hasAsset = input.renderVariants.some(variant => variant.hasAsset);
  const render: ProcessingStageInput = stageFromRun("clip_rendering") ?? {
    status: hasAsset ? "completed"
      : input.renderVariants.some(variant => variant.status === "rendering") ? "running"
      : input.renderVariants.some(variant => variant.status === "pending") ? "queued"
      : input.renderVariants.length > 0 && input.renderVariants.every(variant => variant.status === "failed") ? "failed" : null,
    progress: hasAsset ? 100 : 0,
    errorCode: null,
  };
  const livePosts = input.socialPosts.filter(post => post.clipId !== null);
  const publish: PipelineStepState = livePosts.some(post => post.status === "posted") ? "done"
    : livePosts.some(post => ["preparing_video", "scheduled", "publishing", "processing", "reconciling"].includes(post.status)) ? "active"
    : livePosts.some(post => post.status === "failed" || post.status === "needs_attention") ? "failed" : "todo";
  return {
    ingest: input.ingestStatus === "ready" ? "done" as const : input.ingestStatus === "failed" ? "failed" as const : "active" as const,
    transcribe: stageToStepState(transcribe),
    detect: stageToStepState(detect),
    render: stageToStepState(render),
    publish,
    hasUnfinishedProcessing: [transcribe, detect, render].some(stage =>
      stage.status !== null && ["queued", "running", "waiting", "failed"].includes(stage.status)),
    processingStages: { transcribe, detect, render },
  };
}
