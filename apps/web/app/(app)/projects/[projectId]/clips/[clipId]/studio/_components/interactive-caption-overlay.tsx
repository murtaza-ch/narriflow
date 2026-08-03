"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Box } from "@chakra-ui/react";
import { motion, useMotionValue, useReducedMotion } from "framer-motion";
import { useStudio } from "./studio-shell";
import { computeSnap, type SnapGuide } from "./snap-guides";
import {
  CAPTION_POSITION_Y_DEFAULTS,
  clipAspectRatioOptions,
} from "@narriflow/validators";
import { CaptionCue, useLiveCaption } from "./caption-style-engine";

// ─── Constants ───────────────────────────────────────────────────────────────

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
          backgroundImage={
            g.axis === "x"
              ? "repeating-linear-gradient(to bottom, {colors.studio.accent} 0px, {colors.studio.accent} 4px, transparent 4px, transparent 8px)"
              : "repeating-linear-gradient(to right, {colors.studio.accent} 0px, {colors.studio.accent} 4px, transparent 4px, transparent 8px)"
          }
          pointerEvents="none"
          zIndex={20}
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
          borderColor="studio.accent"
          cursor={hp.cursor}
          zIndex={10}
          style={hp.style as React.CSSProperties}
          onPointerDown={handlePointerDown}
          transition="background 120ms ease, transform 120ms ease"
          _hover={{
            bg: "studio.accent",
            borderColor: "studio.accent",
            transform: "scale(1.2)",
          }}
        />
      ))}
    </>
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
    aspectRatio,
    utterances,
    clipStartSec,
    playbackClock,
  } = useStudio();

  const caption = useLiveCaption(playbackClock, utterances, clipStartSec);
  const reducedMotion = useReducedMotion() ?? false;

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
    CAPTION_POSITION_Y_DEFAULTS[captionPreset.position];

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
      // coalesceKey collapses every tick of one resize gesture into a single
      // undo step (vizard-parity.md Phase A step 3).
      setCaptionPreset((p) => ({ ...p, fontSize: newSize }), "caption-resize");
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
              borderWidth="1px"
              borderStyle="dashed"
              borderColor="studio.accent"
              opacity={0.7}
              borderRadius="l1"
              pointerEvents="none"
            />
          )}

          {/* Selection border — a draggable/selected object earns the accent frame */}
          {showSelection && (
            <Box
              position="absolute"
              inset="-2px"
              borderWidth="1.5px"
              borderStyle="solid"
              borderColor="studio.accent"
              borderRadius="l1"
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

          {/* Caption text — rendered by the one shared caption-style engine */}
          <CaptionCue
            preset={captionPreset}
            words={caption.visibleWords}
            fontSize={displayFontSize}
            scale={1}
            mode="live"
            cueKey={caption.utteranceIndex}
            showEmojis={captionPreset.emojis === true}
            reducedMotion={reducedMotion}
          />
        </motion.div>
      </div>
    </>
  );
}
