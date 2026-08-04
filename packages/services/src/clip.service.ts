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
  clipTitleSuggestionsLlmResponseSchema,
  contentPackSchema,
  DEFAULT_CAPTION_PRESET,
  deletedRangesSchema,
  editorDocumentSchema,
  getCaptionPresetById,
  getEffectiveClipTiming,
  hasRenderableContent,
  isBrandDefaultCaptionPresetId,
  normalizeDeletedRanges,
  normalizeTranscriptSliceForClip,
  saveEditorDocumentSchema,
  splitUtterancesIntoSentences,
  studioEditsSchema,
  updateClipTranscriptSliceSchema,
} from "@narriflow/validators";
import type {
  BrollCue,
  CaptionPreset,
  ClipAspectRatio,
  ClipCategory,
  ClipPlatformTarget,
  ClipRenderVariant,
  ClipSnapshot,
  ClipWindow,
  ContentPack,
  EditorDocument,
  EffectiveClipTiming,
  SaveEditorDocument,
  SourceRange,
  StudioEdits,
  TranscriptUtterance,
  WorkflowStageUpdatedEvent,
} from "@narriflow/validators";
import {
  getLastWorkflowSeq,
  publishWorkflowStageUpdated,
} from "./workflow.service";
import { isUniqueConstraintError } from "./generation-sequencing";
import { copyObject, deleteObject, presignDownloadUrl } from "./r2-storage";
import { analyticsService } from "./analytics.service";
import { assertPublicHttpUrl } from "./url-guard";

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

function toClipRenderVariantSnapshot(render: ClipRender): ClipRenderVariant {
  const aspectRatioDb = clipAspectRatioDbSchema.parse(render.aspectRatio);
  const aspectRatio = clipAspectRatioFromDb[aspectRatioDb];

  return {
    aspectRatio,
    status: render.status as ClipRenderVariant["status"],
    sizeBytes: render.sizeBytes ? Number(render.sizeBytes) : null,
    durationSec: render.durationSec ?? null,
    errorCode: render.errorCode ?? null,
    completedAt: render.completedAt?.toISOString() ?? null,
    hasAsset: render.status === "completed" && Boolean(render.storageKey),
  };
}

function toClipSnapshot(clip: ClipWithRenders): ClipSnapshot {
  // tailPadSec 0: the stored bounds were already pad- and collision-
  // normalized against the FULL transcript when the clip was detected or
  // edited. The clip's own slice can't see the next word beyond its end, so
  // re-padding here would walk the end back INTO the next sentence —
  // exactly the mid-speech cut this pipeline just eliminated. Slice-only
  // re-derivations must treat stored timing as final.
  const effective = getEffectiveClipTiming({
    utterances: clip.transcriptSlice as unknown as TranscriptUtterance[],
    startSec: clip.startSec,
    endSec: clip.endSec,
    sourceDurationSec: clip.project?.sourceDurationSeconds ?? null,
    tailPadSec: 0,
  });

  return {
    id: clip.id,
    projectId: clip.projectId,
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
      .map(toClipRenderVariantSnapshot)
      .sort(
        (left, right) =>
          (aspectRatioOrder.get(left.aspectRatio) ?? Number.MAX_SAFE_INTEGER) -
          (aspectRatioOrder.get(right.aspectRatio) ?? Number.MAX_SAFE_INTEGER),
      ),
    captionPreset: clip.captionPreset
      ? captionPresetSchema.parse(clip.captionPreset)
      : null,
    brollUrl: clip.brollUrl ?? null,
    // Tolerant parse: cues are LLM-authored and purely advisory, so a malformed
    // payload should degrade to keyword-derived B-roll, never fail the clip.
    brollCues: brollCuesArraySchema.safeParse(clip.brollCues).data ?? [],
    studioEdits: clip.studioEdits
      ? studioEditsSchema.parse(clip.studioEdits)
      : studioEditsSchema.parse({}),
    // Presence-only signal — never the storage key itself. See the schema
    // doc comment in packages/validators/src/clip.ts for why this exists.
    hasPreview: Boolean(clip.previewStorageKey),
    createdAt: clip.createdAt.toISOString(),
  };
}

function getClipRenderResetData(): Prisma.ClipRenderUpdateInput {
  return {
    status: "pending",
    storageKey: null,
    sizeBytes: null,
    durationSec: null,
    errorCode: null,
    startedAt: null,
    completedAt: null,
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

/**
 * Thrown when an editor-document save carries a stale baseRevision (another
 * tab or an earlier in-flight save already bumped it). Carries the current
 * revision so the client can refetch, rebase its history, and retry.
 */
export class ClipEditorRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("editor document revision conflict");
    this.name = "ClipEditorRevisionConflictError";
  }
}

function parseTranscriptSlice(value: unknown): TranscriptUtterance[] {
  return updateClipTranscriptSliceSchema.parse({ transcriptSlice: value })
    .transcriptSlice;
}

/**
 * Materialize the editor document from a stored clip row. A null stored
 * captionPreset maps to the default preset — the document model always has a
 * concrete preset, which is also what the preview falls back to.
 */
function buildEditorDocumentFromClip(
  clip: Pick<
    Clip,
    | "startSec"
    | "endSec"
    | "captionPreset"
    | "transcriptSlice"
    | "studioEdits"
    | "brollUrl"
    | "deletedRanges"
  >,
): EditorDocument {
  return editorDocumentSchema.parse({
    clipStartSec: clip.startSec,
    clipEndSec: clip.endSec,
    captionPreset: clip.captionPreset
      ? captionPresetSchema.parse(clip.captionPreset)
      : DEFAULT_CAPTION_PRESET,
    transcriptSlice: parseTranscriptSlice(clip.transcriptSlice),
    studioEdits: clip.studioEdits
      ? studioEditsSchema.parse(clip.studioEdits)
      : studioEditsSchema.parse({}),
    brollUrl: clip.brollUrl ?? null,
    deletedRanges: clip.deletedRanges
      ? deletedRangesSchema.parse(clip.deletedRanges)
      : [],
  });
}

/**
 * Throws when `currentRevision` doesn't match the client's `baseRevision` —
 * shared guard for both saveClipEditorDocument and resetClipEditorToOriginal.
 */
export function assertEditorRevisionMatches(
  currentRevision: number,
  baseRevision: number,
): void {
  if (currentRevision !== baseRevision) {
    throw new ClipEditorRevisionConflictError(currentRevision);
  }
}

/**
 * Multi-model review fix #5: `deletedRanges` normalizes cleanly even when it
 * deletes the clip's entire renderable content — normalization alone can't
 * catch that, only `buildClipCutPlan`'s MIN_KEPT_SEGMENT_SEC-aware guard
 * can, and until now that guard only ran at render time (worker-side),
 * failing every render variant well after the save already succeeded.
 * `hasRenderableContent` (packages/validators/src/edit-ranges.ts) is the
 * exact same policy the worker's `buildClipCutPlan` enforces, so a document
 * this rejects is guaranteed to be one the worker would also reject —
 * checked here so the save itself fails fast instead.
 *
 * NOTE: the PUT `/projects/:id/clips/:clipId/editor` route (apps/web) only
 * maps the `editor_boundaries_immutable` ClipActionError code to a 422 today
 * — every other code, including this one, falls through to an unhandled
 * 500. That route is out of this change's scope; the caller (or whoever
 * owns route.ts) still needs to add a `editor_document_empty_timeline` ->
 * 422 mapping there.
 */
export function assertEditorDocumentHasRenderableContent(
  deletedRanges: SourceRange[],
  window: ClipWindow,
): void {
  if (!hasRenderableContent(window, deletedRanges)) {
    throw new ClipActionError(
      "editor_document_empty_timeline",
      "deleting these ranges would leave nothing in the clip to render",
    );
  }
}

const RESET_BOUNDARY_EPSILON_SEC = 0.001;

export interface EditorResetPlanInput {
  /** Raw `Clip.editorOriginal` column value — null when never saved. */
  editorOriginal: unknown;
  currentStartSec: number;
  currentEndSec: number;
  viralityScore: number;
  sourceDurationSec: number | null;
}

export type EditorResetPlan =
  | { noop: true }
  | {
      noop: false;
      original: EditorDocument;
      effective: ReturnType<typeof getEffectiveClipTiming>;
      boundariesChanged: boolean;
      durationOptimalityScore: number;
      tiktokScore: number;
      youtubeScore: number;
      instagramScore: number;
      /** The full document a real reset would write, schema-parsed so a
       *  JSON.stringify comparison against another schema-parsed document is
       *  a valid deep-equality check (stable key order). Lets callers detect
       *  "this reset would be a true no-op" (e.g. pressing Reset again right
       *  after a reset already landed) without duplicating the shape here. */
      plannedDocument: EditorDocument;
    };

