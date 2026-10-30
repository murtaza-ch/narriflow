"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { motion, useMotionValue, useReducedMotion } from "framer-motion";
import { useStudio } from "./studio-shell";
import { computeSnap, type SnapGuide } from "./snap-guides";
import {
  clipAspectRatioOptions,
} from "@narriflow/validators";
import { CaptionCue } from "./caption-style-engine";
import { captionWordSegmentEnd, type CompositionCaptionVisualLayer } from "@narriflow/composition-plan";

// ─── Constants ───────────────────────────────────────────────────────────────

// Handles sit on the selection frame's edge: `left`/`top` are the frame box's
// own edges, centred on the line by the handle's translate(-50%, -50%).
const HANDLE_POSITIONS = [
  { cursor: "nw-resize", style: { top: 0, left: 0 } },
  { cursor: "n-resize", style: { top: 0, left: "50%" } },
  { cursor: "ne-resize", style: { top: 0, left: "100%" } },
  { cursor: "e-resize", style: { top: "50%", left: "100%" } },
  { cursor: "se-resize", style: { top: "100%", left: "100%" } },
  { cursor: "s-resize", style: { top: "100%", left: "50%" } },
  { cursor: "sw-resize", style: { top: "100%", left: 0 } },
  { cursor: "w-resize", style: { top: "50%", left: 0 } },
] as const;

// The frame is a 1.5px line drawn 2px outside the object; the handles' box is
// inset to the middle of that line (-2px + half its width).
const FRAME_INSET = "-2px";
const HANDLE_BOX_INSET = "-1.25px";

// ─── Snap Guide Lines ────────────────────────────────────────────────────────

export function SnapGuideLines({ guides }: { guides: SnapGuide[] }) {
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

// ─── Selection frame ─────────────────────────────────────────────────────────

/**
 * The thin accent frame around a canvas object: a faint hairline while hovered,
 * a solid line once selected. Shared by captions and text layers.
 */
export function SelectionFrame({ selected, hovered }: { selected: boolean; hovered: boolean }) {
  if (!selected && !hovered) return null;
  return (
    <Box
      position="absolute"
      inset={FRAME_INSET}
      borderWidth={selected ? "1.5px" : "1px"}
      borderColor="studio.accent"
      opacity={selected ? 1 : 0.6}
      borderRadius="6px"
      pointerEvents="none"
      aria-hidden
    />
  );
}

// ─── Resize Handles ──────────────────────────────────────────────────────────

export function DragResizeHandles({
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
    <Box position="absolute" inset={HANDLE_BOX_INSET} pointerEvents="none" zIndex={10}>
      {HANDLE_POSITIONS.map((hp, i) => (
        // A 20px hit area around a 9px dot: easy to grab, quiet to look at.
        <Flex
          key={i}
          position="absolute"
          boxSize="20px"
          align="center"
          justify="center"
          pointerEvents="auto"
          cursor={hp.cursor}
          style={{ ...hp.style, transform: "translate(-50%, -50%)" }}
          onPointerDown={handlePointerDown}
          css={{
            "& > span": { transition: "background 120ms ease, transform 120ms ease" },
            "&:hover > span": { background: "var(--chakra-colors-studio-accent)", transform: "scale(1.25)" },
            "@media (prefers-reduced-motion: reduce)": { "& > span": { transition: "none" } },
          }}
        >
          <Box as="span" boxSize="9px" borderRadius="full" bg="studio.fg" borderWidth="1.5px" borderColor="studio.accent" />
        </Flex>
      ))}
    </Box>
  );
}

// ─── Main Interactive Overlay ────────────────────────────────────────────────

export function InteractiveCaptionOverlay({
  videoContainerRef,
  layer,
  currentTime,
}: {
  videoContainerRef: React.RefObject<HTMLDivElement | null>;
  layer: CompositionCaptionVisualLayer;
  currentTime: number;
}) {
  const {
    setCaptionPreset,
    captionSelected,
    selectCaption,
    deselectCaption,
    aspectRatio,
    endCoalesce,
  } = useStudio("setCaptionPreset", "captionSelected", "selectCaption", "deselectCaption", "aspectRatio", "endCoalesce");
  const captionPreset = layer.preset;

  // Vizard-parity Phase C subtitle visibility toggle — hidden captions must
  // also be unselectable: if the caption was selected when the toggle flips
  // off (from this panel or bulk apply-to-all), drop the selection so the
  // resize/drag handles and selection frame can't linger on an invisible
  // overlay.
  const isVisible = captionPreset.visible !== false;
  useEffect(() => {
    if (!isVisible && captionSelected) {
      deselectCaption();
    }
  }, [isVisible, captionSelected, deselectCaption]);

  const caption = {
    visibleWords: layer.words.map((word, index) => ({
      word: word.text,
      emoji: word.emoji,
      ...(word.spaceBefore === undefined ? {} : { spaceBefore: word.spaceBefore }),
      durationMs: Math.max(50, Math.round((word.endSec - word.startSec) * 1000)),
      // The export's own window for this word's emoji: through the next word's start.
      emojiWindow: { startSec: word.startSec, endSec: captionWordSegmentEnd(layer.words, index) },
      isActive:
        currentTime >= word.startSec &&
        (currentTime < word.endSec ||
          (index === layer.words.length - 1 && currentTime <= word.endSec)),
    })),
    utteranceIndex: layer.cueIndex,
  };
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

  // Display px per canvas px — the cue renders at true export scale.
  const displayScale = containerWidth > 0 ? containerWidth / renderWidth : 0.35;

  // Position: derive from preset or enum
  const posX = layer.anchor.xPct;
  const posY = layer.anchor.yPct;

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
        Math.max(16, Math.min(200, initialFontSizeRef.current * scale)),
      );
      // coalesceKey collapses every tick of one resize gesture into a single
      // undo step (vizard-parity.md Phase A step 3).
      setCaptionPreset((p) => ({ ...p, fontSize: newSize }), "caption-resize");
    },
    [setCaptionPreset],
  );

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    // Fix 8b: break the coalesce chain on gesture end so a later resize
    // that happens to reuse "caption-resize" doesn't merge into this one.
    endCoalesce();
  }, [endCoalesce]);

  // Subtitle display off (vizard-parity Phase C) — hide the overlay AND make
  // it unselectable; style controls in the panel stay live regardless (they
  // just have nothing on-video to preview until this flips back on).
  if (!isVisible) return null;

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
          {/* A draggable/selected object earns the accent frame */}
          <SelectionFrame selected={showSelection} hovered={showHoverBorder} />

          {/* Resize handles */}
          {showSelection && (
            <DragResizeHandles
              onResizeStart={handleResizeStart}
              onResize={handleResize}
              onResizeEnd={handleResizeEnd}
            />
          )}

          {/* Caption text — rendered by the one shared caption-style engine */}
          <CaptionCue
            preset={captionPreset}
            words={caption.visibleWords}
            scale={displayScale}
            frameWidth={containerWidth > 0 ? containerWidth : undefined}
            cueKey={layer.id}
            cueIndex={layer.cueIndex}
            showEmojis={captionPreset.emojis === true}
            reducedMotion={reducedMotion}
            timeSec={currentTime}
            preformatted
            language={layer.language}
          />
        </motion.div>
      </div>
    </>
  );
}
