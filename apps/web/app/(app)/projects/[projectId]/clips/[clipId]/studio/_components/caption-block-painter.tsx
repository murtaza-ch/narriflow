"use client";

/**
 * The Studio's Caption Block painter (spec 5.6 "Painting", 5.7, ADR 0020).
 *
 * Each word of a Dynamic Style cue is measured alone with Canvas
 * `measureText` at 100 px once its faces have loaded, placed by the shared
 * `layoutCaptionBlock`, and drawn as absolutely positioned elements, one per
 * paint layer (shadow, outer stroke, glow, text), the same layers the worker
 * writes as ASS events. Nothing here lays text out across words.
 *
 * Poses come from the playhead. Every tick of the time source computes each
 * word's entrance pose from `timeSec - word.startSec` and writes transform,
 * opacity, filter and visibility straight to the elements: no React state per
 * frame and no mount-triggered animation, so pause, scrub and seeking into an
 * entrance show what the export shows at that time.
 *
 * All colour values here are USER caption colours (they feed the burn-in) and
 * intentionally stay literal, never theme tokens.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { layoutCaptionBlock, type CaptionBlockLayout, type MeasuredWord, type PlacedWord } from "@narriflow/caption-fonts/caption-block";
import { captionGraphemes } from "@narriflow/caption-fonts/emoji";
import type { CompositionCaptionBlock } from "@narriflow/composition-plan";
import {
  CAPTION_EXTRUDE,
  CAPTION_GLOW_SIGMAS,
  CAPTION_HARD_SHADOW,
  CAPTION_MOTIONS,
  CAPTION_SOFT_SHADOW,
  captionBlockAnimation,
  captionDynamicStyle,
  captionEntranceKeyframes,
  captionFontFace,
  captionRoleLook,
  joinTranscriptWords,
  languageDirection,
  textDirection,
  type CaptionFontName,
  type CaptionKeyframe,
  type CaptionPreset,
} from "@narriflow/validators";
import { brandFontFamily, brandFontStyle, useBrandFont, type BrandFontChoice } from "@/app/(app)/brand-kit/_components/brand-fonts";
import {
  CAPTION_FACE_OWN_SCRIPTS,
  captionFaceDraws,
  captionFontStack,
  captionLetterSpacingRuns,
  hasUnspacedScript,
  type CaptionOwnScript,
} from "@/app/caption-script-fonts";
import { captionBlockTransform, captionBlockWordPose } from "./caption-block-pose";
import { ASS_CAMERA_DISTANCE_PX, captionFontStyle, captionFontVariable, CaptionText } from "./caption-style-engine";

// ─── Time sources ────────────────────────────────────────────────────────────

/** What drives the poses: the Studio playback clock, a looping sample, or a fixed time. */
export interface CaptionTimeSource {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
}

/** A time that never moves: still previews and the parity harness. */
export function staticTimeSource(timeSec: number): CaptionTimeSource {
  return { getSnapshot: () => timeSec, subscribe: () => () => undefined };
}

const loopSources = new Map<number, CaptionTimeSource>();

/**
 * A shared clock that loops over `loopSec` while anything listens: one
 * animation frame loop for every thumbnail on the page, stopped when the
 * last one unsubscribes (off screen, reduced motion).
 */
export function loopTimeSource(loopSec: number): CaptionTimeSource {
  const existing = loopSources.get(loopSec);
  if (existing) return existing;
  const listeners = new Set<() => void>();
  let frame = 0;
  const now = () => (performance.now() / 1000) % loopSec;
  const tick = () => {
    for (const listener of listeners) listener();
    frame = requestAnimationFrame(tick);
  };
  const source: CaptionTimeSource = {
    getSnapshot: now,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) frame = requestAnimationFrame(tick);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) cancelAnimationFrame(frame);
      };
    },
  };
  loopSources.set(loopSec, source);
  return source;
}

// ─── Measurement ─────────────────────────────────────────────────────────────

const MEASURE_PX = 100;
const measureCache = new Map<string, MeasuredWord>();
let measureContext: CanvasRenderingContext2D | null = null;