/**
 * Pure planning step for Reset-to-original (docs/plans/vizard-parity.md Phase
 * A step 4): decides whether resetting is a no-op (no revision-zero snapshot
 * was ever captured — the clip's current state already IS the original) and,
 * when not, recomputes effective timing for the ORIGINAL window exactly like
 * updateClipBoundaries so the restored bounds stay consistent with the
 * transcript. Kept side-effect-free (no Prisma) so it's unit-testable on its
 * own — resetClipEditorToOriginal below only adds the guarded transaction and
 * asset cleanup around this decision.
 */
export function planEditorReset(input: EditorResetPlanInput): EditorResetPlan {
  if (!input.editorOriginal) {
    return { noop: true };
  }

  const original = editorDocumentSchema.parse(input.editorOriginal);
  const effective = getEffectiveClipTiming({
    utterances: original.transcriptSlice,
    startSec: original.clipStartSec,
    endSec: original.clipEndSec,
    sourceDurationSec: input.sourceDurationSec,
    tailPadSec: 0,
  });
  const boundariesChanged =
    Math.abs(effective.startSec - input.currentStartSec) >
      RESET_BOUNDARY_EPSILON_SEC ||
    Math.abs(effective.endSec - input.currentEndSec) >
      RESET_BOUNDARY_EPSILON_SEC;
  const durationSec = effective.durationSec;

  const plannedDocument = editorDocumentSchema.parse({
    clipStartSec: effective.startSec,
    clipEndSec: effective.endSec,
    captionPreset: original.captionPreset,
    transcriptSlice: effective.transcriptSlice,
    studioEdits: original.studioEdits,
    brollUrl: original.brollUrl,
    deletedRanges: normalizeDeletedRanges(original.deletedRanges, {
      startSec: effective.startSec,
      endSec: effective.endSec,
    }),
  });

  return {
    noop: false,
    original,
    effective,
    boundariesChanged,
    durationOptimalityScore: computeDurationOptimality(durationSec),
    tiktokScore: computePlatformScore(input.viralityScore, durationSec, "tiktok"),
    youtubeScore: computePlatformScore(
      input.viralityScore,
      durationSec,
      "youtube",
    ),
    instagramScore: computePlatformScore(
      input.viralityScore,
      durationSec,
      "instagram",
    ),
    plannedDocument,
  };
}

const SAVE_BOUNDARY_EPSILON_SEC = 0.001;

export interface EditorDocumentBoundaryClampResult {
  /** `document` with transcriptSlice/clipStartSec/clipEndSec/deletedRanges
   *  reconciled to the STORED clip window — never the recomputed one. */
  document: EditorDocument;
  /** True when `getEffectiveClipTiming` would have moved the boundaries had
   *  its result been adopted verbatim — purely diagnostic (logged by the
   *  caller), since the returned document is clamped either way. */
  boundaryDriftDetected: boolean;
  /** The window `getEffectiveClipTiming` computed from the incoming
   *  transcriptSlice, kept only for logging. */
  recomputedEffective: EffectiveClipTiming;
}

/**
 * Phase A `saveClipEditorDocument` PUT boundary-immutability guard for
 * transcript edits. `getEffectiveClipTiming` (the same primitive
 * `updateClipTranscriptSlice`/`updateClipBoundaries` use to autofit
 * boundaries around a transcript) can WIDEN the window past the clip's own
 * stored bounds when an incoming word overlaps the edge — e.g. a word timed
 * 5-12s submitted against a stored 10-20s clip recomputes `startSec` to 5.
 * Adopting that recomputed window from inside the endpoint that otherwise
 * 422s on any boundary change would silently move boundaries through a side
 * door, with no proxy invalidation to match.
 *
 * This clamps instead: the transcript is normalized to
 * `[clip.startSec, clip.endSec]` with `normalizeTranscriptSliceForClip` —
 * the exact primitive `getEffectiveClipTiming` uses internally for the
 * clamp step — so a straddling word is trimmed/dropped exactly as it would
 * be anywhere else, but the persisted clip boundaries never move through
 * this endpoint. Kept side-effect-free and exported so the 5-12-word
 * scenario is directly unit-testable (mirrors `planEditorReset`'s role for
 * reset).
 *
 * In-studio trim (vizard-parity.md Phase B step 13) reuses this SAME
 * function for the opposite situation: when `saveClipEditorDocument`
 * detects a DELIBERATE boundary change, it calls this with the document's
 * OWN new bounds (not the stored `clip.startSec/endSec`) as the `clip`
 * argument — "clamp to the stored window" becomes "clamp to the window the
 * client just committed to", the exact same normalize-transcript-and-
 * deletedRanges behavior, just pointed at a different target window. The
 * `boundaryDriftDetected` diagnostic is meaningless in that case (the
 * window IS the new window by construction) and the caller ignores it.
 */
export function clampEditorDocumentToStoredWindow(
  document: EditorDocument,
  clip: { startSec: number; endSec: number },
): EditorDocumentBoundaryClampResult {
  const recomputedEffective = getEffectiveClipTiming({
    utterances: document.transcriptSlice,
    startSec: clip.startSec,
    endSec: clip.endSec,
    tailPadSec: 0,
  });
  const boundaryDriftDetected =
    Math.abs(recomputedEffective.startSec - clip.startSec) >
      SAVE_BOUNDARY_EPSILON_SEC ||
    Math.abs(recomputedEffective.endSec - clip.endSec) >
      SAVE_BOUNDARY_EPSILON_SEC;

  return {
    document: {
      ...document,
      clipStartSec: clip.startSec,
      clipEndSec: clip.endSec,
      transcriptSlice: normalizeTranscriptSliceForClip(
        document.transcriptSlice,
        clip.startSec,
        clip.endSec,
      ),
      deletedRanges: normalizeDeletedRanges(document.deletedRanges, {
        startSec: clip.startSec,
        endSec: clip.endSec,
      }),
    },
    boundaryDriftDetected,
    recomputedEffective,
  };
}

export interface EditorDocumentSavePlanInput {
  /** The incoming payload's `document`, already schema-parsed. */
  document: EditorDocument;
  /** `buildEditorDocumentFromClip(clip)` — the document as currently stored. */
  current: EditorDocument;
  /** `{ startSec: clip.startSec, endSec: clip.endSec }` — the clip's
   *  STORED window before this save. */
  storedWindow: ClipWindow;
  /** `project.sourceDurationSeconds`, or null when unknown (never blocks a
   *  trim on its own — only an END past a KNOWN source length is rejected). */
  sourceDurationSec: number | null;
  /** `clip.viralityScore` — only read when boundaries actually change (the
   *  duration-dependent scores need it). */
  viralityScore: number;
}

export type EditorDocumentSavePlan =
  | { noop: true }
  | {
      noop: false;
      /** The fully reconciled document to persist. */
      next: EditorDocument;
      boundariesChanged: boolean;
      transcriptChanged: boolean;
      /** Diagnostic only, and only meaningful when `!boundariesChanged` —
       *  see `clampEditorDocumentToStoredWindow`'s doc comment. */
      boundaryDriftDetected: boolean;
      recomputedEffective: EffectiveClipTiming | null;
      /** Set only when `boundariesChanged` — the caller spreads this
       *  directly into the `clip.update` write. Empty otherwise, so an
       *  unchanged-bounds save can never accidentally touch these columns. */
      durationDependentScores:
        | {
            durationOptimalityScore: number;
            tiktokScore: number;
            youtubeScore: number;
            instagramScore: number;
          }
        | Record<string, never>;
    };

/**
 * Pure planning step for `saveClipEditorDocument` (vizard-parity.md Phase B
 * step 13, in-studio trim) — same role `planEditorReset` plays for Reset:
 * every validation, boundary-clamp, and duration-dependent-score decision
 * lives here, side-effect-free and Prisma-free, so it's directly
 * unit-testable without a database. The wrapper method below only adds the
 * guarded transaction, render-asset cleanup, and revision-conflict handling
 * around whatever this returns.
 *
 * Throws `ClipActionError('editor_boundaries_invalid', …)` for a boundary
 * change that fails validation (too short, negative start, or past a known
 * source length) and `ClipActionError('editor_document_empty_timeline', …)`
 * (via `assertEditorDocumentHasRenderableContent`) for deletions that would
 * leave nothing renderable — both map to 422 in route.ts.
 */
