"use client";

import { useCallback, useRef, useState } from "react";
import { Box } from "@chakra-ui/react";
import { motion, useMotionValue } from "framer-motion";
import type { StudioTextLayer } from "@narriflow/validators";
import { useStudio } from "./studio-shell";
import { computeSnap, type SnapGuide } from "./snap-guides";
import { SnapGuideLines, DragResizeHandles } from "./interactive-caption-overlay";

/** Vizard-parity Phase C step 1: per-layer draggable/resizable overlay for a
 *  studio text overlay, mirroring InteractiveCaptionOverlay's drag/resize/
 *  snap contract exactly (same `computeSnap`, `SnapGuideLines`,
 *  `DragResizeHandles`) so the two selectable canvas objects behave
 *  identically. The caller (video-preview.tsx) only mounts this for layers
 *  already visible at the current playhead — this component doesn't itself
 *  gate on `startSec`/`endSec`. */
export function InteractiveTextLayer({
  layer,
  previewWidth,
  videoContainerRef,
}: {
  layer: StudioTextLayer;
  previewWidth: number;
  videoContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { selectedTextLayerId, selectTextLayer, setStudioEdits, endCoalesce } = useStudio();
  const isSelected = selectedTextLayerId === layer.id;

  const [hovered, setHovered] = useState(false);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [isResizing, setIsResizing] = useState(false);
  const initialFontSizeRef = useRef(layer.fontSize);
  const motionX = useMotionValue(0);
  const motionY = useMotionValue(0);

  const displayFontSize = Math.max(
    9,
    Math.round(layer.fontSize * ((previewWidth || 380) / 1080)),
  );
  const outline =
    layer.outlineWidth > 0 ? `${layer.outlineWidth}px ${layer.outlineColor}` : undefined;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isSelected) selectTextLayer(layer.id);
    },
    [isSelected, selectTextLayer, layer.id],
  );

  const handleDrag = useCallback(() => {
    const el = videoContainerRef.current;
    if (!el) return;

    const parentRect = el.getBoundingClientRect();
    const currentLeft = (layer.positionX / 100) * parentRect.width + motionX.get();
    const currentTop = (layer.positionY / 100) * parentRect.height + motionY.get();

    const centerXPct = (currentLeft / parentRect.width) * 100;
    const centerYPct = (currentTop / parentRect.height) * 100;

    const { guides } = computeSnap(centerXPct, centerYPct);
    setSnapGuides(guides);
  }, [videoContainerRef, layer.positionX, layer.positionY, motionX, motionY]);

  const handleDragEnd = useCallback(() => {
    const el = videoContainerRef.current;
    if (!el) return;

    const parentRect = el.getBoundingClientRect();
    const currentLeft = (layer.positionX / 100) * parentRect.width + motionX.get();
    const currentTop = (layer.positionY / 100) * parentRect.height + motionY.get();

    const rawXPct = (currentLeft / parentRect.width) * 100;
    const rawYPct = (currentTop / parentRect.height) * 100;

    const snapped = computeSnap(
      Math.max(0, Math.min(100, rawXPct)),
      Math.max(0, Math.min(100, rawYPct)),
    );

    motionX.set(0);
    motionY.set(0);

    setStudioEdits((prev) => ({
      ...prev,
      textLayers: prev.textLayers.map((l) =>
        l.id === layer.id ? { ...l, positionX: snapped.x, positionY: snapped.y } : l,
      ),
    }), `text-layer-drag-${layer.id}`);
    endCoalesce();

    setSnapGuides([]);
  }, [videoContainerRef, layer.id, layer.positionX, layer.positionY, motionX, motionY, setStudioEdits, endCoalesce]);

  const handleResizeStart = useCallback(() => {
    initialFontSizeRef.current = layer.fontSize;
    setIsResizing(true);
  }, [layer.fontSize]);

  const handleResize = useCallback(
    (scale: number) => {
      // Schema clamp (studio-edits.ts): fontSize is 8-160.
      const newSize = Math.round(
        Math.max(8, Math.min(160, initialFontSizeRef.current * scale)),
      );
      setStudioEdits((prev) => ({
        ...prev,
        textLayers: prev.textLayers.map((l) =>
          l.id === layer.id ? { ...l, fontSize: newSize } : l,
        ),
      }), `text-layer-resize-${layer.id}`);
    },
    [layer.id, setStudioEdits],
  );

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    endCoalesce();
  }, [endCoalesce]);

  const showHoverBorder = hovered && !isSelected;
  const showSelection = isSelected;

  return (
    <>
      <SnapGuideLines guides={snapGuides} />

      {/* Wrapper owns the center-anchor offset + the 88%-of-canvas cap so
          Framer Motion's x/y-driven transform on the inner motion.div can't
          clobber either — same split as InteractiveCaptionOverlay. */}
      <div
        style={{
          position: "absolute",
          left: `${layer.positionX}%`,
          top: `${layer.positionY}%`,
          transform: "translate(-50%, -50%)",
          maxWidth: "88%",
          zIndex: 4,
        }}
      >
        <motion.div
          style={{
            x: motionX,
            y: motionY,
            position: "relative",
            padding: "6px 8px",
            cursor: isSelected ? (isResizing ? "nwse-resize" : "move") : "pointer",
          }}
          drag={isSelected && !isResizing}
          dragConstraints={videoContainerRef}
          dragMomentum={false}
          dragElastic={0}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
          onClick={handleClick}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
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

          {showSelection && (
            <DragResizeHandles
              onResizeStart={handleResizeStart}
              onResize={handleResize}
              onResizeEnd={handleResizeEnd}
            />
          )}

          {/* Text content — matches the burn-in styling contract 1:1 with
              the previous inert Box (video-preview.tsx), only now nested one
              level inside the draggable/selectable wrapper. */}
          <Box
            borderRadius="6px"
            textAlign="center"
            px={layer.backgroundColor ? "10px" : "0"}
            py={layer.backgroundColor ? "5px" : "0"}
            style={{
              color: layer.color,
              fontFamily: `"${layer.fontName}", Arial, sans-serif`,
              fontSize: `${displayFontSize}px`,
              fontWeight: layer.bold ? 800 : 500,
              lineHeight: 1.08,
              backgroundColor: layer.backgroundColor
                ? `${layer.backgroundColor}${Math.round(layer.backgroundOpacity * 255)
                    .toString(16)
                    .padStart(2, "0")}`
                : undefined,
              WebkitTextStroke: outline,
              textShadow: layer.outlineWidth > 0 ? "0 2px 10px rgba(0,0,0,0.45)" : undefined,
            }}
          >
            {layer.text}
          </Box>
        </motion.div>
      </div>
    </>
  );
}
