"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { motion, useMotionValue } from "framer-motion";
import { useStudio } from "./studio-shell";
import {
  getCurrentCaptionState,
  type CaptionState,
} from "./use-current-caption";
import { computeSnap, type SnapGuide } from "./snap-guides";
import { clipAspectRatioOptions } from "@narriflow/validators";
import type { TranscriptUtterance } from "@narriflow/validators";
import type { PlaybackClock } from "./playback-clock";

// ─── Constants ───────────────────────────────────────────────────────────────

const POSITION_Y_PRESETS = { top: 10, center: 50, bottom: 88 } as const;

const HANDLE_POSITIONS = [
  { cursor: "nw-resize", style: { top: -5, left: -5 } },
  { cursor: "n-resize", style: { top: -5, left: "calc(50% - 5px)" } },
  { cursor: "ne-resize", style: { top: -5, right: -5 } },
  { cursor: "e-resize", style: { top: "calc(50% - 5px)", right: -5 } },
  { cursor: "se-resize", style: { bottom: -5, right: -5 } },
  { cursor: "s-resize", style: { bottom: -5, left: "calc(50% - 5px)" } },
  { cursor: "sw-resize", style: { bottom: -5, left: -5 } },
  { cursor: "w-resize", style: { top: "calc(50% - 5px)", left: -5 } },
] as const;

// ─── Snap Guide Lines ────────────────────────────────────────────────────────

function SnapGuideLines({ guides }: { guides: SnapGuide[] }) {
  if (guides.length === 0) return null;

  return (
    <>
      {guides.map((g, i) => (
        <Box
          key={`${g.axis}-${g.position}-${i}`}
          position="absolute"
          {...(g.axis === "x"
            ? { left: `${g.position}%`, top: 0, bottom: 0, width: "1px" }
            : { top: `${g.position}%`, left: 0, right: 0, height: "1px" }
          )}
          bg="rgba(99, 102, 241, 0.5)"
          pointerEvents="none"
          zIndex={20}
          style={{
            backgroundImage:
              g.axis === "x"
                ? "repeating-linear-gradient(to bottom, #6366F1 0px, #6366F1 4px, transparent 4px, transparent 8px)"
                : "repeating-linear-gradient(to right, #6366F1 0px, #6366F1 4px, transparent 4px, transparent 8px)",
            backgroundColor: "transparent",
          }}
        />
      ))}
    </>
  );
}

// ─── Resize Handles ──────────────────────────────────────────────────────────

function CaptionResizeHandles({
  onResizeStart,
  onResize,
  onResizeEnd,
}: {
  onResizeStart: () => void;
  onResize: (scale: number) => void;
  onResizeEnd: () => void;
}) {
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const captionRect =
        (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
      const centerX = captionRect.left + captionRect.width / 2;
      const centerY = captionRect.top + captionRect.height / 2;
      const initialDist = Math.hypot(
        e.clientX - centerX,
        e.clientY - centerY,
      );

      onResizeStart();

      const handleMove = (me: PointerEvent) => {
        const currentDist = Math.hypot(
          me.clientX - centerX,
          me.clientY - centerY,
        );
        const scale = currentDist / Math.max(initialDist, 1);
        onResize(scale);
      };

      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        onResizeEnd();
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [onResizeStart, onResize, onResizeEnd],
  );

  return (
    <>
      {HANDLE_POSITIONS.map((hp, i) => (
        <Box
          key={i}
          position="absolute"
          w="10px"
          h="10px"
          borderRadius="full"
          bg="white"
          borderWidth="1.5px"
          borderColor="#6366F1"
          cursor={hp.cursor}
          zIndex={10}
          style={hp.style as React.CSSProperties}
          onPointerDown={handlePointerDown}
          transition="all 100ms"
          _hover={{
            bg: "#6366F1",
            borderColor: "#6366F1",
            transform: "scale(1.2)",
          }}
        />
      ))}
    </>
  );
}

// ─── Animation Props Factory ─────────────────────────────────────────────────

