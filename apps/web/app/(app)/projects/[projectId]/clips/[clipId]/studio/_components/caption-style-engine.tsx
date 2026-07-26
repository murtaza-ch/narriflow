"use client";

/**
 * The ONE shared caption-style engine for the studio.
 *
 * Style computation (outline/shadow/glow text-shadow builder), the framer-motion
 * word-animation factory, and the cue renderer used by:
 *   - interactive-caption-overlay.tsx (live WYSIWYG overlay on the video)
 *   - tool-panels/preset-card.tsx (animated preset thumbnails)
 *   - tool-panels/captions-panel.tsx (live panel preview of the current cue)
 *
 * All color values here are USER caption colors (they mirror the burn-in
 * output) and intentionally stay literal — never theme tokens.
 */

import { useEffect, useRef, useState } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { motion } from "framer-motion";
import { emojiForWord } from "@narriflow/validators";
import type { CaptionPreset, TranscriptUtterance } from "@narriflow/validators";
import {
  getCurrentCaptionState,
  type CaptionState,
  type CaptionWord,
} from "./use-current-caption";
import type { PlaybackClock } from "./playback-clock";

// ─── Color helper ─────────────────────────────────────────────────────────────

export function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

// ─── Font resolution ──────────────────────────────────────────────────────────
//
// Caption presets store a bare Google Fonts family name (e.g. "Montserrat").
// The worker bundles the actual font files for burn-in (apps/worker/Dockerfile),
// and apps/web/app/layout.tsx loads the same families in-browser via
// next/font/google, exposed as CSS variables. This map resolves a preset's
// fontName to that variable so every preview renderer agrees with the export
// instead of silently falling back to a system font. "Impact" is proprietary,
// so — mirroring the worker's substitution in render-clips.ts — it resolves
// to Anton.
const CAPTION_FONT_VARIABLES: Record<string, string> = {
  Montserrat: "var(--font-caption-montserrat)",
  "Bebas Neue": "var(--font-caption-bebas-neue)",
  Roboto: "var(--font-caption-roboto)",
  Oswald: "var(--font-caption-oswald)",
  "Open Sans": "var(--font-caption-open-sans)",
  Impact: "var(--font-caption-anton)",
};

/**
 * Resolves a caption preset's fontName to a CSS font-family value. The ONE
 * place every caption-text renderer (live overlay, preset thumbnails, panel
 * previews, and the font picker itself) should go through, so preview can't
 * drift per-callsite the way it did before these fonts were loaded.
 */
export function resolveCaptionFontFamily(fontName: string): string {
  const loadedVariable = CAPTION_FONT_VARIABLES[fontName];
  return loadedVariable
    ? `${loadedVariable}, "${fontName}", sans-serif`
    : `"${fontName}", sans-serif`;
}

// ─── Word animation factory ───────────────────────────────────────────────────

export type CaptionMotionMode = "live" | "preview";

/**
 * Framer-motion props per word. `live` matches burn-in behavior (word-by-word
 * and karaoke are color-only, handled by the color transition); `preview`
 * adds gentle pulses for those two so preset cards still demonstrate them.
 *
 * When `reducedMotion` is true (consumers read framer-motion's
 * useReducedMotion() and pass it down) every animation — including the
 * `repeat: Infinity` breathe pulse — collapses to static final-frame props.
 */