export function planEditorDocumentSave(
  input: EditorDocumentSavePlanInput,
): EditorDocumentSavePlan {
  const { document, current, storedWindow, sourceDurationSec, viralityScore } = input;

  const boundariesChanged =
    Math.abs(document.clipStartSec - storedWindow.startSec) >
      SAVE_BOUNDARY_EPSILON_SEC ||
    Math.abs(document.clipEndSec - storedWindow.endSec) > SAVE_BOUNDARY_EPSILON_SEC;

  if (boundariesChanged) {
    // Note: a negative clipStartSec never reaches here — editorDocumentSchema
    // already enforces `.nonnegative()` on both bounds at the payload-parsing
    // boundary (saveEditorDocumentSchema.parse in saveClipEditorDocument), so
    // that's not re-checked; only the two conditions the schema CAN'T express
    // (a relationship between the two bounds, and a comparison against data
    // loaded from the DB) are validated here.
    const requestedDurationSec = document.clipEndSec - document.clipStartSec;
    if (requestedDurationSec < CLIP_MIN_DURATION_SEC - SAVE_BOUNDARY_EPSILON_SEC) {
      throw new ClipActionError(
        "editor_boundaries_invalid",
        `clip must be at least ${CLIP_MIN_DURATION_SEC} seconds`,
      );
    }
    if (
      typeof sourceDurationSec === "number" &&
      document.clipEndSec > sourceDurationSec + SAVE_BOUNDARY_EPSILON_SEC
    ) {
      throw new ClipActionError(
        "editor_boundaries_invalid",
        "clip end is past the end of the source video",
      );
    }
  }

  // The target window this save reconciles the document to: the clip's
  // STORED bounds when boundaries didn't change (unchanged behavior), or the
  // document's own newly-validated bounds when they did — trim deliberately
  // adopts the client's window rather than recomputing one server-side,
  // since the client already built its transcriptSlice against exactly this
  // window (buildTranscriptSliceForWindow).
  const window: ClipWindow = boundariesChanged
    ? { startSec: document.clipStartSec, endSec: document.clipEndSec }
    : storedWindow;

  let next: EditorDocument = {
    ...document,
    clipStartSec: window.startSec,
    clipEndSec: window.endSec,
    deletedRanges: normalizeDeletedRanges(document.deletedRanges, window),
  };

  // Fix #5: reject a save whose normalized deletions leave nothing
  // renderable — the worker would only discover this at render time
  // (buildClipCutPlan's isEmpty guard), after every render variant for this
  // clip has already been failed.
  assertEditorDocumentHasRenderableContent(next.deletedRanges, window);

  const transcriptChanged =
    JSON.stringify(next.transcriptSlice) !== JSON.stringify(current.transcriptSlice);
  let boundaryDriftDetected = false;
  let recomputedEffective: EffectiveClipTiming | null = null;

  if (boundariesChanged) {
    // Clamp-to-DOCUMENT-window: the client already built transcriptSlice for
    // `window`, but this still normalizes it (and deletedRanges) the same
    // way rather than trusting the client blindly — a stale/buggy client
    // sending words past the validated window gets silently trimmed to it,
    // exactly like the unchanged-bounds branch below does against the
    // stored window.
    next = clampEditorDocumentToStoredWindow(next, window).document;
  } else if (transcriptChanged) {
    const clamp = clampEditorDocumentToStoredWindow(next, storedWindow);
    next = clamp.document;
    boundaryDriftDetected = clamp.boundaryDriftDetected;
    recomputedEffective = clamp.recomputedEffective;
  }

  // Both sides are schema-parse output, so serialized comparison is a valid
  // deep-equality check (stable key order, no undefined-vs-missing holes).
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return { noop: true };
  }

  const durationDependentScores = boundariesChanged
    ? (() => {
        const durationSec = next.clipEndSec - next.clipStartSec;
        return {
          durationOptimalityScore: computeDurationOptimality(durationSec),
          tiktokScore: computePlatformScore(viralityScore, durationSec, "tiktok"),
          youtubeScore: computePlatformScore(viralityScore, durationSec, "youtube"),
          instagramScore: computePlatformScore(viralityScore, durationSec, "instagram"),
        };
      })()
    : {};

  return {
    noop: false,
    next,
    boundariesChanged,
    transcriptChanged,
    boundaryDriftDetected,
    recomputedEffective,
    durationDependentScores,
  };
}

// ─── Create clip from selection (vizard-parity.md Phase B step 14) ─────────

/** Selection range handed to {@link planCreateClipFromSelection}. */
export interface CreateClipFromSelectionPlanInput {
  /** Full RAW project transcript utterances — the same
   *  `project.transcript.utterancesJson` `updateClipBoundaries` reads, NOT
   *  just the source clip's own slice (expanding to the minimum duration can
   *  reach words outside the source clip's current window). */
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
  transcriptSlice: TranscriptUtterance[],
): { title: string; hookText: string } {
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
 * Pure planning step for "Create clip" from a transcript selection
 * (vizard-parity.md Phase B step 14): the selection toolbar's alternative to
 * a duplicate+retrim chain, which this deliberately is NOT — chaining
 * `duplicateClip` (which copies render/proxy assets for the OLD window) with
 * a boundary update (which then deletes those assets once bounds move to the
 * selection's window) is a plan-forbidden pattern that can orphan copied
 * objects on partial failure (plan constraint #7). This computes a brand-new
 * clip's window and all of its duration-dependent state in one side-effect-
 * free step, so `createClipFromSelection` below only adds the guarded DB
 * write around a decision that's independently unit-testable — same shape as
 * `planEditorReset`/`planEditorDocumentSave` above.
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
  const sentenceUtterances = splitUtterancesIntoSentences(input.rawUtterances ?? []);
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
    endSec = Math.max(tokens[endIndex]!.endSec, startSec + CLIP_MIN_DURATION_SEC);
  }

  startSec = roundSec(Math.max(0, Math.min(startSec, sourceDurationSec)));
  endSec = roundSec(Math.max(startSec, Math.min(endSec, sourceDurationSec)));

  const transcriptSlice = buildTranscriptSliceForWindow(input.rawUtterances ?? [], {
    startSec,
    endSec,
  });

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
    instagramScore: computePlatformScore(viralityScore, durationSec, "instagram"),
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
      ].filter((key): key is string => Boolean(key)),
    ),
  ];
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

async function deleteRenderAssets(storageKeys: string[]) {
  const uniqueKeys = [...new Set(storageKeys.filter(Boolean))];

  if (uniqueKeys.length === 0) {
    return;
  }

  await Promise.allSettled(uniqueKeys.map((key) => deleteObject(key)));
}

