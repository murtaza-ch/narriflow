"use client";

import { useEffect, useRef } from "react";

interface MusicPreviewTrackProps {
  /** Resolved playback URL of this Music Block's track. */
  src: string;
  /** The block's planned state at the playhead, or null outside its range. */
  planned: { timelineTimeSec: number; volume: number } | null;
  isPlaying: boolean;
  onDuration(durationSec: number): void;
  onPlaybackFailure(): void;
}

/**
 * One hidden `<audio loop>` per playable Music Block, driven by the planned
 * per-block state (render parity: the in-point, fades, ducking and mix gain
 * all come from the plan). Pauses outside the block's active range; inside
 * it, only corrects drift beyond a small threshold because natural playback
 * already advances `currentTime` and forcing it every tick would stutter.
 */
export function MusicPreviewTrack({
  src,
  planned,
  isPlaying,
  onDuration,
  onPlaybackFailure,
}: MusicPreviewTrackProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const active = planned !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a swapped src reloads the element, which must start playing again.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying && active) {
      audio.play().catch(() => {
        // Autoplay can be rejected outside a user gesture; the next
        // togglePlay() retries it. Nothing to surface for a music bed.
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, active, src]);

  const targetTime = planned?.timelineTimeSec ?? null;
  const volume = planned?.volume ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: src re-applies volume after a media source swap, which some browsers reset.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || targetTime === null) return;
    if (Number.isFinite(targetTime) && Math.abs(audio.currentTime - targetTime) > 0.25) {
      audio.currentTime = Math.max(0, targetTime);
    }
    audio.volume = Math.max(0, Math.min(1, volume));
  }, [targetTime, volume, src]);

  return (
    // biome-ignore lint/a11y/useMediaCaption: decorative background music preview with no dialogue/captions of its own; the clip's captions already cover spoken content.
    <audio
      ref={audioRef}
      src={src}
      loop
      preload="auto"
      onLoadedMetadata={(event) => {
        const durationSec = event.currentTarget.duration;
        if (Number.isFinite(durationSec) && durationSec > 0) onDuration(durationSec);
      }}
      onError={onPlaybackFailure}
      style={{ display: "none" }}
    />
  );
}
