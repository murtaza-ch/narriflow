"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import {
  Smartphone,
  Square,
  Monitor,
  RectangleHorizontal,
  Crop,
  Maximize2,
  ChevronDown,
  Target,
} from "lucide-react";
import { useStudio } from "./studio-shell";
import type { AspectRatio, LayoutMode } from "./studio-shell";
import { InteractiveCaptionOverlay } from "./interactive-caption-overlay";

// ─── Aspect ratio helpers ─────────────────────────────────────────────────────

const ASPECT_RATIO_CONFIG: Record<AspectRatio, { w: number; h: number; icon: React.ReactNode; label: string }> = {
  "9:16": { w: 9, h: 16, icon: <Smartphone size={12} />, label: "9:16" },
  "1:1":  { w: 1, h: 1,  icon: <Square size={12} />,     label: "1:1"  },
  "16:9": { w: 16, h: 9, icon: <Monitor size={12} />,    label: "16:9" },
  "4:5":  { w: 4,  h: 5, icon: <RectangleHorizontal size={12} />, label: "4:5" },
};

const LAYOUT_OPTIONS: LayoutMode[] = ["fill", "fit", "blur"];

function ControlPill({
  children,
  onClick,
  active,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <Flex
      as="button"
      align="center"
      gap="5px"
      px="10px"
      h="26px"
      bg={active ? "rgba(99,102,241,0.2)" : "#1a1a1a"}
      border="1px solid"
      borderColor={active ? "#6366F1" : "#2a2a2a"}
      borderRadius="6px"
      color={active ? "#a5b4fc" : "#aaa"}
      fontSize="12px"
      fontWeight="500"
      cursor="pointer"
      onClick={onClick}
      title={title}
      transition="all 150ms"
      _hover={{ bg: active ? "rgba(99,102,241,0.25)" : "#222", color: "#e5e5e5" }}
      userSelect="none"
    >
      {children}
    </Flex>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function VideoPreview() {
  const {
    aspectRatio, setAspectRatio,
    layoutMode, setLayoutMode,
    trackerEnabled, setTrackerEnabled,
    selectedSegmentId,
    videoRef,
    sourceVideoUrl,
    clipStartSec,
    deselectCaption,
  } = useStudio();

  const [showAspectPicker, setShowAspectPicker] = useState(false);
  const [showReframeMenu, setShowReframeMenu] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);

  const arConfig = ASPECT_RATIO_CONFIG[aspectRatio];

  const cycleLayout = useCallback(() => {
    const idx = LAYOUT_OPTIONS.indexOf(layoutMode);
    setLayoutMode(LAYOUT_OPTIONS[(idx + 1) % LAYOUT_OPTIONS.length]!);
  }, [layoutMode, setLayoutMode]);

  // Wire video source and handle loading
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !sourceVideoUrl) return;

    video.src = sourceVideoUrl;

    const handleLoaded = () => {
      video.currentTime = clipStartSec;
      setVideoLoaded(true);
    };

    video.addEventListener("loadedmetadata", handleLoaded);
    return () => video.removeEventListener("loadedmetadata", handleLoaded);
  }, [sourceVideoUrl, clipStartSec, videoRef]);

  // Calculate video dimensions to fit within container while maintaining aspect ratio
  const videoW = arConfig.w;
  const videoH = arConfig.h;

  return (
    <Flex
      direction="column"
      h="100%"
      bg="#0c0c0c"
      align="center"
      overflow="hidden"
    >
      {/* Controls bar */}
      <Flex
        w="100%"
        align="center"
        justify="center"
        gap="8px"
        py="10px"
        px="16px"
        flexShrink={0}
        position="relative"
      >
        {/* Segment toolbar (when segment selected) */}
        {selectedSegmentId && (
          <Flex
            position="absolute"
            left="16px"
            align="center"
            gap="4px"
          >
            <ControlPill title="Crop (X)">
              <Crop size={12} />
              Crop
            </ControlPill>
            <Box position="relative">
              <ControlPill
                onClick={() => setShowReframeMenu((v) => !v)}
                title="Reframe"
              >
                <Maximize2 size={12} />
                Reframe
                <ChevronDown size={10} />
              </ControlPill>
              {showReframeMenu && (
                <Box
                  position="absolute"
                  top="calc(100% + 6px)"
                  left="0"
                  bg="#1a1a1a"
                  borderWidth="1px"
                  borderColor="#2a2a2a"
                  borderRadius="8px"
                  py="4px"
                  minW="150px"
                  zIndex={50}
                  boxShadow="0 4px 20px rgba(0,0,0,0.5)"
                >
                  {["Auto reframe", "Manual", "Face track"].map((opt) => (
                    <Box
                      key={opt}
                      px="12px"
                      py="8px"
                      fontSize="12px"
                      color="#ccc"
                      cursor="pointer"
                      _hover={{ bg: "#222", color: "#e5e5e5" }}
                      onClick={() => setShowReframeMenu(false)}
                    >
                      {opt}
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          </Flex>
        )}

        {/* Center pills */}
        <Flex align="center" gap="8px">
          {/* Aspect ratio */}
          <Box position="relative">
            <ControlPill
              onClick={() => setShowAspectPicker((v) => !v)}
              title="Change aspect ratio"
            >
              {arConfig.icon}
              {arConfig.label}
            </ControlPill>
            {showAspectPicker && (
              <Box
                position="absolute"
                top="calc(100% + 6px)"
                left="50%"
                transform="translateX(-50%)"
                bg="#1a1a1a"
                borderWidth="1px"
                borderColor="#2a2a2a"
                borderRadius="8px"
                py="4px"
                zIndex={50}
                boxShadow="0 4px 20px rgba(0,0,0,0.5)"
              >
                {Object.entries(ASPECT_RATIO_CONFIG).map(([ratio, cfg]) => (
                  <Flex
                    key={ratio}
                    align="center"
                    gap="8px"
                    px="14px"
                    py="9px"
                    cursor="pointer"
                    fontSize="12px"
                    color={aspectRatio === ratio ? "#a5b4fc" : "#ccc"}
                    bg={aspectRatio === ratio ? "rgba(99,102,241,0.1)" : "transparent"}
                    _hover={{ bg: "#222", color: "#e5e5e5" }}
                    onClick={() => {
                      setAspectRatio(ratio as AspectRatio);
                      setShowAspectPicker(false);
                    }}
                    whiteSpace="nowrap"
                  >
                    {cfg.icon}
                    <Text fontSize="12px">{cfg.label}</Text>
                  </Flex>
                ))}
              </Box>
            )}
          </Box>

          {/* Layout */}
          <ControlPill
            onClick={cycleLayout}
            title="Change layout for the selected scene"
          >
            <Maximize2 size={12} />
            Layout: {layoutMode.charAt(0).toUpperCase() + layoutMode.slice(1)}
          </ControlPill>

          {/* Tracker */}
          <ControlPill
            onClick={() => setTrackerEnabled(!trackerEnabled)}
            active={trackerEnabled}
            title="Enable subject tracking for precise reframing"
          >
            <Target size={12} />
            Tracker: {trackerEnabled ? "ON" : "OFF"}
          </ControlPill>
        </Flex>
      </Flex>

      {/* Video area */}
      <Box
        ref={containerRef}
        flex="1"
        w="100%"
        display="flex"
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
        bg="#000"
        position="relative"
        onClick={(e) => {
          setShowAspectPicker(false);
          if (e.target === e.currentTarget) deselectCaption();
        }}
      >
        {/* Video container with aspect ratio */}
        <Box
          ref={videoContainerRef}
          position="relative"
          style={{
            aspectRatio: `${videoW} / ${videoH}`,
            maxHeight: "100%",
            maxWidth: "100%",
            height: videoH > videoW ? "100%" : "auto",
            width: videoH <= videoW ? "100%" : "auto",
          }}
          bg="#111"
          overflow="hidden"
          borderRadius="2px"
        >
          {/* Placeholder gradient when no video loaded */}
          {!videoLoaded && (
            <Box
              position="absolute"
              inset="0"
              background="linear-gradient(160deg, #1a1a2e 0%, #16213e 40%, #0f3460 70%, #1a1a2e 100%)"
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <Box textAlign="center" opacity={0.3}>
                <Monitor size={48} color="#6366F1" />
                <Text fontSize="13px" color="#888" mt="8px">
                  Video preview
                </Text>
                <Text fontSize="11px" color="#555" mt="4px">
                  No source loaded
                </Text>
              </Box>
            </Box>
          )}

          {/* Actual video element */}
          <video
            ref={videoRef}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: layoutMode === "fit" ? "contain" : "cover",
              display: videoLoaded ? "block" : "none",
            }}
            playsInline
            preload="auto"
          />

          {/* Layout blur layer */}
          {layoutMode === "blur" && (
            <Box
              position="absolute"
              inset="0"
              bg="rgba(0,0,0,0.4)"
              backdropFilter="blur(20px)"
            />
          )}

          {/* Interactive caption overlay */}
          <InteractiveCaptionOverlay videoContainerRef={videoContainerRef} />
        </Box>
      </Box>
    </Flex>
  );
}
