import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Clip, ClipRender } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { projectService } from "./project.service";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  CLIP_MAX_DURATION_SEC,
  CLIP_MIN_DURATION_SEC,
  CLIP_TITLE_MAX_LENGTH,
  CLIP_TITLE_SUGGESTION_COUNT,
  LEGACY_DEFAULT_CAPTION_PRESET_ID,
  brollCuesArraySchema,
  buildTranscriptSliceForWindow,
  captionPresetSchema,
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioOptions,
  clipAspectRatioToDb,
  clipAutoLayoutAnalysisSchema,
  clipSplitLayoutFailureSchema,
  clipLayoutAnalysisSchema,
  clipLayoutAnalysisFailureSchema,
  clipRenderResolutionSchema,
  clipTitleSuggestionsLlmResponseSchema,
	contentPackSchema,
	DEFAULT_CAPTION_PRESET,
	EDITOR_DOCUMENT_VERSION,
	getCaptionPresetById,
  getEffectiveClipTiming,
  isBrandDefaultCaptionPresetId,
  normalizeTranscriptSliceForClip,
  parseClipAutoLayoutAnalysis,
  parseClipSplitLayoutAnalysis,
  parseClipSplitLayoutFailure,
  parseClipSplitLayoutOutcome,
  parseClipLayoutAnalysis,
  parseClipLayoutAnalysisFailure,
  parseClipLayoutAnalysisOutcome,
  resolvePricingTier,
  splitUtterancesIntoSentences,
  studioEditsSchema,
} from "@narriflow/validators";
import type {
  BrollCue,
  CaptionPreset,
  ClipAspectRatio,
  ClipAutoLayoutAnalysis,
  ClipCategory,
  ClipLayoutAnalysis,
  ClipLayoutAnalysisFailure,
  ClipLayoutAnalysisOutcome,
  ClipPlatformTarget,
  ClipRenderResolution,
  ClipRenderVariant,
  ClipSplitLayoutAnalysis,
  ClipSplitLayoutFailure,
  ClipSplitLayoutOutcome,
  ClipSnapshot,
  ContentPack,
  EditorDocument,
  SourceRange,
  StudioEdits,
  TranscriptUtterance,
  WorkflowStageUpdatedEvent,
} from "@narriflow/validators";
import {
  getLastWorkflowSeq,
  publishWorkflowStageUpdated,
} from "./workflow.service";
import {
  classifyR2StorageError,
  copyObject,
  deleteObject,
  getJsonObject,
  presignDownloadUrl,
} from "./r2-storage";
import {
  adoptDurableMediaCopies,
  admitRetiredClipMediaCleanup,
  runDurableMediaCopies,
  type DurableMediaCopyPlan,
} from "./media-cleanup";
import {
  derivePeaksStorageKey,
  isClipPreviewPeaks,
  tryDerivePeaksStorageKey,
  type ClipPreviewPeaks,
} from "./clip-preview-storage";
import { analyticsService } from "./analytics.service";
import { clipExportService } from "./clip-export.service";
import { hasFeature } from "./billing.service";
import { accessibleProjectWhere } from "./project-retention.service";
import { workspaceService } from "./workspace.service";
import {
  currentWorkflowAttempt,
  getWorkflowRunLifecycle,
  requireProtocolV1WorkflowContext,
} from "./workflow-run-lifecycle";
import {
  clipEditorDocumentPersistence,
  decodeClipEditorDocumentFromStorage,
  encodeClipEditorDocumentForStorage,
} from "./clip-editor-document-persistence";
import {
  computeDurationOptimality,
  computePacingScore,
  computePlatformScore,
  computeViralityScore,
} from "./clip-scoring";

export {
  computeDurationOptimality,
  computePacingScore,
  computePlatformScore,
  computeViralityScore,
} from "./clip-scoring";

interface DetectedClip {
  startSec: number;
  endSec: number;
  title: string | null;
  hookText: string;
  payoffText: string | null;
  reasoning: string;
  category: ClipCategory;
  platformFit: ClipPlatformTarget[];
  hookStrengthScore: number;
  emotionalIntensityScore: number;
  storyCompletenessScore: number;
  pacingScore: number;
  durationOptimalityScore: number;
  viralityScore: number;
  tiktokScore: number;
  youtubeScore: number;
  instagramScore: number;
  transcriptSlice: TranscriptUtterance[];
  /** LLM-suggested B-roll cutaway moments, `atSec` relative to the clip's own
   *  start. Optional: the caption-only detection path emits no cues, and older
   *  rows predate the column. When absent the render falls back to the
   *  keyword-derived Pexels query. */
  brollCues?: BrollCue[];
}

interface LlmMeta {
  provider: string;
  model: string;
  totalTokensUsed: number | null;
}

/** A clip still missing a preview proxy, with enough of its project's
 *  source info for the worker to cut one. Returned by
 *  {@link ClipService.getClipsNeedingPreview}.
 *
 *  `startSec`/`endSec` double as the EXPECTED window for
 *  {@link ClipService.completeClipPreview}'s claim: the worker echoes them
 *  back on completion, and the claim only succeeds if the clip's stored
 *  boundaries still match. Without this, an in-flight cut for an OLD window
 *  can land after a boundary edit/reset already nulled `previewStorageKey`
 *  for a NEW window — the stale attempt would otherwise win the
 *  `previewStorageKey IS NULL` race and persist a proxy for the wrong
 *  window. */
export interface ClipPendingPreview {
  id: string;
  projectId: string;
  startSec: number;
  endSec: number;
  sourceStorageKey: string;
  sourceDurationSec: number | null;
}

/** A clip whose proxy exists but whose shared automatic speaker-layout plan
 * has not been analyzed yet (or was explicitly invalidated by a range edit). */
export interface ClipPendingAutoLayoutAnalysis {
  id: string;
  projectId: string;
  startSec: number;
  endSec: number;
  transcriptSlice: TranscriptUtterance[];
  deletedRanges: SourceRange[];
  editorRevision: number;
  previewStorageKey: string;
  previewStartSec: number;
  previewDurationSec: number;
  /** Per-attempt fencing token. Only the worker holding this token may
   * publish or defer the claimed analysis. */
  autoLayoutClaimToken: string;
}

export function resolveClipCaptionPresetForContentPack(
  captionPresetId: string | null | undefined,
  templateCaptionPreset: CaptionPreset | null,
): CaptionPreset | null {
  const id =
    captionPresetId && captionPresetId.trim()
      ? captionPresetId
      : BRAND_DEFAULT_CAPTION_PRESET_ID;

  if (
    isBrandDefaultCaptionPresetId(id) ||
    id === LEGACY_DEFAULT_CAPTION_PRESET_ID
  ) {
    return templateCaptionPreset;
  }

  return getCaptionPresetById(id)?.preset ?? templateCaptionPreset;
}

type ClipWithRenders = Clip & {
  renders: ClipRender[];
  project?: { sourceDurationSeconds: number | null } | null;
};

const DEFAULT_RENDER_ASPECT_RATIOS: ClipAspectRatio[] = ["9:16"];
const aspectRatioOrder = new Map(
  clipAspectRatioOptions.map((option, index) => [option.value, index]),
);
const aspectRatioSlug = new Map(
  clipAspectRatioOptions.map((option) => [option.value, option.slug]),
);

function sortPendingClipRenders<
  T extends { clip: { index: number }; aspectRatio: string },
