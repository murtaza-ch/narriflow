import { readFileSync } from "node:fs";
import bidiFactory from "bidi-js";
import * as hb from "harfbuzzjs";

/**
 * Caption text measured by HarfBuzz, the shaper libass burns the captions
 * with (spec D12). fontkit cannot do this: its `layout()` never returns on
 * Noto Nastaliq Urdu and throws on Gurmukhi and Telugu, so it only reads
 * cmaps and font tables here (fallback-fonts.ts).
 *
 * `layoutCaptionLine` reproduces what libass does with one caption line: the
 * Unicode bidi algorithm (bidi-js) over the whole logical text, a shaping run
 * per contiguous stretch of one face and one embedding level, runs placed in
 * visual order (UAX #9 rule L2). The result is the box of every word in the
 * order the viewer sees it, so pills, plates, active-word overlays and emoji
 * land on the right word of an RTL or mixed line.
 *
 * Direction and script are set per run exactly as libass sets them (level
 * parity and the run's text); no language tag is passed because libass passes
 * none, and a tag could only make the measured width differ from the burned one.
 *
 * Where libass puts a positioned (`\pos`) event is not the centre of its advance
 * box. `compute_string_bbox` (ass_render.c) takes the box from each cluster's
 * first glyph, at `pen + x_offset`, to that position plus the cluster's advance,
 * and `\pos` anchors the middle of it. A Nastaliq or marked Arabic cluster
 * whose first glyph is a mark with a positive `x_offset` therefore stretches the
 * box to the right (a negative one, to the left) and the drawn line sits that
 * far off its `\pos`. `bboxCenterEm` reproduces it so pills and word overlays
 * can be placed on what libass really draws (measured: Urdu words 8 to 37 px
 * left of centre at 88 px per em, Latin, Hebrew and plain Arabic exact).
 */

const bidi = bidiFactory();

interface LoadedFont {
  readonly font: hb.Font;
  readonly upem: number;
}
const MAX_LOADED_FONTS = 48;
const loaded = new Map<string, LoadedFont>();

function loadFont(path: string): LoadedFont {
  const cached = loaded.get(path);
  if (cached) return cached;
  const bytes = readFileSync(path);
  // HarfBuzz reads sfnt only and quietly shapes a WOFF as an empty font; libass (FreeType) opens WOFF2, so
  // an uploaded WOFF2 brand font cannot be measured here and its cues take the typed degradation.
  const signature = bytes.toString("latin1", 0, 4);
  if (signature === "wOF2" || signature === "wOFF") throw new Error("WOFF containers are not shaped by HarfBuzz");
  const face = new hb.Face(new hb.Blob(bytes), 0);
  const entry = { font: new hb.Font(face), upem: face.upem };
  // HarfBuzz objects free their WASM memory when garbage collected; dropping
  // the oldest entry bounds the brand fonts of a long-lived worker.
  if (loaded.size >= MAX_LOADED_FONTS) loaded.delete(loaded.keys().next().value!);
  loaded.set(path, entry);
  return entry;
}

/** One libass cluster: the glyphs of a run sharing a HarfBuzz cluster value, in the order libass lays them out. */
export interface ShapedCluster {
  /** Pen position of the cluster's first glyph, in em from the run start, without letter spacing. */
  readonly startEm: number;
  /** `x_offset` of the cluster's first glyph (libass takes the cluster's position from it). */
  readonly offsetEm: number;
  readonly advanceEm: number;
}

export interface ShapedRun {
  /** Advance in em, without letter spacing. */
  readonly advanceEm: number;
  readonly clusters: readonly ShapedCluster[];
  readonly glyphCount: number;
  /** HarfBuzz drew `.notdef` for some character: the face has no glyph for it. */
  readonly notdef: boolean;
  /** Highest and lowest ink in em above and below the baseline (`bottom` is positive when ink hangs below). */
  readonly inkTopEm: number;
  readonly inkBottomEm: number;
}

const shaped = new Map<string, ShapedRun>();

