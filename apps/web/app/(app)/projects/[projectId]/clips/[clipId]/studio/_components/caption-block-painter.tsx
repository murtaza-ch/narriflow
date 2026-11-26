"use client";

/**
 * The Studio's Caption Block painter (spec 5.6 "Painting", 5.7, ADR 0020).
 *
 * Each word of a Dynamic Style cue is measured alone with Canvas
 * `measureText` at 100 px once its faces have loaded, placed by the shared
 * `layoutCaptionBlock`, and drawn as absolutely positioned elements, one per
 * paint layer (shadow, outer stroke, glow, text), the same layers the worker
 * writes as ASS events. Nothing here lays text out across words. A gradient
 * hero fills with `background-clip: text` over the hero's rest ink box (the
 * worker's bands), and decorations are SVG paths of the shared shapes.
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
import {
  captionBlockCurve,
  captionBlockDirection,
  captionClusterPositions,
  captionTextClusters,
  captionWordDirection,
  layoutCaptionBlock,
  type MeasuredCluster,
  type CaptionBlockLayout,
  type MeasuredWord,
  type PlacedDecoration,
  type PlacedGradient,
  type PlacedWord,
} from "@narriflow/caption-fonts/caption-block";
import { captionGraphemes, isCaptionEmojiCluster } from "@narriflow/caption-fonts/graphemes";
import type { CompositionCaptionBlock } from "@narriflow/composition-plan";
import {
  CAPTION_EXTRUDE,
  CAPTION_GLOW_SIGMAS,
  CAPTION_HARD_SHADOW,
  CAPTION_SHAPES,
  CAPTION_SOFT_SHADOW,
  captionDynamicStyle,
  captionFontFace,
  captionRoleLook,
  captionShapeSvgPath,
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
  captionWordBoxMiddleEm,
  hasUnspacedScript,
  type CaptionOwnScript,
} from "@/app/caption-script-fonts";
import { captionBlockTransform, captionBlockWordPose, captionDecorationPose, captionWipeClipPath } from "./caption-block-pose";
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
export interface WordFace {
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

export function wordFace(
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

/**
 * The face of an uploaded brand font in a Text Layer: the upload, then the layer's catalog face for
 * glyphs the upload lacks, then the script fallbacks. The worker's planner tries the same faces in
 * the same order (requested, saved, script faces). The upload's own metrics set its line box.
 */
export function uploadWordFace(font: BrandFontChoice, fallback: CaptionFontName, language: string | null): WordFace | null {
  const variable = captionFontVariable(fallback);
  const fallbackFamily = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (!font.face || !fallbackFamily) return null;
  const upload = `"${brandFontFamily(font)}"`;
  return {
    requestedFamily: `${upload}, ${fallbackFamily}`,
    css: { fontFamily: captionFontStack(`${upload}, var(${variable})`, language), fontWeight: font.weight, fontStyle: font.face.style, fontSynthesis: "none" },
    weight: font.weight,
    style: font.face.style,
    ascent: font.face.ascent,
    descent: font.face.descent,
    // An upload's coverage is unknown: every cluster checks the whole stack.
    ownScripts: [],
  };
}

/**
 * Canvas font strings for one face: the face alone and its whole fallback stack (for loading),
 * and the stack to measure with. The DOM draws every caption word with `font-synthesis: none`
 * and libass never synthesizes, but Canvas has no such switch: at the role's weight (600 or
 * more) it fake-bolds a script face, which is one regular file, so Nastaliq or Noto Sans JP ink
 * read 1/64 em taller and deeper than either painter draws them (ticket 05b: 12 px of row pitch
 * on an Urdu hero). Every caption family holds a single face (one `localFont` per catalog face,
 * one family per brand font), so `normal 400` selects the same faces the DOM draws and leaves
 * Canvas nothing to synthesize.
 */
