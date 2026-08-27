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
  type CompositionBrollVideoLayer,
  type CompositionCaptionVisualLayer,
  type CompositionLogoVisualLayer,
  type CompositionOutputTreatmentVisualLayer,
  type CompositionSourceVideoLayer,
  type CompositionTextVisualLayer,
  type CompositionTransitionVisualLayer,
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
  clipAspectRatioOptions,
  editedToSource,
  resolveEffectiveFramingMode,
  resolveEffectiveLogoSettings,
  SCREEN_LAYOUT_ENGINE_VERSION,
  speakerLayoutOverrideFromScene,
  type LogoPosition,
  type SpeakerLayerRole,
  type SpeakerLayerTransform,
  type ResolvedSpeakerLayoutScene,
} from "@narriflow/validators";
import { useStudio } from "./studio-shell";
import type { AspectRatio, LayoutMode } from "./studio-shell";
import { InteractiveCaptionOverlay } from "./interactive-caption-overlay";
import { hexToRgba } from "./caption-style-engine";
import { InteractiveTextLayer } from "./interactive-text-layer";
import { SfxPreviewTrack } from "./sfx-preview-track";
import { SplitSecondaryTile, type SplitSecondaryTileCropRect } from "./split-secondary-tile";
import type { NormalizedCropRect } from "./normalized-crop";
import {
  resetSpeakerLayerTransform,
  speakerLayerCropRect,
} from "./auto-layout-preview";
import { InteractiveSpeakerLayer } from "./interactive-speaker-layer";
import {
  brollPreviewLocalTime,
  manualBrollPreviewWindow,
  type ManualBrollPreviewWindow,
} from "./broll-preview";
import {
  adoptCompositionPreviewResult,
  compositionInvalidText,
  compositionNoticeEntries,
  manualBrollAvailabilityForPlan,
  plannedCompositionFrameStyle,
  plannedCompositionAudioState,
  plannedCompositionSourceDimensions,
  plannedCompositionUsesStackedStage,
  plannedCompositionVideoStyle,
} from "./composition-preview-adapter";
import { compositionCapabilities } from "./composition-capabilities";
import {
  adoptResolvedAudioAssets,
  reconcileSelectedAudioAssets,
  type PreviewAudioAssetResolutionMap,
} from "./preview-audio-asset-resolution";

