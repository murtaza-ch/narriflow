"use client";

import { useEffect, useRef, useState } from "react";

interface SplitSecondaryTileProps {
  /** Same `activeVideoUrl` the main preview video uses — proxy when ready,
   *  else the opted-into full source. */
  src: string;
  isPlaying: boolean;
  /** File-local seconds (the same unit `video.currentTime` reads on the
   *  MAIN preview video — i.e. already source-offset-adjusted, see
   *  video-preview.tsx's `splitSecondaryTargetTimeSec`) this tile should be
   *  showing right now. This tile never decodes independently against the
   *  clock the way the main video does (that's `playbackClock.startVideo`'s
   *  job, driven off `videoRef` alone in studio-shell.tsx) — it just chases
   *  this target within a tolerance, exactly like the music `<audio>` sync
   *  effect a little further up in video-preview.tsx. That also means a
   *  ripple skip over a deleted range self-heals within a fraction of a
   *  second here instead of needing its own `stepRipple` wiring. */
  targetTimeSec: number;
  /** Normalized horizontal crop center (0-1), fed straight into
   *  `object-position`'s X component — see the `SPLIT_*_TILE_CX` comment in
   *  video-preview.tsx for what this represents and why it's static. */
  cx: number;
  /** Mirrors the main video's own `previewPhase === "ready"` gate so both
   *  tiles fade in together instead of the bottom one flashing blank while
   *  its own (separate) network load catches up. */
  visible: boolean;
  /** The main preview's own video element — read (never written) purely to
   *  mirror `playbackRate` onto this secondary element, matching the spec's
   *  "playbackRate mirrored" contract. Nothing in the studio currently
   *  exposes a speed control, so this is always 1 today, but staying
   *  wired means a future speed control can't silently desync this tile. */
  mainVideoRef: React.RefObject<HTMLVideoElement | null>;
}

/**
 * Split preview (split packet C) — the bottom tile of the stacked 2-up.
 * The top tile reuses the studio's single existing `<video ref={videoRef}>`
 * element directly (see video-preview.tsx); this component is the ONE extra
 * secondary element split mode needs, muted and silent so `videoRef` stays
 * the sole audio source and the sole playback-clock driver. Mounted only
 * while split framing is active — zero cost otherwise.
 */
export function SplitSecondaryTile({
  src,
  isPlaying,
  targetTimeSec,
  cx,
  visible,
  mainVideoRef,
}: SplitSecondaryTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // M5b (adversarial review): a decode error (bad/expired proxy URL, codec
  // failure, network drop mid-load) otherwise leaves this element showing
  // whatever frame it last painted — a silent stuck frame with no signal
  // anything went wrong. Track it so render can blacken the tile instead.
  const [hasError, setHasError] = useState(false);

  // Load/reload whenever the active source changes (proxy <-> full-source
  // fallback, or a fresh clip) — a scaled-down version of the main video's
  // own load effect one level up, minus the loaded/error/stalled UI state:
  // the top tile alone drives the ghost-stage phase, so this tile just
  // silently catches up once its own network load resolves.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setHasError(false);
    video.src = src;
    video.load();
  }, [src]);

  // M5a (adversarial review): on unmount (split framing toggled off, or the
  // whole preview tearing down), stop the element from continuing to
  // buffer/decode in the background and release its network source —
  // `<video>` doesn't do this on its own just because the DOM node was
  // removed from React's tree in every browser/timing combination, and this
  // element has no `<source>` child for the browser to fall back to
  // releasing automatically. Mirrors the cleanup contract a raw `<video>`
  // needs whenever it's imperatively driven like this one is.
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, []);

  // Play/pause mirrored from the shared transport state, exactly like the
  // music preview `<audio>` effect mirrors it off `isPlaying`.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || hasError) return;
    if (isPlaying) {
      video.play().catch(() => {
        // Autoplay can be rejected outside a user gesture (e.g. a stray
        // effect re-run) — the next togglePlay() retries it; nothing to
        // surface to the user for a silent secondary crop.
      });
    } else {
      video.pause();
    }
  }, [isPlaying, hasError]);

  // M5c (adversarial review): sync strategy now depends on transport state.
  // While PAUSED there's no playback motion to gently correct, so a hard
  // seek past a small tolerance is correct and invisible (the frame was
  // static either way). While PLAYING, a hard seek every correction tick
  // would visibly judder (a frame pop each time) — instead nudge
  // `playbackRate` by a few percent so the tile gradually catches up,
  // the same technique a live-stream player uses for A/V resync, and revert
  // to the mirrored nominal rate once drift is negligible. A large jump
  // (a ripple skip, an explicit seek) still gets an immediate hard seek —
  // a multi-second rate-nudge chase to close a 1s+ gap would read as
  // obviously wrong, not subtly smooth.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || hasError) return;
    if (!Number.isFinite(targetTimeSec)) return;

    const mainRate = mainVideoRef.current?.playbackRate ?? 1;
    const drift = video.currentTime - targetTimeSec;
    const HARD_SEEK_DRIFT_SEC = 1;
    const NUDGE_CATCHUP_DRIFT_SEC = 0.05;
    const NUDGE_FRACTION = 0.04; // +/-4%

    if (video.paused) {
      video.playbackRate = mainRate;
      if (Math.abs(drift) > 0.25) {
        video.currentTime = Math.max(0, targetTimeSec);
      }
      return;
    }

    if (Math.abs(drift) > HARD_SEEK_DRIFT_SEC) {
      video.currentTime = Math.max(0, targetTimeSec);
      video.playbackRate = mainRate;
      return;
    }

    if (Math.abs(drift) < NUDGE_CATCHUP_DRIFT_SEC) {
      video.playbackRate = mainRate;
      return;
    }

    // Ahead of target (drift > 0): slow down to let target catch up.
    // Behind target (drift < 0): speed up to catch up to target.
    const nudged = drift > 0 ? mainRate * (1 - NUDGE_FRACTION) : mainRate * (1 + NUDGE_FRACTION);
    video.playbackRate = Math.max(0.1, nudged);
  }, [targetTimeSec, mainVideoRef, hasError]);

  return (
    // Muted (a11y/useMediaCaption doesn't fire on muted media) silent
    // secondary crop of the same source the main video already plays with
    // audio — captions render via the separate interactive caption overlay,
    // shared across both tiles.
    <video
      ref={videoRef}
      muted
      playsInline
      preload="metadata"
      onError={() => {
        // M5b: structured log (this file's console.warn contract mirrors
        // the worker's `console.warn(JSON.stringify({level, message, ...}))`
        // convention — see AGENTS.md) plus visible state so a broken
        // secondary tile reads as "blacked out" rather than "frozen and
        // nobody noticed." `display: none` below reveals the studio
        // canvas's own dark backdrop behind this tile (this element's
        // wrapping Box is intentionally transparent) — no separate blackout
        // layer needed.
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "split_secondary_tile_video_error",
            src,
          }),
        );
        setHasError(true);
      }}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        objectPosition: `${cx * 100}% 50%`,
        display: visible && !hasError ? "block" : "none",
      }}
    />
  );
}
