"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { Box } from "@chakra-ui/react";
import { useReducedMotion } from "framer-motion";
import type { CaptionPreset, CaptionPresetId, NamedCaptionPreset } from "@narriflow/validators";
import {
  CaptionCue,
  type CaptionCueWord,
} from "../projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine";
import { captionPresetBackdropSrc } from "./caption-preset-backdrops";

const SAMPLE = [
  { word: "make", durationMs: 420 },
  { word: "it", durationMs: 280 },
  { word: "pop", durationMs: 800 },
] as const;
const SAMPLE_SPEECH_MS = SAMPLE.reduce((sum, sample) => sum + sample.durationMs, 0);
const SAMPLE_LOOP_MS = 2100;

/**
 * Loops the sample through the preset's cue model: the active word advances
 * on timers (three state changes per loop), not every animation frame.
 */
function useSampleCue(wordsPerCue: number, animate: boolean) {
  const [active, setActive] = useState(() => (animate ? Math.floor(Math.random() * SAMPLE.length) : 1));

  useEffect(() => {
    if (!animate) return;
    const timer = setTimeout(
      () => setActive((index) => (index + 1) % SAMPLE.length),
      SAMPLE[active]!.durationMs + (active === SAMPLE.length - 1 ? SAMPLE_LOOP_MS - SAMPLE_SPEECH_MS : 0),
    );
    return () => clearTimeout(timer);
  }, [active, animate]);

  const cueIndex = Math.floor(active / wordsPerCue);
  const start = cueIndex * wordsPerCue;
  const words: CaptionCueWord[] = SAMPLE.slice(start, start + wordsPerCue).map((sample, index) => ({
    word: sample.word,
    durationMs: sample.durationMs,
    isActive: start + index === active,
  }));
  return { words, cueIndex };
}

/**
 * A caption preset playing over a talking-head frame — the real caption
 * engine, so the thumbnail shows exactly what the preset renders. Captions
 * are drawn `boost` times larger than true frame scale so they stay legible
 * at thumbnail size; fit-to-width keeps them inside the frame.
 */
export function CaptionPresetPreview({
  namedPreset,
  ...rest
}: {
  namedPreset: NamedCaptionPreset;
  aspectRatio: string;
  captionTopPct: number;
  boost: number;
  imageSizes: string;
}) {
  return (
    <CaptionSamplePreview
      preset={namedPreset.preset}
      backdropSrc={captionPresetBackdropSrc(namedPreset.id as Exclude<CaptionPresetId, "brand_default">)}
      {...rest}
    />
  );
}

/** Any caption style playing its sample over `backdropSrc`; see `CaptionPresetPreview`. */
export function CaptionSamplePreview({
  preset,
  backdropSrc,
  aspectRatio,
  captionTopPct,
  boost,
  imageSizes,
  children,
}: {
  preset: CaptionPreset;
  backdropSrc: string;
  aspectRatio: string;
  captionTopPct: number;
  boost: number;
  imageSizes: string;
  /** Overlays drawn above the caption, such as a logo. */
  children?: ReactNode;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Galleries hold dozens of previews; only the ones on screen keep their timers running.
  const [onScreen, setOnScreen] = useState(true);
  const { words, cueIndex } = useSampleCue(preset.wordsPerCue, !reducedMotion && onScreen);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const resize = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    const visibility = new IntersectionObserver((entries) => setOnScreen(entries[0]?.isIntersecting ?? true));
    resize.observe(el);
    visibility.observe(el);
    return () => {
      resize.disconnect();
      visibility.disconnect();
    };
  }, []);

  return (
    <Box ref={frameRef} position="relative" w="100%" aspectRatio={aspectRatio} overflow="hidden" bg="studio.canvas">
      <Image
        src={backdropSrc}
        alt=""
        fill
        sizes={imageSizes}
        style={{ objectFit: "cover", objectPosition: "50% 30%" }}
      />
      <Box position="absolute" inset="0" bg="linear-gradient(180deg, rgba(0,0,0,.05) 30%, rgba(0,0,0,.35) 100%)" />
      {width > 0 && (
        <Box
          position="absolute"
          left="0"
          right="0"
          top={`${captionTopPct}%`}
          transform="translateY(-50%)"
          display="flex"
          justifyContent="center"
        >
          <CaptionCue
            preset={preset}
            words={words}
            scale={(width * boost) / 1080}
            frameWidth={width}
            cueKey={cueIndex}
            cueIndex={cueIndex}
            reducedMotion={reducedMotion}
          />
        </Box>
      )}
      {children}
    </Box>
  );
}