/** Raised when HarfBuzz cannot read a font or shape a run; the caption keeps its base line only. */
export class CaptionShapingError extends Error {
  readonly code = "caption_shaping_failed";
  constructor(
    readonly fontPath: string,
    cause: unknown,
  ) {
    super(`HarfBuzz could not shape text with ${fontPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Shapes `text` as one run. `rtl` null lets HarfBuzz take the direction from the script. */
export function shapeCaptionRun(path: string, text: string, rtl: boolean | null = null): ShapedRun {
  const key = `${path}\0${rtl}\0${text}`;
  const cached = shaped.get(key);
  if (cached) return cached;
  try {
    const { font, upem } = loadFont(path);
    const buffer = new hb.Buffer();
    buffer.addText(text);
    if (rtl !== null) buffer.setDirection(rtl ? hb.Direction.RTL : hb.Direction.LTR);
    buffer.guessSegmentProperties();
    hb.shape(font, buffer);
    let advance = 0;
    let notdef = false;
    let inkTop = 0;
    let inkBottom = 0;
    const glyphs = buffer.getGlyphInfosAndPositions();
    const clusters: { startEm: number; offsetEm: number; advanceEm: number }[] = [];
    let clusterValue = -1;
    for (const glyph of glyphs) {
      if (clusters.length === 0 || glyph.cluster !== clusterValue) {
        clusterValue = glyph.cluster;
        clusters.push({ startEm: advance / upem, offsetEm: (glyph.xOffset ?? 0) / upem, advanceEm: 0 });
      }
      clusters[clusters.length - 1]!.advanceEm += (glyph.xAdvance ?? 0) / upem;
      advance += glyph.xAdvance ?? 0;
      if (glyph.codepoint === 0) notdef = true;
      const extents = font.glyphExtents(glyph.codepoint);
      if (extents) {
        inkTop = Math.max(inkTop, (extents.yBearing + (glyph.yOffset ?? 0)) / upem);
        inkBottom = Math.max(inkBottom, -(extents.yBearing + extents.height + (glyph.yOffset ?? 0)) / upem);
      }
    }
    const run = { advanceEm: advance / upem, clusters, glyphCount: glyphs.length, notdef, inkTopEm: inkTop, inkBottomEm: inkBottom };
    if (shaped.size > 20_000) shaped.clear();
    shaped.set(key, run);
    return run;
  } catch (error) {
    throw new CaptionShapingError(path, error);
  }
}

/**
 * False when `path` shapes `text` with a `.notdef` glyph (conjuncts and joining forms included).
 * A font HarfBuzz cannot open (a WOFF2 upload) is judged by its cmap alone, as the caller has already done.
 */
export function fontShapesWithoutNotdef(path: string, text: string): boolean {
  try {
    return !shapeCaptionRun(path, text).notdef;
  } catch {
    return true;
  }
}

/** One stretch of caption text drawn by one face. */
export interface CaptionLinePart {
  readonly text: string;
  readonly fontPath: string;
  /** The caption's letter spacing applies after every character (false for cursive and complex scripts). */
  readonly spaced: boolean;
  /** Its ink counts toward the line's ink extents (a fallback face whose glyphs may stand taller or lower than the requested face). */
  readonly inked: boolean;
}

export interface CaptionLineWord {
  readonly parts: readonly CaptionLinePart[];
  /** The space drawn before this word; null when the words abut (no-space scripts). */
  readonly gap: CaptionLinePart | null;
  /** Extra advance after that space (the pill's side padding), in em. */
  readonly gapExtraEm: number;
}

export interface CaptionLineLayout {
  readonly direction: "ltr" | "rtl";
  /** Total advance in em, trailing letter spacing included (libass and CSS both add it after the last character). */
  readonly widthEm: number;
  /**
   * The middle of the box libass anchors a `\pos` event by, in em from the line's left edge (see the file
   * comment): the advance box's middle (`widthEm / 2`) unless a cluster's first glyph is offset.
   */
  readonly bboxCenterEm: number;
  /**
   * Each word's box in em from the line's left edge; `leftEm` is where it starts on screen. The ink
   * fields are the word's own highest and deepest ink among `inked` parts (0 for none).
   */
  readonly words: readonly {
    readonly leftEm: number;
    readonly widthEm: number;
    readonly inkTopEm: number;
    readonly inkBottomEm: number;
  }[];
  /** Highest ink above and deepest ink below the baseline among all `inked` parts, in em; 0 when none. */
  readonly inkTopEm: number;
  readonly inkBottomEm: number;
}

interface Segment {
  readonly owner: number | null;
  readonly part: CaptionLinePart;
  readonly extraEm: number;
}

interface VisualRun {
  readonly owner: number | null;
  readonly inkTopEm: number;
  readonly inkBottomEm: number;
  readonly level: number;
  readonly widthEm: number;
  /** libass bbox of the run in em from its start: first glyph of each cluster to that position plus the cluster's advance. */
  readonly bboxMinEm: number;
  readonly bboxMaxEm: number;
}

/**
 * Lays out one caption line. `direction` is the base direction: the first
 * strong character of the line (`textDirection`), which is what libass's
 * `Encoding -1` picks. Throws `CaptionShapingError` when a run cannot be shaped.
 */
export function layoutCaptionLine(
  words: readonly CaptionLineWord[],
  letterSpacingEm: number,
  direction: "ltr" | "rtl",
): CaptionLineLayout {
  const segments: Segment[] = [];
  words.forEach((word, index) => {
    if (index > 0 && word.gap) segments.push({ owner: null, part: word.gap, extraEm: word.gapExtraEm });
    for (const part of word.parts) segments.push({ owner: index, part, extraEm: 0 });
  });
  const text = segments.map((segment) => segment.part.text).join("");
  const levels = bidi.getEmbeddingLevels(text, direction).levels;

  const runs: VisualRun[] = [];
  let offset = 0;
  for (const segment of segments) {
    const { part } = segment;
    let start = 0;
    while (start < part.text.length) {
      const level = levels[offset + start]!;
      let end = start + 1;
      while (end < part.text.length && levels[offset + end] === level) end++;
      const piece = part.text.slice(start, end);
      const run = shapeCaptionRun(part.fontPath, piece, level % 2 === 1);
      // libass adds the letter spacing after every cluster; the pill's extra advance belongs to the space.
      const spacing = part.spaced ? letterSpacingEm : 0;
      const extra = segment.extraEm > 0 && start === 0 ? segment.extraEm : 0;
      const inked = part.inked && !run.notdef;
      let bboxMin = Number.POSITIVE_INFINITY;
      let bboxMax = Number.NEGATIVE_INFINITY;
      run.clusters.forEach((cluster, index) => {
        const root = cluster.startEm + index * spacing + cluster.offsetEm;
        bboxMin = Math.min(bboxMin, root);
        bboxMax = Math.max(bboxMax, root + cluster.advanceEm + spacing + (index === run.clusters.length - 1 ? extra : 0));
      });
      const widthEm = run.advanceEm + run.clusters.length * spacing + extra;
      runs.push({
        owner: segment.owner,
        level,
        inkTopEm: inked ? run.inkTopEm : 0,
        inkBottomEm: inked ? run.inkBottomEm : 0,
        widthEm,
        bboxMinEm: Number.isFinite(bboxMin) ? bboxMin : 0,
        bboxMaxEm: Number.isFinite(bboxMax) ? bboxMax : widthEm,
      });
      start = end;
    }
    offset += part.text.length;
  }

  // UAX #9 L2: from the highest level down to the lowest odd level, reverse every maximal sequence at that level or above.
  const order = runs.map((_, index) => index);
  const maxLevel = Math.max(0, ...runs.map((run) => run.level));
  const minOdd = Math.min(Number.POSITIVE_INFINITY, ...runs.map((run) => run.level).filter((level) => level % 2 === 1));
  for (let level = maxLevel; level >= minOdd; level--) {
    let index = 0;
    while (index < order.length) {
      if (runs[order[index]!]!.level < level) {
        index++;
        continue;
      }
      let last = index;
      while (last + 1 < order.length && runs[order[last + 1]!]!.level >= level) last++;
      const reversed = order.slice(index, last + 1).reverse();
      order.splice(index, reversed.length, ...reversed);
      index = last + 1;
    }
  }

  const boxes = words.map(() => ({ left: Number.POSITIVE_INFINITY, right: Number.NEGATIVE_INFINITY, inkTop: 0, inkBottom: 0 }));
  let cursor = 0;
  let bboxMin = Number.POSITIVE_INFINITY;
  let bboxMax = Number.NEGATIVE_INFINITY;
  for (const runIndex of order) {
    const run = runs[runIndex]!;
    bboxMin = Math.min(bboxMin, cursor + run.bboxMinEm);
    bboxMax = Math.max(bboxMax, cursor + run.bboxMaxEm);
    if (run.owner !== null) {
      const box = boxes[run.owner]!;
      box.left = Math.min(box.left, cursor);
      box.right = Math.max(box.right, cursor + run.widthEm);
      box.inkTop = Math.max(box.inkTop, run.inkTopEm);
      box.inkBottom = Math.max(box.inkBottom, run.inkBottomEm);
    }
    cursor += run.widthEm;
  }
  return {
    direction,
    widthEm: cursor,
    bboxCenterEm: Number.isFinite(bboxMin) ? (bboxMin + bboxMax) / 2 : cursor / 2,
    words: boxes.map((box) =>
      Number.isFinite(box.left)
        ? { leftEm: box.left, widthEm: box.right - box.left, inkTopEm: box.inkTop, inkBottomEm: box.inkBottom }
        : { leftEm: 0, widthEm: 0, inkTopEm: 0, inkBottomEm: 0 },
    ),
    inkTopEm: Math.max(0, ...boxes.map((box) => box.inkTop)),
    inkBottomEm: Math.max(0, ...boxes.map((box) => box.inkBottom)),
  };
}
