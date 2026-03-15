"use client";

import { useRef, useCallback, useEffect } from "react";
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
import { useStudio } from "./studio-shell";

function formatTime(secs: number) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

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

export function Timeline() {
  const {
    isPlaying, togglePlay, currentTime, duration, seekTo,
    showTimeline, setShowTimeline,
    timelineZoom, setTimelineZoom,
    segments, selectedSegmentId, setSelectedSegmentId,
    splitAtPlayhead, deleteSelectedSegment,
  } = useStudio();

  const stripRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const TIMELINE_PX_PER_SEC = 80 * timelineZoom;
  const totalWidth = duration * TIMELINE_PX_PER_SEC;

  // Ruler ticks
  const tickInterval = timelineZoom < 1 ? 5 : timelineZoom < 2 ? 2.5 : 1;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += tickInterval) {
    ticks.push(t);
  }

  const timeToX = useCallback(
    (t: number) => t * TIMELINE_PX_PER_SEC,
    [TIMELINE_PX_PER_SEC],
  );

  const xToTime = useCallback(
    (x: number) => x / TIMELINE_PX_PER_SEC,
    [TIMELINE_PX_PER_SEC],
  );

  const handleStripClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left + (stripRef.current?.scrollLeft ?? 0);
      seekTo(xToTime(x));
    },
    [seekTo, xToTime],
  );

  // Zoom via wheel on timeline
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      setTimelineZoom((prev: number) => Math.max(0.5, Math.min(4, prev + delta)));
    },
    [setTimelineZoom],
  );

  // Scroll playhead into view
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const playheadX = timeToX(currentTime);
    const { scrollLeft, clientWidth } = el;
    if (playheadX < scrollLeft + 40 || playheadX > scrollLeft + clientWidth - 40) {
      el.scrollLeft = playheadX - clientWidth / 2;
    }
  }, [currentTime, timeToX]);

  return (
    <Box
      flexShrink={0}
      bg="#0f0f0f"
      borderTopWidth="1px"
      borderColor="#1e1e1e"
      style={{ height: showTimeline ? "160px" : "40px" }}
      transition="height 200ms ease"
      overflow="hidden"
    >
      {/* Control bar */}
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
            label=""
            title="Split clips (D)"
          />
          <CtrlBtn
            icon={<Trash2 size={14} />}
            onClick={deleteSelectedSegment}
            label=""
            active={!!selectedSegmentId}
            title="Delete selected clip (Backspace)"
          />
          <CtrlBtn icon={<Volume2 size={14} />} label="" title="Audio" />
          <CtrlBtn icon={<LayoutTemplate size={14} />} label="" title="Layout" />
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
            color="#666"
            ml="8px"
            whiteSpace="nowrap"
          >
            {formatTime(currentTime)}{" "}
            <Box as="span" color="#333">/</Box>{" "}
            {formatTime(duration)}
          </Text>
        </Flex>

        {/* Right: Zoom */}
        <Flex align="center" gap="4px" flex="1" justify="flex-end">
          <CtrlBtn
            icon={<ZoomOut size={13} />}
            onClick={() => setTimelineZoom(Math.max(0.5, timelineZoom - 0.25))}
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
            onClick={() => setTimelineZoom(Math.min(4, timelineZoom + 0.25))}
            title="Zoom in (+)"
          />
        </Flex>
      </Flex>

      {/* Scrollable strip */}
      {showTimeline && (
        <Box
          ref={stripRef}
          flex="1"
          overflowX="auto"
          overflowY="hidden"
          h="120px"
          position="relative"
          onWheel={handleWheel}
          css={{
            "&::-webkit-scrollbar": { height: "4px" },
            "&::-webkit-scrollbar-track": { background: "transparent" },
            "&::-webkit-scrollbar-thumb": { background: "#2a2a2a", borderRadius: "4px" },
          }}
        >
          <Box
            position="relative"
            style={{ width: `${totalWidth + 80}px` }}
            h="100%"
          >
            {/* Ruler */}
            <Box
              position="absolute"
              top="0"
              left="0"
              right="0"
              h="20px"
              bg="#0c0c0c"
              borderBottomWidth="1px"
              borderColor="#1a1a1a"
              onClick={handleStripClick}
              cursor="pointer"
            >
              {ticks.map((t) => (
                <Box
                  key={t}
                  position="absolute"
                  style={{ left: `${timeToX(t)}px` }}
                  top="0"
                  h="100%"
                >
                  <Box
                    w="1px"
                    h={t % 5 === 0 ? "10px" : "5px"}
                    bg={t % 5 === 0 ? "#3a3a3a" : "#252525"}
                    position="absolute"
                    bottom="0"
                  />
                  {t % 5 === 0 && (
                    <Text
                      position="absolute"
                      bottom="10px"
                      fontSize="9px"
                      fontFamily="mono"
                      color="#444"
                      style={{ transform: "translateX(-50%)" }}
                      whiteSpace="nowrap"
                    >
                      {formatTime(t)}
                    </Text>
                  )}
                </Box>
              ))}
            </Box>

            {/* Clip strip */}
            <Box
              position="absolute"
              top="24px"
              left="0"
              right="0"
              h="80px"
              onClick={handleStripClick}
              cursor="pointer"
            >
              {segments.map((seg) => {
                const x = timeToX(seg.startSec);
                const w = timeToX(seg.endSec - seg.startSec);
                const isSelected = selectedSegmentId === seg.id;

                return (
                  <Box
                    key={seg.id}
                    position="absolute"
                    style={{ left: `${x}px`, width: `${w - 2}px` }}
                    top="4px"
                    bottom="4px"
                    borderRadius="6px"
                    overflow="hidden"
                    border="2px solid"
                    borderColor={isSelected ? "#6366F1" : "#2a2a2a"}
                    bg="#1a1a2e"
                    cursor="pointer"
                    transition="border-color 150ms"
                    _hover={{ borderColor: isSelected ? "#6366F1" : "#3a3a3a" }}
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      setSelectedSegmentId(isSelected ? null : seg.id);
                    }}
                  >
                    {/* Thumbnail strip pattern */}
                    <Box
                      position="absolute"
                      inset="0"
                      style={{
                        backgroundImage:
                          "repeating-linear-gradient(90deg, rgba(99,102,241,0.05) 0px, rgba(99,102,241,0.05) 60px, rgba(255,255,255,0.02) 60px, rgba(255,255,255,0.02) 62px)",
                        backgroundSize: "62px 100%",
                      }}
                    />

                    {/* Label */}
                    <Flex
                      position="absolute"
                      inset="0"
                      align="center"
                      justify="center"
                    >
                      <Text
                        fontSize="10px"
                        fontWeight="600"
                        color={isSelected ? "#a5b4fc" : "#444"}
                        letterSpacing="0.05em"
                        textTransform="uppercase"
                      >
                        {seg.label}
                      </Text>
                    </Flex>

                    {/* Trim handles */}
                    <Box
                      position="absolute"
                      left="0"
                      top="0"
                      bottom="0"
                      w="6px"
                      bg="rgba(99,102,241,0.5)"
                      cursor="ew-resize"
                      opacity={isSelected ? 1 : 0}
                      transition="opacity 150ms"
                      _hover={{ opacity: 1, bg: "#6366F1" }}
                      borderRadius="6px 0 0 6px"
                    />
                    <Box
                      position="absolute"
                      right="0"
                      top="0"
                      bottom="0"
                      w="6px"
                      bg="rgba(99,102,241,0.5)"
                      cursor="ew-resize"
                      opacity={isSelected ? 1 : 0}
                      transition="opacity 150ms"
                      _hover={{ opacity: 1, bg: "#6366F1" }}
                      borderRadius="0 6px 6px 0"
                    />
                  </Box>
                );
              })}

              {/* Add clip button */}
              <Flex
                position="absolute"
                style={{ left: `${timeToX(duration) + 8}px` }}
                top="50%"
                transform="translateY(-50%)"
                w="28px"
                h="28px"
                align="center"
                justify="center"
                borderRadius="full"
                bg="#1a1a1a"
                border="1px dashed #333"
                color="#444"
                cursor="pointer"
                _hover={{ bg: "#222", borderColor: "#555", color: "#888" }}
                transition="all 150ms"
                title="Add clip"
              >
                <Plus size={14} />
              </Flex>
            </Box>

            {/* Playhead */}
            <Box
              position="absolute"
              top="0"
              bottom="0"
              w="2px"
              bg="white"
              style={{
                left: `${timeToX(currentTime)}px`,
                pointerEvents: "none",
                transition: isDragging.current ? "none" : "left 100ms linear",
              }}
              zIndex={10}
            >
              {/* Playhead handle */}
              <Box
                position="absolute"
                top="-1px"
                left="50%"
                transform="translateX(-50%)"
                w="0"
                h="0"
                style={{
                  borderLeft: "6px solid transparent",
                  borderRight: "6px solid transparent",
                  borderTop: "8px solid white",
                }}
              />
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}
