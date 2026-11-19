"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { Box } from "@chakra-ui/react";
import { useReducedMotion } from "framer-motion";
import type { CaptionPreset, CaptionPresetId, NamedCaptionPreset } from "@narriflow/validators";
import {
  CaptionCue,
  type CaptionCueWord,
} from "../projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine";
import {
  CaptionBlockFrame,
  loopTimeSource,
  staticTimeSource,
} from "../projects/[projectId]/clips/[clipId]/studio/_components/caption-block-painter";
import { captionPresetBackdropSrc } from "./caption-preset-backdrops";
import { CAPTION_SAMPLE_LOOP_SEC, CAPTION_SAMPLE_WORDS, captionSampleBlockCue } from "./caption-sample-cue";

const SAMPLE = CAPTION_SAMPLE_WORDS.map((word) => ({
  word: word.text,
  durationMs: Math.round((word.endSec - word.startSec) * 1000),
}));
const SAMPLE_SPEECH_MS = SAMPLE.reduce((sum, sample) => sum + sample.durationMs, 0);
const SAMPLE_LOOP_MS = CAPTION_SAMPLE_LOOP_SEC * 1000;

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

/** A settled sample: every word spoken and its entrance finished. */
const SETTLED_SAMPLE = staticTimeSource(CAPTION_SAMPLE_LOOP_SEC - 0.1);

/**
 * A Dynamic Style's sample: the phrase as a real Caption Block, played by the
 * playhead-driven block painter on a shared looping clock. The block is laid
 * out on a virtual canvas `1080 / boost` wide with the frame's aspect, so the
 * hero fills its share of the card and the type reads `boost` times larger.
 */
function BlockSample({
  preset,
  width,
  height,
  captionTopPct,
  boost,
  animate,
  reducedMotion,
}: {
  preset: CaptionPreset;
  width: number;
  height: number;
  captionTopPct: number;
  boost: number;
  animate: boolean;
  reducedMotion: boolean;
}) {
  const cue = useMemo(
    () => captionSampleBlockCue(preset, { xPct: preset.positionX ?? 50, yPct: captionTopPct }),
    [preset, captionTopPct],
  );
  const canvasWidth = 1080 / boost;
  const canvas = useMemo(() => ({ width: canvasWidth, height: (canvasWidth * height) / width }), [canvasWidth, width, height]);
  if (!cue) return null;
  return (
    <Box position="absolute" inset="0" pointerEvents="none">
      <CaptionBlockFrame
        cue={cue}
        canvas={canvas}
        scale={width / canvasWidth}
        timeSource={animate ? loopTimeSource(CAPTION_SAMPLE_LOOP_SEC) : SETTLED_SAMPLE}
        reducedMotion={reducedMotion}
      />
    </Box>
  );
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
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { width, height } = size;
  // Galleries hold dozens of previews; only the ones on screen keep their timers running.
  const [onScreen, setOnScreen] = useState(true);
  const dynamic = preset.dynamic !== undefined;
  const { words, cueIndex } = useSampleCue(preset.wordsPerCue, !dynamic && !reducedMotion && onScreen);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const resize = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      setSize({ width: rect?.width ?? 0, height: rect?.height ?? 0 });
    });
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
      {dynamic && width > 0 && height > 0 && (
        <BlockSample
          preset={preset}
          width={width}
          height={height}
          captionTopPct={captionTopPct}
          boost={boost}
          animate={!reducedMotion && onScreen}
          reducedMotion={reducedMotion}
        />
      )}
      {!dynamic && width > 0 && (
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
