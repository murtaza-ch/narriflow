import type { DemoScript } from "../demo";
import { type Frames, EASES, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, fitScale, rowVisualOrder, sceneSpace } from "../layout";
import type { Clip, Piece, TextPiece } from "../scene";
import { rectPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Spine (`samples/templates/43-spine.js`): a Swiss poster. The hero runs up the left edge of the frame in red
 * capitals, reading bottom to top, rising out of a hard edge with a near-black print offset. Beside it a tidy
 * column of support words on white plates that wipe in as they are spoken. The column wipes away left to right at the cue's end
 * while the hero keeps rising out of the top.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`):
 * the plates start at y 1311 from the column's x (330 beside a hero, 96 without) to 996, Inter Tight Bold 58 px
 * (72 px without a hero, -0.02 em) padded 9 / 16 / 13 px, 8 px apart, packed into the fewest rows at the narrowest width that keeps
 * that count. The hero is Archivo Black at the size that makes it 660 px long (150 to 250 px, -0.01 em), its
 * bottom end at y 1560. Chrome sets the sideways capitals with their baseline 0.833 em and their cap tops
 * 0.145 em across a box whose left is `96 - 0.105 em`; the mask is that box, `size + 10` wide, from the hero's
 * top to 8 px under its bottom.
 *
 * The cue number and horizontal line are omitted at the owner's request.
 */

export const SPINE_DEMO: DemoScript = {
  lines: [
    "The:m best:b outfits:b are:m QUIET:h@560",
    "One:b colour.@380 One:b shape.",
    "Then:b break:b exactly:b one:m RULE:h@540",
    "Always:b EDIT:h@620",
  ],
  options: { lead: 300, tail: 700, cueGap: 160 },
};

const BASE = 1560;
const SPAN = 660;
const HERO_X = 96;
const COL_X = 330;
const SOLO_X = 96;
const RIGHT = 996;
const ANCHOR_Y = 1290;
const PLATE_TOP = 1311;
const PLATE_FS = 58;
const SOLO_FS = 72;
const OFF = 6;
const CAP_IN = 0.105;
/** Where Chrome puts the sideways capitals' baseline across the hero's line box (measured on EDIT at 250 px). */
const HERO_BASELINE_EM = 0.833;
const HERO_FACE = "Archivo Black" as const;
const HERO_LS = -0.01;
const HERO_SIZE = { min: 150, max: 250 } as const;
const PLATE_FACE = "Inter Tight Bold" as const;
const PLATE_LS = -0.02;
const PLATE_PAD = { top: 9, side: 16, bottom: 13 } as const;
const PLATE_GAP = 8;
/** Baseline of Inter Tight's `line-height: 1` box (50 of 58 px, 62 of 72 in the probe). */
const PLATE_BASELINE_EM = 0.862;
const OFFSET_COLOUR = "#141414";
const HERO_EXIT = 180;
const COL_EXIT = 120;
const RISE_MS = 520;
const WIPE_MS = 260;

/** The sample's balanced packing: the fewest rows, at the narrowest width (4 px steps) that still needs that many. */
export function spineRows(widths: readonly number[], limit: number, gap = PLATE_GAP): number[][] {
  const pack = (max: number) => {
    const out: number[][] = [[]];
    let used = 0;
    widths.forEach((width, at) => {
      const need = used ? used + gap + width : width;
      if (used && need > max) {
        out.push([at]);
        used = width;
      } else {
        out[out.length - 1]!.push(at);
        used = need;
      }
    });
    return out;
  };
  const fewest = pack(limit).length;
  let max = limit;
  while (max > 0 && pack(max - 4).length === fewest) max -= 4;
  return pack(max);
}

/** The hero's offset below its rest position, px: it rises out of the edge, then keeps going to leave out of the top. */
export function spineHeroOffset(t: number, wordStartMs: number, cueEndMs: number, travel: number): number {
  const rise = EASES.outExpo(prog(t, wordStartMs - 80, RISE_MS));
  const leave = EASES.in(prog(t, cueEndMs - 10 - HERO_EXIT, HERO_EXIT));
  return (1 - rise) * travel - leave * travel;
}

function buildCue(cue: SceneCue, cueNumber: number, input: SceneInput): Piece[] {
  const space = sceneSpace(input, ANCHOR_Y);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const hero = heroAt >= 0 ? cue.words[heroAt]! : null;
  const support = cue.words.map((_, at) => at).filter((at) => at !== heroAt);
  const colX = hero ? COL_X : SOLO_X;
  const band = cueNumber * 10;
  const fromMs = cue.startMs - 60;
  const colEnd = cue.endMs - 70;
  const exitFrom = colEnd - COL_EXIT;
  const pieces: Piece[] = [];

  // --- the column: it wipes away left to right as one piece (`inset(0 0 0 x)` from x - 12 to RIGHT + 12) ---
  const exitEdge = (t: number) => space.x(colX - 12 + EASES.in(prog(t, exitFrom, COL_EXIT)) * (RIGHT - colX + 24));
  const exitFrames = (from: number): Frames => [[from, space.x(colX - 12)], [exitFrom, space.x(colX - 12)], [colEnd, space.x(RIGHT + 12), "in"]];
  /** When the exit edge reaches canvas x `right`: a piece there is gone, so it ends then (a clip must never invert). */
  const exitPasses = (right: number) => {
    const share = (right - space.x(colX - 12)) / space.px(RIGHT - colX + 24);
    return share <= 0 ? exitFrom : Math.min(colEnd, exitFrom + Math.cbrt(Math.min(1, share)) * COL_EXIT);
  };
  /** A clip whose leading edge wipes in over `[start, start + dur]` (outExpo) and whose left edge carries the column's exit. */
  const wipeClip = (from: number, start: number, dur: number, left: number, right: number, top: number, bottom: number, fromRight = false): Clip => {
    const end = start + dur;
    const wiped = (t: number) => {
      const p = EASES.outExpo(prog(t, start, dur));
      return fromRight ? right - p * (right - left) : left + p * (right - left);
    };
    const overlaps = end > exitFrom;
    if (fromRight) {
      // The wipe and the exit both move the left edge: the later of the two holds it.
      const x1: Frames = overlaps
        ? sampleFrames((t) => Math.max(wiped(t), exitEdge(t)), [from, start, end, exitFrom, colEnd].filter((at) => at >= from).sort((a, b) => a - b), 0.25)
        : [[from, right], [start, right], [end, left, "outExpo"], [exitFrom, Math.max(left, space.x(colX - 12))], [colEnd, space.x(RIGHT + 12), "in"]];
      return { x1, x2: [[from, right]], y1: [[from, top]], y2: [[from, bottom]] };
    }
    // Left to right: the wipe moves the right edge, the exit the left one; they meet only when a word lands in the exit.
    // Sampled, the wipe could dip under the exact exit edge between keyframes: keep it a pixel clear.
    const x2: Frames = overlaps
      ? sampleFrames((t) => Math.max(wiped(t), exitEdge(t) + 1), [from, start, end, exitFrom, colEnd].filter((at) => at >= from).sort((a, b) => a - b), 0.25)
      : [[from, left], [start, left], [end, right, "outExpo"]];
    return { x1: exitFrames(from), x2, y1: [[from, top]], y2: [[from, bottom]] };
  };

  // --- the plates ---
  if (support.length > 0) {
    const limit = space.px(RIGHT - colX);
    const plateWidths = (size: number) =>
      support.map((at) => Math.round(input.measure(cue.words[at]!.text, PLATE_FACE, size, PLATE_LS).advance + PLATE_LS * size + 2 * PLATE_PAD.side * u));
    let size = (hero ? PLATE_FS : SOLO_FS) * u;
    let widths = plateWidths(size);
    // A plate wider than the column shrinks the cue's plates to fit.
    const shrink = fitScale(Math.max(...widths), limit);
    if (shrink < 1) {
      size *= shrink * 0.995;
      widths = plateWidths(size);
    }
    const f = size / ((hero ? PLATE_FS : SOLO_FS) * u);
    const pad = { top: PLATE_PAD.top * u * f, side: PLATE_PAD.side * u * f, bottom: PLATE_PAD.bottom * u * f };
    const height = pad.top + size + pad.bottom;
    const gap = space.px(PLATE_GAP);
    const rows = spineRows(widths, limit, gap);
    const top0 = space.y(PLATE_TOP);
    rows.forEach((row, ri) => {
      const ordered = rowVisualOrder(row.map((at) => cue.words[support[at]!]!.text), rtl ? "rtl" : "ltr").map((at) => row[at]!);
      const rowWidth = ordered.reduce((sum, at) => sum + widths[at]!, 0) + gap * (ordered.length - 1);
      let x = rtl ? space.x(RIGHT) - rowWidth : space.x(colX);
      const top = top0 + ri * (height + gap);
      for (const at of ordered) {
        const index = support[at]!;
        const word = cue.words[index]!;
        const width = widths[at]!;
        const start = word.startMs - 70;
        const clip = wipeClip(fromMs, start, WIPE_MS, x, x + width, top, top + height, rtl);
        const plateFrom = Math.max(fromMs, start + 4);
        const plateTo = exitPasses(x + width);
        pieces.push({
          id: `spine:${cueNumber}:p${index}`,
          kind: "shape",
          z: band + 3,
          fromMs: plateFrom,
          toMs: plateTo,
          track: { x: [[fromMs, x]], y: [[fromMs, top]] },
          clip,
          path: rectPath(0, 0, width, height),
          fill: { colour: input.colours.accent },
        });
        pieces.push({
          id: `spine:${cueNumber}:t${index}`,
          kind: "text",
          z: band + 4,
          fromMs: plateFrom,
          toMs: plateTo,
          track: { x: [[fromMs, x + pad.side]], y: [[fromMs, top + pad.top + PLATE_BASELINE_EM * size]] },
          clip,
          text: word.text,
          face: PLATE_FACE,
          sizePx: size,
          letterSpacingEm: PLATE_LS,
          fill: input.colours.primary,
          anchor: "baseline-left",
          language: cue.language,
        });
        x += width + gap;
      }
    });
  }

  // --- the hero: a sideways word rising out of the edge at y 1560, masked by its own footprint ---
  if (hero) {
    const text = hero.text.toUpperCase();
    // The sample sizes it so it runs 660 px (offsetWidth at 250 px is whole px), clamped 150 to 250 px.
    const at250 = Math.round(input.measure(text, HERO_FACE, 250 * u, HERO_LS).advance / u + HERO_LS * 250);
    let size = Math.min(HERO_SIZE.max, Math.max(HERO_SIZE.min, (250 * SPAN) / at250)) * u;
    const lengthOf = (s: number) => Math.round(input.measure(text, HERO_FACE, s, HERO_LS).advance + HERO_LS * s);
    // On a short canvas (16:9) or with a very long word, shrink it to the room above the edge.
    const room = space.y(BASE) - space.safe.y1;
    if (lengthOf(size) > room) size *= room / lengthOf(size);
    const length = lengthOf(size);
    const base = space.y(BASE);
    const maskLeft = space.x(HERO_X) - CAP_IN * size;
    const off = space.px(OFF);
    const travel = length + off + space.px(4);
    const wordFrom = hero.startMs - 80;
    const heroFrom = Math.max(fromMs, wordFrom + 4);
    const heroTo = cue.endMs - 10;
    const riseEnd = wordFrom + RISE_MS;
    const leaveFrom = heroTo - HERO_EXIT;
    const y: Frames = riseEnd <= leaveFrom
      ? [[wordFrom, base + travel], [riseEnd, base, "outExpo"], [leaveFrom, base], [heroTo, base - travel, "in"]]
      : sampleFrames((t) => base + spineHeroOffset(t, hero.startMs, cue.endMs, travel), [heroFrom, riseEnd, leaveFrom, heroTo].filter((t) => t >= heroFrom).sort((a, b) => a - b), 0.25);
    const clip: Clip = {
      x1: [[heroFrom, maskLeft]],
      x2: [[heroFrom, maskLeft + size + off + space.px(4)]],
      y1: [[heroFrom, base - length]],
      y2: [[heroFrom, base + off + space.px(2)]],
    };
    const copy = (part: string, z: number, colour: string, dx: number, dy: number): TextPiece => ({
      id: `spine:${cueNumber}:${part}`,
      kind: "text",
      z: band + z,
      fromMs: heroFrom,
      toMs: heroTo,
      track: { x: [[heroFrom, maskLeft + HERO_BASELINE_EM * size + dx]], y: y.map(([at, value, name]) => [at, value + dy, name] as const), rz: [[heroFrom, -90]] },
      clip,
      text,
      face: HERO_FACE,
      sizePx: size,
      letterSpacingEm: HERO_LS,
      fill: colour,
      anchor: "baseline-left",
      language: cue.language,
    });
    pieces.push(copy("offset", 1, OFFSET_COLOUR, off, off), copy("hero", 2, input.colours.highlight, 0, 0));
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const spineProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, input))) };
  },
};