/** After this long with no metadata yet, hint that the source is just large. */
const SLOW_LOAD_HINT_MS = 10_000;

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
  onAvailabilityChange,
}: {
  src: string;
  poster: string | null;
  window: ManualBrollPreviewWindow;
  currentTime: number;
  isPlaying: boolean;
  onDuration: (durationSec: number) => void;
  onAvailabilityChange: (state: "available" | "failed") => void;
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
          onAvailabilityChange("available");
          const durationSec = event.currentTarget.duration;
          if (Number.isFinite(durationSec) && durationSec > 0) {
            onDuration(durationSec);
          }
          event.currentTarget.currentTime = Math.min(
            localTime,
            Math.max(0, durationSec - 0.05),
          );
        }}
        onError={() => onAvailabilityChange("failed")}
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
    setSourceAudioEnvelope,
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
    deselectCaption,
    deselectTextLayer,
    captionSelected,
    selectedTextLayerId,
    setStudioEdits,
    endCoalesce,
    isPlaying,
    duration,
    brandLogo,
    layoutAnalysis,
    layoutAnalysisFailure,
    autoLayoutAnalysis,
    splitLayoutAnalysis,
    splitLayoutFailure,
    autoLayoutAnalysisStatus,
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
  // The rendered preview height is needed to map plan destinations to CSS.
  const [previewHeight, setPreviewHeight] = useState(0);
  const [selectedSpeakerRole, setSelectedSpeakerRole] =
    useState<SpeakerLayerRole | null>(null);
  // Source dimensions are captured from loadedmetadata and feed the same
  // plan geometry used by export.
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
  // studioEdits, so resolving it can't dirty the document. The explicit
  // pending/failed states keep the plan honest while access is refreshed.
  const [musicAssetResolution, setMusicAssetResolution] = useState<
    | { assetId: string; state: "pending" | "failed" }
    | {
        assetId: string;
        state: "available";
        url: string;
        durationSec: number;
      }
    | null
  >(null);
  // Same id -> playback-url resolution for SFX placements, batched per
  // unique assetId. These URLs are preview-only and never dirty the editor
  // document.
  const [sfxAssetResolutions, setSfxAssetResolutions] =
    useState<PreviewAudioAssetResolutionMap>({});
  const sfxAssetResolutionsRef = useRef(sfxAssetResolutions);
  useEffect(() => {
    sfxAssetResolutionsRef.current = sfxAssetResolutions;
  }, [sfxAssetResolutions]);
  const sfxAssetIdsKey = useMemo(
    () =>
      Array.from(new Set(studioEdits.sfx.map((placement) => placement.assetId)))
        .sort()
        .join("\n"),
    [studioEdits.sfx],
  );
  const availableMusicAsset =
    musicAssetResolution?.assetId === studioEdits.music.assetId &&
    musicAssetResolution.state === "available"
      ? musicAssetResolution
      : null;
  const musicSrc = studioEdits.music.assetId
    ? availableMusicAsset?.url ?? null
    : studioEdits.music.url;
  const [musicMetadata, setMusicMetadata] = useState<{
    src: string;
    durationSec: number;
  } | null>(null);
  const [failedMusicSrc, setFailedMusicSrc] = useState<string | null>(null);
  const musicDurationSec =
    availableMusicAsset?.durationSec ??
    (musicMetadata?.src === musicSrc ? musicMetadata.durationSec : undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected music identity explicitly resets terminal media failure state.
  useEffect(() => {
    setFailedMusicSrc(null);
  }, [studioEdits.music.assetId, studioEdits.music.url]);
  const arConfig = ASPECT_RATIO_CONFIG[aspectRatio];
  const activeBrollAsset =
    brollPreviewAsset?.url === brollUrl ? brollPreviewAsset : null;
  const [brollMediaProbe, setBrollMediaProbe] = useState<{
    url: string | null;
    state: "pending" | "available" | "failed";
  }>({ url: null, state: "pending" });
  const brollMediaState = !brollUrl
    ? "missing"
    : brollMediaProbe.url === brollUrl
      ? brollMediaProbe.state
      : "pending";
  const handleBrollAvailability = useCallback(
    (state: "available" | "failed") => {
      if (brollUrl) setBrollMediaProbe({ url: brollUrl, state });
    },
    [brollUrl],
  );
  const brollWindow = useMemo(
    () =>
      brollUrl
        ? manualBrollPreviewWindow(duration, activeBrollAsset?.durationSec)
        : null,
    [activeBrollAsset?.durationSec, brollUrl, duration],
  );
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
  // worker composition compiler exactly (scale-to-contain,
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
  const splitEngineVersion = "explicit-split-v1";
  const screenEngineVersion = SCREEN_LAYOUT_ENGINE_VERSION;
  const splitFingerprint = splitLayoutInputFingerprint({
    sourceIdentity: compositionSourceIdentity,
    clipStartSec: editorDocument.clipStartSec,
    clipEndSec: editorDocument.clipEndSec,
    deletedRanges: editorDocument.deletedRanges,
    engineVersion: splitEngineVersion,
  });
  const screenFingerprint = screenLayoutInputFingerprint({
    sourceIdentity: compositionSourceIdentity,
    clipStartSec: editorDocument.clipStartSec,
    clipEndSec: editorDocument.clipEndSec,
    deletedRanges: editorDocument.deletedRanges,
    engineVersion: screenEngineVersion,
  });
  const eligibleAutoLayoutAnalysis =
    autoLayoutAnalysis?.sourceIdentity === compositionSourceIdentity
      ? autoLayoutAnalysis
      : null;
  const automaticLayoutAnalysis =
    eligibleAutoLayoutAnalysis?.engine === "shot-layout-v1"
      ? eligibleAutoLayoutAnalysis
      : null;
  const eligibleSplitLayoutAnalysis =
    splitLayoutAnalysis?.sourceIdentity === compositionSourceIdentity
      ? splitLayoutAnalysis
      : null;
  const exactScreenLayoutAnalysis =
    layoutAnalysis?.version === 2 &&
    layoutAnalysis.sourceIdentity === compositionSourceIdentity &&
    layoutAnalysis.inputFingerprint === screenFingerprint
      ? layoutAnalysis
      : null;
  const exactSplitLayoutFailure =
    splitLayoutFailure?.sourceIdentity === compositionSourceIdentity &&
    splitLayoutFailure.inputFingerprint === splitFingerprint
      ? splitLayoutFailure
      : null;
  const exactScreenLayoutFailure =
    layoutAnalysisFailure?.sourceIdentity === compositionSourceIdentity &&
    layoutAnalysisFailure.inputFingerprint === screenFingerprint
      ? layoutAnalysisFailure
      : null;
  const compositionSourceDims = useMemo(() => {
    if (!sourceDims) return null;
    const durableDimensions =
      effectiveFramingMode === "screen"
        ? exactScreenLayoutAnalysis
        : effectiveFramingMode === "split"
          ? eligibleSplitLayoutAnalysis
          : automaticLayoutAnalysis;
    return plannedCompositionSourceDimensions(sourceDims, durableDimensions);
  }, [
    automaticLayoutAnalysis,
    effectiveFramingMode,
    eligibleSplitLayoutAnalysis,
    exactScreenLayoutAnalysis,
    sourceDims,
  ]);
  const soundEffectAvailability = useMemo(
    () =>
      Object.fromEntries(
        studioEdits.sfx.map((placement) => {
          const resolution = sfxAssetResolutions[placement.assetId];
          return [
            placement.id,
            resolution?.state === "available"
              ? {
                  state: "available" as const,
                  ref: compositionAssetRef("sound-effect", placement.assetId),
                  durationSec: resolution.durationSec,
                }
              : resolution?.state === "failed"
                ? { state: "failed" as const }
                : { state: "pending" as const },
          ];
        }),
      ),
    [sfxAssetResolutions, studioEdits.sfx],
  );
  const compositionPlanResult = useMemo(() => {
    if (!compositionSourceDims) return null;
    const target = clipAspectRatioOptions.find(
      (option) => option.value === aspectRatio,
    );
    if (!target) return null;
    return planClipComposition({
      document: editorDocument,
      source: {
        identity: compositionSourceIdentity,
        kind: clipInfo.sourceKind,
        width: clipInfo.sourceKind === "audio" ? 0 : compositionSourceDims.width,
        height: clipInfo.sourceKind === "audio" ? 0 : compositionSourceDims.height,
        hasAudio: true,
      },
      evidence: {
        automaticLayout: !compositionCapabilities.automaticSpeakerLayoutEnabled
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
        splitLayout: eligibleSplitLayoutAnalysis
          ? {
              state: "available",
              value: {
                sourceIdentity: compositionSourceIdentity,
                inputFingerprint: splitLayoutInputFingerprint({
                  sourceIdentity: compositionSourceIdentity,
                  clipStartSec: eligibleSplitLayoutAnalysis.clipStartSec,
                  clipEndSec: eligibleSplitLayoutAnalysis.clipEndSec,
                  deletedRanges: eligibleSplitLayoutAnalysis.deletedRanges,
                  engineVersion: splitEngineVersion,
                }),
                engineVersion: splitEngineVersion,
                source: "explicit-detector",
                segments: eligibleSplitLayoutAnalysis.segments,
                fallbackSegments: eligibleSplitLayoutAnalysis.noSplitSegments,
              },
            }
          : exactSplitLayoutFailure
            ? { state: "failed", reason: exactSplitLayoutFailure.reason }
          : {
              state: "missing",
            },
        screenLayout:
          exactScreenLayoutAnalysis
            ? {
                state: "available",
                value: {
                  sourceIdentity: compositionSourceIdentity,
                  inputFingerprint: exactScreenLayoutAnalysis.inputFingerprint,
                  engineVersion: screenEngineVersion,
                  source: "durable-pip",
                  pictureInPicture:
                    exactScreenLayoutAnalysis.pipUsable &&
                    exactScreenLayoutAnalysis.pipRect
                      ? {
                          state: "confirmed",
                          rect: {
                            x: exactScreenLayoutAnalysis.pipRect.x,
                            y: exactScreenLayoutAnalysis.pipRect.y,
                            width: exactScreenLayoutAnalysis.pipRect.w,
                            height: exactScreenLayoutAnalysis.pipRect.h,
                          },
                        }
                      : { state: "unavailable" },
                  faceBand: exactScreenLayoutAnalysis.faceBandSegments
                    ? {
                        state: "available",
                        segments: exactScreenLayoutAnalysis.faceBandSegments,
                      }
                    : { state: "unavailable" },
                },
            }
            : exactScreenLayoutFailure
              ? { state: "failed", reason: exactScreenLayoutFailure.reason }
              : { state: "missing" },
      },
      assets: {
        backgroundImage: backgroundImageAvailability,
        ...(studioEdits.music.assetId || studioEdits.music.url
          ? {
              music: studioEdits.music.assetId
                ? availableMusicAsset
                  ? {
                        state: "available" as const,
                        ref: compositionAssetRef(
                          "music",
                          studioEdits.music.assetId,
                        ),
                        durationSec: availableMusicAsset.durationSec,
                      }
                  : musicAssetResolution?.assetId === studioEdits.music.assetId &&
                      musicAssetResolution.state === "failed"
                    ? { state: "failed" as const }
                    : { state: "pending" as const }
                : musicSrc && failedMusicSrc !== musicSrc
                  ? {
                    state: "available" as const,
                    ref: compositionAssetRef(
                      "music",
                      musicSrc,
                    ),
                    durationSec: musicDurationSec,
                  }
                  : { state: "failed" as const },
            }
          : {}),
        soundEffects: soundEffectAvailability,
        ...(brollUrl
          ? {
              broll: manualBrollAvailabilityForPlan({
                url: brollUrl,
                ref: compositionAssetRef("broll", brollUrl),
                window: brollWindow,
                mediaState: brollMediaState,
              }),
            }
          : {}),
        ...(brandLogo && effectiveLogo
          ? brandLogo.url
            ? {
                logo: {
                  state: "available" as const,
                  ref: brandLogo.ref,
                  settings: effectiveLogo,
                },
              }
            : { logo: { state: "failed" as const } }
          : {}),
      },
      capabilities: {
        automaticSpeakerLayout:
          compositionCapabilities.automaticSpeakerLayoutEnabled,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        explicitSplitLayout:
          compositionCapabilities.explicitSplitLayoutEnabled,
        splitEngineVersion,
        screenLayout: compositionCapabilities.screenLayoutEnabled,
        screenEngineVersion,
      },
      targets: [
        {
          id: aspectRatio,
          aspectRatio,
          width: target.width,
          height: target.height,
          outputTreatment: {
            resolution: clipInfo.can1080pExport ? "1080p" : "720p",
            watermark: clipInfo.exportHasWatermark,
          },
        },
      ],
    });
  }, [
    aspectRatio,
    backgroundImageAvailability,
    compositionSourceIdentity,
    editorDocument,
    automaticLayoutAnalysis,
    brollUrl,
    brollMediaState,
    brollWindow,
    brandLogo,
    effectiveLogo,
    clipInfo.can1080pExport,
    clipInfo.exportHasWatermark,
    clipInfo.sourceKind,
    musicSrc,
    availableMusicAsset,
    musicAssetResolution,
    failedMusicSrc,
    musicDurationSec,
    soundEffectAvailability,
    studioEdits.music.assetId,
    studioEdits.music.url,
    eligibleSplitLayoutAnalysis,
    autoLayoutAnalysisStatus,
    exactScreenLayoutAnalysis,
    exactScreenLayoutFailure,
    exactSplitLayoutFailure,
    compositionSourceDims,
  ]);
  const compositionPreview = useMemo(() => {
    if (compositionPlanResult?.status === "invalid") return null;
    return adoptCompositionPreviewResult(
      compositionPlanResult,
      aspectRatio,
      currentTime,
    );
  }, [aspectRatio, compositionPlanResult, currentTime]);
  const plannedAudioState = useMemo(
    () =>
      compositionPlanResult && compositionPlanResult.status !== "invalid"
        ? plannedCompositionAudioState(
            compositionPlanResult.plan.audioSchedule,
            currentTime,
          )
        : null,
    [compositionPlanResult, currentTime],
  );
  const plannedSourceLayers = useMemo(
    () =>
      compositionPreview?.layers.filter(
        (layer): layer is CompositionSourceVideoLayer =>
          layer.kind === "source-video",
      ) ?? [],
    [compositionPreview],
  );
  useEffect(() => {
    setSourceAudioEnvelope(plannedAudioState?.source.outputGain ?? 1);
  }, [plannedAudioState?.source.outputGain, setSourceAudioEnvelope]);
  useEffect(
    () => () => setSourceAudioEnvelope(1),
    [setSourceAudioEnvelope],
  );
  const plannedBackgroundLayer = compositionPreview?.layers.find(
    (layer): layer is CompositionBackgroundLayer => layer.kind === "background",
  );
  const plannedBrollLayer = compositionPreview?.layers.find(
    (layer): layer is CompositionBrollVideoLayer =>
      layer.kind === "broll-video",
  );
  const activeBrollWindow = plannedBrollLayer?.activeRange ?? null;
  const brollActive = Boolean(plannedBrollLayer);
  const plannedTextLayers = compositionPreview?.layers.filter(
    (layer): layer is CompositionTextVisualLayer => layer.kind === "text",
  ) ?? [];
  const plannedCaptionLayer = compositionPreview?.layers.find(
    (layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption",
  );
  const plannedLogoLayer = compositionPreview?.layers.find(
    (layer): layer is CompositionLogoVisualLayer => layer.kind === "logo",
  );
  const plannedTransitionLayer = compositionPreview?.layers.find(
    (layer): layer is CompositionTransitionVisualLayer =>
      layer.kind === "transition",
  );
  const plannedOutputTreatment = compositionPreview?.layers.find(
    (layer): layer is CompositionOutputTreatmentVisualLayer =>
      layer.kind === "output-treatment",
  );
  const transitionOverlayOpacity = (() => {
    if (!plannedTransitionLayer) return 0;
    const { fadeIn, fadeOut } = plannedTransitionLayer.windows;
    if (currentTime <= fadeIn.endSec) {
      const durationSec = Math.max(0.001, fadeIn.endSec - fadeIn.startSec);
      return Math.max(0, Math.min(1, 1 - (currentTime - fadeIn.startSec) / durationSec));
    }
    if (currentTime >= fadeOut.startSec) {
      const durationSec = Math.max(0.001, fadeOut.endSec - fadeOut.startSec);
      return Math.max(0, Math.min(1, (currentTime - fadeOut.startSec) / durationSec));
    }
    return 0;
  })();
  const plannedSourceDims = compositionPlanResult?.status === "invalid"
    ? null
    : compositionPlanResult?.plan.source ?? null;
  const compositionNoticeItems = compositionPreview
    ? compositionNoticeEntries(compositionPreview.notices, {
        requestedMode: compositionPreview.requestedMode,
        effectiveMode: compositionPreview.effectiveMode,
      })
    : [];
  const compositionInvalidTextValue =
    compositionPlanResult?.status === "invalid"
      ? compositionInvalidText(compositionPlanResult.error.code)
      : null;
  const compositionStatusItems = compositionInvalidTextValue
    ? [{ key: "invalid-composition", text: compositionInvalidTextValue }]
    : compositionNoticeItems;
  const backgroundActive =
    effectiveFramingMode === "fit" && clipInfo.sourceKind === "video";
  // resolveEffectiveFramingMode makes background and split/screen mutually
  // exclusive (background always wins as "fit"), so `isSplit`/`isScreen`
  // only ever read true here while `backgroundActive` is false — never read
  // `studioEdits.framing.mode` directly, per the panel/schema doc comments.
  const isSplit = Boolean(
    compositionPreview?.effectiveMode === "split" &&
      plannedCompositionUsesStackedStage(compositionPreview),
  );
  const isScreen = compositionPreview?.effectiveMode === "screen";
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
  const activeSpeakerScene = plannedSpeakerScene;
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

      if (plannedSourceLayers.length === 0) return previous;
      const defaults = {
        ...activeSpeakerScene,
        overrideId: null,
        layers: plannedSourceLayers.map((layer) => ({
          ...layer.speaker!.defaultTransform,
        })),
      };
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
  }, [activeSpeakerScene, aspectRatio, endCoalesce, plannedSourceLayers, setStudioEdits]);

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
  // NOT write the result into `studioEdits`; this is purely a preview-side
  // lookup whose pending/failed state feeds the shared plan.
  useEffect(() => {
    const assetId = studioEdits.music.assetId;
    if (!assetId) {
      setMusicAssetResolution(null);
      return;
    }
    let canceled = false;
    setMusicAssetResolution({ assetId, state: "pending" });
    fetch(`/api/audio-assets/${assetId}/playback-url`)
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{ url?: string; durationSec?: number }>)
          : null,
      )
      .then((data) => {
        if (!canceled && data?.url && data.durationSec && data.durationSec > 0) {
          setMusicAssetResolution({
            assetId,
            state: "available",
            url: data.url,
            durationSec: data.durationSec,
          });
        } else if (!canceled) {
          setMusicAssetResolution({ assetId, state: "failed" });
        }
      })
      .catch(() => {
        if (!canceled) {
          setMusicAssetResolution({ assetId, state: "failed" });
        }
      });
    return () => {
      canceled = true;
    };
  }, [studioEdits.music.assetId]);

  // Same stale-presign resolution for SFX placements, batched by unique
  // assetId so N placements sharing one asset cost one request each, not N.
  useEffect(() => {
    const assetIds = sfxAssetIdsKey ? sfxAssetIdsKey.split("\n") : [];
    const currentResolutions = sfxAssetResolutionsRef.current;
    const missingIds = assetIds.filter((id) => !(id in currentResolutions));
    setSfxAssetResolutions((current) =>
      reconcileSelectedAudioAssets(current, assetIds),
    );
    if (missingIds.length === 0) return;
    void Promise.all(
      missingIds.map(async (id) => {
        try {
          const res = await fetch(`/api/audio-assets/${id}/playback-url`);
          if (!res.ok) return [id, { state: "failed" as const }] as const;
          const data = (await res.json()) as {
            url?: string;
            durationSec?: number;
          };
          return data.url && data.durationSec && data.durationSec > 0
            ? ([
                id,
                {
                  state: "available" as const,
                  url: data.url,
                  durationSec: data.durationSec,
                },
              ] as const)
            : ([id, { state: "failed" as const }] as const);
        } catch {
          return [id, { state: "failed" as const }] as const;
        }
      }),
    ).then((entries) => {
      setSfxAssetResolutions((current) =>
        adoptResolvedAudioAssets(current, entries),
      );
    });
  }, [sfxAssetIdsKey]);

  useEffect(() => playbackClock.subscribe(() => {
    setCurrentTime(playbackClock.getSnapshot());
  }), [playbackClock]);

  useEffect(() => {
    const audio = musicAudioRef.current;
    if (!audio || !musicSrc || !plannedAudioState?.music) return;
    if (isPlaying) {
      audio.play().catch(() => {
        // Autoplay can be rejected outside a user gesture (e.g. a stray
        // effect re-run) — the next togglePlay() retries it; nothing to
        // surface to the user for a background music bed.
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, musicSrc, plannedAudioState?.music]);

  useEffect(() => {
    const audio = musicAudioRef.current;
    const plannedMusic = plannedAudioState?.music;
    if (!audio || !musicSrc || !plannedMusic) return;

    const targetTime = plannedMusic.timelineTimeSec;
    // Only correct drift beyond a small threshold — natural playback already
    // advances audio.currentTime on its own; forcing it every tick would
    // stutter the track.
    if (Number.isFinite(targetTime) && Math.abs(audio.currentTime - targetTime) > 0.25) {
      audio.currentTime = Math.max(0, targetTime);
    }

    audio.volume = plannedMusic.volume;
  }, [musicSrc, plannedAudioState?.music]);

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

          {compositionStatusItems.length > 0 ? (
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
              role={compositionInvalidTextValue ? "alert" : "status"}
              aria-live="polite"
              aria-atomic="true"
              pointerEvents="none"
              direction="column"
              gap="2px"
            >
              {compositionStatusItems.map((item) => (
                <Text key={item.key}>{item.text}</Text>
              ))}
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
                  cropRect={autoBottomCrop}
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

          {brollUrl ? (
            <video
              key={`broll-probe:${brollUrl}`}
              src={brollUrl}
              muted
              playsInline
              preload="metadata"
              aria-hidden="true"
              tabIndex={-1}
              onLoadedMetadata={(event) => {
                handleBrollAvailability("available");
                const durationSec = event.currentTarget.duration;
                if (Number.isFinite(durationSec) && durationSec > 0) {
                  handleBrollDuration(durationSec);
                }
              }}
              onError={() => handleBrollAvailability("failed")}
              style={{ display: "none" }}
            />
          ) : null}

          {brollUrl && activeBrollWindow && brollActive ? (
            <BrollPreviewLayer
              src={brollUrl}
              poster={activeBrollAsset?.posterUrl ?? null}
              window={activeBrollWindow}
              currentTime={currentTime}
              isPlaying={isPlaying}
              onDuration={handleBrollDuration}
              onAvailabilityChange={handleBrollAvailability}
            />
          ) : null}

          {/* Hidden background-music preview track — decorative render-parity
              bed, no user-facing controls; play/pause, looped offset
              seeking, and volume/fade ramps are all driven by the effects
              above off the shared playback clock. */}
          {musicSrc && plannedAudioState?.music ? (
            // biome-ignore lint/a11y/useMediaCaption: decorative background music preview with no dialogue/captions of its own — the clip's own captions already cover spoken content via the interactive caption overlay.
            <audio
              ref={musicAudioRef}
              src={musicSrc}
              loop
              preload="auto"
              onLoadedMetadata={(event) => {
                const durationSec = event.currentTarget.duration;
                if (Number.isFinite(durationSec) && durationSec > 0) {
                  setMusicMetadata({ src: musicSrc, durationSec });
                }
              }}
              onError={() => {
                if (studioEdits.music.assetId) {
                  setMusicAssetResolution({
                    assetId: studioEdits.music.assetId,
                    state: "failed",
                  });
                } else if (musicSrc) {
                  setFailedMusicSrc(musicSrc);
                }
              }}
              style={{ display: "none" }}
            />
          ) : null}

          {/* One-shot SFX placements (vizard-parity.md "Music/SFX library") —
              best-effort preview, see sfx-preview-track.tsx. Keyed on the
              placement's own stable id (not a resolution-version suffix,
              L7): SfxPreviewTrack's volume effect now depends on `src`
              directly, so a newly-resolved (or re-picked) URL updates the
              SAME mounted instance instead of needing a full remount to
              pick up the new value. */}
          {compositionPlanResult && compositionPlanResult.status !== "invalid"
            ? compositionPlanResult.plan.audioSchedule.soundEffects.map((planned) => {
                const placement = studioEdits.sfx.find(
                  (candidate) => candidate.id === planned.id,
                );
                if (!placement) return null;
                const activeState = plannedAudioState?.soundEffects.find(
                  (candidate) => candidate.id === planned.id,
                );
                const sfxResolution = sfxAssetResolutions[placement.assetId];
                return (
                  <SfxPreviewTrack
                    key={planned.id}
                    placement={{
                      startSec: planned.activeRange.startSec,
                      endSec: planned.activeRange.endSec,
                      volume: (activeState?.volume ?? 0) * 100,
                    }}
                    src={sfxResolution?.state === "available" ? sfxResolution.url : null}
                    onPlaybackFailure={() => {
                      setSfxAssetResolutions((current) => ({
                        ...current,
                        [placement.assetId]: { state: "failed" },
                      }));
                    }}
                    isPlaying={isPlaying}
                    currentTime={currentTime}
                  />
                );
              })
            : null}

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

          {plannedTextLayers.map((layer) => {
            return (
              <InteractiveTextLayer
                key={layer.id}
                layer={layer.value}
                previewWidth={previewWidth}
                videoContainerRef={videoContainerRef}
              />
            );
          })}

          {plannedCaptionLayer ? (
            <InteractiveCaptionOverlay
              videoContainerRef={videoContainerRef}
              layer={plannedCaptionLayer}
              currentTime={currentTime}
            />
          ) : null}

          {/* The plan places the brand logo above captions and text. Wait for
              a measured preview width so the planned pixel geometry never
              flashes at zero size on first paint. */}
          {brandLogo?.url && plannedLogoLayer && previewWidth > 0 ? (
            <img
              src={brandLogo.url}
              alt=""
              aria-hidden="true"
              style={{
                ...logoPositionStyle(
                  plannedLogoLayer.position,
                  previewWidth * (plannedLogoLayer.marginPx / compositionPreview!.canvas.width),
                ),
                width: `${previewWidth * (plannedLogoLayer.widthPx / compositionPreview!.canvas.width)}px`,
                height: "auto",
                opacity: plannedLogoLayer.opacity,
                zIndex: 25,
                pointerEvents: "none",
              }}
            />
          ) : null}

          {plannedTransitionLayer && transitionOverlayOpacity > 0 ? (
            <Box
              position="absolute"
              inset="0"
              bg={plannedTransitionLayer.color}
              opacity={transitionOverlayOpacity}
              pointerEvents="none"
              zIndex={30}
              aria-hidden="true"
            />
          ) : null}

          {plannedOutputTreatment?.watermark.enabled ? (
            <Box
              position="absolute"
              top={`${(plannedOutputTreatment.watermark.marginPx.y / (compositionPreview!.canvas.height * plannedOutputTreatment.scale.numerator / plannedOutputTreatment.scale.denominator)) * 100}%`}
              right={`${(plannedOutputTreatment.watermark.marginPx.x / (compositionPreview!.canvas.width * plannedOutputTreatment.scale.numerator / plannedOutputTreatment.scale.denominator)) * 100}%`}
              color={plannedOutputTreatment.watermark.color}
              opacity={plannedOutputTreatment.watermark.opacity}
              fontSize={`${previewWidth * plannedOutputTreatment.watermark.fontSizePx / (compositionPreview!.canvas.width * plannedOutputTreatment.scale.numerator / plannedOutputTreatment.scale.denominator)}px`}
              fontFamily={plannedOutputTreatment.watermark.fontFamily}
              fontWeight={plannedOutputTreatment.watermark.fontWeight}
              textShadow="none"
              style={{
                WebkitTextStroke: `${previewWidth * plannedOutputTreatment.watermark.outline.widthPx / (compositionPreview!.canvas.width * plannedOutputTreatment.scale.numerator / plannedOutputTreatment.scale.denominator)}px ${hexToRgba(plannedOutputTreatment.watermark.outline.color, plannedOutputTreatment.watermark.outline.opacity)}`,
                paintOrder: "stroke fill",
              }}
              pointerEvents="none"
              zIndex={35}
              aria-hidden="true"
            >
              {plannedOutputTreatment.watermark.text}
            </Box>
          ) : null}
        </Box>
      </Box>
    </Flex>
  );
}
