"use client";

import { useRef, useCallback, useEffect, useMemo } from "react";
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

// ─── Thumbnail strip (canvas-based, no CORS needed) ──────────────────────────

/**
 * Renders video frame thumbnails directly via canvas elements appended to the DOM.
 * This avoids CORS issues because we never call toDataURL/toBlob — we just
 * drawImage() onto visible canvases (tainting is fine since we don't read back).
 */
function SegmentThumbnails({
  sourceVideoUrl,
  clipStartSec,
  segStartSec,
  segEndSec,
  width,
  height,
}: {
  sourceVideoUrl: string | null;
  clipStartSec: number;
  segStartSec: number;
  segEndSec: number;
  width: number;
  height: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const generatedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !sourceVideoUrl || width <= 0 || generatedRef.current)
      return;

    const segDuration = segEndSec - segStartSec;
    if (segDuration <= 0) return;

    generatedRef.current = true;

    const THUMB_WIDTH = 80;
    const count = Math.max(1, Math.min(30, Math.ceil(width / THUMB_WIDTH)));
    const interval = segDuration / count;
    const thumbPxWidth = width / count;

    // Aspect: 16:9 internal resolution
    const CW = 160;
    const CH = 90;

    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    // No crossOrigin — avoids CORS blocking

    const canvases: HTMLCanvasElement[] = [];
    for (let i = 0; i < count; i++) {
      const c = document.createElement("canvas");
      c.width = CW;
      c.height = CH;
      c.style.width = `${thumbPxWidth}px`;
      c.style.height = `${height}px`;
      c.style.objectFit = "cover";
      c.style.flexShrink = "0";
      c.style.display = "block";
      canvases.push(c);
      container.appendChild(c);
    }

    let idx = 0;
    let cancelled = false;

    const captureNext = () => {
      if (cancelled || idx >= count) return;
      video.currentTime = clipStartSec + segStartSec + idx * interval;
    };

    const onSeeked = () => {
      if (cancelled || idx >= count) return;
      const ctx = canvases[idx]?.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, CW, CH);
      }
      idx++;
      if (idx < count) {
        captureNext();
      } else {
        // Done — clean up video
        video.pause();
        video.src = "";
      }
    };

    const onCanPlay = () => {
      video.removeEventListener("canplay", onCanPlay);
      captureNext();
    };

    const onError = () => {
      generatedRef.current = false;
    };

    video.addEventListener("seeked", onSeeked);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("error", onError);
    video.src = sourceVideoUrl;

    return () => {
      cancelled = true;
      generatedRef.current = false;
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("error", onError);
      video.pause();
      video.src = "";
      canvases.forEach((c) => c.remove());
    };
  }, [sourceVideoUrl, clipStartSec, segStartSec, segEndSec, width, height]);

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        position: "absolute",
        inset: 0,
        overflow: "hidden",
      }}
    />
  );
}

// ─── Waveform canvas ──────────────────────────────────────────────────────────

function WaveformCanvas({
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

  // Stable seed for consistent random-looking waveform
  const seedRef = useRef<number[]>([]);
  if (seedRef.current.length !== Math.ceil(width)) {
    seedRef.current = Array.from({ length: Math.ceil(width) }, () =>
      Math.random(),
    );
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || duration <= 0) return;

    canvas.width = Math.ceil(width);
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const secPerPx = duration / canvas.width;
    const midY = canvas.height / 2;
    const seeds = seedRef.current;

    for (let px = 0; px < canvas.width; px++) {
      const absoluteTime = clipStartSec + px * secPerPx;

      let amplitude = 0.03;
      for (const u of utterances) {
        if (absoluteTime >= u.startSec && absoluteTime <= u.endSec) {
          if (u.words && u.words.length > 0) {
            let inWord = false;
            for (const w of u.words) {
              if (absoluteTime >= w.startSec && absoluteTime <= w.endSec) {
                inWord = true;
                break;
              }
            }
            amplitude = inWord
              ? 0.35 + (seeds[px] ?? 0.5) * 0.55
              : 0.08 + (seeds[px] ?? 0.5) * 0.12;
          } else {
            amplitude = 0.3 + (seeds[px] ?? 0.5) * 0.5;
          }
          break;
        }
      }

      const barH = amplitude * midY;

      // Gradient from center outward
      const gradient = ctx.createLinearGradient(px, midY - barH, px, midY + barH);
      gradient.addColorStop(0, "rgba(160,170,190,0.7)");
      gradient.addColorStop(0.5, "rgba(130,140,160,0.5)");
      gradient.addColorStop(1, "rgba(160,170,190,0.7)");

      ctx.fillStyle = gradient;
      ctx.fillRect(px, midY - barH, 1, barH * 2);
    }
  }, [utterances, clipStartSec, duration, width, height]);

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
}

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