export class ClipService {
  async persistDetectedClips(
    projectId: string,
    workflowRunId: string,
    clips: DetectedClip[],
    llmMeta: LlmMeta,
    contentPack?: ContentPack | null,
  ) {
    const prisma = requirePrisma();
    const [staleRenderKeys, project] = await Promise.all([
      prisma.clipRender.findMany({
        where: {
          clip: { projectId },
          storageKey: { not: null },
        },
        select: { storageKey: true },
      }),
      prisma.project.findUnique({
        where: { id: projectId },
        select: { brandSnapshot: true },
      }),
    ]);

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

    await prisma.$transaction(async (tx) => {
      await tx.clip.deleteMany({ where: { projectId } });

      if (clips.length > 0) {
        await tx.clip.createMany({
          data: clips.map((clip, i) => ({
            projectId,
            workflowRunId,
            index: i,
            startSec: clip.startSec,
            endSec: clip.endSec,
            title: clip.title,
            hookText: clip.hookText,
            payoffText: clip.payoffText,
            reasoning: clip.reasoning,
            category: clip.category,
            platformFit: clip.platformFit,
            transcriptSlice:
              clip.transcriptSlice as unknown as Prisma.InputJsonValue,
            brollCues:
              clip.brollCues && clip.brollCues.length > 0
                ? (clip.brollCues as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            captionPreset: resolvedCaptionPreset
              ? (resolvedCaptionPreset as unknown as Prisma.InputJsonValue)
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
          })),
        });
      }
    });

    await deleteRenderAssets(
      staleRenderKeys
        .map((render) => render.storageKey)
        .filter((key): key is string => Boolean(key)),
    );
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

  async updateClipBoundaries(
    userId: string,
    projectId: string,
    clipId: string,
    input: { startSec: number; endSec: number },
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: {
        id: clipId,
        projectId,
        project: { userId },
      },
      include: {
        project: {
          include: { transcript: true },
        },
        renders: true,
      },
    });

    if (!clip) {
      throw new Error("clip not found");
    }

    const storedUtterances = clip.project.transcript?.utterancesJson as
      | TranscriptUtterance[]
      | null;
    // Re-split defensively: transcripts stored before sentence-level
    // normalization hold whole speaker turns, whose utterance-end fallback
    // would let boundary expansion overshoot by minutes.
    const utterances = splitUtterancesIntoSentences(storedUtterances ?? []);
    const effective = getEffectiveClipTiming({
      utterances,
      startSec: input.startSec,
      endSec: input.endSec,
      sourceDurationSec: clip.project.sourceDurationSeconds,
    });
    const newSlice = storedUtterances ? effective.transcriptSlice : [];

    const durationSec = effective.durationSec;
    const durationOptimalityScore = computeDurationOptimality(durationSec);

    const tiktokScore = computePlatformScore(
      clip.viralityScore,
      durationSec,
      "tiktok",
    );
    const youtubeScore = computePlatformScore(
      clip.viralityScore,
      durationSec,
      "youtube",
    );
    const instagramScore = computePlatformScore(
      clip.viralityScore,
      durationSec,
      "instagram",
    );

    const staleRenderKeys = [
      ...clip.renders.map((render) => render.storageKey),
      // The old-window preview proxy is orphaned once boundaries move.
      clip.previewStorageKey,
    ].filter((key): key is string => Boolean(key));

    const updated = await prisma.$transaction(async (tx) => {
      await tx.clipRender.deleteMany({
        where: { clipId },
      });

      return tx.clip.update({
        where: { id: clipId },
        data: {
          startSec: effective.startSec,
          endSec: effective.endSec,
          status: "edited",
          transcriptSlice: newSlice as unknown as Prisma.InputJsonValue,
          durationOptimalityScore,
          tiktokScore,
          youtubeScore,
          instagramScore,
          // The preview proxy covers the OLD window (±4s); new boundaries can
          // fall outside it entirely. Null it so the preview backfill worker
          // cuts a fresh proxy for the new window.
          previewStorageKey: null,
          previewStartSec: null,
          previewDurationSec: null,
          // Document-owned columns (startSec/transcriptSlice) are also
          // writable through the revisioned editor document
          // (saveClipEditorDocument) — every mutator that touches them must
          // bump editorRevision so a concurrent studio PUT conflicts (409)
          // instead of silently clobbering this write, and so it doesn't get
          // captured as the eventual editorOriginal snapshot on the next
          // first-save.
          editorRevision: { increment: 1 },
        },
        include: {
          renders: true,
        },
      });
    });

    await deleteRenderAssets(staleRenderKeys);

    return toClipSnapshot(updated);
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
        transcriptSlice: true,
        // The transcript's detected language, stated verbatim in the prompt.
        // Without it the model infers a language from a ~400-character slice and
        // drifts: an English NVIDIA interview came back with Spanish titles, one
        // of them splicing in a Devanagari word. Same source of truth the
        // content suite already uses for exactly this reason.
        project: {
          select: { transcript: { select: { languageCode: true } } },
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

    const utterances =
      (clip.transcriptSlice as unknown as TranscriptUtterance[] | null) ?? [];
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

    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
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
      include: { renders: true },
    });

    if (!source) {
      throw new ClipActionError("clip_not_found", "clip not found");
    }

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
    const previewDestinationKey = source.previewStorageKey
      ? clipDuplicatePreviewStorageKey(projectId, newClipId, randomUUID())
      : null;

    const [renderResults, previewCopied] = await Promise.all([
      Promise.all(
        completedRenders.map(async (render) => {
          const aspectRatio = clipAspectRatioFromDb[
            clipAspectRatioDbSchema.parse(render.aspectRatio)
          ];
          const destinationKey = clipDuplicateRenderStorageKey(
            projectId,
            newClipId,
            aspectRatio,
          );

          try {
            await copyObject({
              sourceKey: render.storageKey as string,
              destinationKey,
            });
            return { render, destinationKey };
          } catch (error) {
            // One unusable variant must not sink the duplicate — the row is the
            // thing being copied. Logged, then dropped from the new clip.
            console.warn(
              JSON.stringify({
                level: "warn",
                message: "clip_duplicate_render_copy_failed",
                clipId,
                newClipId,
                aspectRatio,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
            return null;
          }
        }),
      ),
      (async () => {
        if (!source.previewStorageKey || !previewDestinationKey) return false;
        try {
          await copyObject({
            sourceKey: source.previewStorageKey,
            destinationKey: previewDestinationKey,
          });
          return true;
        } catch (error) {
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "clip_duplicate_preview_copy_failed",
              clipId,
              newClipId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          return false;
        }
      })(),
    ]);

    const copiedRenders: Array<{
      render: ClipRender;
      destinationKey: string;
    }> = renderResults.filter(
      (result): result is { render: ClipRender; destinationKey: string } =>
        result !== null,
    );
    const previewStorageKey = previewCopied ? previewDestinationKey : null;
    const copiedKeys = [
      ...copiedRenders.map((copied) => copied.destinationKey),
      ...(previewStorageKey ? [previewStorageKey] : []),
    ];

    try {
      const created = await prisma.$transaction(async (tx) => {
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
            // A duplicate is a fresh starting point for edits.
            status: "detected",
            startSec: source.startSec,
            endSec: source.endSec,
            title: source.title,
            hookText: source.hookText,
            payoffText: source.payoffText,
            reasoning: source.reasoning,
            category: source.category,
            platformFit: source.platformFit,
            transcriptSlice: source.transcriptSlice as Prisma.InputJsonValue,
            captionPreset:
              source.captionPreset === null
                ? Prisma.JsonNull
                : (source.captionPreset as Prisma.InputJsonValue),
            brollUrl: source.brollUrl,
            studioEdits:
              source.studioEdits === null
                ? Prisma.JsonNull
                : (source.studioEdits as Prisma.InputJsonValue),
            brollCues:
              source.brollCues === null
                ? Prisma.JsonNull
                : (source.brollCues as Prisma.InputJsonValue),
            previewStorageKey,
            previewStartSec: previewStorageKey ? source.previewStartSec : null,
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
            })),
          });
        }

        return clip;
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
      // The row never landed, so nothing references the objects just copied —
      // clean them up rather than leaking them.
      await deleteRenderAssets(copiedKeys);
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
   * `captionPreset`/`studioEdits`/`brollUrl` ARE copied from the source clip
   * (Vizard: the new clip inherits the source's "look"); everything else —
   * boundaries, transcript slice, title/hook, duration-dependent scores —
   * comes straight from `planCreateClipFromSelection`, which also owns the
   * snap/expand/clamp/reject policy (see its own doc comment).
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
          captionPreset: true,
          studioEdits: true,
          brollUrl: true,
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

    const rawUtterances =
      (project.transcript?.utterancesJson as TranscriptUtterance[] | null) ?? [];

    const plan = planCreateClipFromSelection({
      rawUtterances,
      sourceDurationSec: project.sourceDurationSeconds,
      startSec: input.startSec,
      endSec: input.endSec,
    });

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
            startSec: plan.startSec,
            endSec: plan.endSec,
            title: plan.title,
            hookText: plan.hookText,
            payoffText: null,
            reasoning: "Created from a transcript selection in the studio.",
            category: "quote",
            transcriptSlice:
              plan.transcriptSlice as unknown as Prisma.InputJsonValue,
            captionPreset:
              source.captionPreset === null
                ? Prisma.JsonNull
                : (source.captionPreset as Prisma.InputJsonValue),
            brollUrl: source.brollUrl,
            studioEdits:
              source.studioEdits === null
                ? Prisma.JsonNull
                : (source.studioEdits as Prisma.InputJsonValue),
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
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: {
        id: true,
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

    if (!clip) {
      throw new ClipActionError("clip_not_found", "clip not found");
    }

    if (clip.socialPosts.length > 0) {
      throw new ClipActionError(
        "clip_has_scheduled_posts",
        `clip has ${clip.socialPosts.length} scheduled or publishing social post(s)`,
      );
    }

    const storageKeys = planClipStorageDeletion({
      previewStorageKey: clip.previewStorageKey,
      renderStorageKeys: clip.renders.map((render) => render.storageKey),
      dubStorageKeys: clip.dubs.flatMap((dub) => [
        dub.audioStorageKey,
        dub.renderStorageKey,
      ]),
    });

    // Objects first: a failed row delete leaves keys already gone (the row is
    // then re-deletable), whereas a failed object delete after the row is gone
    // leaks bytes nothing references. Same ordering as project deletion.
    await deleteRenderAssets(storageKeys);

    try {
      await prisma.clip.delete({ where: { id: clipId } });
    } catch (error) {
      throw new ClipActionError(
        "clip_delete_failed",
        error instanceof Error ? error.message : "clip delete failed",
      );
    }
  }

  async regenerateClips(
    userId: string,
    projectId: string,
    idempotencyKey: string,
    contentPack?: ContentPack,
  ) {
    const prisma = requirePrisma();
    const parsedContentPack = contentPack
      ? contentPackSchema.parse(contentPack)
      : null;

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
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
    await projectService.assertProjectGenerationAllowed(userId, projectId);

    const existing = await prisma.workflowRun.findFirst({
      where: {
        projectId,
        stage: "moment_detection",
        status: { in: ["queued", "running"] },
      },
    });

    if (existing) {
      return {
        workflowRunId: existing.id,
        acceptedAt: existing.updatedAt.toISOString(),
        initialSeq: await getLastWorkflowSeq(projectId),
      };
    }

    const workflowRunId = randomUUID();

    await prisma.$transaction(async (tx) => {
      if (parsedContentPack) {
        await tx.contentPack.create({
          data: {
            projectId,
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
          },
        });
      }

      await tx.workflowRun.create({
        data: {
          id: workflowRunId,
          projectId,
          idempotencyKey,
          stage: "moment_detection",
          status: "queued",
          progress: 0,
        },
      });
    });

    const event = await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId,
      workflowRunId,
      stage: "moment_detection",
      status: "queued",
      progress: 0,
      errorCode: null,
    });