function getWordMotionProps(
  animation: string,
  isActive: boolean,
  index: number,
): Record<string, unknown> {
  const stagger = index * 0.08;

  switch (animation) {
    case "blur-in":
      return {
        initial: { filter: "blur(10px)", opacity: 0 },
        animate: { filter: "blur(0px)", opacity: 1 },
        transition: { duration: 0.4, ease: "easeOut", delay: stagger },
      };
    case "grow":
      return {
        initial: { scale: 0.2, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { type: "spring", stiffness: 260, damping: 20, delay: stagger },
      };
    case "breathe":
      return isActive
        ? {
            animate: { scale: [1, 1.08, 1] },
            transition: { repeat: Infinity, duration: 1.2, ease: "easeInOut" },
          }
        : {};
    case "soft-landing":
      return {
        initial: { y: -20, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: stagger },
      };
    case "glitch":
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1, x: [0, -3, 4, -2, 0], skewX: [0, -5, 3, -1, 0] },
        transition: { duration: 0.35, delay: stagger },
      };
    case "seamless-bounce":
      return {
        initial: { y: 12, opacity: 0, scale: 0.95 },
        animate: { y: 0, opacity: 1, scale: 1 },
        transition: { type: "spring", stiffness: 300, damping: 15, delay: stagger },
      };
    case "bounce":
      return {
        initial: { y: 10, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        transition: { type: "spring", stiffness: 400, damping: 10, delay: stagger },
      };
    default:
      return {};
  }
}

// ─── Hex to RGBA helper ─────────────────────────────────────────────────────

function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

function captionSignature(caption: CaptionState | null) {
  if (!caption) return "none";
  return `${caption.utteranceIndex}:${caption.activeWordIndex}:${caption.visibleWords
    .map((word) => `${word.word}:${word.isActive ? 1 : 0}`)
    .join("|")}`;
}

function useLiveCaption(
  playbackClock: PlaybackClock,
  utterances: TranscriptUtterance[],
  clipStartSec: number,
) {
  const [caption, setCaption] = useState<CaptionState | null>(() =>
    getCurrentCaptionState(playbackClock.getSnapshot(), utterances, clipStartSec),
  );
  const signatureRef = useRef(captionSignature(caption));

  useEffect(() => {
    const update = () => {
      const next = getCurrentCaptionState(
        playbackClock.getSnapshot(),
        utterances,
        clipStartSec,
      );
      const signature = captionSignature(next);
      if (signature === signatureRef.current) return;
      signatureRef.current = signature;
      setCaption(next);
    };

    update();
    return playbackClock.subscribe(update);
  }, [clipStartSec, playbackClock, utterances]);

  return caption;
}

// ─── Caption Text Content ────────────────────────────────────────────────────

