"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Box, Flex, Popover, Portal, Slider, Stack, Text } from "@chakra-ui/react";
import { toaster } from "@narriflow/ui/components/toaster";
import { Music, Plus, Scissors, Trash2 } from "lucide-react";
import { resolveMusicFadeWindows, type StudioMusicBlock } from "@narriflow/validators";
import { useStudio } from "./studio-shell";
import {
  blockDurationSec,
  blockEndSec,
  blockWaveformColumns,
  formatMusicTime,
  loopPointsSec,
  moveBlock,
  patchMusicBlock,
  snapTargets,
  trimBlockEnd,
  trimBlockStart,
  type SnapConfig,
} from "./music-blocks";
import { loadTrackPeaks, type TrackPeaks } from "./music-waveform";
import { fetchAudioPlayback, useAudioApi } from "./tool-panels/audio-library";
import { studioSliderCss } from "./tool-panels/panel-ui";

export const MUSIC_LANE_HEIGHT = 36;
export const MUSIC_LANE_EMPTY_HEIGHT = 24;

const MOVE_THRESHOLD_PX = 3;
const SNAP_THRESHOLD_PX = 8;
const GRIP_WIDTH_PX = 8;
const MIN_BLOCK_WIDTH_PX = 14;

type GestureMode = "move" | "trim-start" | "trim-end";

interface Gesture {
  id: string;
  mode: GestureMode;
  startClientX: number;
  grab: Pick<StudioMusicBlock, "startSec" | "endSec" | "sourceStartSec">;
  blocks: readonly StudioMusicBlock[];
  playheadSec: number;
  moved: boolean;
}

/** What the dragged block looks like while the gesture is in flight; nothing is stored until the drop. */
interface GesturePreview {
  id: string;
  startSec: number;
  endSec: number | null;
  sourceStartSec: number;
  guideSec: number | null;
  tipSec: number;
  tipEdge: "start" | "end";
}

