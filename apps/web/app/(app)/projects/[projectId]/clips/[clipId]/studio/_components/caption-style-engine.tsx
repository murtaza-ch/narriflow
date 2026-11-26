"use client";
import { useBrandFont, brandFontStyle, brandFontFamily } from "@/app/(app)/brand-kit/_components/brand-fonts";
import {
  CAPTION_FACE_OWN_SCRIPTS,
  captionDecorationExtentEm,
  captionFontStack,
  captionLetterSpacingRuns,
  hasUnspacedScript,
  measureCaptionFallbackInkEm,
  NO_CAPTION_INK,
  type CaptionInkEm,
  type CaptionOwnScript,
} from "@/app/caption-script-fonts";

/**
 * The ONE caption renderer for every caption surface in the web app:
 *   - interactive-caption-overlay.tsx (live WYSIWYG overlay on the video)
 *   - _shared/caption-preset-preview.tsx (animated preset thumbnails)
 *   - tool-panels/captions-panel.tsx (live panel preview of the current cue)
 *
 * Caption Blocks (Dynamic Styles) are drawn by caption-block-painter.tsx
 * instead: absolutely placed words from the shared block geometry, posed
 * from the playhead.
 *
 * It mirrors the worker's ASS burn-in (apps/media/src/caption-ass.ts) layer
 * for layer, from the same spec (packages/validators/src/caption-style.ts):
 * plate, pill, shadow, outer stroke, glow, text, karaoke sweep, typewriter
 * letters, glitch ghosts, and the active word's entrance motion. Fonts are the
 * same files with the same line box (app/caption-fonts.ts), so a cue lays out
 * the same in both renderers. Text in other scripts falls back through the
 * worker's own chain (app/caption-script-fonts.ts), and a cue carries its
 * language and direction: right-to-left cues lay words out and sweep karaoke
 * right to left, and complex scripts take no letter spacing.
 *
 * All colour values here are USER caption colours (they feed the burn-in) and
 * intentionally stay literal — never theme tokens.
 */

import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { motion, type Transition } from "framer-motion";
import { captionWordVisualOrder } from "@narriflow/caption-fonts/bidi-order";
import { captionGraphemes } from "@narriflow/caption-fonts/graphemes";
import {
  CAPTION_CUE_TILTS_DEG,
  CAPTION_ENTRANCE_MIN_REMAINING_MS,
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
  captionClassicAnimation,
  captionEaseProgress,
  captionFontFace,
  captionTypewriterLetterDelays,
  formatCaptionWord,
  hasSpaceBefore,
  languageDirection,
  captionTextDirection,
  type CaptionEase,
  type CaptionFontFace,
  type CaptionFontName,
  type CaptionKeyframe,
  type CaptionMotionSpec,
  type CaptionPreset,
} from "@narriflow/validators";

// ─── Colour + font helpers ───────────────────────────────────────────────────

export function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

