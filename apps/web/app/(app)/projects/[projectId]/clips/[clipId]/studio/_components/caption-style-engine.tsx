"use client";

/**
 * The ONE caption renderer for every caption surface in the web app:
 *   - interactive-caption-overlay.tsx (live WYSIWYG overlay on the video)
 *   - tool-panels/preset-card.tsx (animated preset thumbnails)
 *   - tool-panels/captions-panel.tsx (live panel preview of the current cue)
 *
 * It mirrors the worker's ASS burn-in (apps/worker/src/caption-ass.ts) layer
 * for layer, from the same spec (packages/validators/src/caption-style.ts):
 * plate, pill, shadow, outer stroke, glow, text, karaoke sweep, typewriter
 * letters, glitch ghosts, and the active word's entrance motion. Fonts are the
 * same files with the same line box (app/caption-fonts.ts), so a cue lays out
 * the same in both renderers.
 *
 * All colour values here are USER caption colours (they feed the burn-in) and
 * intentionally stay literal — never theme tokens.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { motion, type Transition } from "framer-motion";
import {
  CAPTION_CUE_TILTS_DEG,
  CAPTION_EXTRUDE,
  CAPTION_FIT_WIDTH_FRACTION,
  CAPTION_GLITCH,
  CAPTION_GLOW_SIGMAS,
  CAPTION_HARD_SHADOW,
  CAPTION_MOTIONS,
  CAPTION_PILL,
  CAPTION_PLATE,
  CAPTION_SOFT_SHADOW,
  applyCaptionTextTransform,
  captionEaseProgress,
  captionFontFace,
  captionTypewriterLetterDelays,
  emojiForWord,
  formatCaptionWord,
  type CaptionEase,
  type CaptionFontName,
  type CaptionKeyframe,
  type CaptionMotionSpec,
  type CaptionPreset,
  type EditedTimeMap,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { getCurrentCaptionState, type CaptionState } from "./use-current-caption";
import type { PlaybackClock } from "./playback-clock";

// ─── Colour + font helpers ───────────────────────────────────────────────────

export function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

/** CSS variable app/caption-fonts.ts registers for a caption face. */
function captionFontVariable(fontName: CaptionFontName): string {
  return `--font-caption-${fontName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** Font declarations for a caption face: family, weight and style. */
export function captionFontStyle(fontName: CaptionFontName): CSSProperties {
  const face = captionFontFace(fontName);
  return {
    fontFamily: `var(${captionFontVariable(fontName)}), sans-serif`,
    fontWeight: face.weight,
    fontStyle: face.style,
  };
}

/**
 * libass places `\frx` turns under a fixed camera distance in script pixels;
 * the preview uses the same distance (scaled to the preview) as its CSS
 * perspective so flips foreshorten alike.
 */
const ASS_CAMERA_DISTANCE_PX = 20000;

// ─── Keyframes → framer-motion ───────────────────────────────────────────────

const easeFunction = (ease: CaptionEase | undefined) => (t: number) => captionEaseProgress(ease, t);

type AnimatedProperty = "scaleX" | "scaleY" | "opacity" | "offsetYEm" | "blurEm" | "rotateXDeg";

/**
 * Turns spec keyframes into framer-motion props. Each property animates over
 * its own keyframes; eased segments follow the libass power curve. Opacity
 * and vertical offset stay linear because libass `\fade` and `\move` are.
 */
function keyframeMotion(keyframes: readonly CaptionKeyframe[], emPx: number, perspectivePx: number) {
  if (keyframes.length === 0) return null;
  const initial: Record<string, number | string> = {};
  const animate: Record<string, (number | string)[]> = {};
  const transition: Record<string, Transition> = {};
  const add = (property: AnimatedProperty, key: string, toValue: (value: number) => number | string, linear: boolean) => {
    const track = keyframes.filter((frame) => frame[property] !== undefined);
    if (track.length === 0) return;
    const start = track[0]!.at;
    const span = Math.max(1, track[track.length - 1]!.at - start);
    initial[key] = toValue(track[0]![property]!);
    animate[key] = track.map((frame) => toValue(frame[property]!));
    transition[key] = {
      duration: span / 1000,
      delay: start / 1000,
      times: track.map((frame) => (frame.at - start) / span),
      ease: track.slice(1).map((frame) => (linear ? (t: number) => t : easeFunction(frame.ease))),
    };
  };
  add("scaleX", "scaleX", (value) => value, false);
  add("scaleY", "scaleY", (value) => value, false);
  add("opacity", "opacity", (value) => value, true);
  add("offsetYEm", "y", (value) => value * emPx, true);
  add("blurEm", "filter", (value) => `blur(${value * emPx}px)`, false);
  add("rotateXDeg", "rotateX", (value) => value, false);
  if ("rotateX" in initial) initial.transformPerspective = perspectivePx;
  return { initial, animate, transition };
}

/** Step keyframes (instant changes) for framer-motion: duplicate each time. */
function stepTimes(steps: readonly { at: number }[], totalMs: number) {
  const times: number[] = [];
  steps.forEach((step, index) => {
    if (index > 0) times.push(step.at / totalMs);
    times.push(step.at / totalMs);
  });
  return times;
}

// ─── Live caption subscription ────────────────────────────────────────────────

function captionSignature(caption: CaptionState | null) {
  if (!caption) return "none";
  return `${caption.utteranceIndex}:${caption.cueIndex}:${caption.activeWordIndex}:${caption.visibleWords
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
  wordsPerCue: number,
  editedTimeMap?: EditedTimeMap,
): CaptionState | null {
  const [caption, setCaption] = useState<CaptionState | null>(() =>
    getCurrentCaptionState(playbackClock.getSnapshot(), utterances, clipStartSec, wordsPerCue, editedTimeMap),
  );
  const signatureRef = useRef(captionSignature(caption));

  useEffect(() => {
    const update = () => {
      const next = getCurrentCaptionState(
        playbackClock.getSnapshot(),
        utterances,
        clipStartSec,
        wordsPerCue,
        editedTimeMap,
      );
      const signature = captionSignature(next);
      if (signature === signatureRef.current) return;
      signatureRef.current = signature;
      setCaption(next);
    };

    update();
    return playbackClock.subscribe(update);
  }, [clipStartSec, playbackClock, utterances, wordsPerCue, editedTimeMap]);

  return caption;
}

// ─── Cue renderer ─────────────────────────────────────────────────────────────

export interface CaptionCueWord {
  word: string;
  isActive: boolean;
  emoji?: string | null;
  /** How long the word stays active, for the karaoke sweep and typewriter. */
  durationMs?: number;
}

export interface CaptionCueProps {
  preset: CaptionPreset;
  words: readonly CaptionCueWord[];
  /** Display px per canvas px (preview width / export width). */
  scale: number;
  /** Width (display px) of the frame the cue sits in; enables fit-to-width. */
  frameWidth?: number;
  /** Remount key: entrance animations replay per cue. */
  cueKey: string | number;
  /** Cue number within the clip; picks the tilt of playful styles. */
  cueIndex?: number;
  showEmojis?: boolean;
  /** From the consumer's useReducedMotion() — renders static final frames. */
  reducedMotion?: boolean;
}

/** One copy of a word's glyphs; every caption layer is one of these. */
function Glyphs({
  text,
  style,
  children,
}: {
  text?: string;
  style: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        whiteSpace: "pre",
        paintOrder: "stroke fill",
        pointerEvents: "none",
        ...style,
      }}
    >
      {children ?? text}
    </span>
  );
}

