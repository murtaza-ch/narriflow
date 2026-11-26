"use client";

import { useCallback, useRef, useState } from "react";
import { Box } from "@chakra-ui/react";
import { motion, useMotionValue } from "framer-motion";
import type { StudioTextLayer } from "@narriflow/validators";
import { useBrandFont, brandFontStyle } from "@/app/(app)/brand-kit/_components/brand-fonts";
import { useStudio } from "./studio-shell";
import { computeSnap, type SnapGuide } from "./snap-guides";
import { SelectionFrame, SnapGuideLines, DragResizeHandles } from "./interactive-caption-overlay";

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
  const { selectedTextLayerId, selectTextLayer, setStudioEdits, endCoalesce } = useStudio("selectedTextLayerId", "selectTextLayer", "setStudioEdits", "endCoalesce");
  const style = layer.style;
  const customFont = useBrandFont(style.fontAsset);
  const isSelected = selectedTextLayerId === layer.id;

  const [hovered, setHovered] = useState(false);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [isResizing, setIsResizing] = useState(false);
  const initialFontSizeRef = useRef(style.fontSize);
  const motionX = useMotionValue(0);
  const motionY = useMotionValue(0);

  const displayFontSize = Math.max(
    9,
    Math.round(style.fontSize * ((previewWidth || 380) / 1080)),
  );
  const outline = style.stroke ? `${style.stroke.width}px ${style.stroke.color}` : undefined;

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
    initialFontSizeRef.current = style.fontSize;
    setIsResizing(true);
  }, [style.fontSize]);

  const handleResize = useCallback(
    (scale: number) => {
      // Schema clamp (text-layer.ts): fontSize is 8-240.
      const newSize = Math.round(
        Math.max(8, Math.min(240, initialFontSizeRef.current * scale)),
      );
      setStudioEdits((prev) => ({
        ...prev,
        textLayers: prev.textLayers.map((l) =>
          l.id === layer.id ? { ...l, style: { ...l.style, fontSize: newSize } } : l,
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
          <SelectionFrame selected={showSelection} hovered={showHoverBorder} />

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
            px={style.background ? "10px" : "0"}
            py={style.background ? "5px" : "0"}
            style={{
              color: style.color,
              fontFamily: `"${style.font}", Arial, sans-serif`,
              fontSize: `${displayFontSize}px`,
              fontWeight: style.bold ? 800 : 500,
              fontStyle: style.italic ? "italic" : undefined,
              textDecoration: style.underline ? "underline" : undefined,
              textTransform: style.textCase === "uppercase" ? "uppercase" : undefined,
              textAlign: style.align,
              whiteSpace: "pre-line",
              ...(customFont ? brandFontStyle(customFont) : {}),
              lineHeight: style.lineHeight,
              backgroundColor: style.background
                ? `${style.background.color}${Math.round(style.background.opacity * 255)
                    .toString(16)
                    .padStart(2, "0")}`
                : undefined,
              WebkitTextStroke: outline,
              textShadow: style.shadow ? `${style.shadow.offsetX}px ${style.shadow.offsetY}px ${style.shadow.blur}px ${style.shadow.color}` : undefined,
            }}
          >
            {layer.text}
          </Box>
        </motion.div>
      </div>
    </>
  );
}