function CaptionTextContent({
  displayFontSize,
  caption,
}: {
  displayFontSize: number;
  caption: CaptionState;
}) {
  const { captionPreset } = useStudio();

  if (!caption || caption.visibleWords.length === 0) return null;

  const preset = captionPreset;
  const highlight = preset.highlightColor;
  const textTransform = (preset.textTransform ?? "uppercase") as React.CSSProperties["textTransform"];
  const letterSpacing = `${preset.letterSpacing ?? 0.04}em`;

  // Build text-shadow
  const outlineWidth = preset.outlineWidth;
  const outlineColor = preset.outlineColor;
  const shadowParts: string[] = [];

  if (outlineWidth > 0) {
    for (let x = -outlineWidth; x <= outlineWidth; x++) {
      for (let y = -outlineWidth; y <= outlineWidth; y++) {
        if (x === 0 && y === 0) continue;
        shadowParts.push(`${x}px ${y}px 0 ${outlineColor}`);
      }
    }
  }

  if (preset.shadow) {
    shadowParts.push("0 2px 8px rgba(0,0,0,0.9)");
  }

  // Glow effect
  if (preset.glowColor) {
    const intensity = preset.glowIntensity ?? 8;
    shadowParts.push(`0 0 ${intensity}px ${preset.glowColor}`);
    shadowParts.push(`0 0 ${intensity * 2}px ${preset.glowColor}40`);
  }

  const textShadow = shadowParts.length > 0 ? shadowParts.join(", ") : undefined;

  // Check for backdrop / highlight box
  const hasBackdrop = !!preset.backgroundColor;
  const hasHighlightBox = !!preset.highlightBoxColor;

  return (
    <Box position="relative">
      {/* Backdrop behind all text */}
      {hasBackdrop && (
        <Box
          position="absolute"
          inset="-6px -10px"
          borderRadius="6px"
          pointerEvents="none"
          style={{
            backgroundColor: hexToRgba(
              preset.backgroundColor!,
              preset.backgroundOpacity ?? 0.6,
            ),
          }}
        />
      )}

      <Flex
        gap="6px"
        align="center"
        flexWrap="nowrap"
        justify="center"
        position="relative"
        zIndex={1}
      >
        {caption.visibleWords.map((item, i) => {
          const motionProps = getWordMotionProps(preset.animation, item.isActive, i);
          const showBox = hasHighlightBox && item.isActive;

          return (
            <Box
              key={`${caption.utteranceIndex}-${i}`}
              position="relative"
              display="inline-flex"
            >
              {/* Highlight box behind active word */}
              {showBox && (
                <Box
                  position="absolute"
                  inset="-2px -4px"
                  borderRadius="4px"
                  pointerEvents="none"
                  style={{
                    backgroundColor: hexToRgba(
                      preset.highlightBoxColor!,
                      preset.highlightBoxOpacity ?? 1,
                    ),
                  }}
                />
              )}

              <motion.span
                {...motionProps}
                style={{
                  position: "relative",
                  zIndex: 1,
                  fontSize: `${displayFontSize}px`,
                  fontWeight: preset.bold ? "900" : "600",
                  letterSpacing,
                  color: item.isActive ? highlight : preset.primaryColor,
                  fontFamily: `"${preset.fontName}", Impact, sans-serif`,
                  textShadow,
                  transition: "color 80ms ease-out",
                  textTransform,
                  pointerEvents: "none",
                  userSelect: "none",
                  display: "inline-block",
                }}
              >
                {item.word}
              </motion.span>
            </Box>
          );
        })}
      </Flex>
    </Box>
  );
}

// ─── Main Interactive Overlay ────────────────────────────────────────────────

