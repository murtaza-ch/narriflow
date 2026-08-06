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
  getEffectiveClipTiming,
  editedToSource,
  isSourceTimeDeleted,
  normalizeDeletedRanges,
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
} from "@narriflow/validators";
import { TopBar } from "./top-bar";
import { TranscriptPanel } from "./transcript-panel";
import { VideoPreview } from "./video-preview";
import { ToolSidebar } from "./tool-sidebar";
import { Timeline } from "./timeline";
import { KeyboardShortcutsModal } from "./keyboard-shortcuts-modal";
import { createPlaybackClock, type PlaybackClock } from "./playback-clock";
import { buildStudioCutPlan, buildSegmentsFromUtterances } from "./edited-timeline";
import { rippleSeekSourceSec, stepRipple } from "./ripple-playback";
import { loadTrimTranscript } from "./trim-transcript-cache";
import {
  releaseTimelineThumbnailResources,
  type ThumbnailVideoKind,
} from "./timeline-preview-manager";
import {
  applyUnifiedEditorAction,
  canRedoUnified,
  canUndoUnified,
  createUnifiedEditorHistory,
  type UnifiedEditorHistory,
} from "./unified-editor-history";
import {
  combineSaveOutcomes,
  completeSave,
  requestSave,
  type SaveOutcome,
  type SaveQueueState,
} from "./save-queue";

/**
 * Below this width the transcript panel has already hidden (it collapses
 * under 1024px) and the 260px fixed inspector has nowhere left to go — the
 * three-pane editor stops being usable well before typical phone/small-tablet
 * widths. Gate it with an explicit message instead of shipping a silently
 * broken layout.
 */
const STUDIO_MIN_VIEWPORT_WIDTH = 900;

/** How often to re-check preview-proxy readiness while it's still
 *  generating (see the poll effect in `StudioShell`). */
const PREVIEW_POLL_INTERVAL_MS = 8_000;
/** Give up after this many ticks (~6 minutes at the interval above) — the
 *  worker's proxy cut "usually takes a minute or two", so this leaves
 *  comfortable margin without polling a stuck job forever. */
const PREVIEW_POLL_MAX_ATTEMPTS = 45;

/** How long to wait after the last edit before autosaving. */
const AUTOSAVE_DEBOUNCE_MS = 1500;

/** Fix 4: a barely-there nudge back from the exact edited duration when
 *  resolving where end-of-playback should park — just enough that
 *  `editedToSource` lands inside the final kept segment instead of exactly
 *  on its far boundary (which, per edit-ranges.ts's half-open convention,
 *  is really the first INSTANT of the next cut, not a frame that's safe to
 *  park on). See `lastKeptPlayerTimeSec` below. */
const LAST_KEPT_FRAME_EPSILON_SEC = 0.001;

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
  const candidateRanges = normalizeDeletedRanges([...currentDeletedRanges, ...additions], window);
  return { candidateRanges, blocked: buildStudioCutPlan(candidateRanges, window).isEmpty };
}

/** Finding 2 (Phase B closing review): `performSave` must only clear
 *  `boundaryEditIntentRef` once there is no PENDING boundary change left to
 *  cover — i.e. the LATEST document's bounds (which may have moved again
 *  while a save was in flight, or already matched going in on a true no-op
 *  save) still agree with `savedBounds`. Clearing it unconditionally on
 *  every save's success used to wipe the flag out from under a trim that
 *  committed mid-flight during an unrelated (non-boundary) save: the trim's
 *  own `boundaryEditIntentRef.current = true` landed before that in-flight
 *  save's fetch resolved, got clobbered by the unconditional clear, and the
 *  trim's own follow-up save then hit the `boundsChanged &&
 *  !boundaryEditIntentRef.current` guard and was falsely blocked as "editor
 *  state got out of sync" — even though both saves individually succeeded. */