export function getWordMotionProps(
  animation: string,
  isActive: boolean,
  index: number,
  mode: CaptionMotionMode = "live",
  reducedMotion = false,
): Record<string, unknown> {
  if (reducedMotion) return {};

  const stagger = index * (mode === "preview" ? 0.12 : 0.08);

  switch (animation) {
    case "blur-in":
      return {
        initial: { filter: "blur(10px)", opacity: 0 },
        animate: { filter: "blur(0px)", opacity: 1 },
        transition: { duration: 0.4, ease: "easeOut", delay: stagger },
      };
    case "grow":
      return {
        initial: { scale: 0.2, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { type: "spring", stiffness: 260, damping: 20, delay: stagger },
      };
    case "breathe":
      return isActive
        ? {
            animate: { scale: [1, 1.08, 1] },
            transition: { repeat: Infinity, duration: 1.2, ease: "easeInOut" },
          }
        : {};
    case "soft-landing":
      return {
        initial: { y: -20, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: stagger },
      };
    case "glitch":
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1, x: [0, -3, 4, -2, 0], skewX: [0, -5, 3, -1, 0] },
        transition: { duration: 0.35, delay: stagger },
      };
    case "seamless-bounce":
      return {
        initial: { y: 12, opacity: 0, scale: 0.95 },
        animate: { y: 0, opacity: 1, scale: 1 },
        transition: { type: "spring", stiffness: 300, damping: 15, delay: stagger },
      };
    case "bounce":
      return {
        initial: { y: 10, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        transition: { type: "spring", stiffness: 400, damping: 10, delay: stagger },
      };
    case "karaoke":
      if (mode === "live") return {};
      return isActive
        ? { initial: { scale: 0.95 }, animate: { scale: 1.05 }, transition: { duration: 0.15 } }
        : { initial: { opacity: 0.5 }, animate: { opacity: 1 }, transition: { duration: 0.2, delay: stagger } };
    case "word-by-word":
      if (mode === "live") return {};
      return {
        initial: { opacity: 0.35 },
        animate: { opacity: 1 },
        transition: { duration: 0.25, delay: stagger },
      };
    default:
      return {};
  }
}

// ─── Text-shadow builder (outline + drop shadow + glow) ──────────────────────

export function buildCaptionTextShadow(
  preset: CaptionPreset,
  scale = 1,
): string | undefined {
  const parts: string[] = [];

  if (preset.outlineWidth > 0) {
    const ow =
      scale === 1
        ? preset.outlineWidth
        : Math.max(1, Math.round(preset.outlineWidth * scale));
    for (let x = -ow; x <= ow; x++) {
      for (let y = -ow; y <= ow; y++) {
        if (x === 0 && y === 0) continue;
        parts.push(`${x}px ${y}px 0 ${preset.outlineColor}`);
      }
    }
  }

  if (preset.shadow) {
    parts.push(scale === 1 ? "0 2px 8px rgba(0,0,0,0.9)" : "0 1px 5px rgba(0,0,0,0.85)");
  }

  if (preset.glowColor) {
    const intensity = Math.max(1, Math.round((preset.glowIntensity ?? 8) * scale));
    parts.push(`0 0 ${intensity}px ${preset.glowColor}`);
    parts.push(`0 0 ${intensity * 2}px ${preset.glowColor}40`);
  }

  return parts.length > 0 ? parts.join(", ") : undefined;
}

// ─── Live caption subscription ────────────────────────────────────────────────

function captionSignature(caption: CaptionState | null) {
  if (!caption) return "none";
  return `${caption.utteranceIndex}:${caption.activeWordIndex}:${caption.visibleWords
    .map((word) => `${word.word}:${word.isActive ? 1 : 0}`)
    .join("|")}`;
}

/** Subscribes to the playback clock and returns the current caption cue. */
export function useLiveCaption(
  playbackClock: PlaybackClock,
  utterances: TranscriptUtterance[],
  clipStartSec: number,
): CaptionState | null {
  const [caption, setCaption] = useState<CaptionState | null>(() =>
    getCurrentCaptionState(playbackClock.getSnapshot(), utterances, clipStartSec),
  );
  const signatureRef = useRef(captionSignature(caption));

  useEffect(() => {
    const update = () => {
      const next = getCurrentCaptionState(
        playbackClock.getSnapshot(),
        utterances,
        clipStartSec,
      );
      const signature = captionSignature(next);
      if (signature === signatureRef.current) return;
      signatureRef.current = signature;
      setCaption(next);
    };

    update();
    return playbackClock.subscribe(update);
  }, [clipStartSec, playbackClock, utterances]);

  return caption;
}

