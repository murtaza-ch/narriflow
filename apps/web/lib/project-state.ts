import {
  ingestStageWord,
  type PipelineStepState,
  type ProcessingStageInput,
  workflowStageUpdatedEventSchema,
  type WorkflowStageUpdatedEvent,
} from "@narriflow/validators";

export const PROJECT_EVENT_ROW_LIMIT = 20;
export const PROJECT_EVENT_IDENTITY_LIMIT = 100;

/**
 * Machine stage id -> the label the pipeline stepper already shows. The
 * Activity list used to print raw ids (`stt`, `moment_detection`), so one page
 * spoke two vocabularies for the same pipeline. Keep this in sync with the
 * stepper in `projects/[projectId]/page.tsx`.
 */
const WORKFLOW_STAGE_LABELS: Record<string, string> = {
  ingest: "Ingest",
  ingest_queued: "Ingest",
  ingest_downloading: "Ingest",
  ingest_normalizing: "Ingest",
  ingest_retrying: "Ingest",
  stt: "Transcribe",
  moment_detection: "Detect",
  clip_rendering: "Render",
  dubbing: "Dub",
  publish: "Publish",
};

/** Falls back to a humanised form of the raw id so a new stage is still
 *  readable rather than disappearing. */
export function workflowStageLabel(stage: string): string {
  const known = WORKFLOW_STAGE_LABELS[stage];
  if (known) return known;
  return stage
    .split("_")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export interface PipelineStepView {
  label: string;
  state: PipelineStepState;
  status?: string | null;
}

const PIPELINE_STEP_LIVE_STAGE: Partial<Record<string, string>> = {
  Transcribe: "stt",
  Detect: "moment_detection",
  Render: "clip_rendering",
};

/**
 * Projects fresh SSE state into the compact header stepper. Events are fenced
 * to the server snapshot's current Workflow Run so terminal history from an
 * older render cannot overwrite a newer attempt's state.
 */
export function mergePipelineStepsWithLiveEvents(
  steps: PipelineStepView[],
  latestByStage: Record<string, WorkflowStageUpdatedEvent>,
  workflowRunId: string | null,
): PipelineStepView[] {
  if (!workflowRunId) return steps;

  return steps.map((step) => {
    const stage = PIPELINE_STEP_LIVE_STAGE[step.label];
    const live = stage ? latestByStage[stage] : undefined;
    if (!live || live.workflowRunId !== workflowRunId) return step;

    const state: PipelineStepState =
      live.status === "completed" || live.status === "partial"
        ? "done"
        : live.status === "failed"
          ? "failed"
          : "active";

    return { ...step, state, status: live.status };
  });
}

export function pipelineStepStateWord(
  state: PipelineStepState,
  workflowStatus?: string | null,
): string | null {
  if (state === "failed") return "failed";
  if (state !== "active") return null;
  if (
    workflowStatus === "queued" ||
    workflowStatus === "waiting" ||
    workflowStatus === "running"
  ) {
    return workflowStatus;
  }
  return "running";
}

export function parseWorkflowEventMessage(
  message: string,
): WorkflowStageUpdatedEvent | null {
  try {
    const parsed = workflowStageUpdatedEventSchema.safeParse(JSON.parse(message));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function workflowEventRowIdentity(
  event: Pick<WorkflowStageUpdatedEvent, "projectId" | "seq">,
): string {
  return `${event.projectId}:${event.seq}`;
}

export function workflowTerminalEventIdentity(
  event: Pick<WorkflowStageUpdatedEvent, "workflowRunId" | "ingestJobId" | "seq">,
): string {
  return `${event.ingestJobId ?? event.workflowRunId}:${event.seq}`;
}

function workflowActivityStateIdentity(event: WorkflowStageUpdatedEvent): string {
  return [
    event.ingestJobId ?? event.workflowRunId,
    event.stage,
    event.status,
    event.progress,
    event.errorCode ?? "",
  ].join(":");
}

/**
 * Converts durable workflow events into user-visible Activity milestones.
 * A render child completion and its aggregate progress event can describe the
 * exact same state; adjacent duplicates collapse to the later timestamp while
 * events from separate runs remain distinct.
 */
export function projectActivityRows(
  events: WorkflowStageUpdatedEvent[],
): WorkflowStageUpdatedEvent[] {
  const collapsed: WorkflowStageUpdatedEvent[] = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const previous = collapsed.at(-1);
    if (
      previous &&
      workflowActivityStateIdentity(previous) ===
        workflowActivityStateIdentity(event)
    ) {
      collapsed[collapsed.length - 1] = event;
    } else {
      collapsed.push(event);
    }
  }
  return collapsed.reverse();
}

/**
 * Records an identity once while bounding memory. Set iteration order is
 * insertion order, so the oldest identity is evicted first.
 */
export function rememberBoundedIdentity(
  identities: Set<string>,
  identity: string,
  limit = PROJECT_EVENT_IDENTITY_LIMIT,
): boolean {
  if (identities.has(identity)) return false;

  identities.add(identity);
  const boundedLimit = Math.max(1, limit);
  while (identities.size > boundedLimit) {
    const oldest = identities.values().next().value;
    if (typeof oldest !== "string") break;
    identities.delete(oldest);
  }

  return true;
}

// --- Processing checklist (Phase 2a) ---------------------------------

/** Ingest stage word for the checklist's Import node — stage words only,
 *  never a percent (ingest emits milestone progress, not a smooth %). */
export type IngestRecoveryAction = "retry" | "new_upload";

/** Provider access denials are deterministic for the same link and worker
 * runtime, and a changed upload can't be re-verified. Repeating the same
 * import is false recovery; start from a file. */
export function ingestRecoveryAction(
  errorCode: string | null | undefined,
): IngestRecoveryAction {
  return errorCode === "source_provider_access_denied" ||
    errorCode === "upload_source_changed"
    ? "new_upload"
    : "retry";
}

const INGEST_LIVE_STAGE_WORDS: Record<string, string> = {
  ingest_queued: "Queued",
  ingest_downloading: "Downloading",
  ingest_normalizing: "Normalizing",
  ingest_retrying: "Retrying",
  ingest_ready: "Ready",
  ingest: "Queued",
};

/** Freshest ingest stage word from the live SSE stream, falling back to the
 *  server-rendered ingestStatus when no live ingest event has arrived yet. */
export function liveIngestStageWord(
  latestByStage: Record<string, WorkflowStageUpdatedEvent>,
  fallbackIngestStatus: string,
): string {
  const ids = [
    "ingest_queued",
    "ingest_downloading",
    "ingest_normalizing",
    "ingest_retrying",
    "ingest_ready",
    "ingest",
  ];
  let latest: WorkflowStageUpdatedEvent | null = null;
  for (const id of ids) {
    const candidate = latestByStage[id];
    if (candidate && (!latest || candidate.seq > latest.seq)) {
      latest = candidate;
    }
  }
  if (!latest) return ingestStageWord(fallbackIngestStatus);
  return INGEST_LIVE_STAGE_WORDS[latest.stage] ?? ingestStageWord(fallbackIngestStatus);
}

/** Merge only events belonging to the current snapshot's Workflow Run. */
export function mergeStageWithLiveEvent(
  server: ProcessingStageInput,
  live: WorkflowStageUpdatedEvent | undefined,
  workflowRunId: string | null,
): ProcessingStageInput {
  if (!workflowRunId || !live || live.workflowRunId !== workflowRunId) return server;
  return { status: live.status, progress: live.progress, errorCode: live.errorCode };
}

// --- Ranked-row rank (Phase 3) ----------------------------------------

/**
 * The clip's immutable virality rank: position in `viralityScore desc, index
 * asc` ordering, computed ONCE from the full (unfiltered, unsorted-by-user)
 * clip list. Never derive rank from array position after a user-facing sort
 * or filter — that renumbers on every interaction, which is exactly what
 * this function exists to prevent. Callers should memoize on the stable
 * clip list (e.g. `useMemo(() => computeClipRanks(clips), [clips])`).
 */
export function computeClipRanks<
  T extends { id: string; viralityScore: number; index: number },
>(clips: readonly T[]): Map<string, number> {
  const ordered = [...clips].sort((a, b) => {
    if (b.viralityScore !== a.viralityScore) {
      return b.viralityScore - a.viralityScore;
    }
    return a.index - b.index;
  });

  const ranks = new Map<string, number>();
  ordered.forEach((clip, position) => {
    ranks.set(clip.id, position + 1);
  });
  return ranks;
}
