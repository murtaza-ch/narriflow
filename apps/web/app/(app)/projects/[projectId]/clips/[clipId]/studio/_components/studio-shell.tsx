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
import type {
  TranscriptUtterance,
  CaptionPreset,
  CaptionAnimation,
  StudioEdits,
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

/**
 * Below this width the transcript panel has already hidden (it collapses
 * under 1024px) and the 260px fixed inspector has nowhere left to go — the
 * three-pane editor stops being usable well before typical phone/small-tablet
 * widths. Gate it with an explicit message instead of shipping a silently
 * broken layout.
 */
const STUDIO_MIN_VIEWPORT_WIDTH = 900;

/** Tracks whether the viewport is narrower than `px` via matchMedia. */
function useIsViewportBelow(px: number): boolean {
  const [isBelow, setIsBelow] = useState(false);

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

export interface ClipInfo {
  id: string;
  projectId: string;
  title: string;
  duration: number;
  startSec: number;
  endSec: number;
  aspectRatio: AspectRatio;
  viralityScore: number;
  category: string;
  brollUrl?: string | null;
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
  saveState: "idle" | "saving" | "saved" | "error";
  exportState: "idle" | "exporting" | "queued";
  // undo/redo
  undoStack: string[];
  redoStack: string[];
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
  setCaptionPreset: (p: CaptionPreset | ((prev: CaptionPreset) => CaptionPreset)) => void;
  selectCaption: () => void;
  deselectCaption: () => void;
  setTranscriptOnly: (v: boolean) => void;
  setSegments: (s: TimelineSegment[]) => void;
  setStudioEdits: (p: StudioEdits | ((prev: StudioEdits) => StudioEdits)) => void;
  togglePlay: () => void;
  seekTo: (t: number) => void;
  splitAtPlayhead: () => void;
  deleteSelectedSegment: () => void;
  handleSave: () => void;
  handleExport: () => void;
  handleUndo: () => void;
  handleRedo: () => void;
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
  transcript: TranscriptUtterance[];
  timelineSegments: TimelineSegment[];
  initialCaptionPreset: CaptionPreset;
  initialStudioEdits?: StudioEdits;
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
}

export function StudioShell({
  clipInfo,
  transcript: initialUtterances,
  timelineSegments,
  initialCaptionPreset,
  initialStudioEdits,
  sourceVideoUrl = null,
  sourcePreviewId = "source",
  clipStartSec = 0,
  clipEndSec = 0,
  previewVideoUrl = null,
  previewStartSec = 0,
}: StudioShellProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playbackClock = useMemo(() => createPlaybackClock(), []);
  const isViewportTooSmall = useIsViewportBelow(STUDIO_MIN_VIEWPORT_WIDTH);
  // Only ever flips true from an explicit user action (see video-preview.tsx)
  // — a missing proxy must never silently fall back to the ~44s full-source
  // load that motivated this whole feature.
  const [useOriginalSourceFallback, setUseOriginalSourceFallback] = useState(false);

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

  // Mutable utterances state (for editable transcript)
  const [utterances, setUtterances] = useState<TranscriptUtterance[]>(
    Array.isArray(initialUtterances) ? initialUtterances : [],
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
  const [captionPreset, setCaptionPreset] = useState<CaptionPreset>(initialCaptionPreset);
  const [studioEdits, setStudioEdits] = useState<StudioEdits>(
    initialStudioEdits ?? { textLayers: [], transition: { type: "none", durationSec: 0.4 }, music: { url: null, title: null, volume: 35, startOffsetSec: 0 } },
  );
  const [captionSelected, setCaptionSelected] = useState(false);
  const [transcriptOnly, setTranscriptOnly] = useState(false);
  const [segments, setSegments] = useState<TimelineSegment[]>(timelineSegments);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [exportState, setExportState] = useState<
    "idle" | "exporting" | "queued"
  >("idle");
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);

  // Update utterance text with proportional timing redistribution
  const updateUtteranceText = useCallback((utteranceIndex: number, newText: string) => {
    setUtterances((prev) => {
      const updated = [...prev];
      const utterance = updated[utteranceIndex];
      if (!utterance) return prev;

      const newWordTexts = newText.trim().split(/\s+/).filter(Boolean);
      if (newWordTexts.length === 0) return prev;

      const utteranceDuration = utterance.endSec - utterance.startSec;
      const wordDuration = utteranceDuration / newWordTexts.length;

      updated[utteranceIndex] = {
        ...utterance,
        text: newText.trim(),
        words: newWordTexts.map((word, i) => ({
          word,
          startSec: utterance.startSec + i * wordDuration,
          endSec: utterance.startSec + (i + 1) * wordDuration,
          confidence: null,
        })),
      };

      return updated;
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
    setUndoStack((prev) => [...prev, JSON.stringify(segments)]);
    setRedoStack([]);
  }, [segments, playbackClock]);

  const deleteSelectedSegment = useCallback(() => {
    if (!selectedSegmentId) return;
    setUndoStack((prev) => [...prev, JSON.stringify(segments)]);
    setRedoStack([]);
    setSegments((prev) => prev.filter((s) => s.id !== selectedSegmentId));
    setSelectedSegmentId(null);
  }, [selectedSegmentId, segments]);

  // True whenever there are unsaved edits queued for autosave. A ref (not state)
  // avoids re-render churn and is readable from the beforeunload/unmount handlers.
  const hasPendingSaveRef = useRef(false);

  // Last successfully-persisted (serialized) value for each autosaved field,
  // seeded lazily from the initial props/state so a save before any edit is a
  // true no-op. `persistEdits`' identity changes whenever ANY of captionPreset
  // / utterances / studioEdits changes (they're all in its deps below), so
  // without this guard a save triggered by one field would blindly re-PATCH
  // the other two as well — and for studioEdits, the server invalidates every
  // completed render + deletes its R2 asset on each write (see
  // updateClipStudioEdits), so a spurious PATCH there is destructive, not
  // just wasteful.
  const lastPersistedCaptionPresetRef = useRef<string | null>(null);
  if (lastPersistedCaptionPresetRef.current === null) {
    lastPersistedCaptionPresetRef.current = JSON.stringify(captionPreset);
  }
  const lastPersistedUtterancesRef = useRef<string | null>(null);
  if (lastPersistedUtterancesRef.current === null) {
    lastPersistedUtterancesRef.current = JSON.stringify(utterances);
  }
  const lastPersistedStudioEditsRef = useRef<string | null>(null);
  if (lastPersistedStudioEditsRef.current === null) {
    lastPersistedStudioEditsRef.current = JSON.stringify(studioEdits);
  }

  // Persists caption preset + transcript edits. Throws on any non-2xx so callers
  // never report "Saved" on a failed write (which would silently lose edits).
  // `keepalive` lets the browser complete the request even if the page is
  // being dismissed (tab close/navigation) — pass it only for the dismissal
  // flush; note the ~64KB keepalive body limit still applies, so this is
  // best-effort for larger payloads rather than a restructured save. Each
  // field is only PATCHed when it actually differs from the last persisted
  // value, so a no-op save issues zero requests.
  const persistEdits = useCallback(async (opts?: { keepalive?: boolean }) => {
    const base = `/api/projects/${clipInfo.projectId}/clips/${clipInfo.id}`;
    const keepalive = opts?.keepalive;

    const captionPresetJson = JSON.stringify(captionPreset);
    if (captionPresetJson !== lastPersistedCaptionPresetRef.current) {
      const presetRes = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captionPreset }),
        ...(keepalive ? { keepalive: true } : {}),
      });
      if (!presetRes.ok) throw new Error("Failed to save caption styling");
      lastPersistedCaptionPresetRef.current = captionPresetJson;
    }

    const utterancesJson = JSON.stringify(utterances);
    if (utterancesJson !== lastPersistedUtterancesRef.current) {
      const transcriptRes = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcriptSlice: utterances }),
        ...(keepalive ? { keepalive: true } : {}),
      });
      if (!transcriptRes.ok) throw new Error("Failed to save transcript");
      lastPersistedUtterancesRef.current = utterancesJson;
    }

    const studioEditsJson = JSON.stringify(studioEdits);
    if (studioEditsJson !== lastPersistedStudioEditsRef.current) {
      const editsRes = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studioEdits }),
        ...(keepalive ? { keepalive: true } : {}),
      });
      if (!editsRes.ok) throw new Error("Failed to save studio edits");
      lastPersistedStudioEditsRef.current = studioEditsJson;
    }

    // All writes succeeded — no more unsaved work pending.
    hasPendingSaveRef.current = false;
  }, [clipInfo.projectId, clipInfo.id, captionPreset, utterances, studioEdits]);

  const handleSave = useCallback(async () => {
    setSaveState("saving");
    try {
      await persistEdits();
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("error");
      toaster.create({
        type: "error",
        title: "Save failed",
        description: "Your latest edits haven't been saved. Retrying shortly.",
      });
      setTimeout(() => setSaveState("idle"), 4000);
    }
  }, [persistEdits]);

  const handleExport = useCallback(async () => {
    setExportState("exporting");
    try {
      await persistEdits();
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
      setSaveState("error");
      toaster.create({
        type: "error",
        title: "Export failed",
        description: "The render couldn't be queued. Try again.",
      });
      setTimeout(() => setSaveState("idle"), 4000);
    }
  }, [persistEdits, clipInfo.projectId, clipInfo.id, aspectRatio, router]);

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1]!;
    setRedoStack((r) => [...r, JSON.stringify(segments)]);
    setUndoStack((u) => u.slice(0, -1));
    setSegments(JSON.parse(prev) as TimelineSegment[]);
  }, [undoStack, segments]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1]!;
    setUndoStack((u) => [...u, JSON.stringify(segments)]);
    setRedoStack((r) => r.slice(0, -1));
    setSegments(JSON.parse(next) as TimelineSegment[]);
  }, [redoStack, segments]);

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

  // Debounced auto-save for transcript and caption preset changes
  const isInitialRender = useRef(true);
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }

    // An edit changed persistEdits' identity — work is now pending until the
    // debounce fires and persistEdits clears the flag on success.
    hasPendingSaveRef.current = true;

    const timeoutId = setTimeout(async () => {
      setSaveState("saving");
      try {
        await persistEdits();
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 2000);
      } catch {
        // Surface failures instead of falsely showing "Saved".
        setSaveState("error");
        toaster.create({
          type: "error",
          title: "Autosave failed",
          description: "Your latest edits haven't been saved.",
        });
        setTimeout(() => setSaveState("idle"), 4000);
      }
    }, 1500);

    return () => clearTimeout(timeoutId);
  }, [persistEdits]);

  // Warn on tab close/refresh while a save is pending or in flight.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasPendingSaveRef.current || saveState === "saving") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveState]);

  // Flush a pending debounced save on unmount (covers in-app navigation, where
  // the debounce timeout would otherwise be cleared without flushing). Keep a
  // ref to the latest persistEdits so this fires the current version without
  // re-subscribing on every edit.
  const persistRef = useRef(persistEdits);
  useEffect(() => {
    persistRef.current = persistEdits;
  }, [persistEdits]);

  // Flush a pending save on pagehide (fires on tab close/navigation away,
  // including mobile cases where beforeunload may not fire). `keepalive` lets
  // the browser finish the request after the page starts dismissing.
  useEffect(() => {
    const onPageHide = () => {
      if (hasPendingSaveRef.current) {
        void persistRef.current({ keepalive: true });
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  useEffect(
    () => () => {
      if (hasPendingSaveRef.current) {
        void persistRef.current({ keepalive: true });
      }
    },
    [],
  );

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
    captionPreset, captionSelected, transcriptOnly, segments, studioEdits, saveState, exportState, undoStack, redoStack,
    transcript: derivedTranscript, clipInfo, videoRef, playbackClock,
    sourceVideoUrl, sourcePreviewId, clipStartSec, clipEndSec,
    previewVideoUrl, previewStartSec, useOriginalSourceFallback, setUseOriginalSourceFallback,
    activeVideoUrl, activeOffsetSec, activeVideoKind, playerClipStartSec, playerClipEndSec,
    utterances, updateUtteranceText,
    setIsPlaying, setActiveTool, setShowTimeline, setAspectRatio,
    setLayoutMode, setShowShortcuts, setTimelineZoom,
    setSelectedSegmentId, setCaptionPreset, selectCaption, deselectCaption,
    setTranscriptOnly, setSegments, setStudioEdits,
    togglePlay, seekTo, splitAtPlayhead, deleteSelectedSegment, handleSave, handleExport,
    handleUndo, handleRedo,
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