function canvasFonts(face: WordFace, language: string | null) {
  const prefix = `${face.style} ${face.weight} ${MEASURE_PX}px`;
  const stack = captionFontStack(face.requestedFamily, language);
  return { requested: `${prefix} ${face.requestedFamily}`, stack: `${prefix} ${stack}`, measure: `normal 400 ${MEASURE_PX}px ${stack}` };
}

/**
 * Whether the faces that draw `text` have loaded: the requested face, and the
 * fallback chain when part of the text is in a script the face lacks.
 */
export function facesLoaded(text: string, face: WordFace, language: string | null): boolean {
  const fonts = canvasFonts(face, language);
  if (!document.fonts.check(fonts.requested, text)) return false;
  // An emoji is Common script, so `captionFaceDraws` counts it as the face's; it is drawn by the
  // emoji fallback face, which must have loaded too, or a build whose own face is already in (an
  // upload resolved after the page's other text) measures the emoji in a system face and keeps it.
  const needsFallback = captionGraphemes(text).some((cluster) => isCaptionEmojiCluster(cluster) || !captionFaceDraws(cluster, face.ownScripts));
  return !needsFallback || document.fonts.check(fonts.stack, text);
}

export function loadFaces(text: string, face: WordFace, language: string | null): Promise<unknown> {
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
export function measureWord(text: string, face: WordFace, letterSpacingEm: number, direction: "ltr" | "rtl", language: string | null, cache: boolean): MeasuredWord {
  const font = canvasFonts(face, language).measure;
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

/**
 * A curved word's glyph clusters placed in the word (spec 5.11): Canvas `measureText` of each
 * prefix ending with a cluster, with the word's letter spacing (so kerning counts), and of each
 * cluster alone without it, combined by the shared `captionClusterPositions` exactly as the worker
 * combines HarfBuzz's. Same font string as `measureWord` (regular weight, ticket 05b).
 */
function measureClusters(text: string, face: WordFace, letterSpacingEm: number, language: string | null): MeasuredCluster[] {
  measureContext ??= document.createElement("canvas").getContext("2d");
  const context = measureContext!;
  context.font = canvasFonts(face, language).measure;
  context.direction = "ltr";
  const hasSpacing = "letterSpacing" in context;
  const width = (value: string, spacingEm: number) => {
    if (hasSpacing) context.letterSpacing = `${spacingEm * MEASURE_PX}px`;
    const measured = context.measureText(value).width;
    return (measured + (hasSpacing ? 0 : spacingEm * MEASURE_PX * captionGraphemes(value).length)) / MEASURE_PX;
  };
  const clusters = captionTextClusters(text);
  const prefixes: number[] = [];
  const alone: number[] = [];
  let prefix = "";
  for (const cluster of clusters) {
    prefix += cluster;
    prefixes.push(width(prefix, letterSpacingEm));
    alone.push(width(cluster, 0));
  }
  if (hasSpacing) context.letterSpacing = "0px";
  return captionClusterPositions(prefixes, alone, clusters.map(() => letterSpacingEm));
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

/**
 * One drawn element group of a word: the word itself on a straight row, or one of its glyph
 * clusters on a curved row (spec 5.11). Every paint layer draws each item once.
 */
export interface CaptionBlockPaintItem {
  readonly text: string;
  readonly px: number;
  readonly baselineX: number;
  readonly baselineY: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly scaleOriginX: number;
  readonly scaleOriginY: number;
  readonly rotationDeg: number;
  readonly letterSpacingEm: number;
  /** A curved cluster: the word's travel stays in screen space while the cluster turns. */
  readonly screenTravel: boolean;
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
  /** What the shared geometry was given for this word, at 1 em (the parity harness reports it). */
  readonly measured: MeasuredWord;
  readonly startSec: number;
  readonly keyframes: readonly CaptionKeyframe[];
  /** A hero word: it takes the block's gradient when there is one. */
  readonly hero: boolean;
  /** What each paint layer draws for the word: the word, or its clusters on a curved row. */
  readonly items: readonly CaptionBlockPaintItem[];
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
  const curved = captionBlockCurve({ preset, style, texts: block.texts, language }) !== 0;
  // The cue's and each word's direction come from the shared geometry, as the burn-in's do.
  const cueDir = captionBlockDirection(block.texts, language);
  const prepared = [];
  const pending: (() => Promise<unknown>)[] = [];
  for (const [index, role] of block.roles.entries()) {
    const text = block.texts[index]!;
    const look = captionRoleLook(preset, style, role, block.seed, text);
    const face = wordFace(look.font, look.fontName, customFont, language);
    if (!face) return null;
    const ready = facesLoaded(text, face, language);
    if (!ready) pending.push(() => loadFaces(text, face, language));
    prepared.push({ text, look, face, ready, dir: captionWordDirection(text, cueDir) });
  }
  if (pending.length > 0 && !force) return { status: "pending", load: () => Promise.all(pending.map((load) => load())) };
  // The line box middle is where libass anchors and scales a word's event; the Studio scales about the same point.
  // Of the face that draws the word: a fallback face's for Urdu or Japanese, as in the burn-in.
  const measured = prepared.map((word): MeasuredWord => ({
    ...measureWord(word.text, word.face, word.look.letterSpacing, word.dir, language, word.ready),
    boxMiddleEm: captionWordBoxMiddleEm(word.text, word.face, language),
    ...(curved ? { clusters: measureClusters(word.text, word.face, word.look.letterSpacing, language) } : {}),
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
    language: cue.language,
  });
  const words = prepared.map((word, index): CaptionBlockPaintWord => {
    const placed = layout.words[index]!;
    const items: CaptionBlockPaintItem[] = placed.clusters
      ? placed.clusters.map((cluster) => ({
        ...cluster,
        scaleOriginX: cluster.centerX,
        scaleOriginY: cluster.centerY,
        letterSpacingEm: 0,
        screenTravel: true,
      }))
      : [{ ...placed, text: word.text, letterSpacingEm: word.look.letterSpacing, screenTravel: false }];
    return {
      text: word.text,
      dir: word.dir,
      face: word.face,
      color: word.look.color,
      tileColor: word.look.tileColor,
      letterSpacingEm: word.look.letterSpacing,
      placed: layout.words[index]!,
      measured: measured[index]!,
      startSec: cue.words[index]!.startSec,
      // The shared entrance (spec 5.7, 5.11): curved rows have no scale or turn keyframes.
      keyframes: placed.keyframes,
      hero: block.roles[index] === "hero",
      items,
    };
  });
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

/** Probed baseline offsets: per face and quarter-pixel size bucket, the exact size probed and its offset. */
export const baselineCache = new Map<string, { readonly fontPx: number; readonly offset: number }>();

/** Sizes share a probe per quarter pixel, so a resizing preview probes a few sizes, not every frame's. */
const baselineKey = (face: WordFace, fontPx: number) =>
  `${face.requestedFamily}\0${face.weight}\0${face.style}\0${Math.round(fontPx * 4) / 4}`;

/**
 * Where the browser puts the baseline inside a word box of `face` at
 * `fontPx` display px, measured from the box top, or null before it has been
 * probed. The box's line height is the face's own line box, but Chrome
 * rounds the face's ascent to whole pixels at each size, so `ascent × size`
 * can be off by most of a pixel. The first size seen in a quarter-pixel bucket
 * is probed exactly; another size in the same bucket (a preview mid-resize)
 * follows the ascent from it. A pure cache read: render never forces layout.
 */
export function baselineOffsetPx(face: WordFace, fontPx: number): number | null {
  const probed = baselineCache.get(baselineKey(face, fontPx));
  return probed === undefined ? null : probed.offset + (fontPx - probed.fontPx) * face.ascent;
}

/**
 * Probes the baseline offsets not cached yet, all in one layout: one hidden
 * box per face and size bucket, read together, then removed. Runs in a layout
 * effect, once a paint exists (its faces have loaded). True when it probed.
 */
export function probeBaselineOffsets(requests: readonly { readonly face: WordFace; readonly fontPx: number }[]): boolean {
  const pending = new Map<string, { face: WordFace; fontPx: number }>();
  for (const request of requests) {
    const key = baselineKey(request.face, request.fontPx);
    if (!baselineCache.has(key) && !pending.has(key)) pending.set(key, request);
  }
  if (pending.size === 0) return false;
  const probes = [...pending].map(([key, { face, fontPx }]) => {
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
    return { key, fontPx, box, anchor };
  });
  if (baselineCache.size + probes.length > 2000) baselineCache.clear();
  for (const { key, fontPx, box, anchor } of probes) {
    baselineCache.set(key, { fontPx, offset: anchor.getBoundingClientRect().top - box.getBoundingClientRect().top });
  }
  for (const { box } of probes) box.remove();
  return true;
}

/** One element per word per paint layer; the pose is written on it every tick. */
function WordLayer({
  word,
  item,
  index,
  scale,
  origin,
  children,
  style,
  gradient,
}: {
  word: CaptionBlockPaintWord;
  /** The word, or one of its clusters on a curved row. */
  item: CaptionBlockPaintItem;
  index: number;
  scale: number;
  origin: { readonly x: number; readonly y: number };
  children: ReactNode;
  style?: CSSProperties;
  /** Fill the glyphs with this gradient (`background-clip: text`) instead of a colour. */
  gradient?: PlacedGradient | null;
}) {
  const { face } = word;
  const placed = item;
  // The box's line height is the face's own line box (its ascent and descent overrides), so the
  // baseline sits about `ascent` em below the top whatever fallback face draws part of the word;
  // the probe gives the browser's exact offset at this size.
  const fontPx = placed.px * scale;
  // A gradient fill only paints inside the box: padding keeps ink that overhangs the advance box
  // (negative tracking pulls the last glyph past it) inside, and the box moves out by as much, so
  // the glyphs stay where they were.
  const pad = gradient ? GRADIENT_PAD_EM * fontPx : 0;
  const left = (placed.baselineX - origin.x) * scale - pad;
  // Until the probe has run (the layout effect below, before the first paint) the ascent stands in.
  const top = (placed.baselineY - origin.y) * scale - (baselineOffsetPx(face, fontPx) ?? face.ascent * fontPx) - pad;
  // Stops at the hero's rest ink box (canvas px) in this box's coordinates; CSS holds the end colours beyond them.
  const fill: CSSProperties = gradient
    ? {
      padding: `${pad}px`,
      color: "transparent",
      backgroundImage: `linear-gradient(to bottom, ${gradient.topColor} ${(gradient.top - origin.y) * scale - top}px, ${gradient.bottomColor} ${(gradient.bottom - origin.y) * scale - top}px)`,
      backgroundClip: "text",
      WebkitBackgroundClip: "text",
    }
    : {};
  return (
    <span
      aria-hidden
      data-caption-block-word={index}
      data-scale-x={(placed.scaleOriginX - placed.centerX) * scale}
      data-scale-y={(placed.scaleOriginY - placed.centerY) * scale}
      data-rotation={item.rotationDeg}
      data-screen-travel={item.screenTravel ? "1" : undefined}
      dir={word.dir}
      style={{
        position: "absolute",
        left: `${left}px`,
        top: `${top}px`,
        whiteSpace: "pre",
        lineHeight: face.ascent + face.descent,
        fontSize: `${fontPx}px`,
        letterSpacing: `${item.letterSpacingEm}em`,
        ...face.css,
        transformOrigin: `${(placed.centerX - origin.x) * scale - left}px ${(placed.centerY - origin.y) * scale - top}px`,
        visibility: "hidden",
        willChange: "transform, opacity",
        pointerEvents: "none",
        paintOrder: "stroke fill",
        ...style,
        ...fill,
      }}
    >
      {children}
    </span>
  );
}

/** Padding around a gradient word's box, em of its size. */
const GRADIENT_PAD_EM = 0.25;

/**
 * One decoration (or one of its shadows, `offset` canvas px away, blurred by `blurPx` display px):
 * the shared shape as an SVG path filling its box, inside a wrapper that is the wipe's clip rectangle
 * (the underline) or the box itself (a star). The wrapper carries the pose: a star scales about its
 * own centre (the worker scales each event about its `\pos`), the underline's wrapper is inset by
 * the wipe. The clip stays put while a shadow sits lower, as the worker's absolute `\clip` does.
 */
function DecorationLayer({
  decoration,
  index,
  scale,
  origin,
  color,
  opacity = 1,
  offset = { x: 0, y: 0 },
  blurPx = 0,
}: {
  decoration: PlacedDecoration;
  index: number;
  scale: number;
  origin: { readonly x: number; readonly y: number };
  color: string;
  opacity?: number;
  offset?: { readonly x: number; readonly y: number };
  blurPx?: number;
}) {
  const { bounds } = decoration;
  const box = decoration.wipe?.clip ?? bounds;
  const shapeLeft = (bounds.x + offset.x - box.x) * scale;
  const shapeTop = (bounds.y + offset.y - box.y) * scale;
  return (
    <div
      aria-hidden
      data-caption-block-decoration={index}
      style={{
        position: "absolute",
        left: `${(box.x - origin.x) * scale}px`,
        top: `${(box.y - origin.y) * scale}px`,
        width: `${box.width * scale}px`,
        height: `${box.height * scale}px`,
        transformOrigin: `${shapeLeft + (bounds.width * scale) / 2}px ${shapeTop + (bounds.height * scale) / 2}px`,
        visibility: "hidden",
        willChange: "transform, clip-path",
        pointerEvents: "none",
      }}
    >
      <svg
        aria-hidden="true"
        width={bounds.width * scale}
        height={bounds.height * scale}
        viewBox={`0 0 ${bounds.width} ${bounds.height}`}
        style={{
          position: "absolute",
          left: `${shapeLeft}px`,
          top: `${shapeTop}px`,
          overflow: "visible",
          opacity,
          ...(blurPx > 0.01 ? { filter: `blur(${blurPx}px)` } : {}),
        }}
      >
        <path d={captionShapeSvgPath(CAPTION_SHAPES[decoration.shape], bounds.width, bounds.height)} fill={color} />
      </svg>
    </div>
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
  // Re-renders the words once baseline probes land, so each is placed from the probed offset.
  const [, setProbes] = useState(0);

  useLayoutEffect(() => {
    const requests = paint.words.flatMap((word) => word.items.map((item) => ({ face: word.face, fontPx: item.px * scale })));
    if (probeBaselineOffsets(requests)) setProbes((count) => count + 1);
    // A face that loads after the probe (a script fallback) can move the baseline: probe again.
    const reprobe = () => {
      baselineCache.clear();
      probeBaselineOffsets(requests);
      setProbes((count) => count + 1);
    };
    document.fonts.addEventListener("loadingdone", reprobe);
    return () => document.fonts.removeEventListener("loadingdone", reprobe);
  }, [paint, scale]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Each element with its scale origin, as an offset from the word centre in display px.
    // Each element with its scale origin (an offset from its centre in display px) and its own rest
    // turn: a curved word's clusters each turn by their angle on the arc and travel in screen space.
    const elements: { element: HTMLElement; scaleOrigin: { x: number; y: number }; rotationDeg: number | null; screenTravel: boolean }[][] = paint.words.map(() => []);
    for (const element of root.querySelectorAll<HTMLElement>("[data-caption-block-word]")) {
      const scaleOrigin = { x: Number(element.dataset.scaleX ?? 0), y: Number(element.dataset.scaleY ?? 0) };
      const rotationDeg = element.dataset.rotation === undefined ? null : Number(element.dataset.rotation);
      elements[Number(element.dataset.captionBlockWord)]?.push({ element, scaleOrigin, rotationDeg, screenTravel: element.dataset.screenTravel === "1" });
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
        const transformFor = (scaleOrigin: { x: number; y: number }, rotationDeg: number | null = null, screenTravel = false) =>
          pose
            ? captionBlockTransform(pose, { rotationDeg: rotationDeg ?? word.placed.rotationDeg, motionSign: word.placed.motionSign, emPx }, perspectivePx, scaleOrigin, screenTravel)
            : "";
        const key = pose ? `${opacity}|${transformFor({ x: 0, y: 0 })}|${filter}` : "hidden";
        if (key === written[index]) return;
        written[index] = key;
        for (const { element, scaleOrigin, rotationDeg, screenTravel } of elements[index]!) {
          element.style.visibility = visible ? "visible" : "hidden";
          if (!visible) continue;
          element.style.opacity = opacity;
          element.style.transform = transformFor(scaleOrigin, rotationDeg, screenTravel);
          element.style.filter = filter;
        }
      });
    };
    // Decoration elements, per decoration: the fill and its shadows share one pose.
    const decorations: HTMLElement[][] = paint.layout.decorations.map(() => []);
    for (const element of root.querySelectorAll<HTMLElement>("[data-caption-block-decoration]")) {
      decorations[Number(element.dataset.captionBlockDecoration)]?.push(element);
    }
    const decorationsWritten = paint.layout.decorations.map(() => "");
    const paintDecorations = (timeSec: number) => {
      paint.layout.decorations.forEach((decoration, index) => {
        const visible = timeSec >= decoration.startSec && timeSec <= endSec;
        const pose = visible ? captionDecorationPose(decoration, (timeSec - decoration.startSec) * 1000, reducedMotion) : null;
        const transform = pose && decoration.keyframes.length > 0 ? `scale(${pose.scale})` : "";
        const clipPath = pose && decoration.wipe ? captionWipeClipPath(decoration.wipe.direction, decoration.wipe.clip.width * scale, pose.reveal) : "";
        const key = pose ? `${transform}|${clipPath}` : "hidden";
        if (key === decorationsWritten[index]) return;
        decorationsWritten[index] = key;
        for (const element of decorations[index]!) {
          element.style.visibility = visible ? "visible" : "hidden";
          if (!visible) continue;
          element.style.transform = transform;
          element.style.clipPath = clipPath;
        }
      });
    };
    const paintAll = () => {
      paintAt();
      paintDecorations(timeSource.getSnapshot());
    };
    paintAll();
    return timeSource.subscribe(paintAll);
  }, [paint, scale, timeSource, reducedMotion]);

  // One element per paint layer for every item: each word, or each cluster of a curved word.
  const layer = (
    name: string,
    render: (word: CaptionBlockPaintWord, item: CaptionBlockPaintItem, ratio: number) => ReactNode,
    gradientFor: (word: CaptionBlockPaintWord) => PlacedGradient | null = () => null,
  ) => (
    <div key={name} style={{ position: "absolute", left: 0, top: 0 }}>
      {paint.words.flatMap((word, index) =>
        word.items.map((item, at) => {
          const content = render(word, item, item.px / S);
          return content === null ? null : (
            <WordLayer key={`${index}-${at}`} word={word} item={item} index={index} scale={scale} origin={origin} gradient={gradientFor(word)}>
              {content}
            </WordLayer>
          );
        }))}
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
        layer(`shadow-${at}`, (_word, item, ratio) =>
          glyphs(item.text, {
            color: preset.shadowColor,
            ...silhouette(stroke(ratio) + outer(ratio), preset.shadowColor),
            opacity: shadow.opacity,
            transform: `translateY(${shadow.offsetYEm}em)`,
            filter: `blur(${shadow.blurEm * item.px * scale}px)`,
          })),
      );
    });
  } else if (preset.shadow !== "none") {
    layers.push(
      layer("shadow", (_word, item, ratio) => {
        const base: CSSProperties = { color: preset.shadowColor, ...silhouette(stroke(ratio) + outer(ratio), preset.shadowColor) };
        if (preset.shadow === "hard") {
          return glyphs(item.text, { ...base, transform: `translate(${CAPTION_HARD_SHADOW.offsetXEm}em, ${CAPTION_HARD_SHADOW.offsetYEm}em)` });
        }
        return Array.from({ length: CAPTION_EXTRUDE.steps }, (_, step) => {
          const distance = (CAPTION_EXTRUDE.steps - step) * CAPTION_EXTRUDE.stepEm;
          return (
            <span key={step} style={{ position: step === 0 ? "relative" : "absolute", left: 0, top: 0, ...base, transform: `translate(${distance}em, ${distance}em)` }}>
              <CaptionText text={item.text} />
            </span>
          );
        });
      }),
    );
  }
  if ((preset.outerOutlineWidth ?? 0) > 0 && preset.outerOutlineColor) {
    const color = preset.outerOutlineColor;
    layers.push(layer("outer", (_word, item, ratio) => glyphs(item.text, { color, ...silhouette(stroke(ratio) + outer(ratio), color) })));
  }
  if (preset.glowColor) {
    const color = preset.glowColor;
    for (const sigma of CAPTION_GLOW_SIGMAS) {
      layers.push(
        layer(`glow-${sigma}`, (_word, item, ratio) =>
          glyphs(item.text, { color, filter: `blur(${sigma * (preset.glowIntensity ?? 8) * ratio * scale}px)` })),
      );
    }
  }
  // A gradient hero's text sits straight in its box, so `background-clip: text` clips to its glyphs;
  // the shadow layers above stay their own elements behind it, as the worker's shadow events are.
  const gradient = paint.layout.gradient;
  const gradientFor = (word: CaptionBlockPaintWord) => (word.hero ? gradient : null);
  layers.push(
    layer(
      "text",
      (word, item, ratio) => (gradientFor(word) ? <CaptionText text={item.text} /> : glyphs(item.text, { color: word.color, ...silhouette(stroke(ratio), preset.outlineColor) })),
      gradientFor,
    ),
  );
  // Decorations above the words, their shadows first, as the worker's decoration layers are.
  const decorationShadows: ReactNode[] = [];
  const decorationFills: ReactNode[] = [];
  paint.layout.decorations.forEach((decoration, index) => {
    const em = decoration.shadowEmPx;
    if (preset.shadow === "soft") {
      soft.forEach((shadow, at) => {
        decorationShadows.push(
          <DecorationLayer key={`${index}-${at}`} decoration={decoration} index={index} scale={scale} origin={origin} color={preset.shadowColor}
            opacity={shadow.opacity} offset={{ x: 0, y: shadow.offsetYEm * em }} blurPx={shadow.blurEm * em * scale} />,
        );
      });
    } else if (preset.shadow !== "none") {
      decorationShadows.push(
        <DecorationLayer key={index} decoration={decoration} index={index} scale={scale} origin={origin} color={preset.shadowColor}
          offset={{ x: CAPTION_HARD_SHADOW.offsetXEm * em, y: CAPTION_HARD_SHADOW.offsetYEm * em }} />,
      );
    }
    decorationFills.push(<DecorationLayer key={index} decoration={decoration} index={index} scale={scale} origin={origin} color={decoration.color} />);
  });
  if (decorationFills.length > 0) {
    layers.push(
      <div key="decoration-shadow" style={{ position: "absolute", left: 0, top: 0 }}>{decorationShadows}</div>,
      <div key="decoration" style={{ position: "absolute", left: 0, top: 0 }}>{decorationFills}</div>,
    );
  }

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
