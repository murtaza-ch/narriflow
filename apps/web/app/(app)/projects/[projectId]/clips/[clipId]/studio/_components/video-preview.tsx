"use client";

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { Box, Flex, Menu, Portal, Text } from "@chakra-ui/react";
import { Spinner } from "@narriflow/ui";
import {
  automaticLayoutInputFingerprint,
  compositionAssetRef,
  planClipComposition,
  screenLayoutInputFingerprint,
  splitLayoutInputFingerprint,
  type CompositionBackgroundLayer,
  type CompositionRect,
  type CompositionSourceVideoLayer,
} from "@narriflow/composition-plan";
import {
  Smartphone,
  Square,
  Monitor,
  RectangleHorizontal,
  Maximize2,
  ChevronDown,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import {
  capDuckingWindows,
  clipAspectRatioOptions,
  computeSpeechWindows,
  duckingGainMultiplierAt,
  editedToSource,
  extractSpeechWordIntervals,
  resolveEffectiveFramingMode,
  resolveEffectiveLogoSettings,
  resolveMusicFadeWindows,
  resolveSpeakerLayoutScene,
  speakerLayoutOverrideFromScene,
  type DuckingWindow,
  type LogoPosition,
  type SpeakerLayerRole,
  type SpeakerLayerTransform,
  type ResolvedSpeakerLayoutScene,
} from "@narriflow/validators";
import { useStudio } from "./studio-shell";
import type { AspectRatio, LayoutMode } from "./studio-shell";
import { InteractiveCaptionOverlay } from "./interactive-caption-overlay";
import { InteractiveTextLayer } from "./interactive-text-layer";
import { SfxPreviewTrack } from "./sfx-preview-track";
import { SplitSecondaryTile, type SplitSecondaryTileCropRect } from "./split-secondary-tile";
import { fitPipCropToTileNormalized, pipCropTooSmallNormalized } from "./pip-crop-math";
import type { NormalizedCropRect } from "./pip-crop-math";
import {
  activeAutoLayoutSegment,
  autoLayoutSegmentsForAspect,
  resetSpeakerLayerTransform,
  speakerLayerCropRect,
} from "./auto-layout-preview";
import { InteractiveSpeakerLayer } from "./interactive-speaker-layer";
import {
  brollPreviewLocalTime,
  isBrollPreviewActive,
  manualBrollPreviewWindow,
  type ManualBrollPreviewWindow,
} from "./broll-preview";
import {
  adoptCompositionPreview,
  plannedCompositionFrameStyle,
  plannedCompositionSourceDimensions,
  plannedCompositionUsesStackedStage,
  plannedCompositionVideoStyle,
} from "./composition-preview-adapter";
import {
  compositionPlanControl,
  shouldAdoptCompositionPlan,
} from "./composition-plan-control";

/** `screenTileGeometry`'s `tileWidth` (apps/worker/src/tasks/screen-layout.ts)
 *  is just the target aspect ratio's own output WIDTH — mirrored here from
 *  `clipAspectRatioOptions` (validators) rather than re-deriving it, so H1's
 *  `pipCropTooSmallNormalized` check compares against the exact same number
 *  the render pipeline's `pip_too_small` gate does (e.g. 1080 for 9:16, 1920
 *  for 16:9), not the preview container's own CSS pixel width. */
const OUTPUT_TILE_WIDTH_PX: Record<AspectRatio, number> = Object.fromEntries(
  clipAspectRatioOptions.map((option) => [option.value, option.width]),
) as Record<AspectRatio, number>;

/** Shadow-only projection of the browser's established object-fit geometry.
 * It never drives rendering; it gives rollout diagnostics an independent
 * legacy value to compare with the planned crop and destination. */
function legacyObjectFitGeometry(input: {
  source: { width: number; height: number };
  target: { width: number; height: number };
  fit: "cover" | "contain";
}): { sourceCrop: CompositionRect; destination: CompositionRect } {
  const { source, target } = input;
  if (input.fit === "contain") {
    const scale = Math.min(
      target.width / source.width,
      target.height / source.height,
    );
    const width = Math.min(
      target.width,
      Math.max(2, Math.round((source.width * scale) / 2) * 2),
    );
    const height = Math.min(
      target.height,
      Math.max(2, Math.round((source.height * scale) / 2) * 2),
    );
    return {
      sourceCrop: { x: 0, y: 0, width: source.width, height: source.height },
      destination: {
        x: Math.round((target.width - width) / 2),
        y: Math.round((target.height - height) / 2),
        width,
        height,
      },
    };
  }
  const sourceRatio = source.width / source.height;
  const targetRatio = target.width / target.height;
  const width =
    sourceRatio >= targetRatio
      ? Math.round(source.height * targetRatio)
      : source.width;
  const height =
    sourceRatio >= targetRatio
      ? source.height
      : Math.round(source.width / targetRatio);
  return {
    sourceCrop: {
      x: Math.max(0, Math.round((source.width - width) / 2)),
      y: Math.max(0, Math.round((source.height - height) / 2)),
      width,
      height,
    },
    destination: { x: 0, y: 0, width: target.width, height: target.height },
  };
}

function rectsDiffer(
  left: CompositionRect | null,
  right: CompositionRect | null,
  epsilon = 1,
): boolean {
  if (!left || !right) return left !== right;
  return (["x", "y", "width", "height"] as const).some(
    (key) => Math.abs(left[key] - right[key]) > epsilon,
  );
}

/** After this long with no metadata yet, hint that the source is just large. */
const SLOW_LOAD_HINT_MS = 10_000;

/** Approximates the worker's fixed 24px margin (render-clips.ts's
 *  LOGO_MARGIN_PX) as a fraction of canvas width, assuming a ~1080px-wide
 *  reference frame — matches the plan's "margin ≈ 24/1080 ≈ 2.2% of canvas
 *  width" approximation. Not pixel-exact (the worker's margin is a fixed px
 *  offset independent of aspect ratio; this scales with the preview's own
 *  rendered width), but close enough for a live preview. */
const LOGO_MARGIN_FRACTION = 24 / 1080;

/** Absolute-position styles for the 3x3 `LogoPosition` grid, mirroring
 *  `buildLogoOverlayPosition` in render-clips.ts (left/right/center-x,
 *  top/bottom/center-y) so preview placement matches burn-in. `marginPx` is
 *  in canvas-local pixels (see `LOGO_MARGIN_FRACTION`). */
function logoPositionStyle(
  position: LogoPosition,
  marginPx: number,
): React.CSSProperties {
  // Mirrors buildLogoOverlayPosition's split("-") parsing: "center" alone
  // has no second segment, so it falls through both branches below to the
  // centered default — matching the worker exactly.
  const [vertical, horizontal] = position.split("-");
  const style: React.CSSProperties = { position: "absolute" };
  let translateX = "0";
  let translateY = "0";

  if (horizontal === "left") style.left = `${marginPx}px`;
  else if (horizontal === "right") style.right = `${marginPx}px`;
  else {
    style.left = "50%";
    translateX = "-50%";
  }

  if (vertical === "top") style.top = `${marginPx}px`;
  else if (vertical === "bot") style.bottom = `${marginPx}px`;
  else {
    style.top = "50%";
    translateY = "-50%";
  }

  style.transform = `translate(${translateX}, ${translateY})`;
  return style;
}

function speakerFrameStyle(layer: SpeakerLayerTransform): React.CSSProperties {
  return {
    position: "absolute",
    left: `${layer.frameX * 100}%`,
    top: `${layer.frameY * 100}%`,
    width: `${layer.frameWidth * 100}%`,
    height: `${layer.frameHeight * 100}%`,
    transform: `rotate(${layer.rotationDeg}deg)`,
    transformOrigin: "center",
  };
}

// ─── Aspect ratio helpers ─────────────────────────────────────────────────────

const ASPECT_RATIO_CONFIG: Record<AspectRatio, { w: number; h: number; icon: React.ReactNode; label: string }> = {
  "9:16": { w: 9, h: 16, icon: <Smartphone size={12} />, label: "9:16" },
  "1:1":  { w: 1, h: 1,  icon: <Square size={12} />,     label: "1:1"  },
  "16:9": { w: 16, h: 9, icon: <Monitor size={12} />,    label: "16:9" },
  "4:5":  { w: 4,  h: 5, icon: <RectangleHorizontal size={12} />, label: "4:5" },
};

const LAYOUT_OPTIONS: LayoutMode[] = ["fill", "fit", "blur"];

function explicitCropVideoStyle(
  crop: NormalizedCropRect | null,
  tileWidthPx: number,
  tileHeightPx: number,
  visible: boolean,
): React.CSSProperties | null {
  if (
    !crop ||
    crop.w <= 0 ||
    crop.h <= 0 ||
    tileWidthPx <= 0 ||
    tileHeightPx <= 0
  ) {
    return null;
  }
  const width = tileWidthPx / crop.w;
  const height = tileHeightPx / crop.h;
  return {
    position: "absolute",
    left: `${-crop.x * width}px`,
    top: `${-crop.y * height}px`,
    width: `${width}px`,
    height: `${height}px`,
    maxWidth: "none",
    display: visible ? "block" : "none",
  };
}

// Split preview (split packet C): heuristic horizontal seat positions for
// the stacked 2-up tiles, fed straight into CSS `object-position`'s X
// component. These are fixed, hand-picked positions, NOT per-segment: the
// render pipeline instead detects real face clusters per shot segment and
// re-centers each tile individually (see the worker's split framing task,
// packet B), and switches which framing (2-up vs single speaker) applies
// per segment. No face detection is available client-side, so the live
// preview always shows this same static 2-up regardless of playhead
// position — same "render is the source of truth" stance as the music
// preview comment further down in this file: good enough to block out
// where the two speakers will sit, without claiming frame-accurate parity
// with the actual export.
//
// H2 (adversarial review): these are NOT "a fraction of the source video's
// width" the way a plain centered crop's `cx` is (that's what the render
// pipeline's `TwoUpRegionSpec.cx` means, and what an earlier version of this
// comment wrongly implied these matched). Under `object-fit: cover`,
// `object-position`'s X component `p` does NOT pick a point on the
// UNSCALED source — `cover` first scales the source up until it fills the
// tile in both dimensions, THEN `p` anchors the overflow: the resulting
// VISIBLE center lands at `p*(1-r) + r/2` of the way across the source,
// where `r = tileAspect / videoAspect` is the fraction of source width the
// tile's viewport actually shows. For a 1920x1080 source stacked into 9:16
// tiles, r ~= 0.775, so the previous `0.33`/`0.67` values rendered as visible
// centers ~0.438/0.562 — far from the intended left/right seats, and close
// enough to each other to read as near-duplicate tiles.
//
// The fix (cheapest option that's still EXACT, not just closer): `0%` and
// `100%`. Those two values are defined as "anchor the overflow's start/end
// edge to the container's start/end edge" — they bypass the `p*(1-r)+r/2`
// formula entirely (there's no scaling-dependent midpoint to get wrong at
// the edges). That's also exactly what the render's own `cropXForCenter`
// produces at ITS clamped extremes (`x=0`, `x=srcWidth-cropW`) for sources
// too narrow to give the two seats real lateral separation — preview and
// render agree at the boundary case, and for the common two-shot framing
// (seats genuinely near the left/right edges of frame) `0%`/`100%` is a
// reasonable stand-in for a per-shot detected center, same "good enough"
// preview stance as before.
const SPLIT_TOP_TILE_CX = 0;
const SPLIT_BOTTOM_TILE_CX = 1;

const PILL_STYLES = {
  alignItems: "center",
  gap: "5px",
  px: "10px",
  h: "26px",
  bg: "studio.surface",
  borderWidth: "1px",
  borderColor: "studio.border",
  borderRadius: "l2",
  color: "studio.fgMuted",
  fontSize: "12px",
  fontWeight: "500",
  cursor: "pointer",
  transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
  userSelect: "none",
} as const;

function BrollPreviewLayer({
  src,
  poster,
  window,
  currentTime,
  isPlaying,
  onDuration,
}: {
  src: string;
  poster: string | null;
  window: ManualBrollPreviewWindow;
  currentTime: number;
  isPlaying: boolean;
  onDuration: (durationSec: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const localTime = brollPreviewLocalTime(currentTime, window);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      const bounded = Math.min(
        Math.max(0, localTime),
        Math.max(0, video.duration - 0.05),
      );
      if (Math.abs(video.currentTime - bounded) > 0.16) {
        video.currentTime = bounded;
      }
    }
    if (isPlaying) {
      void video.play().catch(() => {
        // The poster remains visible if the remote preview cannot autoplay.
      });
    } else {
      video.pause();
    }
  }, [isPlaying, localTime]);

  return (
    <Box
      position="absolute"
      inset="0"
      zIndex={3}
      bg="black"
      pointerEvents="none"
      aria-label="B-roll preview"
    >
      {/* Decorative cutaway: spoken captions remain in the interactive
          overlay above this layer, so this video intentionally has no track. */}
      <video
        ref={ref}
        src={src}
        poster={poster ?? undefined}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(event) => {
          const durationSec = event.currentTarget.duration;
          if (Number.isFinite(durationSec) && durationSec > 0) {
            onDuration(durationSec);
          }
          event.currentTarget.currentTime = Math.min(
            localTime,
            Math.max(0, durationSec - 0.05),
          );
        }}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
        }}
      />
      <Flex
        position="absolute"
        top="8px"
        left="8px"
        align="center"
        gap="5px"
        px="7px"
        h="20px"
        borderRadius="l1"
        bg="studio.surface/88"
        borderWidth="1px"
        borderColor="studio.borderStrong"
        color="studio.accentFg"
        textStyle="eyebrow"
        fontSize="9px"
      >
        B-roll · {(window.endSec - window.startSec).toFixed(1)}s
      </Flex>
    </Box>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function VideoPreview() {
  const {
    editorDocument,
    clipInfo,
    aspectRatio, setAspectRatio,
    layoutMode, setLayoutMode,
    studioEdits,
    mediaRef,
    playbackClock,
    sourceVideoUrl,
    previewVideoUrl,
    sourcePurged,
    useOriginalSourceFallback,
    setUseOriginalSourceFallback,
    reloadPlayback,
    activeVideoUrl,
    activeOffsetSec,
    brollUrl,
    brollPreviewAsset,
    setBrollPreviewAsset,
    editedTimeMap,
    playerClipStartSec,
    deselectCaption,
    deselectTextLayer,
    captionSelected,
    selectedTextLayerId,
    setStudioEdits,
    endCoalesce,
    isPlaying,
    duration,
    brandLogo,
    utterances,
    layoutAnalysis,
    autoLayoutAnalysis,
    autoLayoutAnalysisStatus,
    clipWindow,
  } = useStudio();

  // Effective logo settings for THIS clip — studioEdits.logo overrides
  // merged over the project brand snapshot's defaults, via the exact same
  // helper the worker uses for burn-in (resolveEffectiveLogoSettings), so
  // preview and render can't fork. `null` when the project has no logo.
  const effectiveLogo = brandLogo
    ? resolveEffectiveLogoSettings(
        {
          position: brandLogo.position,
          opacity: brandLogo.opacity,
          scalePct: brandLogo.scalePct,
        },
        studioEdits.logo,
      )
    : null;

  const [videoLoaded, setVideoLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [isStalled, setIsStalled] = useState(false);
  const [bufferedFraction, setBufferedFraction] = useState(0);
  const [slowLoadHint, setSlowLoadHint] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [currentTime, setCurrentTime] = useState(() => playbackClock.getSnapshot());
  const [previewWidth, setPreviewWidth] = useState(0);
  // Screen packet C (PiP persistence — preview true facecam crop): the
  // video container box's own rendered HEIGHT, tracked alongside
  // `previewWidth` by the same ResizeObserver below. Needed (previewWidth
  // alone wasn't) to derive the screen framing bottom tile's own CSS box
  // (half that height, full that width) for `fitPipCropToTileNormalized`'s
  // `tileRatio` and `SplitSecondaryTileCropRect`'s `tileHeightPx`.
  const [previewHeight, setPreviewHeight] = useState(0);
  const [selectedSpeakerRole, setSelectedSpeakerRole] =
    useState<SpeakerLayerRole | null>(null);
  // Screen packet C: the SOURCE video's own pixel dimensions, captured once
  // from `videoRef`'s `loadedmetadata` event (see the load effect below) —
  // `fitPipCropToTileNormalized`'s `probe` argument, matching the worker's
  // `detectPipPath` probe (`ffprobe`'s own reported source dimensions).
  // Null until the main video has loaded metadata at least once; a source
  // switch (proxy <-> full source) reloads it from the SAME physical
  // source file, so the value doesn't need to be invalidated on that
  // transition, only ever (re)set forward.
  const [sourceDims, setSourceDims] = useState<{ width: number; height: number } | null>(null);
  const [backgroundImageAvailability, setBackgroundImageAvailability] =
    useState<
      | { state: "missing" | "pending" | "failed" }
      | { state: "available"; ref: string }
    >({ state: "missing" });
  const containerRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const mainVideoRef = useRef<HTMLVideoElement | null>(null);
  const attachMainVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      mainVideoRef.current = element;
      mediaRef(element);
    },
    [mediaRef],
  );
  const musicAudioRef = useRef<HTMLAudioElement>(null);
  // Music/SFX library (vizard-parity.md): `studioEdits.music.url` for an
  // asset picked in a past session may be an expired R2 presign — the
  // presign TTL is much shorter than a document's lifetime. When
  // `music.assetId` is set, this holds a freshly-fetched playback URL that
  // wins over the (possibly stale) `music.url`; never written back into
  // studioEdits, so resolving it can't dirty the document. Null while
  // unresolved or when there's no assetId (a pasted-link track's `url` is
  // never stale, since there's no presign to expire).
  const [resolvedMusicUrl, setResolvedMusicUrl] = useState<string | null>(null);
  // Same id -> playback-url resolution for SFX placements, batched per
  // unique assetId and cached in a ref (not state) so resolving one more id
  // doesn't need to be an effect dependency — a version counter bumps a
  // render once new entries land instead.
  const sfxUrlCacheRef = useRef<Record<string, string>>({});
  // Calling the setter is what forces the re-render that re-reads
  // `sfxUrlCacheRef` below — the value itself doesn't need to be read
  // anywhere (React re-renders on any state update regardless), so it's
  // discarded here rather than kept around just to silence an unused-var
  // lint (L7: this used to also be baked into `SfxPreviewTrack`'s `key`
  // below as a remount hack; that's gone now that the track's own volume
  // effect correctly reacts to `src` changing on its own).
  const [, setSfxUrlVersion] = useState(0);
  // Music track's own duration (unknown until its metadata loads) — used to
  // wrap the preview's offset+clock time the same way the renderer's
  // `-stream_loop -1` + atrim loops the track.
  const musicDurationRef = useRef(0);
  const arConfig = ASPECT_RATIO_CONFIG[aspectRatio];
  const activeBrollAsset =
    brollPreviewAsset?.url === brollUrl ? brollPreviewAsset : null;
  const brollWindow = useMemo(
    () =>
      brollUrl
        ? manualBrollPreviewWindow(duration, activeBrollAsset?.durationSec)
        : null,
    [activeBrollAsset?.durationSec, brollUrl, duration],
  );
  const brollActive = isBrollPreviewActive(currentTime, brollWindow);
  const handleBrollDuration = useCallback(
    (durationSec: number) => {
      if (!brollUrl) return;
      setBrollPreviewAsset({
        url: brollUrl,
        durationSec,
        posterUrl: activeBrollAsset?.posterUrl ?? null,
        authorName: activeBrollAsset?.authorName ?? null,
        pageUrl: activeBrollAsset?.pageUrl ?? null,
      });
    }, [activeBrollAsset, brollUrl, setBrollPreviewAsset],
  );

  // Vizard-parity Phase C item 2 (canvas background) / Phase C-2 stage 1
  // (framing modes): a persisted studioEdits.background always wins over
  // the cosmetic, session-local `layoutMode` — when the EFFECTIVE framing
  // mode (resolveEffectiveFramingMode, shared with the Layout panel and the
  // worker's render pipeline) resolves to "fit", the video letterboxes and
  // a solid color or image fills the empty frame behind it, mirroring the
  // worker's buildFitAndBackgroundFilter exactly (scale-to-contain,
  // centered). When a persisted auto-layout plan is available, "auto" uses
  // the exact analyzed crop below. Pending/failed analysis and explicit
  // center mode fall back to the existing single-video behavior, so
  // `layoutMode`'s own fill/fit/blur cycling stays fully in charge whenever
  // background is "off". "split" and "screen" are also "off"-branch modes (`backgroundActive`
  // below is a plain `=== "fit"` check, not an exhaustive switch, so it's
  // `false` for both exactly like it is for center) but do NOT fall through
  // to `layoutMode`'s single-video crop-to-fill below — split packet C (and
  // now screen packet C) replace that with a real stacked 2-up dual-video
  // preview (see `isSplit`/`isScreen` and the tile markup further down).
  // `layoutMode`'s fill/fit/blur cosmetic only ever applies to the remaining
  // single-video modes (auto/center) — each split/screen tile already fully
  // determines its own framing via a fixed crop or letterbox, so there's no
  // fill/fit/blur state left to cycle through for it.
  const background = studioEdits.background;
  useEffect(() => {
    if (background.mode !== "image" || !background.imageUrl) {
      setBackgroundImageAvailability({ state: "missing" });
      return;
    }
    let active = true;
    const image = new Image();
    setBackgroundImageAvailability({ state: "pending" });
    image.onload = () => {
      if (active) {
        setBackgroundImageAvailability({
          state: "available",
          ref: compositionAssetRef("background", background.imageUrl!),
        });
      }
    };
    image.onerror = () => {
      if (active) setBackgroundImageAvailability({ state: "failed" });
    };
    image.src = background.imageUrl;
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [background.imageUrl, background.mode]);
  const effectiveFramingMode = resolveEffectiveFramingMode(studioEdits);
  const compositionSourceIdentity = compositionAssetRef(
    "source",
    clipInfo.projectId,
  );
  const eligibleAutoLayoutAnalysis =
    autoLayoutAnalysis?.sourceIdentity === compositionSourceIdentity
      ? autoLayoutAnalysis
      : null;
  const automaticLayoutAnalysis =
    eligibleAutoLayoutAnalysis?.engine === "shot-layout-v1"
      ? eligibleAutoLayoutAnalysis
      : null;
  const compositionSourceDims = sourceDims
    ? plannedCompositionSourceDimensions(sourceDims, eligibleAutoLayoutAnalysis)
    : null;
  const compositionPlanResult = useMemo(() => {
    if (!compositionSourceDims) return null;
    const target = clipAspectRatioOptions.find(
      (option) => option.value === aspectRatio,
    );
    if (!target) return null;
    const splitEngineVersion =
      eligibleAutoLayoutAnalysis?.engine ?? "explicit-split-v1";
    const screenEngineVersion = "screen-layout-v1";
    const screenWindowMatches = Boolean(
      layoutAnalysis &&
        editorDocument.deletedRanges.length === 0 &&
        Math.abs(layoutAnalysis.clipStartSec - editorDocument.clipStartSec) <= 0.05 &&
        Math.abs(layoutAnalysis.clipEndSec - editorDocument.clipEndSec) <= 0.05,
    );
    return planClipComposition({
      document: editorDocument,
      source: {
        identity: compositionSourceIdentity,
        kind: "video",
        width: compositionSourceDims.width,
        height: compositionSourceDims.height,
      },
      evidence: {
        automaticLayout: !compositionPlanControl.automaticSpeakerLayoutEnabled
          ? { state: "disabled" }
          : automaticLayoutAnalysis
            ? {
                state: "available",
                value: {
                  sourceIdentity: compositionSourceIdentity,
                  inputFingerprint: automaticLayoutInputFingerprint({
                    sourceIdentity: compositionSourceIdentity,
                    clipStartSec: editorDocument.clipStartSec,
                    clipEndSec: editorDocument.clipEndSec,
                    deletedRanges: editorDocument.deletedRanges,
                    engineVersion: "shot-layout-v1",
                  }),
                  engineVersion: "shot-layout-v1",
                  analysis: automaticLayoutAnalysis,
                },
              }
            : {
                state:
                  autoLayoutAnalysisStatus === "failed" ? "failed" : "missing",
              },
        splitLayout: eligibleAutoLayoutAnalysis
          ? {
              state: "available",
              value: {
                sourceIdentity: compositionSourceIdentity,
                inputFingerprint: splitLayoutInputFingerprint({
                  sourceIdentity: compositionSourceIdentity,
                  clipStartSec: eligibleAutoLayoutAnalysis.clipStartSec,
                  clipEndSec: eligibleAutoLayoutAnalysis.clipEndSec,
                  deletedRanges: eligibleAutoLayoutAnalysis.deletedRanges,
                  engineVersion: splitEngineVersion,
                }),
                engineVersion: splitEngineVersion,
                source:
                  eligibleAutoLayoutAnalysis.engine === "explicit-split-v1"
                    ? "explicit-detector"
                    : "automatic-layout",
                segments: eligibleAutoLayoutAnalysis.segments,
                fallbackSegments: eligibleAutoLayoutAnalysis.noSplitSegments,
              },
            }
          : {
              state:
                autoLayoutAnalysisStatus === "failed" ? "failed" : "missing",
            },
        screenLayout:
          screenWindowMatches && layoutAnalysis
            ? {
                state: "available",
                value: {
                  sourceIdentity: compositionSourceIdentity,
                  inputFingerprint: screenLayoutInputFingerprint({
                    sourceIdentity: compositionSourceIdentity,
                    clipStartSec: editorDocument.clipStartSec,
                    clipEndSec: editorDocument.clipEndSec,
                    deletedRanges: editorDocument.deletedRanges,
                    engineVersion: screenEngineVersion,
                  }),
                  engineVersion: screenEngineVersion,
                  source: "durable-pip",
                  pictureInPicture:
                    layoutAnalysis.pipUsable && layoutAnalysis.pipRect
                      ? {
                          state: "confirmed",
                          rect: {
                            x: layoutAnalysis.pipRect.x,
                            y: layoutAnalysis.pipRect.y,
                            width: layoutAnalysis.pipRect.w,
                            height: layoutAnalysis.pipRect.h,
                          },
                        }
                      : { state: "unavailable" },
                  faceBand: { state: "unavailable" },
                },
              }
            : { state: "missing" },
      },
      assets: { backgroundImage: backgroundImageAvailability },
      capabilities: {
        automaticSpeakerLayout:
          compositionPlanControl.automaticSpeakerLayoutEnabled,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        explicitSplitLayout: true,
        splitEngineVersion,
        screenLayout: true,
        screenEngineVersion,
      },
      targets: [
        {
          id: aspectRatio,
          aspectRatio,
          width: target.width,
          height: target.height,
        },
      ],
    });
  }, [
    aspectRatio,
    backgroundImageAvailability,
    compositionSourceIdentity,
    editorDocument,
    automaticLayoutAnalysis,
    eligibleAutoLayoutAnalysis,
    autoLayoutAnalysisStatus,
    layoutAnalysis,
    compositionSourceDims,
  ]);
  const compositionPreview = useMemo(() => {
    if (
      !compositionPlanResult ||
      compositionPlanResult.status === "invalid" ||
      (editorDocument.brollUrl &&
        (effectiveFramingMode === "split" || effectiveFramingMode === "screen")) ||
      !shouldAdoptCompositionPlan(effectiveFramingMode)
    ) {
      return null;
    }
    return adoptCompositionPreview(
      compositionPlanResult.plan,
      aspectRatio,
      currentTime,
    );
  }, [
    aspectRatio,
    compositionPlanResult,
    currentTime,
    editorDocument.brollUrl,
    effectiveFramingMode,
  ]);
  const plannedSourceLayers = useMemo(
    () =>
      compositionPreview?.layers.filter(
        (layer): layer is CompositionSourceVideoLayer =>
          layer.kind === "source-video",
      ) ?? [],
    [compositionPreview],
  );
  const plannedBackgroundLayer = compositionPreview?.layers.find(
    (layer): layer is CompositionBackgroundLayer => layer.kind === "background",
  );
  const plannedSourceDims = compositionPlanResult?.status === "invalid"
    ? null
    : compositionPlanResult?.plan.source ?? null;
  const compositionNotice = compositionPreview?.notices[0] ?? null;
  const compositionNoticeText =
    compositionNotice?.code === "background_image_pending"
      ? "Checking background image…"
      : compositionNotice?.code === "background_image_unavailable"
        ? "Background image unavailable. Using the selected color."
        : compositionNotice?.code === "automatic_layout_analyzing"
          ? "Analyzing speakers… Center framing is shown for now."
          : compositionNotice?.code === "automatic_layout_disabled"
            ? "Automatic speaker layout is disabled. Using Center."
            : compositionNotice?.code === "automatic_layout_unavailable"
              ? "Speaker analysis unavailable. Using Center."
              : compositionNotice?.code === "split_layout_analyzing"
                ? "Analyzing speakers… Center framing is shown for now."
                : compositionNotice?.code === "split_layout_disabled"
                  ? "Split analysis is disabled. Using single-speaker framing."
                  : compositionNotice?.code === "split_target_ineligible"
                    ? "Split is unavailable for this format. Using single-speaker framing."
                    : compositionNotice?.code === "split_no_two_up_scenes"
                      ? "Two stable speakers were not found. Using single-speaker framing."
                      : compositionNotice?.code === "split_layout_unavailable"
                        ? "Split analysis is unavailable. Using Center."
                        : compositionNotice?.code === "screen_layout_analyzing"
                          ? "Analyzing screen layout… A centered speaker tile is shown for now."
                          : compositionNotice?.code === "screen_layout_disabled"
                            ? "Screen layout is disabled. Using Center."
                            : compositionNotice?.code === "screen_pip_too_small"
                              ? "The facecam is too small for this format. Using the speaker fallback."
                              : compositionNotice?.code === "screen_face_band_fallback"
                                ? "Using the detected speaker band."
                                : compositionNotice?.code === "screen_static_center_fallback"
                                  ? "Speaker tracking is unavailable. Using a centered speaker tile."
                                  : null;
  const backgroundActive = effectiveFramingMode === "fit";
  // resolveEffectiveFramingMode makes background and split/screen mutually
  // exclusive (background always wins as "fit"), so `isSplit`/`isScreen`
  // only ever read true here while `backgroundActive` is false — never read
  // `studioEdits.framing.mode` directly, per the panel/schema doc comments.
  // Screen packet C: "screen" gets its own two-tile stage, analogous to
  // split's, but with different framing per tile — TOP is the full source
  // frame letterboxed uncropped (object-fit: contain, black backdrop, same
  // as a plain "fit" letterbox) rather than split's cropped-to-fill top
  // tile, and BOTTOM is the facecam picture-in-picture crop. PiP persistence
  // packet C: once the worker's analysis pass (packet B) has run and
  // persisted a `pipRect` for this clip, the bottom tile shows that TRUE
  // facecam crop (see `screenBottomCropRect` below) — matching the render's
  // own framing exactly, not approximating it. Only falls back to a static
  // center crop (no face detection client-side) when no analysis has landed
  // yet or none qualified, same "render is the source of truth" stance split
  // keeps for its fixed left/right seats — see `SplitSecondaryTile`'s
  // `objectFit`/`objectPosition` (fallback) vs. `cropRect` (true crop) props
  // further down.
  const isSplit = compositionPreview
    ? compositionPreview.effectiveMode === "split" &&
      plannedCompositionUsesStackedStage(compositionPreview)
    : effectiveFramingMode === "split";
  const isScreen = compositionPreview
    ? compositionPreview.effectiveMode === "screen"
    : effectiveFramingMode === "screen";
  const plannedSpeakerScene = useMemo<ResolvedSpeakerLayoutScene | null>(() => {
    if (
      (compositionPreview?.requestedMode !== "auto" &&
        compositionPreview?.requestedMode !== "split") ||
      (compositionPreview.effectiveMode !== "auto" &&
        compositionPreview.effectiveMode !== "split") ||
      plannedSourceLayers.length === 0 ||
      plannedSourceLayers.some((layer) => !layer.speaker)
    ) {
      return null;
    }
    return {
      startSec: compositionPreview.sceneStartSec,
      endSec: compositionPreview.sceneEndSec,
      layout: plannedSourceLayers.length === 2 ? "two-up" : "single",
      layers: plannedSourceLayers.map((layer) => ({ ...layer.speaker!.transform })),
      overrideId: plannedSourceLayers[0]!.speaker!.overrideId,
    };
  }, [compositionPreview, plannedSourceLayers]);
  const legacyAutoSegments = useMemo(
    () =>
      compositionPlanControl.auto !== "plan" &&
      effectiveFramingMode === "auto" &&
      automaticLayoutAnalysis &&
      sourceDims
        ? autoLayoutSegmentsForAspect(automaticLayoutAnalysis, aspectRatio, sourceDims)
        : [],
    [aspectRatio, automaticLayoutAnalysis, effectiveFramingMode, sourceDims],
  );
  const legacyActiveAutoSegment = useMemo(
    () => activeAutoLayoutSegment(legacyAutoSegments, currentTime),
    [currentTime, legacyAutoSegments],
  );
  const legacySpeakerScene = useMemo(
    () =>
      legacyActiveAutoSegment
        ? resolveSpeakerLayoutScene(
            legacyActiveAutoSegment,
            studioEdits.speakerLayoutOverrides,
            aspectRatio,
          )
        : null,
    [aspectRatio, legacyActiveAutoSegment, studioEdits.speakerLayoutOverrides],
  );
  const activeSpeakerScene = plannedSpeakerScene ?? legacySpeakerScene;
  const activeSpeakerSceneKey = activeSpeakerScene
    ? `${aspectRatio}:${activeSpeakerScene.startSec.toFixed(3)}:${activeSpeakerScene.endSec.toFixed(3)}:${activeSpeakerScene.layout}`
    : null;

  useEffect(() => {
    if (captionSelected || selectedTextLayerId) {
      setSelectedSpeakerRole(null);
    }
  }, [captionSelected, selectedTextLayerId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the scene key intentionally invalidates selection when scene boundaries change.
  useEffect(() => {
    if (
      selectedSpeakerRole &&
      !activeSpeakerScene?.layers.some((layer) => layer.role === selectedSpeakerRole)
    ) {
      setSelectedSpeakerRole(null);
    }
  }, [activeSpeakerSceneKey, activeSpeakerScene, selectedSpeakerRole]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedSpeakerRole(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const selectSpeakerLayer = useCallback(
    (role: SpeakerLayerRole) => {
      deselectCaption();
      deselectTextLayer();
      setSelectedSpeakerRole(role);
    },
    [deselectCaption, deselectTextLayer],
  );

  const updateSpeakerLayer = useCallback(
    (nextLayer: SpeakerLayerTransform, gesture: string) => {
      if (!activeSpeakerScene) return;
      setStudioEdits(
        (previous) => {
          const nextScene = {
            ...activeSpeakerScene,
            layers: activeSpeakerScene.layers.map((layer) =>
              layer.role === nextLayer.role ? nextLayer : layer,
            ),
          };
          const id =
            activeSpeakerScene.overrideId ??
            `speaker-scene-${crypto.randomUUID()}`;
          const override = speakerLayoutOverrideFromScene(nextScene, aspectRatio, id);
          const withoutCurrent = previous.speakerLayoutOverrides.filter(
            (candidate) => candidate.id !== activeSpeakerScene.overrideId,
          );
          return {
            ...previous,
            speakerLayoutOverrides: [...withoutCurrent.slice(-63), override],
          };
        },
        `${activeSpeakerSceneKey ?? "speaker-scene"}:${gesture}`,
      );
    },
    [activeSpeakerScene, activeSpeakerSceneKey, aspectRatio, setStudioEdits],
  );

  const resetActiveSpeakerLayer = useCallback((role: SpeakerLayerRole) => {
    if (!activeSpeakerScene) return;
    setStudioEdits((previous) => {
      if (!activeSpeakerScene.overrideId) return previous;

      const defaults =
        plannedSourceLayers.length > 0
          ? {
              ...activeSpeakerScene,
              overrideId: null,
              layers: plannedSourceLayers.map((layer) => ({
                ...layer.speaker!.defaultTransform,
              })),
            }
          : legacyActiveAutoSegment
            ? resolveSpeakerLayoutScene(legacyActiveAutoSegment, [], aspectRatio)
            : null;
      if (!defaults) return previous;
      const reset = resetSpeakerLayerTransform(
        activeSpeakerScene.layers,
        defaults.layers,
        role,
      );
      if (!reset.changed) return previous;

      const nextScene = { ...activeSpeakerScene, layers: reset.layers };
      const withoutCurrent = previous.speakerLayoutOverrides.filter(
        (candidate) => candidate.id !== activeSpeakerScene.overrideId,
      );

      return {
        ...previous,
        speakerLayoutOverrides: reset.isFullyReset
          ? withoutCurrent
          : [
              ...withoutCurrent.slice(-63),
              speakerLayoutOverrideFromScene(
                nextScene,
                aspectRatio,
                activeSpeakerScene.overrideId,
              ),
            ],
      };
    });
    endCoalesce();
  }, [activeSpeakerScene, aspectRatio, endCoalesce, legacyActiveAutoSegment, plannedSourceLayers, setStudioEdits]);

  const autoTwoUp = activeSpeakerScene?.layout === "two-up";
  const isStacked = isSplit || isScreen || autoTwoUp;
  const videoObjectFit: "contain" | "cover" = backgroundActive
    ? "contain"
    : layoutMode === "fit"
      ? "contain"
      : "cover";
  const backgroundStageStyle: React.CSSProperties = backgroundActive
    ? plannedBackgroundLayer
      ? plannedBackgroundLayer.imageRef && background.imageUrl
        ? {
            backgroundImage: `url(${background.imageUrl})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundColor: plannedBackgroundLayer.color,
          }
        : { backgroundColor: plannedBackgroundLayer.color }
      : background.mode === "image" && background.imageUrl
      ? {
          backgroundImage: `url(${background.imageUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundColor: background.color ?? "#000000",
        }
      : { backgroundColor: background.color ?? "#000000" }
    : {};

  const cycleLayout = useCallback(() => {
    const idx = LAYOUT_OPTIONS.indexOf(layoutMode);
    setLayoutMode(LAYOUT_OPTIONS[(idx + 1) % LAYOUT_OPTIONS.length]!);
  }, [layoutMode, setLayoutMode]);

  const handleRetry = useCallback(() => {
    setRetryNonce((n) => n + 1);
    reloadPlayback();
  }, [reloadPlayback]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: source changes and explicit retries intentionally reset presentation-only load indicators.
  useEffect(() => {
    setVideoLoaded(false);
    setLoadError(false);
    setIsStalled(false);
    setBufferedFraction(0);
    setSlowLoadHint(false);
  }, [activeVideoUrl, retryNonce]);

  const handleLoadedMetadata = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      const video = event.currentTarget;
      setVideoLoaded(true);
      setLoadError(false);
      setIsStalled(false);
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setSourceDims({ width: video.videoWidth, height: video.videoHeight });
      }
    },
    [],
  );
  const handleVideoError = useCallback(() => {
    setLoadError(true);
    setVideoLoaded(false);
  }, []);
  const handleVideoStalled = useCallback(() => setIsStalled(true), []);
  const handleVideoProgress = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      const video = event.currentTarget;
      setIsStalled(false);
      if (video.duration > 0 && video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        setBufferedFraction(Math.min(1, bufferedEnd / video.duration));
      }
    },
    [],
  );

  // Large sources can sit well below HAVE_METADATA for a long time with no
  // error and no stall event — surface a hint rather than looking frozen.
  // (In practice this only fires for the opted-into full-source fallback —
  // the proxy is small enough that this basically never trips for it.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce intentionally restarts the slow-load timer.
  useEffect(() => {
    if (!activeVideoUrl || videoLoaded || loadError) {
      setSlowLoadHint(false);
      return;
    }
    const timeoutId = setTimeout(() => setSlowLoadHint(true), SLOW_LOAD_HINT_MS);
    return () => clearTimeout(timeoutId);
  }, [activeVideoUrl, videoLoaded, loadError, retryNonce]);

  // Music/SFX library — stale presigned URL resolution (vizard-parity.md).
  // Runs on mount and whenever `music.assetId` changes; deliberately does
  // NOT write the result into `studioEdits` (see `resolvedMusicUrl`'s doc
  // comment) — this is purely a preview-side lookup.
  useEffect(() => {
    const assetId = studioEdits.music.assetId;
    if (!assetId) {
      setResolvedMusicUrl(null);
      return;
    }
    let canceled = false;
    fetch(`/api/audio-assets/${assetId}/playback-url`)
      .then((res) => (res.ok ? (res.json() as Promise<{ url?: string }>) : null))
      .then((data) => {
        if (!canceled && data?.url) setResolvedMusicUrl(data.url);
      })
      .catch(() => {
        // Best-effort — falls back to the (possibly stale) music.url below.
      });
    return () => {
      canceled = true;
    };
  }, [studioEdits.music.assetId]);

  const musicSrc = resolvedMusicUrl ?? studioEdits.music.url;

  // Same stale-presign resolution for SFX placements, batched by unique
  // assetId so N placements sharing one asset cost one request each, not N.
  useEffect(() => {
    const missingIds = Array.from(new Set(studioEdits.sfx.map((p) => p.assetId))).filter(
      (id) => !(id in sfxUrlCacheRef.current),
    );
    if (missingIds.length === 0) return;
    let canceled = false;
    void Promise.all(
      missingIds.map(async (id) => {
        try {
          const res = await fetch(`/api/audio-assets/${id}/playback-url`);
          if (!res.ok) return;
          const data = (await res.json()) as { url?: string };
          if (data.url) sfxUrlCacheRef.current[id] = data.url;
        } catch {
          // Best-effort — this placement just won't play until it resolves.
        }
      }),
    ).then(() => {
      if (!canceled) setSfxUrlVersion((v) => v + 1);
    });
    return () => {
      canceled = true;
    };
  }, [studioEdits.sfx]);

  // Auto-ducking v1 (vizard-parity.md): speech windows derived from the same
  // transcript word timings the caption overlay reads, run through the
  // EXACT SAME three-function pipeline the worker's render-time volume
  // automation composes (M1+M2: `extractSpeechWordIntervals` ->
  // `computeSpeechWindows` -> `capDuckingWindows`, all shared from
  // `@narriflow/validators`) — never forked. Before this, this component
  // hand-rolled its own word extraction with no word-less-utterance
  // fallback and no window-count cap, so a word-less transcript (or one
  // with a pathological number of short utterances) ducked differently in
  // the export than in the preview the user was actually watching.
  // Cheap to compute even when ducking is off (returns `[]` fast via
  // `computeSpeechWindows`'s own early-out), so this doesn't need to be
  // gated on `studioEdits.music.ducking` itself.
  const speechWindows: DuckingWindow[] = useMemo(() => {
    const wordIntervals = extractSpeechWordIntervals(
      utterances,
      playerClipStartSec,
      editedTimeMap,
    );
    return capDuckingWindows(computeSpeechWindows(wordIntervals, duration));
  }, [utterances, editedTimeMap, duration, playerClipStartSec]);

  useEffect(() => playbackClock.subscribe(() => {
    setCurrentTime(playbackClock.getSnapshot());
  }), [playbackClock]);

  // ─── Music preview playback — a hidden looping <audio> element driven off
  // the same clock the video uses, so scrubbing/trimming the clip keeps the
  // music in sync without needing its own play head. Sample-accurate fades
  // are NOT the goal here (the render is the source of truth) — this is a
  // best-effort approximation good enough to preview against.
  // Fix 12: this used to run once on mount ([] deps), but the <audio>
  // element only exists once `studioEdits.music.url` is set (see the
  // conditional render below) — a clip that starts without music never had
  // anything to attach the listener to, and once music was later applied
  // this effect never re-ran to attach it, leaving musicDurationRef stuck at
  // 0 (dead loop-wrap modulo) for the rest of the session. Re-keying on the
  // URL re-runs it every time the <audio> element (re)mounts, and reading
  // `audio.duration` synchronously covers the case where the browser
  // already has cached metadata by the time this runs (no loadedmetadata
  // event will fire again in that case).
  // biome-ignore lint/correctness/useExhaustiveDependencies: musicSrc intentionally rebinds metadata listeners after source replacement.
  useEffect(() => {
    const audio = musicAudioRef.current;
    if (!audio) return;
    const handleLoadedMetadata = () => {
      musicDurationRef.current = Number.isFinite(audio.duration) ? audio.duration : 0;
    };
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      musicDurationRef.current = audio.duration;
    }
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    return () => audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
  }, [musicSrc]);

  // Reset the cached track duration whenever the music source changes so a
  // previous track's duration never leaks into the new one's loop math
  // before its own metadata has loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: musicSrc is the explicit cache-reset trigger.
  useEffect(() => {
    musicDurationRef.current = 0;
  }, [musicSrc]);

  useEffect(() => {
    const audio = musicAudioRef.current;
    if (!audio || !musicSrc) return;
    if (isPlaying) {
      audio.play().catch(() => {
        // Autoplay can be rejected outside a user gesture (e.g. a stray
        // effect re-run) — the next togglePlay() retries it; nothing to
        // surface to the user for a background music bed.
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, musicSrc]);

  useEffect(() => {
    const audio = musicAudioRef.current;
    const music = studioEdits.music;
    if (!audio || !musicSrc) return;

    // Fix 12 fallback: prefer the cached duration, but fall back to reading
    // the element directly — covers a render where metadata was already
    // available by the time the capture effect above ran but this sync
    // effect fires first within the same tick.
    const trackDuration =
      musicDurationRef.current > 0
        ? musicDurationRef.current
        : Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : 0;
    let targetTime = music.startOffsetSec + currentTime;
    if (trackDuration > 0) {
      targetTime = targetTime % trackDuration;
    }
    // Only correct drift beyond a small threshold — natural playback already
    // advances audio.currentTime on its own; forcing it every tick would
    // stutter the track.
    if (Number.isFinite(targetTime) && Math.abs(audio.currentTime - targetTime) > 0.25) {
      audio.currentTime = Math.max(0, targetTime);
    }

    // Fix 13: use the same clamped fade-window policy the render pipeline
    // applies (resolveMusicFadeWindows) instead of dividing by the raw
    // configured fadeInSec/fadeOutSec directly — keeps the preview's gain
    // ramp thresholds/divisors from drifting out of parity with the burn-in
    // when the two fades would otherwise overlap or exceed the clip.
    const baseVolume = Math.max(0, Math.min(1, music.volume / 100));
    const { fadeInSec, fadeOutSec, fadeOutStartSec } = resolveMusicFadeWindows(
      music.fadeInSec,
      music.fadeOutSec,
      duration,
    );
    let gain = baseVolume;
    if (fadeInSec > 0 && currentTime < fadeInSec) {
      gain = baseVolume * (currentTime / fadeInSec);
    }
    if (fadeOutSec > 0 && currentTime > fadeOutStartSec) {
      const remainingSec = Math.max(0, duration - currentTime);
      gain = Math.min(gain, baseVolume * (remainingSec / fadeOutSec));
    }
    // Auto-ducking v1 (vizard-parity.md): the SAME `duckingGainMultiplierAt`
    // the worker's timed volume automation calls, over the SAME
    // `speechWindows` — multiplied on top of the fade envelope rather than
    // replacing it, so a ducked moment inside a fade-in/out still fades.
    if (music.ducking) {
      gain *= duckingGainMultiplierAt(currentTime, speechWindows);
    }
    audio.volume = Math.max(0, Math.min(1, gain));
  }, [currentTime, studioEdits.music, duration, musicSrc, speechWindows]);

  useEffect(() => {
    const el = videoContainerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setPreviewWidth(entry.contentRect.width);
        setPreviewHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Calculate video dimensions to fit within container while maintaining aspect ratio
  const videoW = arConfig.w;
  const videoH = arConfig.h;

  // Distinguish "generating" (no proxy yet, but one can still arrive) from
  // "unavailable" (no proxy, and none ever can — the source was purged)
  // from "loading"/"errored"/"ready" once something is actually playing.
  // "generating" is the honest default: it means we deliberately haven't
  // started loading anything yet because the proxy isn't ready and the user
  // hasn't opted into the full-source fallback — surfacing this honestly is
  // the whole point of Problem A (silently falling back used to cost ~44s).
  // Once past that gate, activeVideoUrl is always set — it's either the
  // proxy, or the source the fallback button already required to be
  // present before it could be clicked — so there's no reachable "nothing
  // loaded" state left to model here (there used to be one; it was dead).
  // Split packet C (reused by screen packet C): file-local seconds (the same
  // unit `video.currentTime` reads on the main video) the secondary bottom
  // tile should be showing right now — runs the clock's edited time back
  // through `editedToSource` + `activeOffsetSec`, the exact reverse of what
  // `playerRippleStartSec` above does for the clip's opening instant. Only
  // meaningful (and only computed) while split or screen is active; the tile
  // that consumes it doesn't otherwise exist.
  const secondaryTileTargetTimeSec = isStacked
    ? editedToSource(editedTimeMap, currentTime) - activeOffsetSec
    : 0;

  const autoMainLayer = activeSpeakerScene?.layers.find((layer) =>
    activeSpeakerScene.layout === "two-up" ? layer.role === "top" : layer.role === "single",
  );
  const autoBottomLayer = activeSpeakerScene?.layers.find((layer) => layer.role === "bottom");
  const plannedMainSourceLayer =
    plannedSourceLayers.find(
      (layer) => layer.speaker?.role === autoMainLayer?.role,
    ) ?? plannedSourceLayers[0];
  const plannedBottomSourceLayer = plannedSourceLayers.find(
    (layer) => layer.speaker?.role === "bottom",
  ) ?? plannedSourceLayers[1];
  const autoMainCrop = useMemo(() => {
    if (!autoMainLayer || !sourceDims) return null;
    if (plannedMainSourceLayer) {
      if (!plannedSourceDims) return null;
      return {
        x: plannedMainSourceLayer.sourceCrop.x / plannedSourceDims.width,
        y: plannedMainSourceLayer.sourceCrop.y / plannedSourceDims.height,
        w: plannedMainSourceLayer.sourceCrop.width / plannedSourceDims.width,
        h: plannedMainSourceLayer.sourceCrop.height / plannedSourceDims.height,
      };
    }
    return speakerLayerCropRect(autoMainLayer, aspectRatio, sourceDims);
  }, [autoMainLayer, plannedMainSourceLayer, plannedSourceDims, sourceDims, aspectRatio]);
  const autoBottomCrop = useMemo((): SplitSecondaryTileCropRect | null => {
    if ((!autoBottomLayer && !plannedBottomSourceLayer) || !sourceDims) {
      return null;
    }
    const crop = plannedBottomSourceLayer
      ? {
          x: plannedBottomSourceLayer.sourceCrop.x / (plannedSourceDims?.width ?? sourceDims.width),
          y: plannedBottomSourceLayer.sourceCrop.y / (plannedSourceDims?.height ?? sourceDims.height),
          w: plannedBottomSourceLayer.sourceCrop.width / (plannedSourceDims?.width ?? sourceDims.width),
          h: plannedBottomSourceLayer.sourceCrop.height / (plannedSourceDims?.height ?? sourceDims.height),
        }
      : autoBottomLayer
        ? speakerLayerCropRect(autoBottomLayer, aspectRatio, sourceDims)
        : null;
    if (!crop || previewWidth <= 0 || previewHeight <= 0) return null;
    return {
      ...crop,
      tileWidthPx:
        previewWidth *
        (plannedBottomSourceLayer
          ? plannedBottomSourceLayer.destination.width /
            (compositionPreview?.canvas.width ?? 1)
          : autoBottomLayer?.frameWidth ?? 1),
      tileHeightPx:
        previewHeight *
        (plannedBottomSourceLayer
          ? plannedBottomSourceLayer.destination.height /
            (compositionPreview?.canvas.height ?? 1)
          : autoBottomLayer?.frameHeight ?? 0.5),
    };
  }, [aspectRatio, autoBottomLayer, compositionPreview, plannedBottomSourceLayer, plannedSourceDims, previewHeight, previewWidth, sourceDims]);

  // Screen packet C (PiP persistence — preview true facecam crop): once the
  // worker's analysis pass has run AND that render's own `decidePipUsage`
  // gate chain actually confirmed the rect (`layoutAnalysis.pipUsable ===
  // true` — C1, adversarial review), the screen bottom tile shows the TRUE
  // facecam crop instead of guessing a face-centered band. A non-null
  // `pipRect` alone is NOT sufficient: it's the PRE-GATE `selectPipRect`
  // output and can be a measured false positive the render itself rejected
  // (`face_not_in_rect`, `not_screencast_like`, etc.) — showing it
  // unconditionally would confidently render exactly the false positive the
  // render pipeline was built to catch. `null` (no analysis yet, analyzed-
  // but-not-usable, the envelope's window no longer matches this clip's
  // current boundaries — H2 below, not screen mode, the crop would be too
  // narrow to be worth it — H1 below, or the source/tile dimensions aren't
  // measured yet) means "nothing to show" — `SplitSecondaryTile` falls back
  // to exactly today's static `"50% 50%"` center-cover crop for that case,
  // so every one of those states degrades safely rather than rendering a
  // broken/blank tile.
  //
  // Render-is-truth note (screen packet C): previously ANY screen clip's
  // bottom tile was an approximation (static center, no face tracking
  // client-side) — the render pipeline was always the source of truth for
  // exact facecam framing. With a persisted, `pipUsable` PiP crop, the
  // preview and the render now agree (both run `fitPipCropToTile`/
  // `fitPipCropToTileNormalized` against the same rect and the same output
  // tile ratio) — divergence from here on is narrower and is spelled out in
  // full on `StudioContextValue.layoutAnalysis`'s own doc comment
  // (studio-shell.tsx): in-session staleness (a render that runs WHILE this
  // studio session is open updates the DB but not this already-fetched
  // context value until a refetch), and a genuinely PER-RENDER face-gate
  // outcome that can differ from what was true when this envelope was
  // written (rare — `faceConfirmed` is recomputed fresh every render, not
  // cached, so a persisted `pipUsable: true` is a snapshot of ONE past
  // render's outcome, not a permanent guarantee).
  const tileWidthPx = previewWidth;
  const tileHeightPx = previewHeight / 2;
  const screenBottomCropRect: SplitSecondaryTileCropRect | null = useMemo(() => {
    if (!isScreen) return null;
    // C1 (adversarial review): gate on `pipUsable`, never on `pipRect`'s
    // nullness alone — see this memo's own doc comment above.
    if (!layoutAnalysis || layoutAnalysis.pipUsable !== true) return null;
    const pipRect = layoutAnalysis.pipRect;
    if (!pipRect) return null;
    // H2 (adversarial review): the envelope's raw `clipStartSec`/`clipEndSec`
    // must still match this clip's CURRENT boundary window — same "the
    // window mismatch IS the invalidation" contract render-clips.ts's
    // `layoutAnalysisMatchesWindow` gives the render path, just checked
    // against the studio's own `clipWindow` (the raw window this session
    // knows about) since the client has no way to recompute
    // `resolveRenderTimingForClip`'s snapping. A trim since this analysis
    // was written must never show a crop measured against footage that's no
    // longer this clip's boundaries.
    const WINDOW_MATCH_EPSILON_SEC = 0.05;
    if (
      Math.abs(layoutAnalysis.clipStartSec - clipWindow.startSec) > WINDOW_MATCH_EPSILON_SEC ||
      Math.abs(layoutAnalysis.clipEndSec - clipWindow.endSec) > WINDOW_MATCH_EPSILON_SEC
    ) {
      return null;
    }
    if (!sourceDims) return null;
    if (tileWidthPx <= 0 || tileHeightPx <= 0) return null;
    const tileRatio = tileWidthPx / tileHeightPx;
    const fitted = fitPipCropToTileNormalized(pipRect, tileRatio, sourceDims);
    if (!fitted) return null;
    // H1 (adversarial review): client-side analogue of `decidePipUsage`'s
    // per-output `pip_too_small` gate — compares the fitted crop's SOURCE-
    // PIXEL width (not the tile's on-screen CSS width, which has no
    // relationship to the render's actual output resolution) against the
    // RENDER OUTPUT tile's own width for this clip's target aspect ratio.
    if (
      pipCropTooSmallNormalized(fitted.w, sourceDims.width, OUTPUT_TILE_WIDTH_PX[aspectRatio])
    ) {
      return null;
    }
    return { ...fitted, tileWidthPx, tileHeightPx };
  }, [isScreen, layoutAnalysis, sourceDims, tileWidthPx, tileHeightPx, clipWindow, aspectRatio]);

  const previewPhase: "generating" | "unavailable" | "loading" | "error" | "ready" =
    !previewVideoUrl && !useOriginalSourceFallback
      ? sourcePurged
        ? "unavailable"
        : "generating"
      : loadError
        ? "error"
        : videoLoaded
          ? "ready"
          : "loading";

  const autoMainVideoStyle = explicitCropVideoStyle(
    autoMainCrop,
    previewWidth * (autoMainLayer?.frameWidth ?? 1),
    previewHeight * (autoMainLayer?.frameHeight ?? (autoTwoUp ? 0.5 : 1)),
    previewPhase === "ready",
  );
  const plannedMainVideoStyle =
    plannedMainSourceLayer && plannedSourceDims && previewWidth > 0 && previewHeight > 0
      ? plannedCompositionVideoStyle(
          plannedMainSourceLayer,
          plannedSourceDims,
          {
            width:
              previewWidth *
              (plannedMainSourceLayer.destination.width /
                (compositionPreview?.canvas.width ?? 1)),
            height:
              previewHeight *
              (plannedMainSourceLayer.destination.height /
                (compositionPreview?.canvas.height ?? 1)),
          },
          previewPhase === "ready",
        )
      : null;
  const plannedSourceFrameStyle =
    plannedMainSourceLayer && compositionPreview
      ? plannedCompositionFrameStyle(
          plannedMainSourceLayer,
          compositionPreview.canvas,
        )
      : null;
  const plannedBottomFrameStyle =
    plannedBottomSourceLayer && compositionPreview
      ? plannedCompositionFrameStyle(
          plannedBottomSourceLayer,
          compositionPreview.canvas,
        )
      : null;

  useEffect(() => {
    if (
      compositionPlanControl[effectiveFramingMode] !== "shadow" ||
      !compositionPlanResult ||
      compositionPlanResult.status === "invalid"
    ) {
      return;
    }
    const target = compositionPlanResult.plan.targets[0];
    const plannedProjection = adoptCompositionPreview(
      compositionPlanResult.plan,
      aspectRatio,
      legacyActiveAutoSegment?.startSec ?? 0,
    );
    const targetFacts = clipAspectRatioOptions.find(
      (candidate) => candidate.value === aspectRatio,
    );
    if (!target || !targetFacts || !sourceDims) return;

    const legacyEffectiveMode =
      effectiveFramingMode === "auto"
        ? legacyActiveAutoSegment
          ? "auto"
          : "center"
        : effectiveFramingMode;
    const legacyBounds = legacyActiveAutoSegment
      ? {
          startSec: legacyActiveAutoSegment.startSec,
          endSec: legacyActiveAutoSegment.endSec,
        }
      : { startSec: 0, endSec: compositionPlanResult.plan.editedDurationSec };
    const staticLegacyGeometry = legacyObjectFitGeometry({
      source: sourceDims,
      target: targetFacts,
      fit: effectiveFramingMode === "fit" ? "contain" : "cover",
    });
    const stackedHeight = Math.round(targetFacts.height / 2);
    const legacySplitCrop = legacyObjectFitGeometry({
      source: sourceDims,
      target: { width: targetFacts.width, height: stackedHeight },
      fit: "cover",
    }).sourceCrop;
    const legacyScreenBottomCrop = screenBottomCropRect
      ? {
          x: Math.round(screenBottomCropRect.x * sourceDims.width),
          y: Math.round(screenBottomCropRect.y * sourceDims.height),
          width: Math.round(screenBottomCropRect.w * sourceDims.width),
          height: Math.round(screenBottomCropRect.h * sourceDims.height),
        }
      : legacySplitCrop;
    const legacySourceLayers =
      effectiveFramingMode === "auto" && legacySpeakerScene
        ? legacySpeakerScene.layers.map((layer, index) => {
            const normalizedCrop = speakerLayerCropRect(
              layer,
              aspectRatio,
              sourceDims,
            );
            const sourceCrop = normalizedCrop
              ? {
                  x: Math.round(normalizedCrop.x * sourceDims.width),
                  y: Math.round(normalizedCrop.y * sourceDims.height),
                  width: Math.round(normalizedCrop.w * sourceDims.width),
                  height: Math.round(normalizedCrop.h * sourceDims.height),
                }
              : staticLegacyGeometry.sourceCrop;
            return {
              kind: "source-video" as const,
              role: layer.role,
              zIndex: index,
              sourceCrop,
              destination: {
                x: Math.round(layer.frameX * targetFacts.width),
                y: Math.round(layer.frameY * targetFacts.height),
                width: Math.round(layer.frameWidth * targetFacts.width),
                height: Math.round(layer.frameHeight * targetFacts.height),
              },
              rotationDeg: layer.rotationDeg,
              backgroundColor: null,
              backgroundImage: false,
            };
          })
        : effectiveFramingMode === "split"
          ? [
              {
                kind: "source-video" as const,
                role: "top" as const,
                zIndex: 0,
                sourceCrop: { ...legacySplitCrop, x: 0 },
                destination: {
                  x: 0,
                  y: 0,
                  width: targetFacts.width,
                  height: stackedHeight,
                },
                rotationDeg: 0,
                backgroundColor: null,
                backgroundImage: false,
              },
              {
                kind: "source-video" as const,
                role: "bottom" as const,
                zIndex: 1,
                sourceCrop: {
                  ...legacySplitCrop,
                  x: sourceDims.width - legacySplitCrop.width,
                },
                destination: {
                  x: 0,
                  y: stackedHeight,
                  width: targetFacts.width,
                  height: stackedHeight,
                },
                rotationDeg: 0,
                backgroundColor: null,
                backgroundImage: false,
              },
            ]
          : effectiveFramingMode === "screen"
            ? [
                {
                  kind: "source-video" as const,
                  role: null,
                  zIndex: 0,
                  sourceCrop: {
                    x: 0,
                    y: 0,
                    width: sourceDims.width,
                    height: sourceDims.height,
                  },
                  destination: {
                    x: 0,
                    y: 0,
                    width: targetFacts.width,
                    height: stackedHeight,
                  },
                  rotationDeg: 0,
                  backgroundColor: null,
                  backgroundImage: false,
                },
                {
                  kind: "source-video" as const,
                  role: null,
                  zIndex: 1,
                  sourceCrop: legacyScreenBottomCrop,
                  destination: {
                    x: 0,
                    y: stackedHeight,
                    width: targetFacts.width,
                    height: stackedHeight,
                  },
                  rotationDeg: 0,
                  backgroundColor: null,
                  backgroundImage: false,
                },
              ]
            : [
            {
              kind: "source-video" as const,
              role: null,
              zIndex: effectiveFramingMode === "fit" ? 1 : 0,
              sourceCrop: staticLegacyGeometry.sourceCrop,
              destination: staticLegacyGeometry.destination,
              rotationDeg: 0,
              backgroundColor: null,
              backgroundImage: false,
            },
            ];
    const legacyLayers = [
      ...(effectiveFramingMode === "fit"
        ? [
            {
              kind: "background" as const,
              role: null,
              zIndex: 0,
              sourceCrop: null,
              destination: {
                x: 0,
                y: 0,
                width: targetFacts.width,
                height: targetFacts.height,
              },
              rotationDeg: 0,
              backgroundColor: background.color ?? "#000000",
              backgroundImage: Boolean(
                background.mode === "image" && background.imageUrl,
              ),
            },
          ]
        : []),
      ...legacySourceLayers,
    ];
    const plannedLayers = plannedProjection.layers.map((layer) => ({
      kind: layer.kind,
      role: layer.kind === "source-video" ? (layer.speaker?.role ?? null) : null,
      zIndex: layer.zIndex,
      sourceCrop: layer.kind === "source-video" ? layer.sourceCrop : null,
      destination: layer.destination,
      rotationDeg: layer.rotationDeg,
      backgroundColor: layer.kind === "background" ? layer.color : null,
      backgroundImage:
        layer.kind === "background" ? Boolean(layer.imageRef) : false,
    }));
    const topology = (layers: typeof plannedLayers) =>
      layers.map((layer) => `${layer.kind}:${layer.role ?? "none"}:${layer.zIndex}`);
    const layerPairs = plannedLayers.map((layer, index) => ({
      planned: layer,
      legacy: legacyLayers[index] ?? null,
    }));
    const comparison = {
      effectiveModeMismatch: target.effectiveMode !== legacyEffectiveMode,
      sceneBoundsMismatch:
        Math.abs(plannedProjection.sceneStartSec - legacyBounds.startSec) >
          0.075 ||
        Math.abs(plannedProjection.sceneEndSec - legacyBounds.endSec) > 0.075,
      layerTopologyMismatch:
        JSON.stringify(topology(plannedLayers)) !==
        JSON.stringify(topology(legacyLayers)),
      geometryMismatch:
        plannedLayers.length !== legacyLayers.length ||
        layerPairs.some(
          ({ planned, legacy }) =>
            !legacy ||
            rectsDiffer(planned.sourceCrop, legacy.sourceCrop) ||
            rectsDiffer(planned.destination, legacy.destination),
        ),
      rotationMismatch: layerPairs.some(
        ({ planned, legacy }) =>
          !legacy || Math.abs(planned.rotationDeg - legacy.rotationDeg) > 0.01,
      ),
      backgroundMismatch: layerPairs.some(
        ({ planned, legacy }) =>
          planned.kind === "background" &&
          (!legacy ||
            planned.backgroundColor !== legacy.backgroundColor ||
            planned.backgroundImage !== legacy.backgroundImage),
      ),
      noticeMismatch: plannedProjection.notices.length > 0,
    };
    const mismatchCount = Object.values(comparison).filter(Boolean).length;
    console.warn(
      JSON.stringify({
        level: "info",
        message: "clip_composition_shadow",
        adapter: "web",
        planVersion: compositionPlanResult.plan.version,
        planFingerprint: compositionPlanResult.plan.fingerprint,
        requestedMode: effectiveFramingMode,
        effectiveMode: target?.effectiveMode ?? null,
        legacy: {
          effectiveMode: legacyEffectiveMode,
          sceneBounds: legacyBounds,
          layers: legacyLayers,
          noticeCodes: [],
        },
        comparison,
        mismatchCount,
        target: target?.aspectRatio ?? aspectRatio,
        canvas: target?.canvas ?? null,
        scenes:
          target?.scenes.map((scene) => ({
            startSec: scene.startSec,
            endSec: scene.endSec,
            layers: scene.layers.map((candidate) => ({
              kind: candidate.kind,
              destination: candidate.destination,
              sourceCrop:
                candidate.kind === "source-video"
                  ? candidate.sourceCrop
                  : null,
            })),
          })) ?? [],
        plannedLayers,
        plannedNoticeCodes: plannedProjection.notices.map(
          (notice) => notice.code,
        ),
      }),
    );
  }, [
    aspectRatio,
    background.color,
    background.imageUrl,
    background.mode,
    compositionPlanResult,
    effectiveFramingMode,
    legacyActiveAutoSegment,
    legacySpeakerScene,
    screenBottomCropRect,
    sourceDims,
  ]);

  return (
    <Flex
      direction="column"
      h="100%"
      bg="studio.canvas"
      align="center"
      overflow="hidden"
    >
      {/* Controls bar */}
      <Flex
        w="100%"
        align="center"
        justify="center"
        gap="2"
        py="2.5"
        px="4"
        flexShrink={0}
        position="relative"
      >
        {/* Aspect ratio menu */}
        <Menu.Root
          onSelect={({ value }) => setAspectRatio(value as AspectRatio)}
          positioning={{ placement: "bottom" }}
        >
          <Menu.Trigger asChild>
            <Flex
              as="button"
              {...PILL_STYLES}
              _hover={{ bg: "studio.raised", color: "studio.fg" }}
              aria-label={`Change aspect ratio (current: ${arConfig.label})`}
              title="Change aspect ratio"
            >
              {arConfig.icon}
              {arConfig.label}
              <ChevronDown size={12} />
            </Flex>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content
                minW="140px"
                bg="studio.surface"
                borderWidth="1px"
                borderColor="studio.borderStrong"
                borderRadius="l2"
                boxShadow="cardHover"
                py="1"
              >
                {Object.entries(ASPECT_RATIO_CONFIG).map(([ratio, cfg]) => {
                  const isCurrent = aspectRatio === ratio;
                  return (
                    <Menu.Item
                      key={ratio}
                      value={ratio}
                      gap="2"
                      px="3"
                      py="2"
                      fontSize="12px"
                      color={isCurrent ? "studio.accentFg" : "studio.fg"}
                      bg={isCurrent ? "studio.raised" : "transparent"}
                      _hover={{ bg: "studio.raised" }}
                      _highlighted={{ bg: "studio.raised" }}
                      cursor="pointer"
                    >
                      {cfg.icon}
                      <Text fontSize="12px" textStyle="data">
                        {cfg.label}
                      </Text>
                    </Menu.Item>
                  );
                })}
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>

        {/* Layout mode (cycles fill → fit → blur) */}
        <Flex
          as="button"
          {...PILL_STYLES}
          _hover={{ bg: "studio.raised", color: "studio.fg" }}
          onClick={cycleLayout}
          title="Change layout for the selected scene"
          aria-label={`Change layout (current: ${layoutMode})`}
        >
          <Maximize2 size={12} />
          Layout: {layoutMode.charAt(0).toUpperCase() + layoutMode.slice(1)}
        </Flex>
      </Flex>

      {/* Video area */}
      <Box
        ref={containerRef}
        flex="1"
        w="100%"
        display="flex"
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
        bg="black"
        position="relative"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            deselectCaption();
            deselectTextLayer();
          }
        }}
      >
        {/* Video container with aspect ratio */}
        <Box
          ref={videoContainerRef}
          position="relative"
          style={{
            aspectRatio: `${videoW} / ${videoH}`,
            maxHeight: "100%",
            maxWidth: "100%",
            height: videoH > videoW ? "100%" : "auto",
            width: videoH <= videoW ? "100%" : "auto",
          }}
          bg={activeSpeakerScene?.overrideId ? "black" : "studio.subtle"}
          overflow="hidden"
          borderRadius="2px"
        >
          {/* Canvas background (vizard-parity Phase C item 2) — sits behind
              the (now letterboxed) video, filling the frame the crop would
              otherwise have covered. Persisted, so it wins over the
              session-local `layoutMode` blur/fill cosmetic below. */}
          {backgroundActive && (
            <Box position="absolute" inset="0" style={backgroundStageStyle} />
          )}

          {compositionNoticeText ? (
            <Flex
              position="absolute"
              top="8px"
              left="50%"
              transform="translateX(-50%)"
              zIndex={8}
              px="8px"
              py="4px"
              bg="studio.surface/92"
              borderWidth="1px"
              borderColor="studio.borderStrong"
              borderRadius="l1"
              color="studio.fgMuted"
              fontSize="10px"
              role="status"
              aria-live="polite"
              pointerEvents="none"
            >
              {compositionNoticeText}
            </Flex>
          ) : null}

          {/* Graphite ghost stage while no video is ready to show */}
          {previewPhase !== "ready" && (
            <Flex
              position="absolute"
              inset="0"
              bg="studio.subtle"
              align="center"
              justify="center"
            >
              <Flex
                direction="column"
                align="center"
                justify="center"
                gap="2"
                w="70%"
                maxW="240px"
                aspectRatio={videoW / videoH}
                borderWidth="1px"
                borderStyle="dashed"
                borderColor={previewPhase === "error" ? "studio.dangerBorder" : "studio.borderStrong"}
                borderRadius="l2"
                color="studio.fgSubtle"
                p="4"
              >
                {previewPhase === "generating" && (
                  <>
                    <Spinner size="sm" />
                    <Text fontSize="12px" color="studio.fgMuted">
                      Preview generating…
                    </Text>
                    <Text fontSize="11px" color="studio.fgSubtle" textAlign="center">
                      A lightweight preview is being cut for this clip — this
                      usually takes a minute or two.
                    </Text>
                    {sourceVideoUrl && (
                      <>
                        <Flex
                          as="button"
                          onClick={() => setUseOriginalSourceFallback(true)}
                          align="center"
                          gap="1.5"
                          px="10px"
                          h="28px"
                          borderRadius="l2"
                          borderWidth="1px"
                          borderColor="studio.borderStrong"
                          color="studio.fg"
                          fontSize="12px"
                          fontWeight="500"
                          cursor="pointer"
                          transition="background 120ms ease, border-color 120ms ease"
                          _hover={{ bg: "studio.raised", borderColor: "studio.fgSubtle" }}
                        >
                          Use original source instead
                        </Flex>
                        <Text fontSize="10px" color="studio.fgSubtle" textAlign="center">
                          Can be slow to load for long sources.
                        </Text>
                      </>
                    )}
                  </>
                )}

                {previewPhase === "unavailable" && (
                  <>
                    <Monitor size={28} strokeWidth={1.5} />
                    <Text fontSize="12px" color="studio.fgMuted">
                      Preview unavailable
                    </Text>
                    <Text fontSize="11px" color="studio.fgSubtle" textAlign="center">
                      This project&rsquo;s source video has been removed, so a
                      preview can no longer be generated for this clip.
                    </Text>
                  </>
                )}

                {previewPhase === "loading" && (
                  <>
                    <Spinner size="sm" />
                    <Text fontSize="12px" color="studio.fgMuted">
                      Preparing preview…
                    </Text>
                    <Box w="72%" h="3px" bg="studio.raised" borderRadius="full" overflow="hidden">
                      <Box
                        h="full"
                        bg="studio.accent"
                        borderRadius="full"
                        w={`${Math.max(bufferedFraction * 100, 4)}%`}
                        animation="meter-fill"
                      />
                    </Box>
                    {isStalled && (
                      <Text fontSize="11px" color="studio.fgSubtle" textAlign="center">
                        Connection stalled — waiting to resume…
                      </Text>
                    )}
                    {!isStalled && slowLoadHint && (
                      <Text fontSize="11px" color="studio.fgSubtle" textAlign="center">
                        Still loading — large source
                      </Text>
                    )}
                  </>
                )}

                {previewPhase === "error" && (
                  <>
                    <Flex color="studio.danger" align="center" justify="center">
                      <AlertTriangle size={24} strokeWidth={1.5} aria-hidden />
                    </Flex>
                    <Text fontSize="12px" color="studio.danger" textAlign="center">
                      Couldn&rsquo;t load the video preview
                    </Text>
                    <Flex
                      as="button"
                      onClick={handleRetry}
                      align="center"
                      gap="1.5"
                      px="10px"
                      h="28px"
                      borderRadius="l2"
                      borderWidth="1px"
                      borderColor="studio.borderStrong"
                      color="studio.fg"
                      fontSize="12px"
                      fontWeight="500"
                      cursor="pointer"
                      transition="background 120ms ease, border-color 120ms ease"
                      _hover={{ bg: "studio.raised", borderColor: "studio.fgSubtle" }}
                    >
                      <RotateCcw size={12} />
                      Retry
                    </Flex>
                  </>
                )}
              </Flex>
            </Flex>
          )}

          {/* Actual video element(s) — three stage layouts share this one
              wrapper position: (1) fill/fit/blur/auto/center — a single
              full-height video, styled per `videoObjectFit`/`layoutMode`;
              (2) split packet C — a stacked 2-up where the top tile is a
              cropped-to-fill (`cover`) seat; (3) screen packet C — also a
              stacked 2-up, but the top tile is the full source frame
              letterboxed UNCROPPED (`contain`, against its own black
              backdrop) rather than cropped, since "screen" means the shared
              window/slide/app itself must stay fully visible up top. In
              every case the TOP tile deliberately reuses the SAME
              main `<video>` DOM node the single-video path
              renders (just restyled/clipped) rather than introducing a
              second element for it — that keeps every existing contract
              that targets the browser media adapter untouched: it remains
              the sole playback driver and audio source, regardless of how
              the element is positioned.
              The wrapper Box below is unconditionally present at this same
              JSX position across ALL THREE branches (only its inline style
              varies by `isSplit`/`isScreen`) specifically so React never
              unmounts the video element when framing mode changes — a
              real, considered risk here: if the wrapper only existed in
              some branches, switching between them would swap in a
              structurally different subtree, forcing React to tear down
              and recreate the `<video>` node, which would silently drop
              its loaded `src`/buffered state until some unrelated effect
              happened to re-run. Only the BOTTOM tile is a genuinely new
              secondary element (SplitSecondaryTile, shared by both split
              and screen) — see its own file for why it's muted and merely
              drift-corrected rather than clock-driving. */}
          <Box
            style={
              plannedSourceFrameStyle ?? (autoMainLayer
                ? speakerFrameStyle(autoMainLayer)
                : {
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: isStacked ? "50%" : 0,
                  })
            }
            overflow="visible"
            zIndex={
              autoMainLayer && selectedSpeakerRole === autoMainLayer.role ? 6 : 1
            }
            borderBottomWidth={isStacked ? "1px" : "0"}
            borderColor="studio.border"
            bg={isScreen ? "black" : undefined}
          >
            <Box position="absolute" inset="0" overflow="hidden">
              {/* biome-ignore lint/a11y/useMediaCaption: captions render via the separate interactive caption overlay; the raw video has no VTT track source to attach. */}
              <video
                ref={attachMainVideo}
                style={
                  plannedMainVideoStyle ?? autoMainVideoStyle ?? {
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: isSplit ? "cover" : isScreen ? "contain" : videoObjectFit,
                    objectPosition: isSplit ? `${SPLIT_TOP_TILE_CX * 100}% 50%` : undefined,
                    display: previewPhase === "ready" ? "block" : "none",
                  }
                }
                playsInline
                preload="metadata"
                onLoadedMetadata={handleLoadedMetadata}
                onError={handleVideoError}
                onStalled={handleVideoStalled}
                onProgress={handleVideoProgress}
              />
            </Box>
            {activeSpeakerScene && autoMainLayer ? (
              <InteractiveSpeakerLayer
                layer={autoMainLayer}
                canvasRef={videoContainerRef}
                selected={selectedSpeakerRole === autoMainLayer.role}
                onSelect={() => selectSpeakerLayer(autoMainLayer.role)}
                onChange={updateSpeakerLayer}
                onGestureEnd={endCoalesce}
                onReset={() => resetActiveSpeakerLayer(autoMainLayer.role)}
              />
            ) : null}
          </Box>

          {isStacked && activeVideoUrl && (
            <Box
              style={
                plannedBottomFrameStyle ?? (autoBottomLayer
                  ? speakerFrameStyle(autoBottomLayer)
                  : {
                      position: "absolute",
                      top: "50%",
                      left: 0,
                      right: 0,
                      bottom: 0,
                    })
              }
              overflow="visible"
              zIndex={
                autoBottomLayer && selectedSpeakerRole === autoBottomLayer.role
                  ? 6
                  : 1
              }
            >
              <Box position="absolute" inset="0" overflow="hidden">
                <SplitSecondaryTile
                  src={activeVideoUrl}
                  isPlaying={isPlaying}
                  targetTimeSec={secondaryTileTargetTimeSec}
                  objectFit="cover"
                  objectPosition={isSplit ? `${SPLIT_BOTTOM_TILE_CX * 100}% 50%` : "50% 50%"}
                  // Screen packet C: `cropRect` is only ever computed for
                  // screen mode (see `screenBottomCropRect`'s own `isScreen`
                  // guard) — split always stays on the `objectFit`/
                  // `objectPosition` path above via this always-null value.
                  cropRect={
                    plannedBottomSourceLayer
                      ? autoBottomCrop
                      : autoTwoUp
                      ? autoBottomCrop
                      : isScreen
                        ? screenBottomCropRect
                        : null
                  }
                  visible={previewPhase === "ready"}
                  mainVideoRef={mainVideoRef}
                />
              </Box>
              {activeSpeakerScene && autoBottomLayer ? (
                <InteractiveSpeakerLayer
                  layer={autoBottomLayer}
                  canvasRef={videoContainerRef}
                  selected={selectedSpeakerRole === autoBottomLayer.role}
                  onSelect={() => selectSpeakerLayer(autoBottomLayer.role)}
                  onChange={updateSpeakerLayer}
                  onGestureEnd={endCoalesce}
                  onReset={() => resetActiveSpeakerLayer(autoBottomLayer.role)}
                />
              ) : null}
            </Box>
          )}

          {brollUrl && brollWindow && brollActive ? (
            <BrollPreviewLayer
              src={brollUrl}
              poster={activeBrollAsset?.posterUrl ?? null}
              window={brollWindow}
              currentTime={currentTime}
              isPlaying={isPlaying}
              onDuration={handleBrollDuration}
            />
          ) : null}

          {/* Hidden background-music preview track — decorative render-parity
              bed, no user-facing controls; play/pause, looped offset
              seeking, and volume/fade ramps are all driven by the effects
              above off the shared playback clock. */}
          {musicSrc ? (
            // biome-ignore lint/a11y/useMediaCaption: decorative background music preview with no dialogue/captions of its own — the clip's own captions already cover spoken content via the interactive caption overlay.
            <audio
              ref={musicAudioRef}
              src={musicSrc}
              loop
              preload="auto"
              style={{ display: "none" }}
            />
          ) : null}

          {/* One-shot SFX placements (vizard-parity.md "Music/SFX library") —
              best-effort preview, see sfx-preview-track.tsx. Keyed on the
              placement's own stable id (not a resolution-version suffix,
              L7): SfxPreviewTrack's volume effect now depends on `src`
              directly, so a newly-resolved (or re-picked) URL updates the
              SAME mounted instance instead of needing a full remount to
              pick up the new value. The re-render itself still comes from
              `setSfxUrlVersion` bumping above; only the forced remount was
              redundant. */}
          {studioEdits.sfx.map((placement) => (
            <SfxPreviewTrack
              key={placement.id}
              placement={placement}
              src={sfxUrlCacheRef.current[placement.assetId] ?? null}
              isPlaying={isPlaying}
              currentTime={currentTime}
            />
          ))}

          {/* Layout blur layer — a persisted background overrides this
              cosmetic entirely (see backgroundActive above), and so do
              split and screen: each tile's crop/letterbox already fully
              determines its framing, so there's no single-video
              fill/fit/blur state left to cosmetically blur behind. */}
          {!backgroundActive && !isSplit && !isScreen && layoutMode === "blur" && (
            <Box
              position="absolute"
              inset="0"
              bg="rgba(0,0,0,0.4)"
              backdropFilter="blur(20px)"
            />
          )}

          {studioEdits.textLayers.map((layer) => {
            const endSec = layer.endSec ?? Number.POSITIVE_INFINITY;
            if (currentTime < layer.startSec || currentTime > endSec) return null;

            return (
              <InteractiveTextLayer
                key={layer.id}
                layer={layer}
                previewWidth={previewWidth}
                videoContainerRef={videoContainerRef}
              />
            );
          })}

          {/* Interactive caption overlay */}
          <InteractiveCaptionOverlay videoContainerRef={videoContainerRef} />

          {/* Brand logo overlay — burns in on top of everything else
              (captions, text layers) at render time (buildLogoFilter
              overlays [outvbase] last in render-clips.ts), so it renders
              last here too. Waits for a real measured previewWidth so
              first paint never flashes a 0-sized/mispositioned logo. */}
          {brandLogo && effectiveLogo?.enabled && previewWidth > 0 ? (
            <img
              src={brandLogo.url}
              alt=""
              aria-hidden="true"
              style={{
                ...logoPositionStyle(effectiveLogo.position, previewWidth * LOGO_MARGIN_FRACTION),
                width: `${previewWidth * (effectiveLogo.scalePct / 100)}px`,
                height: "auto",
                opacity: effectiveLogo.opacity / 100,
                zIndex: 25,
                pointerEvents: "none",
              }}
            />
          ) : null}
        </Box>
      </Box>
    </Flex>
  );
}