export function Timeline() {
  const {
    isPlaying,
    togglePlay,
    currentTime,
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
    clipStartSec,
    utterances,
  } = useStudio();

  const stripRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const TIMELINE_PX_PER_SEC = 80 * timelineZoom;
  const totalWidth = duration * TIMELINE_PX_PER_SEC;

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
    for (let t = 0; t <= duration + 0.01; t += subInterval) {
      const rounded = Math.round(t * 100) / 100;
      const isMajor = Math.abs(rounded % tickInterval) < 0.01;
      result.push({ time: rounded, major: isMajor });
    }
    return result;
  }, [duration, tickInterval, subTickCount]);

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
      if (t >= 0 && t <= duration) seekTo(t);
    },
    [seekTo, xToTime, duration],
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

  // Scroll playhead into view
  useEffect(() => {
    const el = stripRef.current;
    if (!el || !isPlaying) return;
    const playheadX = timeToX(currentTime);
    const { scrollLeft, clientWidth } = el;
    if (
      playheadX < scrollLeft + 60 ||
      playheadX > scrollLeft + clientWidth - 60
    ) {
      el.scrollLeft = playheadX - clientWidth / 2;
    }
  }, [currentTime, timeToX, isPlaying]);

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
            onClick={() => seekTo(duration)}
            title="Go to end"
          />
          <Text
            fontFamily="mono"
            fontSize="12px"
            color="#888"
            ml="8px"
            whiteSpace="nowrap"
          >
            {formatTimecode(currentTime)}
            <Box as="span" color="#444" mx="6px">
              /
            </Box>
            {formatTimecode(duration)}
          </Text>
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
          overflowX="auto"
          overflowY="hidden"
          style={{ height: `${trackAreaHeight}px` }}
          position="relative"
          onWheel={handleWheel}
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
              {ticks.map(({ time, major }) => (
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

              {segments.map((seg) => {
                const x = seg.startSec * TIMELINE_PX_PER_SEC;
                const w = (seg.endSec - seg.startSec) * TIMELINE_PX_PER_SEC;
                const isSelected = selectedSegmentId === seg.id;

                return (
                  <Box
                    key={seg.id}
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
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      setSelectedSegmentId(isSelected ? null : seg.id);
                    }}
                  >
                    {/* Video thumbnails (canvas-based) */}
                    <SegmentThumbnails
                      sourceVideoUrl={sourceVideoUrl}
                      clipStartSec={clipStartSec}
                      segStartSec={seg.startSec}
                      segEndSec={seg.endSec}
                      width={Math.max(w - 3, 4)}
                      height={TRACK_HEIGHT - 3}
                    />

                    {/* Label tag */}
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
                        {seg.label}
                      </Text>
                    </Flex>

                    {/* Trim handles (visible on select/hover) */}
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
                duration={duration}
                width={totalWidth}
                height={WAVEFORM_HEIGHT}
              />
            </Box>

            {/* ── Playhead ─────────────────────────────────────── */}
            <Box
              position="absolute"
              top="0"
              bottom="0"
              w="1.5px"
              bg="white"
              style={{
                left: `${timeToX(currentTime)}px`,
                pointerEvents: "none",
                transition: isDragging.current
                  ? "none"
                  : "left 80ms linear",
              }}
              zIndex={10}
            >
              {/* Triangle handle */}
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
              {/* Bottom dot */}
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
          </Box>
        </Box>
      )}
    </Box>
  );
}