/** Keeps an event inside the block menu from reaching timeline handlers. */
function stopTimelineEvent(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export interface MusicLaneProps {
  left: number;
  top: number;
  width: number;
  height: number;
  pxPerSec: number;
  /** Edited-timeline length of the clip, the unit every block is stored in. */
  clipDurationSec: number;
  /** Composite timeline length, for clamping seeks. */
  timelineDurationSec: number;
  visibleRange: { startSec: number; endSec: number };
  /** Offsets that stretch the snap guide over every lane, from this lane's top. */
  guideTop: number;
  guideHeight: number;
}

function blockLabel(block: StudioMusicBlock): string {
  return block.title?.trim() || "Music";
}

export function MusicLane({
  left,
  top,
  width,
  height,
  pxPerSec,
  clipDurationSec,
  timelineDurationSec,
  visibleRange,
  guideTop,
  guideHeight,
}: MusicLaneProps) {
  const {
    studioEdits,
    selectedMusicBlockId,
    selectMusicBlock,
    deselectMusicBlock,
    splitSelectedMusicBlock,
    deleteSelectedMusicBlock,
    setStudioEdits,
    endCoalesce,
    seekTo,
    setActiveTool,
    timelineSnapping,
    baseEditedToComposite,
    compositeToBaseEdited,
    playbackClock,
  } = useStudio(
    "studioEdits",
    "selectedMusicBlockId",
    "selectMusicBlock",
    "deselectMusicBlock",
    "splitSelectedMusicBlock",
    "deleteSelectedMusicBlock",
    "setStudioEdits",
    "endCoalesce",
    "seekTo",
    "setActiveTool",
    "timelineSnapping",
    "baseEditedToComposite",
    "compositeToBaseEdited",
    "playbackClock",
  );
  const blocks = studioEdits.music.blocks;
  const laneRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const latestPreviewRef = useRef<GesturePreview | null>(null);
  const [preview, setPreview] = useState<GesturePreview | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const timeAtClientX = useCallback(
    (clientX: number) => {
      const rect = laneRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      return Math.max(0, Math.min(timelineDurationSec, (clientX - rect.left) / pxPerSec));
    },
    [pxPerSec, timelineDurationSec],
  );

  const endGesture = useCallback(() => {
    gestureRef.current = null;
    latestPreviewRef.current = null;
    setPreview(null);
  }, []);

  const beginGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>, block: StudioMusicBlock, mode: GestureMode) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A non-capturable pointer still delivers move and up by bubbling.
      }
      gestureRef.current = {
        id: block.id,
        mode,
        startClientX: event.clientX,
        grab: {
          startSec: block.startSec,
          endSec: block.endSec,
          sourceStartSec: block.sourceStartSec,
        },
        blocks,
        playheadSec: compositeToBaseEdited(playbackClock.getSnapshot()),
        moved: false,
      };
      selectMusicBlock(block.id);
    },
    [blocks, compositeToBaseEdited, playbackClock, selectMusicBlock],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (event.buttons === 0) {
        endGesture();
        return;
      }
      const dxPx = event.clientX - gesture.startClientX;
      if (!gesture.moved && Math.abs(dxPx) <= MOVE_THRESHOLD_PX) return;
      gesture.moved = true;

      const deltaSec = dxPx / pxPerSec;
      const shifted = (baseSec: number) =>
        compositeToBaseEdited(baseEditedToComposite(baseSec) + deltaSec);
      const snap: SnapConfig | null = timelineSnapping
        ? {
            targetsSec: snapTargets(gesture.blocks, gesture.id, gesture.playheadSec, clipDurationSec),
            thresholdSec: SNAP_THRESHOLD_PX / pxPerSec,
          }
        : null;

      let next: GesturePreview | null = null;
      if (gesture.mode === "move") {
        const moved = moveBlock(gesture.blocks, gesture.id, shifted(gesture.grab.startSec), clipDurationSec, snap);
        if (moved) {
          next = {
            id: gesture.id,
            ...moved,
            sourceStartSec: gesture.grab.sourceStartSec,
            tipSec: moved.startSec,
            tipEdge: "start",
          };
        }
      } else if (gesture.mode === "trim-start") {
        const trimmed = trimBlockStart(gesture.blocks, gesture.id, shifted(gesture.grab.startSec), clipDurationSec, snap);
        if (trimmed) {
          next = {
            id: gesture.id,
            startSec: trimmed.startSec,
            endSec: gesture.grab.endSec,
            sourceStartSec: trimmed.sourceStartSec,
            guideSec: trimmed.guideSec,
            tipSec: trimmed.startSec,
            tipEdge: "start",
          };
        }
      } else {
        const trimmed = trimBlockEnd(
          gesture.blocks,
          gesture.id,
          shifted(gesture.grab.endSec ?? clipDurationSec),
          clipDurationSec,
          snap,
        );
        if (trimmed) {
          next = {
            id: gesture.id,
            startSec: gesture.grab.startSec,
            endSec: trimmed.endSec,
            sourceStartSec: gesture.grab.sourceStartSec,
            guideSec: trimmed.guideSec,
            tipSec: trimmed.endSec ?? clipDurationSec,
            tipEdge: "end",
          };
        }
      }
      if (!next) return;
      latestPreviewRef.current = next;
      setPreview(next);
    },
    [baseEditedToComposite, clipDurationSec, compositeToBaseEdited, endGesture, pxPerSec, timelineSnapping],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Already released.
      }
      const gesture = gestureRef.current;
      const result = latestPreviewRef.current;
      endGesture();
      if (!gesture) return;
      if (!gesture.moved) {
        // A plain click on the body seeks to where it landed.
        if (gesture.mode === "move") seekTo(timeAtClientX(event.clientX));
        return;
      }
      if (result) {
        // One store write per gesture is one undo step.
        setStudioEdits((prev) => ({
          ...prev,
          music: {
            ...prev.music,
            blocks: patchMusicBlock(prev.music.blocks, result.id, {
              startSec: result.startSec,
              endSec: result.endSec,
              sourceStartSec: result.sourceStartSec,
            }),
          },
        }));
      }
      endCoalesce();
    },
    [endCoalesce, endGesture, seekTo, setStudioEdits, timeAtClientX],
  );

  // Escape abandons a drag in flight; nothing was stored, so there is nothing to undo.
  const dragging = preview !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      endGesture();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging, endGesture]);

  const openMenu = useCallback(
    (event: { clientX: number; clientY: number }, block: StudioMusicBlock, seek: boolean) => {
      selectMusicBlock(block.id);
      if (seek) seekTo(timeAtClientX(event.clientX));
      setMenu({ id: block.id, x: event.clientX, y: event.clientY });
    },
    [seekTo, selectMusicBlock, timeAtClientX],
  );

  const visibleBlocks = blocks.filter((block) => {
    const view = preview?.id === block.id ? { ...block, ...preview } : block;
    return (
      baseEditedToComposite(blockEndSec(view, clipDurationSec)) >= visibleRange.startSec &&
      baseEditedToComposite(view.startSec) <= visibleRange.endSec
    );
  });

  const menuBlock = menu ? blocks.find((block) => block.id === menu.id) ?? null : null;
  const menuPositioning = useMemo(
    () => ({
      placement: "top-start" as const,
      getAnchorRect: () => ({ x: menu?.x ?? 0, y: menu?.y ?? 0, width: 0, height: 0 }),
    }),
    [menu?.x, menu?.y],
  );

  const guideSec = preview?.guideSec ?? null;
  const tipX = preview
    ? baseEditedToComposite(preview.tipSec) * pxPerSec
    : 0;

  return (
    <Box
      ref={laneRef}
      position="absolute"
      data-music-lane
      style={{ top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` }}
      onClick={(event) => {
        // Empty lane space seeks and deselects, like the video track.
        if (event.target !== event.currentTarget) return;
        seekTo(timeAtClientX(event.clientX));
        deselectMusicBlock();
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={(event) => {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // Already released.
        }
        endGesture();
      }}
    >
      {blocks.length === 0 ? (
        <Flex
          as="button"
          aria-label="Add music"
          w="full"
          h="full"
          align="center"
          gap="1.5"
          px="2.5"
          borderRadius="8px"
          bg="studio.subtle"
          color="studio.fgSubtle"
          fontSize="11px"
          fontWeight="500"
          cursor="pointer"
          transition="background 120ms ease, color 120ms ease"
          _hover={{ bg: "studio.raised", color: "studio.fg" }}
          onClick={(event) => {
            event.stopPropagation();
            setActiveTool("music");
          }}
        >
          <Plus size={12} aria-hidden />
          Add music
        </Flex>
      ) : (
        <Box
          position="absolute"
          inset="0"
          bg="studio.subtle"
          borderRadius="8px"
          pointerEvents="none"
          aria-hidden="true"
        />
      )}

      {visibleBlocks.map((block) => {
        const view = preview?.id === block.id ? { ...block, ...preview } : block;
        const startX = baseEditedToComposite(view.startSec) * pxPerSec;
        const endX = baseEditedToComposite(blockEndSec(view, clipDurationSec)) * pxPerSec;
        return (
          <MusicBlockView
            key={block.id}
            block={view}
            selected={selectedMusicBlockId === block.id}
            gesturing={preview?.id === block.id}
            x={startX}
            widthPx={Math.max(MIN_BLOCK_WIDTH_PX, endX - startX)}
            height={height}
            pxPerSec={pxPerSec}
            durationSec={blockDurationSec(view, clipDurationSec)}
            onBegin={beginGesture}
            onContextMenu={openMenu}
          />
        );
      })}

      {guideSec !== null ? (
        <Box
          position="absolute"
          w="1px"
          bg="studio.accent"
          pointerEvents="none"
          zIndex={11}
          aria-hidden="true"
          style={{
            left: `${baseEditedToComposite(guideSec) * pxPerSec}px`,
            top: `${guideTop}px`,
            height: `${guideHeight}px`,
          }}
        />
      ) : null}

      {preview ? (
        <Box
          position="absolute"
          px="1.5"
          borderRadius="4px"
          bg="studio.raised"
          color="studio.fg"
          textStyle="data"
          fontSize="10px"
          lineHeight="16px"
          whiteSpace="nowrap"
          pointerEvents="none"
          zIndex={30}
          role="status"
          style={{ left: `${tipX}px`, top: "-20px", transform: "translateX(-50%)" }}
        >
          {formatMusicTime(preview.tipSec)}
        </Box>
      ) : null}

      <MusicBlockMenu
        block={menuBlock}
        positioning={menuPositioning}
        onClose={() => setMenu(null)}
        onSplit={() => {
          if (!splitSelectedMusicBlock()) {
            toaster.create({
              type: "info",
              title: "Move the playhead inside the block",
              description: "It must sit at least half a second from either edge.",
            });
            return;
          }
          setMenu(null);
        }}
        onDelete={() => {
          setMenu(null);
          deleteSelectedMusicBlock();
        }}
      />
    </Box>
  );
}

// ─── One block ───────────────────────────────────────────────────────────────

const MusicBlockView = memo(function MusicBlockView({
  block,
  selected,
  gesturing,
  x,
  widthPx,
  height,
  pxPerSec,
  durationSec,
  onBegin,
  onContextMenu,
}: {
  block: StudioMusicBlock;
  selected: boolean;
  gesturing: boolean;
  x: number;
  widthPx: number;
  height: number;
  pxPerSec: number;
  durationSec: number;
  onBegin: (event: ReactPointerEvent<HTMLElement>, block: StudioMusicBlock, mode: GestureMode) => void;
  onContextMenu: (event: { clientX: number; clientY: number }, block: StudioMusicBlock, seek: boolean) => void;
}) {
  const peaks = useTrackPeaks(block);
  const fades = resolveMusicFadeWindows(block.fadeInSec, block.fadeOutSec, durationSec);
  const fadeInPx = Math.min(widthPx, fades.fadeInSec * pxPerSec);
  const fadeOutPx = Math.min(widthPx, fades.fadeOutSec * pxPerSec);
  const label = blockLabel(block);

  return (
    <Box
      role="button"
      aria-label={`${label}, music, ${durationSec.toFixed(1)} seconds`}
      aria-pressed={selected}
      position="absolute"
      top="0"
      overflow="hidden"
      borderRadius="6px"
      bg={selected ? "studio.accentSubtle" : "studio.raised"}
      cursor={gesturing ? "grabbing" : "grab"}
      color={selected ? "studio.accentFg" : "studio.fgMuted"}
      transition={gesturing ? "none" : "background 120ms ease"}
      zIndex={gesturing ? 12 : selected ? 5 : 1}
      boxShadow={selected ? "inset 0 0 0 2px {colors.studio.accent}" : "none"}
      _hover={selected ? undefined : { bg: "studio.borderStrong" }}
      style={{
        left: `${x}px`,
        width: `${widthPx}px`,
        height: `${height}px`,
        touchAction: "none",
        willChange: gesturing ? "left, width" : undefined,
      }}
      onPointerDown={(event) => onBegin(event, block, "move")}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event, block, true);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onContextMenu(event, block, false);
      }}
    >
      <MusicWaveform
        block={block}
        peaks={peaks}
        widthPx={widthPx}
        height={height}
        durationSec={durationSec}
      />

      {fadeInPx > 1 || fadeOutPx > 1 ? (
        <svg
          width={widthPx}
          height={height}
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {fadeInPx > 1 ? (
            <>
              <polygon points={`0,0 ${fadeInPx},0 0,${height}`} fill="rgba(0,0,0,0.3)" />
              <line x1={0} y1={height} x2={fadeInPx} y2={0} stroke="currentColor" strokeOpacity={0.7} />
            </>
          ) : null}
          {fadeOutPx > 1 ? (
            <>
              <polygon
                points={`${widthPx - fadeOutPx},0 ${widthPx},0 ${widthPx},${height}`}
                fill="rgba(0,0,0,0.3)"
              />
              <line
                x1={widthPx - fadeOutPx}
                y1={0}
                x2={widthPx}
                y2={height}
                stroke="currentColor"
                strokeOpacity={0.7}
              />
            </>
          ) : null}
        </svg>
      ) : null}

      <Flex
        position="absolute"
        inset="0"
        align="center"
        gap="1.5"
        minW="0"
        pointerEvents="none"
        style={{ paddingLeft: `${GRIP_WIDTH_PX + 2}px`, paddingRight: `${GRIP_WIDTH_PX + 2}px` }}
      >
        <Flex flexShrink={0} aria-hidden>
          <Music size={12} />
        </Flex>
        {widthPx > 56 ? (
          <Text fontSize="11px" fontWeight="500" color="studio.fg" truncate minW="0" flex="1" userSelect="none">
            {label}
          </Text>
        ) : null}
        {selected && widthPx > 110 ? (
          <Text
            flexShrink={0}
            px="1.5"
            borderRadius="4px"
            bg="studio.accent"
            color="white"
            textStyle="data"
            fontSize="10px"
            lineHeight="16px"
          >
            {durationSec.toFixed(1)}s
          </Text>
        ) : null}
      </Flex>

      <Grip side="left" selected={selected} onPointerDown={(event) => onBegin(event, block, "trim-start")} />
      <Grip side="right" selected={selected} onPointerDown={(event) => onBegin(event, block, "trim-end")} />
    </Box>
  );
});

function Grip({
  side,
  selected,
  onPointerDown,
}: {
  side: "left" | "right";
  selected: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <Flex
      position="absolute"
      top="0"
      bottom="0"
      align="center"
      justify="center"
      cursor="ew-resize"
      bg={selected ? "studio.accent" : "transparent"}
      style={{ [side]: 0, width: `${GRIP_WIDTH_PX}px`, touchAction: "none" }}
      onPointerDown={onPointerDown}
    >
      {selected ? <Box w="2px" h="12px" borderRadius="full" bg="white" opacity={0.9} /> : null}
    </Flex>
  );
}

// ─── Waveform ────────────────────────────────────────────────────────────────

/**
 * The block's decoded track peaks, or null while loading / when decoding is
 * not possible. Starts when the block mounts (so only blocks near the
 * viewport), after the first paint, and never delays interaction.
 */
function useTrackPeaks(block: StudioMusicBlock): TrackPeaks | null {
  const audioApi = useAudioApi();
  const [peaks, setPeaks] = useState<TrackPeaks | null>(null);
  const key = block.assetId ?? block.url;
  const { assetId, url } = block;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the track identity (asset or link) is the only trigger.
  useEffect(() => {
    if (!key) return;
    let canceled = false;
    const run = () => {
      const sources = [
        // The stored URL first: it is free, and a presign may still be valid.
        async () => url,
        async () => (assetId ? ((await fetchAudioPlayback(audioApi, assetId))?.url ?? null) : null),
      ];
      void loadTrackPeaks(key, sources).then((result) => {
        if (!canceled) setPeaks(result);
      });
    };
    const idle = (
      window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
      }
    );
    if (idle.requestIdleCallback) {
      const handle = idle.requestIdleCallback(run, { timeout: 1500 });
      return () => {
        canceled = true;
        idle.cancelIdleCallback?.(handle);
      };
    }
    const timeout = window.setTimeout(run, 120);
    return () => {
      canceled = true;
      window.clearTimeout(timeout);
    };
  }, [key, audioApi]);

  return peaks;
}

const BAR_PX = 2;
const BAR_STEP_PX = 3;
const MAX_CANVAS_PX = 4096;
const FLAT_LEVEL = 0.16;

function MusicWaveform({
  block,
  peaks,
  widthPx,
  height,
  durationSec,
}: {
  block: StudioMusicBlock;
  peaks: TrackPeaks | null;
  widthPx: number;
  height: number;
  durationSec: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { sourceStartSec } = block;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || widthPx <= 0) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2, MAX_CANVAS_PX / widthPx);
    canvas.width = Math.max(1, Math.round(widthPx * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, widthPx, height);

    const columnCount = Math.max(1, Math.floor(widthPx / BAR_STEP_PX));
    const columns = peaks
      ? blockWaveformColumns(peaks.peaks, peaks.durationSec, sourceStartSec, durationSec, columnCount)
      : [];
    const mid = height / 2;
    const maxHalf = height / 2 - 5;
    // The canvas inherits the block's token color, so selection retints it.
    ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.globalAlpha = peaks ? 0.55 : 0.28;
    for (let column = 0; column < columnCount; column++) {
      const level = peaks ? Math.max(0.06, columns[column] ?? 0) : FLAT_LEVEL;
      const half = Math.max(1, level * maxHalf);
      ctx.fillRect(column * (widthPx / columnCount), mid - half, BAR_PX, half * 2);
    }

    // Where a short track restarts, so the loop is visible.
    ctx.globalAlpha = 0.5;
    for (const pointSec of loopPointsSec(sourceStartSec, durationSec, peaks?.durationSec ?? null)) {
      ctx.fillRect((pointSec / durationSec) * widthPx, 4, 1, height - 8);
    }
  }, [peaks, widthPx, height, durationSec, sourceStartSec]);

  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas is not focusable; this is a decorative waveform.
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        color: "inherit",
        pointerEvents: "none",
      }}
    />
  );
}

// ─── Right-click / double-click menu ─────────────────────────────────────────

function MusicBlockMenu({
  block,
  positioning,
  onClose,
  onSplit,
  onDelete,
}: {
  block: StudioMusicBlock | null;
  positioning: { placement: "top-start"; getAnchorRect: () => { x: number; y: number; width: number; height: number } };
  onClose: () => void;
  onSplit: () => void;
  onDelete: () => void;
}) {
  const { setStudioEdits, endCoalesce } = useStudio("setStudioEdits", "endCoalesce");
  const id = block?.id ?? null;

  const update = useCallback(
    (patch: Partial<StudioMusicBlock>, field: string) => {
      if (!id) return;
      setStudioEdits(
        (prev) => ({
          ...prev,
          music: { ...prev.music, blocks: patchMusicBlock(prev.music.blocks, id, patch) },
        }),
        `music-block-${id}-${field}`,
      );
    },
    [id, setStudioEdits],
  );

  const rows = block
    ? ([
        ["Volume", block.volume, 0, 100, 1, "%", "Block volume", "volume", (value: number) => ({ volume: value })],
        ["Fade in", block.fadeInSec, 0, 5, 0.1, "s", "Block fade in", "fade-in", (value: number) => ({ fadeInSec: value })],
        ["Fade out", block.fadeOutSec, 0, 5, 0.1, "s", "Block fade out", "fade-out", (value: number) => ({ fadeOutSec: value })],
      ] as const)
    : [];

  return (
    <Popover.Root
      open={block !== null}
      onOpenChange={(event) => {
        if (!event.open) onClose();
      }}
      positioning={positioning}
      lazyMount
      unmountOnExit
    >
      <Portal>
        {/* React bubbles portal events through the component tree, so without
            this the timeline under the menu would track the hover line, zoom
            on wheel and take clicks meant for the menu. */}
        <Popover.Positioner
          onPointerDown={stopTimelineEvent}
          onPointerMove={stopTimelineEvent}
          onPointerUp={stopTimelineEvent}
          onClick={stopTimelineEvent}
          onDoubleClick={stopTimelineEvent}
          onContextMenu={stopTimelineEvent}
          onWheel={stopTimelineEvent}
        >
          <Popover.Content
            w="260px"
            p="4"
            bg="studio.surface"
            color="studio.fg"
            borderWidth="0"
            borderRadius="14px"
            boxShadow="none"
            aria-label="Music block settings"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                onClose();
              }
            }}
          >
            {block ? (
              <Stack gap="3.5">
                <Flex align="center" gap="2" minW="0" color="studio.fgMuted">
                  <Music size={14} aria-hidden />
                  <Text fontSize="13px" fontWeight="500" color="studio.fg" truncate>
                    {blockLabel(block)}
                  </Text>
                </Flex>

                {rows.map(([label, value, min, max, step, suffix, aria, field, toPatch]) => (
                  <Stack key={label} gap="1.5">
                    <Flex justify="space-between" align="baseline">
                      <Text fontSize="13px" color="studio.fgMuted">{label}</Text>
                      <Text fontSize="13px" fontVariantNumeric="tabular-nums">
                        {suffix === "%" ? Math.round(value) : value.toFixed(1)}
                        {suffix}
                      </Text>
                    </Flex>
                    <Slider.Root
                      aria-label={[aria]}
                      value={[value]}
                      min={min}
                      max={max}
                      step={step}
                      onValueChange={(event) => update(toPatch(event.value[0] ?? value), field)}
                      onValueChangeEnd={endCoalesce}
                      size="sm"
                      css={studioSliderCss}
                    >
                      <Slider.Control>
                        <Slider.Track>
                          <Slider.Range />
                        </Slider.Track>
                        <Slider.Thumbs />
                      </Slider.Control>
                    </Slider.Root>
                  </Stack>
                ))}

                <Flex gap="2" pt="0.5">
                  <MenuAction icon={<Scissors size={13} />} label="Split" hint="S" onClick={onSplit} />
                  <MenuAction icon={<Trash2 size={13} />} label="Delete" hint="⌫" danger onClick={onDelete} />
                </Flex>
              </Stack>
            ) : null}
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

function MenuAction({
  icon,
  label,
  hint,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <Flex
      as="button"
      flex="1"
      h="34px"
      align="center"
      justify="center"
      gap="1.5"
      borderRadius="8px"
      bg="studio.subtle"
      color={danger ? "studio.danger" : "studio.fg"}
      fontSize="13px"
      fontWeight="500"
      cursor="pointer"
      transition="background 120ms ease"
      _hover={{ bg: "studio.raised" }}
      onClick={onClick}
    >
      {icon}
      {label}
      <Text as="span" fontSize="11px" color="studio.fgSubtle">
        {hint}
      </Text>
    </Flex>
  );
}
