"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Box, Flex, Menu, Portal, Text } from "@chakra-ui/react";
import { Spinner } from "@narriflow/ui";
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
  resolveEffectiveLogoSettings,
  resolveMusicFadeWindows,
  type LogoPosition,
} from "@narriflow/validators";
import { useStudio } from "./studio-shell";
import type { AspectRatio, LayoutMode } from "./studio-shell";
import { InteractiveCaptionOverlay } from "./interactive-caption-overlay";

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

// ─── Aspect ratio helpers ─────────────────────────────────────────────────────

const ASPECT_RATIO_CONFIG: Record<AspectRatio, { w: number; h: number; icon: React.ReactNode; label: string }> = {
  "9:16": { w: 9, h: 16, icon: <Smartphone size={12} />, label: "9:16" },
  "1:1":  { w: 1, h: 1,  icon: <Square size={12} />,     label: "1:1"  },
  "16:9": { w: 16, h: 9, icon: <Monitor size={12} />,    label: "16:9" },
  "4:5":  { w: 4,  h: 5, icon: <RectangleHorizontal size={12} />, label: "4:5" },
};

const LAYOUT_OPTIONS: LayoutMode[] = ["fill", "fit", "blur"];

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

// ─── Main component ───────────────────────────────────────────────────────────

export function VideoPreview() {
  const {
    aspectRatio, setAspectRatio,
    layoutMode, setLayoutMode,
    studioEdits,
    videoRef,
    playbackClock,
    sourceVideoUrl,
    previewVideoUrl,
    sourcePurged,
    useOriginalSourceFallback,
    setUseOriginalSourceFallback,
    activeVideoUrl,
    playerClipStartSec,
    deselectCaption,
    isPlaying,
    duration,
    brandLogo,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const musicAudioRef = useRef<HTMLAudioElement>(null);
  // Music track's own duration (unknown until its metadata loads) — used to
  // wrap the preview's offset+clock time the same way the renderer's
  // `-stream_loop -1` + atrim loops the track.
  const musicDurationRef = useRef(0);
  // Read by the (rarely re-created) load effect below so a trim change never
  // needs to be in that effect's deps just to seek to the right start point.
  const playerClipStartSecRef = useRef(playerClipStartSec);

  const arConfig = ASPECT_RATIO_CONFIG[aspectRatio];

  const cycleLayout = useCallback(() => {
    const idx = LAYOUT_OPTIONS.indexOf(layoutMode);
    setLayoutMode(LAYOUT_OPTIONS[(idx + 1) % LAYOUT_OPTIONS.length]!);
  }, [layoutMode, setLayoutMode]);

  const handleRetry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    playerClipStartSecRef.current = playerClipStartSec;
  }, [playerClipStartSec]);

  // Assign the active source (proxy when ready, else the source once the
  // user opts in) and wire loading/error/stall state. Keyed only on
  // activeVideoUrl (+ retryNonce) — NOT playerClipStartSec — so trimming the
  // clip seeks the already-buffered file instead of re-downloading it (see
  // the dedicated seek effect below).
  useEffect(() => {
    const video = videoRef.current;
    setVideoLoaded(false);
    setLoadError(false);
    setIsStalled(false);
    setBufferedFraction(0);
    setSlowLoadHint(false);
    if (!video || !activeVideoUrl) return;

    video.src = activeVideoUrl;
    video.load();

    const handleLoaded = () => {
      video.currentTime = playerClipStartSecRef.current;
      playbackClock.setTime(0);
      setVideoLoaded(true);
      setLoadError(false);
      setIsStalled(false);
    };
    const handleError = () => {
      setLoadError(true);
      setVideoLoaded(false);
    };
    const handleStalled = () => setIsStalled(true);
    const handleProgress = () => {
      setIsStalled(false);
      if (video.duration > 0 && video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        setBufferedFraction(Math.min(1, bufferedEnd / video.duration));
      }
    };

    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("error", handleError);
    video.addEventListener("stalled", handleStalled);
    video.addEventListener("progress", handleProgress);
    return () => {
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
      video.removeEventListener("stalled", handleStalled);
      video.removeEventListener("progress", handleProgress);
    };
  }, [activeVideoUrl, videoRef, playbackClock, retryNonce]);

  // Seek (rather than re-download) when the trim boundary moves on a file
  // that's already loaded.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeVideoUrl || !videoLoaded) return;
    if (video.readyState < 1) return; // HAVE_METADATA not reached yet
    if (Math.abs(video.currentTime - playerClipStartSec) > 0.05) {
      video.currentTime = playerClipStartSec;
    }
  }, [playerClipStartSec, activeVideoUrl, videoLoaded, videoRef]);

  // Large sources can sit well below HAVE_METADATA for a long time with no
  // error and no stall event — surface a hint rather than looking frozen.
  // (In practice this only fires for the opted-into full-source fallback —
  // the proxy is small enough that this basically never trips for it.)
  useEffect(() => {
    if (!activeVideoUrl || videoLoaded || loadError) {
      setSlowLoadHint(false);
      return;
    }
    const timeoutId = setTimeout(() => setSlowLoadHint(true), SLOW_LOAD_HINT_MS);
    return () => clearTimeout(timeoutId);
  }, [activeVideoUrl, videoLoaded, loadError, retryNonce]);

  useEffect(() => playbackClock.subscribe(() => {
    setCurrentTime(playbackClock.getSnapshot());
  }), [playbackClock]);

  // ─── Source audio (volume/mute) — mirrors the render's dialogue-branch
  // gain (see buildDialogueAudioFilter in the worker). Live and cheap: no
  // reload, just the two element properties.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = studioEdits.sourceAudio.muted;
    video.volume = Math.max(0, Math.min(1, studioEdits.sourceAudio.volume / 100));
  }, [studioEdits.sourceAudio.muted, studioEdits.sourceAudio.volume, videoRef]);

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
  }, [studioEdits.music.url]);

  // Reset the cached track duration whenever the music URL changes so a
  // previous track's duration never leaks into the new one's loop math
  // before its own metadata has loaded.
  useEffect(() => {
    musicDurationRef.current = 0;
  }, [studioEdits.music.url]);

  useEffect(() => {
    const audio = musicAudioRef.current;
    if (!audio || !studioEdits.music.url) return;
    if (isPlaying) {
      audio.play().catch(() => {
        // Autoplay can be rejected outside a user gesture (e.g. a stray
        // effect re-run) — the next togglePlay() retries it; nothing to
        // surface to the user for a background music bed.
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, studioEdits.music.url]);

  useEffect(() => {
    const audio = musicAudioRef.current;
    const music = studioEdits.music;
    if (!audio || !music.url) return;

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
    audio.volume = Math.max(0, Math.min(1, gain));
  }, [currentTime, studioEdits.music, duration]);

  useEffect(() => {
    const el = videoContainerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setPreviewWidth(entry.contentRect.width);
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
          if (e.target === e.currentTarget) deselectCaption();
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
          bg="studio.subtle"
          overflow="hidden"
          borderRadius="2px"
        >
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

          {/* Actual video element */}
          {/* biome-ignore lint/a11y/useMediaCaption: captions render via the separate interactive caption overlay; the raw video has no VTT track source to attach. */}
          <video
            ref={videoRef}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: layoutMode === "fit" ? "contain" : "cover",
              display: previewPhase === "ready" ? "block" : "none",
            }}
            playsInline
            preload="metadata"
          />

          {/* Hidden background-music preview track — decorative render-parity
              bed, no user-facing controls; play/pause, looped offset
              seeking, and volume/fade ramps are all driven by the effects
              above off the shared playback clock. */}
          {studioEdits.music.url ? (
            // biome-ignore lint/a11y/useMediaCaption: decorative background music preview with no dialogue/captions of its own — the clip's own captions already cover spoken content via the interactive caption overlay.
            <audio
              ref={musicAudioRef}
              src={studioEdits.music.url}
              loop
              preload="auto"
              style={{ display: "none" }}
            />
          ) : null}

          {/* Layout blur layer */}
          {layoutMode === "blur" && (
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
            const displayFontSize = Math.max(
              9,
              Math.round(layer.fontSize * ((previewWidth || 380) / 1080)),
            );
            const outline =
              layer.outlineWidth > 0
                ? `${layer.outlineWidth}px ${layer.outlineColor}`
                : undefined;

            return (
              <Box
                key={layer.id}
                position="absolute"
                left={`${layer.positionX}%`}
                top={`${layer.positionY}%`}
                transform="translate(-50%, -50%)"
                zIndex={4}
                maxW="88%"
                px={layer.backgroundColor ? "10px" : "0"}
                py={layer.backgroundColor ? "5px" : "0"}
                borderRadius="6px"
                textAlign="center"
                pointerEvents="none"
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