>(renders: T[]): T[] {
  return renders.sort((left, right) => {
    if (left.clip.index !== right.clip.index) {
      return left.clip.index - right.clip.index;
    }
    const leftAspectRatio =
      clipAspectRatioFromDb[clipAspectRatioDbSchema.parse(left.aspectRatio)];
    const rightAspectRatio =
      clipAspectRatioFromDb[clipAspectRatioDbSchema.parse(right.aspectRatio)];
    return (
      (aspectRatioOrder.get(leftAspectRatio) ?? Number.MAX_SAFE_INTEGER) -
      (aspectRatioOrder.get(rightAspectRatio) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable");
  }
  return prisma;
}

function normalizeAspectRatios(
  aspectRatios?: ClipAspectRatio[],
): ClipAspectRatio[] {
  const requested =
    aspectRatios && aspectRatios.length > 0
      ? aspectRatios
      : DEFAULT_RENDER_ASPECT_RATIOS;

  return [...new Set(requested)].sort(
    (left, right) =>
      (aspectRatioOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (aspectRatioOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Resolves what resolution a newly-queued render should actually be created
 * at: a "720p" request is always honored as-is (never "upgraded"), but a
 * "1080p" request is clamped down to "720p" when the owner's tier lacks the
 * `export.1080p` entitlement — freemium UX, so the request never fails, it
 * just gets the best the plan allows. This is the single choke point every
 * ClipRender-creating path (user-triggered renders and the post-detection
 * auto-render) must go through so a free-tier row is never created at
 * "1080p" by omission.
 */
async function resolveRequestedResolution(
  requested: ClipRenderResolution,
  workspaceId: string,
): Promise<ClipRenderResolution> {
  if (requested === "720p") return "720p";
  const tier = resolvePricingTier(
    (
      await requirePrisma().workspace.findUnique({
        where: { id: workspaceId },
        select: { pricingTier: true },
      })
    )?.pricingTier,
  );
  return hasFeature(tier, "export.1080p") ? "1080p" : "720p";
}

function toClipRenderVariantSnapshot(render: ClipRender): ClipRenderVariant {
  const aspectRatioDb = clipAspectRatioDbSchema.parse(render.aspectRatio);
  const aspectRatio = clipAspectRatioFromDb[aspectRatioDb];
  // Tolerant parse: rows written before this column existed (or by a future
  // rollback) still need a valid variant snapshot — fall back to the
  // column's own DB default rather than throwing.
  const resolution =
    clipRenderResolutionSchema.safeParse(render.resolution).data ?? "1080p";

  return {
    aspectRatio,
    status: render.status as ClipRenderVariant["status"],
    sizeBytes: render.sizeBytes ? Number(render.sizeBytes) : null,
    durationSec: render.durationSec ?? null,
    errorCode: render.errorCode ?? null,
    completedAt: render.completedAt?.toISOString() ?? null,
    hasAsset: render.status === "completed" && Boolean(render.storageKey),
    resolution,
  };
}

function toClipSnapshot(clip: ClipWithRenders): ClipSnapshot {
  const editorDocument = decodeClipEditorDocumentFromStorage(
    clip,
    clip.project?.sourceDurationSeconds ?? null,
  );
  // tailPadSec 0: the stored bounds were already pad- and collision-
  // normalized against the FULL transcript when the clip was detected or
  // edited. The clip's own slice can't see the next word beyond its end, so
  // re-padding here would walk the end back INTO the next sentence —
  // exactly the mid-speech cut this pipeline just eliminated. Slice-only
  // re-derivations must treat stored timing as final.
  const effective = getEffectiveClipTiming({
    utterances: editorDocument.transcriptSlice,
    startSec: editorDocument.clipStartSec,
    endSec: editorDocument.clipEndSec,
    sourceDurationSec: clip.project?.sourceDurationSeconds ?? null,
    tailPadSec: 0,
  });

  return {
    id: clip.id,
    projectId: clip.projectId,
    editorRevision: clip.editorRevision,
    index: clip.index,
    status: clip.status as ClipSnapshot["status"],
    startSec: effective.startSec,
    endSec: effective.endSec,
    durationSec: Math.round(effective.durationSec * 10) / 10,
    title: clip.title,
    hookText: clip.hookText,
    payoffText: clip.payoffText,
    reasoning: clip.reasoning,
    category: clip.category as ClipSnapshot["category"],
    platformFit: clip.platformFit as ClipPlatformTarget[],
    viralityScore: clip.viralityScore,
    hookStrengthScore: clip.hookStrengthScore,
    emotionalIntensityScore: clip.emotionalIntensityScore,
    storyCompletenessScore: clip.storyCompletenessScore,
    pacingScore: clip.pacingScore,
    durationOptimalityScore: clip.durationOptimalityScore,
    tiktokScore: clip.tiktokScore,
    youtubeScore: clip.youtubeScore,
    instagramScore: clip.instagramScore,
    transcriptSlice: effective.transcriptSlice,
    renderVariants: clip.renders
      .filter((render) => render.exportVariantId === null)
      .map(toClipRenderVariantSnapshot)
      .sort(
        (left, right) =>
          (aspectRatioOrder.get(left.aspectRatio) ?? Number.MAX_SAFE_INTEGER) -
          (aspectRatioOrder.get(right.aspectRatio) ?? Number.MAX_SAFE_INTEGER),
      ),
    captionPreset: editorDocument.captionPreset,
    brollUrl: editorDocument.brollUrl,
    // Tolerant parse: cues are LLM-authored and purely advisory, so a malformed
    // payload should degrade to keyword-derived B-roll, never fail the clip.
    brollCues: brollCuesArraySchema.safeParse(clip.brollCues).data ?? [],
    studioEdits: editorDocument.studioEdits,
    // Presence-only signal — never the storage key itself. See the schema
    // doc comment in packages/validators/src/clip.ts for why this exists.
    hasPreview: Boolean(clip.previewStorageKey),
    createdAt: clip.createdAt.toISOString(),
  };
}

function getClipRenderResetData(
  resolution: ClipRenderResolution,
): Prisma.ClipRenderUpdateInput {
  return {
    status: "pending",
    storageKey: null,
    sizeBytes: null,
    durationSec: null,
    errorCode: null,
    failureDisposition: null,
    workflowAttemptId: null,
    workflowRun: { disconnect: true },
    startedAt: null,
    completedAt: null,
    resolution,
  };
}

/**
 * A clip action that failed for a reason the user can act on, carrying the
 * `code` the API surfaces so `userErrorMessage` can render real copy instead of
 * the generic fallback. Thrown by rename/duplicate/delete/title-suggestion;
 * the older clip mutations predate this and throw plain Errors.
 */
export class ClipActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClipActionError";
  }
}

// ─── Create clip from selection (vizard-parity.md Phase B step 14) ─────────

/** Selection range handed to {@link planCreateClipFromSelection}. */
export interface CreateClipFromSelectionPlanInput {
  /** Full RAW project transcript utterances, not just the source clip's own
   *  slice. Expanding to the minimum duration can reach words outside the
   *  source clip's current window. */
  rawUtterances: TranscriptUtterance[];
  sourceDurationSec: number | null;
  startSec: number;
  endSec: number;
}

export interface CreateClipFromSelectionPlan {
  startSec: number;
  endSec: number;
  durationSec: number;
  transcriptSlice: TranscriptUtterance[];
  title: string;
  hookText: string;
  hookStrengthScore: number;
  emotionalIntensityScore: number;
  storyCompletenessScore: number;
  pacingScore: number;
  durationOptimalityScore: number;
  viralityScore: number;
  tiktokScore: number;
  youtubeScore: number;
  instagramScore: number;
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Every word (or, for a word-timing-less utterance, the utterance itself)
 *  across the transcript, flattened and time-sorted — the unit
 *  `planCreateClipFromSelection` snaps/expands against. Mirrors
 *  `getSpeechTokens`'s utterance-level fallback in clip-timing.ts (not
 *  exported there), scoped per-utterance instead of all-or-nothing so a
 *  transcript mixing word-timed and un-timed utterances still snaps
 *  correctly. */
function collectSelectionTokens(
  utterances: TranscriptUtterance[],
): Array<{ startSec: number; endSec: number }> {
  return utterances
    .flatMap((u) =>
      u.words.length > 0
        ? u.words.map((w) => ({ startSec: w.startSec, endSec: w.endSec }))
        : [{ startSec: u.startSec, endSec: u.endSec }],
    )
    .filter((token) => token.endSec >= token.startSec)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

const CREATE_FROM_SELECTION_TITLE_WORD_COUNT = 8;

/** Title/hook for a manually-created clip: no LLM call for this atomic op
 *  (plan constraint #7 — the whole point is avoiding the duplicate+retrim
 *  chain's asset-orphaning risk, not adding a new external call), so both
 *  are derived straight from the selected text itself. */
function deriveTitleAndHookFromSlice(
  transcriptSlice: TranscriptUtterance[]): { title: string; hookText: string;
} {
  const fullText = transcriptSlice
    .map((u) => u.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!fullText) {
    return {
      title: "New clip",
      hookText: "Clip created from a transcript selection.",
    };
  }

  const words = fullText.split(/\s+/).filter(Boolean);
  let title = words.slice(0, CREATE_FROM_SELECTION_TITLE_WORD_COUNT).join(" ");
  if (words.length > CREATE_FROM_SELECTION_TITLE_WORD_COUNT) {
    title += "…";
  }
  if (title.length > CLIP_TITLE_MAX_LENGTH) {
    title = `${title.slice(0, CLIP_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
  }

  return { title, hookText: fullText };
}

/**
 * Fix (createClipFromSelection copies timeline-relative textLayers/sfx): a
 * `studioEdits.textLayers` overlay AND a `studioEdits.sfx[]` placement both
 * carry EDITED-TIMELINE seconds relative to the SOURCE clip's own window
 * (its startSec/endSec, minus its deletedRanges) — meaningless once
 * re-anchored to a brand-new clip's independently-computed window
 * (`planCreateClipFromSelection`'s startSec/endSec have no relationship to
 * the source's). Overlays/placements anchored to the wrong footage are
 * worse than none at all, so both are dropped (H3); every other studioEdits
 * field (transition/music/sourceAudio/logo/background/framing) is window-
 * independent styling and still copies over untouched.
 *
 * Pulled out as its own pure step (mirrors `deriveTitleAndHookFromSlice`
 * above) so it's unit-testable without a database — `createClipFromSelection`
 * below just calls it with the raw `Clip.studioEdits` JSON column value.
 */
export function planStudioEditsForClipFromSelection(
  sourceStudioEdits: unknown,
): StudioEdits | null {
  if (sourceStudioEdits === null || sourceStudioEdits === undefined) {
    return null;
  }
  return {
    ...studioEditsSchema.parse(sourceStudioEdits),
    textLayers: [],
    sfx: [],
  };
}

/**
 * Pure planning step for "Create clip" from a transcript selection
 * (vizard-parity.md Phase B step 14): the selection toolbar's alternative to
 * a duplicate+retrim chain, which this deliberately is NOT — chaining
 * `duplicateClip` (which copies render/proxy assets for the OLD window) with
 * a boundary update (which then deletes those assets once bounds move to the
 * selection's window) is a plan-forbidden pattern that can orphan copied
 * objects on partial failure (plan constraint #7). This computes a brand-new
 * clip's window and all of its duration-dependent state in one side-effect-
 * free step, so `createClipFromSelection` below only adds the guarded DB
 * write around a decision that's independently unit-testable.
 *
 * Snap/expand/clamp policy:
 * - The incoming [startSec, endSec) is snapped to the transcript words/
 *   tokens it overlaps (defensive: the client already sends word-exact
 *   bounds via transcript-selection.ts's `selectedWordsToSourceRange`, but
 *   this never trusts that blindly).
 * - Shorter than `CLIP_MIN_DURATION_SEC`: expanded a whole word at a time,
 *   alternating start/end, until it clears the floor — Vizard creates a clip
 *   from even a short selection instead of rejecting it outright.
 * - Longer than `CLIP_MAX_DURATION_SEC`: trimmed back from the end, one
 *   whole word at a time, down to the ceiling.
 * - Only rejected (`ClipActionError('clip_selection_invalid', …)`) when the
 *   transcript has no words/tokens at all, or the selection sits so close to
 *   the edge of the transcript that consuming every remaining word on both
 *   sides still can't reach the minimum duration.
 */
export function planCreateClipFromSelection(
  input: CreateClipFromSelectionPlanInput,
): CreateClipFromSelectionPlan {
  const sentenceUtterances = splitUtterancesIntoSentences(input.rawUtterances ?? [],
  );
  const tokens = collectSelectionTokens(sentenceUtterances);

  if (tokens.length === 0) {
    throw new ClipActionError(
      "clip_selection_invalid",
      "This project's transcript has no words to create a clip from.",
    );
  }

  const sourceDurationSec =
    typeof input.sourceDurationSec === "number" && input.sourceDurationSec > 0
      ? input.sourceDurationSec
      : Number.POSITIVE_INFINITY;

  const rawStart = Math.min(
    sourceDurationSec,
    Math.max(0, Math.min(input.startSec, input.endSec)),
  );
  const rawEnd = Math.min(
    sourceDurationSec,
    Math.max(rawStart, Math.max(input.startSec, input.endSec)),
  );

  const overlapping = tokens.filter(
    (token) => token.endSec > rawStart && token.startSec < rawEnd,
  );

  let startIndex: number;
  let endIndex: number;
  if (overlapping.length > 0) {
    startIndex = tokens.indexOf(overlapping[0]!);
    endIndex = tokens.indexOf(overlapping[overlapping.length - 1]!);
  } else {
    // The selection falls entirely inside a gap (no token overlaps it) —
    // anchor on the nearest token so the expansion below still has
    // something to grow from.
    let nearest = tokens.findIndex((token) => token.startSec >= rawStart);
    if (nearest === -1) nearest = tokens.length - 1;
    startIndex = nearest;
    endIndex = nearest;
  }

  let startSec = tokens[startIndex]!.startSec;
  let endSec = tokens[endIndex]!.endSec;

  // Expand symmetrically to the minimum duration, alternating sides so a
  // short selection grows evenly outward rather than eating only one edge.
  let growStart = true;
  while (
    endSec - startSec < CLIP_MIN_DURATION_SEC &&
    (startIndex > 0 || endIndex < tokens.length - 1)
  ) {
    if (growStart && startIndex > 0) {
      startIndex -= 1;
      startSec = tokens[startIndex]!.startSec;
    } else if (!growStart && endIndex < tokens.length - 1) {
      endIndex += 1;
      endSec = tokens[endIndex]!.endSec;
    } else if (startIndex > 0) {
      startIndex -= 1;
      startSec = tokens[startIndex]!.startSec;
    } else if (endIndex < tokens.length - 1) {
      endIndex += 1;
      endSec = tokens[endIndex]!.endSec;
    } else {
      break;
    }
    growStart = !growStart;
  }

  if (endSec - startSec < CLIP_MIN_DURATION_SEC) {
    throw new ClipActionError(
      "clip_selection_invalid",
      `This selection is too close to the edge of the transcript to reach the ${CLIP_MIN_DURATION_SEC}s minimum clip length.`,
    );
  }

  // Trim back from the end, one whole word at a time, if expansion (or an
  // already-long selection) overshot the ceiling.
  if (endSec - startSec > CLIP_MAX_DURATION_SEC) {
    const maxEnd = startSec + CLIP_MAX_DURATION_SEC;
    while (endIndex > startIndex && tokens[endIndex]!.endSec > maxEnd) {
      endIndex -= 1;
    }
    endSec = Math.max(tokens[endIndex]!.endSec, startSec + CLIP_MIN_DURATION_SEC,
    );
  }

  startSec = roundSec(Math.max(0, Math.min(startSec, sourceDurationSec)));
  endSec = roundSec(Math.max(startSec, Math.min(endSec, sourceDurationSec)));

  const transcriptSlice = buildTranscriptSliceForWindow(input.rawUtterances ?? [], {
    startSec,
    endSec,
  },
  );

  const durationSec = roundSec(endSec - startSec);
  const { title, hookText } = deriveTitleAndHookFromSlice(transcriptSlice);

  // No LLM call for this atomic op (see this function's doc comment) — hook
  // strength and emotional intensity have no signal to derive without one,
  // so both start at the schema's own neutral midpoint (matches
  // `storyCompletenessScore`'s Prisma column default). Pacing is the one
  // sub-score with real signal available for free: it's a pure function of
  // the actual selected words.
  const hookStrengthScore = 50;
  const emotionalIntensityScore = 50;
  const storyCompletenessScore = 50;
  const pacingScore = computePacingScore(transcriptSlice, durationSec);
  const durationOptimalityScore = computeDurationOptimality(durationSec);
  const viralityScore = computeViralityScore({
    hookStrength: hookStrengthScore,
    emotionalIntensity: emotionalIntensityScore,
    storyCompleteness: storyCompletenessScore,
    pacing: pacingScore,
    durationOptimality: durationOptimalityScore,
  });

  return {
    startSec,
    endSec,
    durationSec,
    transcriptSlice,
    title,
    hookText,
    hookStrengthScore,
    emotionalIntensityScore,
    storyCompletenessScore,
    pacingScore,
    durationOptimalityScore,
    viralityScore,
    tiktokScore: computePlatformScore(viralityScore, durationSec, "tiktok"),
    youtubeScore: computePlatformScore(viralityScore, durationSec, "youtube"),
    instagramScore: computePlatformScore(viralityScore, durationSec, "instagram",
    ),
  };
}

/**
 * System prompt for AI title suggestions.
 *
 * The language rule is stated here AND with the concrete language code in the
 * user prompt, on purpose. "Write in the same language as the clip's spoken
 * text" alone was not enough: given a ~400-character slice of an English
 * interview the model returned Spanish titles, one of them splicing in a
 * Devanagari word. Naming the language and forbidding translation outright is
 * what holds it.
 */
export const CLIP_TITLE_SYSTEM_PROMPT = [
  `You write short, scroll-stopping titles for vertical short-form video clips.`,
  `Return exactly ${CLIP_TITLE_SUGGESTION_COUNT} distinct options.`,
  `Each title: at most ${CLIP_TITLE_MAX_LENGTH} characters, no surrounding quotes, no emoji, no hashtags, no trailing period.`,
  `Never translate. Write every option in the source language named below, in that language's own script, and use exactly one language across all options.`,
  `Base every title on what is actually said — never invent claims, numbers, or names that do not appear in the text.`,
  `Keep names, products, numbers, and quoted phrases exactly as they appear in the text.`,
  `Vary the angle across the options (e.g. one curiosity-led, one direct//informative, one specific-detail-led). Do not restate the existing title.`,
].join(" ");

/**
 * Builds the per-clip user prompt. Exported so the language line can be asserted
 * directly — the drift bug above was precisely a missing input, not bad wording,
 * and a test that the code reaches the prompt is what catches that class of
 * regression.
 */
export function buildClipTitleUserPrompt(input: {
  languageCode: string | null;
  category: string;
  title: string | null;
  hookText: string;
  payoffText: string | null;
  spokenText: string;
}): string {
  return [
    `Source language: ${
      input.languageCode
        ? `provider language code ${input.languageCode} — write all ${CLIP_TITLE_SUGGESTION_COUNT} titles in this language`
        : "unknown; infer it from the spoken text below and use that one language for every option"
    }`,
    `Clip category: ${input.category}`,
    input.title ? `Current title: ${input.title}` : null,
    `Hook: ${input.hookText}`,
    input.payoffText ? `Payoff: ${input.payoffText}` : null,
    `Spoken text: ${input.spokenText || input.hookText}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Pulls the text out of an OpenAI Responses API payload, which returns either
 *  a flattened `output_text` or the structured `output[].content[].text` form.
 *  Mirrors the same helper in content-suite.service.ts. */
function extractOpenAiResponseText(payload: unknown): string | null {
  const response = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  };
  if (typeof response.output_text === "string") return response.output_text;
  const parts =
    response.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string") ?? [];
  return parts.length > 0 ? parts.join("") : null;
}

/** Every storage-key-bearing field hanging off one clip. Mirrors
 *  ProjectStorageSnapshot's role for whole-project deletion. */
export interface ClipStorageSnapshot {
  previewStorageKey: string | null;
  renderStorageKeys: Array<string | null>;
  dubStorageKeys: Array<string | null>;
}

/**
 * Collects every object a clip owns into one deduped delete list.
 *
 * Split out and exported so the set can be asserted directly: missing a field
 * here leaks paid storage forever, and duplicating one turns an ordinary delete
 * into a redundant round trip. Nulls are expected throughout — an unrendered
 * clip has no render key, an un-dubbed one no dub keys.
 */
export function planClipStorageDeletion(
  snapshot: ClipStorageSnapshot,
): string[] {
  return [
    ...new Set(
      [
        ...snapshot.renderStorageKeys,
        ...snapshot.dubStorageKeys,
        snapshot.previewStorageKey,
        // The peaks sidecar (see clip-preview-storage.ts) lives at a derived
        // key alongside the preview mp4 and isn't tracked by its own column —
        // without this it would leak forever whenever a clip/project is
        // deleted.
        tryDerivePeaksStorageKey(snapshot.previewStorageKey),
      ].filter((key): key is string => Boolean(key)),
    ),
  ];
}

export interface ClipDeletionRow {
  hasActivePublication: boolean;
  storage: ClipStorageSnapshot;
}

export interface ClipDeletionDeps {
  getClipRow(): Promise<ClipDeletionRow | null>;
  deleteObject(key: string): Promise<unknown>;
  isMissingObjectError(error: unknown): boolean;
  deleteClipRow(): Promise<{ count: number }>;
}

export type ClipDeletionOutcome =
  | { kind: "not_found" }
  | { kind: "active_publication" }
  | { kind: "storage_incomplete"; failedObjectCount: number }
  | { kind: "deleted" }
  | { kind: "already_deleted" };

export interface ClipDeletionAdapter {
  getClipRow(input: {
    userId: string;
    projectId: string;
    clipId: string;
  }): Promise<ClipDeletionRow | null>;
  deleteObject(key: string): Promise<unknown>;
  isMissingObjectError(error: unknown): boolean;
  deleteClipRow(input: {
    userId: string;
    projectId: string;
    clipId: string;
  }): Promise<{ count: number }>;
}

export async function runClipDeletion(
  deps: ClipDeletionDeps,
): Promise<ClipDeletionOutcome> {
  const row = await deps.getClipRow();
  if (!row) return { kind: "not_found" };
  if (row.hasActivePublication) return { kind: "active_publication" };

  const keys = planClipStorageDeletion(row.storage);
  const results = await Promise.allSettled(keys.map((key) => deps.deleteObject(key)));
  const failedObjectCount = results.filter(
    (result) =>
      result.status === "rejected" && !deps.isMissingObjectError(result.reason),
  ).length;
  if (failedObjectCount > 0) {
    return { kind: "storage_incomplete", failedObjectCount };
  }

  const deleted = await deps.deleteClipRow();
  return deleted.count === 1 ? { kind: "deleted" } : { kind: "already_deleted" };
}

/**
 * Destination key for a duplicated clip's render — the same
 * `projects/{projectId}/renders/{clipId}/{slug}.mp4` shape the worker writes,
 * with the NEW clip's id. Deterministic per (clip, aspect ratio), which is safe
 * precisely because the clip id differs from the source's.
 */
export function clipDuplicateRenderStorageKey(
  projectId: string,
  newClipId: string,
  aspectRatio: ClipAspectRatio,
): string {
  const slug =
    clipAspectRatioOptions.find((option) => option.value === aspectRatio)
      ?.slug ?? "9x16";
  return `projects/${projectId}/renders/${newClipId}/${slug}.mp4`;
}

/**
 * Destination key for a duplicated clip's preview proxy. Attempt-scoped like
 * the worker's own preview uploads (`clipPreviewAttemptStorageKey`): nothing
 * re-derives a preview key from (projectId, clipId), every reader uses the
 * persisted `previewStorageKey` column.
 */
export function clipDuplicatePreviewStorageKey(
  projectId: string,
  newClipId: string,
  attemptId: string,
): string {
  return `projects/${projectId}/previews/${newClipId}/${attemptId}.mp4`;
}

export interface ClipDuplicationStorageAdapter {
  copy(input: { sourceKey: string; destinationKey: string }): Promise<void>;
}

export class ClipService {
  constructor(
    private readonly options: {
      clipDeletionAdapter?: ClipDeletionAdapter;
      clipDuplicationStorageAdapter?: ClipDuplicationStorageAdapter;
    } = {},
  ) {}

  async getClipSnapshot(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<ClipSnapshot> {
    const clip = await requirePrisma().clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      include: {
        project: { select: { sourceDurationSeconds: true } },
        renders: true,
      },
    });
    if (!clip) throw new ClipActionError("clip_not_found", "Clip not found");
    return toClipSnapshot(clip);
  }

  async persistDetectedClips(
    projectId: string,
    workflowRunId: string,
    clips: DetectedClip[],
    llmMeta: LlmMeta,
    contentPack?: ContentPack | null,
  ) {
    const prisma = requirePrisma();
    const attempt = currentWorkflowAttempt(workflowRunId);
    const lifecycle = attempt ? getWorkflowRunLifecycle() : null;
    if (attempt) await lifecycle?.assertOwnership(attempt);
    else requireProtocolV1WorkflowContext("moment_detection", workflowRunId);
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { brandSnapshot: true, sourceDurationSeconds: true },
    });

    let templateCaptionPreset: CaptionPreset | null = null;
    const snapshotRaw = project?.brandSnapshot;
    if (snapshotRaw && typeof snapshotRaw === "object" && !Array.isArray(snapshotRaw)) {
      const snap = snapshotRaw as Record<string, unknown>;
      if (snap.captionPreset && typeof snap.captionPreset === "object") {
        templateCaptionPreset = captionPresetSchema.parse(snap.captionPreset);
      }
    }
    const resolvedCaptionPreset = resolveClipCaptionPresetForContentPack(
      contentPack?.captionPreset,
      templateCaptionPreset,
    );

    const detectedClipRows = clips.map((clip, i) => {
		const editorDocument = encodeClipEditorDocumentForStorage(
			{
				version: EDITOR_DOCUMENT_VERSION,
				clipStartSec: clip.startSec,
				clipEndSec: clip.endSec,
          captionPreset: resolvedCaptionPreset ?? DEFAULT_CAPTION_PRESET,
          transcriptSlice: clip.transcriptSlice,
          studioEdits: studioEditsSchema.parse(undefined),
				brollUrl: null,
				deletedRanges: [],
				sceneBlocks: [],
				censorSegments: [],
				mediaMotions: [],
			},
        project?.sourceDurationSeconds ?? null,
      );
      return {
            projectId,
            workflowRunId,
            index: i,
            ...editorDocument,
            title: clip.title,
            hookText: clip.hookText,
            payoffText: clip.payoffText,
            reasoning: clip.reasoning,
            category: clip.category,
            platformFit: clip.platformFit,
            brollCues:
              clip.brollCues && clip.brollCues.length > 0
                ? (clip.brollCues as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            viralityScore: clip.viralityScore,
            hookStrengthScore: clip.hookStrengthScore,
            emotionalIntensityScore: clip.emotionalIntensityScore,
            storyCompletenessScore: clip.storyCompletenessScore,
            pacingScore: clip.pacingScore,
            durationOptimalityScore: clip.durationOptimalityScore,
            tiktokScore: clip.tiktokScore,
            youtubeScore: clip.youtubeScore,
            instagramScore: clip.instagramScore,
            llmProvider: llmMeta.provider,
            llmModel: llmMeta.model,
            llmTokensUsed: llmMeta.totalTokensUsed,
          };
    }) satisfies Prisma.ClipCreateManyInput[];
    if (attempt && lifecycle) {
      await lifecycle.replaceDetectedClips(attempt, detectedClipRows);
    } else {
      await prisma.$transaction(async (tx) => {
        await admitRetiredClipMediaCleanup(
          tx,
          "detected_clip_replacement",
          projectId,
        );
        await tx.clip.deleteMany({ where: { projectId } });
        if (detectedClipRows.length > 0) {
          await tx.clip.createMany({ data: detectedClipRows });
        }
      });
    }
  }

  async listClips(userId: string, projectId: string): Promise<ClipSnapshot[]> {
    const prisma = requirePrisma();

    const clips = await prisma.clip.findMany({
      where: {
        projectId,
        project: { userId },
      },
      include: {
        project: { select: { sourceDurationSeconds: true } },
        renders: true,
      },
      orderBy: { viralityScore: "desc" },
    });

    return clips.map(toClipSnapshot);
  }

  /**
   * Renames a clip. Purely cosmetic: the title is display chrome (row header,
   * studio top bar, social caption seed) and is never burned into a render, so
   * unlike boundaries/studio-edits/transcript changes this does NOT invalidate
   * completed renders or move the clip to `edited`.
   */
  async updateClipTitle(
    userId: string,
    projectId: string,
    clipId: string,
    title: string,
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: { id: true },
    });

    if (!clip) {
      throw new ClipActionError("clip_not_found", "clip not found");
    }

    const updated = await prisma.clip.update({
      where: { id: clipId },
      data: { title },
      include: {
        project: { select: { sourceDurationSeconds: true } },
        renders: true,
      },
    });

    return toClipSnapshot(updated);
  }

  /**
   * Asks the LLM for alternative titles for one clip, and returns them without
   * writing anything — the caller picks one and PATCHes it back as an ordinary
   * rename. Kept read-only on purpose: a one-click "rewrite my title" that
   * silently replaces the current one has no undo, and the picker is what the
   * product actually wants.
   *
   * Prompted from the clip's own transcript slice (not the whole transcript),
   * which is what makes this cheap enough to run per-clip on demand.
   */
  async suggestClipTitles(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<string[]> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: {
        title: true,
        hookText: true,
        payoffText: true,
        category: true,
        startSec: true,
        endSec: true,
        transcriptSlice: true,
        captionPreset: true,
        studioEdits: true,
        brollUrl: true,
        deletedRanges: true,
        editorDocumentVersion: true,
        sceneBlocks: true,
        censorSegments: true,
        mediaMotions: true,
        // The transcript's detected language, stated verbatim in the prompt.
        // Without it the model infers a language from a ~400-character slice and
        // drifts: an English NVIDIA interview came back with Spanish titles, one
        // of them splicing in a Devanagari word. Same source of truth the
        // content suite already uses for exactly this reason.
        project: {
          select: {
            sourceDurationSeconds: true,
            transcript: { select: { languageCode: true } },
          },
        },
      },
    });

    if (!clip) {
      throw new ClipActionError("clip_not_found", "clip not found");
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // Distinct from clip_title_suggestion_failed: nothing the user does will
      // fix a missing key, so the copy must not invite a retry.
      throw new ClipActionError(
        "openai_not_configured",
        "OPENAI_API_KEY is not configured",
      );
    }

    const utterances = decodeClipEditorDocumentFromStorage(
      clip,
      clip.project.sourceDurationSeconds,
    ).transcriptSlice;
    // Bounded so a long clip can't blow up the prompt — the opening lines carry
    // the hook, which is what a title has to land.
    const spokenText = utterances
      .map((utterance) => utterance.text)
      .join(" ")
      .slice(0, 4000);

    const languageCode = clip.project?.transcript?.languageCode ?? null;

    const model =
      process.env.OPENAI_CONTENT_MODEL ??
      process.env.OPENAI_CLIP_MODEL ??
      "gpt-5.4-mini";

    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: "system",
              content: CLIP_TITLE_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: buildClipTitleUserPrompt({
                languageCode,
                category: clip.category,
                title: clip.title,
                hookText: clip.hookText,
                payoffText: clip.payoffText,
                spokenText,
              }),
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "clip_titles",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  titles: {
                    type: "array",
                    minItems: CLIP_TITLE_SUGGESTION_COUNT,
                    maxItems: CLIP_TITLE_SUGGESTION_COUNT,
                    items: { type: "string", minLength: 1 },
                  },
                },
                required: ["titles"],
              },
            },
          },
        }),
      });
    } catch (error) {
      throw new ClipActionError(
        "clip_title_suggestion_failed",
        error instanceof Error ? error.message : "OpenAI request failed",
      );
    }

    const payload = (await response.json().catch(() => null)) as { error?: { message?: string };
    }
      | null;

    if (!response.ok || !payload) {
      throw new ClipActionError(
        "clip_title_suggestion_failed",
        payload?.error?.message ??
          `OpenAI request failed with status ${response.status}`,
      );
    }

    const content = extractOpenAiResponseText(payload);
    if (!content) {
      throw new ClipActionError(
        "clip_title_suggestion_failed",
        "Empty response from OpenAI",
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      throw new ClipActionError(
        "clip_title_suggestion_failed",
        "Model returned invalid JSON",
      );
    }

    const parsed = clipTitleSuggestionsLlmResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new ClipActionError(
        "clip_title_suggestion_failed",
        "Model output did not match the expected shape",
      );
    }

    // De-duplicate case-insensitively: three options are only useful if they're
    // three actual choices, and the current title reappearing is noise.
    const seen = new Set<string>(
      clip.title ? [clip.title.trim().toLowerCase()] : [],
    );
    const titles: string[] = [];
    for (const title of parsed.data.titles) {
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      titles.push(title);
    }

    if (titles.length === 0) {
      throw new ClipActionError(
        "clip_title_suggestion_failed",
        "Model returned no usable titles",
      );
    }

    return titles;
  }

  /**
   * Duplicates one clip, including its finished video, without re-rendering.
   *
   * Every completed render and the preview proxy are copied server-side inside
   * R2 (`copyObject`) to keys derived from the NEW clip id, so the copy is
   * playable and downloadable as soon as this returns — no worker job, no render
   * capacity consumed. Two rows must never share a storage key: delete (below)
   * and the project deletion planner both delete objects by key, so a shared key
   * would leave the surviving clip pointing at nothing.
   *
   * Measured end-to-end at ~3s for a 7.7 MB render plus its proxy (~1.5s of that
   * is R2, the rest Postgres round trips) — fast enough to hold a spinner on the
   * menu item, not fast enough to feel instantaneous. Copying is concurrent, so
   * more aspect ratios cost roughly the largest one rather than their sum.
   *
   * `index` is taken as max+1 within the source clip's workflow run to satisfy
   * `@@unique([projectId, workflowRunId, index])`. Everything user-authored
   * comes across (title, boundaries, transcript slice, caption preset, studio
   * edits, B-roll); dubs and social posts do not — those are per-destination
   * artefacts, not part of the clip.
   *
   * A copy whose objects fail to copy is still returned, minus the affected
   * variants: the row is the thing being duplicated, and a missing render is a
   * state the UI already renders (the format pill falls back to "Render").
   */
  async duplicateClip(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();

    const source = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      include: {
        project: { select: { sourceDurationSeconds: true } },
        renders: { where: { exportVariantId: null } },
      },
    });

    if (!source) {
      throw new ClipActionError("clip_not_found", "clip not found");
    }
    const sourceDocument = decodeClipEditorDocumentFromStorage(
      source,
      source.project.sourceDurationSeconds,
    );
    const duplicateDocument = encodeClipEditorDocumentForStorage(
      sourceDocument,
      source.project.sourceDurationSeconds,
    );

    const newClipId = randomUUID();

    // Copy the bytes BEFORE inserting the row, so a copy failure can't leave a
    // row pointing at a key that was never written. Renders that fail to copy
    // are simply left out of the new clip.
    const completedRenders = source.renders.filter(
      (render) => render.status === "completed" && render.storageKey,
    );

    // All copies run concurrently. They target distinct keys, so R2's ~1
    // write/second/key limit doesn't apply across them, and copy latency is
    // dominated by object size rather than by this process — measured on a
    // 7.7 MB render plus a 1.0 MB proxy, serialising them cost 2.5s against
    // 1.5s in parallel, and a clip rendered in all four aspect ratios would
    // have serialised five copies deep.
    const renderCopies = completedRenders.map((render) => {
      const aspectRatio =
        clipAspectRatioFromDb[clipAspectRatioDbSchema.parse(render.aspectRatio)];
      return {
        render,
        aspectRatio,
        destinationKey: clipDuplicateRenderStorageKey(
          projectId,
          newClipId,
          aspectRatio,
        ),
      };
    });
    const previewDestinationKey = source.previewStorageKey
      ? clipDuplicatePreviewStorageKey(projectId, newClipId, randomUUID())
      : null;
    const compensationClaimId = randomUUID();
    const duplicationStorage = this.options.clipDuplicationStorageAdapter;
    type DuplicateCopyValue =
      | { kind: "render"; render: ClipRender; aspectRatio: ClipAspectRatio }
      | { kind: "preview" };
    const copyPlans: DurableMediaCopyPlan<DuplicateCopyValue>[] = [
      ...renderCopies.map((copy) => ({
        origin: "clip_duplicate_compensation" as const,
        cleanupClass: "mutable_render" as const,
        projectId,
        clipId: newClipId,
        objectKey: copy.destinationKey,
        sourceKey: copy.render.storageKey as string,
        value: {
          kind: "render" as const,
          render: copy.render,
          aspectRatio: copy.aspectRatio,
        },
      })),
      ...(previewDestinationKey && source.previewStorageKey
        ? [
            {
              origin: "clip_duplicate_compensation" as const,
              cleanupClass: "preview_proxy" as const,
              projectId,
              clipId: newClipId,
              objectKey: previewDestinationKey,
              sourceKey: source.previewStorageKey,
              value: { kind: "preview" as const },
            },
          ]
        : []),
    ];

    try {
      const created: { id: string } = await runDurableMediaCopies({
        store: prisma.mediaCleanupObligation,
        plans: copyPlans,
        claimId: compensationClaimId,
        claimExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        leaseMs: 15 * 60 * 1000,
        heartbeatMs: 5 * 60 * 1000,
        async renew({ plans, claimId, now, claimExpiresAt }) {
          const renewed = await prisma.mediaCleanupObligation.updateMany({
            where: {
              claimId,
              claimExpiresAt: { gt: now },
              completedAt: null,
              OR: plans.map((plan) => ({
                origin: plan.origin,
                cleanupClass: plan.cleanupClass,
                objectKey: plan.objectKey,
              })),
            },
            data: { claimExpiresAt },
          });
          return renewed.count === plans.length;
        },
        async copy({ sourceKey, objectKey }) {
          if (duplicationStorage) {
            await duplicationStorage.copy({
              sourceKey,
              destinationKey: objectKey,
            });
          } else {
            await copyObject({ sourceKey, destinationKey: objectKey });
          }
        },
        onCopyFailure(plan) {
          console.warn(
            JSON.stringify({
              level: "warn",
              message:
                plan.value.kind === "render"
                  ? "clip_duplicate_render_copy_failed"
                  : "clip_duplicate_preview_copy_failed",
              clipId,
              newClipId,
              ...(plan.value.kind === "render"
                ? { aspectRatio: plan.value.aspectRatio }
                : {}),
              failureCode: "storage_copy_failed",
            }),
          );
        },
        onReleaseFailure() {
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "clip_duplicate_compensation_release_failed",
              clipId,
              newClipId,
            }),
          );
        },
        onAdoptionOutcome(outcome, context) {
          console.warn(
            JSON.stringify({
              level: outcome === "succeeded" ? "info" : "warn",
              message: "clip_duplicate_adoption_outcome",
              clipId,
              newClipId,
              outcome,
              ...context,
            }),
          );
        },
        onCompensationOutcome(outcome, context) {
          console.warn(
            JSON.stringify({
              level: outcome === "released" ? "info" : "warn",
              message: "clip_duplicate_compensation_outcome",
              clipId,
              newClipId,
              outcome,
              ...context,
            }),
          );
        },
        async release(objectKeys, claimId) {
          const released = await prisma.mediaCleanupObligation.updateMany({
            where: {
              origin: "clip_duplicate_compensation",
              objectKey: { in: [...objectKeys] },
              claimId,
              completedAt: null,
            },
            data: {
              claimId: null,
              claimExpiresAt: null,
              nextAttemptAt: new Date(),
              failureCode: "duplicate_compensation_released",
            },
          });
          return released.count;
        },
        async adopt(copied, claimId, fencedAt) {
          const copiedRenders = copied.flatMap((plan) =>
            plan.value.kind === "render"
              ? [{ render: plan.value.render, destinationKey: plan.objectKey }]
              : [],
          );
          const previewStorageKey =
            copied.find((plan) => plan.value.kind === "preview")?.objectKey ??
            null;
          return prisma.$transaction(async (tx) => {
            await adoptDurableMediaCopies(
              tx.mediaCleanupObligation,
              copied,
              claimId,
              fencedAt,
            );
            const highest = await tx.clip.aggregate({
              where: { projectId, workflowRunId: source.workflowRunId },
              _max: { index: true },
            });

            const clip = await tx.clip.create({
              data: {
                id: newClipId,
                projectId,
                workflowRunId: source.workflowRunId,
                index: (highest._max.index ?? source.index) + 1,
                status: "detected",
                ...duplicateDocument,
                title: source.title,
                hookText: source.hookText,
                payoffText: source.payoffText,
                reasoning: source.reasoning,
                category: source.category,
                platformFit: source.platformFit,
                brollCues:
                  source.brollCues === null
                    ? Prisma.JsonNull
                    : (source.brollCues as Prisma.InputJsonValue),
                previewStorageKey,
                previewStartSec: previewStorageKey
                  ? source.previewStartSec
                  : null,
                previewDurationSec: previewStorageKey
                  ? source.previewDurationSec
                  : null,
                viralityScore: source.viralityScore,
                hookStrengthScore: source.hookStrengthScore,
                emotionalIntensityScore: source.emotionalIntensityScore,
                storyCompletenessScore: source.storyCompletenessScore,
                pacingScore: source.pacingScore,
                durationOptimalityScore: source.durationOptimalityScore,
                tiktokScore: source.tiktokScore,
                youtubeScore: source.youtubeScore,
                instagramScore: source.instagramScore,
                llmProvider: source.llmProvider,
                llmModel: source.llmModel,
                llmTokensUsed: source.llmTokensUsed,
              },
            });

            if (copiedRenders.length > 0) {
              await tx.clipRender.createMany({
                data: copiedRenders.map(({ render, destinationKey }) => ({
                  clipId: clip.id,
                  aspectRatio: render.aspectRatio,
                  status: render.status,
                  storageKey: destinationKey,
                  sizeBytes: render.sizeBytes,
                  durationSec: render.durationSec,
                  startedAt: render.startedAt,
                  completedAt: render.completedAt,
                  resolution: render.resolution,
                })),
              });
            }

            return clip;
          });
        },
      });

      // Read the snapshot back OUTSIDE the transaction. The row is committed by
      // now, and against a remote Postgres this read costs a full round trip —
      // holding a transaction (and its pooled connection) open across it buys
      // nothing.
      const snapshot = await prisma.clip.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          project: { select: { sourceDurationSeconds: true } },
          renders: true,
        },
      });

      return toClipSnapshot(snapshot);
    } catch (error) {
      // Planned destinations are admitted before copying. If persistence fails,
      // releasing the hold makes every successful or ambiguous copy recoverable
      // without relying on this process to finish a best-effort delete.
      throw new ClipActionError(
        "clip_duplicate_failed",
        error instanceof Error ? error.message : "clip duplicate failed",
      );
    }
  }

  /**
   * Create clip from selection (vizard-parity.md Phase B step 14): a NEW,
   * from-scratch clip carved out of an arbitrary transcript-panel.tsx
   * selection — the selection toolbar's "Create clip" action. Deliberately
   * NOT `duplicateClip` (above) followed by a boundary update: that chain
   * copies render/proxy assets for the OLD window and then deletes them once
   * the boundaries move to the selection's window, which can orphan copied
   * objects if the process dies between the two steps (plan constraint #7).
   * This never copies renders or the preview proxy at all — the new clip
   * gets neither, and the worker's preview-backfill poll
   * (`getClipsNeedingPreview` / `processPendingClipPreviews` in
   * apps/worker/src/tasks/clip-preview.ts) picks it up for a proxy on its
   * own the same way every other proxy-less clip does; there is no separate
   * trigger to fire from here.
   *
   * `captionPreset`/`studioEdits`/`brollUrl`/`platformFit` ARE copied from the
   * source clip (Vizard: the new clip inherits the source's "look"), EXCEPT
   * `studioEdits.textLayers` and `studioEdits.sfx` (H3) — both carry
   * edited-timeline seconds relative to the SOURCE clip's own window,
   * meaningless once re-anchored to this clip's independently-computed
   * window, so they're dropped rather than copied wrong. Everything else —
   * boundaries, transcript slice, title/hook,
   * duration-dependent scores — comes straight from
   * `planCreateClipFromSelection`, which also owns the snap/expand/clamp/
   * reject policy (see its own doc comment).
   *
   * Known limitation: `planCreateClipFromSelection` builds the new slice from
   * the RAW project transcript (`rawUtterances` below), so any word-level
   * corrections made on the SOURCE clip are lost in the new one. The studio
   * client is gaining a `mergeCorrectedWordsIntoWindow` helper (packages/
   * validators) for commitTrim's equivalent problem — a follow-up should
   * reuse it here once available.
   */
  async createClipFromSelection(
    userId: string,
    projectId: string,
    sourceClipId: string,
    input: { startSec: number; endSec: number },
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();

    const [source, project] = await Promise.all([
      prisma.clip.findFirst({
        where: { id: sourceClipId, projectId, project: { userId } },
        select: {
          index: true,
          workflowRunId: true,
          startSec: true,
          endSec: true,
          captionPreset: true,
          transcriptSlice: true,
          studioEdits: true,
          brollUrl: true,
          deletedRanges: true,
          editorDocumentVersion: true,
          sceneBlocks: true,
          censorSegments: true,
          mediaMotions: true,
          platformFit: true,
        },
      }),
      prisma.project.findFirst({
        where: { id: projectId, userId },
        select: {
          sourceDurationSeconds: true,
          transcript: { select: { utterancesJson: true } },
        },
      }),
    ]);

    if (!source) {
      throw new ClipActionError("clip_not_found", "clip not found");
    }
    if (!project) {
      throw new ClipActionError("clip_not_found", "project not found");
    }

    const sourceDocument = decodeClipEditorDocumentFromStorage(
      source,
      project.sourceDurationSeconds,
    );

    const rawUtterances =
      (project.transcript?.utterancesJson as TranscriptUtterance[] | null) ?? [];

    const plan = planCreateClipFromSelection({
      rawUtterances,
      sourceDurationSec: project.sourceDurationSeconds,
      startSec: input.startSec,
      endSec: input.endSec,
    });

    const studioEditsForNewClip = planStudioEditsForClipFromSelection(
      sourceDocument.studioEdits,
    );
	const selectionDocument = encodeClipEditorDocumentForStorage(
		{
			version: EDITOR_DOCUMENT_VERSION,
			clipStartSec: plan.startSec,
        clipEndSec: plan.endSec,
        captionPreset: sourceDocument.captionPreset,
        transcriptSlice: plan.transcriptSlice,
        studioEdits: studioEditsForNewClip ?? studioEditsSchema.parse(undefined),
			brollUrl: sourceDocument.brollUrl,
			deletedRanges: [],
			sceneBlocks: [],
			censorSegments: [],
			mediaMotions: [],
		},
      project.sourceDurationSeconds,
    );

    const newClipId = randomUUID();

    try {
      const created = await prisma.$transaction(async (tx) => {
        const highest = await tx.clip.aggregate({
          where: { projectId, workflowRunId: source.workflowRunId },
          _max: { index: true },
        });

        return tx.clip.create({
          data: {
            id: newClipId,
            projectId,
            workflowRunId: source.workflowRunId,
            index: (highest._max.index ?? source.index) + 1,
            status: "edited",
            ...selectionDocument,
            title: plan.title,
            hookText: plan.hookText,
            payoffText: null,
            reasoning: "Created from a transcript selection in the studio.",
            category: "quote",
            // Vizard-parity: a duplicate/derived clip keeps the source's
            // platform targeting (duplicateClip does the same).
            platformFit: source.platformFit,
            // Fresh clip: no renders, no preview proxy, no B-roll cues, no
            // editor history — see this method's doc comment for why nothing
            // is copied from the source's rendered assets. deletedRanges /
            // editorRevision / editorOriginal are left unset, taking their
            // Prisma column defaults (null / 0 / null) — exactly the "empty
            // history" state the plan calls for.
            viralityScore: plan.viralityScore,
            hookStrengthScore: plan.hookStrengthScore,
            emotionalIntensityScore: plan.emotionalIntensityScore,
            storyCompletenessScore: plan.storyCompletenessScore,
            pacingScore: plan.pacingScore,
            durationOptimalityScore: plan.durationOptimalityScore,
            tiktokScore: plan.tiktokScore,
            youtubeScore: plan.youtubeScore,
            instagramScore: plan.instagramScore,
            llmProvider: "manual",
            llmModel: "transcript-selection",
            llmTokensUsed: null,
          },
        });
      });

      // Read the snapshot back OUTSIDE the transaction — same rationale as
      // duplicateClip above (a remote-Postgres round trip that doesn't need
      // to hold the transaction's pooled connection open).
      const snapshot = await prisma.clip.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          project: { select: { sourceDurationSeconds: true } },
          renders: true,
        },
      });

      return toClipSnapshot(snapshot);
    } catch (error) {
      if (error instanceof ClipActionError) throw error;
      throw new ClipActionError(
        "clip_create_from_selection_failed",
        error instanceof Error
          ? error.message
          : "clip create from selection failed",
      );
    }
  }

  /**
   * Permanently deletes one clip: its renders, preview proxy, and dub assets
   * come out of R2 first, then the row (ClipRender/ClipDub cascade with it).
   *
   * Refuses while the clip has social posts that are scheduled or mid-publish.
   * `SocialPost.clipId` is `onDelete: SetNull`, so deleting anyway wouldn't
   * cascade — it would leave a queued post whose clip and rendered asset are
   * gone, which the publisher can only fail on. Cancel the posts first.
   *
   * Analytics events also SetNull, deliberately: past performance for a clip
   * that used to exist is still true, and shouldn't vanish from project totals.
   */
  async deleteClip(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<void> {
    const context = { userId, projectId, clipId };
    const adapter: ClipDeletionAdapter =
      this.options.clipDeletionAdapter ??
      (() => {
        const prisma = requirePrisma();
        return {
          async getClipRow(input) {
            const clip = await prisma.clip.findFirst({
              where: {
                id: input.clipId,
                projectId: input.projectId,
                project: { userId: input.userId },
              },
              select: {
                previewStorageKey: true,
                renders: { select: { storageKey: true } },
                dubs: {
                  select: { audioStorageKey: true, renderStorageKey: true },
                },
                socialPosts: {
                  where: { status: { in: ["scheduled", "publishing"] } },
                  select: { id: true },
                },
              },
            });
            if (!clip) return null;
            return {
              hasActivePublication: clip.socialPosts.length > 0,
              storage: {
                previewStorageKey: clip.previewStorageKey,
                renderStorageKeys: clip.renders.map(
                  (render) => render.storageKey,
                ),
                dubStorageKeys: clip.dubs.flatMap((dub) => [
                  dub.audioStorageKey,
                  dub.renderStorageKey,
                ]),
              },
            };
          },
          deleteObject,
          isMissingObjectError: (error) =>
            classifyR2StorageError(error) === "storage_object_missing",
          async deleteClipRow(input) {
            try {
              return await prisma.clip.deleteMany({
                where: {
                  id: input.clipId,
                  projectId: input.projectId,
                  project: { userId: input.userId },
                },
              });
            } catch {
              throw new ClipActionError(
                "clip_delete_failed",
                "clip delete failed",
              );
            }
          }
        };
      })();

    const outcome = await runClipDeletion({
      getClipRow: () => adapter.getClipRow(context),
      deleteObject: (key) => adapter.deleteObject(key),
      isMissingObjectError: (error) => adapter.isMissingObjectError(error),
      deleteClipRow: () => adapter.deleteClipRow(context),
    });

    if (outcome.kind === "not_found") {
      throw new ClipActionError("clip_not_found", "clip not found");
    }
    if (outcome.kind === "active_publication") {
      throw new ClipActionError(
        "clip_has_scheduled_posts",
        "clip has scheduled or publishing social posts",
      );
    }
    if (outcome.kind === "storage_incomplete") {
      throw new ClipActionError(
        "clip_storage_delete_incomplete",
        "clip storage deletion is incomplete",
      );
    }
  }

  async regenerateClips(
    projectId: string,
    idempotencyKey: string,
    contentPack: ContentPack | undefined,
    workspaceContext: { workspaceId: string; actorUserId: string },
  ) {
    const prisma = requirePrisma();
    await workspaceService.requireActor(
      workspaceContext.actorUserId,
      workspaceContext.workspaceId,
      "processing.consume",
    );
    const parsedContentPack = contentPack
      ? contentPackSchema.parse(contentPack)
      : null;

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        workspaceId: workspaceContext.workspaceId,
      },
      select: {
        id: true,
        transcript: { select: { status: true } },
      },
    });

    if (!project) {
      throw new Error("project not found");
    }

    if (project.transcript?.status !== "completed") {
      throw new Error("transcript is not ready");
    }

    // Enforce plan-tier quota + per-upload length cap on this path too (the
    // project-page "Detect / Regenerate Clips" buttons route through here).
    await projectService.assertProjectGenerationAllowed(
      projectId,
      workspaceContext.workspaceId,
    );

    const admitted = await getWorkflowRunLifecycle().admit({
      projectId,
      idempotencyKey,
      stage: "moment_detection",
      contentPack: parsedContentPack
        ? {
            outputTypes: parsedContentPack.outputTypes,
            clipGenerationMode: parsedContentPack.clipGenerationMode,
            clipCountTarget: parsedContentPack.clipCountTarget,
            clipDurationSecTarget: parsedContentPack.clipDurationSecTarget,
            minDurationSec: parsedContentPack.minDurationSec,
            preferredMinDurationSec: parsedContentPack.preferredMinDurationSec,
            preferredMaxDurationSec: parsedContentPack.preferredMaxDurationSec,
            maxDurationSec: parsedContentPack.maxDurationSec,
            platformTargets: parsedContentPack.platformTargets,
            autoRenderClips: parsedContentPack.autoRenderClips,
            toneConstraints: parsedContentPack.toneConstraints,
            captionPreset: parsedContentPack.captionPreset,
            platformPlaybookVersion: parsedContentPack.platformPlaybookVersion,
            mode: parsedContentPack.mode,
            autoHook: parsedContentPack.autoHook,
            specificMoments: parsedContentPack.specificMoments,
            processingStartSec: parsedContentPack.processingStartSec,
            processingEndSec: parsedContentPack.processingEndSec,
            clipLengthPreset: parsedContentPack.clipLengthPreset,
            defaultAspectRatio: parsedContentPack.defaultAspectRatio,
          }
        : undefined,
    });

    return {
      workflowRunId: admitted.id,
      acceptedAt: new Date().toISOString(),
      initialSeq: await getLastWorkflowSeq(projectId),
    };
  }

  async triggerClipRendering(
    projectId: string,
    idempotencyKey: string,
    workspaceContext: { workspaceId: string; actorUserId: string },
    clipIds?: string[],
    aspectRatios?: ClipAspectRatio[],
    resolution: ClipRenderResolution = "1080p",
  ) {
    const prisma = requirePrisma();
    await workspaceService.requireActor(
      workspaceContext.actorUserId,
      workspaceContext.workspaceId,
      "processing.consume",
    );
    const requestedAspectRatios = normalizeAspectRatios(aspectRatios);
    const requestedAspectRatioDbValues = requestedAspectRatios.map(
      (aspectRatio) => clipAspectRatioToDb[aspectRatio],
    );
    // Entitlement clamp (vizard-parity Phase C export options) — every row
    // this call creates or resets is stamped with the resolution the owner
    // is actually allowed, not the raw request.
    const resolvedResolution = await resolveRequestedResolution(
      resolution,
      workspaceContext.workspaceId,
    );

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        workspaceId: workspaceContext.workspaceId,
      },
      select: { id: true },
    });

    if (!project) {
      throw new Error("project not found");
    }

    const whereClause: Prisma.ClipWhereInput = clipIds
      ? { projectId, id: { in: clipIds } }
      : { projectId };

    const clipsToRender = await prisma.clip.findMany({
      where: whereClause,
      select: { id: true },
    });

    if (clipsToRender.length === 0) {
      throw new Error("no clips available for rendering");
    }

    const clipIdsToRender = clipsToRender.map((clip) => clip.id);
    const existingRenderVariants = await prisma.clipRender.findMany({
      where: {
        clipId: { in: clipIdsToRender },
        aspectRatio: { in: requestedAspectRatioDbValues },
        exportVariantId: null,
      },
      select: {
        id: true,
        clipId: true,
        aspectRatio: true,
        status: true,
      },
    });

    const existingRenderMap = new Map(
      existingRenderVariants.map((render) => [
        `${render.clipId}:${render.aspectRatio}`,
        render,
      ]),
    );

    const createOperations: Prisma.PrismaPromise<unknown>[] = [];
    const updateOperations: Prisma.PrismaPromise<unknown>[] = [];

    for (const clip of clipsToRender) {
      for (const aspectRatio of requestedAspectRatios) {
        const aspectRatioDb = clipAspectRatioToDb[aspectRatio];
        const key = `${clip.id}:${aspectRatioDb}`;
        const existingRender = existingRenderMap.get(key);

        if (!existingRender) {
          createOperations.push(
            prisma.clipRender.create({
              data: {
                clipId: clip.id,
                aspectRatio: aspectRatioDb,
                status: "pending",
                resolution: resolvedResolution,
              },
            }),
          );
          continue;
        }

        if (
          existingRender.status === "pending" ||
          existingRender.status === "rendering"
        ) {
          continue;
        }

        updateOperations.push(
          prisma.clipRender.update({
            where: { id: existingRender.id },
            data: getClipRenderResetData(resolvedResolution),
          }),
        );
      }
    }

    if (createOperations.length > 0 || updateOperations.length > 0) {
      await prisma.$transaction([...createOperations, ...updateOperations]);
    }

    const admitted = await getWorkflowRunLifecycle().admit({
      projectId,
      idempotencyKey,
      stage: "clip_rendering",
    });

    return {
      workflowRunId: admitted.id,
      acceptedAt: new Date().toISOString(),
      initialSeq: await getLastWorkflowSeq(projectId),
      clipCount: clipsToRender.length,
      variantCount: clipsToRender.length * requestedAspectRatios.length,
      resolution: resolvedResolution,
    };
  }

  /**
   * How much render work has ALREADY landed for a project — consulted by the
   * worker when a claimed clip_rendering run finds zero pending variants.
   * Live incident 2026-08-06: a run rendered every variant, then its
   * completion bookkeeping threw (expired transaction), the run requeued,
   * and the retry found nothing pending — `no_renderable_clips` is a listed
   * PERMANENT failure code, so a fully-successful render surfaced to the
   * user as "Something went wrong". A retry that finds completed variants
   * must complete the run instead of failing it; this summary is how it
   * tells that state apart from a genuinely-empty project.
   */
  async getCompletedClipRenderSummaryForProject(projectId: string) {
    const prisma = requirePrisma();
    const completed = await prisma.clipRender.findMany({
      where: {
        status: "completed",
        clip: { projectId, project: accessibleProjectWhere() },
      },
      select: { clipId: true },
    });
    return {
      completedVariantCount: completed.length,
      completedClipCount: new Set(completed.map((render) => render.clipId)).size,
    };
  }

  async getProjectRenderStorageReferences(projectId: string) {
    const prisma = requirePrisma();
    const [renders, exportVariants] = await Promise.all([
      prisma.clipRender.findMany({
        where: {
          storageKey: { not: null },
          clip: { projectId },
        },
        select: { storageKey: true },
      }),
      prisma.clipExportVariant.findMany({
        where: {
          storageKey: { not: null },
          export: { projectId },
        },
        select: { storageKey: true },
      }),
    ]);
    return new Set(
      [...renders, ...exportVariants].flatMap((row) =>
        row.storageKey ? [row.storageKey] : [],
      ),
    );
  }

  async getPendingClipRendersForProject(projectId: string) {
    const prisma = requirePrisma();
    const renders = await prisma.clipRender.findMany({
      where: {
        status: "pending",
        clip: { projectId, project: accessibleProjectWhere() },
      },
      include: {
        clip: true,
        exportVariant: { select: { exportId: true } },
      },
    });

    return sortPendingClipRenders(renders);
  }

  async getPendingClipRendersForWorkSet(
    projectId: string,
    workflowRunId: string,
  ) {
    const prisma = requirePrisma();
    const renders = await prisma.clipRender.findMany({
      where: {
        workflowRunId,
        status: "pending",
        clip: { projectId, project: accessibleProjectWhere() },
      },
      include: {
        clip: true,
        exportVariant: { select: { exportId: true, watermark: true } },
      },
    });
    return sortPendingClipRenders(renders);
  }

  /**
   * Loads every mutable input a clip-render attempt is allowed to observe in
   * one repeatable-read transaction. The worker must consume this value as an
   * immutable attempt-start snapshot instead of interleaving project and
   * render-row reads with source I/O.
   */
  async getFrozenRenderingStateForWorkSet(
    projectId: string,
    workflowRunId: string,
  ) {
    const prisma = requirePrisma();
    const snapshotAt = new Date();
    return prisma.$transaction(
      async (tx) => {
        const project = await tx.project.findFirst({
          where: { id: projectId, ...accessibleProjectWhere(snapshotAt) },
          select: {
            sourceStorageKey: true,
            sourceDurationSeconds: true,
            userId: true,
            workspaceId: true,
            brandSnapshot: true,
            workspace: { select: { pricingTier: true } },
          },
        });
        if (!project) return null;

        const pendingRenders = await tx.clipRender.findMany({
          where: {
            workflowRunId,
            status: "pending",
            clip: {
              projectId,
              project: accessibleProjectWhere(snapshotAt),
            },
          },
          include: {
            clip: true,
            exportVariant: { select: { exportId: true, watermark: true } },
          },
        });

        return {
          sourceStorageKey: project.sourceStorageKey,
          sourceDurationSeconds: project.sourceDurationSeconds,
          userId: project.userId,
          workspaceId: project.workspaceId,
          ownerTier: resolvePricingTier(project.workspace.pricingTier),
          brandSnapshot: {
            status: "available" as const,
            value: project.brandSnapshot,
          },
          pendingRenders: sortPendingClipRenders(pendingRenders),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async markClipRenderVariantRendering(clipRenderId: string) {
    const prisma = requirePrisma();
    const attempt = currentWorkflowAttempt();
    const lifecycle = attempt ? getWorkflowRunLifecycle() : null;
    if (attempt) await lifecycle?.assertOwnership(attempt);
    else requireProtocolV1WorkflowContext("clip_rendering");

    const render = await prisma.clipRender.findUnique({
      where: { id: clipRenderId },
      select: { exportVariantId: true },
    });

    const startedAt = new Date();
    const persisted =
      attempt && lifecycle
        ? await lifecycle.markClipRenderVariantRendering(attempt, {
            clipRenderId,
            exportVariantId: render?.exportVariantId ?? null,
            startedAt,
          })
        : await prisma.$transaction(async (tx) => {
            // updateMany: an editor save/reset can deleteMany this row while
            // the encode is queued — a vanished row is a no-op, not P2025.
            const claim = await tx.clipRender.updateMany({
              where: { id: clipRenderId, status: "pending" },
              data: {
                status: "rendering",
                workflowAttemptId: null,
                startedAt,
                errorCode: null,
              },
            });
            if (claim.count === 0) return false;
            if (render?.exportVariantId) {
              await tx.clipExportVariant.update({
                where: { id: render.exportVariantId },
                data: { status: "rendering", startedAt, errorCode: null },
              });
            }
            return true;
          });
    if (persisted && render?.exportVariantId && !attempt) {
      const variant = await prisma.clipExportVariant.findUniqueOrThrow({
        where: { id: render.exportVariantId },
        select: { exportId: true },
      });
      await clipExportService.syncAggregate(variant.exportId);
    }
  }

  /**
   * Claims a ClipRender row for a just-uploaded render output. Render
   * storage keys are attempt-unique (the caller mints a fresh key per
   * encode, mirroring `clipPreviewAttemptStorageKey`'s pattern from
   * 5c3b985) — this only has to detect whether the row this attempt was
   * rendering for is STILL the live one, since an editor save or reset can
   * `clipRender.deleteMany` the row out from under an in-flight encode.
   * Uses `updateMany` rather than `update` so a deleted row makes this a
   * clean `persisted: false` instead of throwing P2025 — the caller (the
   * worker's `uploadRenderedOutput`) must then delete its own just-uploaded
   * object, since with attempt-unique keys that object can never collide
   * with (and therefore never needs to protect) anything another attempt
   * uploaded.
   */
  async completeClipRenderVariant(
    clipRenderId: string,
    input: {
      storageKey: string;
      sizeBytes: number;
      durationSec: number;
    },
  ): Promise<{ persisted: boolean }> {
    const prisma = requirePrisma();
    const attempt = currentWorkflowAttempt();
    const lifecycle = attempt ? getWorkflowRunLifecycle() : null;
    if (attempt) {
      await lifecycle?.assertOwnership(attempt);
    } else requireProtocolV1WorkflowContext("clip_rendering");
    const render = await prisma.clipRender.findUnique({
      where: { id: clipRenderId },
      include: {
        clip: { select: { projectId: true } },
        exportVariant: { select: { id: true, exportId: true } },
      },
    });
    if (!render) {
      return { persisted: false };
    }

    const completedAt = new Date();
    const persisted =
      attempt && lifecycle
        ? await lifecycle.completeClipRenderVariant(attempt, {
            clipRenderId,
            exportVariantId: render.exportVariant?.id ?? null,
            ...input,
            completedAt,
          })
        : await prisma.$transaction(async (tx) => {
            const claim = await tx.clipRender.updateMany({
              where: { id: clipRenderId },
              data: {
                status: "completed",
                storageKey: input.storageKey,
                sizeBytes: BigInt(input.sizeBytes),
                durationSec: input.durationSec,
                errorCode: null,
                completedAt,
              },
            });
            if (claim.count === 0) return false;
            if (render.exportVariant) {
              await tx.clipExportVariant.update({
                where: { id: render.exportVariant.id },
                data: {
                  status: "completed",
                  storageKey: input.storageKey,
                  sizeBytes: BigInt(input.sizeBytes),
                  durationSec: input.durationSec,
                  errorCode: null,
                  completedAt,
                },
              });
            }
            return true;
          });
    if (!persisted) return { persisted: false };

    if (render.exportVariant && !attempt) {
      await clipExportService.syncAggregate(render.exportVariant.exportId);
    }

    await analyticsService
      .recordProjectEvent({
        projectId: render.clip.projectId,
        clipId: render.clipId,
        type: "render_completed",
        metadata: { aspectRatio: render.aspectRatio },
      })
      .catch((error) => {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "render_analytics_record_failed",
            projectId: render.clip.projectId,
            clipId: render.clipId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });

    // Incremental delivery: nudge the project's live stream as soon as this
    // individual clip's render lands, instead of only on the run's overall
    // completed/failed transition — see project-events.tsx's throttled
    // refresh-on-progress handling.
    if (!attempt) await this.pingActiveWorkflowRun(render.clip.projectId);

    return { persisted: true };
  }

  async failClipRenderVariant(
    clipRenderId: string,
    errorCode: string,
    disposition: "retryable" | "permanent" = "retryable",
  ) {
    const prisma = requirePrisma();
    const attempt = currentWorkflowAttempt();
    const lifecycle = attempt ? getWorkflowRunLifecycle() : null;
    if (attempt) {
      await lifecycle?.assertOwnership(attempt);
    } else requireProtocolV1WorkflowContext("clip_rendering");

    const render = await prisma.clipRender.findUnique({
      where: { id: clipRenderId },
      select: { exportVariantId: true },
    });

    const persisted =
      attempt && lifecycle
        ? await lifecycle.failClipRenderVariant(attempt, {
            clipRenderId,
            exportVariantId: render?.exportVariantId ?? null,
            errorCode,
            disposition,
          })
        : await prisma.$transaction(async (tx) => {
            const claim = await tx.clipRender.updateMany({
              where: { id: clipRenderId },
              data: { status: "failed", errorCode },
            });
            if (claim.count === 0) return false;
            if (render?.exportVariantId) {
              await tx.clipExportVariant.update({
                where: { id: render.exportVariantId },
                data: { status: "failed", errorCode },
              });
            }
            return true;
          });
    if (persisted && render?.exportVariantId && !attempt) {
      const variant = await prisma.clipExportVariant.findUniqueOrThrow({
        where: { id: render.exportVariantId },
        select: { exportId: true },
      });
      await clipExportService.syncAggregate(variant.exportId);
    }
  }

  /** Queues a fresh clip_rendering run for variants that were added while a
   *  now-completed run was already rendering (the one-live-run guard absorbed
   *  their trigger, but that run had already snapshotted its work). Keyed to
   *  the completed run so a crashed retry of the same completion can't queue
   *  twice; a P2002 from the one-live-run index means another live run
   *  already exists and will pick the variants up. */
  async queueFollowUpRenderRun(projectId: string, completedRunId: string) {
    await getWorkflowRunLifecycle().admit({
      projectId,
      idempotencyKey: `drain-${completedRunId}`,
      stage: "clip_rendering",
    });
  }

  async getClipDownloadUrl(
    userId: string,
    projectId: string,
    clipId: string,
    aspectRatio: ClipAspectRatio = "9:16",
  ): Promise<{
    downloadUrl: string;
    expiresInSeconds: number;
    fileName: string;
    /** True when `downloadUrl` points at the lightweight preview proxy
     *  rather than a finished render — see the fallback below. */
    isPreviewProxy?: boolean;
    /** The proxy's t=0 expressed in source time; only present alongside
     *  `isPreviewProxy`. Callers must subtract this from source-time
     *  boundaries before seeking/trimming against the proxy. */
    previewStartSec?: number;
  }> {
    const prisma = requirePrisma();
    const aspectRatioDb = clipAspectRatioToDb[aspectRatio];

    const render = await prisma.clipRender.findFirst({
      where: {
        clipId,
        aspectRatio: aspectRatioDb,
        exportVariantId: null,
        clip: {
          projectId,
          project: { userId, ...accessibleProjectWhere() },
        },
      },
      include: {
        clip: true,
      },
    });

    if (render && render.status === "completed" && render.storageKey) {
      const slug = aspectRatioSlug.get(aspectRatio) ?? "9x16";
      const fileName = `clip-${render.clip.index + 1}-${render.clip.category}-${slug}.mp4`;
      const downloadUrl = await presignDownloadUrl({
        key: render.storageKey,
        fileName,
      });

      await analyticsService.recordProjectEvent({
        projectId,
        clipId,
        type: "download_opened",
        metadata: { aspectRatio },
      });

      return {
        downloadUrl,
        expiresInSeconds: 3600,
        fileName,
      };
    }

    // No completed render for this aspect ratio yet (or none was ever
    // queued) — fall back to the lightweight, aspect-ratio-agnostic preview
    // proxy so callers still get something playable instead of a hard
    // error. This path is never reached by an explicit "Download" click
    // (the UI only offers that button once `hasAsset` is true), so it's
    // exclusively the inline-preview path — no `download_opened` analytics.
    const clip =
      render?.clip ??
      (await prisma.clip.findFirst({
        where: { id: clipId, projectId, project: { userId } },
      }));

    if (clip?.previewStorageKey) {
      const fileName = `clip-${clip.index + 1}-preview.mp4`;
      const downloadUrl = await presignDownloadUrl({
        key: clip.previewStorageKey,
        fileName,
      });

      return {
        downloadUrl,
        expiresInSeconds: 3600,
        fileName,
        isPreviewProxy: true,
        previewStartSec: clip.previewStartSec ?? 0,
      };
    }

    if (!render) {
      throw new Error("clip render not found");
    }

    throw new Error("clip has not been rendered for this aspect ratio");
  }

  /**
   * Resolves the initial clip-row previews in one database read and one HTTP
   * response. Browsers otherwise queue ten independent same-origin requests
   * behind their per-origin connection limit, making later rows wait for
   * multiple database-latency waves before they can paint.
   */
  async getProjectClipPreviewUrls(
    userId: string,
    projectId: string,
    aspectRatio: ClipAspectRatio = "9:16",
  ): Promise<{
    previews: Record<
      string,
      {
          downloadUrl: string;
          expiresInSeconds: number;
          fileName: string;
          isPreviewProxy?: boolean;
          previewStartSec?: number;
        }
      | null
    >;
  }> {
    const prisma = requirePrisma();
    const aspectRatioDb = clipAspectRatioToDb[aspectRatio];
    const clips = await prisma.clip.findMany({
      where: {
        projectId,
        project: { userId, ...accessibleProjectWhere() },
      },
      orderBy: { index: "asc" },
      select: {
        id: true,
        index: true,
        category: true,
        previewStorageKey: true,
        previewStartSec: true,
        renders: {
          where: {
            aspectRatio: aspectRatioDb,
            exportVariantId: null,
          },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            status: true,
            storageKey: true,
          },
        },
      },
    });

    const previews = await Promise.all(
      clips.map(async (clip) => {
        const render = clip.renders[0];
        if (render?.status === "completed" && render.storageKey) {
          const slug = aspectRatioSlug.get(aspectRatio) ?? "9x16";
          const fileName = `clip-${clip.index + 1}-${clip.category}-${slug}.mp4`;
          return [
            clip.id,
            {
              downloadUrl: await presignDownloadUrl({
                key: render.storageKey,
                fileName,
              }),
              expiresInSeconds: 3600,
              fileName,
            },
          ] as const;
        }

        if (clip.previewStorageKey) {
          const fileName = `clip-${clip.index + 1}-preview.mp4`;
          return [
            clip.id,
            {
              downloadUrl: await presignDownloadUrl({
                key: clip.previewStorageKey,
                fileName,
              }),
              expiresInSeconds: 3600,
              fileName,
              isPreviewProxy: true as const,
              previewStartSec: clip.previewStartSec ?? 0,
            },
          ] as const;
        }

        return [clip.id, null] as const;
      }),
    );

    return { previews: Object.fromEntries(previews) };
  }

  /**
   * Resolves a presigned URL for a clip's preview proxy (if one has been
   * generated yet) for the studio editor. Returns nulls when no proxy
   * exists so the caller can fall back to the full source. Kept separate
   * from {@link getClipDownloadUrl} because the studio has no aspect-ratio
   * selector to key a render lookup off of — it always wants "whatever
   * preview exists for this clip," full stop.
   *
   * `waveformPeaksUrl` is a same-origin authenticated API endpoint, not a
   * private-R2 presign. Browser fetches of the latter require bucket CORS;
   * the endpoint keeps the page's critical path free of an R2 GET and streams
   * only this small validated metadata artifact after the editor paints.
   */
  async getClipPreviewSource(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<{
    previewUrl: string | null;
    previewStartSec: number;
    previewDurationSec: number | null;
    waveformPeaksUrl: string | null;
  }> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: {
        id: clipId,
        projectId,
        project: { userId, ...accessibleProjectWhere() },
      },
      select: {
        previewStorageKey: true,
        previewStartSec: true,
        previewDurationSec: true,
      },
    });

    if (!clip?.previewStorageKey) {
      return {
        previewUrl: null,
        previewStartSec: 0,
        previewDurationSec: null,
        waveformPeaksUrl: null,
      };
    }

    try {
      const previewUrl = await presignDownloadUrl({
        key: clip.previewStorageKey,
        expiresIn: 3600,
      });

      return {
        previewUrl,
        previewStartSec: clip.previewStartSec ?? 0,
        previewDurationSec: clip.previewDurationSec ?? null,
        waveformPeaksUrl:
          `/api/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(clipId)}/preview-peaks` +
          `?v=${encodeURIComponent(clip.previewStorageKey.split("/").at(-1) ?? "preview")}`,
      };
    } catch {
      return {
        previewUrl: null,
        previewStartSec: 0,
        previewDurationSec: null,
        waveformPeaksUrl: null,
      };
    }
  }

  /** Reads the small peaks sibling for the authenticated same-origin API.
   * Missing/silent/legacy/malformed artifacts are normal and return null. */
  async getClipPreviewPeaks(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<ClipPreviewPeaks | null> {
    const prisma = requirePrisma();
    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: { previewStorageKey: true },
    });
    if (!clip?.previewStorageKey) return null;
    try {
      const value = await getJsonObject({
        key: derivePeaksStorageKey(clip.previewStorageKey),
        maxBytes: 256 * 1024,
      });
      return isClipPreviewPeaks(value) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Finds clips still missing a preview proxy, highest `viralityScore`
   * first (users look at the top clips first) — scoped to projects whose
   * source is still available and fully ingested. Backs the worker's
   * decoupled `processPendingClipPreviews` poll (apps/worker/src/tasks/
   * clip-preview.ts), which also backfills every pre-existing clip.
   *
   * Returns the *effective* (transcript-boundary-expanded) timing — the
   * exact same `getEffectiveClipTiming` computation `toClipSnapshot` uses
   * for what the studio/clip-card actually display — not the raw DB
   * columns. A freshly-detected clip's raw `startSec`/`endSec` can differ
   * from its displayed timing (boundary edits persist the effective values
   * back, but detection doesn't); padding around the raw columns could
   * leave the proxy not actually covering what's shown, silently reproducing
   * the exact off-by-`previewStartSec` desync this feature exists to avoid.
   */
  async getClipsNeedingPreview(limit: number): Promise<ClipPendingPreview[]> {
    const prisma = requirePrisma();
    const take = Math.max(1, Math.min(25, limit));

    const clips = await prisma.clip.findMany({
      where: {
        previewStorageKey: null,
        project: {
          ...accessibleProjectWhere(),
          sourceStorageKey: { not: null },
          ingestStatus: "ready",
        },
      },
      orderBy: [{ viralityScore: "desc" }, { createdAt: "asc" }],
      take,
      select: {
        id: true,
        projectId: true,
        startSec: true,
        endSec: true,
        transcriptSlice: true,
        captionPreset: true,
        studioEdits: true,
        brollUrl: true,
        deletedRanges: true,
        editorDocumentVersion: true,
        sceneBlocks: true,
        censorSegments: true,
        mediaMotions: true,
        project: {
          select: { sourceStorageKey: true, sourceDurationSeconds: true },
        },
      },
    });

    const pending: ClipPendingPreview[] = [];
    for (const clip of clips) {
      if (!clip.project.sourceStorageKey) continue;

      // tailPadSec 0 — must stay in lockstep with toClipSnapshot (see its
      // comment): slice-only timing treats stored bounds as final.
      let document: EditorDocument;
      try {
        document = decodeClipEditorDocumentFromStorage(
          clip,
          clip.project.sourceDurationSeconds,
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "clip_preview_document_skipped",
            clipId: clip.id,
            projectId: clip.projectId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      const effective = getEffectiveClipTiming({
        utterances: document.transcriptSlice,
        startSec: document.clipStartSec,
        endSec: document.clipEndSec,
        sourceDurationSec: clip.project.sourceDurationSeconds ?? null,
        tailPadSec: 0,
      });

      pending.push({
        id: clip.id,
        projectId: clip.projectId,
        startSec: effective.startSec,
        endSec: effective.endSec,
        sourceStorageKey: clip.project.sourceStorageKey,
        sourceDurationSec: clip.project.sourceDurationSeconds ?? null,
      });
    }
    return pending;
  }

  /**
   * Persists a clip's generated preview-proxy metadata — but only if no
   * proxy has been recorded yet AND the clip's boundary window still
   * matches what this attempt cut its proxy for. `previewStorageKey IS
   * NULL` is the atomic claim condition (mirroring the codebase's
   * claim-via-conditional-update idiom used by e.g. `claimNextWorkflowRun`),
   * since the Clip model has no separate "generating" status column to
   * transition: two workers racing to cut the same clip's proxy will both
   * upload, but only one write wins here — the loser (persisted: false)
   * must delete its own upload.
   *
   * The `startSec`/`endSec IS NULL`-adjacent window check closes a second,
   * narrower race than that one: an editor save/reset can null
   * `previewStorageKey` for a NEW window while an OLD-window cut is still
   * in flight from BEFORE that change. `previewStorageKey IS NULL` alone
   * would still be true after the reset, so the stale attempt would win the
   * claim and persist a proxy for a window the clip no longer has. Matching
   * the clip's CURRENT `startSec`/`endSec` against the caller-supplied
   * `expectedClipStartSec`/`expectedClipEndSec` (the window this attempt
   * was actually cutting for) makes that impossible — a boundary change
   * always fails this attempt's claim, exactly like `editorRevision`
   * mismatches fail the editor document's guarded writes.
   */
  async completeClipPreview(
    clipId: string,
    input: {
      storageKey: string;
      startSec: number;
      durationSec: number;
      /** The clip's own boundary window this attempt cut its proxy for
       *  (`ClipPendingPreview.startSec/endSec` at dispatch time) — distinct
       *  from `startSec` above, which is the PADDED preview window persisted
       *  as `previewStartSec`. */
      expectedClipStartSec: number;
      expectedClipEndSec: number;
    },
  ): Promise<{ persisted: boolean; projectId: string | null }> {
    const prisma = requirePrisma();
    const PREVIEW_WINDOW_EPSILON_SEC = 0.001;

    const clip = await prisma.clip.findUnique({
      where: { id: clipId },
      select: { projectId: true },
    });
    if (!clip) {
      return { persisted: false, projectId: null };
    }

    const claim = await prisma.clip.updateMany({
      where: {
        id: clipId,
        project: accessibleProjectWhere(),
        previewStorageKey: null,
        startSec: {
          gte: input.expectedClipStartSec - PREVIEW_WINDOW_EPSILON_SEC,
          lte: input.expectedClipStartSec + PREVIEW_WINDOW_EPSILON_SEC,
        },
        endSec: {
          gte: input.expectedClipEndSec - PREVIEW_WINDOW_EPSILON_SEC,
          lte: input.expectedClipEndSec + PREVIEW_WINDOW_EPSILON_SEC,
        },
      },
      data: {
        previewStorageKey: input.storageKey,
        previewStartSec: input.startSec,
        previewDurationSec: input.durationSec,
      },
    });

    if (claim.count === 0) {
      return { persisted: false, projectId: clip.projectId };
    }

    // Incremental delivery: nudge the project's live stream — see
    // project-events.tsx's throttled refresh-on-progress handling.
    await this.pingActiveWorkflowRun(clip.projectId);

    return { persisted: true, projectId: clip.projectId };
  }

  /**
   * Atomically claims one clip for automatic layout analysis. A durable lease
   * (rather than an in-process mutex) prevents duplicate proxy downloads and
   * CPU detection when workers are horizontally scaled. Expired processing
   * claims are recoverable after a crash; the UUID token fences a stale owner
   * from completing or releasing a newer attempt.
   */
  async claimNextClipForAutoLayoutAnalysis(
    leaseMs: number,
  ): Promise<ClipPendingAutoLayoutAnalysis | null> {
    const prisma = requirePrisma();
    const now = new Date();
    const boundedLeaseMs = Math.max(30_000, Math.min(15 * 60_000, leaseMs));
    const leaseExpiresAt = new Date(now.getTime() + boundedLeaseMs);
    const clips = await prisma.clip.findMany({
      where: {
        autoLayoutAnalysis: { equals: Prisma.DbNull },
        previewStorageKey: { not: null },
        previewStartSec: { not: null },
        previewDurationSec: { not: null },
        project: accessibleProjectWhere(now),
        OR: [
          {
            autoLayoutStatus: "pending",
            OR: [
              { autoLayoutLeaseExpiresAt: null },
              { autoLayoutLeaseExpiresAt: { lte: now } },
            ],
          },
          {
            autoLayoutStatus: "processing",
            autoLayoutLeaseExpiresAt: { lte: now },
          },
        ],
      },
      orderBy: [{ viralityScore: "desc" }, { createdAt: "asc" }],
      // Read a few candidates so a collision with another replica does not
      // turn this tick into a false empty result.
      take: 8,
      select: {
        id: true,
        projectId: true,
        startSec: true,
        endSec: true,
        transcriptSlice: true,
        captionPreset: true,
        studioEdits: true,
        brollUrl: true,
        deletedRanges: true,
        editorDocumentVersion: true,
        sceneBlocks: true,
        censorSegments: true,
        mediaMotions: true,
        editorRevision: true,
        previewStorageKey: true,
        previewStartSec: true,
        previewDurationSec: true,
        project: { select: { sourceDurationSeconds: true } },
      },
    });

    for (const clip of clips) {
      if (
        !clip.previewStorageKey ||
        clip.previewStartSec === null ||
        clip.previewDurationSec === null
      ) {
        continue;
      }
      let document: EditorDocument;
      try {
        document = decodeClipEditorDocumentFromStorage(
          clip,
          clip.project.sourceDurationSeconds,
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "clip_auto_layout_document_skipped",
            clipId: clip.id,
            projectId: clip.projectId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      const claimToken = randomUUID();
      const claim = await prisma.clip.updateMany({
        where: {
          id: clip.id,
          project: accessibleProjectWhere(now),
          autoLayoutAnalysis: { equals: Prisma.DbNull },
          OR: [
            {
              autoLayoutStatus: "pending",
              OR: [
                { autoLayoutLeaseExpiresAt: null },
                { autoLayoutLeaseExpiresAt: { lte: now } },
              ],
            },
            {
              autoLayoutStatus: "processing",
              autoLayoutLeaseExpiresAt: { lte: now },
            },
          ],
        },
        data: {
          autoLayoutStatus: "processing",
          autoLayoutClaimToken: claimToken,
          autoLayoutLeaseExpiresAt: leaseExpiresAt,
          autoLayoutAttemptCount: { increment: 1 },
        },
      });
      if (claim.count === 0) continue;

      return {
        id: clip.id,
        projectId: clip.projectId,
        startSec: document.clipStartSec,
        endSec: document.clipEndSec,
        transcriptSlice: document.transcriptSlice,
        deletedRanges: document.deletedRanges,
        editorRevision: clip.editorRevision,
        previewStorageKey: clip.previewStorageKey,
        previewStartSec: clip.previewStartSec,
        previewDurationSec: clip.previewDurationSec,
        autoLayoutClaimToken: claimToken,
      };
    }
    return null;
  }

  /** Atomically publishes a derived automatic layout plan only while the clip
   * still has the same editor revision and proxy that were analyzed. */
  async completeClipAutoLayoutAnalysis(
    clipId: string,
    analysis: ClipAutoLayoutAnalysis,
    expected: {
      editorRevision: number;
      previewStorageKey: string;
    },
  ): Promise<boolean> {
    const prisma = requirePrisma();
    const parsed = clipAutoLayoutAnalysisSchema.parse(analysis);
    const attempt = currentWorkflowAttempt();
    if (attempt) {
      return getWorkflowRunLifecycle().completeClipAutoLayoutAnalysis(attempt, {
        clipId,
        analysis: parsed as unknown as Prisma.InputJsonValue,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
      });
    }
    const result = await prisma.clip.updateMany({
      where: {
        id: clipId,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
        autoLayoutAnalysis: { equals: Prisma.DbNull },
      },
      data: {
        autoLayoutAnalysis: parsed as unknown as Prisma.InputJsonValue,
        autoLayoutStatus: "completed",
        autoLayoutClaimToken: null,
        autoLayoutLeaseExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  /** Publishes explicit Split evidence behind the same revision/proxy and
   * workflow-ownership fences as Automatic evidence. */
  async completeClipSplitLayoutAnalysis(
    clipId: string,
    analysis: ClipSplitLayoutAnalysis,
    expected: {
      editorRevision: number;
      previewStorageKey: string;
    },
  ): Promise<boolean> {
    const prisma = requirePrisma();
    const parsed = parseClipSplitLayoutAnalysis(analysis);
    if (!parsed) {
      throw new Error("invalid_split_layout_analysis_engine");
    }
    const attempt = currentWorkflowAttempt();
    if (attempt) {
      return getWorkflowRunLifecycle().completeClipSplitLayoutAnalysis(attempt, {
        clipId,
        analysis: parsed as unknown as Prisma.InputJsonValue,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
      },
      );
    }
    const result = await prisma.clip.updateMany({
      where: {
        id: clipId,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
      },
      data: {
        splitLayoutAnalysis: parsed as unknown as Prisma.InputJsonValue,
      },
    });
    return result.count === 1;
  }

  /** Persists an identity-bound terminal Split analysis failure so Studio
   * shows the same typed degraded plan as export instead of polling forever. */
  async completeClipSplitLayoutFailure(
    clipId: string,
    failure: ClipSplitLayoutFailure,
    expected: { editorRevision: number; previewStorageKey: string },
  ): Promise<boolean> {
    const prisma = requirePrisma();
    const parsed = clipSplitLayoutFailureSchema.parse(failure);
    const attempt = currentWorkflowAttempt();
    if (attempt) {
      return getWorkflowRunLifecycle().completeClipSplitLayoutFailure(attempt, {
        clipId,
        failure: parsed as unknown as Prisma.InputJsonValue,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
      });
    }
    const result = await prisma.clip.updateMany({
      where: {
        id: clipId,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
      },
      data: {
        splitLayoutAnalysis: parsed as unknown as Prisma.InputJsonValue,
      },
    });
    return result.count === 1;
  }

  /** Complete a worker claim only if its fencing token and analyzed inputs
   * are still current. */
  async completeClaimedClipAutoLayoutAnalysis(
    clipId: string,
    analysis: ClipAutoLayoutAnalysis,
    expected: {
      editorRevision: number;
      previewStorageKey: string;
      claimToken: string;
    },
  ): Promise<boolean> {
    const prisma = requirePrisma();
    const parsed = clipAutoLayoutAnalysisSchema.parse(analysis);
    const result = await prisma.clip.updateMany({
      where: {
        id: clipId,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
        autoLayoutAnalysis: { equals: Prisma.DbNull },
        autoLayoutStatus: "processing",
        autoLayoutClaimToken: expected.claimToken,
      },
      data: {
        autoLayoutAnalysis: parsed as unknown as Prisma.InputJsonValue,
        autoLayoutStatus: "completed",
        autoLayoutClaimToken: null,
        autoLayoutLeaseExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  /** Persist retry backoff for a failed claim so another replica or process
   * restart cannot immediately repeat the same expensive failure. */
  async deferClaimedClipAutoLayoutAnalysis(
    clipId: string,
    claimToken: string,
    retryAt: Date,
  ): Promise<boolean> {
    const prisma = requirePrisma();
    const result = await prisma.clip.updateMany({
      where: {
        id: clipId,
        autoLayoutAnalysis: { equals: Prisma.DbNull },
        autoLayoutStatus: "processing",
        autoLayoutClaimToken: claimToken,
      },
      data: {
        autoLayoutStatus: "pending",
        autoLayoutClaimToken: null,
        autoLayoutLeaseExpiresAt: retryAt,
      },
    });
    return result.count === 1;
  }

  /**
   * Best-effort "something changed" ping for a project's live SSE stream —
   * reuses whatever WorkflowRun is currently queued/running for the
   * project rather than inventing a new event shape or stage (the shape is
   * the shared `workflow.stage.updated` event consumed by
   * apps/web/app/api/stream/[projectId]/route.ts). A no-op when nothing is
   * actively in flight for the project, so a backfill run touching an
   * already-finished project doesn't inject stale-looking "activity".
   * Never throws — a missed nudge just means the client catches up on its
   * next poll/navigation instead of getting an instant push.
   */
  private async pingActiveWorkflowRun(projectId: string): Promise<void> {
    try {
      const prisma = requirePrisma();
      const run = await prisma.workflowRun.findFirst({
        where: {
          projectId,
          lifecycleVersion: 1,
          status: { in: ["queued", "running", "waiting"] },
        },
        orderBy: { updatedAt: "desc" },
      });
      if (!run) return;

      await publishWorkflowStageUpdated({
        event: "workflow.stage.updated",
        projectId,
        workflowRunId: run.id,
        stage: run.stage as WorkflowStageUpdatedEvent["stage"],
        status: run.status as WorkflowStageUpdatedEvent["status"],
        progress: run.progress,
        errorCode: run.errorCode,
      });
    } catch {
      // Best-effort only — the SSE route also polls the DB as a fallback.
    }
  }

  /**
   * Loads the editor document + revision for the studio, plus the immutable
   * revision-zero original used by Reset-to-original. Before the first save
   * no snapshot exists yet, so the current state IS the original.
   */
  async getClipEditorDocument(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<{
    revision: number;
    document: EditorDocument;
    original: EditorDocument;
    /** Screen-mode PiP layout analysis (packet A — db/services foundation),
     *  parsed via `parseClipLayoutAnalysis`: `null` for "never analyzed"
     *  (column NULL) or unversioned malformed JSON. A declared unknown
     *  version fails closed so the browser cannot adopt evidence written by
     *  a contract this deployment does not understand. Only the worker-side
     *  write path (`setClipLayoutAnalysis`) needs the column's NULL-vs-envelope
     *  distinction. Rides alongside `document`/`original` as a sibling
     *  derived field, same as `revision` — NOT folded into `document`
     *  itself, since it's worker-derived data the client never PUTs back
     *  through `saveEditorDocumentSchema`. Consumed by the studio preview
     *  (packet C) to render the true facecam crop instead of guessing from
     *  a face-centered band. */
    layoutAnalysis: ClipLayoutAnalysis | null;
    /** Automatic shot/speaker layout consumed by preview and render. */
    autoLayoutAnalysis: ClipAutoLayoutAnalysis | null;
    /** Explicit Split detector evidence, independent from Automatic. */
    splitLayoutAnalysis: ClipSplitLayoutAnalysis | null;
    splitLayoutFailure: ClipSplitLayoutFailure | null;
    layoutAnalysisFailure: ClipLayoutAnalysisFailure | null;
  }> {
    const result = await clipEditorDocumentPersistence.readDocument({
      actorUserId: userId,
      projectId,
      clipId,
    });
    return {
      revision: result.revision,
      document: result.document,
      original: result.original,
      layoutAnalysis: parseClipLayoutAnalysis(result.evidence.screen),
      autoLayoutAnalysis: parseClipAutoLayoutAnalysis(result.evidence.automatic,
      ),
      splitLayoutAnalysis: parseClipSplitLayoutAnalysis(result.evidence.split),
      splitLayoutFailure: parseClipSplitLayoutFailure(result.evidence.split),
      layoutAnalysisFailure: parseClipLayoutAnalysisFailure(result.evidence.screen,
      ),
    };
  }

  /** Lightweight readiness read for the studio's short-lived background
   * poll. Keep this separate from getClipEditorDocument: transcripts and
   * editor JSON can be large, while the poll needs exactly one derived
   * column. */
  async getClipAutoLayoutAnalysis(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<ClipAutoLayoutAnalysis | null> {
    const prisma = requirePrisma();
    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: { autoLayoutAnalysis: true },
    });
    if (!clip) {
      throw new Error("clip not found");
    }
    return parseClipAutoLayoutAnalysis(clip.autoLayoutAnalysis);
  }

  async getClipSplitLayoutAnalysis(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<ClipSplitLayoutAnalysis | null> {
    const prisma = requirePrisma();
    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: { splitLayoutAnalysis: true },
    });
    if (!clip) {
      throw new Error("clip not found");
    }
    return parseClipSplitLayoutAnalysis(clip.splitLayoutAnalysis);
  }

  async getClipSplitLayoutOutcome(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<ClipSplitLayoutOutcome | null> {
    const prisma = requirePrisma();
    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: { splitLayoutAnalysis: true },
    });
    if (!clip) throw new Error("clip not found");
    return parseClipSplitLayoutOutcome(clip.splitLayoutAnalysis);
  }

  async getClipLayoutAnalysis(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<ClipLayoutAnalysis | null> {
    const prisma = requirePrisma();
    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: { layoutAnalysis: true },
    });
    if (!clip) {
      throw new Error("clip not found");
    }
    return parseClipLayoutAnalysis(clip.layoutAnalysis);
  }

  async getClipLayoutAnalysisOutcome(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<ClipLayoutAnalysisOutcome | null> {
    const prisma = requirePrisma();
    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: { layoutAnalysis: true },
    });
    if (!clip) throw new Error("clip not found");
    return parseClipLayoutAnalysisOutcome(clip.layoutAnalysis);
  }

  /** Publishes derived Screen evidence only while the analyzed editor
   * revision and preview proxy are still current. The write does not bump the
   * editor revision because evidence is not a user edit. */
  async setClipLayoutAnalysis(
    clipId: string,
    analysis: ClipLayoutAnalysis,
    expected: { editorRevision: number; previewStorageKey: string },
  ): Promise<void> {
    const prisma = requirePrisma();
    const parsed = clipLayoutAnalysisSchema.parse(analysis);

    const attempt = currentWorkflowAttempt();
    if (attempt) {
      await getWorkflowRunLifecycle().setClipLayoutAnalysis(attempt, {
        clipId,
        analysis: parsed as unknown as Prisma.InputJsonValue,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
      });
      return;
    }

    await prisma.clip.updateMany({
      where: {
        id: clipId,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
      },
      data: { layoutAnalysis: parsed as unknown as Prisma.InputJsonValue },
    });
  }

  async setClipLayoutAnalysisFailure(
    clipId: string,
    failure: ClipLayoutAnalysisFailure,
    expected: { editorRevision: number; previewStorageKey: string },
  ): Promise<void> {
    const prisma = requirePrisma();
    const parsed = clipLayoutAnalysisFailureSchema.parse(failure);
    const attempt = currentWorkflowAttempt();
    if (attempt) {
      await getWorkflowRunLifecycle().setClipLayoutAnalysisFailure(attempt, {
        clipId,
        failure: parsed as unknown as Prisma.InputJsonValue,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
      });
      return;
    }
    await prisma.clip.updateMany({
      where: {
        id: clipId,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
      },
      data: { layoutAnalysis: parsed as unknown as Prisma.InputJsonValue },
    });
  }

  async autoQueueDefaultRenders(
    projectId: string,
    detectionWorkflowRunId: string,
    aspectRatio: ClipAspectRatio = "9:16",
  ): Promise<void> {
    const prisma = requirePrisma();
    const attempt = currentWorkflowAttempt(detectionWorkflowRunId);
    const lifecycle = attempt ? getWorkflowRunLifecycle() : null;
    if (attempt) await lifecycle?.assertOwnership(attempt);
    else
      requireProtocolV1WorkflowContext(
        "moment_detection",
        detectionWorkflowRunId,
      );

    const clips = await prisma.clip.findMany({
      where: { projectId },
      select: { id: true },
    });

    if (clips.length === 0) {
      return;
    }

    // Same entitlement clamp as triggerClipRendering — this is the
    // post-detection auto-render, so a free-tier project's first render must
    // land at "720p" on the row, not the "1080p" column default, or the
    // worker's per-row resolution scale never kicks in for it.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true, workspaceId: true },
    });
    const resolvedResolution = project
      ? await resolveRequestedResolution("1080p", project.workspaceId)
      : "1080p";

    const aspectRatioDb = clipAspectRatioToDb[aspectRatio];
    const clipIds = clips.map((c) => c.id);

    const existingRenders = await prisma.clipRender.findMany({
      where: {
        clipId: { in: clipIds },
        aspectRatio: aspectRatioDb,
        exportVariantId: null,
        status: { in: ["pending", "rendering"] },
      },
      select: { clipId: true },
    });

    const alreadyQueued = new Set(existingRenders.map((r) => r.clipId));
    const toCreate = clipIds.filter((id) => !alreadyQueued.has(id));

    const renderRows = toCreate.map((clipId) => ({
      clipId,
      aspectRatio: aspectRatioDb,
      status: "pending" as const,
      resolution: resolvedResolution,
    })) satisfies Prisma.ClipRenderCreateManyInput[];

    if (attempt && lifecycle) {
      await lifecycle.admitAutoRenderWork(attempt, {
        idempotencyKey: `auto-render-${detectionWorkflowRunId}`,
        renders: renderRows,
      });
      return;
    }

    if (renderRows.length > 0) {
      await prisma.clipRender.createMany({
        data: renderRows,
        skipDuplicates: true,
      });
    }

    await getWorkflowRunLifecycle().admit({
      projectId,
      idempotencyKey: `auto-render-${detectionWorkflowRunId}`,
      stage: "clip_rendering",
    });
  }
}

// --- Scoring utilities ---

export function sliceTranscriptForClip(
  utterances: TranscriptUtterance[],
  startSec: number,
  endSec: number,
): TranscriptUtterance[] {
  return normalizeTranscriptSliceForClip(utterances, startSec, endSec);
}

export const clipService = new ClipService();
