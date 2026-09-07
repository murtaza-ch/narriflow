"use client";

import { useEffect, useRef } from "react";

interface CensorBeepPreviewTrackProps {
  beep: { readonly frequencyHz: number; readonly volume: number } | null;
  isPlaying: boolean;
}

/** A clock-driven oscillator for the planned beep branch. The source media is
 * muted by the same schedule before this component is mounted, so this is a
 * replacement cue rather than an additive effect. */
export function CensorBeepPreviewTrack({
  beep,
  isPlaying,
}: CensorBeepPreviewTrackProps) {
  const contextRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const frequencyHz = beep?.frequencyHz ?? null;
  const volume = beep?.volume ?? 0;

  useEffect(() => {
    if (frequencyHz === null || !isPlaying) return;
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequencyHz;
    gain.gain.value = 0;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    context.resume().catch(() => undefined);
    contextRef.current = context;
    gainRef.current = gain;

    return () => {
      oscillator.stop();
      gain.disconnect();
      void context.close();
      contextRef.current = null;
      gainRef.current = null;
    };
  }, [frequencyHz, isPlaying]);

  useEffect(() => {
    const context = contextRef.current;
    const gain = gainRef.current;
    if (!context || !gain) return;
    gain.gain.setTargetAtTime(
      Math.max(0, Math.min(0.95, volume)),
      context.currentTime,
      0.004,
    );
  }, [volume]);

  return null;
}
