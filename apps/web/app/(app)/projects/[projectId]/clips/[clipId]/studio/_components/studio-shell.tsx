"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
} from "react";
import { useRouter } from "next/navigation";
import { Box, Button, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { Monitor } from "lucide-react";
import { toaster } from "@narriflow/ui";
import {
  compositionAssetRef,
  screenLayoutInputFingerprint,
  splitLayoutInputFingerprint,
} from "@narriflow/composition-plan";
import {
  getEffectiveClipTiming,
  clipAutoLayoutMatchesInputs,
  editedToSource,
  normalizeDeletedRanges,
  resolveEffectiveFramingMode,
  SCREEN_LAYOUT_ENGINE_VERSION,
  buildTranscriptSliceForWindow,
  mergeCorrectedWordsIntoWindow,
  type TranscriptUtterance,
  type CaptionPreset,
  type CaptionAnimation,
  type LogoPosition,
  type StudioEdits,
  type EditorDocument,
  type EditedTimeMap,
  type SourceRange,
  type ClipWindow,
  type ClipLayoutAnalysis,
  type ClipLayoutAnalysisFailure,
  type ClipLayoutAnalysisOutcome,
  type ClipAutoLayoutAnalysis,
  type ClipSplitLayoutAnalysis,
  type ClipSplitLayoutFailure,
  type ClipSplitLayoutOutcome,
  type BrollCue,
} from "@narriflow/validators";
import { TopBar } from "./top-bar";
import { TranscriptPanel } from "./transcript-panel";
import { VideoPreview } from "./video-preview";
import { ToolSidebar } from "./tool-sidebar";
import { Timeline } from "./timeline";
import { KeyboardShortcutsModal } from "./keyboard-shortcuts-modal";
import type { PlaybackClock } from "./playback-clock";
import { buildStudioCutPlan, buildSegmentsFromUtterances,
} from "./edited-timeline";
import { loadTrimTranscript } from "./trim-transcript-cache";
import {
  releaseTimelineThumbnailResources,
  type ThumbnailVideoKind,
} from "./timeline-preview-manager";
import {
  selectStudioCloud,
  selectStudioCanRedo,
  selectStudioCanUndo,
  selectStudioDocument,
  selectStudioDurability,
  selectStudioOwnership,
  selectStudioPlaybackPresentation,
  selectStudioPreview,
  selectStudioRecovery,
  selectStudioSegments,
  selectStudioStatus,
  studioPlaybackPresentationEqual,
  studioPreviewPresentationEqual,
  useStudioEditingSession,
  useStudioSessionSelector,
} from "./studio-editing-session-react";
import type { StudioSessionSnapshot } from "./studio-editing-session";
import { DraftRecoveryDialog } from "./draft-recovery-dialog";
import { StudioWriteLeaseOverlay } from "./studio-write-lease-overlay";
import {
  addSubtitleLineAfter as insertSubtitleLineAfter,
  deleteSubtitleLine as removeSubtitleLine,
  mergeSubtitleLineWithNext as mergeAdjacentSubtitleLines,
  labelForTimelineSegment,
  replaceSubtitleLineText,
  replaceSubtitleParagraphText,
} from "./subtitle-lines";
import type { TimelineSegment } from "./studio-types";
import type { CompositionPlanQaFixture } from "./composition-plan-qa-fixture";
import type {
  StudioCompositionPlanStatus,
  StudioExportState,
} from "./studio-export-policy";
import {
  authenticatedRequestFailureMessage,
  isAuthenticatedActionFailure,
  type BrowserRequestFailure,
} from "@/lib/authenticated-request-browser";

class StudioExportRequestError extends Error {
  constructor(
    readonly code: "editor_revision_conflict" | "export_queue_failed",
  ) {
    super(code);
    this.name = "StudioExportRequestError";
  }
}

type StudioAuthenticatedActionFailure = BrowserRequestFailure & {
  ok: false;
  error: string;
  code: string;
  requestId: string;
};

function unwrapStudioActionResult<T>(
  result: T | StudioAuthenticatedActionFailure,
): T {
  if (isAuthenticatedActionFailure(result)) {
    throw new Error(
      authenticatedRequestFailureMessage(
        result,
        window.location.pathname,
        "Studio access changed. Refresh before continuing.",
      ),
    );
  }
  return result as T;
}

/**
 * Below this width the transcript panel has already hidden (it collapses
 * under 1024px) and the 260px fixed inspector has nowhere left to go — the
 * three-pane editor stops being usable well before typical phone/small-tablet
 * widths. Gate it with an explicit message instead of shipping a silently
 * broken layout.
 */
const STUDIO_MIN_VIEWPORT_WIDTH = 900;

const TIMELINE_SNAP_THRESHOLD_SEC = 0.25;

/** Shared guard for `deleteSelectedSegment` (timeline), `deleteSourceRange`
 *  (transcript selection, Phase B step 11), and `applyRemoveSilence` (Phase
 *  B step 12, which passes the whole batch of detected ranges at once):
 *  mirrors the worker's render-time `isEmpty` check (`cut-plan.ts`) so a
 *  delete that would leave nothing renderable is rejected client-side
 *  before it's ever dispatched, instead of discovered later as a failed
 *  render. Pure/module-level so every caller shares one implementation
 *  rather than duplicating the normalize-then-check sequence. */
function computeDeleteCandidate(
  currentDeletedRanges: SourceRange[],
  window: { startSec: number; endSec: number },
  ranges: SourceRange | SourceRange[],
): { candidateRanges: SourceRange[]; blocked: boolean } {
  const additions = Array.isArray(ranges) ? ranges : [ranges];
  const candidateRanges = normalizeDeletedRanges([...currentDeletedRanges, ...additions], window,
  );
  return { candidateRanges, blocked: buildStudioCutPlan(candidateRanges, window).isEmpty,
  };
}

function nearestTimedWordBoundary(
  utterances: TranscriptUtterance[],
  sourceSec: number,
  minSec: number,
  maxSec: number,
): number {
  let nearest = sourceSec;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const utterance of utterances) {
    for (const word of utterance.words) {
      for (const boundary of [word.startSec, word.endSec]) {
        if (boundary <= minSec || boundary >= maxSec) continue;
        const distance = Math.abs(boundary - sourceSec);
        if (distance < nearestDistance) {
          nearest = boundary;
          nearestDistance = distance;
        }
      }
    }
  }
  return nearestDistance <= TIMELINE_SNAP_THRESHOLD_SEC ? nearest : sourceSec;
}

