"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import { loadFaces, wordFace } from "../projects/[projectId]/clips/[clipId]/studio/_components/caption-block-painter";
import { CAPTION_CARD_CLIPS, PRESET_CARD_FRAME } from "./caption-card-clips";

function clipUrls(presetId: string) {
  const entry = CAPTION_CARD_CLIPS[presetId];
  const version = entry ? `?v=${entry.hash.slice(0, 12)}` : "";
  return { video: `/caption-cards/${presetId}.mp4${version}`, poster: `/caption-cards/${presetId}.webp${version}` };
}

/**
 * A preset's sample as its pre-rendered clip: the poster shows at once, the clip plays only while the card is on
 * screen, and with reduced motion the poster (the sample's settled still) stays.
 */
export function CaptionCardClip({ presetId }: { presetId: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const { video, poster } = clipUrls(presetId);

  useEffect(() => {
    const element = ref.current;
    if (!element || reducedMotion) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void element.play().catch(() => undefined);
      else element.pause();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      element.pause();
    };
  }, [reducedMotion]);

  return (
    <video
      ref={ref}
      src={video}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      disablePictureInPicture
      disableRemotePlayback
      aria-hidden
      style={{ display: "block", width: "100%", aspectRatio: PRESET_CARD_FRAME.aspectRatio, objectFit: "cover" }}
    />
  );
}

const preloaded = new Set<string>();

/**
 * Starts loading the faces a preset's Scene Style draws with (pointing at its card is a strong hint it is about to be
 * picked), so the on-video build that follows finds them loaded and measures once instead of twice.
 */
export function preloadCaptionCardFaces(presetId: string): void {
  if (preloaded.has(presetId)) return;
  preloaded.add(presetId);
  for (const name of CAPTION_CARD_CLIPS[presetId]?.faces ?? []) {
    const face = wordFace("text", name, null, null);
    if (face) void loadFaces("Aa", face, null).catch(() => undefined);
  }
}
