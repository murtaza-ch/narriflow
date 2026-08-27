"use client";

import { useEffect, useRef } from "react";

interface SfxPreviewTrackProps {
  placement: {
    startSec: number;
    endSec: number;
    volume: number;
  };
  /** Resolved playback URL, or null while it is still being fetched. */
  src: string | null;
  isPlaying: boolean;
  /** EDITED-timeline seconds from the shared playback clock — the same unit
   *  `placement.startSec` is stored in. */
  currentTime: number;
  onPlaybackFailure(): void;
}

/**
 * One-shot SFX playback (vizard-parity.md "Music/SFX library"): mirrors
 * video-preview.tsx's clock-driven music preview at per-placement scale.
 * Plays only inside the planner-owned active range, then stays silent until
 * the playhead re-enters that range. This preview only needs to stay inside
 * the same +/-0.25s tolerance as the music bed.
 */
export function SfxPreviewTrack({
  placement,
  src,
  isPlaying,
  currentTime,
  onPlaybackFailure,
}: SfxPreviewTrackProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !src) return;

    const withinWindow =
      currentTime >= placement.startSec &&
      currentTime < placement.endSec;

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
  }, [isPlaying, currentTime, placement.endSec, placement.startSec, src]);

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
    <audio
      ref={audioRef}
      src={src}
      preload="auto"
      onError={onPlaybackFailure}
      style={{ display: "none" }}
    />
  );
}
