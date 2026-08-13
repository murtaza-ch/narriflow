"use client";

import { useEffect, useRef } from "react";
import type { StudioSfxPlacement } from "@narriflow/validators";

interface SfxPreviewTrackProps {
  placement: StudioSfxPlacement;
  /** Resolved playback URL for `placement.assetId`, or null while it's still
   *  being fetched (see video-preview.tsx's `sfxUrlCacheRef`) — nothing
   *  renders until this resolves. */
  src: string | null;
  isPlaying: boolean;
  /** EDITED-timeline seconds from the shared playback clock — the same unit
   *  `placement.startSec` is stored in. */
  currentTime: number;
}

/**
 * One-shot SFX playback (vizard-parity.md "Music/SFX library"): mirrors
 * video-preview.tsx's clock-driven music preview at per-placement scale.
 * Plays once starting at `placement.startSec` for as long as this track's
 * own duration (unknown until `loadedmetadata`, at which point the window
 * narrows from "open-ended" to "closes after the track's real length"),
 * then stays silent until the playhead re-enters the window (loop, or a
 * scrub back before `startSec`). Not sample-accurate — the render is the
 * source of truth for exact placement — this only needs to stay inside the
 * same +/-0.25s tolerance the music bed already accepts.
 */
export function SfxPreviewTrack({ placement, src, isPlaying, currentTime }: SfxPreviewTrackProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const durationRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: src intentionally resets metadata for the newly mounted media source.
  useEffect(() => {
    durationRef.current = 0;
    const audio = audioRef.current;
    if (!audio) return;
    const handleLoadedMetadata = () => {
      durationRef.current = Number.isFinite(audio.duration) ? audio.duration : 0;
    };
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      durationRef.current = audio.duration;
    }
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    return () => audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !src) return;

    const trackDuration = durationRef.current;
    const withinWindow =
      currentTime >= placement.startSec &&
      (trackDuration <= 0 || currentTime < placement.startSec + trackDuration);

    if (!isPlaying || !withinWindow) {
      audio.pause();
      return;
    }

    const targetTime = currentTime - placement.startSec;
    if (Number.isFinite(targetTime) && Math.abs(audio.currentTime - targetTime) > 0.25) {
      audio.currentTime = Math.max(0, targetTime);
    }
    audio.play().catch(() => {
      // Autoplay can be rejected outside a user gesture — the next
      // togglePlay() retries it; nothing to surface for a one-shot SFX cue.
    });
  }, [isPlaying, currentTime, placement.startSec, src]);

  // L7: `src` is in the deps (not just `placement.volume`) because some
  // browsers reset a media element's `.volume` back to its default when its
  // `src` is swapped for a new asset — without this, re-picking a different
  // SFX for the same placement at the SAME volume value never re-applied
  // it, silently reverting the cue back to full volume.
  // biome-ignore lint/correctness/useExhaustiveDependencies: src intentionally reapplies volume after a media source swap.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = Math.max(0, Math.min(1, placement.volume / 100));
  }, [placement.volume, src]);

  if (!src) return null;

  return (
    // biome-ignore lint/a11y/useMediaCaption: decorative one-shot SFX cue, no dialogue/captions of its own.
    <audio ref={audioRef} src={src} preload="auto" style={{ display: "none" }} />
  );
}