/** The face one word is drawn in, resolved for the DOM and for Canvas. */
interface WordFace {
  /** The face's resolved CSS family (the next/font family, or the brand font's). */
  readonly requestedFamily: string;
  /** DOM font declarations, with the script fallbacks for the cue's language. */
  readonly css: CSSProperties;
  readonly weight: number;
  readonly style: string;
  /** Catalog line metrics (OS/2 win metrics, the face's ascent and descent overrides). */
  readonly ascent: number;
  readonly descent: number;
  readonly ownScripts: readonly CaptionOwnScript[];
}

function wordFace(
  slot: "text" | "hero",
  fontName: CaptionFontName,
  customFont: BrandFontChoice | null,
  language: string | null,
): WordFace | null {
  if (slot === "text" && customFont) {
    const requestedFamily = `"${brandFontFamily(customFont)}"`;
    const face = customFont.face ?? captionFontFace(fontName);
    return {
      requestedFamily,
      css: { ...brandFontStyle(customFont), fontFamily: captionFontStack(requestedFamily, language) },
      weight: customFont.weight,
      style: customFont.face?.style ?? "normal",
      ascent: face.ascent,
      descent: face.descent,
      // A brand font's coverage is unknown: only its Latin counts as drawn by it.
      ownScripts: [],
    };
  }
  const requestedFamily = getComputedStyle(document.documentElement).getPropertyValue(captionFontVariable(fontName)).trim();
  if (!requestedFamily) return null;
  const face = captionFontFace(fontName);
  return {
    requestedFamily,
    css: captionFontStyle(fontName, language),
    weight: face.weight,
    style: face.style,
    ascent: face.ascent,
    descent: face.descent,
    ownScripts: CAPTION_FACE_OWN_SCRIPTS[fontName] ?? [],
  };
}

/** Canvas font strings for one face: the face alone, and its whole fallback stack. */
function canvasFonts(face: WordFace, language: string | null) {
  const prefix = `${face.style} ${face.weight} ${MEASURE_PX}px`;
  return { requested: `${prefix} ${face.requestedFamily}`, stack: `${prefix} ${captionFontStack(face.requestedFamily, language)}` };
}

/**
 * Whether the faces that draw `text` have loaded: the requested face, and the
 * fallback chain when part of the text is in a script the face lacks.
 */
function facesLoaded(text: string, face: WordFace, language: string | null): boolean {
  const fonts = canvasFonts(face, language);
  if (!document.fonts.check(fonts.requested, text)) return false;
  const needsFallback = captionGraphemes(text).some((cluster) => !captionFaceDraws(cluster, face.ownScripts));
  return !needsFallback || document.fonts.check(fonts.stack, text);
}

function loadFaces(text: string, face: WordFace, language: string | null): Promise<unknown> {
  const fonts = canvasFonts(face, language);
  return Promise.all([document.fonts.load(fonts.requested, text), document.fonts.load(fonts.stack, text)]);
}

/**
 * One word measured alone in its face, at 1 em (spec 5.6, Studio): Canvas
 * `measureText` at 100 px, fractional `width` and `actualBoundingBox*`, the
 * method `measureCaptionFallbackInkEm` uses. The advance includes letter
 * spacing and excludes the trailing spacing, as the shared geometry expects;
 * scripts that take no letter spacing are measured without it, as they draw.
 */
function measureWord(text: string, face: WordFace, letterSpacingEm: number, direction: "ltr" | "rtl", language: string | null, cache: boolean): MeasuredWord {
  const font = canvasFonts(face, language).stack;
  const key = `${font}\0${letterSpacingEm}\0${direction}\0${text}`;
  const cached = measureCache.get(key);
  if (cached) return cached;
  measureContext ??= document.createElement("canvas").getContext("2d");
  const context = measureContext!;
  context.font = font;
  context.direction = direction;
  const spacing = (em: number) => {
    if ("letterSpacing" in context) context.letterSpacing = `${em * MEASURE_PX}px`;
  };
  const runs = hasUnspacedScript(text) ? captionLetterSpacingRuns(text) : [{ text, spaced: true }];
  let width = 0;
  for (const run of runs) {
    spacing(run.spaced ? letterSpacingEm : 0);
    width += context.measureText(run.text).width;
    // Without Canvas letterSpacing, add CSS's spacing after every character by hand.
    if (!("letterSpacing" in context) && run.spaced) width += letterSpacingEm * MEASURE_PX * captionGraphemes(run.text).length;
  }
  spacing(0);
  const ink = context.measureText(text);
  const trailing = runs[runs.length - 1]?.spaced ? letterSpacingEm : 0;
  const measured: MeasuredWord = {
    advanceEm: width / MEASURE_PX - trailing,
    inkTopEm: Math.max(0, ink.actualBoundingBoxAscent) / MEASURE_PX,
    inkBottomEm: Math.max(0, ink.actualBoundingBoxDescent) / MEASURE_PX,
  };
  if (cache) {
    if (measureCache.size > 5000) measureCache.clear();
    measureCache.set(key, measured);
  }
  return measured;
}

