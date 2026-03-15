"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { Box, Flex } from "@chakra-ui/react";
import { TopBar } from "./top-bar";
import { TranscriptPanel } from "./transcript-panel";
import { VideoPreview } from "./video-preview";
import { ToolSidebar } from "./tool-sidebar";
import { Timeline } from "./timeline";
import { KeyboardShortcutsModal } from "./keyboard-shortcuts-modal";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AspectRatio = "9:16" | "1:1" | "16:9" | "4:5";
export type LayoutMode = "fill" | "fit" | "blur";
export type CaptionAnimation = "none" | "word-by-word" | "karaoke" | "bounce";
export type ToolId =
  | "ai-enhance"
  | "captions"
  | "upload"
  | "brand"
  | "broll"
  | "transitions"
  | "text"
  | "music"
  | "ai-hook";

export interface CaptionPreset {
  fontName: string;
  primaryColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadow: number;
  bold: boolean;
  position: "top" | "center" | "bottom";
  highlightColor?: string;
  animation?: CaptionAnimation;
}

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
  credits: number;
}

interface StudioState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  activeTool: ToolId | null;
  showTimeline: boolean;
  aspectRatio: AspectRatio;
  layoutMode: LayoutMode;
  trackerEnabled: boolean;
  showShortcuts: boolean;
  timelineZoom: number;
  selectedSegmentId: string | null;
  captionPreset: CaptionPreset;
  transcriptOnly: boolean;
  credits: number;
  segments: TimelineSegment[];
  saveState: "idle" | "saving" | "saved";
  // undo/redo
  undoStack: string[];
  redoStack: string[];
}

interface StudioContextValue extends StudioState {
  transcript: TranscriptItem[];
  clipInfo: ClipInfo;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  setCurrentTime: (t: number) => void;
  setIsPlaying: (v: boolean) => void;
  setActiveTool: (t: ToolId | null) => void;
  setShowTimeline: (v: boolean) => void;
  setAspectRatio: (r: AspectRatio) => void;
  setLayoutMode: (m: LayoutMode) => void;
  setTrackerEnabled: (v: boolean) => void;
  setShowShortcuts: (v: boolean) => void;
  setTimelineZoom: React.Dispatch<React.SetStateAction<number>>;
  setSelectedSegmentId: (id: string | null) => void;
  setCaptionPreset: (p: CaptionPreset | ((prev: CaptionPreset) => CaptionPreset)) => void;
  setTranscriptOnly: (v: boolean) => void;
  setSegments: (s: TimelineSegment[]) => void;
  togglePlay: () => void;
  seekTo: (t: number) => void;
  splitAtPlayhead: () => void;
  deleteSelectedSegment: () => void;
  handleSave: () => void;
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
  transcript: TranscriptItem[];
  timelineSegments: TimelineSegment[];
  initialCaptionPreset: CaptionPreset;
}

export function StudioShell({
  clipInfo,
  transcript,
  timelineSegments,
  initialCaptionPreset,
}: StudioShellProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration] = useState(clipInfo.duration);
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [showTimeline, setShowTimeline] = useState(true);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(clipInfo.aspectRatio);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("fill");
  const [trackerEnabled, setTrackerEnabled] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [captionPreset, setCaptionPreset] = useState<CaptionPreset>(initialCaptionPreset);
  const [transcriptOnly, setTranscriptOnly] = useState(false);
  const [credits] = useState(clipInfo.credits);
  const [segments, setSegments] = useState<TimelineSegment[]>(timelineSegments);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      // No video — just toggle state for UI demo
      setIsPlaying((v) => !v);
      return;
    }
    if (video.paused) {
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, []);

  const seekTo = useCallback((t: number) => {
    const clamped = Math.max(0, Math.min(duration, t));
    setCurrentTime(clamped);
    if (videoRef.current) {
      videoRef.current.currentTime = clamped;
    }
  }, [duration]);

  const splitAtPlayhead = useCallback(() => {
    const active = segments.find(
      (s) => currentTime >= s.startSec && currentTime <= s.endSec,
    );
    if (!active || currentTime <= active.startSec + 0.1 || currentTime >= active.endSec - 0.1) return;

    const newSegments = segments.flatMap((s) => {
      if (s.id !== active.id) return [s];
      return [
        { ...s, endSec: currentTime },
        { id: `${s.id}-b`, label: s.label, startSec: currentTime + 0.05, endSec: s.endSec },
      ];
    });
    setSegments(newSegments);
    setUndoStack((prev) => [...prev, JSON.stringify(segments)]);
    setRedoStack([]);
  }, [segments, currentTime]);

  const deleteSelectedSegment = useCallback(() => {
    if (!selectedSegmentId) return;
    setUndoStack((prev) => [...prev, JSON.stringify(segments)]);
    setRedoStack([]);
    setSegments((prev) => prev.filter((s) => s.id !== selectedSegmentId));
    setSelectedSegmentId(null);
  }, [selectedSegmentId, segments]);

  const handleSave = useCallback(async () => {
    setSaveState("saving");
    await new Promise((r) => setTimeout(r, 800));
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 2000);
  }, []);

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

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          seekTo(currentTime + (e.shiftKey ? 5 : 1 / 30));
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekTo(currentTime - (e.shiftKey ? 5 : 1 / 30));
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
          setShowShortcuts(false);
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, currentTime, duration, splitAtPlayhead, deleteSelectedSegment, handleUndo, handleRedo]);

  // Simulate time advancing when playing (no real video)
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setCurrentTime((t) => {
        if (t >= duration) {
          setIsPlaying(false);
          return 0;
        }
        return t + 0.1;
      });
    }, 100);
    return () => clearInterval(interval);
  }, [isPlaying, duration]);

  const ctx: StudioContextValue = {
    isPlaying, currentTime, duration, activeTool, showTimeline, aspectRatio,
    layoutMode, trackerEnabled, showShortcuts, timelineZoom, selectedSegmentId,
    captionPreset, transcriptOnly, credits, segments, saveState, undoStack, redoStack,
    transcript, clipInfo, videoRef,
    setCurrentTime, setIsPlaying, setActiveTool, setShowTimeline, setAspectRatio,
    setLayoutMode, setTrackerEnabled, setShowShortcuts, setTimelineZoom,
    setSelectedSegmentId, setCaptionPreset, setTranscriptOnly, setSegments,
    togglePlay, seekTo, splitAtPlayhead, deleteSelectedSegment, handleSave,
    handleUndo, handleRedo,
  };

  return (
    <StudioContext.Provider value={ctx}>
      <Flex direction="column" h="100vh" bg="#0c0c0c" overflow="hidden">
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