export function InteractiveCaptionOverlay({
  videoContainerRef,
}: {
  videoContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const {
    captionPreset,
    setCaptionPreset,
    captionSelected,
    selectCaption,
    deselectCaption,
    aspectRatio,
    utterances,
    clipStartSec,
    playbackClock,
  } = useStudio();

  const caption = useLiveCaption(playbackClock, utterances, clipStartSec);

  const [hovered, setHovered] = useState(false);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [isResizing, setIsResizing] = useState(false);
  const initialFontSizeRef = useRef(captionPreset.fontSize);
  const motionX = useMotionValue(0);
  const motionY = useMotionValue(0);

  // Compute render resolution for font scaling
  const arOption = clipAspectRatioOptions.find(
    (o) => o.value === aspectRatio,
  );
  const renderWidth = arOption?.width ?? 1080;

  // Measure preview container width for proportional font scaling
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = videoContainerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [videoContainerRef]);

  const displayFontSize =
    containerWidth > 0
      ? captionPreset.fontSize * (containerWidth / renderWidth)
      : captionPreset.fontSize * 0.35; // fallback scale

  // Position: derive from preset or enum
  const posX = captionPreset.positionX ?? 50;
  const posY =
    captionPreset.positionY ??
    POSITION_Y_PRESETS[captionPreset.position];

  // Click handler
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!captionSelected) {
        selectCaption();
      }
    },
    [captionSelected, selectCaption],
  );

  // Drag handlers
  const handleDrag = useCallback(() => {
    const el = videoContainerRef.current;
    if (!el) return;

    const parentRect = el.getBoundingClientRect();
    // Get current position from CSS + motion offset
    const currentLeft = (posX / 100) * parentRect.width + motionX.get();
    const currentTop = (posY / 100) * parentRect.height + motionY.get();

    const centerXPct = (currentLeft / parentRect.width) * 100;
    const centerYPct = (currentTop / parentRect.height) * 100;

    const { guides } = computeSnap(centerXPct, centerYPct);
    setSnapGuides(guides);
  }, [videoContainerRef, posX, posY, motionX, motionY]);

  const handleDragEnd = useCallback(() => {
    const el = videoContainerRef.current;
    if (!el) return;

    const parentRect = el.getBoundingClientRect();
    const currentLeft = (posX / 100) * parentRect.width + motionX.get();
    const currentTop = (posY / 100) * parentRect.height + motionY.get();

    const rawXPct = (currentLeft / parentRect.width) * 100;
    const rawYPct = (currentTop / parentRect.height) * 100;

    const snapped = computeSnap(
      Math.max(0, Math.min(100, rawXPct)),
      Math.max(0, Math.min(100, rawYPct)),
    );

    // Reset motion values and update preset position
    motionX.set(0);
    motionY.set(0);

    setCaptionPreset((p) => ({
      ...p,
      positionX: snapped.x,
      positionY: snapped.y,
    }));

    setSnapGuides([]);
  }, [videoContainerRef, posX, posY, motionX, motionY, setCaptionPreset]);

  // Resize handlers
  const handleResizeStart = useCallback(() => {
    initialFontSizeRef.current = captionPreset.fontSize;
    setIsResizing(true);
  }, [captionPreset.fontSize]);

  const handleResize = useCallback(
    (scale: number) => {
      const newSize = Math.round(
        Math.max(8, Math.min(120, initialFontSizeRef.current * scale)),
      );
      setCaptionPreset((p) => ({ ...p, fontSize: newSize }));
    },
    [setCaptionPreset],
  );

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Don't render if no caption to show
  if (!caption || caption.visibleWords.length === 0) return null;

  const showHoverBorder = hovered && !captionSelected;
  const showSelection = captionSelected;

  return (
    <>
      {/* Snap guide lines rendered at video container level */}
      <SnapGuideLines guides={snapGuides} />

      {/* Wrapper owns the center-anchor offset so Framer Motion's
          x/y-driven transform on the inner motion.div can't clobber it. */}
      <div
        style={{
          position: "absolute",
          left: `${posX}%`,
          top: `${posY}%`,
          transform: "translate(-50%, -50%)",
          width: "max-content",
          zIndex: 5,
        }}
      >
        <motion.div
          style={{
            x: motionX,
            y: motionY,
            position: "relative",
            padding: "8px 12px",
            cursor: captionSelected
              ? isResizing
                ? "nwse-resize"
                : "move"
              : "pointer",
          }}
          drag={captionSelected && !isResizing}
          dragConstraints={videoContainerRef}
          dragMomentum={false}
          dragElastic={0}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
          onClick={handleClick}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {/* Hover border */}
          {showHoverBorder && (
            <Box
              position="absolute"
              inset="-2px"
              border="1px dashed rgba(99,102,241,0.6)"
              borderRadius="4px"
              pointerEvents="none"
            />
          )}

          {/* Selection border */}
          {showSelection && (
            <Box
              position="absolute"
              inset="-2px"
              border="1.5px solid #6366F1"
              borderRadius="4px"
              pointerEvents="none"
            />
          )}

          {/* Resize handles */}
          {showSelection && (
            <CaptionResizeHandles
              onResizeStart={handleResizeStart}
              onResize={handleResize}
              onResizeEnd={handleResizeEnd}
            />
          )}

          {/* Caption text */}
          <CaptionTextContent
            displayFontSize={displayFontSize}
            caption={caption}
          />
        </motion.div>
      </div>
    </>
  );
}