// ─── Layout ──────────────────────────────────────────────────────────────────

/** A cue the painter can draw: a plan caption layer with a block fits, and so does a sample cue. */
export interface CaptionBlockCueInput {
  readonly block: CompositionCaptionBlock;
  readonly words: readonly { readonly startSec: number; readonly endSec: number; readonly spaceBefore?: boolean }[];
  readonly preset: CaptionPreset;
  readonly language: string | null;
  readonly anchor: { readonly xPct: number; readonly yPct: number };
  readonly activeRange: { readonly startSec: number; readonly endSec: number };
}

/** One word ready to paint: its text, face, colour, placement and entrance. */
export interface CaptionBlockPaintWord {
  readonly text: string;
  readonly dir: "ltr" | "rtl";
  readonly face: WordFace;
  readonly color: string;
  /** Fill of the word's tile (tile styles), else null. */
  readonly tileColor: string | null;
  readonly letterSpacingEm: number;
  readonly placed: PlacedWord;
  readonly startSec: number;
  readonly keyframes: readonly CaptionKeyframe[];
}

export interface CaptionBlockPaint {
  readonly cue: CaptionBlockCueInput;
  readonly layout: CaptionBlockLayout;
  readonly words: readonly CaptionBlockPaintWord[];
  readonly language: string | null;
  /** The cue's base direction; a left style mirrors to the right edge for "rtl". */
  readonly direction: "ltr" | "rtl";
}

type PaintResult =
  | { readonly status: "ready"; readonly paint: CaptionBlockPaint }
  | { readonly status: "pending"; readonly load: () => Promise<unknown> };

function buildPaint(
  cue: CaptionBlockCueInput,
  canvas: { readonly width: number; readonly height: number },
  customFont: BrandFontChoice | null,
  force: boolean,
): PaintResult | null {
  const { block, preset, language } = cue;
  if (block.roles.length === 0 || block.roles.length !== cue.words.length) return null;
  const style = captionDynamicStyle(block.style);
  const motion = CAPTION_MOTIONS[captionBlockAnimation(preset, style)];
  // The cue's base direction: its first strong character, else the language's (the burn-in's rule).
  const cueDir = textDirection(
    joinTranscriptWords(block.texts.map((text, index) => ({ word: text, ...(cue.words[index]!.spaceBefore === undefined ? {} : { spaceBefore: cue.words[index]!.spaceBefore }) }))),
    languageDirection(language),
  );
  const prepared = [];
  const pending: (() => Promise<unknown>)[] = [];
  for (const [index, role] of block.roles.entries()) {
    const text = block.texts[index]!;
    const look = captionRoleLook(preset, style, role, block.seed);
    const face = wordFace(look.font, look.fontName, customFont, language);
    if (!face) return null;
    const ready = facesLoaded(text, face, language);
    if (!ready) pending.push(() => loadFaces(text, face, language));
    prepared.push({ text, look, face, ready, dir: textDirection(text, cueDir) });
  }
  if (pending.length > 0 && !force) return { status: "pending", load: () => Promise.all(pending.map((load) => load())) };
  // The line box middle is where libass anchors and scales a word's event; the Studio scales about the same point.
  const measured = prepared.map((word): MeasuredWord => ({
    ...measureWord(word.text, word.face, word.look.letterSpacing, word.dir, language, word.ready),
    boxMiddleEm: (word.face.ascent - word.face.descent) / 2,
  }));
  const layout = layoutCaptionBlock({
    block,
    preset,
    style,
    words: cue.words,
    measured,
    canvas,
    anchor: cue.anchor,
    direction: cueDir,
    cueEndSec: cue.activeRange.endSec,
  });
  const words = prepared.map((word, index): CaptionBlockPaintWord => ({
    text: word.text,
    dir: word.dir,
    face: word.face,
    color: word.look.color,
    tileColor: word.look.tileColor,
    letterSpacingEm: word.look.letterSpacing,
    placed: layout.words[index]!,
    startSec: cue.words[index]!.startSec,
    keyframes: captionEntranceKeyframes(motion, block.roles[index] === "hero"),
  }));
  return { status: "ready", paint: { cue, layout, words, language, direction: cueDir } };
}

