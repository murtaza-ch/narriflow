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
  type TranscriptUtterance,
  type CaptionPreset,
  type CaptionAnimation,
  type LogoPosition,
  type StudioEdits,
  type EditorDocument,
} from "@narriflow/validators";
import { TopBar } from "./top-bar";
import { TranscriptPanel } from "./transcript-panel";
import { VideoPreview } from "./video-preview";
import { ToolSidebar } from "./tool-sidebar";
import { Timeline } from "./timeline";
import { KeyboardShortcutsModal } from "./keyboard-shortcuts-modal";
import { createPlaybackClock, type PlaybackClock } from "./playback-clock";
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
  | "music";

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
  /** Server-seeded brand logo (URL + snapshot defaults), or null when the
   *  project has none. See `StudioBrandLogo`'s doc comment. */
  brandLogo: StudioBrandLogo | null;
  utterances: TranscriptUtterance[];
  updateUtteranceText: (index: number, newText: string) => void;
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
  togglePlay: () => void;
  seekTo: (t: number) => void;
  splitAtPlayhead: () => void;
  deleteSelectedSegment: () => void;
  handleSave: () => void;
  handleExport: () => void;
  handleUndo: () => void;
  handleRedo: () => void;
  handleReset: () => void;
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
  clipStartSec?: number;
  clipEndSec?: number;
  /** Presigned preview-proxy URL from studio/page.tsx, or null when no
   *  proxy has been generated for this clip yet. */
  previewVideoUrl?: string | null;
  /** The proxy's t=0 expressed in source time (`Clip.previewStartSec`).
   *  Meaningless when `previewVideoUrl` is null. */
  previewStartSec?: number;
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
  }>;
  /** Server-seeded brand logo (see studio/page.tsx and `StudioBrandLogo`'s
   *  doc comment), or null/omitted when the project has none. */
  brandLogo?: StudioBrandLogo | null;
}