/** Tracks whether the viewport is narrower than `px` via matchMedia. */
function useIsViewportBelow(px: number): boolean {
  // Lazily seeded from matchMedia (not hardcoded `false`) so a phone's very
  // first render already shows the small-viewport gate instead of flashing
  // the full three-pane studio for one frame before the effect below
  // corrects it. Guarded for SSR, where `window` doesn't exist — the server
  // has no viewport to check, so it renders the same `false` it always did.
  const [isBelow, setIsBelow] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia(`(max-width: ${px - 1}px)`).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${px - 1}px)`);
    const update = () => setIsBelow(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [px]);

  return isBelow;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type AspectRatio = "9:16" | "1:1" | "16:9" | "4:5";
export type LayoutMode = "fill" | "fit" | "blur";
export type StudioSaveState =
  | "idle"
  | "local"
  | "saving"
  | "saved"
  | "offline"
  | "error"
  | "blocked"
  | "degraded"
  | "readonly";

function projectStudioSaveState(
  cloud: StudioSessionSnapshot["cloud"],
  ownership: StudioSessionSnapshot["ownership"],
): StudioSaveState {
  if (ownership.kind === "reader") return "readonly";
  switch (cloud.state) {
    case "current":
      return "idle";
    case "pending":
      return "local";
    case "saving":
      return "saving";
    case "offline":
      return "offline";
    case "retrying":
      return "error";
    case "rejected":
    case "authentication-lost":
    case "missing":
    case "revision-conflict":
      return "blocked";
  }
}
export type { CaptionAnimation, CaptionPreset };
export type ToolId =
  "captions"
  | "brand"
  | "broll"
  | "transitions"
  | "text"
  | "music"
  | "layout";

export interface TranscriptItem {
  id: string;
  type: "speech" | "broll";
  text?: string;
  timestamp: number;
  highlights?: { word: string; color: "green" | "amber" | "orange" }[];
  description?: string;
}

export type { TimelineSegment } from "./studio-types";

/** The project's brand logo, pre-resolved server-side (studio/page.tsx) from
 *  the frozen project brand snapshot: a presigned download URL plus the
 *  snapshot's own position/opacity/scalePct (the per-clip defaults before
 *  any `studioEdits.logo` override — see `resolveEffectiveLogoSettings` in
 *  @narriflow/validators for how the two combine). `null` when the project
 *  has no logo. Immutable for the life of the studio session — swapping
 *  logos happens in Brand kit settings, not here. */
export interface StudioBrandLogo {
  /** A stable logical logo remains present when presigning fails so the
   * composition plan can surface deterministic optional-asset degradation. */
  url: string | null;
  ref: string;
  position: LogoPosition;
  opacity: number;
  scalePct: number;
}

export interface ClipInfo {
  id: string;
  projectId: string;
  /** The clip's hook text — what it actually says. Deliberately NOT the
   *  user-facing title: the B-roll panel derives its stock-footage query from
   *  this, and that query should follow the spoken content, not a title someone
   *  renamed for the clip list. */
  title: string;
  /** The user- or AI-authored display title (`Clip.title`), or null when the
   *  clip has never been titled. Falls back to `title` where shown. */
  clipTitle: string | null;
  duration: number;
  startSec: number;
  endSec: number;
  aspectRatio: AspectRatio;
  viralityScore: number;
  category: string;
  sourceKind: "video" | "audio";
  /** Detection-time visual cues, clip-relative. The studio uses the same
   *  cues as the worker so its automatic-cutaway plan never falls back to
   *  one repeated title query when richer timing data already exists. */
  brollCues: BrollCue[];
  can1080pExport: boolean;
  exportHasWatermark: boolean;
}

export interface StudioExportOptions {
  aspectRatios: AspectRatio[];
  resolution: "720p" | "1080p";
}

export interface StudioBrollPreviewAsset {
  url: string;
  durationSec: number;
  posterUrl: string | null;
  authorName: string | null;
  pageUrl: string | null;
}

interface StudioState {
  isPlaying: boolean;
  playbackRate: number;
  duration: number;
  activeTool: ToolId | null;
  showTimeline: boolean;
  timelineSnapping: boolean;
  aspectRatio: AspectRatio;
  layoutMode: LayoutMode;
  showShortcuts: boolean;
  timelineZoom: number;
  selectedSegmentId: string | null;
  transcriptSelectionRange: SourceRange | null;
  captionPreset: CaptionPreset;
  captionSelected: boolean;
  /** Vizard-parity Phase C step 1: the one text overlay currently selected on
   *  the canvas/panel/timeline, or null. Mutually exclusive with
   *  `captionSelected` — selecting one deselects the other, matching the
   *  "single selected canvas object" rule. */
  selectedTextLayerId: string | null;
  transcriptOnly: boolean;
  segments: readonly TimelineSegment[];
  studioEdits: StudioEdits;
  /** Current B-roll cutaway URL — lives in the editor document (undoable,
   *  autosaved), not a locally-PATCHed side channel. */
  brollUrl: string | null;
  /** Session metadata for the applied B-roll URL. The URL itself remains in
   *  the editor document; this lightweight companion lets preview/timeline
   *  match the renderer's duration-bounded placement immediately. */
  brollPreviewAsset: StudioBrollPreviewAsset | null;
  /** 'blocked' is a distinct terminal state from 'error': it means autosave
   *  has permanently stopped (a 409/422 that a reload is needed to clear),
   *  as opposed to 'error''s transient/retryable failure. */
  saveState: StudioSaveState;
  /** True while the local document differs from what the server last
   *  confirmed. Live-QA finding 2026-08-06: the top-bar indicator used to
   *  show "Saved" whenever saveState was 'idle' — including the window
   *  after a failed save timed back to idle with the retry still pending —
   *  so it must consult this to say "Unsaved changes" instead. */
  isDocDirty: boolean;
  exportState: StudioExportState;
  compositionPlanStatus: StudioCompositionPlanStatus;
  resetState: "idle" | "resetting";
  canUndo: boolean;
  canRedo: boolean;
  /** False once resetting would be a no-op — see the canReset computation
   *  below for exactly what "nothing to reset" means. */
  canReset: boolean;
}

interface StudioContextValue extends StudioState {
  /** Current immutable Clip Editor Document projection owned by the session. */
  editorDocument: EditorDocument;
  transcript: TranscriptItem[];
  clipInfo: ClipInfo;
  mediaRef: (element: HTMLVideoElement | null) => void;
  playbackClock: PlaybackClock;
  setSourceAudioEnvelope: (gain: number) => void;
  sourceVideoUrl: string | null;
  sourcePreviewId: string;
  clipStartSec: number;
  clipEndSec: number;
  /** Presigned URL of the clip's lightweight preview proxy, or null when one
   *  hasn't been generated yet. The proxy's own t=0 is `previewStartSec`
   *  seconds into the *source* — video-preview.tsx / studio-shell.tsx map
   *  between the two via `playerClipStartSec`/`playerClipEndSec` below
   *  rather than ever comparing raw `clipStartSec`/`clipEndSec` against the
   *  proxy's `currentTime` directly. */
  previewVideoUrl: string | null;
  previewStartSec: number;
  /** Same-origin authenticated endpoint for the proxy's amplitude peaks. */
  waveformPeaksUrl: string | null;
  /** True when the project's source has been purged (`Project.sourceStorageKey`
   *  is null). Once true, a still-missing `previewVideoUrl` can never arrive
   *  — the worker that cuts proxies reads straight from source storage — so
   *  video-preview.tsx shows a terminal message instead of polling or
   *  spinning forever, and hides the "Use original source" escape hatch
   *  (which needs that same now-gone source). */
  sourcePurged: boolean;
  /** True while the session has selected the full source: either after the
   *  user opts in for an initially missing proxy, or automatically while a
   *  boundary-invalidated proxy is being replaced. */
  useOriginalSourceFallback: boolean;
  setUseOriginalSourceFallback: (v: boolean) => void;
  reloadPlayback: () => void;
  /** Whichever URL the session selected for the `<video>` element: an
   *  eligible proxy, the source during explicit/automatic fallback, or null.
   *  Also what the timeline scrubs
   *  thumbnails from (see timeline-preview-manager.ts) — thumbnails
   *  deliberately mirror the player's source choice instead of eagerly
   *  opening the full source on their own, which was the bug this same
   *  proxy work fixed for playback. */
  activeVideoUrl: string | null;
  /** Source time -> `activeVideoUrl`-local time offset: `previewStartSec`
   *  when `activeVideoUrl` is the proxy, 0 when it's the source (or null).
   *  Same role as `playerClipStartSec`/`playerClipEndSec` below but as a
   *  standalone delta — the timeline thumbnail pipeline seeks arbitrary
   *  in-clip points rather than clip start/end, so it subtracts this
   *  directly (see `sourceTimeToVideoTime` in timeline-preview-manager.ts)
   *  instead of reusing the start/end pair. */
  activeOffsetSec: number;
  /** Which physical file `activeVideoUrl` resolves to. Threaded through to
   *  the timeline's thumbnail cache keys so a strip captured from the
   *  source before the proxy existed is never handed back once the proxy
   *  takes over (see `ThumbnailVideoKind` in timeline-preview-manager.ts). */
  activeVideoKind: ThumbnailVideoKind;
  /** `clipStartSec`/`clipEndSec` re-expressed in *whichever* file
   *  `activeVideoUrl` points at — identical to `clipStartSec`/`clipEndSec`
   *  when playing the source, shifted back by `previewStartSec` when
   *  playing the proxy. Everything that seeks/bounds the actual
   *  `videoRef.current.currentTime` must use these, not the raw
   *  `clipStartSec`/`clipEndSec` (which stay in source time for the
   *  caption/transcript/timeline consumers that key off them). */
  playerClipStartSec: number;
  playerClipEndSec: number;
  /** Vizard-parity Phase B step 8 (docs/plans/vizard-parity.md §4): the
   *  edited-time map derived from `doc.deletedRanges` — the SINGLE source of
   *  truth every consumer of clip time (captions, transcript sync, the
   *  timeline ruler/segments, playback) converts through so cuts can never
   *  drift between what plays and what's displayed. Identity (one segment,
   *  no cuts) when `deletedRanges` is empty — the fast path that keeps
   *  pre-ripple behavior byte-for-byte unchanged. `duration` above IS
   *  `editedTimeMap.editedDurationSec` — never compute it separately. */
  editedTimeMap: EditedTimeMap;
  /** `doc.deletedRanges` — absolute source seconds, already normalized by
   *  the reducer. Exposed directly (not just via `editedTimeMap`) so the
   *  timeline can render one Revert-able cut marker per range; see
   *  `deletedRangesToCutMarkers` in edited-timeline.ts. */
  deletedRanges: SourceRange[];
  /** The same (window, deletedRanges) window `editedTimeMap` was built
   *  from — pass this to `detectSilenceRanges` (Phase B step 12) so the
   *  timeline's live preview can never disagree with what `applyRemoveSilence`
   *  actually dispatches. */
  clipWindow: ClipWindow;
  /** Server-seeded brand logo (URL + snapshot defaults), or null when the
   *  project has none. See `StudioBrandLogo`'s doc comment. */
  brandLogo: StudioBrandLogo | null;
  /** Worker-derived Screen/PiP evidence. It is server-seeded, then refreshed
   *  by exact source-identity/fingerprint polling while requested evidence is
   *  pending. This read-only measurement never enters the editor document,
   *  undo/redo history, or autosave body. Consumers must still validate the
   *  evidence window and source identity before adopting its crop. */
  layoutAnalysis: ClipLayoutAnalysis | null;
  /** Persisted automatic shot-layout plan; derived/read-only like PiP analysis. */
  autoLayoutAnalysis: ClipAutoLayoutAnalysis | null;
  /** Durable explicit Split evidence, isolated from Automatic analysis. */
  splitLayoutAnalysis: ClipSplitLayoutAnalysis | null;
  splitLayoutFailure: ClipSplitLayoutFailure | null;
  layoutAnalysisFailure: ClipLayoutAnalysisFailure | null;
  autoLayoutAnalysisStatus: "available" | "pending" | "failed";
  utterances: TranscriptUtterance[];
  updateUtteranceText: (index: number, newText: string) => void;
  updateParagraphText: (indices: number[], newText: string) => void;
  addSubtitleLineAfter: (index: number) => void;
  deleteSubtitleLine: (index: number) => void;
  mergeSubtitleLineWithNext: (index: number) => boolean;
  /** Word-level Correct (vizard-parity.md Phase B step 10) — changes only
   *  this one word's text, no proportional retiming. `utteranceIndex`/
   *  `wordIndex` are indices into the displayed `utterances` array, which
   *  transcript-panel.tsx's callers already assume line up 1:1 with
   *  `doc.transcriptSlice` (the same contract `updateUtteranceText` uses). */
  updateWord: (utteranceIndex: number, wordIndex: number, text: string) => void;
  /** Transcript selection Delete (vizard-parity.md Phase B step 11) — same
   *  isEmpty guard as `deleteSelectedSegment`, over an arbitrary absolute-
   *  source-second range instead of a timeline segment. Returns false (and
   *  toasts) when the delete was rejected, true once it was dispatched. */
  deleteSourceRange: (range: SourceRange) => boolean;
  /** Vizard-parity Phase B step 12 (Remove silence): unions `detected` with
   *  the existing manual `deletedRanges` and dispatches ONE undoable
   *  `setDeletedRanges` action. Same isEmpty guard/toast as every other
   *  delete path; returns false (no dispatch) when blocked, empty, or a
   *  no-op. */
  applyRemoveSilence: (detected: SourceRange[]) => boolean;
  setPlaybackRate: (v: number) => void;
  setActiveTool: (t: ToolId | null) => void;
  setShowTimeline: (v: boolean) => void;
  setTimelineSnapping: (v: boolean) => void;
  setAspectRatio: (r: AspectRatio) => void;
  setLayoutMode: (m: LayoutMode) => void;
  setShowShortcuts: (v: boolean) => void;
  setTimelineZoom: React.Dispatch<React.SetStateAction<number>>;
  setSelectedSegmentId: (id: string | null) => void;
  setTranscriptSelectionRange: (range: SourceRange | null) => void;
  setCaptionPreset: (
    p: CaptionPreset | ((prev: CaptionPreset) => CaptionPreset),
    coalesceKey?: string,
  ) => void;
  selectCaption: () => void;
  deselectCaption: () => void;
  /** Selects one text overlay by id — deselects the caption (single-selection
   *  rule) and switches the tool sidebar to the Text panel, mirroring
   *  `selectCaption`. */
  selectTextLayer: (id: string) => void;
  deselectTextLayer: () => void;
  setTranscriptOnly: (v: boolean) => void;
  setSegments: (s: TimelineSegment[]) => void;
  setStudioEdits: (
    p: StudioEdits | ((prev: StudioEdits) => StudioEdits),
    coalesceKey?: string,
  ) => void;
  setBrollUrl: (url: string | null, coalesceKey?: string) => void;
  setBrollPreviewAsset: (asset: StudioBrollPreviewAsset | null) => void;
  /** Breaks the document's coalesce chain without recording an undo step —
   *  wire to `onValueChangeEnd` of every slider that passes a coalesceKey
   *  (and pointer-up of the caption-resize drag) so the NEXT gesture never
   *  accidentally merges into one that already finished. */
  endCoalesce: () => void;
  /** Restores a previously deleted source range (the Vizard-parity "Revert"
   *  affordance on a timeline cut marker) — dispatches `revertRange` through
   *  the same undo/redo history as every other document mutation. */
  revertDeletedRange: (range: SourceRange) => void;
  togglePlay: () => void;
  seekTo: (t: number) => void;
  splitAtPlayhead: () => void;
  deleteSelectedSegment: () => void;
  handleSave: () => void;
  handleExport: (options: StudioExportOptions) => void;
  reportCompositionPlanStatus: (status: StudioCompositionPlanStatus) => void;
  compositionPlanQaFixture: CompositionPlanQaFixture | null;
  handleUndo: () => void;
  handleRedo: () => void;
  handleReset: () => void;
  /** In-studio trim (vizard-parity.md Phase B step 13): commits a drag on
   *  either timeline trim handle. `newStartSec`/`newEndSec` are absolute
   *  SOURCE seconds, already word-snapped and guard-clamped by the caller
   *  (min duration, source-duration ceiling — see timeline.tsx's trim
   *  handles). Builds the new transcriptSlice from the full project
   *  transcript and dispatches ONE composite `trimClip` action (bounds +
   *  slice, one undo step) plus a silent `resegment` so the timeline's
   *  utterance-grouped blocks rebuild against the new window in the SAME
   *  update — see unified-editor-history.ts's `resegment` doc comment for
   *  why that second part doesn't cost its own ⌘Z press. */
  commitTrim: (newStartSec: number, newEndSec: number) => Promise<void>;
  /** True while a save (or reset) is in flight — the trim handles disable
   *  themselves rather than let a second trim stack on an unsaved one
   *  (Phase B step 13 guard item 8; the single-flight save queue already
   *  serializes the actual requests, this just reflects that in the UI). */
  trimHandlesDisabled: boolean;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export function useStudio() {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error("useStudio must be used within StudioShell");
  return ctx;
}

// ─── Shell ────────────────────────────────────────────────────────────────────

interface StudioShellProps {
  clipInfo: ClipInfo;
  timelineSegments: TimelineSegment[];
  /** The revisioned editor document (docs/plans/vizard-parity.md Phase A) —
   *  the single source of truth for captionPreset/transcriptSlice/
   *  studioEdits/brollUrl/deletedRanges. Everything the studio can mutate
   *  flows through this one value's undo/redo history instead of four
   *  independently-PATCHed fragments. */
  initialEditorDocument: EditorDocument;
  initialEditorRevision: number;
  /** The immutable revision-zero snapshot Reset-to-original restores. Reset
   *  itself is still a server round-trip + full reload (see handleReset
   *  below — boundaries/preview proxy may change, so re-seeding from a
   *  fresh server render is simpler and safer than patching client state in
   *  place) — but this is read client-side to derive `canReset`: reset is
   *  only offered when the live document (or what the server already held
   *  at load) actually differs from this snapshot, not just because
   *  `revision > 0`. Optional so a caller without a real original (e.g. a
   *  test harness) still gets a sane fallback — see the canReset
   *  computation below. */
  initialEditorOriginal?: EditorDocument;
  sourceVideoUrl?: string | null;
  sourcePreviewId?: string;
  /** Vizard-parity Phase B step 13 (in-studio trim): these are seeds ONLY —
   *  the server's page-load-time effective timing, used for the very first
   *  render before any trim has happened. Every internal computation
   *  (playerClipStartSec/EndSec, the derived transcript, split/delete range
   *  math, and everything exposed on context as `clipStartSec`/`clipEndSec`)
   *  derives LIVE from `doc.transcriptSlice`/`doc.clipStartSec`/
   *  `doc.clipEndSec` instead (see the `effectiveTiming` memo below) — by
   *  the "finalize-once" boundary invariant these two already agree with
   *  the document's own bounds on first paint, so this is a no-op seed, not
   *  a second source of truth. */
  clipStartSec?: number;
  clipEndSec?: number;
  /** Presigned preview-proxy URL from studio/page.tsx, or null when no
   *  proxy has been generated for this clip yet. */
  previewVideoUrl?: string | null;
  /** The proxy's t=0 expressed in source time (`Clip.previewStartSec`).
   *  Meaningless when `previewVideoUrl` is null. */
  previewStartSec?: number;
  /** Duration of the generated proxy window, used by the session-owned
   * descriptor to keep the server asset and its fingerprint together. */
  previewDurationSec?: number | null;
  /** Same-origin endpoint for validated real amplitude peaks, or null when
   *  no preview exists yet. */
  waveformPeaksUrl?: string | null;
  /** True when the project's source has been purged — see the doc comment
   *  on `StudioContextValue.sourcePurged`. */
  sourcePurged?: boolean;
  /** Server Action that re-checks this clip's preview-proxy readiness,
   *  defined in studio/page.tsx (see its doc comment for why it's threaded
   *  through as a prop rather than imported by name). Polled by the effect
   *  below while `previewVideoUrl` is still null; omitted entirely (e.g. in
   *  tests) simply disables polling rather than throwing. */
  fetchPreviewStatus?: () => Promise<StudioAuthenticatedActionFailure | {
    previewUrl: string | null;
    previewStartSec: number;
    previewDurationSec: number | null;
    waveformPeaksUrl: string | null;
  }>;
  /** Authenticated Server Action used while worker-derived shot analysis is
   *  still pending. The client accepts only a plan matching its live clip
   *  window and deleted ranges. */
  fetchAutoLayoutAnalysis?: () => Promise<StudioAuthenticatedActionFailure | ClipAutoLayoutAnalysis | null>;
  fetchSplitLayoutAnalysis?: () => Promise<StudioAuthenticatedActionFailure | ClipSplitLayoutOutcome | null>;
  fetchScreenLayoutAnalysis?: () => Promise<StudioAuthenticatedActionFailure | ClipLayoutAnalysisOutcome | null>;
  /** Server-seeded brand logo (see studio/page.tsx and `StudioBrandLogo`'s
   *  doc comment), or null/omitted when the project has none. */
  brandLogo?: StudioBrandLogo | null;
  /** Server-seeded screen-mode PiP layout analysis (see
   *  `StudioContextValue.layoutAnalysis`'s doc comment), or null/omitted
   *  when the clip has none yet. */
  layoutAnalysis?: ClipLayoutAnalysis | null;
  autoLayoutAnalysis?: ClipAutoLayoutAnalysis | null;
  splitLayoutAnalysis?: ClipSplitLayoutAnalysis | null;
  splitLayoutFailure?: ClipSplitLayoutFailure | null;
  layoutAnalysisFailure?: ClipLayoutAnalysisFailure | null;
  /** Development-only browser fixture. The server page never forwards this
   *  in production. It exists so Chrome QA can prove the invalid-plan alert
   *  and export block without corrupting a Clip Editor Document. */
  compositionPlanQaFixture?: CompositionPlanQaFixture | null;
}

export function StudioShell({
  clipInfo,
  timelineSegments,
  initialEditorDocument,
  initialEditorRevision,
  initialEditorOriginal,
  sourceVideoUrl = null,
  sourcePreviewId = "source",
  // clipStartSec/clipEndSec are accepted (see the prop's doc comment above)
  // but deliberately not read here — every internal use now derives from
  // `doc` via the `effectiveTiming` memo below.
  previewVideoUrl: initialPreviewVideoUrl = null,
  previewStartSec: initialPreviewStartSec = 0,
  previewDurationSec: initialPreviewDurationSec = null,
  waveformPeaksUrl: initialWaveformPeaksUrl = null,
  sourcePurged = false,
  fetchPreviewStatus,
  fetchAutoLayoutAnalysis,
  fetchSplitLayoutAnalysis,
  fetchScreenLayoutAnalysis,
  brandLogo = null,
  layoutAnalysis: initialLayoutAnalysis = null,
  autoLayoutAnalysis: initialAutoLayoutAnalysis = null,
  splitLayoutAnalysis: initialSplitLayoutAnalysis = null,
  splitLayoutFailure: initialSplitLayoutFailure = null,
  layoutAnalysisFailure: initialLayoutAnalysisFailure = null,
  compositionPlanQaFixture = null,
}: StudioShellProps) {
  const isViewportTooSmall = useIsViewportBelow(STUDIO_MIN_VIEWPORT_WIDTH);
  const [brollPreviewAsset, setBrollPreviewAsset] =
    useState<StudioBrollPreviewAsset | null>(null);
  const [layoutAnalysis, setLayoutAnalysis] =
    useState<ClipLayoutAnalysis | null>(initialLayoutAnalysis);
  const [splitLayoutAnalysis, setSplitLayoutAnalysis] =
    useState<ClipSplitLayoutAnalysis | null>(initialSplitLayoutAnalysis);
  const [splitLayoutFailure, setSplitLayoutFailure] =
    useState<ClipSplitLayoutFailure | null>(initialSplitLayoutFailure);
  const [layoutAnalysisFailure, setLayoutAnalysisFailure] =
    useState<ClipLayoutAnalysisFailure | null>(initialLayoutAnalysisFailure);

  // React creates one clip-scoped session, then subscribes to focused
  // immutable projections below. All editing protocols remain owned by the
  // session; this component only translates snapshots and user gestures for
  // presentation consumers.
  const {
    session: studioSession,
    mediaRef,
    playbackClock,
    setSourceAudioEnvelope,
    suppressNavigationWarning,
  } = useStudioEditingSession(
    {
      projectId: clipInfo.projectId,
      clipId: clipInfo.id,
      cloudRevision: initialEditorRevision,
      document: initialEditorDocument,
      segments: timelineSegments,
      preview: {
        sourceUrl: sourceVideoUrl,
        sourcePurged,
        proxy: initialPreviewVideoUrl
          ? {
              url: initialPreviewVideoUrl,
              startSec: initialPreviewStartSec,
              durationSec: initialPreviewDurationSec,
              waveformPeaksUrl: initialWaveformPeaksUrl,
            }
          : null,
        automaticLayout: initialAutoLayoutAnalysis,
      },
    },
    {
      preview: {
        ...(fetchPreviewStatus
          ? {
              fetchProxyStatus: async () =>
                unwrapStudioActionResult(await fetchPreviewStatus()),
            }
          : {}),
        ...(fetchAutoLayoutAnalysis
          ? {
              fetchAutomaticLayout: async () =>
                unwrapStudioActionResult(await fetchAutoLayoutAnalysis()),
            }
          : {}),
      },
    },
  );

  const doc = useStudioSessionSelector(studioSession, selectStudioDocument);
  const evidenceFramingMode = resolveEffectiveFramingMode(doc.studioEdits);
  const compositionSourceIdentity = compositionAssetRef(
    "source",
    clipInfo.projectId,
  );
  const splitEvidenceMatchesDocument = Boolean(
    (splitLayoutAnalysis &&
      splitLayoutAnalysis.sourceIdentity === compositionSourceIdentity &&
      clipAutoLayoutMatchesInputs(splitLayoutAnalysis, {
        clipStartSec: doc.clipStartSec,
        clipEndSec: doc.clipEndSec,
        deletedRanges: doc.deletedRanges,
      })) ||
      (splitLayoutFailure?.sourceIdentity === compositionSourceIdentity &&
        splitLayoutFailure.inputFingerprint ===
          splitLayoutInputFingerprint({
            sourceIdentity: compositionSourceIdentity,
            clipStartSec: doc.clipStartSec,
            clipEndSec: doc.clipEndSec,
            deletedRanges: doc.deletedRanges,
            engineVersion: "explicit-split-v1",
          })),
  );
  const screenEvidenceMatchesDocument = Boolean(
    (layoutAnalysis?.version === 2 &&
      layoutAnalysis.engine === SCREEN_LAYOUT_ENGINE_VERSION &&
      layoutAnalysis.sourceIdentity === compositionSourceIdentity &&
      layoutAnalysis.inputFingerprint ===
        screenLayoutInputFingerprint({
          sourceIdentity: compositionSourceIdentity,
          clipStartSec: doc.clipStartSec,
          clipEndSec: doc.clipEndSec,
          deletedRanges: doc.deletedRanges,
          engineVersion: SCREEN_LAYOUT_ENGINE_VERSION,
        })) ||
      (layoutAnalysisFailure?.sourceIdentity === compositionSourceIdentity &&
        layoutAnalysisFailure.inputFingerprint ===
        screenLayoutInputFingerprint({
          sourceIdentity: compositionSourceIdentity,
          clipStartSec: doc.clipStartSec,
          clipEndSec: doc.clipEndSec,
          deletedRanges: doc.deletedRanges,
          engineVersion: SCREEN_LAYOUT_ENGINE_VERSION,
        })),
  );

  useEffect(() => {
    if (
      !fetchScreenLayoutAnalysis ||
      evidenceFramingMode !== "screen" ||
      screenEvidenceMatchesDocument
    ) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      attempts += 1;
      try {
        const next = await fetchScreenLayoutAnalysis();
        if (cancelled) return;
        if (isAuthenticatedActionFailure(next)) return;
        const failed = next && "state" in next;
        setLayoutAnalysis(failed ? null : next);
        setLayoutAnalysisFailure(failed ? next : null);
        if (
          next?.version === 2 &&
          next.engine === SCREEN_LAYOUT_ENGINE_VERSION &&
          next.sourceIdentity === compositionSourceIdentity &&
          next.inputFingerprint ===
            screenLayoutInputFingerprint({
              sourceIdentity: compositionSourceIdentity,
              clipStartSec: doc.clipStartSec,
              clipEndSec: doc.clipEndSec,
              deletedRanges: doc.deletedRanges,
              engineVersion: SCREEN_LAYOUT_ENGINE_VERSION,
            })
        ) {
          return;
        }
      } catch {
        if (cancelled) return;
      }
      if (attempts < 30) timer = setTimeout(poll, 2_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    doc.clipEndSec,
    doc.clipStartSec,
    doc.deletedRanges,
    compositionSourceIdentity,
    evidenceFramingMode,
    fetchScreenLayoutAnalysis,
    screenEvidenceMatchesDocument,
  ]);

  useEffect(() => {
    if (
      !fetchSplitLayoutAnalysis ||
      evidenceFramingMode !== "split" ||
      splitEvidenceMatchesDocument
    ) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      attempts += 1;
      try {
        const next = await fetchSplitLayoutAnalysis();
        if (cancelled) return;
        if (isAuthenticatedActionFailure(next)) return;
        const failed = next && "state" in next;
        setSplitLayoutAnalysis(failed ? null : next);
        setSplitLayoutFailure(failed ? next : null);
        if (
          next &&
          next.sourceIdentity === compositionSourceIdentity &&
          ("state" in next
            ? next.inputFingerprint ===
              splitLayoutInputFingerprint({
                sourceIdentity: compositionSourceIdentity,
                clipStartSec: doc.clipStartSec,
                clipEndSec: doc.clipEndSec,
                deletedRanges: doc.deletedRanges,
                engineVersion: "explicit-split-v1",
              })
            : clipAutoLayoutMatchesInputs(next, {
                clipStartSec: doc.clipStartSec,
                clipEndSec: doc.clipEndSec,
                deletedRanges: doc.deletedRanges,
              }))
        ) {
          return;
        }
      } catch {
        if (cancelled) return;
      }
      if (attempts < 30) timer = setTimeout(poll, 2_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    doc.clipEndSec,
    doc.clipStartSec,
    doc.deletedRanges,
    compositionSourceIdentity,
    evidenceFramingMode,
    fetchSplitLayoutAnalysis,
    splitEvidenceMatchesDocument,
  ]);
  const segments = useStudioSessionSelector(studioSession, selectStudioSegments,
  );
  const canUndo = useStudioSessionSelector(studioSession, selectStudioCanUndo);
  const canRedo = useStudioSessionSelector(studioSession, selectStudioCanRedo);
  const status = useStudioSessionSelector(studioSession, selectStudioStatus);
  const recovery = useStudioSessionSelector(studioSession, selectStudioRecovery,
  );
  const durability = useStudioSessionSelector(studioSession, selectStudioDurability,
  );
  const ownership = useStudioSessionSelector(studioSession, selectStudioOwnership,
  );
  const cloud = useStudioSessionSelector(studioSession, selectStudioCloud);
  const preview = useStudioSessionSelector(
    studioSession,
    selectStudioPreview,
    studioPreviewPresentationEqual,
  );
  const playbackPresentation = useStudioSessionSelector(
    studioSession,
    selectStudioPlaybackPresentation,
    studioPlaybackPresentationEqual,
  );
  const getStudioDocument = useCallback(
    () => studioSession.getSnapshot().document as EditorDocument,
    [studioSession],
  );

  const previewVideoUrl = preview.proxy?.url ?? null;
  const previewStartSec = preview.proxy?.startSec ?? 0;
  const waveformPeaksUrl = preview.waveformPeaksUrl;
  const autoLayoutAnalysis =
    preview.automaticLayout as ClipAutoLayoutAnalysis | null;
  const autoLayoutAnalysisStatus = preview.automaticLayoutStatus;
  const activeVideoUrl = preview.activeAsset.url;
  const activeOffsetSec = preview.activeAsset.offsetSec;
  const useOriginalSourceFallback =
    preview.activeAsset.kind === "source";
  const setUseOriginalSourceFallback = useCallback(
    (enabled: boolean) => {
      studioSession.dispatch({
        type: "preview.set-source-fallback",
        enabled,
      });
    },
    [studioSession],
  );
  const reloadPlayback = useCallback(() => {
    studioSession.dispatch({ type: "playback.reload" });
  }, [studioSession]);

  // Named `doc` (not `document`) to avoid shadowing the global DOM object.
  const captionPreset = doc.captionPreset;
  const studioEdits = doc.studioEdits;
  const brollUrl = doc.brollUrl;

  // Derived from `doc.transcriptSlice`/`doc.clipStartSec`/`doc.clipEndSec`
  // via the exact same pure effective-timing computation studio/page.tsx
  // runs server-side (tailPadSec 0 — slice-only, matching the stored
  // bounds). Idempotent on the document's own (already-effective) bounds, so
  // first paint is visually identical to before; only diverges once a
  // transcript edit or an in-studio trim (vizard-parity.md Phase B step 13)
  // actually changes the slice/window.
  //
  // Phase B step 13 reverses an earlier assumption: `clipStartSec`/
  // `clipEndSec` used to be frozen server-seeded PROPS (the page's
  // page-load-time effective timing) because boundaries were immutable.
  // Now that a trim can move `doc.clipStartSec`/`doc.clipEndSec` live, this
  // memo — not the props — is the single source of truth for "effective"
  // clip timing; `effectiveClipStartSec`/`effectiveClipEndSec` below feed
  // every consumer that used to read the props directly (playerClipStartSec/
  // EndSec, the derived transcript, split/delete range math, and the
  // `clipStartSec`/`clipEndSec` values exposed on context to transcript-
  // panel.tsx/interactive-caption-overlay.tsx/caption-style-engine.tsx/
  // timeline.tsx — all of which only ever read them THROUGH context, so
  // swapping what this produces is enough to make them doc-derived with no
  // changes of their own). The prop seeds remain only as the initial values
  // (see the `clipStartSec`/`clipEndSec` prop doc comments above).
  const effectiveTiming = useMemo(
    () =>
      getEffectiveClipTiming({
        utterances: doc.transcriptSlice,
        startSec: doc.clipStartSec,
        endSec: doc.clipEndSec,
        tailPadSec: 0,
      }),
    [doc.transcriptSlice, doc.clipStartSec, doc.clipEndSec],
  );
  const utterances = effectiveTiming.transcriptSlice;
  const effectiveClipStartSec = effectiveTiming.startSec;
  const effectiveClipEndSec = effectiveTiming.endSec;

  const activeVideoKind: ThumbnailVideoKind =
    preview.activeAsset.kind === "proxy" ? "proxy" : "source";
  const playerClipStartSec = effectiveClipStartSec - activeOffsetSec;
  const playerClipEndSec = effectiveClipEndSec - activeOffsetSec;

  // ─── Edited-timeline model (vizard-parity.md Phase B step 8) ────────────
  // The SINGLE map every time-based consumer (playback, captions, transcript
  // sync, the timeline) converts through. Falls back to `clipInfo.duration`
  // for the same degenerate case the old `duration` computation guarded
  // (clipStartSec/clipEndSec both unset, e.g. a test harness) — building the
  // map from an empty window would otherwise yield a bogus zero duration.
  // Same (window, deletedRanges) window every delete-candidate check
  // (computeDeleteCandidate, Remove-silence detection/apply) must use, kept
  // as one memo so they can never disagree with editedTimeMap about where
  // the clip's bounds actually are.
  const clipWindow: ClipWindow = useMemo(() => {
    const hasRealBounds = doc.clipEndSec > doc.clipStartSec;
    return hasRealBounds
      ? { startSec: doc.clipStartSec, endSec: doc.clipEndSec }
      : { startSec: doc.clipStartSec, endSec: doc.clipStartSec + Math.max(0, clipInfo.duration),
        };
  }, [doc.clipStartSec, doc.clipEndSec, clipInfo.duration]);

  const editedTimeMap: EditedTimeMap = useMemo(
    () => buildStudioCutPlan(doc.deletedRanges, clipWindow).map,
    [doc.deletedRanges, clipWindow],
  );

  // `duration` IS the edited duration — identical to the old
  // `clipEndSec - clipStartSec` computation whenever `deletedRanges` is
  // empty (the fast path), strictly shorter once cuts exist.
  const duration = playbackPresentation.durationSec;

  // Derive TranscriptItem[] from utterances for existing TranscriptPanel
  const derivedTranscript: TranscriptItem[] = useMemo(
    () =>
      utterances.map((u, i) => ({
        id: `u-${u.index ?? i}`,
        type: "speech" as const,
        text: u.text,
        timestamp: u.startSec - effectiveClipStartSec,
      })),
    [utterances, effectiveClipStartSec],
  );

  const isPlaying = playbackPresentation.state === "playing";
  const playbackRate = playbackPresentation.rate;
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [showTimeline, setShowTimeline] = useState(true);
  const [timelineSnapping, setTimelineSnapping] = useState(true);
  const router = useRouter();
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(clipInfo.aspectRatio,
  );
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("fill");
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null,
  );
  const [transcriptSelectionRange, setTranscriptSelectionRange] =
    useState<SourceRange | null>(null);
  const [captionSelected, setCaptionSelected] = useState(false);
  const [selectedTextLayerId, setSelectedTextLayerId] = useState<string | null>(null,
  );
  const [transcriptOnly, setTranscriptOnly] = useState(false);
  const [exportState, setExportState] = useState<StudioExportState>("idle");
  const [compositionPlanStatus, setCompositionPlanStatus] =
    useState<StudioCompositionPlanStatus>("unresolved");
  const reportCompositionPlanStatus = useCallback(
    (status: StudioCompositionPlanStatus) => setCompositionPlanStatus(status),
    [],
  );
  const [resetState, setResetState] = useState<"idle" | "resetting">("idle");
  const revision = cloud.revision;
  const isDocDirty = cloud.dirty;
  const saveState = projectStudioSaveState(cloud, ownership);
  const hasWriteOwnership =
    ownership.kind === "writer" || ownership.kind === "degraded";
  const writeOwnershipReady = ownership.kind !== "pending";
  const draftRecoveryReady = status !== "starting";
  const sessionDraftConflict = status === "conflict";
  const sessionSafetyDegraded =
    durability.device === "degraded" || ownership.kind === "degraded";
  const recoveryNoticeRef = useRef<StudioSessionSnapshot["recovery"]["kind"]>("none");

  useEffect(() => {
    const kind = recovery.kind;
    if (kind === recoveryNoticeRef.current) return;
    recoveryNoticeRef.current = kind;
    let notice: Parameters<typeof toaster.create>[0] | null = null;
    if (kind === "recovered" || kind === "merged") {
      notice = {
        type: "info",
        title: kind === "merged" ? "Draft recovered and merged" : "Draft recovered",
        description:
          kind === "merged"
            ? "Your device draft was safely combined with newer cloud changes."
            : "Unsynced edits from this device are ready to continue.",
      };
    } else if (durability.device === "degraded") {
      notice = {
        type: "warning",
        title: "Local recovery is unavailable",
        description:
          "Cloud autosave still works, but this browser could not open its recovery storage.",
      };
    }
    if (!notice) return;

    // Chakra updates its toast store synchronously. Defer the update until
    // after React finishes this effect's commit so recovery never calls
    // flushSync from inside a lifecycle method.
    const timeoutId = window.setTimeout(() => toaster.create(notice), 0);
    return () => window.clearTimeout(timeoutId);
  }, [durability.device, recovery.kind]);

  // Fix 4: canReset used to be `revision > 0 || isDocDirty`, which offered
  // Reset even when nothing would actually change (e.g. right after a fresh
  // autosave with the document still equal to the original). Derive it
  // instead from an actual difference against the immutable revision-zero
  // snapshot: either the LIVE local document already differs from it, or the
  // document the server was already holding differed from it AT LOAD time
  // (edits from a previous session that this session hasn't touched yet).
  // Falls back to the old load-time document when no explicit original was
  // provided (e.g. a test harness that omits the prop) rather than silently
  // disabling reset.
  const originalDoc = initialEditorOriginal ?? initialEditorDocument;
  const canReset = useMemo(() => {
    const originalJson = JSON.stringify(originalDoc);
    const localDiffersFromOriginal = JSON.stringify(doc) !== originalJson;
    const serverDifferedFromOriginalAtLoad =
      JSON.stringify(initialEditorDocument) !== originalJson;
    return (
      localDiffersFromOriginal || (revision > 0 && serverDifferedFromOriginalAtLoad)
    );
  }, [doc, originalDoc, initialEditorDocument, revision]);

  // Dispatch helpers — thin wrappers that turn context setter calls into
  // reducer actions through the unified history. Signatures match the old
  // per-field useState setters (functional-update form supported) so no
  // consuming panel needs to change shape, plus an OPTIONAL trailing
  // coalesceKey for continuous gestures (slider drags etc.) so one gesture
  // collapses into one undo step instead of one per tick.
  const setCaptionPreset = useCallback(
    (
      updater: CaptionPreset | ((prev: CaptionPreset) => CaptionPreset),
      coalesceKey?: string,
    ) => {
      const current = getStudioDocument().captionPreset;
      const next = typeof updater === "function" ? updater(current) : updater;
      studioSession.dispatch({
        type: "document.edit",
        action: { type: "setCaptionPreset", captionPreset: next },
        coalesceKey,
      });
    },
    [getStudioDocument, studioSession],
  );

  const setStudioEdits = useCallback(
    (
      updater: StudioEdits | ((prev: StudioEdits) => StudioEdits),
      coalesceKey?: string,
    ) => {
      const current = getStudioDocument().studioEdits;
      const next = typeof updater === "function" ? updater(current) : updater;
      studioSession.dispatch({
        type: "document.edit",
        action: { type: "setStudioEdits", studioEdits: next },
        coalesceKey,
      });
    },
    [getStudioDocument, studioSession],
  );

  // Fix 8b: gesture end (slider pointer-up, resize-drag pointer-up) breaks
  // the coalesce chain so the NEXT gesture never merges into one that
  // already finished, even if it happens to reuse the same coalesceKey.
  const endCoalesce = useCallback(() => {
    studioSession.dispatch({ type: "gesture.end" });
  }, [studioSession]);

  const setBrollUrl = useCallback((url: string | null, coalesceKey?: string) => {
    studioSession.dispatch({
      type: "document.edit",
      action: { type: "setBrollUrl", brollUrl: url },
      coalesceKey,
    });
  }, [studioSession],
  );

  const setSegments = useCallback((next: TimelineSegment[]) => {
    studioSession.dispatch({ type: "segments.replace", segments: next });
  }, [studioSession],
  );

  // Update utterance text — whole-utterance rewrite with proportional timing
  // redistribution across the new word count (distinct from the reducer's
  // word-level `updateWordText`, which deliberately never redistributes).
  const updateUtteranceText = useCallback((utteranceIndex: number, newText: string) => {
    const prev = getStudioDocument().transcriptSlice;
    const nextSlice = replaceSubtitleLineText(prev, utteranceIndex, newText);
    studioSession.dispatch({
      type: "document.edit",
      action: { type: "setTranscriptSlice", transcriptSlice: nextSlice },
    });
  }, [getStudioDocument, studioSession],
  );

  const updateParagraphText = useCallback((indices: number[], newText: string) => {
    const nextSlice = replaceSubtitleParagraphText(
      getStudioDocument().transcriptSlice,
      indices,
      newText,
    );
    studioSession.dispatch({
      type: "document.edit",
      action: { type: "setTranscriptSlice", transcriptSlice: nextSlice },
    });
  }, [getStudioDocument, studioSession],
  );

  const addSubtitleLineAfter = useCallback((index: number) => {
    const nextSlice = insertSubtitleLineAfter(
      getStudioDocument().transcriptSlice,
      index,
    );
    studioSession.dispatch({
      type: "document.edit",
      action: { type: "setTranscriptSlice", transcriptSlice: nextSlice },
    });
  }, [getStudioDocument, studioSession],
  );

  const deleteSubtitleLine = useCallback((index: number) => {
    const nextSlice = removeSubtitleLine(
      getStudioDocument().transcriptSlice,
      index,
    );
    studioSession.dispatch({
      type: "document.edit",
      action: { type: "setTranscriptSlice", transcriptSlice: nextSlice },
    });
  }, [getStudioDocument, studioSession],
  );

  const mergeSubtitleLineWithNext = useCallback(
    (index: number) => {
      const first = utterances[index];
      const second = utterances[index + 1];
      if (!first || !second) return false;
      const boundaryRelative = second.startSec - effectiveClipStartSec;
      const crossesManualSceneBoundary = segments.some(
        (segment) =>
          segment.id.includes("-b") &&
          Math.abs(segment.startSec - boundaryRelative) <= 0.02,
      );
      if (crossesManualSceneBoundary) {
        toaster.create({
          type: "error",
          title: "Subtitles cannot be merged across scenes",
          description: "Remove the scene split first, then merge these subtitle lines.",
        });
        return false;
      }
      const nextSlice = mergeAdjacentSubtitleLines(
        getStudioDocument().transcriptSlice,
        index,
      );
      studioSession.dispatch({
        type: "document.edit",
        action: { type: "setTranscriptSlice", transcriptSlice: nextSlice },
      });
      return true;
    },
    [effectiveClipStartSec, getStudioDocument, segments, studioSession, utterances,
    ],
  );

  const setPlaybackRate = useCallback((rate: number) => {
    studioSession.dispatch({ type: "playback.set-rate", rate });
  }, [studioSession],
  );

  const togglePlay = useCallback(() => {
    studioSession.dispatch({ type: "playback.toggle" });
  }, [studioSession]);

  // `t` is EDITED-timeline seconds (the clock's own unit) — converted to an
  // absolute source second via the map, then to the active file's own
  // local time, so a seek can never land inside a cut (editedToSource only
  // ever returns kept-segment seconds; see edit-ranges.ts).
  const seekTo = useCallback((t: number) => {
    studioSession.dispatch({ type: "playback.seek", editedTimeSec: t });
  }, [studioSession],
  );

  // Split stays client-only (vizard-parity.md Phase B step 9) — it only
  // ever defines selection boundaries within the `segments` array, which is
  // still stored clip-relative-to-source (see edited-timeline.ts's doc
  // comment on `projectSegmentToEdited`). The playhead itself is EDITED
  // time, so it's converted back to that same source-relative convention
  // before searching for the segment it falls in.
  const splitAtPlayhead = useCallback(() => {
    const editedTime = playbackClock.getSnapshot();
    // Same base rule as deleteSelectedSegment's fix 8 below: `segments` are
    // authored against the EFFECTIVE clip start (`effectiveClipStartSec`),
    // not `doc.clipStartSec` — the two can disagree on legacy rows (and,
    // post Phase B step 13, momentarily right after a trim if this ever ran
    // before the resegment dispatch settled).
    const unsnappedSourceSec = editedToSource(editedTimeMap, editedTime);
    const unsnappedRelativeTime = unsnappedSourceSec - effectiveClipStartSec;
    const active = segments.find(
      (s) => unsnappedRelativeTime >= s.startSec && unsnappedRelativeTime <= s.endSec,
    );
    if (!active) return;
    const snappedSourceSec = timelineSnapping
      ? nearestTimedWordBoundary(
          utterances,
          unsnappedSourceSec,
          effectiveClipStartSec + active.startSec,
          effectiveClipStartSec + active.endSec,
        )
      : unsnappedSourceSec;
    const sourceRelativeTime = snappedSourceSec - effectiveClipStartSec;
    if (
      sourceRelativeTime <= active.startSec + 0.1 ||
      sourceRelativeTime >= active.endSec - 0.1
    ) return;

    const newSegments = segments.flatMap((s) => {
      if (s.id !== active.id) return [s];
      return [
        {
          ...s,
          label: labelForTimelineSegment(
            utterances,
            effectiveClipStartSec,
            s.startSec,
            sourceRelativeTime,
            s.label,
          ),
          endSec: sourceRelativeTime,
        },
        {
          id: `${s.id}-b`,
          label: labelForTimelineSegment(
            utterances,
            effectiveClipStartSec,
            sourceRelativeTime,
            s.endSec,
            s.label,
          ),
          startSec: sourceRelativeTime,
          endSec: s.endSec,
        },
      ];
    });
    setSegments(newSegments);
  }, [
    segments,
    playbackClock,
    setSegments,
    editedTimeMap,
    effectiveClipStartSec,
    timelineSnapping,
    utterances,
  ]);

  // Vizard-parity Phase B step 9: Backspace/Delete on a selected segment
  // persists the cut through `doc.deletedRanges` (undoable, autosaved,
  // renders invalidated — see clip.service.ts) instead of the old
  // cosmetic-only array splice. The `segments` array itself is left
  // untouched: once `deletedRanges` covers a segment's whole source range,
  // it simply stops being drawn (edited-timeline.ts's
  // `projectSegmentToEdited` returns null for it) — reverting the range
  // (see `revertDeletedRange`) makes it reappear for free, with no separate
  // "segments" undo step needed.
  const deleteSelectedSegment = useCallback(() => {
    if (!selectedSegmentId) return;
    const seg = segments.find((s) => s.id === selectedSegmentId);
    if (!seg) {
      // Stale selection (segment no longer exists) — nothing to reject, so
      // clearing it here is just cleanup, not the "blocked delete" case
      // fix 9 cares about below.
      setSelectedSegmentId(null);
      return;
    }

    // Fix 8: `segments` (built server-side at load, or client-side by the
    // `resegment` dispatch after a trim — see edited-timeline.ts's
    // `buildSegmentsFromUtterances`) are built against the EFFECTIVE clip
    // start (`effectiveClipStartSec` below), which is NOT always
    // `doc.clipStartSec` (the persisted, raw `clip.startSec`): they can
    // disagree on legacy rows whose stored boundary didn't land exactly on a
    // word/sentence edge before the finalize-once boundary overhaul. Rebase
    // against the SAME base the segments were actually built from, not the
    // document's, so the absolute range handed to `deleteRange` can't
    // silently shift by however far the two happen to disagree.
    const range: SourceRange = {
      startSec: effectiveClipStartSec + seg.startSec,
      endSec: effectiveClipStartSec + seg.endSec,
    };
    const window = { startSec: doc.clipStartSec, endSec: doc.clipEndSec };
    const { blocked } = computeDeleteCandidate(doc.deletedRanges, window, range,
    );
    if (blocked) {
      toaster.create({
        type: "error",
        title: "Can't delete the only remaining content",
        description: "Keep at least one segment in the clip.",
      });
      // Fix 9: a REJECTED delete must not clear the user's selection —
      // only a delete that actually goes through does (below). Otherwise
      // the error toast is followed by the selected block silently
      // deselecting, which reads as "the delete happened" when it didn't.
      return;
    }

    setSelectedSegmentId(null);
    studioSession.dispatch({
      type: "document.edit",
      action: { type: "deleteRange", range },
    });
  }, [
    selectedSegmentId,
    segments,
    effectiveClipStartSec,
    doc.clipStartSec,
    doc.clipEndSec,
    doc.deletedRanges,
    studioSession,
  ]);

  const revertDeletedRange = useCallback((range: SourceRange) => {
    studioSession.dispatch({
      type: "document.edit",
      action: { type: "revertRange", range },
    });
  }, [studioSession],
  );

  // Vizard-parity Phase B step 11: deletes an arbitrary absolute-source-
  // second range selected in the transcript panel (as opposed to
  // `deleteSelectedSegment`'s timeline-segment range) — same isEmpty guard
  // (shared via `computeDeleteCandidate`), same undoable `deleteRange`
  // dispatch. Returns whether the delete actually went through so the
  // caller (transcript-panel.tsx) knows whether to clear its own selection
  // state — mirroring fix 9's "a rejected delete must not clear the
  // selection" rule above.
  const deleteSourceRange = useCallback(
    (range: SourceRange): boolean => {
      const window = { startSec: doc.clipStartSec, endSec: doc.clipEndSec };
      const { candidateRanges, blocked } = computeDeleteCandidate(
        doc.deletedRanges,
        window,
        range,
      );
      if (blocked) {
        toaster.create({
          type: "error",
          title: "Can't delete the only remaining content",
          description: "Keep at least one segment in the clip.",
        });
        return false;
      }
      // Guard 4 (vizard-parity.md §4 step 11): the selection is already
      // fully covered by existing deletedRanges — dispatching would be a
      // guaranteed no-op the reducer would just bounce back (jsonEqual
      // check in `applyEditorAction`'s "deleteRange" branch). The panel
      // itself should never reach this path (an all-deleted selection shows
      // Revert, not Delete), but skip the dispatch defensively rather than
      // relying on that alone.
      if (JSON.stringify(candidateRanges) === JSON.stringify(doc.deletedRanges)) {
        return false;
      }
      studioSession.dispatch({
        type: "document.edit",
        action: { type: "deleteRange", range },
      });
      return true;
    },
    [doc.clipStartSec, doc.clipEndSec, doc.deletedRanges, studioSession],
  );

  // Vizard-parity Phase B step 12: Remove silence. `detected` is a batch of
  // ranges the caller (timeline.tsx's popover) already computed with the
  // pure `detectSilenceRanges` (packages/validators) for its own live
  // preview line — what's shown before Apply is exactly what gets unioned
  // and dispatched here, never recomputed. Unions with the existing manual
  // `deletedRanges` (never replaces them — a manual cut always survives)
  // and reuses the same isEmpty guard/toast every other delete path uses,
  // via `computeDeleteCandidate`'s multi-range form. One `setDeletedRanges`
  // dispatch = one undo step, so ⌘Z restores exactly the pre-Apply
  // deletedRanges (manual cuts included) in a single action.
  const applyRemoveSilence = useCallback(
    (detected: SourceRange[]): boolean => {
      if (detected.length === 0) return false;
      const { candidateRanges, blocked } = computeDeleteCandidate(
        doc.deletedRanges,
        clipWindow,
        detected,
      );
      if (blocked) {
        toaster.create({
          type: "error",
          title: "Can't delete the only remaining content",
          description: "Keep at least one segment in the clip.",
        });
        return false;
      }
      // Every detected range already sits outside `doc.deletedRanges`
      // (silence-detection.ts subtracts existingDeleted before returning),
      // but guard defensively against a stale preview re-detecting nothing
      // new rather than relying on that alone.
      if (JSON.stringify(candidateRanges) === JSON.stringify(doc.deletedRanges)) {
        return false;
      }
      studioSession.dispatch({
        type: "document.edit",
        action: { type: "setDeletedRanges", ranges: candidateRanges },
      });
      return true;
    },
    [doc.deletedRanges, clipWindow, studioSession],
  );

  // Vizard-parity Phase B step 10: word-level Correct — changes only ONE
  // word's text via the reducer's non-retiming `updateWordText` action
  // (distinct from `updateUtteranceText` above, which rewrites the whole
  // utterance with proportional timing redistribution). This is what the
  // transcript panel's double-click-to-correct UI dispatches; no
  // coalesceKey is passed, so every correction is its own undo step.
  const updateWord = useCallback((utteranceIndex: number, wordIndex: number, text: string) => {
    studioSession.dispatch({
      type: "document.edit",
      action: { type: "updateWordText", utteranceIndex, wordIndex, text },
    });
  }, [studioSession],
  );

  // Vizard-parity Phase B step 13 (in-studio trim): commits a drag on either
  // timeline trim handle. `newStartSec`/`newEndSec` arrive already
  // word-snapped and guard-clamped (min/max duration, source-duration
  // ceiling — see timeline.tsx's handles), so this only needs to turn them
  // into a document mutation: rebuild transcriptSlice from the FULL project
  // transcript for the new window (the same primitives the server's own
  // boundary paths use — see buildTranscriptSliceForWindow's doc comment),
  // then dispatch ONE composite `trimClip` action (bounds + slice, one undo
  // step covering deletedRanges/textLayers rebase too) plus a silent
  // `resegment` so the timeline's utterance blocks rebuild against the new
  // window in the SAME state update — see unified-editor-history.ts's
  // `resegment` doc comment for why that doesn't cost a second ⌘Z press.
  //
  // `loadTrimTranscript` is normally already resolved from cache by the
  // time a drag ends (the handle prefetches on pointerdown) — awaiting it
  // here is a safety net for a commit that somehow races ahead of that
  // fetch, not the common path.
  const commitTrim = useCallback(
    async (newStartSec: number, newEndSec: number) => {
      const { rawUtterances } = await loadTrimTranscript(clipInfo.projectId);
      const rawSlice = buildTranscriptSliceForWindow(rawUtterances, {
        startSec: newStartSec,
        endSec: newEndSec,
      });
      // Phase B closing review finding 1: `rawSlice` is built purely from
      // the RAW project transcript, which carries none of this session's
      // word-level corrections (updateWordText) — merging the CURRENT doc's
      // corrected words back in is what stops a trim from silently
      // discarding them (see mergeCorrectedWordsIntoWindow's own doc
      // comment for the exact matching rule).
      const newSlice = mergeCorrectedWordsIntoWindow(rawSlice, doc.transcriptSlice,
      );
      // Same effective-timing pass the `effectiveTiming` memo above runs —
      // computed explicitly here (not read from that memo) because segments
      // need to be built against the window this dispatch is ABOUT to
      // produce, in the SAME synchronous state update, not next render.
      const newEffective = getEffectiveClipTiming({
        utterances: newSlice,
        startSec: newStartSec,
        endSec: newEndSec,
        tailPadSec: 0,
      });
      const newSegments = buildSegmentsFromUtterances(
        newEffective.transcriptSlice,
        newEffective.startSec,
        newEffective.durationSec,
      );
      await studioSession.perform({
        type: "trim",
        startSec: newStartSec,
        endSec: newEndSec,
        transcriptSlice: newSlice,
        segments: newSegments,
      });
    },
    [clipInfo.projectId, doc.transcriptSlice, studioSession],
  );

  // Cloud checkpoint and reset barriers are projected by the session.
  const trimHandlesDisabled = saveState === "saving" || resetState === "resetting";

  const applyHistoryIntent = useCallback(
    (type: "history.undo" | "history.redo") => {
      studioSession.dispatch({ type });
    },
    [studioSession],
  );

  const handleUndo = useCallback(() => {
    applyHistoryIntent("history.undo");
  }, [applyHistoryIntent]);

  const handleRedo = useCallback(() => {
    applyHistoryIntent("history.redo");
  }, [applyHistoryIntent]);

  const handleSave = useCallback(async () => {
    const result = await studioSession.perform({ type: "checkpoint-cloud" });
    if (result.kind === "cloud-current") return;
    toaster.create({
      type: "error",
      title: "Save paused",
      description:
        result.kind === "cloud-blocked" && result.reason === "semantic-rejection"
          ? "Correct the rejected edit and save again. Your device draft is safe."
          : "Narriflow could not make this revision current yet. Your device draft is safe.",
    });
  }, [studioSession]);

  const handleExport = useCallback(async (options: StudioExportOptions) => {
    if (compositionPlanStatus === "invalid") {
      toaster.create({
        type: "error",
        title: "Export blocked",
        description: "Fix the invalid composition before exporting.",
      });
      return;
    }
    setExportState("exporting");
    try {
      const prepared = await studioSession.perform({
        type: "prepare-cloud-revision",
      });
      if (prepared.kind !== "cloud-prepared") {
        throw new Error("save failed before export");
      }
      const response = await fetch(
        `/api/projects/${clipInfo.projectId}/clips/${clipInfo.id}/exports`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            expectedRevision: prepared.revision,
            aspectRatios: options.aspectRatios,
            resolution: options.resolution,
          }),
        },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.export?.id) {
        if (response.status === 409) {
          throw new StudioExportRequestError("editor_revision_conflict");
        }
        throw new StudioExportRequestError("export_queue_failed");
      }
      setExportState("queued");
      router.push(
        `/projects/${clipInfo.projectId}/clips/${clipInfo.id}/exports/${body.export.id}`,
      );
    } catch (error) {
      setExportState("idle");
      toaster.create({
        type: "error",
        title: "Export failed",
        description:
          error instanceof StudioExportRequestError && error.code === "editor_revision_conflict"
            ? "The clip changed in another session. Reload before exporting."
            : "The render couldn't be queued. Try again.",
      });
    }
  }, [
    compositionPlanStatus,
    studioSession,
    clipInfo.projectId,
    clipInfo.id,
    router,
  ],
  );

  // ─── Reset to original (vizard-parity.md Phase A step 4) ────────────────
  const handleReset = useCallback(async () => {
    if (resetState === "resetting" || !hasWriteOwnership) return;
    setResetState("resetting");
    try {
      const result = await studioSession.perform({ type: "reset-to-original" });
      if (result.kind !== "reset-complete") {
        throw new Error(
          result.kind === "cloud-blocked" ? result.reason : "reset unavailable",
        );
      }
      suppressNavigationWarning();
      window.location.reload();
    } catch {
      toaster.create({
        type: "error",
        title: "Reset failed",
        description: "This clip couldn't be reset to its original version. Try again.",
      });
    } finally {
      setResetState((s) => (s === "resetting" ? "idle" : s));
    }
  }, [hasWriteOwnership, resetState, studioSession, suppressNavigationWarning]);

  const handleTakeOverEditing = useCallback(() => {
    void studioSession.perform({ type: "take-over" }).then((result) => {
      if (result.kind !== "ownership-acquired") {
        toaster.create({
          type: "error",
          title: "Could not take over editing",
          description: "Try again in a moment. Your open draft has not been changed.",
        });
      }
    });
  }, [studioSession]);

  const handleKeepCloudDraft = useCallback(() => {
    if (!sessionDraftConflict) return;
    void studioSession
      .perform({ type: "resolve-conflict", choice: "cloud" })
      .then((result) => {
        if (result.kind === "conflict-resolved-degraded") {
          toaster.create({
            type: "warning",
            title: "Cloud version kept with reduced recovery",
            description:
              "Cloud editing can continue, but this browser could not remove its obsolete device draft.",
          });
          return;
        }
        if (result.kind !== "conflict-resolution-blocked") return;
        toaster.create({
          type: "error",
          title: "Cloud choice could not be completed",
          description: "Another tab took ownership. Reload before choosing a version.",
        });
      });
  }, [sessionDraftConflict, studioSession]);

  const handleRecoverConflictingDraft = useCallback(() => {
    if (!sessionDraftConflict) return;
    void studioSession
      .perform({ type: "resolve-conflict", choice: "device" })
      .then(() => undefined);
  }, [sessionDraftConflict, studioSession]);


  const selectCaption = useCallback(() => {
    setCaptionSelected(true);
    setSelectedTextLayerId(null);
    // `selectedSegmentId` sits outside the caption<->text-layer
    // single-selection invariant these two setters otherwise enforce — left
    // set here, a stale segment selection survives selecting the caption
    // and a subsequent Delete/Backspace would delete THAT segment instead
    // of doing anything caption-related.
    setSelectedSegmentId(null);
    setActiveTool("captions");
  }, []);

  const deselectCaption = useCallback(() => {
    setCaptionSelected(false);
    setActiveTool((prev) => (prev === "captions" ? null : prev));
  }, []);

  const selectTextLayer = useCallback((id: string) => {
    setSelectedTextLayerId(id);
    setCaptionSelected(false);
    // See selectCaption's comment above — same gap, same fix.
    setSelectedSegmentId(null);
    setActiveTool("text");
  }, []);

  const deselectTextLayer = useCallback(() => {
    setSelectedTextLayerId(null);
    setActiveTool((prev) => (prev === "text" ? null : prev));
  }, []);

  // Delete/Backspace with a text layer selected deletes THAT layer, not a
  // timeline segment — mirrors text-panel.tsx's `removeLayer` but lives
  // here so the keyboard handler (which has no direct handle on the panel)
  // can call it.
  const deleteSelectedTextLayer = useCallback(() => {
    if (!selectedTextLayerId) return;
    const id = selectedTextLayerId;
    setStudioEdits((prev) => ({
      ...prev,
      textLayers: prev.textLayers.filter((layer) => layer.id !== id),
    }));
    deselectTextLayer();
  }, [selectedTextLayerId, setStudioEdits, deselectTextLayer]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const canMutate = hasWriteOwnership && !sessionDraftConflict;
      const tag = (e.target as HTMLElement)?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (e.target as HTMLElement)?.isContentEditable
      ) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          seekTo(playbackClock.getSnapshot() + (e.shiftKey ? 5 : 1 / 30));
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekTo(playbackClock.getSnapshot() - (e.shiftKey ? 5 : 1 / 30));
          break;
        case "d":
        case "D":
          if (canMutate && !e.ctrlKey && !e.metaKey) splitAtPlayhead();
          break;
        case "b":
        case "B":
          if (canMutate && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            splitAtPlayhead();
          }
          break;
        case "Backspace":
        case "Delete":
          // A selected text layer takes priority: `selectedSegmentId` and
          // `selectedTextLayerId` can both be stale-set at once (segment
          // selection is a raw setter the timeline calls directly, outside
          // the caption<->text-layer invariant) — without this check,
          // Delete could destroy a real document mutation (the segment)
          // while the user's visible selection is the text layer.
          if (!canMutate) break;
          if (selectedTextLayerId) {
            deleteSelectedTextLayer();
          } else {
            deleteSelectedSegment();
          }
          break;
        case "1":
        case "Home":
          e.preventDefault();
          seekTo(0);
          break;
        case "End":
          e.preventDefault();
          seekTo(duration);
          break;
        case "\\":
          setTimelineZoom(1);
          break;
        case "+":
        case "=":
          setTimelineZoom((z) => Math.min(8, z + 0.25));
          break;
        case "-":
          setTimelineZoom((z) => Math.max(0.05, z - 0.25));
          break;
        case "n":
        case "N":
          if (!e.ctrlKey && !e.metaKey) setTimelineSnapping((value) => !value);
          break;
        case "h":
        case "H":
          if (!e.ctrlKey && !e.metaKey) setShowTimeline((v) => !v);
          break;
        case "?":
          setShowShortcuts(true);
          break;
        case "z":
        case "Z":
          if (canMutate && (e.ctrlKey || e.metaKey) && e.shiftKey) {
            e.preventDefault();
            handleRedo();
          } else if (canMutate && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleUndo();
          }
          break;
        case "Escape":
          if (captionSelected) { deselectCaption(); break; }
          if (selectedTextLayerId) { deselectTextLayer(); break; }
          setShowShortcuts(false);
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, playbackClock, duration, splitAtPlayhead, deleteSelectedSegment, deleteSelectedTextLayer, handleUndo, handleRedo, captionSelected, deselectCaption, selectedTextLayerId, deselectTextLayer, hasWriteOwnership, sessionDraftConflict,
  ]);

  // The timeline's thumbnail cache and hidden scrub <video> elements
  // (timeline-preview-manager.ts) live in module scope, not React state, so
  // they survive across re-renders on purpose (that's the whole point of the
  // cache) but never get released on their own. Free them once, when the
  // studio itself unmounts — not when the timeline panel is merely toggled
  // hidden, which unmounts <Timeline /> far more often.
  useEffect(() => {
    return () => {
      releaseTimelineThumbnailResources();
    };
  }, []);

  // Below the minimum usable width, skip the three-pane editor entirely
  // rather than rendering a transcript-less, inspector-cramped studio. All
  // hooks above have already run unconditionally, so this early return is
  // safe with respect to the rules of hooks.
  if (isViewportTooSmall) {
    return (
      <Flex minH="100dvh" align="center" justify="center" p="6" bg="studio.canvas" color="studio.fg">
        <Stack gap="5" maxW="360px" align="center" textAlign="center" animation="fade-up">
          <Flex
            w="72px"
            h="72px"
            align="center"
            justify="center"
            borderWidth="1px"
            borderStyle="dashed"
            borderColor="studio.borderStrong"
            borderRadius="l2"
            color="studio.fgSubtle"
          >
            <Monitor size={28} strokeWidth={1.5} />
          </Flex>
          <Stack gap="2" align="center">
            <Text textStyle="eyebrow" color="studio.fgMuted">
              Studio
            </Text>
            <Heading textStyle="title" fontSize="20px" color="studio.fg">
              Open the studio on a larger screen
            </Heading>
            <Text color="studio.fgMuted" fontSize="14px">
              The editor needs more room for the transcript, preview, and
              tools — try a tablet in landscape or a desktop display.
            </Text>
          </Stack>
          <Button
            size="sm"
            variant="solid"
            colorPalette="accent"
            onClick={() => router.push(`/projects/${clipInfo.projectId}`)}
          >
            Back to project
          </Button>
        </Stack>
      </Flex>
    );
  }

  const displayedSaveState: StudioSaveState =
    sessionSafetyDegraded &&
    (saveState === "idle" || saveState === "local" || saveState === "readonly")
      ? "degraded"
      : saveState;

  const ctx: StudioContextValue = {
    isPlaying, playbackRate, duration, activeTool, showTimeline, timelineSnapping, aspectRatio,
    layoutMode, showShortcuts, timelineZoom, selectedSegmentId, transcriptSelectionRange,
    captionPreset, captionSelected, selectedTextLayerId, transcriptOnly, segments, studioEdits, brollUrl,
    brollPreviewAsset,
    saveState: displayedSaveState, isDocDirty, exportState, compositionPlanStatus,
    resetState, canUndo, canRedo, canReset,
    editorDocument: doc,
    transcript: derivedTranscript, clipInfo, mediaRef, playbackClock, setSourceAudioEnvelope,
    sourceVideoUrl, sourcePreviewId,
    clipStartSec: effectiveClipStartSec, clipEndSec: effectiveClipEndSec, sourcePurged,
    previewVideoUrl, previewStartSec, waveformPeaksUrl, useOriginalSourceFallback, setUseOriginalSourceFallback, reloadPlayback,
    activeVideoUrl, activeOffsetSec, activeVideoKind, playerClipStartSec, playerClipEndSec,
    editedTimeMap, deletedRanges: doc.deletedRanges, clipWindow,
    brandLogo, layoutAnalysis, layoutAnalysisFailure, autoLayoutAnalysis, splitLayoutAnalysis, splitLayoutFailure, autoLayoutAnalysisStatus, utterances, updateUtteranceText,
    updateParagraphText, addSubtitleLineAfter, deleteSubtitleLine, mergeSubtitleLineWithNext,
    updateWord, deleteSourceRange, applyRemoveSilence,
    setPlaybackRate, setActiveTool, setShowTimeline, setTimelineSnapping, setAspectRatio,
    setLayoutMode, setShowShortcuts, setTimelineZoom,
    setSelectedSegmentId, setTranscriptSelectionRange, setCaptionPreset, selectCaption, deselectCaption,
    selectTextLayer, deselectTextLayer,
    setTranscriptOnly, setSegments, setStudioEdits, setBrollUrl, setBrollPreviewAsset, endCoalesce,
    revertDeletedRange,
    togglePlay, seekTo, splitAtPlayhead, deleteSelectedSegment, handleSave, handleExport,
    reportCompositionPlanStatus, compositionPlanQaFixture,
    handleUndo, handleRedo, handleReset, commitTrim, trimHandlesDisabled,
  };

  return (
    <StudioContext.Provider value={ctx}>
      <Flex
        direction="column"
        h="100dvh"
        bg="studio.canvas"
        overflow="hidden"
        position="relative"
      >
        {/* Top bar */}
        <TopBar />

        {/* Main area */}
        <Flex flex="1" overflow="hidden" position="relative">
          {/* Transcript panel */}
          <TranscriptPanel />

          {/* Video preview */}
          <Box flex="1" overflow="hidden" position="relative">
            <VideoPreview />
          </Box>

          {/* Tool sidebar */}
          <ToolSidebar />
        </Flex>

        {/* Timeline */}
        <Timeline />

        {/* Keyboard shortcuts modal */}
        <KeyboardShortcutsModal />

        <StudioWriteLeaseOverlay
          visible={draftRecoveryReady && writeOwnershipReady && !hasWriteOwnership}
          onTakeOver={handleTakeOverEditing}
        />

        <DraftRecoveryDialog
          open={sessionDraftConflict}
          conflictPaths={[...recovery.conflictPaths]}
          onKeepCloud={handleKeepCloudDraft}
          onRecoverLocal={handleRecoverConflictingDraft}
        />
      </Flex>
    </StudioContext.Provider>
  );
}