    return {
      workflowRunId,
      acceptedAt: event?.emittedAt ?? new Date().toISOString(),
      initialSeq: event?.seq ?? 0,
    };
  }

  async triggerClipRendering(
    userId: string,
    projectId: string,
    idempotencyKey: string,
    clipIds?: string[],
    aspectRatios?: ClipAspectRatio[],
  ) {
    const prisma = requirePrisma();
    const requestedAspectRatios = normalizeAspectRatios(aspectRatios);
    const requestedAspectRatioDbValues = requestedAspectRatios.map(
      (aspectRatio) => clipAspectRatioToDb[aspectRatio],
    );

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
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
            data: getClipRenderResetData(),
          }),
        );
      }
    }

    if (createOperations.length > 0 || updateOperations.length > 0) {
      await prisma.$transaction([...createOperations, ...updateOperations]);
    }

    const existingWorkflowRun = await prisma.workflowRun.findFirst({
      where: {
        projectId,
        stage: "clip_rendering",
        status: { in: ["queued", "running"] },
      },
    });

    if (existingWorkflowRun) {
      return {
        workflowRunId: existingWorkflowRun.id,
        acceptedAt: existingWorkflowRun.updatedAt.toISOString(),
        initialSeq: await getLastWorkflowSeq(projectId),
        clipCount: clipsToRender.length,
        variantCount: clipsToRender.length * requestedAspectRatios.length,
      };
    }

    const workflowRunId = randomUUID();

    try {
      await prisma.workflowRun.create({
        data: {
          id: workflowRunId,
          projectId,
          idempotencyKey,
          stage: "clip_rendering",
          status: "queued",
          progress: 0,
        },
      });
    } catch (error) {
      // Partial unique index: one live clip_rendering run per project. Losing
      // this race means another caller just created the run — reuse it; the
      // pending variants written above are picked up by whichever run runs.
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const liveRun = await prisma.workflowRun.findFirst({
        where: {
          projectId,
          stage: "clip_rendering",
          status: { in: ["queued", "running"] },
        },
      });
      if (!liveRun) {
        throw error;
      }
      return {
        workflowRunId: liveRun.id,
        acceptedAt: liveRun.updatedAt.toISOString(),
        initialSeq: await getLastWorkflowSeq(projectId),
        clipCount: clipsToRender.length,
        variantCount: clipsToRender.length * requestedAspectRatios.length,
      };
    }

    const event = await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId,
      workflowRunId,
      stage: "clip_rendering",
      status: "queued",
      progress: 0,
      errorCode: null,
    });

    return {
      workflowRunId,
      acceptedAt: event?.emittedAt ?? new Date().toISOString(),
      initialSeq: event?.seq ?? 0,
      clipCount: clipsToRender.length,
      variantCount: clipsToRender.length * requestedAspectRatios.length,
    };
  }

  async getPendingClipRendersForProject(projectId: string) {
    const prisma = requirePrisma();
    const renders = await prisma.clipRender.findMany({
      where: {
        status: "pending",
        clip: { projectId },
      },
      include: {
        clip: true,
      },
    });

    return renders.sort((left, right) => {
      if (left.clip.index !== right.clip.index) {
        return left.clip.index - right.clip.index;
      }

      const leftAspectRatio = clipAspectRatioFromDb[
        clipAspectRatioDbSchema.parse(left.aspectRatio)
      ];
      const rightAspectRatio = clipAspectRatioFromDb[
        clipAspectRatioDbSchema.parse(right.aspectRatio)
      ];

      return (
        (aspectRatioOrder.get(leftAspectRatio) ?? Number.MAX_SAFE_INTEGER) -
        (aspectRatioOrder.get(rightAspectRatio) ?? Number.MAX_SAFE_INTEGER)
      );
    });
  }

  async markClipRenderVariantRendering(clipRenderId: string) {
    const prisma = requirePrisma();

    // updateMany: an editor save/reset can deleteMany this row while the
    // encode is queued — a vanished row is a no-op, not a P2025 crash.
    await prisma.clipRender.updateMany({
      where: { id: clipRenderId },
      data: {
        status: "rendering",
        startedAt: new Date(),
        errorCode: null,
      },
    });
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

    const claim = await prisma.clipRender.updateMany({
      where: { id: clipRenderId },
      data: {
        status: "completed",
        storageKey: input.storageKey,
        sizeBytes: BigInt(input.sizeBytes),
        durationSec: input.durationSec,
        errorCode: null,
        completedAt: new Date(),
      },
    });

    if (claim.count === 0) {
      return { persisted: false };
    }

    const render = await prisma.clipRender.findUniqueOrThrow({
      where: { id: clipRenderId },
      include: { clip: { select: { projectId: true } } },
    });

    await analyticsService.recordProjectEvent({
      projectId: render.clip.projectId,
      clipId: render.clipId,
      type: "render_completed",
      metadata: { aspectRatio: render.aspectRatio },
    });

    // Incremental delivery: nudge the project's live stream as soon as this
    // individual clip's render lands, instead of only on the run's overall
    // completed/failed transition — see project-events.tsx's throttled
    // refresh-on-progress handling.
    await this.pingActiveWorkflowRun(render.clip.projectId);

    return { persisted: true };
  }

  async failClipRenderVariant(clipRenderId: string, errorCode: string) {
    const prisma = requirePrisma();

    // updateMany for the same deleted-mid-render reason as
    // markClipRenderVariantRendering above.
    await prisma.clipRender.updateMany({
      where: { id: clipRenderId },
      data: {
        status: "failed",
        errorCode,
      },
    });
  }

  /** Queues a fresh clip_rendering run for variants that were added while a
   *  now-completed run was already rendering (the one-live-run guard absorbed
   *  their trigger, but that run had already snapshotted its work). Keyed to
   *  the completed run so a crashed retry of the same completion can't queue
   *  twice; a P2002 from the one-live-run index means another live run
   *  already exists and will pick the variants up. */
  async queueFollowUpRenderRun(projectId: string, completedRunId: string) {
    const prisma = requirePrisma();
    const workflowRunId = randomUUID();

    try {
      await prisma.workflowRun.create({
        data: {
          id: workflowRunId,
          projectId,
          idempotencyKey: `drain-${completedRunId}`,
          stage: "clip_rendering",
          status: "queued",
          progress: 0,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return;
      }
      throw error;
    }

    await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId,
      workflowRunId,
      stage: "clip_rendering",
      status: "queued",
      progress: 0,
      errorCode: null,
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
        clip: {
          projectId,
          project: { userId },
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
   * Resolves a presigned URL for a clip's preview proxy (if one has been
   * generated yet) for the studio editor. Returns nulls when no proxy
   * exists so the caller can fall back to the full source. Kept separate
   * from {@link getClipDownloadUrl} because the studio has no aspect-ratio
   * selector to key a render lookup off of — it always wants "whatever
   * preview exists for this clip," full stop.
   */
  async getClipPreviewSource(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<{
    previewUrl: string | null;
    previewStartSec: number;
    previewDurationSec: number | null;
  }> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: {
        previewStorageKey: true,
        previewStartSec: true,
        previewDurationSec: true,
      },
    });

    if (!clip?.previewStorageKey) {
      return { previewUrl: null, previewStartSec: 0, previewDurationSec: null };
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
      };
    } catch {
      return { previewUrl: null, previewStartSec: 0, previewDurationSec: null };
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
      const effective = getEffectiveClipTiming({
        utterances: clip.transcriptSlice as unknown as TranscriptUtterance[],
        startSec: clip.startSec,
        endSec: clip.endSec,
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
        where: { projectId, status: { in: ["queued", "running"] } },
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

  async updateClipCaptionPreset(
    userId: string,
    projectId: string,
    clipId: string,
    preset: CaptionPreset | null,
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: {
        id: clipId,
        projectId,
        project: { userId },
      },
    });

    if (!clip) {
      throw new Error("clip not found");
    }

    const updated = await prisma.clip.update({
      where: { id: clipId },
      data: {
        captionPreset: preset !== null ? (preset as Prisma.InputJsonValue) : Prisma.JsonNull,
        // See updateClipBoundaries' comment: captionPreset is document-owned
        // and also writable via saveClipEditorDocument, so this must bump
        // editorRevision too.
        editorRevision: { increment: 1 },
      },
      include: { renders: true },
    });

    return toClipSnapshot(updated);
  }

  /**
   * Sets (or clears, with null) the chosen stock B-roll URL for a clip, and
   * invalidates existing renders — but only when the value actually
   * changed. Mirrors `updateClipStudioEdits`'s no-op guard exactly (see
   * below): the studio can re-PATCH the same B-roll selection (e.g. an
   * autosave tick) without deleting a perfectly-valid completed render.
   */
  async updateClipBroll(
    userId: string,
    projectId: string,
    clipId: string,
    brollUrl: string | null,
  ): Promise<ClipSnapshot> {
    if (brollUrl !== null) {
      assertPublicHttpUrl(brollUrl);
    }

    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      include: { renders: true },
    });
    if (!clip) {
      throw new Error("clip not found");
    }

    if (!brollUrlChanged(clip.brollUrl, brollUrl)) {
      return toClipSnapshot(clip);
    }

    const staleRenderKeys = clip.renders
      .map((render) => render.storageKey)
      .filter((key): key is string => Boolean(key));

    let deletedRenderCount = 0;
    const updated = await prisma.$transaction(async (tx) => {
      const deleted = await tx.clipRender.deleteMany({ where: { clipId } });
      deletedRenderCount = deleted.count;
      return tx.clip.update({
        where: { id: clipId },
        data: {
          brollUrl,
          // See updateClipBoundaries' comment: brollUrl is document-owned
          // and also writable via saveClipEditorDocument.
          editorRevision: { increment: 1 },
        },
        include: { renders: true },
      });
    });

    console.warn(
      JSON.stringify({
        level: "warn",
        message: "clip_broll_changed_invalidated_renders",
        clipId,
        deletedRenderCount,
      }),
    );

    await deleteRenderAssets(staleRenderKeys);

    return toClipSnapshot(updated);
  }

  /**
   * Persists export-affecting studio edits and clears stale renders — but
   * only when the value actually changed. The client autosaves this field on
   * every edit tick regardless of which field changed (see studio-shell.tsx's
   * persistEdits), so without this guard an unrelated change (e.g. picking a
   * different caption preset) would invalidate every completed render and
   * delete its R2 asset.
   */
  async updateClipStudioEdits(
    userId: string,
    projectId: string,
    clipId: string,
    studioEdits: StudioEdits,
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();
    const parsed = studioEditsSchema.parse(studioEdits);

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      include: { renders: true },
    });
    if (!clip) {
      throw new Error("clip not found");
    }

    const existing = clip.studioEdits
      ? studioEditsSchema.parse(clip.studioEdits)
      : studioEditsSchema.parse({});

    // No-op write: both sides are the output of the same schema parse, so
    // comparing the serialized form is a valid deep-equality check (stable
    // key order, no undefined-vs-missing ambiguity).
    if (JSON.stringify(parsed) === JSON.stringify(existing)) {
      return toClipSnapshot(clip);
    }

    const staleRenderKeys = clip.renders
      .map((render) => render.storageKey)
      .filter((key): key is string => Boolean(key));

    let deletedRenderCount = 0;
    const updated = await prisma.$transaction(async (tx) => {
      const deleted = await tx.clipRender.deleteMany({ where: { clipId } });
      deletedRenderCount = deleted.count;
      return tx.clip.update({
        where: { id: clipId },
        data: {
          studioEdits: parsed as unknown as Prisma.InputJsonValue,
          status: "edited",
          // See updateClipBoundaries' comment: studioEdits is document-owned
          // and also writable via saveClipEditorDocument.
          editorRevision: { increment: 1 },
        },
        include: { renders: true },
      });
    });

    console.warn(
      JSON.stringify({
        level: "warn",
        message: "studio_edits_changed_invalidated_renders",
        clipId,
        deletedRenderCount,
      }),
    );

    await deleteRenderAssets(staleRenderKeys);

    return toClipSnapshot(updated);
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
  }> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
    });
    if (!clip) {
      throw new Error("clip not found");
    }

    const document = buildEditorDocumentFromClip(clip);
    const original = clip.editorOriginal
      ? editorDocumentSchema.parse(clip.editorOriginal)
      : document;

    return { revision: clip.editorRevision, document, original };
  }

  /**
   * Atomic, revision-guarded save of the whole editor document — the
   * replacement for the studio's previous three independent PATCHes
   * (captionPreset / transcriptSlice / studioEdits+brollUrl), which had no
   * concurrency control and inconsistent render invalidation (studio edits
   * deleted renders; caption/transcript changes silently did not, leaving
   * stale burned output downloadable).
   *
   * Policy here: ANY export-affecting change (the whole document is
   * export-affecting) invalidates renders in the same transaction as the
   * guarded write. No-op saves are detected by deep-equality and issue zero
   * writes. The first real save captures the revision-zero snapshot.
   *
   * Boundaries (vizard-parity.md Phase B step 13, in-studio trim): a real
   * change is VALIDATED, not rejected — `endSec - startSec` must clear
   * `CLIP_MIN_DURATION_SEC` (the same floor `updateClipBoundariesSchema`
   * enforces for the legacy endpoint, reused here so the two paths can never
   * disagree about how short a clip may get) and the window must lie inside
   * `[0, project.sourceDurationSeconds]` when that's known. A real change
   * follows `updateClipBoundaries`'/`resetClipEditorToOriginal`'s own
   * side-effect pattern: null the preview proxy (its window covered the OLD
   * bounds) and recompute the duration-dependent scores, inside the same
   * guarded transaction that invalidates renders below (every real save
   * already does that regardless of whether bounds moved). When bounds are
   * UNCHANGED, a transcript change is still clamped to the clip's STORED
   * window via `clampEditorDocumentToStoredWindow` exactly as before — NOT
   * recomputed/expanded the way `updateClipTranscriptSlice` does, because a
   * transcriptSlice whose words overlap past the stored edge must never move
   * boundaries through the back door. When bounds DID move, the same
   * function clamps to the DOCUMENT's own new window instead (see its
   * updated doc comment) so a client-sent transcriptSlice/deletedRanges pair
   * can never imply a wider span than what was actually validated above.
   */
  async saveClipEditorDocument(
    userId: string,
    projectId: string,
    clipId: string,
    payload: SaveEditorDocument,
  ): Promise<{ revision: number; document: EditorDocument; clip: ClipSnapshot }> {
    const prisma = requirePrisma();
    const { baseRevision, document } = saveEditorDocumentSchema.parse(payload);
    if (document.brollUrl !== null) {
      assertPublicHttpUrl(document.brollUrl);
    }

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      include: {
        renders: true,
        project: { select: { sourceDurationSeconds: true } },
      },
    });
    if (!clip) {
      throw new Error("clip not found");
    }
    if (clip.editorRevision !== baseRevision) {
      throw new ClipEditorRevisionConflictError(clip.editorRevision);
    }

    const current = buildEditorDocumentFromClip(clip);

    const plan = planEditorDocumentSave({
      document,
      current,
      storedWindow: { startSec: clip.startSec, endSec: clip.endSec },
      sourceDurationSec: clip.project.sourceDurationSeconds,
      viralityScore: clip.viralityScore,
    });

    if (plan.noop) {
      return {
        revision: clip.editorRevision,
        document: current,
        clip: toClipSnapshot(clip),
      };
    }

    const { next, boundariesChanged, transcriptChanged, boundaryDriftDetected } = plan;
    if (boundaryDriftDetected && plan.recomputedEffective) {
      // Diagnostic only — the transcript is already clamped to the stored
      // window regardless. Surfaces the cases where a client sent a
      // transcriptSlice implying a wider window than the clip actually has,
      // so it's visible without being able to move boundaries.
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "editor_document_transcript_boundary_drift_clamped",
          clipId,
          storedStartSec: clip.startSec,
          storedEndSec: clip.endSec,
          recomputedStartSec: plan.recomputedEffective.startSec,
          recomputedEndSec: plan.recomputedEffective.endSec,
        }),
      );
    }

    const staleRenderKeys = [
      ...clip.renders.map((render) => render.storageKey),
      // The old-window preview proxy is orphaned once boundaries actually
      // move — same rule as updateClipBoundaries/resetClipEditorToOriginal.
      ...(boundariesChanged ? [clip.previewStorageKey] : []),
    ].filter((key): key is string => Boolean(key));

    let deletedRenderCount = 0;
    const updated = await prisma.$transaction(async (tx) => {
      const guarded = await tx.clip.updateMany({
        where: { id: clipId, editorRevision: baseRevision },
        data: {
          startSec: next.clipStartSec,
          endSec: next.clipEndSec,
          captionPreset: next.captionPreset as unknown as Prisma.InputJsonValue,
          transcriptSlice:
            next.transcriptSlice as unknown as Prisma.InputJsonValue,
          studioEdits: next.studioEdits as unknown as Prisma.InputJsonValue,
          brollUrl: next.brollUrl,
          deletedRanges: next.deletedRanges as unknown as Prisma.InputJsonValue,
          editorRevision: { increment: 1 },
          status: "edited",
          ...plan.durationDependentScores,
          // The proxy covers the OLD window; new boundaries can fall
          // outside it entirely. Null it so the preview backfill worker
          // cuts a fresh proxy for the new window (the client also drops
          // its own previewVideoUrl state immediately on a successful save
          // — see studio-shell.tsx's trim commit handler).
          ...(boundariesChanged
            ? { previewStorageKey: null, previewStartSec: null, previewDurationSec: null }
            : {}),
          // First real save captures the pre-edit state as the immutable
          // revision-zero snapshot; never overwritten afterwards.
          ...(clip.editorOriginal
            ? {}
            : { editorOriginal: current as unknown as Prisma.InputJsonValue }),
        },
      });
      if (guarded.count === 0) {
        return null;
      }
      const deleted = await tx.clipRender.deleteMany({ where: { clipId } });
      deletedRenderCount = deleted.count;
      return tx.clip.findUniqueOrThrow({
        where: { id: clipId },
        include: { renders: true },
      });
    });

    if (!updated) {
      const latest = await prisma.clip.findUnique({
        where: { id: clipId },
        select: { editorRevision: true },
      });
      throw new ClipEditorRevisionConflictError(
        latest?.editorRevision ?? baseRevision + 1,
      );
    }

    console.warn(
      JSON.stringify({
        level: "warn",
        message: "editor_document_saved_invalidated_renders",
        clipId,
        revision: updated.editorRevision,
        deletedRenderCount,
        transcriptChanged,
        boundariesChanged,
      }),
    );

    await deleteRenderAssets(staleRenderKeys);

    return {
      revision: updated.editorRevision,
      document: buildEditorDocumentFromClip(updated),
      clip: toClipSnapshot(updated),
    };
  }

  /**
   * Reset-to-original (docs/plans/vizard-parity.md Phase A step 4): restores
   * the whole editor document — INCLUDING clip boundaries and the transcript
   * slice — from the immutable revision-zero snapshot captured on first save
   * (`Clip.editorOriginal`, see saveClipEditorDocument above). Unlike that
   * method, a boundary change here is the whole point, so this follows
   * updateClipBoundaries' side-effect pattern instead: recompute effective
   * timing for the restored window, null the preview proxy + drop its asset
   * when the window actually moves, and invalidate every render.
   *
   * No-op (zero writes) when no snapshot exists yet — the clip was never
   * saved through the editor document, so its current state already IS the
   * original. That decision is revision-guarded atomically (see the
   * `noOpGuard` below): a first-save committing between the initial read and
   * this check — which is exactly the transition from "no snapshot" to
   * "snapshot exists" — must surface as a 409 conflict, not a stale success
   * that silently skipped a now-possible real reset. Likewise, a second
   * Reset press right after the first one landed (planned document already
   * equals the current one) is also a true zero-write no-op — it must not
   * re-bump editorRevision or delete still-valid renders.
   */
  async resetClipEditorToOriginal(
    userId: string,
    projectId: string,
    clipId: string,
    baseRevision: number,
  ): Promise<{ revision: number; document: EditorDocument; clip: ClipSnapshot }> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      include: {
        project: { select: { sourceDurationSeconds: true } },
        renders: true,
      },
    });
    if (!clip) {
      throw new Error("clip not found");
    }
    assertEditorRevisionMatches(clip.editorRevision, baseRevision);

    const plan = planEditorReset({
      editorOriginal: clip.editorOriginal,
      currentStartSec: clip.startSec,
      currentEndSec: clip.endSec,
      viralityScore: clip.viralityScore,
      sourceDurationSec: clip.project.sourceDurationSeconds,
    });

    if (plan.noop) {
      // Every mutator that can populate `editorOriginal` (only
      // saveClipEditorDocument's first real save) increments editorRevision
      // in the SAME write — that invariant is what makes this guarded
      // no-op update a valid atomic re-check: if it still matches
      // editorRevision: baseRevision, editorOriginal is PROVABLY still null
      // at that instant, even though our own read of it happened earlier
      // and unguarded. The write itself is value-preserving (sets
      // editorRevision back to itself) — no real column changes, so this
      // does not bump the visible revision or invalidate renders.
      const noOpGuard = await prisma.clip.updateMany({
        where: { id: clipId, editorRevision: baseRevision },
        data: { editorRevision: baseRevision },
      });
      if (noOpGuard.count === 0) {
        const latest = await prisma.clip.findUnique({
          where: { id: clipId },
          select: { editorRevision: true },
        });
        throw new ClipEditorRevisionConflictError(
          latest?.editorRevision ?? baseRevision + 1,
        );
      }
      return {
        revision: clip.editorRevision,
        document: buildEditorDocumentFromClip(clip),
        clip: toClipSnapshot(clip),
      };
    }

    // Fix (MEDIUM, no-op reset): pressing Reset again after the first reset
    // already landed must be a true zero-write no-op — no revision bump, no
    // render invalidation — not just a shortcut for the "never saved" case
    // above. Same deep-equality pattern saveClipEditorDocument uses (both
    // sides are schema-parse output, so serialized comparison is a valid
    // check).
    const currentDocument = buildEditorDocumentFromClip(clip);
    if (
      JSON.stringify(plan.plannedDocument) === JSON.stringify(currentDocument)
    ) {
      return {
        revision: clip.editorRevision,
        document: currentDocument,
        clip: toClipSnapshot(clip),
      };
    }

    const { original, effective, boundariesChanged } = plan;
    const staleRenderKeys = [
      ...clip.renders.map((render) => render.storageKey),
      // The old-window preview proxy is orphaned once boundaries move —
      // same rule as updateClipBoundaries.
      ...(boundariesChanged ? [clip.previewStorageKey] : []),
    ].filter((key): key is string => Boolean(key));

    let deletedRenderCount = 0;
    const updated = await prisma.$transaction(async (tx) => {
      const guarded = await tx.clip.updateMany({
        where: { id: clipId, editorRevision: baseRevision },
        data: {
          startSec: effective.startSec,
          endSec: effective.endSec,
          captionPreset: original.captionPreset as unknown as Prisma.InputJsonValue,
          transcriptSlice:
            effective.transcriptSlice as unknown as Prisma.InputJsonValue,
          studioEdits: original.studioEdits as unknown as Prisma.InputJsonValue,
          brollUrl: original.brollUrl,
          deletedRanges: normalizeDeletedRanges(original.deletedRanges, {
            startSec: effective.startSec,
            endSec: effective.endSec,
          }) as unknown as Prisma.InputJsonValue,
          durationOptimalityScore: plan.durationOptimalityScore,
          tiktokScore: plan.tiktokScore,
          youtubeScore: plan.youtubeScore,
          instagramScore: plan.instagramScore,
          status: "edited",
          editorRevision: { increment: 1 },
          ...(boundariesChanged
            ? {
                previewStorageKey: null,
                previewStartSec: null,
                previewDurationSec: null,
              }
            : {}),
        },
      });
      if (guarded.count === 0) {
        return null;
      }
      const deleted = await tx.clipRender.deleteMany({ where: { clipId } });
      deletedRenderCount = deleted.count;
      return tx.clip.findUniqueOrThrow({
        where: { id: clipId },
        include: { renders: true },
      });
    });

    if (!updated) {
      const latest = await prisma.clip.findUnique({
        where: { id: clipId },
        select: { editorRevision: true },
      });
      throw new ClipEditorRevisionConflictError(
        latest?.editorRevision ?? baseRevision + 1,
      );
    }

    console.warn(
      JSON.stringify({
        level: "warn",
        message: "editor_document_reset_to_original",
        clipId,
        revision: updated.editorRevision,
        deletedRenderCount,
        boundariesChanged,
      }),
    );

    await deleteRenderAssets(staleRenderKeys);

    return {
      revision: updated.editorRevision,
      document: buildEditorDocumentFromClip(updated),
      clip: toClipSnapshot(updated),
    };
  }

  /** Applies a caption preset to every clip in an owned project ("apply to all"). */
  async applyCaptionPresetToAllClips(
    userId: string,
    projectId: string,
    preset: CaptionPreset,
  ): Promise<{ updated: number }> {
    const prisma = requirePrisma();

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });
    if (!project) {
      throw new Error("project not found");
    }

    const result = await prisma.clip.updateMany({
      where: { projectId },
      data: {
        captionPreset: preset as Prisma.InputJsonValue,
        // See updateClipBoundaries' comment: captionPreset is document-owned
        // and also writable via saveClipEditorDocument, on every affected
        // row.
        editorRevision: { increment: 1 },
      },
    });

    return { updated: result.count };
  }

  async updateClipTranscriptSlice(
    userId: string,
    projectId: string,
    clipId: string,
    transcriptSlice: TranscriptUtterance[],
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: {
        id: clipId,
        projectId,
        project: { userId },
      },
    });

    if (!clip) {
      throw new Error("clip not found");
    }

    // tailPadSec 0 — slice-only input; stored bounds are final (see
    // toClipSnapshot).
    const effective = getEffectiveClipTiming({
      utterances: transcriptSlice,
      startSec: clip.startSec,
      endSec: clip.endSec,
      tailPadSec: 0,
    });

    const updated = await prisma.clip.update({
      where: { id: clipId },
      data: {
        startSec: effective.startSec,
        endSec: effective.endSec,
        transcriptSlice: effective.transcriptSlice as unknown as Prisma.InputJsonValue,
        status: "edited",
        // See updateClipBoundaries' comment: startSec/transcriptSlice are
        // document-owned and also writable via saveClipEditorDocument.
        editorRevision: { increment: 1 },
      },
      include: { renders: true },
    });

    return toClipSnapshot(updated);
  }

  async autoQueueDefaultRenders(
    projectId: string,
    detectionWorkflowRunId: string,
    aspectRatio: ClipAspectRatio = "9:16",
  ): Promise<void> {
    const prisma = requirePrisma();

    const clips = await prisma.clip.findMany({
      where: { projectId },
      select: { id: true },
    });

    if (clips.length === 0) {
      return;
    }

    const aspectRatioDb = clipAspectRatioToDb[aspectRatio];
    const clipIds = clips.map((c) => c.id);

    const existingRenders = await prisma.clipRender.findMany({
      where: {
        clipId: { in: clipIds },
        aspectRatio: aspectRatioDb,
        status: { in: ["pending", "rendering"] },
      },
      select: { clipId: true },
    });

    const alreadyQueued = new Set(existingRenders.map((r) => r.clipId));
    const toCreate = clipIds.filter((id) => !alreadyQueued.has(id));

    if (toCreate.length > 0) {
      await prisma.clipRender.createMany({
        data: toCreate.map((clipId) => ({
          clipId,
          aspectRatio: aspectRatioDb,
          status: "pending" as const,
        })),
        skipDuplicates: true,
      });
    }

    const existingWorkflowRun = await prisma.workflowRun.findFirst({
      where: {
        projectId,
        stage: "clip_rendering",
        status: { in: ["queued", "running"] },
      },
    });

    if (existingWorkflowRun) {
      return;
    }

    const workflowRunId = randomUUID();

    try {
      await prisma.workflowRun.create({
        data: {
          id: workflowRunId,
          projectId,
          idempotencyKey: `auto-render-${detectionWorkflowRunId}`,
          stage: "clip_rendering",
          status: "queued",
          progress: 0,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      // Two distinct uniques can fire here: the one-live-run partial index (a
      // concurrent trigger created the live run first — fine, it picks up the
      // variants written above) or the (projectId, idempotencyKey) unique (a
      // re-run for the same detection whose earlier auto-render run already
      // completed — in that case there is NO live run, so swallowing the
      // error would strand the pending variants).
      const liveRun = await prisma.workflowRun.findFirst({
        where: {
          projectId,
          stage: "clip_rendering",
          status: { in: ["queued", "running"] },
        },
        select: { id: true },
      });
      if (liveRun) {
        return;
      }
      throw error;
    }

    await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId,
      workflowRunId,
      stage: "clip_rendering",
      status: "queued",
      progress: 0,
      errorCode: null,
    });
  }
}