/**
 * Renders one caption cue with full preset styling. The cue is a single
 * line; each word is an inline-block span whose box is the font's line box,
 * so pills, plates and motion origins line up with the burn-in.
 */
export function CaptionCue({
  preset,
  words,
  scale,
  frameWidth,
  cueKey,
  cueIndex = 0,
  showEmojis = false,
  reducedMotion = false,
}: CaptionCueProps) {
  const [naturalWidth, setNaturalWidth] = useState(0);
  const face = captionFontFace(preset.fontName);
  const spec: CaptionMotionSpec = CAPTION_MOTIONS[preset.animation];
  const emPx = preset.fontSize * scale;
  const stroke = preset.outlineWidth * scale;
  const outer = (preset.outerOutlineWidth ?? 0) * scale;
  const keepPunctuation = preset.punctuation !== false;

  const display = words.map((item) =>
    applyCaptionTextTransform(formatCaptionWord(item.word, { punctuation: keepPunctuation }), preset.textTransform),
  );

  // The keyed cue entrance replaces this node on every cue change. Observe
  // the new line so longer captions keep fitting after playback or seeking.
  const measureLine = useCallback((line: HTMLDivElement | null) => {
    if (!line) return;
    const measure = () => setNaturalWidth(line.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    return () => observer.disconnect();
  }, []);

  // When punctuation is off and every word in this cue is pure punctuation,
  // the composition plan emits no cue at all — so render nothing either.
  if (display.every((text) => text.length === 0)) return null;

  const activeIndex = words.findIndex((item) => item.isActive);
  const fit =
    frameWidth && naturalWidth > 0
      ? Math.min(1, (CAPTION_FIT_WIDTH_FRACTION * frameWidth) / (naturalWidth + 2 * (stroke + outer)))
      : 1;
  const tilt = spec.tilt ? CAPTION_CUE_TILTS_DEG[cueIndex % CAPTION_CUE_TILTS_DEG.length]! : 0;
  const animated = !reducedMotion;
  const perspectivePx = ASS_CAMERA_DISTANCE_PX * scale;

  const cueEntrance = !animated
    ? {}
    : spec.flicker
      ? {
          initial: { opacity: 0 },
          animate: { opacity: spec.flicker.flatMap((step, index) => (index === 0 ? [step.opacity] : [spec.flicker![index - 1]!.opacity, step.opacity])) },
          transition: {
            duration: spec.flicker[spec.flicker.length - 1]!.at / 1000,
            times: stepTimes(spec.flicker, spec.flicker[spec.flicker.length - 1]!.at),
            ease: "linear" as const,
          },
        }
      : spec.cueFadeMs > 0
        ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: spec.cueFadeMs / 1000, ease: "linear" as const } }
        : {};

  const silhouetteStroke = (width: number, color: string): CSSProperties =>
    width > 0 ? { WebkitTextStroke: `${width * 2}px ${color}` } : {};

  const shadowLayers = (text: string, visible: boolean): ReactNode[] => {
    if (!visible || preset.shadow === "none") return [];
    const base: CSSProperties = {
      color: preset.shadowColor,
      ...silhouetteStroke(stroke + outer, preset.shadowColor),
      zIndex: 1,
    };
    if (preset.shadow === "soft") {
      return [
        <Glyphs
          key="shadow"
          text={text}
          style={{
            ...base,
            opacity: CAPTION_SOFT_SHADOW.opacity,
            transform: `translateY(${CAPTION_SOFT_SHADOW.offsetYEm}em)`,
            filter: `blur(${CAPTION_SOFT_SHADOW.blurEm * emPx}px)`,
          }}
        />,
      ];
    }
    if (preset.shadow === "hard") {
      return [
        <Glyphs
          key="shadow"
          text={text}
          style={{ ...base, transform: `translate(${CAPTION_HARD_SHADOW.offsetXEm}em, ${CAPTION_HARD_SHADOW.offsetYEm}em)` }}
        />,
      ];
    }
    return Array.from({ length: CAPTION_EXTRUDE.steps }, (_, index) => {
      const distance = (CAPTION_EXTRUDE.steps - index) * CAPTION_EXTRUDE.stepEm;
      return <Glyphs key={`extrude-${index}`} text={text} style={{ ...base, transform: `translate(${distance}em, ${distance}em)` }} />;
    });
  };

  const glowLayers = (text: string, color: string | null): ReactNode[] => {
    if (!color) return [];
    const intensity = (preset.glowIntensity ?? 8) * scale;
    return CAPTION_GLOW_SIGMAS.map((sigma) => (
      <Glyphs key={`glow-${sigma}`} text={text} style={{ color, filter: `blur(${sigma * intensity}px)`, zIndex: 4 }} />
    ));
  };

  return (
    <motion.div
      key={`cue-${cueKey}`}
      {...cueEntrance}
      style={{ display: "inline-flex", justifyContent: "center", pointerEvents: "none", userSelect: "none" }}
    >
      <div style={{ transform: `rotate(${tilt}deg) scale(${fit})`, transformOrigin: "50% 50%" }}>
        <div
          ref={measureLine}
          style={{
            position: "relative",
            display: "inline-block",
            whiteSpace: "pre",
            lineHeight: "normal",
            fontSize: `${emPx}px`,
            letterSpacing: `${preset.letterSpacing}em`,
            wordSpacing: preset.highlightBoxColor ? `${CAPTION_PILL.extraWordSpacingEm}em` : undefined,
            ...captionFontStyle(preset.fontName),
          }}
        >
          {preset.backgroundColor && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: `${-CAPTION_PLATE.padXEm}em`,
                right: `${-CAPTION_PLATE.padXEm}em`,
                top: `${face.ascent - face.capHeight - CAPTION_PLATE.padTopEm}em`,
                height: `${face.capHeight + CAPTION_PLATE.padTopEm + CAPTION_PLATE.padBottomEm}em`,
                borderRadius: `${CAPTION_PLATE.radiusEm}em`,
                background: hexToRgba(preset.backgroundColor, preset.backgroundOpacity ?? 1),
              }}
            />
          )}
          {words.map((item, index) => {
            const text = display[index]!;
            const isActive = index === activeIndex;
            const upcoming = activeIndex >= 0 && index > activeIndex;
            const sung = spec.effect === "karaoke" && activeIndex >= 0 && index < activeIndex;
            const opacity = upcoming ? spec.upcomingOpacity : 1;
            const fill = isActive || sung ? preset.highlightColor : preset.primaryColor;
            const glow = isActive ? (preset.highlightGlowColor ?? preset.glowColor ?? null) : (preset.glowColor ?? null);
            const entrance = isActive && animated ? keyframeMotion(spec.word, emPx, perspectivePx) : null;
            const emoji = showEmojis ? (item.emoji ?? emojiForWord(item.word)) : null;
            const durationMs = item.durationMs ?? 400;
            if (text.length === 0) return null;
            return (
              <span key={`${cueKey}-${index}`}>
                {index > 0 && " "}
                <motion.span
                  key={`${cueKey}-${index}-${isActive ? "on" : "off"}`}
                  {...(entrance ?? {})}
                  style={{
                    position: "relative",
                    display: "inline-block",
                    whiteSpace: "pre",
                    transformOrigin: "50% 50%",
                    opacity: entrance ? undefined : opacity,
                    // The active word draws above its neighbours, as the
                    // burn-in overlay does.
                    zIndex: isActive ? 10 : undefined,
                  }}
                >
                  {isActive && preset.highlightBoxColor && (
                    <motion.span
                      aria-hidden
                      initial={animated ? { scale: 0.82, opacity: 0 } : false}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{
                        scale: { duration: 0.13, ease: easeFunction("out") },
                        opacity: { duration: 0.13, ease: "linear" },
                      }}
                      style={{
                        position: "absolute",
                        left: `${-CAPTION_PILL.padXEm}em`,
                        right: `${-CAPTION_PILL.padXEm}em`,
                        top: `${face.ascent - face.capHeight - CAPTION_PILL.padTopEm}em`,
                        height: `${face.capHeight + CAPTION_PILL.padTopEm + CAPTION_PILL.padBottomEm}em`,
                        borderRadius: `${CAPTION_PILL.radiusEm}em`,
                        background: hexToRgba(preset.highlightBoxColor, preset.highlightBoxOpacity ?? 1),
                        zIndex: 2,
                      }}
                    />
                  )}
                  {shadowLayers(text, opacity > 0)}
                  {outer > 0 && preset.outerOutlineColor && (
                    <Glyphs text={text} style={{ color: preset.outerOutlineColor, ...silhouetteStroke(stroke + outer, preset.outerOutlineColor), zIndex: 3 }} />
                  )}
                  {glowLayers(text, glow)}
                  {isActive && spec.effect === "glitch" && animated && (
                    <GlitchGhosts text={text} />
                  )}
                  <GlitchText active={isActive && spec.effect === "glitch" && animated}>
                    <span
                      style={{
                        position: "relative",
                        zIndex: 5,
                        color: fill,
                        paintOrder: "stroke fill",
                        ...silhouetteStroke(stroke, preset.outlineColor),
                      }}
                    >
                      {isActive && spec.effect === "typewriter" && animated ? (
                        <TypewriterLetters text={text} durationMs={durationMs} />
                      ) : (
                        text
                      )}
                    </span>
                  </GlitchText>
                  {isActive && spec.effect === "karaoke" && (
                    <KaraokeSweep text={text} color={preset.highlightColor} durationMs={durationMs} animated={animated} style={silhouetteStroke(stroke, preset.outlineColor)} />
                  )}
                  {isActive && emoji && (
                    <span
                      aria-hidden
                      style={{
                        position: "absolute",
                        left: "50%",
                        bottom: "100%",
                        transform: "translateX(-50%)",
                        fontSize: "0.8em",
                        letterSpacing: 0,
                        fontFamily: "system-ui, sans-serif",
                        fontStyle: "normal",
                      }}
                    >
                      {emoji}
                    </span>
                  )}
                </motion.span>
              </span>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

/** Karaoke: a highlight-coloured copy wiped in left to right while the word is spoken. */
function KaraokeSweep({
  text,
  color,
  durationMs,
  animated,
  style,
}: {
  text: string;
  color: string;
  durationMs: number;
  animated: boolean;
  style: CSSProperties;
}) {
  return (
    <motion.span
      aria-hidden
      initial={animated ? { clipPath: "inset(0 100% 0 0)" } : false}
      animate={{ clipPath: "inset(0 0% 0 0)" }}
      transition={{ duration: durationMs / 1000, ease: "linear" }}
      style={{ position: "absolute", left: 0, top: 0, zIndex: 6, color, whiteSpace: "pre", paintOrder: "stroke fill", ...style }}
    >
      {text}
    </motion.span>
  );
}

/** Typewriter: the active word's letters appear one at a time. */
function TypewriterLetters({ text, durationMs }: { text: string; durationMs: number }) {
  const letters = [...text];
  const delays = captionTypewriterLetterDelays(letters.length, durationMs);
  return letters.map((letter, index) => (
    <motion.span
      key={`${index}-${letter}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: delays[index]! / 1000, duration: 0 }}
    >
      {letter}
    </motion.span>
  ));
}

const GLITCH_TOTAL_MS = CAPTION_GLITCH.stepMs * CAPTION_GLITCH.steps.length;

/** Glitch: cyan/red copies jitter for three steps, then hold a small split. */
function GlitchGhosts({ text }: { text: string }) {
  const times = [0, ...CAPTION_GLITCH.steps.slice(1).flatMap((_, index) => {
    const at = ((index + 1) * CAPTION_GLITCH.stepMs) / GLITCH_TOTAL_MS;
    return [at, at];
  }), 1, 1];
  return CAPTION_GLITCH.ghostColors.map((color, ghostIndex) => {
    const sign = ghostIndex === 0 ? 1 : -1;
    const offsets = [
      ...CAPTION_GLITCH.steps.flatMap((step, index) => (index === 0 ? [step.ghostEm] : [CAPTION_GLITCH.steps[index - 1]!.ghostEm, step.ghostEm])),
      CAPTION_GLITCH.steps[CAPTION_GLITCH.steps.length - 1]!.ghostEm,
      CAPTION_GLITCH.heldGhostEm,
    ];
    const opacities = [
      ...CAPTION_GLITCH.steps.flatMap((_, index) => (index === 0 ? [CAPTION_GLITCH.ghostOpacity] : [CAPTION_GLITCH.ghostOpacity, CAPTION_GLITCH.ghostOpacity])),
      CAPTION_GLITCH.ghostOpacity,
      CAPTION_GLITCH.heldGhostOpacity,
    ];
    return (
      <motion.span
        key={color}
        aria-hidden
        initial={{ x: `${sign * offsets[0]![0]}em`, y: `${sign * offsets[0]![1]}em`, opacity: opacities[0] }}
        animate={{
          x: offsets.map((offset) => `${sign * offset[0]}em`),
          y: offsets.map((offset) => `${sign * offset[1]}em`),
          opacity: opacities,
        }}
        transition={{ duration: GLITCH_TOTAL_MS / 1000, times, ease: "linear" }}
        style={{ position: "absolute", left: 0, top: 0, zIndex: 4, color, whiteSpace: "pre" }}
      >
        {text}
      </motion.span>
    );
  });
}

/** Glitch: the word itself jitters sideways and shears during the three steps. */
function GlitchText({ active, children }: { active: boolean; children: ReactNode }) {
  if (!active) return <>{children}</>;
  const steps = CAPTION_GLITCH.steps;
  const times = [0, ...steps.slice(1).flatMap((_, index) => {
    const at = ((index + 1) * CAPTION_GLITCH.stepMs) / GLITCH_TOTAL_MS;
    return [at, at];
  }), 1];
  const values = <T,>(pick: (step: (typeof steps)[number]) => T) => [
    ...steps.flatMap((step, index) => (index === 0 ? [pick(step)] : [pick(steps[index - 1]!), pick(step)])),
    pick(steps[steps.length - 1]!),
  ];
  return (
    <motion.span
      initial={{ x: `${steps[0].textDxEm}em`, skewX: `${(Math.atan(-steps[0].shear) * 180) / Math.PI}deg` }}
      animate={{
        x: values((step) => `${step.textDxEm}em`),
        skewX: values((step) => `${(Math.atan(-step.shear) * 180) / Math.PI}deg`),
      }}
      transition={{ duration: GLITCH_TOTAL_MS / 1000, times, ease: "linear" }}
      style={{ display: "inline-block", position: "relative", zIndex: 5 }}
    >
      {children}
    </motion.span>
  );
}
