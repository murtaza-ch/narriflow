"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Screen packet C (PiP persistence — preview true facecam crop): a
 * normalized source rect
 * paired with the tile's own rendered CSS box dimensions, everything this
 * component needs to switch from the `objectFit`/`objectPosition` static
 * crop to an EXPLICIT-SIZE crop that reproduces an arbitrary sub-rect zoom —
 * something `object-fit`/`object-position` alone cannot express. `x`/`y`/`w`/
 * `h` are already fitted to this tile's own aspect ratio by the shared
 * composition planner — this component only turns them into concrete
 * width/height/left/top, it does no aspect-fitting of its own.
 */
export interface SplitSecondaryTileCropRect {
  /** Normalized (0..1, fraction of the SOURCE frame's width/height) crop
   *  rect — NOT re-normalized to the tile box below. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The tile's own rendered box, in CSS px, as measured by the caller's
   *  ResizeObserver. Zero/negative (not yet measured) is treated as
   *  degenerate — see the fallback logic below. */
  tileWidthPx: number;
  tileHeightPx: number;
}

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
  /** CSS `object-fit` for this tile. Split's bottom seat and screen's
   *  face-crop seat both want `"cover"` (crop to fill); left generalized
   *  (rather than hardcoded) so a future caller with different needs
   *  doesn't have to fork this component. */
  objectFit: "cover" | "contain";
  /** Full CSS `object-position` value (e.g. `"0% 50%"`, `"50% 50%"`) fed
   *  straight through to the element's style. Split passes a static
   *  left/right seat position (see the `SPLIT_*_TILE_CX` comment in
   *  video-preview.tsx for what those values represent and why they're
   *  static); screen packet C passes a static `"50% 50%"` center — same
   *  "render is the source of truth" stance: the worker face-tracks this
   *  seat per shot segment, the preview approximates with a fixed center. */
  objectPosition: string;
  /** Screen packet C: when set (and geometrically valid — see the
   *  degeneracy checks in the render below), switches this tile from the
   *  `objectFit`/`objectPosition` static crop to the explicit-size true
   *  facecam crop, ignoring `objectFit`/`objectPosition` entirely. `null`/
   *  `undefined` (split mode always; screen mode with no persisted
   *  `pipRect` yet) falls back to exactly today's `objectFit`/
   *  `objectPosition` behavior — split's fixed left/right seats are
   *  untouched by this prop. */
  cropRect?: SplitSecondaryTileCropRect | null;
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
 * Split/screen preview (split packet C, reused by screen packet C) — the
 * bottom tile of a stacked 2-up. The top tile reuses the studio's single
 * existing `<video ref={videoRef}>` element directly (see video-preview.tsx);
 * this component is the ONE extra secondary element either mode needs, muted
 * and silent so `videoRef` stays the sole audio source and the sole
 * playback-clock driver. Mounted only while split or screen framing is
 * active — zero cost otherwise. `objectFit`/`objectPosition` (static crop)
 * vs. `cropRect` (explicit-size true facecam crop, screen packet C) are the
 * only bits that differ between the two callers (split always uses its
 * fixed left/right seat via `objectFit`/`objectPosition`; screen uses
 * `cropRect` once a persisted `pipRect` exists, else falls back to the same
 * static-center `objectFit`/`objectPosition` split uses) — everything else
 * (drift sync, error handling, cleanup) is shared, unforked logic.
 */
export function SplitSecondaryTile({
  src,
  isPlaying,
  targetTimeSec,
  objectFit,
  objectPosition,
  cropRect,
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

  // Screen packet C: explicit-size crop math. `object-fit`/`object-position`
  // can only express "scale to fill, anchor the overflow" — there is no CSS
  // way to zoom into an arbitrary sub-rect of the source through them. The
  // fix is to size+position the raw `<video>` element itself: scale the
  // WHOLE source up until the crop rect's own w/h (both normalized 0..1
  // fractions of the source) exactly fill the tile box, then shift it left/
  // up by the crop rect's x/y (scaled the same way) so the rect's top-left
  // corner lands at the tile's own top-left corner — everything outside the
  // rect falls outside the tile's `overflow: hidden` wrapper (set by the
  // caller) and is simply clipped.
  //
  //   videoDisplayW = tileWidthPx / cropRect.w   (scale factor applied to
  //   videoDisplayH = tileHeightPx / cropRect.h   the video's rendered size)
  //   left = -cropRect.x * videoDisplayW
  //   top  = -cropRect.y * videoDisplayH
  //
  // Degenerate `cropRect` (not yet measured — zero/negative tile dims — or
  // a zero/negative crop w/h) is re-checked here defensively and
  // falls through to the exact same `objectFit`/`objectPosition` static
  // crop split mode has always used.
  const hasValidCropRect =
    !!cropRect &&
    cropRect.w > 0 &&
    cropRect.h > 0 &&
    cropRect.tileWidthPx > 0 &&
    cropRect.tileHeightPx > 0;
  const videoStyle: React.CSSProperties = hasValidCropRect
    ? (() => {
        const videoDisplayW = cropRect!.tileWidthPx / cropRect!.w;
        const videoDisplayH = cropRect!.tileHeightPx / cropRect!.h;
        return {
          position: "absolute",
          left: `${-cropRect!.x * videoDisplayW}px`,
          top: `${-cropRect!.y * videoDisplayH}px`,
          width: `${videoDisplayW}px`,
          height: `${videoDisplayH}px`,
          maxWidth: "none",
          display: visible && !hasError ? "block" : "none",
        };
      })()
    : {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit,
        objectPosition,
        display: visible && !hasError ? "block" : "none",
      };

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
      style={videoStyle}
    />
  );
}