/**
 * Whether a clip's chosen B-roll URL actually changed. Used by
 * `updateClipBroll` to decide whether completed renders need invalidating —
 * exported so the no-op guard is unit-testable without a database.
 */
export function brollUrlChanged(
  current: string | null,
  next: string | null,
): boolean {
  return current !== next;
}

// --- Scoring utilities ---

export function sliceTranscriptForClip(
  utterances: TranscriptUtterance[],
  startSec: number,
  endSec: number,
): TranscriptUtterance[] {
  return normalizeTranscriptSliceForClip(utterances, startSec, endSec);
}

export function computeDurationOptimality(
  durationSec: number,
  policy: {
    minDurationSec?: number;
    preferredMinDurationSec?: number;
    preferredMaxDurationSec?: number;
    maxDurationSec?: number;
  } = {},
): number {
  const minDurationSec = policy.minDurationSec ?? 15;
  const preferredMinDurationSec = policy.preferredMinDurationSec ?? 30;
  const preferredMaxDurationSec = policy.preferredMaxDurationSec ?? 60;
  const maxDurationSec = policy.maxDurationSec ?? 120;

  if (
    durationSec >= preferredMinDurationSec &&
    durationSec <= preferredMaxDurationSec
  ) {
    return 100;
  }

  if (durationSec >= minDurationSec && durationSec < preferredMinDurationSec) {
    const span = Math.max(1, preferredMinDurationSec - minDurationSec);
    return Math.round(60 + ((durationSec - minDurationSec) / span) * 40);
  }

  if (durationSec > preferredMaxDurationSec && durationSec <= maxDurationSec) {
    const span = Math.max(1, maxDurationSec - preferredMaxDurationSec);
    return Math.round(100 - ((durationSec - preferredMaxDurationSec) / span) * 60);
  }

  if (durationSec < minDurationSec) {
    return Math.max(20, Math.round((durationSec / minDurationSec) * 60));
  }

  return 20;
}

