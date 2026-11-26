"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useMotionValue } from "framer-motion";
import { sceneCuesFromLayers } from "@narriflow/caption-scene";
import type { CompositionActiveRange, CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { useStudio } from "./studio-shell";
import { computeSnap, type SnapGuide } from "./snap-guides";
import { PREVIEW_Z } from "./preview-stacking";
import { CaptionSceneLayers, captionSceneBoundsAt, useCaptionScene } from "./caption-scene-painter";
import { DragResizeHandles, SelectionFrame, SnapGuideLines } from "./interactive-caption-overlay";
import { SceneCaptionEmojis } from "./emoji/scene-caption-emojis";

/**
 * The on-video caption of a Scene Style (ADR 0021). A scene draws all the cues of the target at once
 * (the previous and next cue, exits), so, unlike a Caption Block, it is not one layer at a time: the
 * overlay paints the whole target's scene from the playback clock. The selection frame and the hit
 * area are the bounds of what the scene draws at the playhead. A drag moves the preset's anchor by the
 * distance dragged, a resize scales the body size, as Caption Blocks do.
 */
export function InteractiveSceneOverlay({
  videoContainerRef,
  layers,
  insertedScenes,
}: {
  videoContainerRef: React.RefObject<HTMLDivElement | null>;
  layers: readonly CompositionCaptionVisualLayer[];
  /** The target's inserted scenes (`insertedSceneRanges`): the scene is cut at them. */
  insertedScenes: readonly CompositionActiveRange[];
}) {
  const { setCaptionPreset, captionSelected, selectCaption, deselectCaption, endCoalesce, playbackClock, clipInfo } = useStudio(
    "setCaptionPreset", "captionSelected", "selectCaption", "deselectCaption", "endCoalesce", "playbackClock", "clipInfo",
  );
  // The export's frame grid: the scene and its emojis are planned for the rate the clip renders at.
  const fps = clipInfo.renderFrameRate.numerator / clipInfo.renderFrameRate.denominator;
  const first = layers[0]!;
  const preset = first.preset;
  const canvas = useMemo(() => ({ width: first.destination.width, height: first.destination.height }), [first.destination.width, first.destination.height]);

  const input = useMemo(
    () => ({ preset, cues: sceneCuesFromLayers(layers), canvas, anchor: first.anchor, language: first.language, insertedScenes, fps }),
    [preset, layers, canvas, first.anchor, first.language, insertedScenes, fps],
  );
  const built = useCaptionScene(input);

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
  // Display px per canvas px.
  const scale = containerWidth > 0 ? containerWidth / canvas.width : 0.35;

  // The box the scene draws now. Written to state only when it moves, not every frame.
  const [bounds, setBounds] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  useEffect(() => {
    if (!built) return;
    const update = () => {
      const next = captionSceneBoundsAt(built, playbackClock.getSnapshot() * 1000);
      setBounds((previous) => {
        if (!next || !previous) return next;
        const moved = Math.abs(next.x1 - previous.x1) + Math.abs(next.y1 - previous.y1) + Math.abs(next.x2 - previous.x2) + Math.abs(next.y2 - previous.y2);
        return moved > 2 ? next : previous;
      });
    };
    update();
    return playbackClock.subscribe(update);
  }, [built, playbackClock]);

  const [hovered, setHovered] = useState(false);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [isResizing, setIsResizing] = useState(false);
  const initialFontSizeRef = useRef(preset.fontSize);
  const motionX = useMotionValue(0);
  const motionY = useMotionValue(0);

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!captionSelected) selectCaption();
    },
    [captionSelected, selectCaption],
  );

  const boxCentre = bounds ? { xPct: ((bounds.x1 + bounds.x2) / 2 / canvas.width) * 100, yPct: ((bounds.y1 + bounds.y2) / 2 / canvas.height) * 100 } : null;

  const handleDrag = useCallback(() => {
    const el = videoContainerRef.current;
    if (!el || !boxCentre) return;
    const rect = el.getBoundingClientRect();
    const { guides } = computeSnap(boxCentre.xPct + (motionX.get() / rect.width) * 100, boxCentre.yPct + (motionY.get() / rect.height) * 100);
    setSnapGuides(guides);
  }, [videoContainerRef, boxCentre, motionX, motionY]);

  const handleDragEnd = useCallback(() => {
    const el = videoContainerRef.current;
    if (!el || !boxCentre) return;
    const rect = el.getBoundingClientRect();
    const dx = (motionX.get() / rect.width) * 100;
    const dy = (motionY.get() / rect.height) * 100;
    const snapped = computeSnap(Math.max(0, Math.min(100, boxCentre.xPct + dx)), Math.max(0, Math.min(100, boxCentre.yPct + dy)));
    // The scene moves by what the box moved: the anchor takes the same shift.
    const positionX = Math.max(0, Math.min(100, first.anchor.xPct + (snapped.x - boxCentre.xPct)));
    const positionY = Math.max(0, Math.min(100, first.anchor.yPct + (snapped.y - boxCentre.yPct)));
    motionX.set(0);
    motionY.set(0);
    setCaptionPreset((p) => ({ ...p, positionX, positionY }));
    setSnapGuides([]);
  }, [videoContainerRef, boxCentre, motionX, motionY, setCaptionPreset, first.anchor]);

  const handleResizeStart = useCallback(() => {
    initialFontSizeRef.current = preset.fontSize;
    setIsResizing(true);
  }, [preset.fontSize]);
  const handleResize = useCallback(
    (factor: number) => {
      const size = Math.round(Math.max(16, Math.min(200, initialFontSizeRef.current * factor)));
      setCaptionPreset((p) => ({ ...p, fontSize: size }), "caption-resize");
    },
    [setCaptionPreset],
  );
  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    endCoalesce();
  }, [endCoalesce]);

  // A hidden caption is not selectable (the plan returns no layers then, so this stays for safety).
  useEffect(() => {
    if (preset.visible === false && captionSelected) deselectCaption();
  }, [preset.visible, captionSelected, deselectCaption]);

  if (!built) return null;
  const showHoverBorder = hovered && !captionSelected;
  return (
    <>
      <SnapGuideLines guides={snapGuides} />
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: PREVIEW_Z.caption, pointerEvents: "none" }}>
        <CaptionSceneLayers built={built} canvas={canvas} scale={scale} timeSource={playbackClock} />
        <SceneCaptionEmojis built={built} layers={layers} scale={scale} timeSource={playbackClock} />
      </div>
      {bounds ? (
        <div
          style={{
            position: "absolute",
            left: `${bounds.x1 * scale}px`,
            top: `${bounds.y1 * scale}px`,
            width: `${(bounds.x2 - bounds.x1) * scale}px`,
            height: `${(bounds.y2 - bounds.y1) * scale}px`,
            zIndex: PREVIEW_Z.captionFrame,
          }}
        >
          <motion.div
            style={{ x: motionX, y: motionY, position: "absolute", inset: 0, cursor: captionSelected ? (isResizing ? "nwse-resize" : "move") : "pointer" }}
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
            <SelectionFrame selected={captionSelected} hovered={showHoverBorder} />
            {captionSelected && <DragResizeHandles onResizeStart={handleResizeStart} onResize={handleResize} onResizeEnd={handleResizeEnd} />}
          </motion.div>
        </div>
      ) : null}
    </>
  );
}