/** CSS variable app/caption-fonts.ts registers for a caption face. */
export function captionFontVariable(fontName: CaptionFontName): string {
  return `--font-caption-${fontName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** Font declarations for a caption face: family (with the script fallbacks for `language`), weight and style. */
export function captionFontStyle(fontName: CaptionFontName, language?: string | null): CSSProperties {
  const face = captionFontFace(fontName);
  return {
    fontFamily: captionFontStack(`var(${captionFontVariable(fontName)})`, language),
    fontWeight: face.weight,
    fontStyle: face.style,
    // libass never emboldens a fallback face; neither does the browser.
    fontSynthesis: "none",
  };
}

/**
 * libass places `\frx` turns under a fixed camera distance in script pixels;
 * the preview uses the same distance (scaled to the preview) as its CSS
 * perspective so flips foreshorten alike.
 */
export const ASS_CAMERA_DISTANCE_PX = 20000;

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

// ─── Cue renderer ─────────────────────────────────────────────────────────────

export interface CaptionCueWord {
  word: string;
  isActive: boolean;
  /** How long the word stays active, for the karaoke sweep and typewriter. */
  durationMs?: number;
  /** The provider's spacing before the word; without it the script decides (no space between Han/kana). */
  spaceBefore?: boolean;
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
  /** From the consumer's useReducedMotion() — renders static final frames. */
  reducedMotion?: boolean;
  /** The words already went through the composition plan's cue formatting
   *  (punctuation, censor masks, case). Formatting them again would strip a
   *  mask's asterisks. */
  preformatted?: boolean;
  /** The cue's effective caption language: casing, direction and the locale face. */
  language?: string | null;
  /**
   * Called with the line's layout box (offset metrics, display px: before its fit and tilt, and
   * untouched by the word entrances) when the line mounts or changes size: the emoji layer's classic cue box.
   */
  onLineSize?: (width: number, height: number) => void;
}

// ─── Pill and plate geometry ──────────────────────────────────────────────────

/** A zero-size box on the text baseline: where the baseline sits is read from it. */
const BASELINE_ANCHOR: CSSProperties = { display: "inline-block", width: 0, height: 0, pointerEvents: "none" };

interface BaselineInk {
  /** Em from the top of the box the decoration is positioned in. */
  readonly baselineEm: number;
  readonly ink: CaptionInkEm;
}

/** What the browser drew for one cue: each word's baseline and the fallback-face ink, as the burn-in measures them. */
interface CueInkMeasure {
  readonly key: string;
  readonly line: BaselineInk;
  readonly words: readonly BaselineInk[];
}

const sameBaselineInk = (a: BaselineInk, b: BaselineInk) =>
  a.baselineEm === b.baselineEm && a.ink.topEm === b.ink.topEm && a.ink.bottomEm === b.ink.bottomEm;

const sameMeasure = (a: CueInkMeasure | null, b: CueInkMeasure | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.key === b.key &&
    sameBaselineInk(a.line, b.line) &&
    a.words.length === b.words.length &&
    a.words.every((word, index) => sameBaselineInk(word, b.words[index]!)));

/**
 * Reads the cue as the browser laid it out. The burn-in puts a pill or plate
 * around the line's tallest ascent and grows it to fallback-face ink (Nastaliq
 * swashes, Indic marks); the face's catalog metrics only hold for text it draws
 * itself. The baseline is read from the anchors in the DOM, because a taller
 * fallback face pushes it down inside the word's box. A reading within a pixel
 * of the catalog's ascent is the catalog's (offsets are whole pixels).
 */
function measureCueInk(
  line: HTMLElement,
  input: { key: string; display: readonly string[]; emPx: number; face: CaptionFontFace; requestedFamily: string; language: string | null; ownScripts: readonly CaptionOwnScript[] },
): CueInkMeasure | null {
  if (!input.requestedFamily || input.emPx <= 0) return null;
  const baselineEm = (anchor: HTMLElement | null) => {
    if (!anchor) return input.face.ascent;
    const px = anchor.offsetTop;
    return Math.abs(px - input.face.ascent * input.emPx) <= 1 ? input.face.ascent : px / input.emPx;
  };
  const anchors = new Map<string, HTMLElement>();
  for (const anchor of line.querySelectorAll<HTMLElement>("[data-caption-baseline]")) anchors.set(anchor.dataset.captionBaseline!, anchor);
  const words = input.display.map((text, index): BaselineInk => ({
    baselineEm: baselineEm(anchors.get(String(index)) ?? null),
    ink: measureCaptionFallbackInkEm(text, { ...input.face, requestedFamily: input.requestedFamily, language: input.language, ownScripts: input.ownScripts }),
  }));
  const ink = words.reduce<CaptionInkEm>(
    (all, word) => ({ topEm: Math.max(all.topEm, word.ink.topEm), bottomEm: Math.max(all.bottomEm, word.ink.bottomEm) }),
    NO_CAPTION_INK,
  );
  return { key: input.key, line: { baselineEm: baselineEm(anchors.get("line") ?? null), ink }, words };
}

/** Text with the cue's letter spacing switched off for scripts that take none (`\fsp0` in the burn-in). */
export function CaptionText({ text }: { text: string }) {
  if (!hasUnspacedScript(text)) return <>{text}</>;
  return (
    <>
      {captionLetterSpacingRuns(text).map((run, index) =>
        run.spaced ? (
          <Fragment key={index}>{run.text}</Fragment>
        ) : (
          <span key={index} style={{ letterSpacing: 0 }}>
            {run.text}
          </span>
        ),
      )}
    </>
  );
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
      {children ?? (text === undefined ? null : <CaptionText text={text} />)}
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
  reducedMotion = false,
  preformatted = false,
  language = null,
  onLineSize,
}: CaptionCueProps) {
  const [naturalWidth, setNaturalWidth] = useState(0);
  const lineRef = useRef<HTMLDivElement | null>(null);
  // The line node is replaced per cue and its observer outlives renders: it reports through the latest callback.
  const onLineSizeRef = useRef(onLineSize);
  onLineSizeRef.current = onLineSize;
  const [measured, setMeasured] = useState<CueInkMeasure | null>(null);
  const customFont = useBrandFont(preset.fontAsset);
  const face = customFont?.face ?? captionFontFace(preset.fontName);
  // A classic line cannot draw a dynamic-only motion (slide): it plays `fade`, as in the burn-in.
  const spec: CaptionMotionSpec = CAPTION_MOTIONS[captionClassicAnimation(preset)];
  const emPx = preset.fontSize * scale;
  const stroke = preset.outlineWidth * scale;
  const outer = (preset.outerOutlineWidth ?? 0) * scale;
  const keepPunctuation = preset.punctuation !== false;

  const display = words.map((item) =>
    preformatted
      ? item.word
      : applyCaptionTextTransform(formatCaptionWord(item.word, { punctuation: keepPunctuation }), preset.textTransform, language),
  );
  // Resolve the spoken line as a whole, as the burn-in does; an opening
  // English product name alone does not choose the surrounding Urdu flow.
  const cueDir = captionTextDirection(
    display.join(" "),
    language ? languageDirection(language) : undefined,
  );

  // The keyed cue entrance replaces this node on every cue change. Observe
  // the new line so longer captions keep fitting after playback or seeking.
  const measureLine = useCallback((line: HTMLDivElement | null) => {
    lineRef.current = line;
    if (!line) return;
    const measure = () => {
      setNaturalWidth(line.offsetWidth);
      onLineSizeRef.current?.(line.offsetWidth, line.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    // A fallback face that arrives after first paint changes the line's width;
    // fit-to-width must measure the text in the face that draws it.
    const fonts = document.fonts;
    void fonts?.ready.then(measure);
    fonts?.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      fonts?.removeEventListener("loadingdone", measure);
    };
  }, []);

  // Pills and plates follow the baseline and fallback ink the browser drew. Until
  // that is read, and whenever the text or face changes, the catalog metrics stand.
  const requestedFamilyName = customFont ? brandFontFamily(customFont) : null;
  const inkKey = `${customFont ? requestedFamilyName : preset.fontName}\0${language ?? ""}\0${emPx}\0${display.join("\u0001")}`;
  // `inkKey` stands for the display text, face, language and size the effect reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by inkKey
  useEffect(() => {
    const measure = () => {
      const line = lineRef.current;
      if (!line) return;
      const requestedFamily = requestedFamilyName
        ? `"${requestedFamilyName}"`
        : getComputedStyle(line).getPropertyValue(captionFontVariable(preset.fontName)).trim();
      // A brand font's coverage is unknown: only its Latin counts as drawn without ink (complex scripts count in any face).
      const ownScripts = customFont ? [] : (CAPTION_FACE_OWN_SCRIPTS[preset.fontName] ?? []);
      const next = measureCueInk(line, { key: inkKey, display, emPx, face, requestedFamily, language, ownScripts });
      setMeasured((previous) => (sameMeasure(previous, next) ? previous : next));
    };
    measure();
    const fonts = document.fonts;
    void fonts?.ready.then(measure);
    fonts?.addEventListener("loadingdone", measure);
    return () => fonts?.removeEventListener("loadingdone", measure);
  }, [inkKey]);
  const cueInk = measured?.key === inkKey ? measured : null;
  const plateExtent = captionDecorationExtentEm(face.capHeight, CAPTION_PLATE, cueInk?.line.ink ?? NO_CAPTION_INK);
  const plateBaselineEm = cueInk?.line.baselineEm ?? face.ascent;

  // When punctuation is off and every word in this cue is pure punctuation,
  // the composition plan emits no cue at all — so render nothing either.
  if (display.every((text) => text.length === 0)) return null;

  // Where each word stands on screen: the burn-in's bidi order (UAX #9 over the
  // whole line), not the container's direction. A space goes where the provider
  // (or the script) puts one, never between Han or kana. Empty words draw nothing.
  const drawn = display.flatMap((text, index) => (text.length > 0 ? [index] : []));
  const visual = captionWordVisualOrder(
    drawn.map((index, position) => ({
      text: display[index]!,
      space:
        position > 0 &&
        hasSpaceBefore(display[drawn[position - 1]!]!, {
          word: display[index]!,
          ...(words[index]!.spaceBefore === undefined ? {} : { spaceBefore: words[index]!.spaceBefore }),
        }),
    })),
    cueDir,
  );

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
      : spec.cueFadeMs > 0 && (words[0]?.durationMs ?? 400) >= CAPTION_ENTRANCE_MIN_REMAINING_MS
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
          lang={language ?? undefined}
          // The words below are already in the burn-in's visual order; left-to-right keeps the browser from ordering them again.
          dir="ltr"
          data-caption-direction={cueDir}
          style={{
            position: "relative",
            display: "inline-block",
            whiteSpace: "pre",
            lineHeight: "normal",
            fontSize: `${emPx}px`,
            letterSpacing: `${preset.letterSpacing}em`,
            wordSpacing: preset.highlightBoxColor ? `${CAPTION_PILL.extraWordSpacingEm}em` : undefined,
            ...(customFont
              ? { ...brandFontStyle(customFont), fontFamily: captionFontStack(`"${brandFontFamily(customFont)}"`, language) }
              : captionFontStyle(preset.fontName, language)),
          }}
        >
          <span aria-hidden data-caption-baseline="line" style={BASELINE_ANCHOR} />
          {preset.backgroundColor && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: `${-CAPTION_PLATE.padXEm}em`,
                right: `${-CAPTION_PLATE.padXEm}em`,
                top: `${plateBaselineEm - plateExtent.aboveBaselineEm}em`,
                height: `${plateExtent.aboveBaselineEm + plateExtent.belowBaselineEm}em`,
                borderRadius: `${CAPTION_PLATE.radiusEm}em`,
                background: hexToRgba(preset.backgroundColor, preset.backgroundOpacity ?? 1),
              }}
            />
          )}
          {visual.items.map((entry, position) => {
            if ("space" in entry) return <Fragment key={`${cueKey}-space-${position}`}>{" "}</Fragment>;
            const index = drawn[entry.word]!;
            const item = words[index]!;
            const text = display[index]!;
            const wordDir = visual.wordDirections[entry.word]!;
            const isActive = index === activeIndex;
            const upcoming = activeIndex >= 0 && index > activeIndex;
            const sung = spec.effect === "karaoke" && activeIndex >= 0 && index < activeIndex;
            const opacity = upcoming ? spec.upcomingOpacity : 1;
            // The sweep paints the highlight over the word; until it arrives the
            // word is the primary colour, as `\kf` draws it in the burn-in.
            const fill = (isActive && spec.effect !== "karaoke") || sung ? preset.highlightColor : preset.primaryColor;
            const glow = isActive ? (preset.highlightGlowColor ?? preset.glowColor ?? null) : (preset.glowColor ?? null);
            const durationMs = item.durationMs ?? 400;
            const entrance = isActive && animated && durationMs >= CAPTION_ENTRANCE_MIN_REMAINING_MS ? keyframeMotion(spec.word, emPx, perspectivePx) : null;
            const wordInk = cueInk?.words[index];
            const pillExtent = captionDecorationExtentEm(face.capHeight, CAPTION_PILL, wordInk?.ink ?? NO_CAPTION_INK);
            return (
              <Fragment key={`${cueKey}-${index}`}>
                <span
                  dir={wordDir}
                  style={{
                    position: "relative",
                    display: "inline-block",
                    whiteSpace: "pre",
                    // The active word draws above its neighbours, as the
                    // burn-in overlay does.
                    zIndex: isActive ? 10 : undefined,
                  }}
                >
                <motion.span
                  key={`${cueKey}-${index}-${isActive ? "on" : "off"}`}
                  {...(entrance ?? {})}
                  style={{
                    position: "relative",
                    display: "block",
                    whiteSpace: "pre",
                    transformOrigin: "50% 50%",
                    opacity: entrance ? undefined : opacity,
                  }}
                >
                  <span aria-hidden data-caption-baseline={index} style={BASELINE_ANCHOR} />
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
                        top: `${(wordInk?.baselineEm ?? face.ascent) - pillExtent.aboveBaselineEm}em`,
                        height: `${pillExtent.aboveBaselineEm + pillExtent.belowBaselineEm}em`,
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
                        <CaptionText text={text} />
                      )}
                    </span>
                  </GlitchText>
                  {isActive && spec.effect === "karaoke" && (
                    <KaraokeSweep text={text} color={preset.highlightColor} durationMs={durationMs} animated={animated} rtl={wordDir === "rtl"} style={silhouetteStroke(stroke, preset.outlineColor)} />
                  )}
                </motion.span>
                </span>
              </Fragment>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

/** Karaoke: a highlight-coloured copy wiped in while the word is spoken: left to right, right to left for a right-to-left word. */
function KaraokeSweep({
  text,
  color,
  durationMs,
  animated,
  rtl,
  style,
}: {
  text: string;
  color: string;
  durationMs: number;
  animated: boolean;
  rtl: boolean;
  style: CSSProperties;
}) {
  return (
    <motion.span
      aria-hidden
      initial={animated ? { clipPath: rtl ? "inset(0 0 0 100%)" : "inset(0 100% 0 0)" } : false}
      animate={{ clipPath: rtl ? "inset(0 0 0 0%)" : "inset(0 0% 0 0)" }}
      transition={{ duration: durationMs / 1000, ease: "linear" }}
      style={{ position: "absolute", left: 0, top: 0, zIndex: 6, color, whiteSpace: "pre", paintOrder: "stroke fill", ...style }}
    >
      <CaptionText text={text} />
    </motion.span>
  );
}

/** Typewriter: the active word's letters appear one at a time. */
function TypewriterLetters({ text, durationMs }: { text: string; durationMs: number }) {
  // Grapheme clusters, like the burn-in: a ZWJ family or flag appears as one letter.
  // Joined and complex scripts (Arabic, Indic, Thai...) appear whole: separate
  // letters would not join or reorder.
  const letters = hasUnspacedScript(text) ? [text] : captionGraphemes(text);
  const delays = captionTypewriterLetterDelays(letters.length, durationMs);
  return letters.map((letter, index) => (
    <motion.span
      key={`${index}-${letter}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: delays[index]! / 1000, duration: 0 }}
    >
      <CaptionText text={letter} />
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
        <CaptionText text={text} />
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