export function computePacingScore(
  utterances: TranscriptUtterance[],
  durationSec: number,
): number {
  if (durationSec <= 0 || utterances.length === 0) return 50;

  const totalWords = utterances.reduce(
    (sum, u) => sum + u.text.split(/\s+/).length,
    0,
  );
  const wps = totalWords / durationSec;
  // Count actual speaker CHANGES, not utterance rows: utterances are now
  // sentence-sized (a monologue is many rows), so `utterances.length` would
  // inflate "turns" and with it pacing/virality for single-speaker content.
  const speakerTurns = utterances.reduce(
    (turns, utterance, index) =>
      index === 0 || utterance.speaker !== utterances[index - 1]!.speaker
        ? turns + 1
        : turns,
    0,
  );
  const turnsPerMinute = (speakerTurns / durationSec) * 60;

  let score = 50;
  if (wps >= 2 && wps <= 3.5) score += 25;
  else if (wps >= 1.5 && wps < 2) score += 10;
  else if (wps > 3.5 && wps <= 4.5) score += 10;

  if (speakerTurns <= 1) {
    // Monologue: turn cadence carries no signal either way, so award the
    // midpoint rather than structurally penalizing single-speaker content
    // against multi-speaker conversations.
    score += 15;
  } else if (turnsPerMinute >= 4 && turnsPerMinute <= 12) score += 25;
  else if (turnsPerMinute >= 2 && turnsPerMinute < 4) score += 10;
  else if (turnsPerMinute > 12 && turnsPerMinute <= 20) score += 10;

  return Math.min(100, Math.max(1, score));
}