const subscribeNothing = () => () => undefined;

/**
 * Measures and lays out a Caption Block cue on `canvas` (canvas px). Null
 * until the cue's faces have loaded (and during server rendering and
 * hydration, which have no fonts to measure). It changes only when the cue,
 * the canvas or a face changes, never per frame.
 */
export function useCaptionBlockPaint(
  cue: CaptionBlockCueInput | null,
  canvas: { readonly width: number; readonly height: number },
): CaptionBlockPaint | null {
  const client = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const customFont = useBrandFont(cue?.preset.fontAsset);
  // After a load settles for this cue, measure with whatever faces arrived rather than wait forever on a failed one.
  const [settledFor, setSettledFor] = useState<CaptionBlockCueInput | null>(null);
  const { width, height } = canvas;
  const result = useMemo(
    () => (client && cue && width > 0 && height > 0 ? buildPaint(cue, { width, height }, customFont, settledFor === cue) : null),
    [client, cue, width, height, customFont, settledFor],
  );
  useEffect(() => {
    if (result?.status !== "pending" || !cue) return;
    let live = true;
    void result.load().catch(() => undefined).then(() => {
      if (live) setSettledFor(cue);
    });
    return () => {
      live = false;
    };
  }, [result, cue]);
  return result?.status === "ready" ? result.paint : null;
}

// ─── Painting ────────────────────────────────────────────────────────────────

const baselineCache = new Map<string, number>();

/**
 * Where the browser puts the baseline inside a word box of `face` at
 * `fontPx` display px, measured from the box top. The box's line height is
 * the face's own line box, but Chrome rounds the face's ascent to whole
 * pixels at each size, so `ascent × size` can be off by most of a pixel; a
 * probe at the real size lands the baseline where the layout says. Called
 * only once the faces have loaded (a paint exists), and cached.
 */
function baselineOffsetPx(face: WordFace, fontPx: number): number {
  const key = `${face.requestedFamily}\0${face.weight}\0${face.style}\0${fontPx}`;
  const cached = baselineCache.get(key);
  if (cached !== undefined) return cached;
  const box = document.createElement("span");
  Object.assign(box.style, face.css, {
    position: "absolute",
    left: "-99999px",
    top: "0px",
    visibility: "hidden",
    whiteSpace: "pre",
    lineHeight: String(face.ascent + face.descent),
    fontSize: `${fontPx}px`,
  });
  const anchor = document.createElement("i");
  anchor.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
  box.append(anchor, "H");
  document.body.append(box);
  const offset = anchor.getBoundingClientRect().top - box.getBoundingClientRect().top;
  box.remove();
  if (baselineCache.size > 2000) baselineCache.clear();
  baselineCache.set(key, offset);
  return offset;
}