export function StudioShell({
  clipInfo,
  timelineSegments,
  initialEditorDocument,
  initialEditorRevision,
  initialEditorOriginal,
  sourceVideoUrl = null,
  sourcePreviewId = "source",
  clipStartSec = 0,
  clipEndSec = 0,
  previewVideoUrl: initialPreviewVideoUrl = null,
  previewStartSec: initialPreviewStartSec = 0,
  sourcePurged = false,
  fetchPreviewStatus,
  brandLogo = null,
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

  const activeVideoUrl = previewVideoUrl ?? (useOriginalSourceFallback ? sourceVideoUrl : null);
  // Source time -> "whichever file is actually playing" time. Zero when
  // there's no proxy (i.e. we're playing the source as-is, or nothing).
  const activeOffsetSec = previewVideoUrl ? previewStartSec : 0;
  // Mirrors activeOffsetSec's own condition: the proxy wins whenever it
  // exists, regardless of useOriginalSourceFallback (that flag only decides
  // what happens in ITS absence). Consumers only need to branch on this when
  // activeVideoUrl is non-null.
  const activeVideoKind: ThumbnailVideoKind = previewVideoUrl ? "proxy" : "source";
  const playerClipStartSec = clipStartSec - activeOffsetSec;
  const playerClipEndSec = clipEndSec - activeOffsetSec;

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

  // Derived from `doc.transcriptSlice` via the exact same pure
  // effective-timing computation studio/page.tsx runs server-side (tailPadSec
  // 0 — slice-only, matching the stored bounds). Idempotent on the document's
  // own (already-effective) bounds, so first paint is visually identical to
  // before; only diverges once a transcript edit actually changes the slice.
  const utterances = useMemo(
    () =>
      getEffectiveClipTiming({
        utterances: doc.transcriptSlice,
        startSec: doc.clipStartSec,
        endSec: doc.clipEndSec,
        tailPadSec: 0,
      }).transcriptSlice,
    [doc.transcriptSlice, doc.clipStartSec, doc.clipEndSec],
  );

  const duration = useMemo(
    () => Math.max(0, clipEndSec - clipStartSec || clipInfo.duration),
    [clipEndSec, clipStartSec, clipInfo.duration],
  );

  // Derive TranscriptItem[] from utterances for existing TranscriptPanel
  const derivedTranscript: TranscriptItem[] = useMemo(
    () =>
      utterances.map((u, i) => ({
        id: `u-${u.index ?? i}`,
        type: "speech" as const,
        text: u.text,
        timestamp: u.startSec - clipStartSec,
      })),
    [utterances, clipStartSec],
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
      video.currentTime < playerClipStartSec ||
      currentTime >= duration - 0.02
    ) {
      video.currentTime = playerClipStartSec;
      playbackClock.setTime(0);
    }
    if (video.paused) {
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, [activeVideoUrl, playerClipStartSec, playerClipEndSec, duration, playbackClock]);

  const seekTo = useCallback((t: number) => {
    const clamped = Math.max(0, Math.min(duration, t));
    playbackClock.setTime(clamped);
    if (videoRef.current && activeVideoUrl) {
      videoRef.current.currentTime = playerClipStartSec + clamped;
    }
  }, [duration, playerClipStartSec, activeVideoUrl, playbackClock]);

  const splitAtPlayhead = useCallback(() => {
    const currentTime = playbackClock.getSnapshot();
    const active = segments.find(
      (s) => currentTime >= s.startSec && currentTime <= s.endSec,
    );
    if (!active || currentTime <= active.startSec + 0.1 || currentTime >= active.endSec - 0.1) return;

    const newSegments = segments.flatMap((s) => {
      if (s.id !== active.id) return [s];
      return [
        { ...s, endSec: currentTime },
        { id: `${s.id}-b`, label: s.label, startSec: currentTime, endSec: s.endSec },
      ];
    });
    setSegments(newSegments);
  }, [segments, playbackClock, setSegments]);

  const deleteSelectedSegment = useCallback(() => {
    if (!selectedSegmentId) return;
    setSegments(segments.filter((s) => s.id !== selectedSegmentId));
    setSelectedSegmentId(null);
  }, [selectedSegmentId, segments, setSegments]);

  const handleUndo = useCallback(() => {
    setUnified((s) => applyUnifiedEditorAction(s, { kind: "undo" }));
  }, []);

  const handleRedo = useCallback(() => {
    setUnified((s) => applyUnifiedEditorAction(s, { kind: "redo" }));
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

    if (documentJson === lastSavedDocumentJsonRef.current) {
      // Reached via a queued request that turned out to be a no-op (e.g. an
      // edit landed and was then undone before this turn ran) — nothing to
      // send, but still drain the queue below.
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
          console.warn(
            JSON.stringify({
              level: "error",
              message: isUnsafeBrollUrl
                ? "editor_unsafe_broll_url"
                : "editor_boundaries_immutable_client_bug",
              clipId: clipInfo.id,
              projectId: clipInfo.projectId,
            }),
          );
          setSaveState("blocked");
          toaster.create({
            type: "error",
            title: "Save failed",
            description: isUnsafeBrollUrl
              ? "This clip's B-roll URL isn't allowed. Remove it and try again."
              : "This clip's boundaries changed unexpectedly. Reload to continue.",
          });
          saveQueueStateRef.current = "idle";
          return "failure";
        }
        if (!res.ok) throw new Error("editor document save failed");

        const json = (await res.json()) as { revision: number; document: EditorDocument };
        setBaseRevision(json.revision);

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
    setActiveTool("captions");
  }, []);

  const deselectCaption = useCallback(() => {
    setCaptionSelected(false);
    setActiveTool((prev) => (prev === "captions" ? null : prev));
  }, []);

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
          deleteSelectedSegment();
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
          setShowShortcuts(false);
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, playbackClock, duration, splitAtPlayhead, deleteSelectedSegment, handleUndo, handleRedo, captionSelected, deselectCaption]);

  // Keep the clock aligned with explicit media updates without routing every
  // playback frame through the top-level React context. Bounds are in
  // "whichever file is active" time (playerClipStartSec/playerClipEndSec),
  // not raw source time — see their definitions above.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeVideoUrl) return;

    const handleTimeUpdate = () => {
      const clipRelativeTime = Math.max(0, video.currentTime - playerClipStartSec);
      const clampedTime = Math.min(duration, clipRelativeTime);

      if (video.currentTime >= playerClipEndSec - 0.02 || clampedTime >= duration) {
        video.pause();
        video.currentTime = playerClipEndSec;
        playbackClock.setTime(duration);
        setIsPlaying(false);
        return;
      }

      if (video.paused) {
        playbackClock.setTime(clampedTime);
      }
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => video.removeEventListener("timeupdate", handleTimeUpdate);
  }, [activeVideoUrl, playerClipStartSec, playerClipEndSec, duration, playbackClock]);

  useEffect(() => {
    if (!isPlaying || !activeVideoUrl) return;

    return playbackClock.startVideo({
      video: videoRef.current,
      clipStartSec: playerClipStartSec,
      clipEndSec: playerClipEndSec,
      duration,
      onEnded: () => {
        const video = videoRef.current;
        if (video) {
          video.pause();
          video.currentTime = playerClipEndSec;
        }
        setIsPlaying(false);
      },
    });
  }, [isPlaying, activeVideoUrl, playerClipStartSec, playerClipEndSec, duration, playbackClock]);

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
    captionPreset, captionSelected, transcriptOnly, segments, studioEdits, brollUrl,
    saveState, exportState, resetState, canUndo, canRedo, canReset,
    transcript: derivedTranscript, clipInfo, videoRef, playbackClock,
    sourceVideoUrl, sourcePreviewId, clipStartSec, clipEndSec, sourcePurged,
    previewVideoUrl, previewStartSec, useOriginalSourceFallback, setUseOriginalSourceFallback,
    activeVideoUrl, activeOffsetSec, activeVideoKind, playerClipStartSec, playerClipEndSec,
    brandLogo, utterances, updateUtteranceText,
    setIsPlaying, setActiveTool, setShowTimeline, setAspectRatio,
    setLayoutMode, setShowShortcuts, setTimelineZoom,
    setSelectedSegmentId, setCaptionPreset, selectCaption, deselectCaption,
    setTranscriptOnly, setSegments, setStudioEdits, setBrollUrl, endCoalesce,
    togglePlay, seekTo, splitAtPlayhead, deleteSelectedSegment, handleSave, handleExport,
    handleUndo, handleRedo, handleReset,
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
