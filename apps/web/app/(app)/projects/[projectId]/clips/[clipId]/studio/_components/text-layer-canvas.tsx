"use client";

/**
 * Text Layers on the canvas (title-text spec section 6): painted by the Scene painter from the
 * shared layout, with a hit area per layer on screen, and for the selected one a selection frame
 * (the layout's `frame`) with four corner grips (font size and width together), two side grips
 * (width, opposite edge fixed) and a floating toolbar. Presentational: layers and the selection
 * come in, one commit per gesture goes out, so the Studio and the prototype page share it.
 *
 * While a gesture runs the layer is drawn from a local draft (it moves on the frame it is dragged,
 * without a document change per pointer move); the gesture's end commits once.
 *
 * Only the grips capture the pointer over the selected frame: a press inside it goes through the
 * same topmost-layer hit test as anywhere else, and moves the selected layer only when that layer is
 * the one hit. With a layer selected and focused, the arrow keys nudge it (1%, Shift 5%).
 */

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Portal } from "@chakra-ui/react";
import type { StudioTextLayer } from "@narriflow/validators";
import type { CaptionTimeSource } from "./caption-block-painter";
import { CaptionSceneLayers } from "./caption-scene-painter";
import { SnapGuideLines } from "./interactive-caption-overlay";
import type { SnapGuide } from "./snap-guides";
import { type TextLayerReach, cornerResizeTextLayer, dragTextLayer, nudgeTextLayer, sideResizeTextLayer, textToolbarPlacement } from "./text-layer-gestures";
import { useTextLayerScene } from "./text-layer-scene";

export interface TextLayerCanvasEntry {
  /**
   * Unique per entry. The plan cuts a layer at each inserted scene into pieces that share the
   * layer's id; each piece is its own entry (its own window), laid out under this key.
   */
  readonly key: string;
  readonly layer: StudioTextLayer;
  /** Clip ms the layer is on screen, start inclusive, end exclusive. */
  readonly window: { readonly fromMs: number; readonly toMs: number };
}

/** What a gesture changed. */
export type TextLayerGesturePatch = Partial<Pick<StudioTextLayer, "positionX" | "positionY" | "widthPct">> & { readonly fontSize?: number };
export type TextLayerGesture = "move" | "corner" | "side";

export interface TextLayerCanvasProps {
  readonly entries: readonly TextLayerCanvasEntry[];
  readonly canvas: { readonly width: number; readonly height: number };
  /** Display px per canvas px. */
  readonly scale: number;
  readonly timeSource: CaptionTimeSource;
  /** The time hit areas and the frame are shown for (seconds, the clip's edited timeline). */
  readonly timeSec: number;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  /** One call at the end of each gesture. */
  readonly onCommit: (id: string, patch: TextLayerGesturePatch, gesture: TextLayerGesture) => void;
  /** Double-click on a layer: edit its words. */
  readonly onEditText?: (id: string) => void;
  /** Arrow keys on the selected layer: its new centre. A burst of presses ends with `onNudgeEnd`. */
  readonly onNudge?: (id: string, place: { positionX: number; positionY: number }) => void;
  readonly onNudgeEnd?: () => void;
  /** The floating toolbar's content for the selected layer (positioned here); `compact` when the preview area is narrow. */
  readonly toolbar?: (layer: StudioTextLayer, options: { compact: boolean }) => ReactNode;
  /** The element the toolbar stays inside (the preview area); the viewport when absent. */
  readonly toolbarBoundsRef?: React.RefObject<HTMLElement | null>;
  /** Stacking: the painted layers and their hit areas, and the selected layer's frame above other canvas objects. */
  readonly zIndex?: { readonly paint: number; readonly frame: number };
}

interface Draft {
  readonly id: string;
  readonly patch: TextLayerGesturePatch;
}

function applyPatch(layer: StudioTextLayer, patch: TextLayerGesturePatch): StudioTextLayer {
  const { fontSize, ...place } = patch;
  return { ...layer, ...place, ...(fontSize !== undefined ? { style: { ...layer.style, fontSize } } : {}) };
}

const CORNERS = [
  { id: "nw", cursor: "nwse-resize", left: "0%", top: "0%", label: "top left" },
  { id: "ne", cursor: "nesw-resize", left: "100%", top: "0%", label: "top right" },
  { id: "se", cursor: "nwse-resize", left: "100%", top: "100%", label: "bottom right" },
  { id: "sw", cursor: "nesw-resize", left: "0%", top: "100%", label: "bottom left" },
] as const;