function boundsConverged(
  current: { clipStartSec: number; clipEndSec: number },
  savedBounds: { startSec: number; endSec: number },
): boolean {
  return (
    Math.abs(current.clipStartSec - savedBounds.startSec) <= 0.001 &&
    Math.abs(current.clipEndSec - savedBounds.endSec) <= 0.001
  );
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
export type { CaptionAnimation, CaptionPreset };
export type ToolId =
  | "captions"
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

export interface TimelineSegment {
  id: string;
  label: string;
  startSec: number;
  endSec: number;
}

/** The project's brand logo, pre-resolved server-side (studio/page.tsx) from
 *  the frozen project brand snapshot: a presigned download URL plus the
 *  snapshot's own position/opacity/scalePct (the per-clip defaults before
 *  any `studioEdits.logo` override — see `resolveEffectiveLogoSettings` in
 *  @narriflow/validators for how the two combine). `null` when the project
 *  has no logo. Immutable for the life of the studio session — swapping
 *  logos happens in Brand kit settings, not here. */
export interface StudioBrandLogo {
  url: string;
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
}

interface StudioState {
  isPlaying: boolean;
  duration: number;
  activeTool: ToolId | null;
  showTimeline: boolean;
  aspectRatio: AspectRatio;
  layoutMode: LayoutMode;
  showShortcuts: boolean;
  timelineZoom: number;
  selectedSegmentId: string | null;
  captionPreset: CaptionPreset;
  captionSelected: boolean;
  /** Vizard-parity Phase C step 1: the one text overlay currently selected on
   *  the canvas/panel/timeline, or null. Mutually exclusive with
   *  `captionSelected` — selecting one deselects the other, matching the
   *  "single selected canvas object" rule. */
  selectedTextLayerId: string | null;
  transcriptOnly: boolean;
  segments: TimelineSegment[];
  studioEdits: StudioEdits;
  /** Current B-roll cutaway URL — lives in the editor document (undoable,
   *  autosaved), not a locally-PATCHed side channel. */
  brollUrl: string | null;
  /** 'blocked' is a distinct terminal state from 'error': it means autosave
   *  has permanently stopped (a 409/422 that a reload is needed to clear),
   *  as opposed to 'error''s transient/retryable failure. */
  saveState: "idle" | "saving" | "saved" | "error" | "blocked";
  exportState: "idle" | "exporting" | "queued";
  resetState: "idle" | "resetting";
  canUndo: boolean;
  canRedo: boolean;
  /** False once resetting would be a no-op — see the canReset computation
   *  below for exactly what "nothing to reset" means. */
  canReset: boolean;
}

interface StudioContextValue extends StudioState {
  transcript: TranscriptItem[];
  clipInfo: ClipInfo;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Phase B closing review finding 5: true for the duration of one commit
   *  whenever a boundary-changing dispatch (trim, or an undo/redo crossing
   *  one) is about to move `playerClipStartSec` — video-preview.tsx's own
   *  `playerClipStartSec`-keyed seek effect checks this and stands down,
   *  ceding the reposition to studio-shell.tsx's `editedTimeMap` reconcile
   *  effect, which clears it once done. See that effect's doc comment for
   *  the full race it resolves. */
  boundaryReconcileOwnsSeekRef: React.RefObject<boolean>;
  playbackClock: PlaybackClock;
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
  /** Presigned URL of the proxy's amplitude-peaks JSON, or null — see the
   *  matching prop's doc comment on `StudioShellProps.waveformPeaksUrl`. */
  waveformPeaksUrl: string | null;
  /** True when the project's source has been purged (`Project.sourceStorageKey`
   *  is null). Once true, a still-missing `previewVideoUrl` can never arrive
   *  — the worker that cuts proxies reads straight from source storage — so
   *  video-preview.tsx shows a terminal message instead of polling or
   *  spinning forever, and hides the "Use original source" escape hatch
   *  (which needs that same now-gone source). */
  sourcePurged: boolean;
  /** True once the user has explicitly opted into loading the full source
   *  (see video-preview.tsx's "Use original source" affordance) because no
   *  proxy exists yet — never set automatically, so a missing proxy never
   *  silently triggers the ~44s full-source load Problem A measured. */
  useOriginalSourceFallback: boolean;
  setUseOriginalSourceFallback: (v: boolean) => void;
  /** Whichever URL is actually meant to be fed to the `<video>` element:
   *  the proxy when ready, else the source only once the user opts in,
   *  else null (nothing to play yet). Also what the timeline scrubs
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
  /** PiP persistence packet C: the worker's screen-mode facecam layout
   *  analysis (packet A/B — `getClipEditorDocument`'s sibling
   *  `layoutAnalysis` field), or `null` when the clip hasn't been analyzed
   *  yet / analysis found no qualifying rect / the stored envelope failed
   *  to parse (see `parseClipLayoutAnalysis`'s doc comment — all three
   *  collapse to `null` here, this context has no use for telling them
   *  apart). Server-seeded ONCE from `studio/page.tsx`'s initial fetch,
   *  same as `brandLogo` — deliberately NOT plumbed through `doc`/
   *  `studioEdits`: it's worker-derived, read-only measurement data, not a
   *  user edit, so it must never enter the undo/redo history or the
   *  autosave PUT body. Consumed today only by video-preview.tsx's screen
   *  framing bottom tile (the true facecam crop) — nothing else reads it.
   *  That consumer gates on `layoutAnalysis.pipUsable === true` (never on
   *  `pipRect`'s nullness alone — see `ClipLayoutAnalysis.pipUsable`'s own
   *  doc comment) and additionally checks `layoutAnalysis.clipStartSec`/
   *  `clipEndSec` against this context's own `clipWindow` before trusting
   *  the rect — see that check's own comment in video-preview.tsx (H2,
   *  adversarial review) for why a stale envelope from before a trim must
   *  never be shown.
   *
   *  Residual staleness this "server-seeded once" contract does NOT close
   *  (H2c, adversarial review): if a render for THIS clip completes and
   *  re-persists `layoutAnalysis` WHILE this studio session is already
   *  open, this context value keeps showing whatever was true at initial
   *  page load until the session refetches (a reload, or a future explicit
   *  poll — no such poll exists today). A newly-landed `pipUsable: true`
   *  won't upgrade the preview from its static center-cover guess without
   *  one; a newly-landed `pipUsable: false` (e.g. this same clip re-
   *  rendered after a trim, and the fresh analysis's face-gate rejected the
   *  new footage) similarly won't downgrade an already-shown crop until
   *  then either. Same class of gap the render-vs-preview divergence note
   *  above already accepts for a single render's face-gate outcome, just on
   *  a longer timescale (across renders within one open session, not within
   *  one render). */
  layoutAnalysis: ClipLayoutAnalysis | null;
  utterances: TranscriptUtterance[];
  updateUtteranceText: (index: number, newText: string) => void;
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
  setIsPlaying: (v: boolean) => void;
  setActiveTool: (t: ToolId | null) => void;
  setShowTimeline: (v: boolean) => void;
  setAspectRatio: (r: AspectRatio) => void;
  setLayoutMode: (m: LayoutMode) => void;
  setShowShortcuts: (v: boolean) => void;
  setTimelineZoom: React.Dispatch<React.SetStateAction<number>>;
  setSelectedSegmentId: (id: string | null) => void;
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
  handleExport: () => void;
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
  /** Presigned URL of the proxy's amplitude-peaks JSON (derived from the
   *  proxy's own storage key — see `derivePeaksStorageKey` in
   *  packages/services), or null when no proxy exists yet, the derived
   *  object doesn't exist (silent-video preview, legacy pre-feature
   *  preview), or presigning it failed. The timeline's WaveformCanvas
   *  fetches this itself and falls back to its synthetic waveform when
   *  null or when the fetch fails — see `waveform-peaks.ts`. */
  waveformPeaksUrl?: string | null;
  /** True when the project's source has been purged — see the doc comment
   *  on `StudioContextValue.sourcePurged`. */
  sourcePurged?: boolean;
  /** Server Action that re-checks this clip's preview-proxy readiness,
   *  defined in studio/page.tsx (see its doc comment for why it's threaded
   *  through as a prop rather than imported by name). Polled by the effect
   *  below while `previewVideoUrl` is still null; omitted entirely (e.g. in
   *  tests) simply disables polling rather than throwing. */
  fetchPreviewStatus?: () => Promise<{
    previewUrl: string | null;
    previewStartSec: number;
    previewDurationSec: number | null;
    waveformPeaksUrl: string | null;
  }>;
  /** Server-seeded brand logo (see studio/page.tsx and `StudioBrandLogo`'s
   *  doc comment), or null/omitted when the project has none. */
  brandLogo?: StudioBrandLogo | null;
  /** Server-seeded screen-mode PiP layout analysis (see
   *  `StudioContextValue.layoutAnalysis`'s doc comment), or null/omitted
   *  when the clip has none yet. */
  layoutAnalysis?: ClipLayoutAnalysis | null;
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
  waveformPeaksUrl: initialWaveformPeaksUrl = null,
  sourcePurged = false,
  fetchPreviewStatus,
  brandLogo = null,
  layoutAnalysis = null,
}: StudioShellProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playbackClock = useMemo(() => createPlaybackClock(), []);
  const isViewportTooSmall = useIsViewportBelow(STUDIO_MIN_VIEWPORT_WIDTH);
  // Only ever flips true from an explicit user action (see video-preview.tsx)
  // — a missing proxy must never silently fall back to the ~44s full-source
  // load that motivated this whole feature.
  const [useOriginalSourceFallback, setUseOriginalSourceFallback] = useState(false);

  // Seeded from the server-rendered snapshot; swapped in live by the poll
  // effect below once the worker's proxy actually lands. Kept as state
  // (rather than reading the props directly) because nothing else about
  // this page ever refreshes on its own — see that effect for why.
  const [previewVideoUrl, setPreviewVideoUrl] = useState(initialPreviewVideoUrl);
  const [previewStartSec, setPreviewStartSec] = useState(initialPreviewStartSec);
  const [waveformPeaksUrl, setWaveformPeaksUrl] = useState(initialWaveformPeaksUrl);

  // While no proxy exists yet, periodically re-check readiness so "Preview
  // generating…" resolves on its own instead of only ever updating on a
  // manual reload (see the module doc comment on studio/page.tsx's
  // `fetchPreviewStatus` for why this is a Server Action passed as a prop).
  // Stops when: the proxy lands (previewVideoUrl flips non-null, which also
  // makes the guard below skip scheduling a next tick), the source is
  // purged (sourcePurged — nothing will ever land), the component unmounts
  // (cleanup clears the pending timeout), or after PREVIEW_POLL_MAX_ATTEMPTS
  // ticks so a genuinely stuck worker job doesn't poll forever.
  useEffect(() => {
    if (previewVideoUrl || sourcePurged || !fetchPreviewStatus) return;

    let cancelled = false;
    let attempts = 0;
    let timeoutId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      attempts += 1;
      try {
        const status = await fetchPreviewStatus();
        if (cancelled) return;
        if (status.previewUrl) {
          setPreviewVideoUrl(status.previewUrl);
          setPreviewStartSec(status.previewStartSec);
          setWaveformPeaksUrl(status.waveformPeaksUrl);
          return; // Ready — don't schedule another tick.
        }
      } catch {
        // Transient failure (network blip, presign hiccup) — just retry on
        // the next tick instead of surfacing an error for a background poll.
      }
      if (!cancelled && attempts < PREVIEW_POLL_MAX_ATTEMPTS) {
        timeoutId = setTimeout(poll, PREVIEW_POLL_INTERVAL_MS);
      }
    };

    timeoutId = setTimeout(poll, PREVIEW_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [previewVideoUrl, sourcePurged, fetchPreviewStatus]);

  // ─── Unified editor document + segment history (vizard-parity.md Phase A
  // step 3) ────────────────────────────────────────────────────────────────
  // Everything the studio can mutate (captionPreset, transcriptSlice,
  // studioEdits, brollUrl, deletedRanges) lives in ONE EditorHistory, plus
  // the client-only timeline segments, interleaved into one undo/redo order
  // — see unified-editor-history.ts for why these stay as two underlying
  // stacks instead of one merged array.
  const [unified, setUnified] = useState<UnifiedEditorHistory>(() =>
    createUnifiedEditorHistory(initialEditorDocument, timelineSegments),
  );

  // Named `doc` (not `document`) to avoid shadowing the global DOM object.
  const doc = unified.doc.present;
  const captionPreset = doc.captionPreset;
  const studioEdits = doc.studioEdits;
  const brollUrl = doc.brollUrl;
  const segments = unified.segments;
  const canUndo = canUndoUnified(unified);
  const canRedo = canRedoUnified(unified);

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

  const activeVideoUrl = previewVideoUrl ?? (useOriginalSourceFallback ? sourceVideoUrl : null);
  // Source time -> "whichever file is actually playing" time. Zero when
  // there's no proxy (i.e. we're playing the source as-is, or nothing).
  const activeOffsetSec = previewVideoUrl ? previewStartSec : 0;
  // Mirrors activeOffsetSec's own condition: the proxy wins whenever it
  // exists, regardless of useOriginalSourceFallback (that flag only decides
  // what happens in ITS absence). Consumers only need to branch on this when
  // activeVideoUrl is non-null.
  const activeVideoKind: ThumbnailVideoKind = previewVideoUrl ? "proxy" : "source";
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
      : { startSec: doc.clipStartSec, endSec: doc.clipStartSec + Math.max(0, clipInfo.duration) };
  }, [doc.clipStartSec, doc.clipEndSec, clipInfo.duration]);

  const editedTimeMap: EditedTimeMap = useMemo(
    () => buildStudioCutPlan(doc.deletedRanges, clipWindow).map,
    [doc.deletedRanges, clipWindow],
  );

  // `duration` IS the edited duration — identical to the old
  // `clipEndSec - clipStartSec` computation whenever `deletedRanges` is
  // empty (the fast path), strictly shorter once cuts exist.
  const duration = editedTimeMap.editedDurationSec;

  // File-local position of edited time 0 — usually `playerClipStartSec`,
  // EXCEPT when the clip's own opening seconds are themselves deleted, in
  // which case the first kept frame starts later than the raw clip
  // boundary. Anywhere code seeks/resets "to the start" of playback (as
  // opposed to a trim boundary, which `playerClipStartSec` still owns) goes
  // through this instead. Identical to `playerClipStartSec` whenever
  // `deletedRanges` is empty.
  const playerRippleStartSec = editedToSource(editedTimeMap, 0) - activeOffsetSec;

  // Fix 4 (Phase B hardening): mirror of `playerRippleStartSec` for the
  // OTHER end of playback. End-of-playback used to park at
  // `playerClipEndSec` unconditionally — the RAW clip boundary — which is
  // deleted footage whenever the clip's own tail is cut. This resolves the
  // last KEPT source frame instead: a hair before `editedDurationSec` (so
  // `editedToSource` lands strictly inside the final kept segment rather
  // than exactly on its far boundary — see edit-ranges.ts's half-open
  // convention) mapped back through the map, then re-expressed in the
  // active file's own local time. Identical to `playerClipEndSec` whenever
  // `deletedRanges` is empty.
  const lastKeptPlayerTimeSec = useCallback(() => {
    const lastKeptSourceSec = editedToSource(
      editedTimeMap,
      Math.max(0, editedTimeMap.editedDurationSec - LAST_KEPT_FRAME_EPSILON_SEC),
    );
    return lastKeptSourceSec - activeOffsetSec;
  }, [editedTimeMap, activeOffsetSec]);

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

  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [showTimeline, setShowTimeline] = useState(true);
  const router = useRouter();
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(clipInfo.aspectRatio);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("fill");
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [captionSelected, setCaptionSelected] = useState(false);
  const [selectedTextLayerId, setSelectedTextLayerId] = useState<string | null>(null);
  const [transcriptOnly, setTranscriptOnly] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error" | "blocked"
  >("idle");
  const [exportState, setExportState] = useState<
    "idle" | "exporting" | "queued"
  >("idle");
  const [resetState, setResetState] = useState<"idle" | "resetting">("idle");
  const [revision, setRevisionState] = useState(initialEditorRevision);
  const [isDocDirty, setIsDocDirty] = useState(false);

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
    return localDiffersFromOriginal || (revision > 0 && serverDifferedFromOriginalAtLoad);
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
      setUnified((s) => {
        const next =
          typeof updater === "function" ? updater(s.doc.present.captionPreset) : updater;
        return applyUnifiedEditorAction(s, {
          kind: "document",
          action: { type: "setCaptionPreset", captionPreset: next },
          coalesceKey,
        });
      });
    },
    [],
  );

  const setStudioEdits = useCallback(
    (
      updater: StudioEdits | ((prev: StudioEdits) => StudioEdits),
      coalesceKey?: string,
    ) => {
      setUnified((s) => {
        const next =
          typeof updater === "function" ? updater(s.doc.present.studioEdits) : updater;
        return applyUnifiedEditorAction(s, {
          kind: "document",
          action: { type: "setStudioEdits", studioEdits: next },
          coalesceKey,
        });
      });
    },
    [],
  );

  // Fix 8b: gesture end (slider pointer-up, resize-drag pointer-up) breaks
  // the coalesce chain so the NEXT gesture never merges into one that
  // already finished, even if it happens to reuse the same coalesceKey.
  const endCoalesce = useCallback(() => {
    setUnified((s) => applyUnifiedEditorAction(s, { kind: "endCoalesce" }));
  }, []);

  const setBrollUrl = useCallback((url: string | null, coalesceKey?: string) => {
    setUnified((s) =>
      applyUnifiedEditorAction(s, {
        kind: "document",
        action: { type: "setBrollUrl", brollUrl: url },
        coalesceKey,
      }),
    );
  }, []);

  const setSegments = useCallback((next: TimelineSegment[]) => {
    setUnified((s) => applyUnifiedEditorAction(s, { kind: "segments", segments: next }));
  }, []);

  // Update utterance text — whole-utterance rewrite with proportional timing
  // redistribution across the new word count (distinct from the reducer's
  // word-level `updateWordText`, which deliberately never redistributes).
  const updateUtteranceText = useCallback((utteranceIndex: number, newText: string) => {
    setUnified((s) => {
      const prev = s.doc.present.transcriptSlice;
      const utterance = prev[utteranceIndex];
      if (!utterance) return s;

      const newWordTexts = newText.trim().split(/\s+/).filter(Boolean);
      if (newWordTexts.length === 0) return s;

      const utteranceDuration = utterance.endSec - utterance.startSec;
      const wordDuration = utteranceDuration / newWordTexts.length;

      const updatedUtterance = {
        ...utterance,
        text: newText.trim(),
        words: newWordTexts.map((word, i) => ({
          word,
          startSec: utterance.startSec + i * wordDuration,
          endSec: utterance.startSec + (i + 1) * wordDuration,
          confidence: null,
        })),
      };

      const nextSlice = prev.map((u, i) => (i === utteranceIndex ? updatedUtterance : u));
      return applyUnifiedEditorAction(s, {
        kind: "document",
        action: { type: "setTranscriptSlice", transcriptSlice: nextSlice },
      });
    });
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    const currentTime = playbackClock.getSnapshot();
    if (!video || !activeVideoUrl) {
      if (currentTime >= duration - 0.02) {
        playbackClock.setTime(0);
      }
      setIsPlaying((v) => !v);
      return;
    }

    if (
      video.currentTime >= playerClipEndSec - 0.02 ||
      video.currentTime < playerRippleStartSec ||
      currentTime >= duration - 0.02
    ) {
      video.currentTime = playerRippleStartSec;
      playbackClock.setTime(0);
    }
    if (video.paused) {
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, [activeVideoUrl, playerRippleStartSec, playerClipEndSec, duration, playbackClock]);

  // `t` is EDITED-timeline seconds (the clock's own unit) — converted to an
  // absolute source second via the map, then to the active file's own
  // local time, so a seek can never land inside a cut (editedToSource only
  // ever returns kept-segment seconds; see edit-ranges.ts).
  const seekTo = useCallback((t: number) => {
    const clamped = Math.max(0, Math.min(duration, t));
    playbackClock.setTime(clamped);
    if (videoRef.current && activeVideoUrl) {
      videoRef.current.currentTime = editedToSource(editedTimeMap, clamped) - activeOffsetSec;
    }
  }, [duration, editedTimeMap, activeOffsetSec, activeVideoUrl, playbackClock]);

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
    const sourceRelativeTime = editedToSource(editedTimeMap, editedTime) - effectiveClipStartSec;
    const active = segments.find(
      (s) => sourceRelativeTime >= s.startSec && sourceRelativeTime <= s.endSec,
    );
    if (
      !active ||
      sourceRelativeTime <= active.startSec + 0.1 ||
      sourceRelativeTime >= active.endSec - 0.1
    ) return;

    const newSegments = segments.flatMap((s) => {
      if (s.id !== active.id) return [s];
      return [
        { ...s, endSec: sourceRelativeTime },
        { id: `${s.id}-b`, label: s.label, startSec: sourceRelativeTime, endSec: s.endSec },
      ];
    });
    setSegments(newSegments);
  }, [segments, playbackClock, setSegments, editedTimeMap, effectiveClipStartSec]);

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
    const { blocked } = computeDeleteCandidate(doc.deletedRanges, window, range);
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
    setUnified((s) =>
      applyUnifiedEditorAction(s, { kind: "document", action: { type: "deleteRange", range } }),
    );
  }, [
    selectedSegmentId,
    segments,
    effectiveClipStartSec,
    doc.clipStartSec,
    doc.clipEndSec,
    doc.deletedRanges,
  ]);

  const revertDeletedRange = useCallback((range: SourceRange) => {
    setUnified((s) =>
      applyUnifiedEditorAction(s, { kind: "document", action: { type: "revertRange", range } }),
    );
  }, []);

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
      setUnified((s) =>
        applyUnifiedEditorAction(s, { kind: "document", action: { type: "deleteRange", range } }),
      );
      return true;
    },
    [doc.clipStartSec, doc.clipEndSec, doc.deletedRanges],
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
      setUnified((s) =>
        applyUnifiedEditorAction(s, {
          kind: "document",
          action: { type: "setDeletedRanges", ranges: candidateRanges },
        }),
      );
      return true;
    },
    [doc.deletedRanges, clipWindow],
  );

  // Vizard-parity Phase B step 10: word-level Correct — changes only ONE
  // word's text via the reducer's non-retiming `updateWordText` action
  // (distinct from `updateUtteranceText` above, which rewrites the whole
  // utterance with proportional timing redistribution). This is what the
  // transcript panel's double-click-to-correct UI dispatches; no
  // coalesceKey is passed, so every correction is its own undo step.
  const updateWord = useCallback((utteranceIndex: number, wordIndex: number, text: string) => {
    setUnified((s) =>
      applyUnifiedEditorAction(s, {
        kind: "document",
        action: { type: "updateWordText", utteranceIndex, wordIndex, text },
      }),
    );
  }, []);

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
      const newSlice = mergeCorrectedWordsIntoWindow(rawSlice, doc.transcriptSlice);
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
      boundaryEditIntentRef.current = true;
      // Finding 5 (Phase B closing review): a start-handle trim moves
      // `playerClipStartSec`, which video-preview.tsx's own seek effect
      // reacts to by unconditionally snapping playback back to the new
      // clip start — wrong whenever the playhead wasn't already there. The
      // shell's `editedTimeMap` reconcile effect below is the one that
      // actually knows whether the CURRENT playhead position is still valid
      // after this trim (it reseeks only when it isn't, preserving the
      // user's position otherwise), so it must be the one to act. Setting
      // this ref here — synchronously, before the state update that will
      // change both `playerClipStartSec` and `editedTimeMap` in the SAME
      // commit — lets video-preview.tsx's seek effect (which runs first,
      // since it's the child) check it and stand down for this commit; the
      // reconcile effect (which runs after, as the parent) clears it once
      // it's done owning the reposition.
      boundaryReconcileOwnsSeekRef.current = true;
      setUnified((s) => {
        const withTrim = applyUnifiedEditorAction(s, {
          kind: "document",
          action: {
            type: "trimClip",
            startSec: newStartSec,
            endSec: newEndSec,
            transcriptSlice: newSlice,
          },
        });
        return applyUnifiedEditorAction(withTrim, { kind: "resegment", segments: newSegments });
      });
    },
    [clipInfo.projectId, doc.transcriptSlice],
  );

  // Guard item 8 (vizard-parity.md Phase B step 13): the single-flight save
  // queue already serializes the actual PUTs — this just reflects "a save
  // is in flight" in the UI so the handles can't stack a second trim on an
  // unsaved one. Also disabled mid-reset for the same reason handleReset
  // itself blocks autosave (resetInFlightRef) — a trim during a reset
  // negotiation would race it for the same baseRevision.
  const trimHandlesDisabled = saveState === "saving" || resetState === "resetting";

  const handleUndo = useCallback(() => {
    setUnified((s) => {
      const next = applyUnifiedEditorAction(s, { kind: "undo" });
      if (
        next.doc.present.clipStartSec !== s.doc.present.clipStartSec ||
        next.doc.present.clipEndSec !== s.doc.present.clipEndSec
      ) {
        boundaryEditIntentRef.current = true;
        // Finding 5: an undo/redo that crosses a trim step changes
        // `playerClipStartSec` + `editedTimeMap` in this same commit exactly
        // like commitTrim does — same coordination applies.
        boundaryReconcileOwnsSeekRef.current = true;
      }
      return next;
    });
  }, []);

  const handleRedo = useCallback(() => {
    setUnified((s) => {
      const next = applyUnifiedEditorAction(s, { kind: "redo" });
      if (
        next.doc.present.clipStartSec !== s.doc.present.clipStartSec ||
        next.doc.present.clipEndSec !== s.doc.present.clipEndSec
      ) {
        boundaryEditIntentRef.current = true;
        boundaryReconcileOwnsSeekRef.current = true;
      }
      return next;
    });
  }, []);

  // ─── Single-endpoint revision-aware autosave (vizard-parity.md Phase A
  // step 4) ────────────────────────────────────────────────────────────────
  // Replaces the old three-PATCH persistEdits with one revision-guarded PUT
  // of the whole document. Refs (not state) hold the values the async save
  // loop needs to read without re-subscribing on every edit:
  //  - docPresentRef: latest document, kept in sync via effect below.
  //  - lastSavedDocumentJsonRef: what the server last confirmed — the dirty
  //    check compares against this, so a true no-op issues zero requests.
  //  - baseRevisionRef: the revision to send with the next save.
  //  - saveQueueStateRef: the single-flight state machine (save-queue.ts) —
  //    never two overlapping PUTs; an edit that lands mid-flight triggers
  //    exactly one more save once the current one finishes.
  //  - autosaveStoppedRef: set once a 409/422 tells us further autosaving
  //    would just fail again until the user reloads or the conflict clears.
  //  - resetInFlightRef: set for the duration of handleReset's drain+POST so
  //    nothing else (debounce, an explicit save) starts a competing autosave
  //    while a reset is being negotiated with the server (fix 2). Distinct
  //    from autosaveStoppedRef, which is permanent-until-reload — this one
  //    always clears itself when handleReset finishes, success or not.
  //  - suppressUnloadGuardRef: set right before a successful reset's reload
  //    so the beforeunload prompt can't block it (fix 3).
  //  - keepaliveFiredRef: dedupes pagehide + unmount both firing the
  //    keepalive flush for the same teardown (fix 6); reset on `pageshow`
  //    (bfcache restores) so a later real teardown can still flush.
  const docPresentRef = useRef(doc);
  const lastSavedDocumentJsonRef = useRef(JSON.stringify(initialEditorDocument));
  // Vizard-parity Phase B step 13 (in-studio trim): the bounds the server
  // last confirmed — compared against each save's own bounds to detect a
  // boundary-changing save (the server nulls the preview proxy for those;
  // see the success branch below). Deliberately a SEPARATE ref from
  // `lastSavedDocumentJsonRef` rather than parsing bounds back out of it —
  // this only ever needs two numbers, not a full document round-trip.
  const lastSavedBoundsRef = useRef({
    startSec: initialEditorDocument.clipStartSec,
    endSec: initialEditorDocument.clipEndSec,
  });
  // Boundary changes are only ever legitimate as the direct result of an
  // explicit trim (commitTrim) or an undo/redo that crosses a trim step.
  // Anything else producing boundary-differing state (a hot-reload replay
  // in dev, or any future state-corruption bug) must NOT silently persist
  // a trim now that the server accepts boundary changes — performSave
  // refuses to send those and demands a reload instead.
  const boundaryEditIntentRef = useRef(false);
  // Finding 5 (Phase B closing review): set (alongside boundaryEditIntentRef)
  // whenever a dispatch is ABOUT to change both `playerClipStartSec` and
  // `editedTimeMap` in the same commit — a trim (commitTrim) or an undo/redo
  // that crosses one. video-preview.tsx's own `playerClipStartSec`-keyed
  // seek effect checks this and stands down for that commit; the
  // `editedTimeMap` reconcile effect further below — which actually knows
  // whether the current playhead position survived the change — owns the
  // reposition instead, and clears this ref once it has run. See both
  // effects' own doc comments for the full walkthrough.
  const boundaryReconcileOwnsSeekRef = useRef(false);
  const baseRevisionRef = useRef(initialEditorRevision);
  const saveQueueStateRef = useRef<SaveQueueState>("idle");
  const autosaveStoppedRef = useRef(false);
  const resetInFlightRef = useRef(false);
  const suppressUnloadGuardRef = useRef(false);
  const keepaliveFiredRef = useRef(false);
  const currentSavePromiseRef = useRef<Promise<SaveOutcome>>(Promise.resolve("success"));

  const setBaseRevision = useCallback((next: number) => {
    baseRevisionRef.current = next;
    setRevisionState(next);
  }, []);

  useEffect(() => {
    docPresentRef.current = doc;
    setIsDocDirty(JSON.stringify(doc) !== lastSavedDocumentJsonRef.current);
  }, [doc]);

  const performSave = useCallback(async (): Promise<SaveOutcome> => {
    const documentToSave = docPresentRef.current;
    const documentJson = JSON.stringify(documentToSave);
    let outcome: SaveOutcome = "success";

    // Finding 2: clears `boundaryEditIntentRef` iff the LATEST document
    // (which may differ from `documentToSave` — an edit can land while this
    // turn's fetch is in flight) has converged on the bounds already
    // confirmed as saved — see `boundsConverged`'s own doc comment for why
    // this can't just be unconditional.
    const clearBoundaryIntentIfConverged = () => {
      if (boundsConverged(docPresentRef.current, lastSavedBoundsRef.current)) {
        boundaryEditIntentRef.current = false;
      }
    };

    const boundsChanged =
      Math.abs(documentToSave.clipStartSec - lastSavedBoundsRef.current.startSec) > 0.001 ||
      Math.abs(documentToSave.clipEndSec - lastSavedBoundsRef.current.endSec) > 0.001;
    if (boundsChanged && !boundaryEditIntentRef.current) {
      console.warn(
        JSON.stringify({
          level: "error",
          message: "editor_boundary_save_without_intent_blocked",
          clipId: clipInfo.id,
          attemptedStartSec: documentToSave.clipStartSec,
          attemptedEndSec: documentToSave.clipEndSec,
          lastSavedStartSec: lastSavedBoundsRef.current.startSec,
          lastSavedEndSec: lastSavedBoundsRef.current.endSec,
        }),
      );
      autosaveStoppedRef.current = true;
      setSaveState("blocked");
      toaster.create({
        type: "error",
        title: "Editor state got out of sync",
        description: "Reload to keep editing — nothing was saved.",
        action: { label: "Reload", onClick: () => window.location.reload() },
      });
      saveQueueStateRef.current = "idle";
      return "failure";
    }

    if (documentJson === lastSavedDocumentJsonRef.current) {
      // Reached via a queued request that turned out to be a no-op (e.g. an
      // edit landed and was then undone before this turn ran) — nothing to
      // send, but still drain the queue below.
      //
      // Finding 2 (Phase B closing review, LOW): this branch used to leave
      // `boundaryEditIntentRef` completely untouched — a trim that lands and
      // then gets undone back to exactly the last-saved bounds before its
      // own save turn runs left the flag stuck `true` with nothing left to
      // cover. Same conditional clear as the success branch below.
      clearBoundaryIntentIfConverged();
    } else {
      setSaveState("saving");
      try {
        const res = await fetch(
          `/api/projects/${clipInfo.projectId}/clips/${clipInfo.id}/editor`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              baseRevision: baseRevisionRef.current,
              document: documentToSave,
            }),
          },
        );

        if (res.status === 409) {
          // Fix 1: this used to be set unconditionally BEFORE the fetch,
          // with no path back to false on this branch — every later edit
          // was silently dropped while the indicator kept showing "Saved".
          // It's now only ever set on a path that also surfaces a distinct
          // 'blocked' state (fix 7), and only for outcomes that really are
          // permanent-until-reload.
          autosaveStoppedRef.current = true;
          setSaveState("blocked");
          toaster.create({
            type: "error",
            title: "This clip was changed somewhere else",
            description: "Reload to keep editing with the latest version.",
            action: { label: "Reload", onClick: () => window.location.reload() },
          });
          saveQueueStateRef.current = "idle";
          return "failure";
        }
        if (res.status === 422) {
          autosaveStoppedRef.current = true;
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          const isUnsafeBrollUrl = body?.error === "unsafe_broll_url";
          // Phase B step 13: editor_boundaries_invalid is the server-side
          // backstop for min-duration/out-of-source-range trims — the trim
          // handles' own drag guard should make this unreachable in
          // practice, same as editor_document_empty_timeline already was.
          const isInvalidBoundaries = body?.error === "editor_boundaries_invalid";
          console.warn(
            JSON.stringify({
              level: "error",
              message: isUnsafeBrollUrl
                ? "editor_unsafe_broll_url"
                : isInvalidBoundaries
                  ? "editor_boundaries_invalid_client_guard_bypassed"
                  : "editor_document_save_rejected",
              clipId: clipInfo.id,
              projectId: clipInfo.projectId,
              error: body?.error,
            }),
          );
          setSaveState("blocked");
          toaster.create({
            type: "error",
            title: "Save failed",
            description: isUnsafeBrollUrl
              ? "This clip's B-roll URL isn't allowed. Remove it and try again."
              : isInvalidBoundaries
                ? "That trim isn't valid anymore. Reload to continue."
                : "This clip's boundaries changed unexpectedly. Reload to continue.",
          });
          saveQueueStateRef.current = "idle";
          return "failure";
        }
        if (!res.ok) throw new Error("editor document save failed");

        const json = (await res.json()) as { revision: number; document: EditorDocument };
        setBaseRevision(json.revision);

        // Phase B step 13: a boundary-changing save just had the server
        // null the preview proxy (clip.service.ts's saveClipEditorDocument)
        // — the old proxy's window no longer matches the new clip bounds.
        // Drop the local proxy state immediately (video-preview.tsx falls
        // back to the source so playback keeps working across the trim)
        // and let the poll effect — keyed off `previewVideoUrl` — restart
        // on its own now that it's null again. Compared against
        // `documentToSave`'s OWN bounds regardless of whether local edits
        // landed mid-flight below: the server accepted exactly this
        // document's bounds, so that's the authoritative "did this save
        // move the window" answer either way.
        const priorBounds = lastSavedBoundsRef.current;
        const boundariesChangedByThisSave =
          Math.abs(documentToSave.clipStartSec - priorBounds.startSec) > 0.001 ||
          Math.abs(documentToSave.clipEndSec - priorBounds.endSec) > 0.001;
        lastSavedBoundsRef.current = {
          startSec: documentToSave.clipStartSec,
          endSec: documentToSave.clipEndSec,
        };
        if (boundariesChangedByThisSave) {
          setPreviewVideoUrl(null);
          setPreviewStartSec(0);
          // Finding 7 (Phase B closing review): dropping the proxy makes
          // `activeVideoUrl` (`previewVideoUrl ?? (useOriginalSourceFallback
          // ? sourceVideoUrl : null)`) go straight to null unless the user
          // had ALREADY opted into the source fallback — playback would
          // otherwise just die the moment a trim saves, until the new proxy
          // finishes cutting. Opt in on the trim's behalf so it keeps
          // playing from source immediately; the poll effect below still
          // swaps back to the (now-regenerating) proxy once it lands.
          setUseOriginalSourceFallback(true);
          // Finding 8 (Phase B closing review): the OLD proxy's amplitude
          // peaks describe the OLD window — left in place, the waveform
          // keeps painting the stale window's shape against the new bounds
          // until the poll effect's `fetchPreviewStatus` call happens to
          // repopulate it. Clear it in the same branch that drops the proxy
          // itself so the two can never disagree about which window is
          // current; the same poll effect (keyed off `previewVideoUrl`,
          // already restarting because of the `setPreviewVideoUrl(null)`
          // above) repopulates `waveformPeaksUrl` from the new proxy's
          // status the same way it does today.
          setWaveformPeaksUrl(null);
        }
        // The confirmed bounds are now the baseline — a fresh trim (or a
        // trim-crossing undo/redo) must re-arm the intent flag before the
        // next boundary-changing save is allowed through. Only cleared when
        // the LATEST document has converged on these bounds (finding 2) — if
        // a further trim landed while this save was in flight, its own
        // `boundaryEditIntentRef.current = true` must survive for ITS save.
        clearBoundaryIntentIfConverged();

        if (docPresentRef.current === documentToSave) {
          // No local edits landed mid-flight — safe to adopt the server's
          // (possibly rebased) document without recording a new undo step.
          setUnified((s) =>
            s.doc.present === documentToSave
              ? { ...s, doc: { ...s.doc, present: json.document } }
              : s,
          );
          lastSavedDocumentJsonRef.current = JSON.stringify(json.document);
        } else {
          // Local edits arrived while the request was in flight — leave
          // `present` alone; the next autosave cycle will converge.
          lastSavedDocumentJsonRef.current = documentJson;
        }

        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 2000);
      } catch {
        outcome = "failure";
        setSaveState("error");
        toaster.create({
          type: "error",
          title: "Autosave failed",
          description: "Your latest edits haven't been saved.",
        });
        setTimeout(() => setSaveState("idle"), 4000);
      }
    }

    if (autosaveStoppedRef.current) {
      saveQueueStateRef.current = "idle";
      return outcome;
    }
    const transition = completeSave(saveQueueStateRef.current);
    saveQueueStateRef.current = transition.state;
    if (transition.shouldStartSave) {
      currentSavePromiseRef.current = performSave();
      const chainedOutcome = await currentSavePromiseRef.current;
      return combineSaveOutcomes(outcome, chainedOutcome);
    }
    return outcome;
  }, [clipInfo.projectId, clipInfo.id, setBaseRevision]);

  // Enqueues a save (single-flight — see save-queue.ts) and returns a promise
  // that resolves once the WHOLE chain (including any save(s) triggered by
  // edits that landed mid-flight) has drained. Also doubles as the flush
  // primitive for handleSave/handleExport: calling it when nothing is dirty
  // and nothing is in flight resolves immediately.
  const requestAutosave = useCallback((): Promise<SaveOutcome> => {
    // fix 1/2: a stopped autosave or an in-flight reset (draining/POSTing)
    // both mean "don't start a new PUT right now" — surface that as a
    // failure so callers like handleExport don't proceed as if the document
    // were safely persisted.
    if (autosaveStoppedRef.current || resetInFlightRef.current) {
      return Promise.resolve("failure");
    }
    if (JSON.stringify(docPresentRef.current) === lastSavedDocumentJsonRef.current) {
      return saveQueueStateRef.current === "idle"
        ? Promise.resolve("success")
        : currentSavePromiseRef.current;
    }
    const transition = requestSave(saveQueueStateRef.current);
    saveQueueStateRef.current = transition.state;
    if (transition.shouldStartSave) {
      currentSavePromiseRef.current = performSave();
    }
    return currentSavePromiseRef.current;
  }, [performSave]);

  const flushSave = useCallback(() => requestAutosave(), [requestAutosave]);

  const isDirtyNow = useCallback(
    () => JSON.stringify(docPresentRef.current) !== lastSavedDocumentJsonRef.current,
    [],
  );

  const handleSave = useCallback(async () => {
    // Failure is already surfaced by performSave itself (toast + saveState);
    // nothing further to show here (fix 5 — handleSave now reflects
    // failure by simply not pretending the save succeeded).
    await flushSave();
  }, [flushSave]);

  const handleExport = useCallback(async () => {
    setExportState("exporting");
    try {
      const outcome = await flushSave();
      // Fix 5: abort with the existing export-error toast whenever the
      // flush failed, autosave is (still) blocked, or the document is
      // somehow still dirty after the flush resolved — exporting a stale
      // document would silently render the wrong thing.
      if (outcome === "failure" || autosaveStoppedRef.current || isDirtyNow()) {
        throw new Error("save failed before export");
      }
      const response = await fetch(
        `/api/projects/${clipInfo.projectId}/clips/render`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            clipIds: [clipInfo.id],
            aspectRatios: [aspectRatio],
          }),
        },
      );
      if (!response.ok) throw new Error("Failed to queue render");
      setExportState("queued");
      // Renders + downloads surface on the project detail page.
      router.push(`/projects/${clipInfo.projectId}`);
    } catch {
      setExportState("idle");
      toaster.create({
        type: "error",
        title: "Export failed",
        description: "The render couldn't be queued. Try again.",
      });
      // Don't clobber a 'blocked' indicator (fix 7) — that one is meant to
      // persist until reload, not get reset to idle by an unrelated export
      // failure toast's timeout.
      if (!autosaveStoppedRef.current) {
        setSaveState("error");
        setTimeout(() => setSaveState("idle"), 4000);
      }
    }
  }, [flushSave, isDirtyNow, clipInfo.projectId, clipInfo.id, aspectRatio, router]);

  // Debounced autosave — triggers AUTOSAVE_DEBOUNCE_MS after the document
  // actually changes (reference change on `unified.doc.present`).
  const isInitialRender = useRef(true);
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    // Fix 2: a reset in flight is already draining/negotiating its own
    // save — don't let a fresh debounce tick race it with a competing PUT.
    if (autosaveStoppedRef.current || resetInFlightRef.current) return;

    const timeoutId = setTimeout(() => {
      void requestAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [doc, requestAutosave]);

  // Warn on tab close/refresh while a save is pending or in flight.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Fix 3: suppressed right before a successful reset's own reload, so
      // that reload can't get stuck behind this prompt.
      if (suppressUnloadGuardRef.current) return;
      if (isDocDirty || saveState === "saving") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDocDirty, saveState]);

  // Fire-and-forget keepalive flush for pagehide/unmount: the page is
  // dismissing, so there's no meaningful way to await the single-flight
  // queue — just get the latest full document envelope out the door once.
  // Fix 6: this used to bypass the queue unconditionally, so a keepalive
  // fired while a regular autosave PUT was still in flight raced it at the
  // SAME baseRevision — the server accepts whichever lands first and 409s
  // the other, and nothing listens to that 409, so whichever request lost
  // silently failed to persist. Skip the keepalive entirely whenever a save
  // is already in flight/queued: that save's own body already carries real
  // state, and once it completes the (still-scheduled, or about-to-fire)
  // debounce naturally carries any further edits — this trades a small
  // window of "the very last edits before an instant close might not be
  // flushed" for eliminating a guaranteed-conflict, guaranteed-silent-loss
  // race. Also dedupes pagehide + unmount (which can both fire for the same
  // teardown) via a fired-once ref that resets on `pageshow` (bfcache
  // restores), so a later real teardown can still flush.
  const flushKeepalive = useCallback(() => {
    if (keepaliveFiredRef.current) return;
    if (autosaveStoppedRef.current || resetInFlightRef.current) return;
    if (saveQueueStateRef.current !== "idle") return;
    const documentToSave = docPresentRef.current;
    if (JSON.stringify(documentToSave) === lastSavedDocumentJsonRef.current) return;
    keepaliveFiredRef.current = true;
    void fetch(`/api/projects/${clipInfo.projectId}/clips/${clipInfo.id}/editor`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseRevision: baseRevisionRef.current,
        document: documentToSave,
      }),
      keepalive: true,
    });
  }, [clipInfo.projectId, clipInfo.id]);

  useEffect(() => {
    const onPageHide = () => flushKeepalive();
    const onPageShow = () => {
      keepaliveFiredRef.current = false;
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [flushKeepalive]);

  useEffect(() => () => flushKeepalive(), [flushKeepalive]);

  // ─── Reset to original (vizard-parity.md Phase A step 4) ────────────────
  const handleReset = useCallback(async () => {
    if (resetState === "resetting") return;
    setResetState("resetting");
    try {
      // Fix 2: drain any in-flight/pending save chain BEFORE posting the
      // reset, so the reset's baseRevision reflects whatever the server was
      // just brought up to date with instead of racing an autosave that's
      // about to bump the revision out from under it — this removes most
      // 409s at the source rather than just reacting to them. Uses the
      // normal flushSave path (resetInFlightRef is still false here), so an
      // already-in-flight save drains exactly like any other flush.
      await flushSave();

      // From here until the reset POST settles, block any FURTHER
      // debounce-triggered or explicit autosave from starting — the two
      // would otherwise race for the same baseRevision on different
      // endpoints. Set synchronously right after the drain resolves (no
      // `await` in between), so nothing else can slip in before this takes
      // effect. Always cleared in `finally` below, success or not — this is
      // intentionally NOT autosaveStoppedRef, which is permanent-until-reload.
      resetInFlightRef.current = true;

      const res = await fetch(
        `/api/projects/${clipInfo.projectId}/clips/${clipInfo.id}/editor/reset`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseRevision: baseRevisionRef.current }),
        },
      );
      if (res.status === 409) {
        toaster.create({
          type: "error",
          title: "This clip was changed somewhere else",
          description: "Reload to see the latest version before resetting.",
          action: { label: "Reload", onClick: () => window.location.reload() },
        });
        return;
      }
      if (!res.ok) throw new Error("reset failed");

      // Fix 1: autosaveStoppedRef is now only ever set on this success path
      // (previously it was set unconditionally before the POST, with the
      // 409 branch never clearing it back — every later edit was silently
      // dropped while the indicator kept showing "Saved"). Fix 3: suppress
      // the unload guard and clear dirty state BEFORE reloading, so a stray
      // beforeunload prompt can't leave the dialog wedged mid-reset.
      autosaveStoppedRef.current = true;
      suppressUnloadGuardRef.current = true;
      setIsDocDirty(false);
      // Boundaries and the preview proxy may have changed — a full reload
      // re-seeds everything (timing, segments, history) safely from the
      // server rather than trying to patch client state in place.
      window.location.reload();
    } catch {
      toaster.create({
        type: "error",
        title: "Reset failed",
        description: "This clip couldn't be reset to its original version. Try again.",
      });
    } finally {
      resetInFlightRef.current = false;
      // Fix 3: unconditionally return to idle (not just on the error
      // paths) so the dialog can never stay stuck on "Resetting…" if the
      // reload above is somehow prevented or delayed.
      setResetState((s) => (s === "resetting" ? "idle" : s));
    }
  }, [clipInfo.projectId, clipInfo.id, resetState, flushSave]);

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
          if (!e.ctrlKey && !e.metaKey) splitAtPlayhead();
          break;
        case "b":
        case "B":
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); splitAtPlayhead(); }
          break;
        case "Backspace":
        case "Delete":
          // A selected text layer takes priority: `selectedSegmentId` and
          // `selectedTextLayerId` can both be stale-set at once (segment
          // selection is a raw setter the timeline calls directly, outside
          // the caption<->text-layer invariant) — without this check,
          // Delete could destroy a real document mutation (the segment)
          // while the user's visible selection is the text layer.
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
          setTimelineZoom((z) => Math.min(4, z + 0.25));
          break;
        case "-":
          setTimelineZoom((z) => Math.max(0.5, z - 0.25));
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
          if ((e.ctrlKey || e.metaKey) && e.shiftKey) { e.preventDefault(); handleRedo(); }
          else if (e.ctrlKey || e.metaKey) { e.preventDefault(); handleUndo(); }
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
  }, [togglePlay, seekTo, playbackClock, duration, splitAtPlayhead, deleteSelectedSegment, deleteSelectedTextLayer, handleUndo, handleRedo, captionSelected, deselectCaption, selectedTextLayerId, deselectTextLayer]);

  // Fix 3 (Phase B hardening): nothing else reconciles the <video> element
  // or the clock against a delete/revert that just happened — a paused
  // player keeps showing whatever frame it already had loaded even once
  // that frame's SOURCE second is now deleted (or the clock's edited time
  // now points past the new, shorter duration). Runs off `editedTimeMap`'s
  // own identity (it's only rebuilt when deletedRanges/clipStartSec/
  // clipEndSec actually change — see its useMemo above), so this is a
  // total no-op on every other re-render, and it applies equally whether
  // paused or mid-playback (a same-tick safety net ahead of the next rVFC
  // tick in the latter case).
  //
  // Finding 5 (Phase B closing review): a start-handle trim changes
  // `editedTimeMap` AND video-preview.tsx's `playerClipStartSec`-keyed seek
  // effect in the SAME commit. That child effect runs first (child effects
  // fire before parent effects within one commit) and used to unconditionally
  // snap playback back to the new clip start regardless of where the
  // playhead actually was — wrong for a trim mid-playback, and this effect's
  // own `isSourceTimeDeleted` check then saw a now-valid position and left it
  // there. This effect is the one that actually knows whether the CURRENT
  // position survived the change, so it's now authoritative: commitTrim (and
  // the undo/redo cases that cross a trim step) set
  // `boundaryReconcileOwnsSeekRef` synchronously before dispatching, the
  // child effect checks it and stands down for that commit, and this effect
  // clears it below once it's run its own (correct) reposition — a plain
  // cut/revert that never touched the ref is an unaffected no-op here.
  const editedTimeMapRef = useRef(editedTimeMap);
  useEffect(() => {
    if (editedTimeMapRef.current === editedTimeMap) return;
    editedTimeMapRef.current = editedTimeMap;

    const clampedTime = Math.min(playbackClock.getSnapshot(), editedTimeMap.editedDurationSec);
    if (clampedTime !== playbackClock.getSnapshot()) {
      playbackClock.setTime(clampedTime);
    }

    const video = videoRef.current;
    if (video && activeVideoUrl) {
      const currentSourceSec = video.currentTime + activeOffsetSec;
      if (isSourceTimeDeleted(editedTimeMap, currentSourceSec)) {
        video.currentTime = rippleSeekSourceSec(editedTimeMap, clampedTime) - activeOffsetSec;
      }
    }

    // Ownership of this commit's reposition ends here, whether or not a
    // trim actually caused it — a no-op reset when it was already false.
    boundaryReconcileOwnsSeekRef.current = false;
  }, [editedTimeMap, playbackClock, activeVideoUrl, activeOffsetSec, videoRef]);

  // Keep the clock aligned with explicit media updates without routing every
  // playback frame through the top-level React context. Same ripple engine
  // as playback-clock.ts's `startVideo` (stepRipple — see ripple-playback.ts)
  // so this coarse native-`timeupdate` safety net can't disagree with the
  // rVFC-driven loop about where edited time or end-of-clip actually falls
  // once cuts exist.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeVideoUrl) return;

    const handleTimeUpdate = () => {
      const sourceTimeSec = video.currentTime + activeOffsetSec;
      const step = stepRipple(editedTimeMap, sourceTimeSec);

      if (step.atEnd) {
        video.pause();
        // Fix 4: park at the last KEPT frame, not the raw clip boundary
        // (which is deleted footage whenever the clip's own tail is cut).
        video.currentTime = lastKeptPlayerTimeSec();
        playbackClock.setTime(editedTimeMap.editedDurationSec);
        setIsPlaying(false);
        return;
      }

      if (step.skipToSourceSec !== undefined) {
        video.currentTime = step.skipToSourceSec - activeOffsetSec;
      }

      if (video.paused) {
        playbackClock.setTime(step.editedTime);
      }
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => video.removeEventListener("timeupdate", handleTimeUpdate);
  }, [activeVideoUrl, activeOffsetSec, editedTimeMap, lastKeptPlayerTimeSec, playbackClock]);

  useEffect(() => {
    if (!isPlaying || !activeVideoUrl) return;

    return playbackClock.startVideo({
      video: videoRef.current,
      editedTimeMap,
      sourceOffsetSec: activeOffsetSec,
      onEnded: () => {
        const video = videoRef.current;
        if (video) {
          video.pause();
          // Fix 4: same last-kept-frame park as the timeupdate path above.
          video.currentTime = lastKeptPlayerTimeSec();
        }
        setIsPlaying(false);
      },
    });
  }, [isPlaying, activeVideoUrl, editedTimeMap, activeOffsetSec, lastKeptPlayerTimeSec, playbackClock]);

  // Simulated time advancing when playing (fallback: no active video source
  // — proxy not ready and the user hasn't opted into the full-source
  // fallback, or nothing loaded at all).
  useEffect(() => {
    if (!isPlaying || activeVideoUrl) return;
    return playbackClock.startSynthetic(duration, () => setIsPlaying(false));
  }, [isPlaying, duration, activeVideoUrl, playbackClock]);

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

  const ctx: StudioContextValue = {
    isPlaying, duration, activeTool, showTimeline, aspectRatio,
    layoutMode, showShortcuts, timelineZoom, selectedSegmentId,
    captionPreset, captionSelected, selectedTextLayerId, transcriptOnly, segments, studioEdits, brollUrl,
    saveState, exportState, resetState, canUndo, canRedo, canReset,
    transcript: derivedTranscript, clipInfo, videoRef, boundaryReconcileOwnsSeekRef, playbackClock,
    sourceVideoUrl, sourcePreviewId,
    clipStartSec: effectiveClipStartSec, clipEndSec: effectiveClipEndSec, sourcePurged,
    previewVideoUrl, previewStartSec, waveformPeaksUrl, useOriginalSourceFallback, setUseOriginalSourceFallback,
    activeVideoUrl, activeOffsetSec, activeVideoKind, playerClipStartSec, playerClipEndSec,
    editedTimeMap, deletedRanges: doc.deletedRanges, clipWindow,
    brandLogo, layoutAnalysis, utterances, updateUtteranceText, updateWord, deleteSourceRange, applyRemoveSilence,
    setIsPlaying, setActiveTool, setShowTimeline, setAspectRatio,
    setLayoutMode, setShowShortcuts, setTimelineZoom,
    setSelectedSegmentId, setCaptionPreset, selectCaption, deselectCaption,
    selectTextLayer, deselectTextLayer,
    setTranscriptOnly, setSegments, setStudioEdits, setBrollUrl, endCoalesce,
    revertDeletedRange,
    togglePlay, seekTo, splitAtPlayhead, deleteSelectedSegment, handleSave, handleExport,
    handleUndo, handleRedo, handleReset, commitTrim, trimHandlesDisabled,
  };

  return (
    <StudioContext.Provider value={ctx}>
      <Flex direction="column" h="100dvh" bg="studio.canvas" overflow="hidden">
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
        {showTimeline && <Timeline />}

        {/* Keyboard shortcuts modal */}
        <KeyboardShortcutsModal />
      </Flex>
    </StudioContext.Provider>
  );
}
