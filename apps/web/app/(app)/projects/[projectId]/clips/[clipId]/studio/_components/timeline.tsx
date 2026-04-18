"use client";

import { memo, useRef, useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { Box, Flex, Text, Slider } from "@chakra-ui/react";
import {
  Eye,
  EyeOff,
  Scissors,
  Trash2,
  Volume2,
  LayoutTemplate,
  SkipBack,
  Play,
  Pause,
  SkipForward,
  Plus,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { TranscriptUtterance } from "@narriflow/validators";
import { useStudio } from "./studio-shell";
import { usePlaybackTime } from "./playback-clock";
import {
  getCachedTimelineThumbnail,
  requestTimelineThumbnail,
  setTimelineThumbnailPlaybackActive,
} from "./timeline-preview-manager";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimecode(secs: number) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const f = Math.floor((secs % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
}

function formatRulerLabel(secs: number) {
  if (secs === 0) return "0";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  if (m > 0 && s === 0) return `${m}m`;
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}`;
  return `${s}`;
}

// ─── Thumbnail strip (canvas-based, memory-only session cache) ───────────────

function drawCachedStrip(
  target: HTMLCanvasElement,
  cached: HTMLCanvasElement,
  width: number,
  height: number,
) {
  const ctx = target.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(cached, 0, 0, width, height);
}

/**
 * Renders one cached canvas strip per segment. The canvas is intentionally capped
 * in internal pixel width so long clips do not create huge browser surfaces.
 */
const SegmentThumbnails = memo(function SegmentThumbnails({
  sourceVideoUrl,
  sourcePreviewId,
  clipStartSec,
  segStartSec,
  segEndSec,
  width,
  height,
}: {
  sourceVideoUrl: string | null;
  sourcePreviewId: string;
  clipStartSec: number;
  segStartSec: number;
  segEndSec: number;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const renderWidth = Math.max(1, Math.round(width));
  const renderHeight = Math.max(1, Math.round(height));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;

    canvas.width = renderWidth;
    canvas.height = renderHeight;

    const cachedRefined = getCachedTimelineThumbnail({
      sourcePreviewId,
      clipStartSec,
      segStartSec,
      segEndSec,
      width: renderWidth,
      height: renderHeight,
      quality: "refined",
    });
    const cachedCoarse = getCachedTimelineThumbnail({
      sourcePreviewId,
      clipStartSec,
      segStartSec,
      segEndSec,
      width: renderWidth,
      height: renderHeight,
      quality: "coarse",
    });
    const cached = cachedRefined ?? cachedCoarse;

    if (cached) {
      drawCachedStrip(canvas, cached, renderWidth, renderHeight);
      setStatus("ready");
      if (cachedRefined) return;
    } else {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, renderWidth, renderHeight);
      ctx.fillStyle = "#141414";
      ctx.fillRect(0, 0, renderWidth, renderHeight);
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      for (let x = 0; x < renderWidth; x += 42) {
        ctx.fillRect(x, 0, 18, renderHeight);
      }
    }

    setStatus(sourceVideoUrl ? (cached ? "ready" : "loading") : "idle");

    if (!sourceVideoUrl) return;

    const segDuration = segEndSec - segStartSec;
    if (segDuration <= 0) return;

    let cancelled = false;
    const drawStrip = (strip: HTMLCanvasElement, isComplete: boolean) => {
      if (cancelled) return;
      const target = canvasRef.current;
      if (!target) return;
      drawCachedStrip(target, strip, renderWidth, renderHeight);
      if (isComplete) setStatus("ready");
    };

    const cancelCoarse =
      cachedCoarse || cachedRefined
        ? () => {}
        : requestTimelineThumbnail({
            sourcePreviewId,
            sourceVideoUrl,
            clipStartSec,
            segStartSec,
            segEndSec,
            width: renderWidth,
            height: renderHeight,
            quality: "coarse",
            onFrame: drawStrip,
            onError: () => {
              if (!cancelled) setStatus("error");
            },
          });

    let cancelRefined = () => {};
    const refinedTimer = window.setTimeout(() => {
      if (cancelled || cachedRefined) return;
      cancelRefined = requestTimelineThumbnail({
        sourcePreviewId,
        sourceVideoUrl,
        clipStartSec,
        segStartSec,
        segEndSec,
        width: renderWidth,
        height: renderHeight,
        quality: "refined",
        onFrame: drawStrip,
        onError: () => {
          if (!cancelled) setStatus(cachedCoarse ? "ready" : "error");
        },
      });
    }, cachedCoarse ? 60 : 180);

    return () => {
      cancelled = true;
      window.clearTimeout(refinedTimer);
      cancelCoarse();
      cancelRefined();
    };
  }, [clipStartSec, height, renderHeight, renderWidth, segEndSec, segStartSec, sourcePreviewId, sourceVideoUrl, width]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background:
          status === "ready"
            ? "#111"
            : "linear-gradient(90deg, #111 0%, #181818 45%, #101010 100%)",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          opacity: status === "ready" ? 1 : 0.55,
          transition: "opacity 120ms ease",
        }}
      />
    </div>
  );
});

// ─── Waveform canvas ──────────────────────────────────────────────────────────

const MAX_WAVEFORM_CANVAS_WIDTH = 2400;

const WaveformCanvas = memo(function WaveformCanvas({
  utterances,
  clipStartSec,
  duration,
  width,
  height,
}: {
  utterances: TranscriptUtterance[];
  clipStartSec: number;
  duration: number;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWidth = Math.max(
    1,
    Math.min(MAX_WAVEFORM_CANVAS_WIDTH, Math.ceil(width)),
  );
  const timingIndex = useMemo(() => {
    const speechRanges = utterances
      .map((u) => ({ startSec: u.startSec, endSec: u.endSec }))
      .sort((a, b) => a.startSec - b.startSec);
    const wordRanges = utterances
      .flatMap((u) =>
        u.words.map((w) => ({ startSec: w.startSec, endSec: w.endSec })),
      )
      .sort((a, b) => a.startSec - b.startSec);

    return { speechRanges, wordRanges };
  }, [utterances]);

  // Stable seed for consistent random-looking waveform
  const seedRef = useRef<number[]>([]);
  if (seedRef.current.length !== canvasWidth) {
    seedRef.current = Array.from({ length: canvasWidth }, () =>
      Math.random(),
    );
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasWidth <= 0 || duration <= 0) return;

    canvas.width = canvasWidth;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const secPerPx = duration / canvas.width;
    const midY = canvas.height / 2;
    const seeds = seedRef.current;
    const speechRanges = timingIndex.speechRanges;
    const wordRanges = timingIndex.wordRanges;
    let speechIndex = 0;
    let wordIndex = 0;
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "rgba(160,170,190,0.7)");
    gradient.addColorStop(0.5, "rgba(130,140,160,0.5)");
    gradient.addColorStop(1, "rgba(160,170,190,0.7)");
    ctx.fillStyle = gradient;

    for (let px = 0; px < canvas.width; px++) {
      const absoluteTime = clipStartSec + px * secPerPx;

      let amplitude = 0.03;
      while (speechRanges[speechIndex] && speechRanges[speechIndex]!.endSec < absoluteTime) {
        speechIndex += 1;
      }
      while (wordRanges[wordIndex] && wordRanges[wordIndex]!.endSec < absoluteTime) {
        wordIndex += 1;
      }

      const speech = speechRanges[speechIndex];
      if (speech && absoluteTime >= speech.startSec && absoluteTime <= speech.endSec) {
        const word = wordRanges[wordIndex];
        const inWord =
          word && absoluteTime >= word.startSec && absoluteTime <= word.endSec;
        amplitude = inWord
          ? 0.35 + (seeds[px] ?? 0.5) * 0.55
          : 0.08 + (seeds[px] ?? 0.5) * 0.12;
      }

      const barH = amplitude * midY;
      ctx.fillRect(px, midY - barH, 1, barH * 2);
    }
  }, [timingIndex, clipStartSec, duration, canvasWidth, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        display: "block",
      }}
    />
  );
});

// ─── Control button ───────────────────────────────────────────────────────────

function CtrlBtn({
  icon,
  onClick,
  label,
  active,
  title,
}: {
  icon: React.ReactNode;
  onClick?: () => void;
  label?: string;
  active?: boolean;
  title?: string;
}) {
  return (
    <Flex
      as="button"
      align="center"
      gap="5px"
      px={label ? "8px" : "6px"}
      h="28px"
      borderRadius="5px"
      bg={active ? "#1e1e1e" : "transparent"}
      border="none"
      color={active ? "#e5e5e5" : "#555"}
      cursor="pointer"
      fontSize="12px"
      fontWeight="500"
      title={title ?? label}
      onClick={onClick}
      transition="all 150ms"
      _hover={{ bg: "#1e1e1e", color: "#ccc" }}
    >
      {icon}
      {label && <Text fontSize="11px">{label}</Text>}
    </Flex>
  );
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

const TRACK_HEIGHT = 64;
const WAVEFORM_HEIGHT = 36;
const RULER_HEIGHT = 24;
const LEFT_GUTTER = 40;
const TIMELINE_OVERSCAN_PX = 900;
const PAUSE_MARKER_THRESHOLD_SEC = 0.4;

function useTimelineViewport(ref: RefObject<HTMLDivElement | null>) {
  const [viewport, setViewport] = useState({ scrollLeft: 0, clientWidth: 0 });
  const frameRef = useRef(0);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    setViewport((prev) => {
      if (prev.scrollLeft === el.scrollLeft && prev.clientWidth === el.clientWidth) {
        return prev;
      }
      return { scrollLeft: el.scrollLeft, clientWidth: el.clientWidth };
    });
  }, [ref]);

  const onScroll = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      observer.disconnect();
    };
  }, [measure, ref]);

  return { viewport, onScroll };
}

const TimelineSegmentBlock = memo(function TimelineSegmentBlock({
  id,
  label,
  startSec,
  endSec,
  isSelected,
  pxPerSec,
  sourceVideoUrl,
  sourcePreviewId,
  clipStartSec,
  setSelectedSegmentId,
}: {
  id: string;
  label: string;
  startSec: number;
  endSec: number;
  isSelected: boolean;
  pxPerSec: number;
  sourceVideoUrl: string | null;
  sourcePreviewId: string;
  clipStartSec: number;
  setSelectedSegmentId: (id: string | null) => void;
}) {
  const x = startSec * pxPerSec;
  const w = (endSec - startSec) * pxPerSec;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedSegmentId(isSelected ? null : id);
    },
    [id, isSelected, setSelectedSegmentId],
  );

  return (
    <Box
      position="absolute"
      style={{ left: `${x}px`, width: `${Math.max(w - 1, 4)}px` }}
      top="0"
      bottom="0"
      borderRadius="4px"
      overflow="hidden"
      border="1.5px solid"
      borderColor={isSelected ? "#6366F1" : "#252525"}
      bg="#111"
      cursor="pointer"
      transition="border-color 120ms"
      _hover={{
        borderColor: isSelected ? "#818cf8" : "#3a3a3a",
      }}
      onClick={handleClick}
      contain="layout paint"
    >
      <SegmentThumbnails
        sourceVideoUrl={sourceVideoUrl}
        sourcePreviewId={sourcePreviewId}
        clipStartSec={clipStartSec}
        segStartSec={startSec}
        segEndSec={endSec}
        width={Math.max(w - 3, 4)}
        height={TRACK_HEIGHT - 3}
      />

      <Flex
        position="absolute"
        top="3px"
        left="4px"
        px="5px"
        h="16px"
        align="center"
        borderRadius="3px"
        bg="rgba(0,0,0,0.6)"
        backdropFilter="blur(4px)"
      >
        <Text
          fontSize="9px"
          fontWeight="700"
          color={isSelected ? "#a5b4fc" : "#aaa"}
          letterSpacing="0.04em"
          textTransform="capitalize"
        >
          {label}
        </Text>
      </Flex>

      <Box
        position="absolute"
        left="0"
        top="0"
        bottom="0"
        w="5px"
        bg="rgba(99,102,241,0.6)"
        cursor="ew-resize"
        opacity={isSelected ? 1 : 0}
        transition="opacity 120ms"
        _hover={{ opacity: 1, bg: "#6366F1" }}
        borderLeftRadius="4px"
      />
      <Box
        position="absolute"
        right="0"
        top="0"
        bottom="0"
        w="5px"
        bg="rgba(99,102,241,0.6)"
        cursor="ew-resize"
        opacity={isSelected ? 1 : 0}
        transition="opacity 120ms"
        _hover={{ opacity: 1, bg: "#6366F1" }}
        borderRightRadius="4px"
      />
    </Box>
  );
});

const TimelineTimecode = memo(function TimelineTimecode({
  duration,
}: {
  duration: number;
}) {
  const { playbackClock } = useStudio();
  const currentTime = usePlaybackTime(playbackClock);
  const safeCurrentTime = Math.min(duration, Math.max(0, currentTime));

  return (
    <Text
      fontFamily="mono"
      fontSize="12px"
      color="#888"
      ml="8px"
      whiteSpace="nowrap"
    >
      {formatTimecode(safeCurrentTime)}
      <Box as="span" color="#444" mx="6px">
        /
      </Box>
      {formatTimecode(duration)}
    </Text>
  );
});

const TimelinePlayhead = memo(function TimelinePlayhead({
  duration,
  isPlaying,
  timeToX,
  scrollRootRef,
}: {
  duration: number;
  isPlaying: boolean;
  timeToX: (time: number) => number;
  scrollRootRef: RefObject<HTMLDivElement | null>;
}) {
  const { playbackClock } = useStudio();
  const playheadRef = useRef<HTMLDivElement>(null);
  const lastAutoScrollAtRef = useRef(0);

  const updatePlayhead = useCallback(() => {
    const el = playheadRef.current;
    const currentTime = Math.min(duration, Math.max(0, playbackClock.getSnapshot()));
    const playheadX = timeToX(currentTime);

    if (el) {
      el.style.transform = `translate3d(${playheadX}px, 0, 0)`;
    }

    const scrollRoot = scrollRootRef.current;
    if (!scrollRoot || !isPlaying) return;

    const now = performance.now();
    if (now - lastAutoScrollAtRef.current < 250) return;

    const { scrollLeft, clientWidth } = scrollRoot;
    if (
      playheadX < scrollLeft + 60 ||
      playheadX > scrollLeft + clientWidth - 60
    ) {
      scrollRoot.scrollLeft = playheadX - clientWidth / 2;
      lastAutoScrollAtRef.current = now;
    }
  }, [duration, isPlaying, playbackClock, scrollRootRef, timeToX]);

  useEffect(() => {
    updatePlayhead();
    return playbackClock.subscribe(updatePlayhead);
  }, [playbackClock, updatePlayhead]);

  return (
    <Box
      ref={playheadRef}
      position="absolute"
      top="0"
      bottom="0"
      w="1.5px"
      bg="white"
      style={{
        left: 0,
        transform: `translate3d(${timeToX(Math.min(duration, Math.max(0, playbackClock.getSnapshot())))}px, 0, 0)`,
        pointerEvents: "none",
        willChange: "transform",
      }}
      zIndex={10}
    >
      <Box
        position="absolute"
        top="0"
        left="50%"
        transform="translateX(-50%)"
        w="0"
        h="0"
        style={{
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: "7px solid white",
        }}
      />
      <Box
        position="absolute"
        bottom="-1px"
        left="50%"
        transform="translateX(-50%)"
        w="5px"
        h="5px"
        borderRadius="full"
        bg="white"
      />
    </Box>
  );
});

export function Timeline() {
  const {
    isPlaying,
    togglePlay,
    duration,
    seekTo,
    showTimeline,
    setShowTimeline,
    timelineZoom,
    setTimelineZoom,
    segments,
    selectedSegmentId,
    setSelectedSegmentId,
    splitAtPlayhead,
    deleteSelectedSegment,
    sourceVideoUrl,
    sourcePreviewId,
    clipStartSec,
    utterances,
  } = useStudio();

  const stripRef = useRef<HTMLDivElement>(null);
  const { viewport, onScroll } = useTimelineViewport(stripRef);

  const safeDuration = Math.max(0, duration);
  const TIMELINE_PX_PER_SEC = 80 * timelineZoom;
  const totalWidth = safeDuration * TIMELINE_PX_PER_SEC;

  useEffect(() => {
    setTimelineThumbnailPlaybackActive(isPlaying);
    return () => setTimelineThumbnailPlaybackActive(false);
  }, [isPlaying]);

  // Ruler ticks — adaptive intervals
  const tickInterval = useMemo(() => {
    if (timelineZoom < 0.7) return 10;
    if (timelineZoom < 1.5) return 5;
    if (timelineZoom < 3) return 2;
    return 1;
  }, [timelineZoom]);

  const subTickCount = tickInterval >= 5 ? 5 : 2;

  const ticks = useMemo(() => {
    const result: { time: number; major: boolean }[] = [];
    const subInterval = tickInterval / subTickCount;
    for (let t = 0; t <= safeDuration + 0.01; t += subInterval) {
      const rounded = Math.round(t * 100) / 100;
      const isMajor = Math.abs(rounded % tickInterval) < 0.01;
      result.push({ time: rounded, major: isMajor });
    }
    return result;
  }, [safeDuration, tickInterval, subTickCount]);

  const visibleRange = useMemo(() => {
    const startX = Math.max(0, viewport.scrollLeft - TIMELINE_OVERSCAN_PX);
    const endX =
      viewport.scrollLeft + Math.max(1, viewport.clientWidth) + TIMELINE_OVERSCAN_PX;

    return {
      startSec: Math.max(0, (startX - LEFT_GUTTER) / TIMELINE_PX_PER_SEC),
      endSec: Math.min(
        safeDuration,
        Math.max(0, (endX - LEFT_GUTTER) / TIMELINE_PX_PER_SEC),
      ),
    };
  }, [TIMELINE_PX_PER_SEC, safeDuration, viewport.clientWidth, viewport.scrollLeft]);

  const visibleTicks = useMemo(
    () =>
      ticks.filter(
        ({ time }) =>
          time >= visibleRange.startSec - tickInterval &&
          time <= visibleRange.endSec + tickInterval,
      ),
    [ticks, visibleRange.endSec, visibleRange.startSec, tickInterval],
  );

  const visibleSegments = useMemo(
    () =>
      segments.filter(
        (seg) =>
          seg.endSec >= visibleRange.startSec &&
          seg.startSec <= visibleRange.endSec,
      ),
    [segments, visibleRange.endSec, visibleRange.startSec],
  );

  const visiblePauseMarkers = useMemo(() => {
    const markers: { id: string; startSec: number; endSec: number; duration: number }[] = [];

    for (let i = 0; i < utterances.length - 1; i++) {
      const current = utterances[i]!;
      const next = utterances[i + 1]!;
      const gap = next.startSec - current.endSec;

      if (gap < PAUSE_MARKER_THRESHOLD_SEC) continue;

      const startSec = Math.max(0, current.endSec - clipStartSec);
      const endSec = Math.min(safeDuration, next.startSec - clipStartSec);

      if (endSec <= visibleRange.startSec || startSec >= visibleRange.endSec) {
        continue;
      }

      markers.push({
        id: `pause-${i}`,
        startSec,
        endSec,
        duration: gap,
      });
    }

    return markers;
  }, [clipStartSec, safeDuration, utterances, visibleRange.endSec, visibleRange.startSec]);

  const timeToX = useCallback(
    (t: number) => LEFT_GUTTER + t * TIMELINE_PX_PER_SEC,
    [TIMELINE_PX_PER_SEC],
  );

  const xToTime = useCallback(
    (x: number) => (x - LEFT_GUTTER) / TIMELINE_PX_PER_SEC,
    [TIMELINE_PX_PER_SEC],
  );

  const handleStripClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left + (stripRef.current?.scrollLeft ?? 0);
      const t = xToTime(x);
      if (t >= 0 && t <= safeDuration) seekTo(t);
    },
    [seekTo, xToTime, safeDuration],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      setTimelineZoom((prev: number) =>
        Math.max(0.5, Math.min(4, prev + delta)),
      );
    },
    [setTimelineZoom],
  );

  const trackAreaHeight = RULER_HEIGHT + TRACK_HEIGHT + WAVEFORM_HEIGHT + 8;

  return (
    <Box
      flexShrink={0}
      bg="#0a0a0a"
      borderTopWidth="1px"
      borderColor="#1a1a1a"
      style={{ height: showTimeline ? `${40 + trackAreaHeight}px` : "40px" }}
      transition="height 200ms ease"
      overflow="hidden"
    >
      {/* ── Control bar ───────────────────────────────────────────────── */}
      <Flex
        h="40px"
        align="center"
        px="12px"
        borderBottomWidth="1px"
        borderColor="#1a1a1a"
        flexShrink={0}
        gap="2px"
      >
        {/* Left group */}
        <Flex align="center" gap="2px" flex="1">
          <CtrlBtn
            icon={showTimeline ? <Eye size={14} /> : <EyeOff size={14} />}
            onClick={() => setShowTimeline(!showTimeline)}
            label="Hide timeline"
          />
          <Box w="1px" h="16px" bg="#2a2a2a" mx="4px" />
          <CtrlBtn
            icon={<Scissors size={14} />}
            onClick={splitAtPlayhead}
            title="Split clips (D)"
          />
          <CtrlBtn
            icon={<Trash2 size={14} />}
            onClick={deleteSelectedSegment}
            active={!!selectedSegmentId}
            title="Delete selected clip (Backspace)"
          />
          <CtrlBtn icon={<Volume2 size={14} />} title="Audio" />
          <CtrlBtn icon={<LayoutTemplate size={14} />} title="Layout" />
        </Flex>

        {/* Center: Playback controls */}
        <Flex align="center" gap="6px" flex="0">
          <CtrlBtn
            icon={<SkipBack size={15} />}
            onClick={() => seekTo(0)}
            title="Back to start (1)"
          />
          <Flex
            as="button"
            align="center"
            justify="center"
            w="32px"
            h="32px"
            borderRadius="full"
            bg="#1e1e1e"
            border="1px solid #2a2a2a"
            cursor="pointer"
            color="#e5e5e5"
            onClick={togglePlay}
            transition="all 150ms"
            _hover={{ bg: "#2a2a2a" }}
          >
            {isPlaying ? <Pause size={15} /> : <Play size={15} />}
          </Flex>
          <CtrlBtn
            icon={<SkipForward size={15} />}
            onClick={() => seekTo(safeDuration)}
            title="Go to end"
          />
          <TimelineTimecode duration={safeDuration} />
        </Flex>

        {/* Right: Zoom */}
        <Flex align="center" gap="4px" flex="1" justify="flex-end">
          <CtrlBtn
            icon={<ZoomOut size={13} />}
            onClick={() =>
              setTimelineZoom(Math.max(0.5, timelineZoom - 0.25))
            }
            title="Zoom out (-)"
          />
          <Slider.Root
            value={[timelineZoom]}
            min={0.5}
            max={4}
            step={0.05}
            onValueChange={(e) => setTimelineZoom(e.value[0]!)}
            size="sm"
            colorPalette="purple"
            w="80px"
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <CtrlBtn
            icon={<ZoomIn size={13} />}
            onClick={() =>
              setTimelineZoom(Math.min(4, timelineZoom + 0.25))
            }
            title="Zoom in (+)"
          />
        </Flex>
      </Flex>

      {/* ── Track area ────────────────────────────────────────────────── */}
      {showTimeline && (
        <Box
          ref={stripRef}
          data-timeline-scroll-root
          overflowX="auto"
          overflowY="hidden"
          style={{ height: `${trackAreaHeight}px` }}
          position="relative"
          onWheel={handleWheel}
          onScroll={onScroll}
          css={{
            "&::-webkit-scrollbar": { height: "6px" },
            "&::-webkit-scrollbar-track": { background: "transparent" },
            "&::-webkit-scrollbar-thumb": {
              background: "#2a2a2a",
              borderRadius: "4px",
            },
          }}
        >
          <Box
            position="relative"
            style={{ width: `${totalWidth + LEFT_GUTTER + 60}px` }}
            h="100%"
          >
            {/* ── Ruler ───────────────────────────────────────────── */}
            <Box
              position="absolute"
              top="0"
              left="0"
              right="0"
              style={{ height: `${RULER_HEIGHT}px` }}
              onClick={handleStripClick}
              cursor="pointer"
            >
              {visibleTicks.map(({ time, major }) => (
                <Box
                  key={time}
                  position="absolute"
                  style={{ left: `${timeToX(time)}px` }}
                  top="0"
                  h="100%"
                >
                  {major ? (
                    <>
                      <Text
                        position="absolute"
                        top="2px"
                        fontSize="10px"
                        fontFamily="mono"
                        color="#555"
                        style={{ transform: "translateX(-50%)" }}
                        whiteSpace="nowrap"
                        userSelect="none"
                      >
                        {formatRulerLabel(time)}
                      </Text>
                      <Box
                        w="1px"
                        h="6px"
                        bg="#444"
                        position="absolute"
                        bottom="0"
                      />
                    </>
                  ) : (
                    <Box
                      w="3px"
                      h="3px"
                      borderRadius="full"
                      bg="#333"
                      position="absolute"
                      bottom="2px"
                      style={{ transform: "translateX(-1px)" }}
                    />
                  )}
                </Box>
              ))}
            </Box>

            {/* ── Video track (thumbnails) ─────────────────────── */}
            <Box
              position="absolute"
              top={`${RULER_HEIGHT}px`}
              left={`${LEFT_GUTTER}px`}
              style={{
                width: `${totalWidth}px`,
                height: `${TRACK_HEIGHT}px`,
              }}
              onClick={handleStripClick}
              cursor="pointer"
            >
              {/* Add button left */}
              <Flex
                position="absolute"
                left="-34px"
                top="50%"
                transform="translateY(-50%)"
                w="24px"
                h="24px"
                align="center"
                justify="center"
                borderRadius="full"
                bg="#161616"
                border="1px dashed #333"
                color="#444"
                cursor="pointer"
                _hover={{ bg: "#1e1e1e", borderColor: "#555", color: "#888" }}
                transition="all 150ms"
                title="Add clip"
                zIndex={5}
              >
                <Plus size={12} />
              </Flex>

              {visibleSegments.map((seg) => (
                <TimelineSegmentBlock
                  key={seg.id}
                  id={seg.id}
                  label={seg.label}
                  startSec={seg.startSec}
                  endSec={seg.endSec}
                  isSelected={selectedSegmentId === seg.id}
                  pxPerSec={TIMELINE_PX_PER_SEC}
                  sourceVideoUrl={sourceVideoUrl}
                  sourcePreviewId={sourcePreviewId}
                  clipStartSec={clipStartSec}
                  setSelectedSegmentId={setSelectedSegmentId}
                />
              ))}

              {visiblePauseMarkers.map((marker) => {
                const left = marker.startSec * TIMELINE_PX_PER_SEC;
                const width = Math.max(
                  2,
                  (marker.endSec - marker.startSec) * TIMELINE_PX_PER_SEC,
                );

                return (
                  <Box
                    key={marker.id}
                    position="absolute"
                    top="0"
                    bottom="0"
                    style={{ left: `${left}px`, width: `${width}px` }}
                    bg="rgba(255,255,255,0.08)"
                    borderLeft="1px solid rgba(255,255,255,0.16)"
                    borderRight="1px solid rgba(255,255,255,0.12)"
                    pointerEvents="none"
                    title={`${marker.duration.toFixed(1)}s pause`}
                    zIndex={6}
                  />
                );
              })}

              {/* Add button right */}
              <Flex
                position="absolute"
                style={{ left: `${totalWidth + 8}px` }}
                top="50%"
                transform="translateY(-50%)"
                w="24px"
                h="24px"
                align="center"
                justify="center"
                borderRadius="full"
                bg="#161616"
                border="1px dashed #333"
                color="#444"
                cursor="pointer"
                _hover={{ bg: "#1e1e1e", borderColor: "#555", color: "#888" }}
                transition="all 150ms"
                title="Add clip"
              >
                <Plus size={12} />
              </Flex>
            </Box>

            {/* ── Waveform track ───────────────────────────────── */}
            <Box
              position="absolute"
              top={`${RULER_HEIGHT + TRACK_HEIGHT + 2}px`}
              left={`${LEFT_GUTTER}px`}
              style={{
                width: `${totalWidth}px`,
                height: `${WAVEFORM_HEIGHT}px`,
              }}
              bg="#0d0d0d"
              borderRadius="4px"
              overflow="hidden"
              border="1px solid #1a1a1a"
              onClick={handleStripClick}
              cursor="pointer"
            >
              <WaveformCanvas
                utterances={utterances}
                clipStartSec={clipStartSec}
                duration={safeDuration}
                width={totalWidth}
                height={WAVEFORM_HEIGHT}
              />
            </Box>

            {/* ── Playhead ─────────────────────────────────────── */}
            <TimelinePlayhead
              duration={safeDuration}
              isPlaying={isPlaying}
              timeToX={timeToX}
              scrollRootRef={stripRef}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