const SIDES = [
  { side: "left", left: "0%", label: "left" },
  { side: "right", left: "100%", label: "right" },
] as const;

/** Frame (preview px) a drag or nudge leaves on the canvas on each axis, so one side's grips stay reachable. */
const REACHABLE_PX = 24;
/** Under this much room the toolbar drops alignment and case into its more menu. */
export const COMPACT_TOOLBAR_PX = 380;

const ARROWS: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** A short name for a layer in labels. */
function layerName(layer: StudioTextLayer): string {
  const words = layer.text.replace(/\s+/g, " ").trim();
  return `${layer.role === "title" ? "Title" : "Text"} "${words.length > 40 ? `${words.slice(0, 39)}…` : words}"`;
}

export function TextLayerCanvas({ entries, canvas, scale, timeSource, timeSec, selectedId, onSelect, onCommit, onEditText, onNudge, onNudgeEnd, toolbar, toolbarBoundsRef, zIndex = { paint: 4, frame: 7 } }: TextLayerCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const drawn = useMemo(
    () => (draft ? entries.map((entry) => (entry.layer.id === draft.id ? { ...entry, layer: applyPatch(entry.layer, draft.patch) } : entry)) : entries),
    [entries, draft],
  );
  // Laid out under each entry's key, so the pieces of one layer cut at an inserted scene stay apart.
  const keyed = useMemo(() => drawn.map((entry) => ({ layer: { ...entry.layer, id: entry.key }, window: entry.window })), [drawn]);
  const built = useTextLayerScene(keyed, canvas);
  const ms = timeSec * 1000;
  const onScreen = drawn.filter((entry) => ms >= entry.window.fromMs && ms < entry.window.toMs);
  const selected = onScreen.find((entry) => entry.layer.id === selectedId) ?? null;
  const selectedFrame = selected ? built?.layouts.get(selected.key)?.frame : undefined;

  /** How far this entry's frame may leave the canvas (`TextLayerReach`). */
  const reachOf = useCallback(
    (key: string): TextLayerReach => {
      const frame = built?.layouts.get(key)?.frame;
      return {
        widthPct: frame ? ((frame.x2 - frame.x1) / canvas.width) * 100 : 0,
        heightPct: frame ? ((frame.y2 - frame.y1) / canvas.height) * 100 : 0,
        overlapXPct: (REACHABLE_PX / Math.max(1, canvas.width * scale)) * 100,
        overlapYPct: (REACHABLE_PX / Math.max(1, canvas.height * scale)) * 100,
      };
    },
    [built, canvas.width, canvas.height, scale],
  );

  // A gesture: pointer down on a hit area, the frame or a grip; window listeners until it ends.
  const startGesture = useCallback(
    (event: React.PointerEvent<HTMLElement>, entry: TextLayerCanvasEntry, kind: TextLayerGesture, side?: "left" | "right") => {
      const root = rootRef.current;
      if (!root || event.button !== 0) return;
      const { layer } = entry;
      event.preventDefault();
      event.stopPropagation();
      // Preventing the pointer's default also stops the focus a press gives: focus the hit area, so the arrow keys reach it.
      if (kind === "move") event.currentTarget.focus({ preventScroll: true });
      onSelect(layer.id);
      const reach = reachOf(entry.key);
      const rect = root.getBoundingClientRect();
      const widthPx = canvas.width * scale;
      const heightPx = canvas.height * scale;
      const start = { positionX: layer.positionX, positionY: layer.positionY, widthPct: layer.widthPct, fontSize: layer.style.fontSize };
      const centre = { x: rect.left + (start.positionX / 100) * widthPx, y: rect.top + (start.positionY / 100) * heightPx };
      const startDistance = Math.max(1, Math.hypot(event.clientX - centre.x, event.clientY - centre.y));
      const origin = { x: event.clientX, y: event.clientY };
      let moved = false;
      let latest: TextLayerGesturePatch | null = null;
      const move = (pointer: PointerEvent) => {
        if (!moved && Math.hypot(pointer.clientX - origin.x, pointer.clientY - origin.y) < 3) return;
        moved = true;
        if (kind === "move") {
          const next = dragTextLayer(start, ((pointer.clientX - origin.x) / widthPx) * 100, ((pointer.clientY - origin.y) / heightPx) * 100, reach);
          latest = { positionX: next.positionX, positionY: next.positionY };
          setGuides(next.guides);
        } else if (kind === "corner") {
          latest = cornerResizeTextLayer(start, Math.hypot(pointer.clientX - centre.x, pointer.clientY - centre.y) / startDistance);
        } else {
          latest = sideResizeTextLayer(start, side ?? "right", ((pointer.clientX - rect.left) / widthPx) * 100);
        }
        setDraft({ id: layer.id, patch: latest });
      };
      const end = (commit: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        setGuides([]);
        setDraft(null);
        if (commit && moved && latest) onCommit(layer.id, latest, kind);
      };
      const up = () => end(true);
      const cancel = () => end(false);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
    [canvas.width, canvas.height, scale, onSelect, onCommit, reachOf],
  );

  const nudge = (event: React.KeyboardEvent, entry: TextLayerCanvasEntry): boolean => {
    const step = ARROWS[event.key];
    if (!step || !onNudge || entry.layer.id !== selectedId) return false;
    const by = event.shiftKey ? 5 : 1;
    onNudge(entry.layer.id, nudgeTextLayer(entry.layer, step[0] * by, step[1] * by, reachOf(entry.key)));
    return true;
  };

  if (!built) return null;
  const box = (frame: { x1: number; y1: number; x2: number; y2: number }) => ({
    left: `${frame.x1 * scale}px`,
    top: `${frame.y1 * scale}px`,
    width: `${(frame.x2 - frame.x1) * scale}px`,
    height: `${(frame.y2 - frame.y1) * scale}px`,
  });

  return (
    <>
      <SnapGuideLines guides={guides} />
      <div ref={rootRef} style={{ position: "absolute", left: 0, top: 0, width: `${canvas.width * scale}px`, height: `${canvas.height * scale}px`, zIndex: zIndex.paint, pointerEvents: "none" }}>
        <CaptionSceneLayers built={built.built} canvas={canvas} scale={scale} timeSource={timeSource} />
        {/* Hit areas in document order: where layers overlap, the later (drawn on top) takes the click. */}
        {onScreen.map((entry) => {
          const { layer } = entry;
          const frame = built.layouts.get(entry.key)?.frame;
          if (!frame) return null;
          const isSelected = layer.id === selectedId;
          return (
            <Box
              key={entry.key}
              data-text-layer-hit={layer.id}
              role="button"
              tabIndex={0}
              aria-label={isSelected ? `${layerName(layer)}, selected. Arrow keys move it; Enter edits the words` : `Select ${layerName(layer)}`}
              aria-pressed={isSelected}
              position="absolute"
              style={box(frame)}
              pointerEvents="auto"
              cursor={isSelected ? "move" : "pointer"}
              outline="none"
              _focusVisible={{ boxShadow: "0 0 0 1.5px var(--chakra-colors-studio-border-focus)", borderRadius: "4px" }}
              onPointerDown={(event) => startGesture(event, entry, "move")}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onEditText?.(layer.id);
              }}
              onKeyUp={(event) => {
                if (ARROWS[event.key] && isSelected) onNudgeEnd?.();
              }}
              onKeyDown={(event) => {
                if (nudge(event, entry)) {
                  // The Studio's shortcuts listen on the window: an arrow here moves the layer, not the playhead.
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                if (event.key === "Enter" || event.key === " ") {
                  // The Studio's shortcuts listen on the window: Space here selects, it does not play.
                  event.preventDefault();
                  event.stopPropagation();
                  if (isSelected) onEditText?.(layer.id);
                  else onSelect(layer.id);
                }
              }}
              onPointerEnter={() => setHoveredId(layer.id)}
              onPointerLeave={() => setHoveredId((current) => (current === layer.id ? null : current))}
            >
              {!isSelected && hoveredId === layer.id ? <Box position="absolute" inset="-2px" borderRadius="4px" boxShadow="0 0 0 1px var(--chakra-colors-studio-accent)" opacity={0.6} pointerEvents="none" /> : null}
            </Box>
          );
        })}
      </div>
      {selected && selectedFrame ? (
        <div style={{ position: "absolute", left: 0, top: 0, width: `${canvas.width * scale}px`, height: `${canvas.height * scale}px`, zIndex: zIndex.frame, pointerEvents: "none" }}>
          {/* Not a pointer target itself: only the grips are. */}
          <Box position="absolute" style={box(selectedFrame)} pointerEvents="none" data-text-layer-frame={selected.layer.id}>
            <Box position="absolute" inset="-2px" borderRadius="3px" boxShadow="0 0 0 1.5px var(--chakra-colors-studio-accent)" pointerEvents="none" aria-hidden />
            {CORNERS.map((corner) => (
              <Box
                key={corner.id}
                role="presentation"
                aria-label={`Resize from the ${corner.label} corner`}
                position="absolute"
                boxSize="20px"
                display="flex"
                alignItems="center"
                justifyContent="center"
                cursor={corner.cursor}
                pointerEvents="auto"
                style={{ left: corner.left, top: corner.top, transform: "translate(-50%, -50%)", touchAction: "none" }}
                onPointerDown={(event) => startGesture(event, selected, "corner")}
              >
                <Box boxSize="10px" borderRadius="full" bg="studio.fg" boxShadow="0 0 0 1.5px var(--chakra-colors-studio-accent)" />
              </Box>
            ))}
            {SIDES.map((grip) => (
              <Box
                key={grip.side}
                role="presentation"
                aria-label={`Change the width from the ${grip.label} edge`}
                position="absolute"
                w="20px"
                h="28px"
                display="flex"
                alignItems="center"
                justifyContent="center"
                cursor="ew-resize"
                pointerEvents="auto"
                style={{ left: grip.left, top: "50%", transform: "translate(-50%, -50%)", touchAction: "none" }}
                onPointerDown={(event) => startGesture(event, selected, "side", grip.side)}
              >
                <Box w="6px" h="16px" borderRadius="full" bg="studio.fg" boxShadow="0 0 0 1.5px var(--chakra-colors-studio-accent)" />
              </Box>
            ))}
          </Box>
          {toolbar && !draft ? (
            <FloatingToolbar rootRef={rootRef} boundsRef={toolbarBoundsRef} frame={{ left: selectedFrame.x1 * scale, top: selectedFrame.y1 * scale, right: selectedFrame.x2 * scale, bottom: selectedFrame.y2 * scale }}>
              {(compact) => toolbar(selected.layer, { compact })}
            </FloatingToolbar>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * The toolbar under the frame (above it without room), kept inside the bounds. Portaled with fixed
 * positioning so the preview's clipping never cuts it; placed from the canvas's screen position.
 */
function FloatingToolbar({ rootRef, boundsRef, frame, children }: { rootRef: React.RefObject<HTMLDivElement | null>; boundsRef?: React.RefObject<HTMLElement | null>; frame: { left: number; top: number; right: number; bottom: number }; children: (compact: boolean) => ReactNode }) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [compact, setCompact] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((value) => value + 1);
    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);
    const observer = new ResizeObserver(bump);
    if (toolbarRef.current) observer.observe(toolbarRef.current);
    return () => {
      window.removeEventListener("resize", bump);
      window.removeEventListener("scroll", bump, true);
      observer.disconnect();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-places the toolbar after a resize or scroll.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const toolbar = toolbarRef.current;
    if (!root || !toolbar) return;
    const rect = root.getBoundingClientRect();
    const bounds = boundsRef?.current?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const inset = 8;
    const room = Math.min(window.innerWidth, bounds.right) - Math.max(0, bounds.left) - 2 * inset;
    setCompact(room < COMPACT_TOOLBAR_PX);
    const next = textToolbarPlacement(
      { left: rect.left + frame.left, top: rect.top + frame.top, right: rect.left + frame.right, bottom: rect.top + frame.bottom },
      { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
      { left: Math.max(0, bounds.left) + inset, top: Math.max(0, bounds.top) + inset, right: Math.min(window.innerWidth, bounds.right) - inset, bottom: Math.min(window.innerHeight, bounds.bottom) - inset },
    );
    setPlace((current) => (current && current.left === next.left && current.top === next.top ? current : { left: next.left, top: next.top }));
  }, [frame.left, frame.top, frame.right, frame.bottom, tick, rootRef, boundsRef]);
  return (
    <Portal>
      <Box
        ref={toolbarRef}
        role="toolbar"
        aria-label="Text"
        position="fixed"
        zIndex={40}
        style={{ left: `${place?.left ?? -9999}px`, top: `${place?.top ?? -9999}px`, visibility: place ? "visible" : "hidden" }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {children(compact)}
      </Box>
    </Portal>
  );
}