/** One element per word per paint layer; the pose is written on it every tick. */
function WordLayer({
  word,
  index,
  scale,
  origin,
  children,
  style,
}: {
  word: CaptionBlockPaintWord;
  index: number;
  scale: number;
  origin: { readonly x: number; readonly y: number };
  children: ReactNode;
  style?: CSSProperties;
}) {
  const { placed, face } = word;
  // The box's line height is the face's own line box (its ascent and descent overrides), so the
  // baseline sits about `ascent` em below the top whatever fallback face draws part of the word;
  // the probe gives the browser's exact offset at this size.
  const fontPx = placed.px * scale;
  const left = (placed.baselineX - origin.x) * scale;
  const top = (placed.baselineY - origin.y) * scale - baselineOffsetPx(face, fontPx);
  return (
    <span
      aria-hidden
      data-caption-block-word={index}
      data-scale-x={(placed.scaleOriginX - placed.centerX) * scale}
      data-scale-y={(placed.scaleOriginY - placed.centerY) * scale}
      dir={word.dir}
      style={{
        position: "absolute",
        left: `${left}px`,
        top: `${top}px`,
        whiteSpace: "pre",
        lineHeight: face.ascent + face.descent,
        fontSize: `${fontPx}px`,
        letterSpacing: `${word.letterSpacingEm}em`,
        ...face.css,
        transformOrigin: `${(placed.centerX - origin.x) * scale - left}px ${(placed.centerY - origin.y) * scale - top}px`,
        visibility: "hidden",
        willChange: "transform, opacity",
        pointerEvents: "none",
        paintOrder: "stroke fill",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/**
 * A word's tile (or its hard shadow, moved `offset` canvas px right and down): a rounded
 * rectangle that turns and travels with its word about the word's centre, and scales about
 * its own centre, as the worker's `\p1` tile event does.
 */
function TileLayer({
  word,
  index,
  scale,
  origin,
  color,
  offset,
}: {
  word: CaptionBlockPaintWord;
  index: number;
  scale: number;
  origin: { readonly x: number; readonly y: number };
  color: string;
  offset: number;
}) {
  const { placed } = word;
  const tile = placed.tile!;
  const centerX = tile.centerX + offset;
  const centerY = tile.centerY + offset;
  const left = (centerX - tile.width / 2 - origin.x) * scale;
  const top = (centerY - tile.height / 2 - origin.y) * scale;
  return (
    <div
      aria-hidden
      data-caption-block-word={index}
      data-scale-x={(centerX - placed.centerX) * scale}
      data-scale-y={(centerY - placed.centerY) * scale}
      style={{
        position: "absolute",
        left: `${left}px`,
        top: `${top}px`,
        width: `${tile.width * scale}px`,
        height: `${tile.height * scale}px`,
        borderRadius: `${tile.radius * scale}px`,
        background: color,
        transformOrigin: `${(placed.centerX - origin.x) * scale - left}px ${(placed.centerY - origin.y) * scale - top}px`,
        visibility: "hidden",
        willChange: "transform, opacity",
        pointerEvents: "none",
      }}
    />
  );
}

const silhouette = (width: number, color: string): CSSProperties => (width > 0 ? { WebkitTextStroke: `${width * 2}px ${color}` } : {});

interface CaptionBlockWordsProps {
  paint: CaptionBlockPaint;
  /** Display px per canvas px. */
  scale: number;
  /** Canvas point drawn at the container's top-left corner. */
  origin: { readonly x: number; readonly y: number };
  timeSource: CaptionTimeSource;
  /** Settled words, as classic presets show with reduced motion. */
  reducedMotion: boolean;
}

/**
 * Draws a laid-out block inside a positioned container. Paint layers are
 * siblings in the export's layer order (every shadow below every outer
 * stroke, glow and text), as the worker's per-layer events stack.
 */
export const CaptionBlockWords = memo(function CaptionBlockWords({ paint, scale, origin, timeSource, reducedMotion }: CaptionBlockWordsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { preset } = paint.cue;
  const S = preset.fontSize;
  const style = captionDynamicStyle(paint.cue.block.style);
  const soft = style.softShadow ?? [CAPTION_SOFT_SHADOW];

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Each element with its scale origin, as an offset from the word centre in display px.
    const elements: { element: HTMLElement; scaleOrigin: { x: number; y: number } }[][] = paint.words.map(() => []);
    for (const element of root.querySelectorAll<HTMLElement>("[data-caption-block-word]")) {
      const scaleOrigin = { x: Number(element.dataset.scaleX ?? 0), y: Number(element.dataset.scaleY ?? 0) };
      elements[Number(element.dataset.captionBlockWord)]?.push({ element, scaleOrigin });
    }
    const written = paint.words.map(() => "");
    const perspectivePx = ASS_CAMERA_DISTANCE_PX * scale;
    const endSec = paint.cue.activeRange.endSec;
    const paintAt = () => {
      const timeSec = timeSource.getSnapshot();
      paint.words.forEach((word, index) => {
        // Unspoken words are not drawn; a word stays until the cue ends.
        const visible = timeSec >= word.startSec && timeSec <= endSec;
        let opacity = "";
        let filter = "";
        let pose: ReturnType<typeof captionBlockWordPose> | null = null;
        const emPx = word.placed.px * scale;
        if (visible) {
          pose = captionBlockWordPose(word.keyframes, (timeSec - word.startSec) * 1000, reducedMotion ? 0 : word.placed.entranceTimeScale);
          opacity = String(pose.opacity);
          filter = pose.blurEm * emPx > 0.01 ? `blur(${pose.blurEm * emPx}px)` : "none";
        }
        const transformFor = (scaleOrigin: { x: number; y: number }) =>
          pose ? captionBlockTransform(pose, { rotationDeg: word.placed.rotationDeg, motionSign: word.placed.motionSign, emPx }, perspectivePx, scaleOrigin) : "";
        const key = pose ? `${opacity}|${transformFor({ x: 0, y: 0 })}|${filter}` : "hidden";
        if (key === written[index]) return;
        written[index] = key;
        for (const { element, scaleOrigin } of elements[index]!) {
          element.style.visibility = visible ? "visible" : "hidden";
          if (!visible) continue;
          element.style.opacity = opacity;
          element.style.transform = transformFor(scaleOrigin);
          element.style.filter = filter;
        }
      });
    };
    paintAt();
    return timeSource.subscribe(paintAt);
  }, [paint, scale, timeSource, reducedMotion]);

  const layer = (name: string, render: (word: CaptionBlockPaintWord, ratio: number) => ReactNode) => (
    <div key={name} style={{ position: "absolute", left: 0, top: 0 }}>
      {paint.words.map((word, index) => {
        const content = render(word, word.placed.px / S);
        return content === null ? null : (
          <WordLayer key={index} word={word} index={index} scale={scale} origin={origin}>
            {content}
          </WordLayer>
        );
      })}
    </div>
  );

  // Strokes, shadows and glow scale with each word's size relative to the body size S (spec 5.2).
  const stroke = (ratio: number) => preset.outlineWidth * ratio * scale;
  const outer = (ratio: number) => (preset.outerOutlineWidth ?? 0) * ratio * scale;
  const glyphs = (text: string, css: CSSProperties) => (
    <span style={{ position: "relative", display: "inline-block", ...css }}>
      <CaptionText text={text} />
    </span>
  );

  const layers: ReactNode[] = [];
  // Tiles sit below every text layer, their hard shadows below every tile (the worker's layer 0).
  const tile = style.tile;
  if (tile && tile.shadowEm > 0) {
    layers.push(
      <div key="tile-shadow" style={{ position: "absolute", left: 0, top: 0 }}>
        {paint.words.map((word, index) =>
          word.placed.tile && word.tileColor ? (
            <TileLayer key={index} word={word} index={index} scale={scale} origin={origin} color={preset.shadowColor} offset={word.placed.tile.shadowOffset} />
          ) : null)}
      </div>,
    );
  }
  if (tile) {
    layers.push(
      <div key="tile" style={{ position: "absolute", left: 0, top: 0 }}>
        {paint.words.map((word, index) =>
          word.placed.tile && word.tileColor ? (
            <TileLayer key={index} word={word} index={index} scale={scale} origin={origin} color={word.tileColor} offset={0} />
          ) : null)}
      </div>,
    );
  }
  if (preset.shadow === "soft") {
    // One element per soft shadow layer, lowest first, as the worker writes one event per layer.
    soft.forEach((shadow, at) => {
      layers.push(
        layer(`shadow-${at}`, (word, ratio) =>
          glyphs(word.text, {
            color: preset.shadowColor,
            ...silhouette(stroke(ratio) + outer(ratio), preset.shadowColor),
            opacity: shadow.opacity,
            transform: `translateY(${shadow.offsetYEm}em)`,
            filter: `blur(${shadow.blurEm * word.placed.px * scale}px)`,
          })),
      );
    });
  } else if (preset.shadow !== "none") {
    layers.push(
      layer("shadow", (word, ratio) => {
        const base: CSSProperties = { color: preset.shadowColor, ...silhouette(stroke(ratio) + outer(ratio), preset.shadowColor) };
        if (preset.shadow === "hard") {
          return glyphs(word.text, { ...base, transform: `translate(${CAPTION_HARD_SHADOW.offsetXEm}em, ${CAPTION_HARD_SHADOW.offsetYEm}em)` });
        }
        return Array.from({ length: CAPTION_EXTRUDE.steps }, (_, step) => {
          const distance = (CAPTION_EXTRUDE.steps - step) * CAPTION_EXTRUDE.stepEm;
          return (
            <span key={step} style={{ position: step === 0 ? "relative" : "absolute", left: 0, top: 0, ...base, transform: `translate(${distance}em, ${distance}em)` }}>
              <CaptionText text={word.text} />
            </span>
          );
        });
      }),
    );
  }
  if ((preset.outerOutlineWidth ?? 0) > 0 && preset.outerOutlineColor) {
    const color = preset.outerOutlineColor;
    layers.push(layer("outer", (word, ratio) => glyphs(word.text, { color, ...silhouette(stroke(ratio) + outer(ratio), color) })));
  }
  if (preset.glowColor) {
    const color = preset.glowColor;
    for (const sigma of CAPTION_GLOW_SIGMAS) {
      layers.push(
        layer(`glow-${sigma}`, (word, ratio) =>
          glyphs(word.text, { color, filter: `blur(${sigma * (preset.glowIntensity ?? 8) * ratio * scale}px)` })),
      );
    }
  }
  layers.push(
    layer("text", (word, ratio) => glyphs(word.text, { color: word.color, ...silhouette(stroke(ratio), preset.outlineColor) })),
  );

  return (
    <div ref={rootRef} lang={paint.language ?? undefined} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", userSelect: "none" }}>
      {layers}
    </div>
  );
});

// ─── Framed and fitted blocks ────────────────────────────────────────────────

/**
 * A block cue drawn over a frame whose top-left is canvas (0, 0): the parity
 * harness and the preset thumbnails, where position on the frame matters.
 */
export function CaptionBlockFrame({
  cue,
  canvas,
  scale,
  timeSource,
  reducedMotion = false,
  onPaint,
}: {
  cue: CaptionBlockCueInput;
  canvas: { readonly width: number; readonly height: number };
  /** Display px per canvas px. */
  scale: number;
  timeSource: CaptionTimeSource;
  reducedMotion?: boolean;
  /** Receives the layout once it exists (the parity harness reports it). */
  onPaint?: (paint: CaptionBlockPaint) => void;
}) {
  const paint = useCaptionBlockPaint(cue, canvas);
  useEffect(() => {
    if (paint) onPaint?.(paint);
  }, [paint, onPaint]);
  if (!paint) return null;
  return <CaptionBlockWords paint={paint} scale={scale} origin={ORIGIN} timeSource={timeSource} reducedMotion={reducedMotion} />;
}

const ORIGIN = { x: 0, y: 0 } as const;

/**
 * A block cue laid out on its real canvas, then scaled so its bounds fit a
 * small box and centred in it: the Captions panel preview and the template
 * thumbnails, where the whole block must stay readable.
 */
export function CaptionBlockFit({
  cue,
  canvas,
  boxWidth,
  boxHeight,
  maxScale,
  timeSource,
  reducedMotion = false,
}: {
  cue: CaptionBlockCueInput;
  canvas: { readonly width: number; readonly height: number };
  boxWidth: number;
  boxHeight: number;
  /** Largest display px per canvas px. */
  maxScale: number;
  timeSource: CaptionTimeSource;
  reducedMotion?: boolean;
}) {
  const paint = useCaptionBlockPaint(cue, canvas);
  const bounds = paint?.layout.bounds;
  const origin = useMemo(() => ({ x: bounds?.x ?? 0, y: bounds?.y ?? 0 }), [bounds?.x, bounds?.y]);
  if (!paint || !bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const scale = Math.min(maxScale, (boxWidth * 0.92) / bounds.width, (boxHeight * 0.88) / bounds.height);
  return (
    <div style={{ position: "relative", width: `${bounds.width * scale}px`, height: `${bounds.height * scale}px`, flexShrink: 0 }}>
      <CaptionBlockWords paint={paint} scale={scale} origin={origin} timeSource={timeSource} reducedMotion={reducedMotion} />
    </div>
  );
}