// ─── Cue renderer ─────────────────────────────────────────────────────────────

export interface CaptionCueProps {
  preset: CaptionPreset;
  words: CaptionWord[];
  /** Display font size in px (already scaled to the preview surface). */
  fontSize: number;
  /** Shadow/outline scale relative to the full-size render (1 = overlay). */
  scale?: number;
  mode?: CaptionMotionMode;
  /** Remount key segment so entrance animations replay per cue/loop. */
  cueKey?: string | number;
  gapPx?: number;
  showEmojis?: boolean;
  /** From the consumer's useReducedMotion() — renders static final frames. */
  reducedMotion?: boolean;
}

/**
 * Renders one caption cue with full preset styling: backdrop, per-word
 * highlight box, outline/shadow/glow, transform, and word animation.
 */
export function CaptionCue({
  preset,
  words,
  fontSize,
  scale = 1,
  mode = "live",
  cueKey = "cue",
  gapPx = 6,
  showEmojis = false,
  reducedMotion = false,
}: CaptionCueProps) {
  if (words.length === 0) return null;

  const highlight = preset.highlightColor;
  const textShadow = buildCaptionTextShadow(preset, scale);
  const hasBackdrop = !!preset.backgroundColor;
  const hasHighlightBox = !!preset.highlightBoxColor;
  const textTransform = (preset.textTransform ??
    "uppercase") as React.CSSProperties["textTransform"];
  const letterSpacing = `${preset.letterSpacing ?? 0.04}em`;
  const full = scale >= 1;

  return (
    <Box position="relative" display="inline-flex" alignItems="center" justifyContent="center">
      {/* Backdrop behind all text */}
      {hasBackdrop && (
        <Box
          position="absolute"
          inset={full ? "-6px -10px" : "-4px -8px"}
          borderRadius={full ? "6px" : "5px"}
          pointerEvents="none"
          style={{
            backgroundColor: hexToRgba(
              preset.backgroundColor!,
              preset.backgroundOpacity ?? 0.6,
            ),
          }}
        />
      )}

      <Flex
        gap={`${gapPx}px`}
        align="center"
        flexWrap="nowrap"
        justify="center"
        position="relative"
        zIndex={1}
      >
        {words.map((item, i) => {
          const motionProps = getWordMotionProps(
            preset.animation,
            item.isActive,
            i,
            mode,
            reducedMotion,
          );
          const showBox = hasHighlightBox && item.isActive;

          return (
            <Box key={`${cueKey}-${i}`} position="relative" display="inline-flex">
              {/* Highlight box behind the active word */}
              {showBox && (
                <Box
                  position="absolute"
                  inset="-2px -4px"
                  borderRadius={full ? "4px" : "3px"}
                  pointerEvents="none"
                  style={{
                    backgroundColor: hexToRgba(
                      preset.highlightBoxColor!,
                      preset.highlightBoxOpacity ?? 1,
                    ),
                  }}
                />
              )}

              <motion.span
                {...motionProps}
                style={{
                  position: "relative",
                  zIndex: 1,
                  fontSize: `${fontSize}px`,
                  fontWeight: preset.bold ? "900" : "600",
                  letterSpacing,
                  color: item.isActive ? highlight : preset.primaryColor,
                  fontFamily: resolveCaptionFontFamily(preset.fontName),
                  textShadow,
                  transition: "color 80ms ease-out",
                  textTransform,
                  pointerEvents: "none",
                  userSelect: "none",
                  display: "inline-block",
                  lineHeight: mode === "preview" ? 1.3 : 1.08,
                }}
              >
                {item.word}
                {showEmojis && emojiForWord(item.word)
                  ? ` ${emojiForWord(item.word)}`
                  : ""}
              </motion.span>
            </Box>
          );
        })}
      </Flex>
    </Box>
  );
}
