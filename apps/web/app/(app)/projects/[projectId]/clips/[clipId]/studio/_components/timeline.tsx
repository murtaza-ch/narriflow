"use client";

import { memo, useRef, useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { Box, Flex, Text, Slider, Popover, Portal, Stack } from "@chakra-ui/react";
import { Button, toaster } from "@narriflow/ui";
import {
  Eye,
  EyeOff,
  Scissors,
  Trash2,
  SkipBack,
  Play,
  Pause,
  SkipForward,
  ZoomIn,
  ZoomOut,
  Undo2,
  AudioLines,
} from "lucide-react";
import {
  editedToSource,
  sourceRangeToEdited,
  detectSilenceRanges,
  SILENCE_DEFAULT_MIN_SILENCE_SEC,
  SILENCE_DEFAULT_PAD_SEC,
  CLIP_MIN_DURATION_SEC,
  CLIP_MAX_DURATION_SEC,
} from "@narriflow/validators";
import type { EditedTimeMap, SourceRange, TranscriptUtterance } from "@narriflow/validators";
import type { ClipPreviewPeaks } from "@narriflow/services";
import { useStudio } from "./studio-shell";
import { usePlaybackTime } from "./playback-clock";
import { deletedRangesToCutMarkers, projectSegmentToEdited, type CutMarker } from "./edited-timeline";
import { loadClipPreviewPeaks, sampleAmplitudeAtSourceTime } from "./waveform-peaks";
import {
  getCachedTimelineThumbnail,
  requestTimelineThumbnail,
  setTimelineThumbnailPlaybackActive,
  type ThumbnailVideoKind,
} from "./timeline-preview-manager";
import {
  loadTrimTranscript,
  prefetchTrimTranscript,
  nearestWordBoundary,
  type TrimTranscript,
} from "./trim-transcript-cache";
import {
  averageWordDurationSec,
  findActiveWordId,
  projectWordsToEdited,
  pxPerWordForZoom,
  selectVisibleWordChips,
  shouldRenderWordChips,
  zoomForFitToSentence,
  zoomForFitToWord,
  type WordChipDatum,
} from "./word-chips";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Frame-accurate MM:SS.ff readout — sub-second precision that the shared
// integer-second formatTimecode helper intentionally doesn't cover.
function formatTimecode(secs: number) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const f = Math.floor((secs % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
}

function formatRulerLabel(secs: number) {
  if (secs === 0) return "0";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  if (m > 0 && s === 0) return `${m}m`;
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}`;
  return `${s}`;
}

// ─── Thumbnail strip (canvas-based, memory-only session cache) ───────────────

function drawCachedStrip(
  target: HTMLCanvasElement,
  cached: HTMLCanvasElement,
  width: number,
  height: number,
) {
  const ctx = target.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(cached, 0, 0, width, height);
}

/**
 * Renders one cached canvas strip per segment. The canvas is intentionally capped
 * in internal pixel width so long clips do not create huge browser surfaces.
 */
const SegmentThumbnails = memo(function SegmentThumbnails({
  thumbnailVideoUrl,
  videoKind,
  offsetSec,
  sourcePreviewId,
  clipStartSec,
  editedStartSec,
  editedEndSec,
  editedTimeMap,
  cutsSignature,
  width,
  height,
}: {
  /** The proxy when one exists, else the source once the user has opted
   *  in, else null — same resolution rule as the main player's
   *  `activeVideoUrl` (see studio-shell.tsx), so the timeline never opens a
   *  full-source reader the player itself wouldn't also open. */
  thumbnailVideoUrl: string | null;
  videoKind: ThumbnailVideoKind;
  /** Source time -> `thumbnailVideoUrl`-local time offset (studio-shell.tsx's
   *  `activeOffsetSec`). Subtracted from every seek target before it reaches
   *  the hidden scrub `<video>` — see `sourceTimeToVideoTime`. */
  offsetSec: number;
  sourcePreviewId: string;
  clipStartSec: number;
  /** Fix 6 (Phase B hardening): this block's own EDITED-timeline span —
   *  exactly what it's drawn at (see TimelineSegmentBlock's `x`/`w`), not
   *  the segment's raw uncut source span. A segment straddling a cut is
   *  drawn narrower than its full source range; sampling must walk THIS
   *  span through `editedTimeMap` so every thumbnail frame comes from kept
   *  footage, matching what the block's own width already implies. */
  editedStartSec: number;
  editedEndSec: number;
  editedTimeMap: EditedTimeMap;
  /** Short signature of the clip's current `deletedRanges` — part of the
   *  thumbnail cache key (see timeline-preview-manager.ts's `cacheKeyFor`)
   *  so a strip captured under one cut layout can't be handed back once
   *  the cuts change. */
  cutsSignature: string;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const renderWidth = Math.max(1, Math.round(width));
  const renderHeight = Math.max(1, Math.round(height));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;

    canvas.width = renderWidth;
    canvas.height = renderHeight;

    const cachedRefined = getCachedTimelineThumbnail({
      sourcePreviewId,
      videoKind,
      clipStartSec,
      editedStartSec,
      editedEndSec,
      cutsSignature,
      width: renderWidth,
      height: renderHeight,
      quality: "refined",
    });
    const cachedCoarse = getCachedTimelineThumbnail({
      sourcePreviewId,
      videoKind,
      clipStartSec,
      editedStartSec,
      editedEndSec,
      cutsSignature,
      width: renderWidth,
      height: renderHeight,
      quality: "coarse",
    });
    const cached = cachedRefined ?? cachedCoarse;

    if (cached) {
      drawCachedStrip(canvas, cached, renderWidth, renderHeight);
      setStatus("ready");
      if (cachedRefined) return;
    } else {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, renderWidth, renderHeight);
      // Canvas can't consume theme tokens — literal matches studio.subtle.
      ctx.fillStyle = "#14171C";
      ctx.fillRect(0, 0, renderWidth, renderHeight);
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      for (let x = 0; x < renderWidth; x += 42) {
        ctx.fillRect(x, 0, 18, renderHeight);
      }
    }

    setStatus(thumbnailVideoUrl ? (cached ? "ready" : "loading") : "idle");

    if (!thumbnailVideoUrl) return;

    const editedDuration = editedEndSec - editedStartSec;
    if (editedDuration <= 0) return;

    let cancelled = false;
    const drawStrip = (strip: HTMLCanvasElement, isComplete: boolean) => {
      if (cancelled) return;
      const target = canvasRef.current;
      if (!target) return;
      drawCachedStrip(target, strip, renderWidth, renderHeight);
      if (isComplete) setStatus("ready");
    };

    const cancelCoarse =
      cachedCoarse || cachedRefined
        ? () => {}
        : requestTimelineThumbnail({
            sourcePreviewId,
            sourceVideoUrl: thumbnailVideoUrl,
            videoKind,
            offsetSec,
            clipStartSec,
            editedStartSec,
            editedEndSec,
            editedTimeMap,
            cutsSignature,
            width: renderWidth,
            height: renderHeight,
            quality: "coarse",
            onFrame: drawStrip,
            onError: () => {
              if (!cancelled) setStatus("error");
            },
          });

    let cancelRefined = () => {};
    const refinedTimer = window.setTimeout(() => {
      if (cancelled || cachedRefined) return;
      cancelRefined = requestTimelineThumbnail({
        sourcePreviewId,
        sourceVideoUrl: thumbnailVideoUrl,
        videoKind,
        offsetSec,
        clipStartSec,
        editedStartSec,
        editedEndSec,
        editedTimeMap,
        cutsSignature,
        width: renderWidth,
        height: renderHeight,
        quality: "refined",
        onFrame: drawStrip,
        onError: () => {
          if (!cancelled) setStatus(cachedCoarse ? "ready" : "error");
        },
      });
    }, cachedCoarse ? 60 : 180);

    return () => {
      cancelled = true;
      window.clearTimeout(refinedTimer);
      cancelCoarse();
      cancelRefined();
    };
  }, [
    clipStartSec,
    cutsSignature,
    editedEndSec,
    editedStartSec,
    editedTimeMap,
    height,
    offsetSec,
    renderHeight,
    renderWidth,
    sourcePreviewId,
    thumbnailVideoUrl,
    videoKind,
    width,
  ]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        // Literals match studio.surface / studio.subtle (canvas strip chrome).
        background:
          status === "ready"
            ? "#171B21"
            : "linear-gradient(90deg, #171B21 0%, #1B2027 45%, #14171C 100%)",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          opacity: status === "ready" ? 1 : 0.55,
          transition: "opacity 120ms ease",
        }}
      />
    </div>
  );
});

// ─── Waveform canvas ──────────────────────────────────────────────────────────

const MAX_WAVEFORM_CANVAS_WIDTH = 2400;

const WaveformCanvas = memo(function WaveformCanvas({
  utterances,
  editedTimeMap,
  duration,
  width,
  height,
  waveformPeaksUrl,
}: {
  utterances: TranscriptUtterance[];
  /** Vizard-parity Phase B step 8: pixel positions on this canvas are
   *  EDITED-timeline seconds (the ruler's own unit) — converted through the
   *  map to absolute source seconds before matching speech/word ranges, so
   *  the waveform's "loud" regions line up with the transcript even once
   *  cuts exist. Identity map (no deletions) makes this pixel-for-pixel the
   *  same computation as before ripple existed. */
  editedTimeMap: EditedTimeMap;
  duration: number;
  width: number;
  height: number;
  /** Presigned URL of the clip preview proxy's real amplitude-peaks JSON
   *  (see waveform-peaks.ts / packages/services's ClipPreviewPeaks), or
   *  null. When set, this component fetches it once (cached by URL) and
   *  paints REAL amplitude instead of the synthetic per-pixel randomness
   *  below — the fetch/parse is best-effort, so a pending fetch, a missing
   *  object (proxy still generating, silent-video preview, legacy preview
   *  cut before this feature shipped), or a malformed payload all fall
   *  back to the exact same synthetic waveform this canvas has always
   *  painted, with no visual regression. */
  waveformPeaksUrl: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWidth = Math.max(
    1,
    Math.min(MAX_WAVEFORM_CANVAS_WIDTH, Math.ceil(width)),
  );
  const timingIndex = useMemo(() => {
    const speechRanges = utterances
      .map((u) => ({ startSec: u.startSec, endSec: u.endSec }))
      .sort((a, b) => a.startSec - b.startSec);
    const wordRanges = utterances
      .flatMap((u) =>
        u.words.map((w) => ({ startSec: w.startSec, endSec: w.endSec })),
      )
      .sort((a, b) => a.startSec - b.startSec);

    return { speechRanges, wordRanges };
  }, [utterances]);

  // Stable seed for consistent random-looking waveform
  const seedRef = useRef<number[]>([]);
  if (seedRef.current.length !== canvasWidth) {
    seedRef.current = Array.from({ length: canvasWidth }, () =>
      Math.random(),
    );
  }

  // Real peaks, fetched once per URL (module-level cache — see
  // loadClipPreviewPeaks) and re-used by the paint effect below whenever
  // it's available. Seeded null so a still-loading/missing/malformed
  // response paints identically to the pre-existing synthetic-only
  // behavior.
  const [peaksData, setPeaksData] = useState<ClipPreviewPeaks | null>(null);
  useEffect(() => {
    if (!waveformPeaksUrl) {
      setPeaksData(null);
      return;
    }
    let cancelled = false;
    loadClipPreviewPeaks(waveformPeaksUrl).then((data) => {
      if (!cancelled) setPeaksData(data);
    });
    return () => {
      cancelled = true;
    };
  }, [waveformPeaksUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasWidth <= 0 || duration <= 0) return;

    canvas.width = canvasWidth;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const secPerPx = duration / canvas.width;
    const midY = canvas.height / 2;
    const seeds = seedRef.current;
    const speechRanges = timingIndex.speechRanges;
    const wordRanges = timingIndex.wordRanges;
    let speechIndex = 0;
    let wordIndex = 0;
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "rgba(160,170,190,0.7)");
    gradient.addColorStop(0.5, "rgba(130,140,160,0.5)");
    gradient.addColorStop(1, "rgba(160,170,190,0.7)");
    ctx.fillStyle = gradient;

    const hasRealPeaks = peaksData !== null && peaksData.peaks.length > 0;

    for (let px = 0; px < canvas.width; px++) {
      // px is an EDITED-timeline position; editedToSource is monotonic
      // non-decreasing (segments stay in source order), so the speechIndex/
      // wordIndex cursors below can keep advancing left-to-right exactly as
      // they did before ripple existed.
      const absoluteTime = editedToSource(editedTimeMap, px * secPerPx);

      let amplitude: number;
      if (hasRealPeaks) {
        // Real waveform: same floor as the synthetic silence baseline below
        // so a genuinely-silent stretch of real audio still reads as a
        // visible flatline rather than vanishing entirely.
        amplitude = Math.max(
          0.03,
          sampleAmplitudeAtSourceTime(peaksData!, absoluteTime),
        );
      } else {
        amplitude = 0.03;
        while (speechRanges[speechIndex] && speechRanges[speechIndex]!.endSec < absoluteTime) {
          speechIndex += 1;
        }
        while (wordRanges[wordIndex] && wordRanges[wordIndex]!.endSec < absoluteTime) {
          wordIndex += 1;
        }

        const speech = speechRanges[speechIndex];
        if (speech && absoluteTime >= speech.startSec && absoluteTime <= speech.endSec) {
          const word = wordRanges[wordIndex];
          const inWord =
            word && absoluteTime >= word.startSec && absoluteTime <= word.endSec;
          amplitude = inWord
            ? 0.35 + (seeds[px] ?? 0.5) * 0.55
            : 0.08 + (seeds[px] ?? 0.5) * 0.12;
        }
      }

      const barH = amplitude * midY;
      ctx.fillRect(px, midY - barH, 1, barH * 2);
    }
  }, [timingIndex, editedTimeMap, duration, canvasWidth, height, peaksData]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        display: "block",
      }}
    />
  );
});

// ─── Word chips (Vizard-parity Phase B step 15) ───────────────────────────────
//
// One chip per timed word, drawn on a thin row of its own. Words already
// come fully timed off `useStudio().utterances` (the transcript panel's own
// data source) — nothing new to fetch, so this stays cheap by construction.
// `words` here is the FULL projected list (word-chips.ts's
// `projectWordsToEdited`, computed once per utterances/editedTimeMap
// change); this component only ever renders the caller-windowed subset
// (`selectVisibleWordChips`), and paints the active word by direct DOM
// mutation (mirrors TrimHandle/TimelinePlayhead's imperative-paint contract
// above) so a 60fps playback-clock tick never forces a React re-render of
// every mounted chip.
const WordChipsRow = memo(function WordChipsRow({
  words,
  pxPerSec,
  height,
  editedTimeMap,
  onSeek,
}: {
  words: WordChipDatum[];
  pxPerSec: number;
  height: number;
  editedTimeMap: EditedTimeMap;
  onSeek: (t: number) => void;
}) {
  const { playbackClock } = useStudio();
  const elementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const activeIdRef = useRef<string | null>(null);

  const paintActive = useCallback((id: string | null, active: boolean) => {
    if (!id) return;
    const el = elementsRef.current.get(id);
    if (!el) return;
    el.style.borderColor = active
      ? "var(--chakra-colors-studio-accent)"
      : "var(--chakra-colors-studio-border)";
    el.style.color = active
      ? "var(--chakra-colors-studio-fg)"
      : "var(--chakra-colors-studio-fgMuted)";
  }, []);

  const updateActive = useCallback(() => {
    const editedTime = playbackClock.getSnapshot();
    const sourceTime = editedToSource(editedTimeMap, editedTime);
    const nextId = findActiveWordId(words, sourceTime);
    if (nextId === activeIdRef.current) return;
    paintActive(activeIdRef.current, false);
    paintActive(nextId, true);
    activeIdRef.current = nextId;
  }, [words, editedTimeMap, playbackClock, paintActive]);

  useEffect(() => {
    return playbackClock.subscribe(updateActive);
  }, [playbackClock, updateActive]);

  // The mounted chip set just changed (scroll/zoom swapped which words are
  // in the window) — re-run once so a freshly-mounted active chip gets its
  // paint without waiting for the next clock tick.
  useEffect(() => {
    activeIdRef.current = null;
    updateActive();
  }, [words, updateActive]);

  return (
    <>
      {words.map((chip) => {
        const left = chip.editedStartSec * pxPerSec;
        const width = Math.max(chip.editedEndSec * pxPerSec - left - 2, 6);
        return (
          <Box
            key={chip.id}
            ref={(el: HTMLDivElement | null) => {
              if (el) elementsRef.current.set(chip.id, el);
              else elementsRef.current.delete(chip.id);
            }}
            as="button"
            position="absolute"
            top="1px"
            style={{ left: `${left}px`, width: `${width}px`, height: `${height - 2}px` }}
            display="flex"
            alignItems="center"
            justifyContent="center"
            overflow="hidden"
            px="4px"
            borderRadius="l1"
            borderWidth="1px"
            borderColor="studio.border"
            bg="studio.raised"
            color="studio.fgMuted"
            fontSize="10px"
            whiteSpace="nowrap"
            textOverflow="ellipsis"
            cursor="pointer"
            title={chip.text}
            aria-label={`Word "${chip.text}" at ${formatTimecode(chip.editedStartSec)}`}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onSeek(chip.editedStartSec);
            }}
          >
            {chip.text}
          </Box>
        );
      })}
    </>
  );
});

// ─── Control button ───────────────────────────────────────────────────────────

function CtrlBtn({
  icon,
  onClick,
  label,
  active,
  title,
}: {
  icon?: React.ReactNode;
  onClick?: () => void;
  label?: string;
  active?: boolean;
  title?: string;
}) {
  return (
    <Flex
      as="button"
      align="center"
      gap="5px"
      px={label ? "8px" : "6px"}
      h="28px"
      borderRadius="l1"
      bg={active ? "studio.raised" : "transparent"}
      border="none"
      color={active ? "studio.fg" : "studio.fgMuted"}
      cursor="pointer"
      fontSize="12px"
      fontWeight="500"
      title={title ?? label}
      aria-label={title ?? label}
      onClick={onClick}
      transition="background 120ms ease, color 120ms ease"
      _hover={{ bg: "studio.raised", color: "studio.fg" }}
    >
      {icon}
      {label && <Text fontSize="11px">{label}</Text>}
    </Flex>
  );
}

// ─── Remove silence (vizard-parity.md Phase B step 12) ────────────────────────
//
// Seeded from the pause-marker UX above (same underlying signal — gaps
// between words — surfaced as an on-demand batch action instead of just an
// inline chip): a small popover recomputes `detectSilenceRanges` (pure, from
// packages/validators) on every slider move for a live "N silences · −X.Xs"
// line, with no dispatch until Apply. Apply hands the CURRENT preview's
// exact ranges to `applyRemoveSilence`, which unions them with the existing
// manual `deletedRanges` and dispatches one undoable `setDeletedRanges`.

const SILENCE_MIN_SEC_RANGE = { min: 0.3, max: 3.0, step: 0.1 };
const SILENCE_PAD_SEC_RANGE = { min: 0, max: 0.5, step: 0.05 };

function RemoveSilencePopover() {
  const { utterances, clipWindow, deletedRanges, applyRemoveSilence } = useStudio();
  const [open, setOpen] = useState(false);
  const [minSilenceSec, setMinSilenceSec] = useState(SILENCE_DEFAULT_MIN_SILENCE_SEC);
  const [padSec, setPadSec] = useState(SILENCE_DEFAULT_PAD_SEC);

  // Defaults reset per open — no persistence across sessions of the popover,
  // keeping the scope tight (design doc §2).
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      setMinSilenceSec(SILENCE_DEFAULT_MIN_SILENCE_SEC);
      setPadSec(SILENCE_DEFAULT_PAD_SEC);
    }
  }, []);

  const detected = useMemo(
    () =>
      open
        ? detectSilenceRanges(utterances, clipWindow, {
            minSilenceSec,
            padSec,
            existingDeleted: deletedRanges,
          })
        : [],
    [open, utterances, clipWindow, minSilenceSec, padSec, deletedRanges],
  );

  const totalRemovedSec = useMemo(
    () => detected.reduce((sum, r) => sum + (r.endSec - r.startSec), 0),
    [detected],
  );

  const handleApply = useCallback(() => {
    if (applyRemoveSilence(detected)) setOpen(false);
  }, [applyRemoveSilence, detected]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(e) => handleOpenChange(e.open)}
      positioning={{ placement: "top-start" }}
    >
      <Popover.Trigger asChild>
        <Box>
          <CtrlBtn icon={<AudioLines size={14} />} title="Remove silence" active={open} />
        </Box>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content layerStyle="panel" boxShadow="cardHover" minW="260px" p="3">
            <Stack gap="3">
              <Text textStyle="eyebrow" color="fg.subtle">
                Remove silence
              </Text>

              <Stack gap="1.5">
                <Flex justify="space-between" align="baseline">
                  <Text fontSize="12px" color="fg.muted">
                    Min silence
                  </Text>
                  <Text fontSize="12px" fontFamily="mono" color="fg.timecode">
                    {minSilenceSec.toFixed(1)}s
                  </Text>
                </Flex>
                <Slider.Root
                  value={[minSilenceSec]}
                  min={SILENCE_MIN_SEC_RANGE.min}
                  max={SILENCE_MIN_SEC_RANGE.max}
                  step={SILENCE_MIN_SEC_RANGE.step}
                  onValueChange={(e) => setMinSilenceSec(e.value[0]!)}
                  size="sm"
                  colorPalette="accent"
                >
                  <Slider.Control>
                    <Slider.Track>
                      <Slider.Range />
                    </Slider.Track>
                    <Slider.Thumbs />
                  </Slider.Control>
                </Slider.Root>
              </Stack>

              <Stack gap="1.5">
                <Flex justify="space-between" align="baseline">
                  <Text fontSize="12px" color="fg.muted">
                    Keep padding
                  </Text>
                  <Text fontSize="12px" fontFamily="mono" color="fg.timecode">
                    {padSec.toFixed(2)}s
                  </Text>
                </Flex>
                <Slider.Root
                  value={[padSec]}
                  min={SILENCE_PAD_SEC_RANGE.min}
                  max={SILENCE_PAD_SEC_RANGE.max}
                  step={SILENCE_PAD_SEC_RANGE.step}
                  onValueChange={(e) => setPadSec(e.value[0]!)}
                  size="sm"
                  colorPalette="accent"
                >
                  <Slider.Control>
                    <Slider.Track>
                      <Slider.Range />
                    </Slider.Track>
                    <Slider.Thumbs />
                  </Slider.Control>
                </Slider.Root>
              </Stack>

              <Text fontSize="12px" color="fg.muted">
                {detected.length === 0
                  ? `No silences ≥ ${minSilenceSec.toFixed(1)}s`
                  : `${detected.length} silence${detected.length === 1 ? "" : "s"} · −${totalRemovedSec.toFixed(1)}s`}
              </Text>

              <Button
                size="sm"
                variant="outline"
                colorPalette="accent"
                disabled={detected.length === 0}
                onClick={handleApply}
              >
                Apply
              </Button>
            </Stack>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

const TRACK_HEIGHT = 64;
const WORD_CHIPS_HEIGHT = 20;
const WAVEFORM_HEIGHT = 36;
const RULER_HEIGHT = 24;
const LEFT_GUTTER = 40;
const TIMELINE_OVERSCAN_PX = 900;
const PAUSE_MARKER_THRESHOLD_SEC = 0.4;
const TEXT_TRACK_HEIGHT = 26;
// Not schema-enforced — a UI-level floor (matches text-panel.tsx's own
// TextLayerDetail timing fields) so a chip drag/edge-retime can't collapse a
// layer to an unusably thin sliver.
const MIN_TEXT_LAYER_DURATION_SEC = 0.5;

function useTimelineViewport(ref: RefObject<HTMLDivElement | null>) {
  const [viewport, setViewport] = useState({ scrollLeft: 0, clientWidth: 0 });
  const frameRef = useRef(0);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    setViewport((prev) => {
      if (prev.scrollLeft === el.scrollLeft && prev.clientWidth === el.clientWidth) {
        return prev;
      }
      return { scrollLeft: el.scrollLeft, clientWidth: el.clientWidth };
    });
  }, [ref]);

  const onScroll = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      observer.disconnect();
    };
  }, [measure, ref]);

  return { viewport, onScroll };
}

const TimelineSegmentBlock = memo(function TimelineSegmentBlock({
  id,
  label,
  editedStartSec,
  editedEndSec,
  isSelected,
  pxPerSec,
  thumbnailVideoUrl,
  videoKind,
  offsetSec,
  sourcePreviewId,
  clipStartSec,
  editedTimeMap,
  cutsSignature,
  setSelectedSegmentId,
}: {
  id: string;
  label: string;
  /** Where the block is DRAWN — edited-timeline seconds (post Vizard-parity
   *  Phase B step 8's "collapsed" convention: a deleted span never occupies
   *  ruler width, so this is always continuous with neighboring segments).
   *  Fix 6 (Phase B hardening): also now where the thumbnail strip SAMPLES
   *  from — walked through `editedTimeMap` to real source seconds — instead
   *  of the segment's raw uncut source span, which a straddling cut could
   *  make wider than what's actually drawn/kept. */
  editedStartSec: number;
  editedEndSec: number;
  isSelected: boolean;
  pxPerSec: number;
  thumbnailVideoUrl: string | null;
  videoKind: ThumbnailVideoKind;
  offsetSec: number;
  sourcePreviewId: string;
  clipStartSec: number;
  editedTimeMap: EditedTimeMap;
  cutsSignature: string;
  setSelectedSegmentId: (id: string | null) => void;
}) {
  const x = editedStartSec * pxPerSec;
  const w = (editedEndSec - editedStartSec) * pxPerSec;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedSegmentId(isSelected ? null : id);
    },
    [id, isSelected, setSelectedSegmentId],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedSegmentId(isSelected ? null : id);
    },
    [id, isSelected, setSelectedSegmentId],
  );

  return (
    <Box
      position="absolute"
      style={{ left: `${x}px`, width: `${Math.max(w - 1, 4)}px` }}
      top="0"
      bottom="0"
      borderRadius="l1"
      overflow="hidden"
      border="1.5px solid"
      borderColor={isSelected ? "studio.accent" : "studio.border"}
      bg="studio.surface"
      cursor="pointer"
      transition="border-color 120ms"
      _hover={{
        borderColor: isSelected ? "studio.accentFg" : "studio.borderStrong",
      }}
      _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "1px" }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`Segment "${label}", ${formatTimecode(editedStartSec)} to ${formatTimecode(editedEndSec)}`}
      contain="layout paint"
    >
      <SegmentThumbnails
        thumbnailVideoUrl={thumbnailVideoUrl}
        videoKind={videoKind}
        offsetSec={offsetSec}
        sourcePreviewId={sourcePreviewId}
        clipStartSec={clipStartSec}
        editedStartSec={editedStartSec}
        editedEndSec={editedEndSec}
        editedTimeMap={editedTimeMap}
        cutsSignature={cutsSignature}
        width={Math.max(w - 3, 4)}
        height={TRACK_HEIGHT - 3}
      />

      {/* Utterance label — first words of the segment's speech */}
      <Flex
        position="absolute"
        top="3px"
        left="4px"
        maxW="calc(100% - 8px)"
        px="5px"
        h="16px"
        align="center"
        borderRadius="3px"
        bg="rgba(0,0,0,0.6)"
        backdropFilter="blur(4px)"
      >
        <Text
          fontSize="10px"
          fontWeight="600"
          color={isSelected ? "studio.accentFg" : "studio.fgMuted"}
          letterSpacing="0.02em"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
        >
          {label}
        </Text>
      </Flex>
    </Box>
  );
});

// ─── Cut marker (Vizard-parity Phase B step 9) ────────────────────────────────
//
// The "collapsed + cut markers" decision (see report): a deleted span never
// occupies width on the edited-timeline ruler — it collapses to a single
// point where the kept content before and after it now meet. This is the
// ONLY on-timeline trace of a deletion, and it doubles as the Revert
// affordance Vizard's recoverable-delete model relies on. A click reverts
// immediately (single, obviously-reversible action; the delete itself is
// already one click behind Backspace and lives on the undo stack too, so
// there's no destructive-action asymmetry to guard against here).
const CutMarkerBlock = memo(function CutMarkerBlock({
  marker,
  x,
  onRevert,
}: {
  marker: CutMarker;
  x: number;
  onRevert: (range: SourceRange) => void;
}) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onRevert(marker.range);
    },
    [marker.range, onRevert],
  );

  return (
    <Flex
      as="button"
      position="absolute"
      top="0"
      bottom="0"
      style={{ left: `${x}px`, transform: "translateX(-50%)" }}
      w="16px"
      align="center"
      justify="center"
      border="none"
      bg="transparent"
      cursor="pointer"
      zIndex={8}
      title={`${marker.durationSec.toFixed(1)}s cut — click to revert`}
      aria-label={`${marker.durationSec.toFixed(1)} second cut — click to revert`}
      onClick={handleClick}
      role="group"
    >
      <Box
        w="2px"
        h="100%"
        bg="studio.dangerBorder"
        borderRadius="full"
        transition="width 120ms ease, background 120ms ease"
        _groupHover={{ w: "3px", bg: "studio.danger" }}
      />
      <Flex
        position="absolute"
        top="2px"
        align="center"
        justify="center"
        w="16px"
        h="16px"
        borderRadius="full"
        bg="studio.danger"
        // Fix 11: white-on-studio.danger (#F26D6D) is only ~2.9:1 — below
        // the WCAG 1.4.11 3:1 floor for a graphical glyph, and off-token
        // besides (studio chrome never leaves graphite; see the theme's
        // own doc comment on studio.danger). studio.canvas is dark enough
        // against this coral to clear the floor comfortably while staying
        // inside the studio.* palette.
        color="studio.canvas"
        opacity={0}
        transition="opacity 120ms ease"
        _groupHover={{ opacity: 1 }}
        pointerEvents="none"
      >
        <Undo2 size={9} strokeWidth={2.5} />
      </Flex>
    </Flex>
  );
});

const TimelineTimecode = memo(function TimelineTimecode({
  duration,
}: {
  duration: number;
}) {
  const { playbackClock } = useStudio();
  const currentTime = usePlaybackTime(playbackClock);
  const safeCurrentTime = Math.min(duration, Math.max(0, currentTime));

  return (
    <Text
      textStyle="data"
      fontSize="12px"
      color="studio.timecode"
      ml="2"
      whiteSpace="nowrap"
    >
      {formatTimecode(safeCurrentTime)}
      <Box as="span" color="studio.fgSubtle" mx="6px">
        /
      </Box>
      <Box as="span" color="studio.fgMuted">
        {formatTimecode(duration)}
      </Box>
    </Text>
  );
});

const TimelinePlayhead = memo(function TimelinePlayhead({
  duration,
  isPlaying,
  timeToX,
  scrollRootRef,
}: {
  duration: number;
  isPlaying: boolean;
  timeToX: (time: number) => number;
  scrollRootRef: RefObject<HTMLDivElement | null>;
}) {
  const { playbackClock } = useStudio();
  const playheadRef = useRef<HTMLDivElement>(null);
  const lastAutoScrollAtRef = useRef(0);

  const updatePlayhead = useCallback(() => {
    const el = playheadRef.current;
    const currentTime = Math.min(duration, Math.max(0, playbackClock.getSnapshot()));
    const playheadX = timeToX(currentTime);

    if (el) {
      el.style.transform = `translate3d(${playheadX}px, 0, 0)`;
    }

    const scrollRoot = scrollRootRef.current;
    if (!scrollRoot || !isPlaying) return;

    const now = performance.now();
    if (now - lastAutoScrollAtRef.current < 250) return;

    const { scrollLeft, clientWidth } = scrollRoot;
    if (
      playheadX < scrollLeft + 60 ||
      playheadX > scrollLeft + clientWidth - 60
    ) {
      scrollRoot.scrollLeft = playheadX - clientWidth / 2;
      lastAutoScrollAtRef.current = now;
    }
  }, [duration, isPlaying, playbackClock, scrollRootRef, timeToX]);

  useEffect(() => {
    updatePlayhead();
    return playbackClock.subscribe(updatePlayhead);
  }, [playbackClock, updatePlayhead]);

  return (
    <Box
      ref={playheadRef}
      position="absolute"
      top="0"
      bottom="0"
      w="1.5px"
      bg="studio.fg"
      style={{
        left: 0,
        transform: `translate3d(${timeToX(Math.min(duration, Math.max(0, playbackClock.getSnapshot())))}px, 0, 0)`,
        pointerEvents: "none",
        willChange: "transform",
      }}
      zIndex={10}
    >
      <Box
        position="absolute"
        top="0"
        left="50%"
        transform="translateX(-50%)"
        w="0"
        h="0"
        style={{
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: "7px solid var(--chakra-colors-studio-fg)",
        }}
      />
      <Box
        position="absolute"
        bottom="-1px"
        left="50%"
        transform="translateX(-50%)"
        w="5px"
        h="5px"
        borderRadius="full"
        bg="studio.fg"
      />
    </Box>
  );
});

// ─── Trim handles (vizard-parity.md Phase B step 13, in-studio trim) ─────────
//
// Draggable edge grips at the far left/right of the track area. Dragging
// moves the clip's own [clipStartSec, clipEndSec) window in absolute SOURCE
// seconds — NOT a position on the edited-timeline ruler, which always starts
// at edited-time 0 by definition (the window's own start), so there's no
// pixel space "before" it to drag into. Instead this reads raw POINTER pixel
// delta (independent of where edited-time-0 happens to be drawn) and applies
// it directly to the grabbed boundary: dragging the start handle left
// (negative delta) decreases clipStartSec (extends earlier); dragging the
// end handle right (positive delta) increases clipEndSec (extends later).
//
// PERFORMANCE CONTRACT (matches the legacy trim dialog's own drag): the
// candidate boundary and its floating delta label are painted IMPERATIVELY
// via direct DOM mutation on every pointermove — no React state, no segment
// rebuild — because a full re-render (let alone a segment rebuild) per
// mousemove is exactly what this file's constraints forbid. React state
// updates only once, on commit (pointerup), via `commitTrim`.
const TRIM_COMMIT_EPSILON_SEC = 0.05;

function formatTrimDelta(deltaSec: number): string {
  if (Math.abs(deltaSec) < 0.05) return "0.0s";
  const sign = deltaSec > 0 ? "+" : "−";
  return `${sign}${Math.abs(deltaSec).toFixed(1)}s`;
}

interface TrimDragState {
  startClientX: number;
  grabStartSec: number;
  grabEndSec: number;
  /** Live candidate for the side being dragged — the OTHER bound stays at
   *  its grab value. Updated on every pointermove, read once on pointerup. */
  candidateSec: number;
}

const TrimHandle = memo(function TrimHandle({
  side,
  anchorPx,
  pxPerSec,
  trackHeight,
}: {
  side: "start" | "end";
  /** The handle's fixed anchor in track-area-local pixels — `LEFT_GUTTER`
   *  for the start handle (edited-time 0), `LEFT_GUTTER + totalWidth` for
   *  the end handle (edited-time `duration`). The grip itself is centered
   *  on this via `translateX(-50%)` and never moves during a drag (see the
   *  module doc comment above) — only the floating delta label slides. */
  anchorPx: number;
  pxPerSec: number;
  trackHeight: number;
}) {
  const { clipInfo, clipStartSec, clipEndSec, commitTrim, trimHandlesDisabled } = useStudio();

  const dragRef = useRef<TrimDragState | null>(null);
  const transcriptRef = useRef<TrimTranscript | null>(null);
  const gripRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  // Warm the full-project transcript on grab (not on hover/mount) — a trim
  // handle is grabbed far less often than the legacy dialog is opened, and
  // fetching ~1-2MB of transcript for every studio session regardless of
  // whether trim is ever used would be wasteful. Session-cached (see
  // trim-transcript-cache.ts), so a second grab in the same tab is instant.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (trimHandlesDisabled) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // non-capturable pointer; bubbling still delivers move/up
      }

      prefetchTrimTranscript(clipInfo.projectId);
      loadTrimTranscript(clipInfo.projectId)
        .then((t) => {
          transcriptRef.current = t;
        })
        .catch(() => {
          // No transcript available — dragging still works, just unsnapped;
          // the min-duration/zero clamps below still apply regardless.
        });

      dragRef.current = {
        startClientX: e.clientX,
        grabStartSec: clipStartSec,
        grabEndSec: clipEndSec,
        candidateSec: side === "start" ? clipStartSec : clipEndSec,
      };
      gripRef.current?.classList.add("trimming");
      if (labelRef.current) labelRef.current.style.opacity = "1";
    },
    [trimHandlesDisabled, clipInfo.projectId, clipStartSec, clipEndSec, side],
  );

  const paintDrag = useCallback((dxPx: number, drag: TrimDragState) => {
    if (labelRef.current) {
      const deltaSec = drag.candidateSec - (side === "start" ? drag.grabStartSec : drag.grabEndSec);
      labelRef.current.textContent = formatTrimDelta(deltaSec);
      labelRef.current.style.transform = `translate3d(${dxPx}px, 0, 0)`;
    }
  }, [side]);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dxPx = e.clientX - drag.startClientX;
      const deltaSec = dxPx / pxPerSec;
      const transcript = transcriptRef.current;
      const sourceCeilingSec = transcript ? transcript.sourceDurationSec : Number.POSITIVE_INFINITY;

      if (side === "start") {
        // Finding 3 (Phase B closing review): the server now rejects a
        // boundary save whose duration exceeds CLIP_MAX_DURATION_SEC
        // (packages/validators/src/clip.ts) the same way it already rejects
        // one under CLIP_MIN_DURATION_SEC — the handle must refuse to drag
        // past it too, mirroring CLIP_MIN_DURATION_SEC's existing clamp
        // right below.
        const minStartForMaxDurationSec = drag.grabEndSec - CLIP_MAX_DURATION_SEC;
        let candidate = drag.grabStartSec + deltaSec;
        candidate = Math.max(
          0,
          minStartForMaxDurationSec,
          Math.min(candidate, drag.grabEndSec - CLIP_MIN_DURATION_SEC),
        );
        if (transcript) {
          candidate = nearestWordBoundary(transcript.words, candidate, "start");
          candidate = Math.max(
            0,
            minStartForMaxDurationSec,
            Math.min(candidate, drag.grabEndSec - CLIP_MIN_DURATION_SEC),
          );
        }
        drag.candidateSec = candidate;
      } else {
        const maxEndForMaxDurationSec = drag.grabStartSec + CLIP_MAX_DURATION_SEC;
        let candidate = drag.grabEndSec + deltaSec;
        candidate = Math.min(
          sourceCeilingSec,
          maxEndForMaxDurationSec,
          Math.max(candidate, drag.grabStartSec + CLIP_MIN_DURATION_SEC),
        );
        if (transcript) {
          candidate = nearestWordBoundary(transcript.words, candidate, "end");
          candidate = Math.min(
            sourceCeilingSec,
            maxEndForMaxDurationSec,
            Math.max(candidate, drag.grabStartSec + CLIP_MIN_DURATION_SEC),
          );
        }
        drag.candidateSec = candidate;
      }

      paintDrag(dxPx, drag);
    },
    [pxPerSec, side, paintDrag],
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    gripRef.current?.classList.remove("trimming");
    if (labelRef.current) {
      labelRef.current.style.opacity = "0";
      labelRef.current.style.transform = "translate3d(0, 0, 0)";
    }
    if (!drag) return;

    const newStartSec = side === "start" ? drag.candidateSec : drag.grabStartSec;
    const newEndSec = side === "end" ? drag.candidateSec : drag.grabEndSec;
    const changed =
      Math.abs(newStartSec - drag.grabStartSec) > TRIM_COMMIT_EPSILON_SEC / 2 ||
      Math.abs(newEndSec - drag.grabEndSec) > TRIM_COMMIT_EPSILON_SEC / 2;
    if (!changed) return;
    // Finding 6 (Phase B closing review): commitTrim awaits the full-project
    // transcript fetch before dispatching — a rejection there (offline, a
    // transient network error) used to be an unhandled promise rejection
    // that silently dropped the trim with no feedback and no re-enabled
    // handles. `trimHandlesDisabled` only reflects an in-flight AUTOSAVE, not
    // this fetch, so nothing else surfaces the failure either.
    commitTrim(newStartSec, newEndSec).catch(() => {
      toaster.create({
        type: "error",
        title: "Trim failed",
        description: "Couldn't load the transcript for this trim. Try again.",
      });
    });
  }, [side, commitTrim]);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
      endDrag();
    },
    [endDrag],
  );

  const handlePointerCancel = useCallback(() => {
    endDrag();
  }, [endDrag]);

  return (
    <Box
      ref={gripRef}
      position="absolute"
      top="0"
      style={{
        left: `${anchorPx}px`,
        transform: "translateX(-50%)",
        height: `${trackHeight}px`,
        width: "10px",
        cursor: trimHandlesDisabled ? "default" : "col-resize",
        opacity: trimHandlesDisabled ? 0.4 : 1,
        touchAction: "none",
      }}
      zIndex={15}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      css={{
        "&.trimming": { "& > .trim-grip-stripe": { background: "var(--chakra-colors-accent-solid)" } },
      }}
    >
      <Box
        className="trim-grip-stripe"
        position="absolute"
        top="0"
        bottom="0"
        left="50%"
        transform="translateX(-50%)"
        w="3px"
        borderRadius="full"
        bg="studio.borderStrong"
        transition="background 100ms ease"
      />
      <Box
        ref={labelRef}
        position="absolute"
        top="-22px"
        left="50%"
        style={{ transform: "translate3d(0, 0, 0)", opacity: 0 }}
        transformOrigin="center"
        whiteSpace="nowrap"
        px="6px"
        py="2px"
        borderRadius="l1"
        bg="studio.raised"
        borderWidth="1px"
        borderColor="studio.borderStrong"
        textStyle="data"
        fontSize="10px"
        color="fg.timecode"
        pointerEvents="none"
        willChange="transform"
        css={{ marginLeft: "-16px" }}
      >
        0.0s
      </Box>
    </Box>
  );
});

// ─── Text overlay track (Vizard-parity Phase C step 1) ────────────────────
//
// One chip per `studioEdits.textLayers` entry, positioned/sized by
// startSec/endSec on the EDITED timeline (same convention the video/
// waveform tracks already draw in — see the module doc comment on
// StudioContextValue.editedTimeMap — so no source<->edited mapping is
// needed here). A plain React-state drag (not TrimHandle's imperative paint)
// is fine here: a handful of small chips, not a filmstrip.
interface TextLayerDragState {
  startClientX: number;
  grabStartSec: number;
  grabEndSec: number | null;
  mode: "move" | "resize-start" | "resize-end";
  moved: boolean;
}

const TextLayerChip = memo(function TextLayerChip({
  id,
  text,
  startSec,
  endSec,
  isSelected,
  pxPerSec,
  duration,
}: {
  id: string;
  text: string;
  startSec: number;
  endSec: number | null;
  isSelected: boolean;
  pxPerSec: number;
  duration: number;
}) {
  const { setStudioEdits, endCoalesce, selectTextLayer, seekTo } = useStudio();
  const dragRef = useRef<TextLayerDragState | null>(null);

  const x = startSec * pxPerSec;
  const w = Math.max(((endSec ?? duration) - startSec) * pxPerSec, 10);

  const patch = useCallback(
    (fields: { startSec?: number; endSec?: number | null }) => {
      setStudioEdits((prev) => ({
        ...prev,
        textLayers: prev.textLayers.map((l) => (l.id === id ? { ...l, ...fields } : l)),
      }), `text-layer-retime-${id}`);
    },
    [id, setStudioEdits],
  );

  const handlePointerDown = useCallback(
    (mode: TextLayerDragState["mode"]) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // non-capturable pointer; bubbling still delivers move/up
      }
      dragRef.current = {
        startClientX: e.clientX,
        grabStartSec: startSec,
        grabEndSec: endSec,
        mode,
        moved: false,
      };
      selectTextLayer(id);
    },
    [id, startSec, endSec, selectTextLayer],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (e.buttons === 0) {
        // Belt-and-braces: a pointerup/pointercancel we somehow missed
        // shouldn't leave the drag stuck open — bail and close the
        // coalesce chain the same way a cancel would.
        dragRef.current = null;
        endCoalesce();
        return;
      }
      const dxPx = e.clientX - drag.startClientX;
      if (Math.abs(dxPx) > 3) drag.moved = true;
      const deltaSec = dxPx / pxPerSec;
      const grabEndOrDuration = drag.grabEndSec ?? duration;

      if (drag.mode === "move") {
        if (drag.grabEndSec == null) {
          const newStart = Math.max(0, Math.min(drag.grabStartSec + deltaSec, duration));
          patch({ startSec: newStart });
        } else {
          const layerDur = drag.grabEndSec - drag.grabStartSec;
          const newStart = Math.max(0, Math.min(drag.grabStartSec + deltaSec, duration - layerDur));
          patch({ startSec: newStart, endSec: newStart + layerDur });
        }
      } else if (drag.mode === "resize-start") {
        const newStart = Math.max(
          0,
          Math.min(drag.grabStartSec + deltaSec, grabEndOrDuration - MIN_TEXT_LAYER_DURATION_SEC),
        );
        patch({ startSec: newStart });
      } else {
        const newEnd = Math.max(
          drag.grabStartSec + MIN_TEXT_LAYER_DURATION_SEC,
          Math.min(grabEndOrDuration + deltaSec, duration),
        );
        patch({ endSec: newEnd });
      }
    },
    [pxPerSec, duration, patch],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag && !drag.moved) {
        selectTextLayer(id);
        seekTo(startSec);
      }
      if (drag) endCoalesce();
    },
    [id, startSec, selectTextLayer, seekTo, endCoalesce],
  );

  // Mirrors TrimHandle's onPointerCancel: without it, a canceled pointer
  // (e.g. the OS interrupts the gesture) leaves dragRef set and the
  // per-layer coalesce chain open — the next drag would merge into the
  // stale undo frame, and a stray hover/move could resume a "dead" drag.
  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag) endCoalesce();
    },
    [endCoalesce],
  );

  return (
    <Box
      position="absolute"
      top="0"
      style={{ left: `${x}px`, width: `${w}px`, touchAction: "none" }}
      h={`${TEXT_TRACK_HEIGHT}px`}
      borderRadius="l1"
      border="1.5px solid"
      borderColor={isSelected ? "studio.accent" : "studio.border"}
      bg="studio.surface"
      cursor="grab"
      overflow="hidden"
      onPointerDown={handlePointerDown("move")}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      transition="border-color 120ms"
      _hover={{ borderColor: isSelected ? "studio.accentFg" : "studio.borderStrong" }}
    >
      <Text
        fontSize="10px"
        fontWeight="600"
        color={isSelected ? "studio.accentFg" : "studio.fgMuted"}
        px="6px"
        lineHeight={`${TEXT_TRACK_HEIGHT}px`}
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
        userSelect="none"
      >
        {text}
      </Text>

      {/* Edge grips — retime start/end independently, same pattern as the
          clip-level TrimHandle above (pointer capture + delta drag). */}
      <Box
        position="absolute"
        top="0"
        bottom="0"
        left="0"
        w="6px"
        cursor="ew-resize"
        style={{ touchAction: "none" }}
        onPointerDown={handlePointerDown("resize-start")}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      />
      <Box
        position="absolute"
        top="0"
        bottom="0"
        right="0"
        w="6px"
        cursor="ew-resize"
        style={{ touchAction: "none" }}
        onPointerDown={handlePointerDown("resize-end")}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      />
    </Box>
  );
});

export function Timeline() {
  const {
    isPlaying,
    togglePlay,
    duration,
    seekTo,
    showTimeline,
    setShowTimeline,
    timelineZoom,
    setTimelineZoom,
    segments,
    selectedSegmentId,
    setSelectedSegmentId,
    splitAtPlayhead,
    deleteSelectedSegment,
    activeVideoUrl,
    activeOffsetSec,
    activeVideoKind,
    sourcePreviewId,
    clipStartSec,
    editedTimeMap,
    deletedRanges,
    revertDeletedRange,
    utterances,
    exportState,
    waveformPeaksUrl,
    studioEdits,
    selectedTextLayerId,
  } = useStudio();

  const stripRef = useRef<HTMLDivElement>(null);
  const { viewport, onScroll } = useTimelineViewport(stripRef);

  const safeDuration = Math.max(0, duration);
  const TIMELINE_PX_PER_SEC = 80 * timelineZoom;
  const totalWidth = safeDuration * TIMELINE_PX_PER_SEC;

  useEffect(() => {
    setTimelineThumbnailPlaybackActive(isPlaying);
    return () => setTimelineThumbnailPlaybackActive(false);
  }, [isPlaying]);

  // Ruler ticks — adaptive intervals
  const tickInterval = useMemo(() => {
    if (timelineZoom < 0.7) return 10;
    if (timelineZoom < 1.5) return 5;
    if (timelineZoom < 3) return 2;
    return 1;
  }, [timelineZoom]);

  const subTickCount = tickInterval >= 5 ? 5 : 2;

  const ticks = useMemo(() => {
    const result: { time: number; major: boolean }[] = [];
    const subInterval = tickInterval / subTickCount;
    for (let t = 0; t <= safeDuration + 0.01; t += subInterval) {
      const rounded = Math.round(t * 100) / 100;
      const isMajor = Math.abs(rounded % tickInterval) < 0.01;
      result.push({ time: rounded, major: isMajor });
    }
    return result;
  }, [safeDuration, tickInterval, subTickCount]);

  const visibleRange = useMemo(() => {
    const startX = Math.max(0, viewport.scrollLeft - TIMELINE_OVERSCAN_PX);
    const endX =
      viewport.scrollLeft + Math.max(1, viewport.clientWidth) + TIMELINE_OVERSCAN_PX;

    return {
      startSec: Math.max(0, (startX - LEFT_GUTTER) / TIMELINE_PX_PER_SEC),
      endSec: Math.min(
        safeDuration,
        Math.max(0, (endX - LEFT_GUTTER) / TIMELINE_PX_PER_SEC),
      ),
    };
  }, [TIMELINE_PX_PER_SEC, safeDuration, viewport.clientWidth, viewport.scrollLeft]);

  const visibleTicks = useMemo(
    () =>
      ticks.filter(
        ({ time }) =>
          time >= visibleRange.startSec - tickInterval &&
          time <= visibleRange.endSec + tickInterval,
      ),
    [ticks, visibleRange.endSec, visibleRange.startSec, tickInterval],
  );

  // Vizard-parity Phase B step 9: `segments` is still stored source-
  // relative-to-`clipStartSec` (split stays client-only — see
  // studio-shell.tsx's `splitAtPlayhead`/`deleteSelectedSegment`); this
  // projects each one onto the edited timeline for DRAWING. A segment
  // that's been fully deleted (`deleteSelectedSegment` dispatches
  // `deleteRange` but never removes it from `segments` — see that
  // function's doc comment) projects to null here and simply stops being
  // drawn, with no separate "segments" undo step needed to make it
  // reappear on Revert.
  const projectedSegments = useMemo(() => {
    return segments.flatMap((seg) => {
      const edited = projectSegmentToEdited(seg, clipStartSec, editedTimeMap);
      if (!edited) return [];
      return [{
        id: seg.id,
        label: seg.label,
        editedStartSec: edited.startSec,
        editedEndSec: edited.endSec,
      }];
    });
  }, [segments, clipStartSec, editedTimeMap]);

  const visibleSegments = useMemo(
    () =>
      projectedSegments.filter(
        (seg) =>
          seg.editedEndSec >= visibleRange.startSec &&
          seg.editedStartSec <= visibleRange.endSec,
      ),
    [projectedSegments, visibleRange.endSec, visibleRange.startSec],
  );

  // Fix 6 (Phase B hardening): a compact signature of the current cut
  // layout, folded into the thumbnail cache key (timeline-preview-manager.ts)
  // so a strip captured under one set of deletedRanges is never handed back
  // once the cuts change — even in the (rare) case where a block's own
  // editedStartSec/editedEndSec happen not to move.
  const cutsSignature = useMemo(() => JSON.stringify(deletedRanges), [deletedRanges]);

  // One collapsed marker per deleted range (the "collapsed + cut markers"
  // timeline convention — see the Phase B step 9 report for why deleted
  // spans never occupy ruler width). Each marker's own click reverts it.
  const cutMarkers = useMemo(
    () => deletedRangesToCutMarkers(deletedRanges, editedTimeMap),
    [deletedRanges, editedTimeMap],
  );

  const visibleCutMarkers = useMemo(
    () =>
      cutMarkers.filter(
        (marker) =>
          marker.editedSec >= visibleRange.startSec - 0.5 &&
          marker.editedSec <= visibleRange.endSec + 0.5,
      ),
    [cutMarkers, visibleRange.endSec, visibleRange.startSec],
  );

  const visiblePauseMarkers = useMemo(() => {
    const markers: { id: string; startSec: number; endSec: number; duration: number }[] = [];

    for (let i = 0; i < utterances.length - 1; i++) {
      const current = utterances[i]!;
      const next = utterances[i + 1]!;
      const gap = next.startSec - current.endSec;

      if (gap < PAUSE_MARKER_THRESHOLD_SEC) continue;

      // A pause that now sits (partly or wholly) inside a cut collapses or
      // shrinks with it — sourceRangeToEdited returns null when the whole
      // gap was deleted, in which case there's nothing left to mark.
      const edited = sourceRangeToEdited(editedTimeMap, {
        startSec: current.endSec,
        endSec: next.startSec,
      });
      if (!edited) continue;

      const startSec = Math.max(0, edited.startSec);
      const endSec = Math.min(safeDuration, edited.endSec);

      if (endSec <= visibleRange.startSec || startSec >= visibleRange.endSec) {
        continue;
      }

      markers.push({
        id: `pause-${i}`,
        startSec,
        endSec,
        // Fix 10: the LABEL must match what's actually drawn (the edited/
        // projected width, `endSec - startSec`) rather than the raw source
        // `gap` — if a cut has eaten part of this pause, the marker's own
        // width already shrank to reflect that, but the label used to keep
        // quoting the pre-cut duration.
        duration: endSec - startSec,
      });
    }

    return markers;
  }, [editedTimeMap, safeDuration, utterances, visibleRange.endSec, visibleRange.startSec]);

  // Vizard-parity Phase B step 15: word chips. `allWordChips` projects every
  // timed word once per utterances/editedTimeMap change (cheap — the words
  // are already loaded); `showWordChips` is the legibility gate (avg
  // px-per-word >= WORD_CHIP_MIN_PX_PER_WORD); `visibleWordChips` re-windows
  // on every scroll/zoom tick via a binary search, not a full re-derive.
  const allWordChips = useMemo(
    () => projectWordsToEdited(utterances, editedTimeMap),
    [utterances, editedTimeMap],
  );

  const avgWordDurationSec = useMemo(() => averageWordDurationSec(utterances), [utterances]);

  const showWordChips = shouldRenderWordChips(
    pxPerWordForZoom(timelineZoom, avgWordDurationSec),
  );

  const visibleWordChips = useMemo(
    () => (showWordChips ? selectVisibleWordChips(allWordChips, visibleRange) : []),
    [showWordChips, allWordChips, visibleRange],
  );

  const handleFitToWord = useCallback(() => {
    setTimelineZoom(zoomForFitToWord(utterances));
  }, [setTimelineZoom, utterances]);

  const handleFitToSentence = useCallback(() => {
    setTimelineZoom(zoomForFitToSentence(utterances));
  }, [setTimelineZoom, utterances]);

  const timeToX = useCallback(
    (t: number) => LEFT_GUTTER + t * TIMELINE_PX_PER_SEC,
    [TIMELINE_PX_PER_SEC],
  );

  const xToTime = useCallback(
    (x: number) => (x - LEFT_GUTTER) / TIMELINE_PX_PER_SEC,
    [TIMELINE_PX_PER_SEC],
  );

  const handleStripClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left + (stripRef.current?.scrollLeft ?? 0);
      const t = xToTime(x);
      if (t >= 0 && t <= safeDuration) seekTo(t);
    },
    [seekTo, xToTime, safeDuration],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      setTimelineZoom((prev: number) =>
        Math.max(0.5, Math.min(4, prev + delta)),
      );
    },
    [setTimelineZoom],
  );

  const hasTextLayers = studioEdits.textLayers.length > 0;
  const textTrackTop =
    RULER_HEIGHT + TRACK_HEIGHT + 4 + WORD_CHIPS_HEIGHT + 4 + WAVEFORM_HEIGHT + 6;
  const trackAreaHeight =
    RULER_HEIGHT + TRACK_HEIGHT + 4 + WORD_CHIPS_HEIGHT + 4 + WAVEFORM_HEIGHT + 8 +
    (hasTextLayers ? TEXT_TRACK_HEIGHT + 6 : 0);

  return (
    <Box
      flexShrink={0}
      bg="studio.canvas"
      borderTopWidth="1px"
      borderColor="studio.border"
      style={{ height: showTimeline ? `${40 + trackAreaHeight}px` : "40px" }}
      transition="height 200ms ease"
      overflow="hidden"
      position="relative"
    >
      {/* Render-in-flight — 3px indeterminate meter along the top edge */}
      {exportState !== "idle" && (
        <Box
          position="absolute"
          top="0"
          left="0"
          right="0"
          h="3px"
          overflow="hidden"
          zIndex={20}
          role="progressbar"
          aria-label="Queueing render"
        >
          <Box
            h="full"
            backgroundImage="linear-gradient(90deg, transparent 20%, {colors.studio.accent} 50%, transparent 80%)"
            backgroundSize="200% 100%"
            animation="shimmer"
          />
        </Box>
      )}

      {/* ── Control bar ───────────────────────────────────────────────── */}
      <Flex
        h="40px"
        align="center"
        px="3"
        borderBottomWidth="1px"
        borderColor="studio.border"
        flexShrink={0}
        gap="2px"
      >
        {/* Left group */}
        <Flex align="center" gap="2px" flex="1">
          <CtrlBtn
            icon={showTimeline ? <Eye size={14} /> : <EyeOff size={14} />}
            onClick={() => setShowTimeline(!showTimeline)}
            label="Hide timeline"
          />
          <Box w="1px" h="16px" bg="studio.border" mx="1" />
          <CtrlBtn
            icon={<Scissors size={14} />}
            onClick={splitAtPlayhead}
            title="Split clips (D)"
          />
          <CtrlBtn
            icon={<Trash2 size={14} />}
            onClick={deleteSelectedSegment}
            active={!!selectedSegmentId}
            title="Delete selected clip (Backspace)"
          />
          <Box w="1px" h="16px" bg="studio.border" mx="1" />
          <RemoveSilencePopover />
        </Flex>

        {/* Center: Playback controls */}
        <Flex align="center" gap="6px" flex="0">
          <CtrlBtn
            icon={<SkipBack size={15} />}
            onClick={() => seekTo(0)}
            title="Back to start (1)"
          />
          <Flex
            as="button"
            align="center"
            justify="center"
            w="32px"
            h="32px"
            borderRadius="full"
            bg="studio.raised"
            borderWidth="1px"
            borderColor="studio.borderStrong"
            cursor="pointer"
            color="studio.fg"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={togglePlay}
            transition="background 120ms ease, border-color 120ms ease"
            _hover={{ borderColor: "studio.fgSubtle" }}
          >
            {isPlaying ? <Pause size={15} /> : <Play size={15} />}
          </Flex>
          <CtrlBtn
            icon={<SkipForward size={15} />}
            onClick={() => seekTo(safeDuration)}
            title="Go to end"
          />
          <TimelineTimecode duration={safeDuration} />
        </Flex>

        {/* Right: Zoom */}
        <Flex align="center" gap="4px" flex="1" justify="flex-end">
          <CtrlBtn label="Word" onClick={handleFitToWord} title="Fit to word" />
          <CtrlBtn label="Sentence" onClick={handleFitToSentence} title="Fit to sentence" />
          <Box w="1px" h="16px" bg="studio.border" mx="1" />
          <CtrlBtn
            icon={<ZoomOut size={13} />}
            onClick={() =>
              setTimelineZoom(Math.max(0.5, timelineZoom - 0.25))
            }
            title="Zoom out (-)"
          />
          <Slider.Root
            value={[timelineZoom]}
            min={0.5}
            max={4}
            step={0.05}
            onValueChange={(e) => setTimelineZoom(e.value[0]!)}
            size="sm"
            colorPalette="accent"
            w="80px"
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <CtrlBtn
            icon={<ZoomIn size={13} />}
            onClick={() =>
              setTimelineZoom(Math.min(4, timelineZoom + 0.25))
            }
            title="Zoom in (+)"
          />
        </Flex>
      </Flex>

      {/* ── Track area ────────────────────────────────────────────────── */}
      {showTimeline && (
        <Box
          ref={stripRef}
          data-timeline-scroll-root
          overflowX="auto"
          overflowY="hidden"
          style={{ height: `${trackAreaHeight}px` }}
          position="relative"
          onWheel={handleWheel}
          onScroll={onScroll}
          css={{
            "&::-webkit-scrollbar": { height: "6px" },
            "&::-webkit-scrollbar-track": { background: "transparent" },
            "&::-webkit-scrollbar-thumb": {
              background: "var(--chakra-colors-studio-raised)",
              borderRadius: "4px",
            },
          }}
        >
          <Box
            position="relative"
            style={{ width: `${totalWidth + LEFT_GUTTER + 60}px` }}
            h="100%"
          >
            {/* ── Ruler ───────────────────────────────────────────── */}
            <Box
              position="absolute"
              top="0"
              left="0"
              right="0"
              style={{ height: `${RULER_HEIGHT}px` }}
              onClick={handleStripClick}
              cursor="pointer"
            >
              {visibleTicks.map(({ time, major }) => (
                <Box
                  key={time}
                  position="absolute"
                  style={{ left: `${timeToX(time)}px` }}
                  top="0"
                  h="100%"
                >
                  {major ? (
                    <>
                      <Text
                        position="absolute"
                        top="2px"
                        fontSize="10px"
                        textStyle="data"
                        color="studio.timecode"
                        style={{ transform: "translateX(-50%)" }}
                        whiteSpace="nowrap"
                        userSelect="none"
                      >
                        {formatRulerLabel(time)}
                      </Text>
                      <Box
                        w="1px"
                        h="6px"
                        bg="studio.borderStrong"
                        position="absolute"
                        bottom="0"
                      />
                    </>
                  ) : (
                    <Box
                      w="1px"
                      h="3px"
                      bg="studio.border"
                      position="absolute"
                      bottom="0"
                      style={{ transform: "translateX(-0.5px)" }}
                    />
                  )}
                </Box>
              ))}
            </Box>

            {/* ── Video track (thumbnails) ─────────────────────── */}
            <Box
              position="absolute"
              top={`${RULER_HEIGHT}px`}
              left={`${LEFT_GUTTER}px`}
              style={{
                width: `${totalWidth}px`,
                height: `${TRACK_HEIGHT}px`,
              }}
              onClick={handleStripClick}
              cursor="pointer"
            >

              {visibleSegments.map((seg) => (
                <TimelineSegmentBlock
                  key={seg.id}
                  id={seg.id}
                  label={seg.label}
                  editedStartSec={seg.editedStartSec}
                  editedEndSec={seg.editedEndSec}
                  isSelected={selectedSegmentId === seg.id}
                  pxPerSec={TIMELINE_PX_PER_SEC}
                  thumbnailVideoUrl={activeVideoUrl}
                  videoKind={activeVideoKind}
                  offsetSec={activeOffsetSec}
                  sourcePreviewId={sourcePreviewId}
                  clipStartSec={clipStartSec}
                  editedTimeMap={editedTimeMap}
                  cutsSignature={cutsSignature}
                  setSelectedSegmentId={setSelectedSegmentId}
                />
              ))}

              {visibleCutMarkers.map((marker) => (
                <CutMarkerBlock
                  key={marker.id}
                  marker={marker}
                  x={marker.editedSec * TIMELINE_PX_PER_SEC}
                  onRevert={revertDeletedRange}
                />
              ))}

              {visiblePauseMarkers.map((marker) => {
                const left = marker.startSec * TIMELINE_PX_PER_SEC;
                const width = Math.max(
                  2,
                  (marker.endSec - marker.startSec) * TIMELINE_PX_PER_SEC,
                );

                return (
                  <Box
                    key={marker.id}
                    position="absolute"
                    top="0"
                    bottom="0"
                    style={{ left: `${left}px`, width: `${width}px` }}
                    bg="rgba(255,255,255,0.08)"
                    borderLeft="1px solid rgba(255,255,255,0.16)"
                    borderRight="1px solid rgba(255,255,255,0.12)"
                    pointerEvents="none"
                    title={`${marker.duration.toFixed(1)}s pause`}
                    zIndex={6}
                  />
                );
              })}

            </Box>

            {/* ── Word chips (Vizard-parity Phase B step 15) ────── */}
            <Box
              position="absolute"
              top={`${RULER_HEIGHT + TRACK_HEIGHT + 4}px`}
              left={`${LEFT_GUTTER}px`}
              style={{
                width: `${totalWidth}px`,
                height: `${WORD_CHIPS_HEIGHT}px`,
              }}
            >
              {showWordChips && (
                <WordChipsRow
                  words={visibleWordChips}
                  pxPerSec={TIMELINE_PX_PER_SEC}
                  height={WORD_CHIPS_HEIGHT}
                  editedTimeMap={editedTimeMap}
                  onSeek={seekTo}
                />
              )}
            </Box>

            {/* ── Waveform track ───────────────────────────────── */}
            <Box
              position="absolute"
              top={`${RULER_HEIGHT + TRACK_HEIGHT + 4 + WORD_CHIPS_HEIGHT + 4}px`}
              left={`${LEFT_GUTTER}px`}
              style={{
                width: `${totalWidth}px`,
                height: `${WAVEFORM_HEIGHT}px`,
              }}
              bg="studio.subtle"
              borderRadius="l1"
              overflow="hidden"
              borderWidth="1px"
              borderColor="studio.border"
              onClick={handleStripClick}
              cursor="pointer"
            >
              <WaveformCanvas
                utterances={utterances}
                editedTimeMap={editedTimeMap}
                duration={safeDuration}
                width={totalWidth}
                height={WAVEFORM_HEIGHT}
                waveformPeaksUrl={waveformPeaksUrl}
              />
            </Box>

            {/* ── Text overlay track (Vizard-parity Phase C step 1) ── */}
            {hasTextLayers && (
              <Box
                position="absolute"
                top={`${textTrackTop}px`}
                left={`${LEFT_GUTTER}px`}
                style={{
                  width: `${totalWidth}px`,
                  height: `${TEXT_TRACK_HEIGHT}px`,
                }}
              >
                {studioEdits.textLayers.map((layer) => (
                  <TextLayerChip
                    key={layer.id}
                    id={layer.id}
                    text={layer.text}
                    startSec={layer.startSec}
                    endSec={layer.endSec ?? null}
                    isSelected={selectedTextLayerId === layer.id}
                    pxPerSec={TIMELINE_PX_PER_SEC}
                    duration={safeDuration}
                  />
                ))}
              </Box>
            )}

            {/* ── Playhead ─────────────────────────────────────── */}
            <TimelinePlayhead
              duration={safeDuration}
              isPlaying={isPlaying}
              timeToX={timeToX}
              scrollRootRef={stripRef}
            />

            {/* ── Trim handles (vizard-parity.md Phase B step 13) ─ */}
            <TrimHandle
              side="start"
              anchorPx={LEFT_GUTTER}
              pxPerSec={TIMELINE_PX_PER_SEC}
              trackHeight={trackAreaHeight}
            />
            <TrimHandle
              side="end"
              anchorPx={LEFT_GUTTER + totalWidth}
              pxPerSec={TIMELINE_PX_PER_SEC}
              trackHeight={trackAreaHeight}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
