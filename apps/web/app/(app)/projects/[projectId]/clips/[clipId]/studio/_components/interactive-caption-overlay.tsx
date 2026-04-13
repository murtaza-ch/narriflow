"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { motion, useMotionValue } from "framer-motion";
import { useStudio } from "./studio-shell";
import { useCurrentCaption } from "./use-current-caption";
import { computeSnap, type SnapGuide } from "./snap-guides";
import { clipAspectRatioOptions } from "@narriflow/validators";

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

// ─── Caption Text Content ────────────────────────────────────────────────────

function CaptionTextContent({
  displayFontSize,
}: {
  displayFontSize: number;
}) {
  const { currentTime, captionPreset, utterances, clipStartSec } = useStudio();
  const caption = useCurrentCaption(currentTime, utterances, clipStartSec);

  if (!caption || caption.visibleWords.length === 0) return null;

  const preset = captionPreset;
  const highlight = preset.highlightColor;

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

  return (
    <Flex gap="6px" align="center" flexWrap="wrap" justify="center">
      {caption.visibleWords.map((item, i) => (
        <Text
          key={`${caption.utteranceIndex}-${i}`}
          fontSize={`${displayFontSize}px`}
          fontWeight={preset.bold ? "900" : "600"}
          letterSpacing="0.04em"
          color={item.isActive ? highlight : preset.primaryColor}
          style={{
            fontFamily: `"${preset.fontName}", Impact, sans-serif`,
            textShadow:
              shadowParts.length > 0 ? shadowParts.join(", ") : undefined,
            transition: "color 80ms ease-out",
            textTransform: "uppercase",
            pointerEvents: "none",
            userSelect: "none",
          }}
        >
          {item.word}
        </Text>
      ))}
    </Flex>
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
    currentTime,
    utterances,
    clipStartSec,
  } = useStudio();

  const caption = useCurrentCaption(currentTime, utterances, clipStartSec);

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

      <motion.div
        style={{
          position: "absolute",
          left: `${posX}%`,
          top: `${posY}%`,
          x: motionX,
          y: motionY,
          transform: "translate(-50%, -50%)",
          cursor: captionSelected
            ? isResizing
              ? "nwse-resize"
              : "move"
            : "pointer",
          zIndex: 5,
          padding: "8px 12px",
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
        <CaptionTextContent displayFontSize={displayFontSize} />
      </motion.div>
    </>
  );
}