export function computeViralityScore(subScores: {
  hookStrength: number;
  emotionalIntensity: number;
  storyCompleteness?: number;
  pacing: number;
  durationOptimality: number;
}): number {
  return Math.round(
    subScores.hookStrength * 0.3 +
      subScores.emotionalIntensity * 0.22 +
      (subScores.storyCompleteness ?? 50) * 0.18 +
      subScores.pacing * 0.15 +
      subScores.durationOptimality * 0.15,
  );
}

export function computePlatformScore(
  compositeScore: number,
  durationSec: number,
  platform: "tiktok" | "youtube" | "instagram",
): number {
  const idealRanges: Record<string, [number, number]> = {
    tiktok: [15, 60],
    youtube: [30, 90],
    instagram: [15, 45],
  };

  const [minIdeal, maxIdeal] = idealRanges[platform]!;
  let modifier = 0;

  if (durationSec >= minIdeal && durationSec <= maxIdeal) {
    modifier = 10;
  } else if (durationSec < minIdeal) {
    modifier = -Math.round(((minIdeal - durationSec) / minIdeal) * 20);
  } else {
    modifier = -Math.round(((durationSec - maxIdeal) / maxIdeal) * 20);
  }

  return Math.min(100, Math.max(1, compositeScore + modifier));
}

export const clipService = new ClipService();
