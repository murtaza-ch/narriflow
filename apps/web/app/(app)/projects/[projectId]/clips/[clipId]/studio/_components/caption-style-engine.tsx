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
import { emojiForWord, formatCaptionWord } from "@narriflow/validators";
import type { CaptionPreset, EditedTimeMap, TranscriptUtterance } from "@narriflow/validators";
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

/**
 * Resolves a preset's `bold` flag to the CSS font-weight that will actually
 * render. Must agree with BOTH sides of the preview/export contract:
 *  - the browser: layout.tsx only loads weights 400 and 700 for every
 *    caption family, so anything else (previously "900"/"600") silently
 *    collapses to the nearest loaded weight — 700 either way, erasing the
 *    non-bold presets' distinction in preview.
 *  - the worker: render-clips.ts's libass force_style sets `Bold=1` or
 *    `Bold=0`, which libass's built-in fonts render as 700/400.
 * The ONE place every caption-text renderer should go through for weight,
 * mirroring resolveCaptionFontFamily above.
 */
export function resolveCaptionFontWeight(bold: boolean): "700" | "400" {
  return bold ? "700" : "400";
}

// ─── Font warming ─────────────────────────────────────────────────────────────
//
// Every caption face loads with `preload: false` in apps/web/app/layout.tsx —
// deliberately, so none of the six caption woff2s ship as preload hints on
// marketing/landing routes that never render a caption. The tradeoff: with no
// preload hint, the browser only starts fetching a given caption face the
// first time text actually needs to paint in it — so the first caption cue,
// and the first open of the captions panel (which renders a preset-card
// thumbnail in all six families near-simultaneously), visibly FOUT as each
// family swaps in one by one. `warmCaptionFonts` front-runs that by asking
// the Font Loading API to fetch+parse every registered caption face as soon
// as the studio mounts, well before any specific cue needs to paint it.

/**
 * Weights actually registered per family in layout.tsx. Bebas Neue and Anton
 * are single-weight (400-only) display faces; the rest load 400 + 700.
 * Requesting a weight with no matching @font-face rejects the load (caught
 * and ignored below), so keep this in sync with layout.tsx's `weight` arrays.
 */
const CAPTION_FONT_WARM_WEIGHTS: Record<string, readonly string[]> = {
  Montserrat: ["400", "700"],
  "Bebas Neue": ["400"],
  Roboto: ["400", "700"],
  Oswald: ["400", "700"],
  "Open Sans": ["400", "700"],
  Impact: ["400"], // resolves to Anton via CAPTION_FONT_VARIABLES, 400-only
};

/** Module-scoped so a remount (e.g. switching clips) doesn't re-warm. */
let captionFontsWarmed = false;

/**
 * Extracts the `--custom-property` name out of a `"var(--x)"` expression, as
 * stored in CAPTION_FONT_VARIABLES — so warming can resolve each family's
 * *actual* (next/font-generated) font-family string via getComputedStyle
 * instead of duplicating a second hardcoded variable-name list here.
 */
function cssVariableNameOf(expression: string): string | null {
  return expression.match(/^var\((--[\w-]+)\)$/)?.[1] ?? null;
}

/**
 * Fire-and-forget prefetch of every caption font family via the browser's
 * Font Loading API, so the first caption paint — and the first captions-panel
 * open, which renders all six at once for preset thumbnails — doesn't
 * visibly FOUT. Call once from a studio mount effect.
 *
 * - SSR-safe: bails out immediately when `document`/`document.fonts` don't
 *   exist (also covers older browsers lacking the Font Loading API).
 * - Never throws: every failure path (unresolved CSS variable, a rejected
 *   FontFace load, a missing API) is swallowed. This is a best-effort perf
 *   nudge, never a correctness dependency, so it must never be able to break
 *   the studio around it.
 * - Never blocks render: `document.fonts.load()` promises are left to settle
 *   in the background and are never awaited.
 * - Idempotent per page session: only does real work on the first call.
 */
export function warmCaptionFonts(): void {
  if (captionFontsWarmed) return;
  if (typeof document === "undefined" || !document.fonts) return;
  captionFontsWarmed = true;

  try {
    const rootStyle = getComputedStyle(document.documentElement);

    for (const [fontName, cssVarExpression] of Object.entries(CAPTION_FONT_VARIABLES)) {
      const cssVariableName = cssVariableNameOf(cssVarExpression);
      const resolvedFamily = cssVariableName
        ? rootStyle.getPropertyValue(cssVariableName).trim()
        : "";
      if (!resolvedFamily) continue;

      const weights = CAPTION_FONT_WARM_WEIGHTS[fontName] ?? ["400"];
      for (const weight of weights) {
        document.fonts.load(`${weight} 16px ${resolvedFamily}`).catch(() => {
          // Best-effort only — a face failing to warm just means it falls
          // back to loading on first paint, same as before this existed.
        });
      }
    }
  } catch {
    // Best-effort only — warming must never throw into the caller.
  }
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

/** Subscribes to the playback clock and returns the current caption cue.
 *  `editedTimeMap` converts the clock's edited-timeline seconds to absolute
 *  source seconds before matching cues (see getCurrentCaptionState's doc
 *  comment) — omit it only where there's genuinely no notion of one. */
export function useLiveCaption(
  playbackClock: PlaybackClock,
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  editedTimeMap?: EditedTimeMap,
): CaptionState | null {
  const [caption, setCaption] = useState<CaptionState | null>(() =>
    getCurrentCaptionState(playbackClock.getSnapshot(), utterances, clipStartSec, editedTimeMap),
  );
  const signatureRef = useRef(captionSignature(caption));

  useEffect(() => {
    const update = () => {
      const next = getCurrentCaptionState(
        playbackClock.getSnapshot(),
        utterances,
        clipStartSec,
        editedTimeMap,
      );
      const signature = captionSignature(next);
      if (signature === signatureRef.current) return;
      signatureRef.current = signature;
      setCaption(next);
    };

    update();
    return playbackClock.subscribe(update);
  }, [clipStartSec, playbackClock, utterances, editedTimeMap]);

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
  // Vizard-parity Phase C punctuation toggle — absent/true keeps punctuation
  // as transcribed. Routed through the SAME `formatCaptionWord` helper the
  // worker's SRT/ASS builders use so preview text can never fork from
  // burn-in text.
  const keepPunctuation = preset.punctuation !== false;

  // When punctuation is off and every word in this cue is pure punctuation
  // (e.g. an isolated "…" token), each word already formats to "" and is
  // skipped below — but without this check the cue would still render an
  // empty box (backdrop included). The worker's ASS builder already skips
  // emitting a Dialogue event entirely for this case; match it here so the
  // preview doesn't show a hollow box the burn-in render never produces.
  const allWordsEmpty = words.every(
    (item) => formatCaptionWord(item.word, { punctuation: keepPunctuation }).length === 0,
  );
  if (allWordsEmpty) return null;

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
          // Punctuation stripped for DISPLAY only — a token that is pure
          // punctuation (e.g. "...") formats to "" and is skipped entirely
          // rather than rendering an empty span, mirroring the worker's
          // per-word skip in generateAssFromSlice.
          const displayWord = formatCaptionWord(item.word, {
            punctuation: keepPunctuation,
          });
          if (displayWord.length === 0) return null;

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
                  fontWeight: resolveCaptionFontWeight(preset.bold),
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
                {displayWord}
                {/* Emoji lookup always reads the RAW word, never the
                    punctuation-formatted one — emojiForWord already strips
                    every non-a-z character via its own key normalization, so
                    this can never disagree with the worker's identical
                    choice in generateAssFromSlice. */}
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
