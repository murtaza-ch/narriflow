import {
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

export type PipelineStepState = "done" | "active" | "failed" | "todo";

type WorkflowRunLike = {
  stage: string;
  status: string;
};

type RenderVariantLike = {
  status: string;
  hasAsset: boolean;
};

type SocialPostLike = {
  status: string;
  /** Null when the post's clip was deleted (FK is SetNull) — e.g. after
   *  "Regenerate clips" replaced the clip set the post belonged to. */
  clipId?: string | null;
};

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
  event: Pick<WorkflowStageUpdatedEvent, "workflowRunId" | "seq">,
): string {
  return `${event.workflowRunId}:${event.seq}`;
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

const INGEST_LIVE_STAGE_WORDS: Record<string, string> = {
  ingest_queued: "Queued",
  ingest_downloading: "Downloading",
  ingest_normalizing: "Normalizing",
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

/** Prefers a live SSE event over the server-rendered stage snapshot — the
 *  live event is always fresher when one has arrived for this stage. */
export function mergeStageWithLiveEvent(
  server: ProcessingStageInput,
  live: WorkflowStageUpdatedEvent | undefined,
): ProcessingStageInput {
  if (!live) return server;
  return { status: live.status, progress: live.progress, errorCode: live.errorCode };
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
  autoRenderClips: boolean;
  clipCount: number;
  hasAnyRendered: boolean;
}

const DONE_COPY = {
  clipNoAutoRender: "Clips found — previews are finishing.",
  clipAutoRender: "All done — your clips are rendered and ready.",
  captionOnly: "Your captioned video is ready.",
} as const;

/**
 * Vertical checklist stepper for the processing panel: Import -> Transcribe
 * -> Find best moments -> (Render, only when auto-render is on or the mode
 * is caption-only) -> Done. Pure derivation — the caller owns merging
 * server-rendered state with any live SSE event for freshness.
 */
export function deriveProcessingChecklist(
  input: ProcessingChecklistInput,
): ProcessingNode[] {
  const showRenderNode = input.autoRenderClips || input.mode === "caption_only";

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
      : input.autoRenderClips
        ? DONE_COPY.clipAutoRender
        : DONE_COPY.clipNoAutoRender;

  // Auto-render and caption-only both fold a mandatory render into the same
  // run, so "done" must track the render stage's own terminal status
  // (`renderState === "done"`), not merely whether one asset has landed —
  // `hasAnyRendered` flips true the instant the FIRST variant of the FIRST
  // clip finishes, while auto-render can still be rendering the rest.
  // `renderState` already falls back to `hasAnyRendered` when there's no
  // active run to read a stage status from (see the caller), so this stays
  // exactly as accurate once the run disappears.
  const isDone = input.autoRenderClips
    ? renderState === "done"
    : input.mode === "caption_only"
      ? renderState === "done"
      : input.clipCount > 0 || detectState === "done";

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

  if (showRenderNode) {
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
  }

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

export function deriveProjectPipelineStates(input: {
  clipCount: number;
  latestRun: WorkflowRunLike | null;
  renderVariants: readonly RenderVariantLike[];
  socialPosts: readonly SocialPostLike[];
}): {
  detect: PipelineStepState;
  render: PipelineStepState;
  publish: PipelineStepState;
} {
  const detectionRun =
    input.latestRun?.stage === "moment_detection" ? input.latestRun : null;
  const detect: PipelineStepState =
    input.clipCount > 0
      ? "done"
      : detectionRun?.status === "queued" ||
          detectionRun?.status === "running" ||
          detectionRun?.status === "waiting"
        ? "active"
        : detectionRun?.status === "failed"
          ? "failed"
          : "todo";

  const render: PipelineStepState = input.renderVariants.some(
    (variant) => variant.hasAsset,
  )
    ? "done"
    : input.renderVariants.some(
          (variant) =>
            variant.status === "pending" || variant.status === "rendering",
        )
      ? "active"
      : input.renderVariants.length > 0 &&
          input.renderVariants.every((variant) => variant.status === "failed")
        ? "failed"
        : "todo";

  // Orphaned posts (clip deleted, e.g. by "Regenerate clips") stay visible in
  // the Publish tab as history, but must not drive the CURRENT pipeline view:
  // counting them showed "Publish ✓" for a clip set with zero renders.
  const livePosts = input.socialPosts.filter(
    (post) => post.clipId !== null,
  );

  const publish: PipelineStepState = livePosts.some(
    (post) => post.status === "posted",
  )
    ? "done"
    : livePosts.some(
          (post) => post.status === "scheduled" || post.status === "publishing",
        )
      ? "active"
      : livePosts.some((post) => post.status === "failed")
        ? "failed"
        : "todo";

  return { detect, render, publish };
}
