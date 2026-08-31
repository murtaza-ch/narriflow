"use client";

import { useEffect, useRef } from "react";

interface PlannedBeep {
  readonly frequencyHz: number;
  readonly volume: number;
}

/** Browser adapter for the planner-owned beep envelope. The oscillator never
 * owns interval timing or fades; it only renders the current planned sample. */
export function CensorBeepPreview({
  beep,
  isPlaying,
}: {
  beep: PlannedBeep | null;
  isPlaying: boolean;
}) {
  const frequencyHz = beep?.frequencyHz ?? null;
  const plannedVolume = beep?.volume ?? 0;
  const audioRef = useRef<{
    context: AudioContext;
    oscillator: OscillatorNode;
    gain: GainNode;
  } | null>(null);

  useEffect(() => {
    if (frequencyHz === null) return;
    const AudioContextConstructor = window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequencyHz;
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    audioRef.current = { context, oscillator, gain };
    return () => {
      audioRef.current = null;
      oscillator.stop();
      oscillator.disconnect();
      gain.disconnect();
      void context.close();
    };
  }, [frequencyHz]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const volume = isPlaying ? Math.max(0, Math.min(1, plannedVolume)) : 0;
    audio.gain.gain.setTargetAtTime(volume, audio.context.currentTime, 0.004);
    if (isPlaying && audio.context.state === "suspended") {
      void audio.context.resume();
    }
  }, [isPlaying, plannedVolume]);

  return null;
}
