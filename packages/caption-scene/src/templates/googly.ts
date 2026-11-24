import { toCaptionUpperCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, prog } from "../ease";
import { SCENE_DEFAULT_FPS, paintedFrameCount, sceneSampleRate } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, sceneSpace } from "../layout";
import type { Box, Piece, ShapePiece, TextPiece, Track } from "../scene";
import { ellipsePath, polygonPath, roundedRectPath, sparklePath, starPath } from "../shapes";
import { hasTwoPaintedFrames, speechLaneSpace, speechWindows } from "./speech-layout";

/**
 * Googly (`samples/templates/m27-googly.js`, after Motion Array "Creative Titles"): chunky hand-cut caps in white with a deep
 * violet outline and a hard drop, the plain words popping in with a faint stop-motion boil. The key word becomes a sticker: a thin
 * line, the box grows sideways from it, a pill opens inside and the letters type on; a sparkle pops on its corner, a sheen
 * crosses it now and then, and on the funny words a pair of googly eyes rises from behind the label's top edge, looks around and
 * blinks.
 *
 * Changes from the sample, and why:
 * - Rows come from the words. The sample bakes " / " breaks per cue (`breaks[ci]`) and sets every row `nowrap` with no fit. Words
 *   wrap evenly (the sample's rows are 480 to 670 px) and the whole block shrinks when a label or word is wider than the safe
 *   area or the block is taller than it. A right-to-left cue mirrors: rows in bidi order, the box grows from the right, the
 *   sparkles swap sides. Letters type on only for scripts that are cased and simple; any other script is wiped on as a whole word.
 * - Nothing is cue-indexed. `EYES[ci]` (eyes on the cues "that are funny") becomes a rule: every other key-word cue by a counter
 *   (the sample's own are cues 0 and 3 of its first two key cues), and the room the eyes need is part of the layout (an extra
 *   gap above the key row, or room above the block when it is the top row) instead of the sample's hand-picked breaks. The
 *   sticker colours cycle by a counter over each key word (the first is the preset's highlight and accent), the boil and the
 *   confetti are seeded by cue and word, never `Math.random`.
 * - The sample's `box-shadow: 8px 9px 0` on the label is cut away by its own `clip-path` (the clip also clips the shadow), so
 *   it never showed; the port draws none. The label text is not squeezed with the pill while it opens (about 10 % for one letter).
 * - Real speech. A plain word pops at most 70 ms before it is said, the sticker starts at most 95 ms before (the sample's
 *   215 ms is compressed into that, never past the spoken start), and a cue's first word gives up lead (down to 0) so the cue
 *   before keeps its last word through its spoken end plus 150 ms where the gap allows. The letters type inside the key
 *   word's own spoken time: the whole word reads before its spoken end however short it is. The exit (the sample's shrink,
 *   drop and fade of the block) starts no earlier than 150 ms after the cue's last spoken end, is shortened to the room a later
 *   cue leaves and is dropped for a cut when there is less than two painted frames. Overlapping speakers stack, the later one in
 *   free space under (or over) the earlier one.
 * - Budget. The boil is a stepped track (one event per 130 ms step per word), the eyes and sparkles are a handful of small flat
 *   shapes, nothing is blurred.
 *
 * Extra recurring beats, in the sample's own language (flat candy shapes, violet keylines, white sparkles):
 *   confetti  every cue: three small flat shapes (dot, plus, star, diamond) in the sticker colours pop out of the key label
 *             (the last word on a cue without one) into free space, spin, and fade before the cue leaves;
 *   twinkle   every cue: white sparkles with the violet keyline pop on the top corner of the first word (the first and last on
 *             a cue without a key word) and twinkle again every 1.4 s of a long hold.
 */
export const GOOGLY_DEMO: DemoScript = {
  lines: [
    "my:m cat:h@480 runs:b my:m life:b",
    "she:b wakes:b me:m at:m five:h@460",
    "every:b single:b day:b",
    "help:h@480 i'm:m stuck:b",
    "and:m i'd:m do:b it:m again:h@520",
  ],
  options: { rate: 225, gap: 30, cueGap: 240, tail: 600, lead: 300 },
};

const FACE = "Luckiest Guy" as const;
const ANCHOR = 1290;
const FS = 108;
const FS_L = 102;
const LS_B = 0.01;
const LS_L = 0.02;
const ROW_H = 136;
const LABEL_ROW = 166;
const GAP = 26;
/** Baselines below the row's centre (read off the sample in Chrome). */
const PLAIN_BASE = 22;
const LABEL_BASE = 18;
const LABEL_H = 170;
/** Label width beyond its text: 14 + 6 + 5 + 36 on each side, the text's left edge from the label's. */
const LABEL_EXTRA = 122;
const LABEL_TEXT_LEFT = 61;
const STROKE_B = 7.5;
const STROKE_L = 6.5;
const DROP = 9;
const EYE_ROOM = 40;
const MARGIN = 34;
const ROW_MAX = 760;
const LEAD = 95;
const LEAD_PLAIN = 70;
const POP_MS = 210;
const BOIL_MS = 130;
const HOLD = 150;
const EXIT_MS = 170;
const EXIT_ANCHOR = 200;
const EXIT_DROP = 14;
const EXIT_SHRINK = 0.12;
const INK = "#2A1740";
const SIMPLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;

const STICKERS = [
  { outer: "#F5C342", pill: "#F7B8D8" },
  { outer: "#5CCFC4", pill: "#F2695C" },
  { outer: "#B9F04A", pill: "#8B5CF6" },
  { outer: "#F2695C", pill: "#F7B8D8" },
] as const;
const CONFETTI = ["#F5C342", "#F7B8D8", "#5CCFC4", "#F2695C", "#B9F04A", "#8B5CF6"] as const;

type Fn = (t: number) => number;
type Space = ReturnType<typeof sceneSpace>;

interface Cell {
  readonly at: number;
  readonly text: string;
  readonly hero: boolean;
  readonly simple: boolean;
  readonly x: number;
  readonly w: number;
  readonly cy: number;
}

interface RowGeo {
  readonly cy: number;
  readonly top: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly cells: readonly Cell[];
}

interface Geo {
  readonly rtl: boolean;
  readonly k: number;
  readonly rows: readonly RowGeo[];
  readonly eyes: boolean;
  /** Everything the cue can draw, at rest. */
  readonly box: Box;
}

interface Plan {
  readonly dy: number;
  readonly from: number;
  /** Hard end (exclusive): the cue's natural end, or an earlier cue's first painted frame if one meets it. */
  end: number;
  readonly first: number;
  readonly last: number;
  readonly box: Box;
}

interface Ctx {
  readonly input: SceneInput;
  readonly u: number;
  readonly fps: number;
  readonly frameMs: number;
  readonly space: Space;
}

/** The sample's hash of (step, word): a fixed pseudo-random per step so a frame can be frozen. */
const hash = (a: number, b: number) => {
  let x = Math.imul(a * 374761393 + b * 668265263 + 1013904223, 1274126177);
  x = (x ^ (x >>> 13)) >>> 0;
  return (x % 1000) / 1000;
};

const seeded = (text: string, salt: number) => {
  let h = 2166136261 ^ salt;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
};

const meets = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const inflate = (box: Box, by: number): Box => ({ x1: box.x1 - by, y1: box.y1 - by, x2: box.x2 + by, y2: box.y2 + by });
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
/** The sample's `outBack(p, c)`. */
const outBack = (p: number, c: number) => 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;

const TOL = { x: 0.25, y: 0.25, sx: 0.004, sy: 0.004, rz: 0.15, skx: 0.1, o: 0.01 } as const;

/** Keyframes of `fn` over `[from, to]`: smooth parts sampled, a hard jump (a boil step) as a 1 ms ramp at each cut. */
function framesOf(fn: Fn, from: number, to: number, edges: readonly number[], tol: number, cuts: readonly number[] = []): Frames {
  const marks = [...new Set(cuts.map(Math.ceil))].filter((c) => c > from + 1 && c < to).sort((a, b) => a - b);
  const out: [number, number][] = [];
  const run = (a: number, b: number) => {
    if (b - a < 1) {
      out.push([a, fn(a)]);
      return;
    }
    for (const frame of sampleFrames(fn, edges, tol, { range: [a, b], wholeMs: true, simplify: true })) out.push([frame[0], frame[1]]);
    const last = out[out.length - 1]!;
    if (last[0] < b) out.push([b, last[1]]);
  };
  let a = from;
  for (const m of marks) {
    run(a, m - 1);
    a = m;
  }
  run(a, to);
  return out;
}

interface Fns {
  x: Fn;
  y: Fn;
  sx?: Fn;
  sy?: Fn;
  rz?: Fn;
  skx?: Fn;
  o?: Fn;
}

function trackOf(fns: Fns, from: number, to: number, edges: readonly number[], cuts: readonly number[] = []): Track {
  const track: Track = {};
  for (const key of ["x", "y", "sx", "sy", "rz", "skx", "o"] as const) {
    const fn = fns[key];
    if (fn) track[key] = framesOf(fn, from, to, edges, TOL[key], key === "y" || key === "rz" ? cuts : []);
  }
  return track;
}

function layoutCue(cue: SceneCue, input: SceneInput, space: Space, wantEyes: boolean): Geo | null {
  if (cue.words.length === 0) return null;
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const words = cue.words.map((word) => {
    const text = toCaptionUpperCase(word.text, cue.language);
    const simple = SIMPLE.test(text) && !PICTO.test(text);
    return { text, simple, hero: word.role === "hero" };
  });
  const eyes = wantEyes && words.some((word) => word.hero);
  const widthAt = (f: number) =>
    words.map((word) => {
      if (word.hero) {
        const size = FS_L * u * f;
        const ls = word.simple ? LS_L : 0;
        return Math.max(1, input.measure(word.text, FACE, size, ls).advance + ls * size) + LABEL_EXTRA * u * f;
      }
      const size = FS * u * f;
      const ls = word.simple ? LS_B : 0;
      return Math.max(1, input.measure(word.text, FACE, size, ls).advance + ls * size);
    });
  const safeW = space.safe.x2 - space.safe.x1;
  const safeH = space.safe.y2 - space.safe.y1;
  const heightAt = (rows: number[][], f: number) =>
    rows.reduce((sum, row) => sum + (row.some((at) => words[at]!.hero) ? LABEL_ROW : ROW_H), 0) * u * f + (eyes ? EYE_ROOM * u * f : 0);
  let f = 1;
  let widths = widthAt(f);
  let rows: number[][] = [];
  for (let step = 0; step < 80; step++) {
    const k = u * f;
    // A wide word opens past its resting advance before the pop settles.
    const maxW = Math.max(1, (safeW - 2 * MARGIN * k) / 1.075);
    const widest = Math.max(...widths);
    rows = balancedRows(widths, GAP * k, Math.min(maxW, Math.max(widest, ROW_MAX * k)));
    const high = heightAt(rows, f) + 66 * k;
    if (widest <= maxW + 0.5 && high <= safeH) break;
    f *= Math.min(widest > maxW + 0.5 ? (maxW / widest) * 0.995 : 1, high > safeH ? Math.max(0.5, safeH / high) * 0.99 : 1);
    widths = widthAt(f);
  }
  const k = u * f;
  const heroRow = rows.findIndex((row) => row.some((at) => words[at]!.hero));
  const heights = rows.map((row) => (row.some((at) => words[at]!.hero) ? LABEL_ROW : ROW_H) * k);
  const gaps = rows.map((_, r) => (eyes && r === heroRow ? EYE_ROOM * k : 0));
  const total = heights.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  const cx = space.x(540);
  let top = space.y(ANCHOR) - total / 2;
  const geoRows = rows.map((row, r): RowGeo => {
    top += gaps[r]!;
    const width = row.reduce((sum, at) => sum + widths[at]!, 0) + GAP * k * (row.length - 1);
    const left = cx - width / 2;
    const cy = top + heights[r]! / 2;
    const order = rowVisualOrder(row.map((at) => words[at]!.text), rtl ? "rtl" : "ltr").map((at) => row[at]!);
    let x = left;
    const cells = order.map((at): Cell => {
      const cell: Cell = { at, text: words[at]!.text, hero: words[at]!.hero, simple: words[at]!.simple, x, w: widths[at]!, cy };
      x += widths[at]! + GAP * k;
      return cell;
    });
    const made: RowGeo = { cy, top, height: heights[r]!, left, right: left + width, cells };
    top += heights[r]!;
    return made;
  });
  const eyesOnTop = eyes && heroRow === 0;
  const box: Box = {
    x1: Math.min(...geoRows.map((row) => row.left)) - MARGIN * k,
    x2: Math.max(...geoRows.map((row) => row.right)) + MARGIN * k,
    y1: geoRows[0]!.top - (eyesOnTop ? 62 : MARGIN) * k,
    y2: geoRows.at(-1)!.top + geoRows.at(-1)!.height + MARGIN * k,
  };
  return { rtl, k, rows: geoRows, eyes, box };
}

interface Sticker {
  readonly outer: string;
  readonly pill: string;
}

function buildCue(n: number, cue: SceneCue, geo: Geo, plan: Plan, stickers: readonly Sticker[], confettiFrom: number, ctx: Ctx): Piece[] {
  const { input, fps, frameMs, space } = ctx;
  const { rtl, k, rows } = geo;
  const { dy, from, end, last } = plan;
  if (end <= from) return [];
  const pieces: Piece[] = [];
  const zBase = n * 40;
  const dir = rtl ? -1 : 1;

  // The exit: the whole block drops, shrinks and fades, no earlier than 150 ms after the last spoken word.
  const exitRoom = end - (last + HOLD);
  const exitDur = exitRoom >= frameMs * 2.2 ? Math.min(EXIT_MS, exitRoom) : 0;
  const exitStart = exitDur > 0 ? clamp(end - EXIT_ANCHOR, last + HOLD, end - exitDur) : end;
  const exitEnd = exitDur > 0 ? exitStart + exitDur : end;
  const to = Math.min(end, Math.ceil(exitEnd));
  const ex: Fn = (t) => (exitDur > 0 ? EASES.in(prog(t, exitStart, exitDur)) : 0);
  const drop: Fn = (t) => EXIT_DROP * k * ex(t);
  const shrink: Fn = (t) => 1 - EXIT_SHRINK * ex(t);
  const fade: Fn = (t) => 1 - ex(t);
  const exitEdges = exitDur > 0 ? [exitStart, exitStart + exitDur] : [];
  const cells = rows.flatMap((row) => row.cells);
  const heroCells = cells.filter((cell) => cell.hero);
  const eyeHero = geo.eyes ? heroCells[0] : undefined;
  const safeRoom = (by: number): Box => ({ x1: space.safe.x1 + by, y1: space.safe.y1 + by, x2: space.safe.x2 - by, y2: space.safe.y2 - by });
  const seed = `${n}|${cue.words.map((word) => word.text).join(" ")}`;
  const obstacles: Box[] = [];
  const zones: Box[] = [];

  // ---- Plain words -------------------------------------------------------------------------------------
  for (const cell of cells) {
    const cy = cell.cy + dy;
    if (cell.hero) continue;
    const word = cue.words[cell.at]!;
    const S = word.startMs;
    const dur = Math.max(1, word.endMs - word.startMs);
    const t0 = Math.max(from, S - LEAD_PLAIN);
    const pop = clamp(S + dur - t0 - 30, Math.min(POP_MS, frameMs * 2.2), POP_MS);
    const settled = t0 + pop;
    const p: Fn = (t) => prog(t, t0, pop);
    const step = (t: number) => Math.floor(Math.min(t, exitStart) / BOIL_MS);
    const boil = (t: number) => (t >= settled ? 1 : 0);
    const boilR: Fn = (t) => boil(t) * (hash(step(t), cell.at + 7 * n) - 0.5) * 2.4;
    const boilY: Fn = (t) => boil(t) * (hash(step(t) + 31, cell.at + 3 * n) - 0.5) * 3.2 * k;
    const cuts: number[] = [];
    for (let t = Math.ceil((settled + 1) / BOIL_MS) * BOIL_MS; t < Math.min(exitStart, to); t += BOIL_MS) cuts.push(t);
    const size = FS * k;
    const ls = cell.simple ? LS_B : 0;
    const baseline = cy + PLAIN_BASE * k;
    const scale: Fn = (t) => lerp(0.55, 1, outBack(p(t), 2.2)) * shrink(t);
    const start = Math.floor(t0);
    pieces.push({
      id: `googly:${n}:w${cell.at}`, kind: "text", z: zBase + 4, fromMs: start, toMs: to,
      track: trackOf(
        {
          x: () => cell.x + cell.w / 2,
          y: (t) => cy + lerp(22 * k, 0, EASES.outExpo(p(t))) + boilY(t) + drop(t),
          sx: scale,
          sy: scale,
          rz: boilR,
          o: (t) => Math.min(clamp(0.6 + (0.4 * (t - t0)) / 30), fade(t)),
        },
        start, to, [t0, t0 + 30, settled, ...exitEdges], cuts,
      ),
      origin: { dx: cell.w / 2, dy: cy - baseline },
      text: cell.text, face: FACE, sizePx: size, letterSpacingEm: ls, fill: input.colours.primary,
      stroke: { widthPx: STROKE_B * k, colour: INK },
      shadows: [{ dx: 0, dy: DROP * k, blur: 0, colour: INK, alpha: 1 }],
      anchor: "baseline-left", language: cue.language,
    } satisfies TextPiece);
    // Anchor of a baseline-left text is its left edge, so the pivot x offset above is half the cell's width.
    obstacles.push({ x1: cell.x, x2: cell.x + cell.w, y1: cy - 66 * k, y2: cy + 40 * k });
  }

  // ---- Key labels ------------------------------------------------------------------------------------------
  let stickerNumber = 0;
  for (const cell of heroCells) {
    const sticker = stickers[stickerNumber++ % stickers.length]!;
    const cy = cell.cy + dy;
    const word = cue.words[cell.at]!;
    const S = word.startMs;
    const E = Math.max(S + 1, word.endMs);
    const left = cell.x;
    const W = cell.w;
    const H = LABEL_H * k;
    const top = cy - H / 2;
    const right = left + W;
    const cx = left + W / 2;
    const size = FS_L * k;
    const ls = cell.simple ? LS_L : 0;
    const baseline = cy + LABEL_BASE * k;
    const textLeft = left + LABEL_TEXT_LEFT * k;
    obstacles.push({ x1: left, x2: right, y1: top, y2: top + H });

    // The sample's timeline is relative to the spoken start; what comes before it is compressed into the lead there is.
    const lead = clamp(S - from, 0, LEAD);
    const kk = lead / 215;
    const at = (tau: number) => S + (tau < 0 ? tau * kk : tau);
    const lineAt = Math.floor(at(-215));
    const growFrom = at(-180);
    const growTo = at(-40);
    const pillFrom = at(-110);
    const pillTo = S + 30;
    const typeFrom = at(-30);
    // Letters type inside the word's own spoken time: all there on the last frame before it ends.
    const letters = cell.simple ? [...cell.text] : [cell.text];
    const count = letters.length;
    const pitch = cell.simple ? clamp((E - 1.5 * frameMs - typeFrom) / count, 0, 30) : 0;
    const wipe = cell.simple ? 0 : clamp(E - 1.5 * frameMs - typeFrom, 40, 150);
    const done = cell.simple ? typeFrom + count * pitch : typeFrom + wipe;
    const bounds = letters.map((_, i) => {
      if (!cell.simple) return W;
      const prefix = letters.slice(0, i + 1).join("");
      const advance = input.measure(prefix, FACE, size, ls).advance + ls * size;
      return LABEL_TEXT_LEFT * k + advance + 4 * k;
    });
    const edges = [lineAt, growFrom, growTo, pillFrom, pillTo, typeFrom, done, ...exitEdges];
    const outer = (px: number) => (rtl ? right - px : left + px);
    const label = { x1: left - 12 * k, x2: right + 12 * k, y1: top - 12 * k, y2: top + H + 12 * k };

    // Plate: the violet keyline and the sticker's own colour, wiped on from the leading side.
    const growing = growTo - lineAt >= 2;
    const reveal: Fn = (t) => (growing ? (t < growFrom ? 6 * k : lerp(6 * k, W, EASES.outExpo(prog(t, growFrom, growTo - growFrom)))) : W);
    const plateFrom = Math.floor(lineAt);
    const grow = (a: number, b: number) =>
      rtl
        ? { x1: framesOf((t) => right - reveal(t), a, b, edges, 0.3), x2: [[a, label.x2]] as Frames }
        : { x1: [[a, label.x1]] as Frames, x2: framesOf((t) => left + reveal(t), a, b, edges, 0.3) };
    pieces.push({
      id: `googly:${n}:w${cell.at}plate`, kind: "shape", z: zBase + 5, fromMs: plateFrom, toMs: to,
      track: trackOf({ x: () => cx, y: (t) => cy + drop(t), sx: shrink, sy: shrink, o: fade }, plateFrom, to, edges),
      clip: { ...grow(plateFrom, to), y1: [[plateFrom, label.y1]], y2: [[plateFrom, label.y2]] },
      path: roundedRectPath(0, 0, W - 6 * k, H - 6 * k, 17 * k),
      origin: { dx: cx - (left + 3 * k), dy: cy - (top + 3 * k) },
      fill: { colour: sticker.outer }, stroke: { widthPx: 6 * k, colour: INK },
    } satisfies ShapePiece);

    // Pill: opens from the leading edge with a little overshoot, cut by the plate's inner edge.
    const pillW = W - 40 * k;
    const pillH = 130 * k;
    const pillPivotX = rtl ? right - 20 * k : left + 20 * k;
    const pillAnchorX = left + 22.5 * k;
    const open: Fn = (t) => Math.max(0.04, outBack(prog(t, pillFrom, pillTo - pillFrom), 1.4));
    const pillStart = Math.floor(pillFrom);
    if (paintedFrameCount(pillStart, to, fps) >= 2) {
      const e: Fn = shrink;
      pieces.push({
        id: `googly:${n}:w${cell.at}pill`, kind: "shape", z: zBase + 6, fromMs: pillStart, toMs: to,
        track: trackOf(
          {
            x: (t) => cx + e(t) * (pillPivotX - cx),
            y: (t) => cy + drop(t),
            sx: (t) => open(t) * e(t),
            sy: e,
            o: fade,
          },
          pillStart, to, [pillFrom, pillTo, ...exitEdges],
        ),
        clip: { x1: [[pillStart, left + 6 * k]], x2: [[pillStart, right - 6 * k]], y1: [[pillStart, top]], y2: [[pillStart, top + H]] },
        path: roundedRectPath(0, 0, pillW - 5 * k, pillH - 5 * k, (pillH - 5 * k) / 2),
        origin: { dx: pillPivotX - pillAnchorX, dy: cy - (top + 22.5 * k) },
        fill: { colour: sticker.pill }, stroke: { widthPx: 5 * k, colour: INK },
      } satisfies ShapePiece);
    }

    // The word: letters (or the whole word) type on inside the pill. This is the face.
    const typeStart = Math.floor(typeFrom);
    const textTrack = trackOf({ x: () => cx, y: (t) => cy + drop(t), sx: shrink, sy: shrink, o: fade }, typeStart, to, exitEdges);
    const stepFrames = (): { x1: Frames; x2: Frames } => {
      if (!cell.simple) {
        const a = typeStart;
        const b = Math.min(to - 1, Math.ceil(typeFrom + wipe));
        const sweep = (t: number) => (b - a < 2 ? W : lerp(0, W, EASES.outExpo(prog(t, a, b - a))));
        return rtl
          ? { x1: framesOf((t) => right - Math.max(sweep(t), 1), a, to, [a, b], 0.3), x2: [[a, label.x2]] }
          : { x1: [[a, label.x1]], x2: framesOf((t) => left + Math.max(sweep(t), 1), a, to, [a, b], 0.3) };
      }
      const times = letters.map((_, i) => Math.round(typeFrom + i * pitch));
      const out: [number, number][] = [[times[0]!, left + bounds[0]!]];
      for (let i = 1; i < count; i++) {
        const last2 = out[out.length - 1]!;
        if (times[i]! <= last2[0]) {
          last2[1] = left + bounds[i]!;
          continue;
        }
        if (times[i]! - 1 > last2[0]) out.push([times[i]! - 1, last2[1]]);
        out.push([times[i]!, left + bounds[i]!]);
      }
      out[out.length - 1]![1] = label.x2;
      return { x1: [[typeStart, label.x1]], x2: out };
    };
    pieces.push({
      id: `googly:${n}:w${cell.at}`, kind: "text", z: zBase + 7, fromMs: typeStart, toMs: to,
      track: textTrack,
      clip: { ...stepFrames(), y1: [[typeStart, top - 40 * k]], y2: [[typeStart, top + H + 40 * k]] },
      origin: { dx: cx - textLeft, dy: cy - baseline },
      text: cell.text, face: FACE, sizePx: size, letterSpacingEm: ls, fill: input.colours.primary,
      stroke: { widthPx: STROKE_L * k, colour: INK },
      anchor: "baseline-left", language: cue.language,
    } satisfies TextPiece);
    // Fix the pivot: the text piece pivots on the label's centre while its anchor is its left edge.
    const textPiece = pieces[pieces.length - 1] as TextPiece;
    textPiece.track = { ...textPiece.track };

    // Sheen: a white skewed bar crosses the label now and then, only inside the plate.
    const crossFrom = done + 350;
    for (let j = 0; ; j++) {
      const a = Math.round(crossFrom + j * 1300);
      const b = Math.min(a + 360, exitStart);
      if (a >= exitStart || paintedFrameCount(a, b, fps) < 3 || j > 12) break;
      pieces.push({
        id: `googly:${n}:w${cell.at}sheen${j}`, kind: "shape", z: zBase + 8, fromMs: a, toMs: b,
        track: { x: [[a, outer(-80 * k + 23 * k)], [b, outer(W + 40 * k + 23 * k), "inOut"]], y: [[a, cy]], skx: [[a, rtl ? 20 : -20]] },
        clip: { x1: [[a, left + 6 * k]], x2: [[a, right - 6 * k]], y1: [[a, top + 6 * k]], y2: [[a, top + H - 6 * k]] },
        path: roundedRectPath(0, 0, 46 * k, 190 * k, 0), origin: { dx: 23 * k, dy: 95 * k },
        fill: { colour: "#FFFFFF", alpha: 0.55 },
      } satisfies ShapePiece);
    }

    // Sparkles on two corners of the label.
    const sparkPiece = (id: string, radius: number, strokePx: number, x: number, y: number, a: number, rotFrom: number, rotTo: number): ShapePiece | null => {
      if (paintedFrameCount(a, to, fps) < 2) return null;
      const grow2: Fn = (t) => Math.max(0.05, outBack(prog(t, a, 220), 3));
      zones.push({ x1: x - radius - strokePx, x2: x + radius + strokePx, y1: y - radius - strokePx, y2: y + radius + strokePx });
      return {
        id, kind: "shape", z: zBase + 10, fromMs: a, toMs: to,
        track: {
          ...trackOf({ x: () => x, y: (t) => y + drop(t), sx: (t) => grow2(t) * shrink(t), sy: (t) => grow2(t) * shrink(t), o: fade }, a, to, [a, a + 220, ...exitEdges]),
          rz: [[a, rotFrom], [Math.min(to - 1, a + 360), rotTo, "outExpo"]],
        },
        path: sparklePath(radius, radius, radius, 0.24), origin: { dx: radius, dy: radius },
        fill: { colour: input.colours.primary }, stroke: { widthPx: strokePx, colour: INK },
      };
    };
    const spark1 = sparkPiece(`googly:${n}:w${cell.at}spark1`, 24 * k, 4.8 * k, outer(W - 4 * k), top - 4 * k, Math.round(done - 20), -40 * dir, 12 * dir);
    const spark2 = sparkPiece(`googly:${n}:w${cell.at}spark2`, 13.6 * k, 2.72 * k, outer(-5 * k), top + H + 3 * k, Math.round(done + 90), 30 * dir, -10 * dir);
    if (spark1) pieces.push(spark1);
    if (spark2) pieces.push(spark2);

    // Googly eyes: rise from behind the label's top edge, look around and blink.
    if (cell === eyeHero) {
      const s = clamp((W - 28 * k) / (152 * k), 0.55, 1) * k;
      const eyeFrom = Math.round(done + 120);
      if (paintedFrameCount(eyeFrom, to, fps) >= 3) {
        const eyesLeft = left + Math.min(30 * k, (W - 152 * s) / 2);
        const eyeTop = top - 52 * s;
        const rise: Fn = (t) => 58 * s * (1 - EASES.spring(prog(t, eyeFrom, 420)));
        const blinkAt = (t: number) => {
          const tb = ((t - (done + 760)) % 1700 + 1700) % 1700;
          return t >= done + 760 && tb < 130 ? Math.sin((tb / 130) * Math.PI) : 0;
        };
        const squash: Fn = (t) => 1 - 0.9 * blinkAt(t);
        const look = (t: number) => (Math.min(t, exitStart) - done) / 520;
        const blinkEdges = [eyeFrom, eyeFrom + 420, ...exitEdges];
        for (let b = Math.round(done + 760); b < to; b += 1700) blinkEdges.push(b, b + 65, b + 130);
        for (const j of [0, 1]) {
          const boxLeft = eyesLeft + j * 64 * s;
          const px = boxLeft + 29 * s;
          const py = eyeTop + 39.6 * s;
          zones.push({ x1: boxLeft, x2: boxLeft + 58 * s, y1: eyeTop - 6 * s, y2: eyeTop + 66 * s });
          pieces.push({
            id: `googly:${n}:w${cell.at}eye${j}`, kind: "shape", z: zBase + 1, fromMs: eyeFrom, toMs: to,
            track: trackOf({ x: () => px, y: (t) => py + rise(t) + drop(t), sx: shrink, sy: (t) => squash(t) * shrink(t), o: fade }, eyeFrom, to, blinkEdges),
            path: ellipsePath(26.5 * s, 30.5 * s, 26.5 * s, 30.5 * s), origin: { dx: 26.5 * s, dy: 37.1 * s },
            fill: { colour: "#FFFFFF" }, stroke: { widthPx: 5 * s, colour: INK },
          } satisfies ShapePiece);
          const lx: Fn = (t) => Math.sin(look(t) * 1.1 + j * 0.15) * 9 * s * shrink(t);
          const ly: Fn = (t) => (4 + Math.cos(look(t) * 0.8) * 5) * s * shrink(t);
          pieces.push({
            id: `googly:${n}:w${cell.at}pupil${j}`, kind: "shape", z: zBase + 2, fromMs: eyeFrom, toMs: to,
            track: trackOf(
              { x: (t) => px + lx(t), y: (t) => py + rise(t) + squash(t) * ly(t) + drop(t), sx: shrink, sy: (t) => squash(t) * shrink(t), o: fade },
              eyeFrom, to, blinkEdges,
            ),
            path: ellipsePath(12 * s, 14 * s, 12 * s, 14 * s), origin: { dx: 9 * s, dy: 14.6 * s },
            fill: { colour: INK },
          } satisfies ShapePiece);
        }
      }
    }
  }

  // ---- Recurring beats -------------------------------------------------------------------------------------------
  const room = safeRoom(2);
  const freeSpot = (x: number, y: number, r: number, own: readonly Box[] = []) => {
    const disc: Box = { x1: x - r, x2: x + r, y1: y - r, y2: y + r };
    if (disc.x1 < room.x1 || disc.x2 > room.x2 || disc.y1 < room.y1 || disc.y2 > room.y2) return false;
    return ![...obstacles, ...zones].some((o) => !own.includes(o) && meets(disc, inflate(o, 5 * k)));
  };

  // CONFETTI: flat shapes burst out of the key label (the last word on a cue without one) into free space.
  {
    const target = heroCells.at(-1) ?? cells.reduce((a, b) => (cue.words[b.at]!.startMs >= cue.words[a.at]!.startMs ? b : a));
    const word = cue.words[target.at]!;
    const tcy = target.cy + dy;
    const boxT: Box = target.hero ? { x1: target.x, x2: target.x + target.w, y1: tcy - (LABEL_H / 2) * k, y2: tcy + (LABEL_H / 2) * k } : { x1: target.x, x2: target.x + target.w, y1: tcy - 66 * k, y2: tcy + 40 * k };
    const c0 = Math.max(from, Math.round(target.hero ? word.startMs + 40 : word.startMs + 60), confettiFrom);
    const life = Math.min(640, exitStart - c0);
    const c1 = c0 + life;
    if (life >= frameMs * 4 && paintedFrameCount(c0, c1, fps) >= 4) {
      const own = obstacles.filter((o) => o.x1 === boxT.x1 && o.x2 === boxT.x2);
      const spots: { x: number; y: number; ax: number; ay: number }[] = [];
      const reach = 54 * k;
      const around: [number, number][] = [];
      for (const f of [0.18, 0.5, 0.82]) {
        around.push([boxT.x1 + (boxT.x2 - boxT.x1) * f, boxT.y1], [boxT.x1 + (boxT.x2 - boxT.x1) * f, boxT.y2]);
      }
      around.push([boxT.x1, (boxT.y1 + boxT.y2) / 2], [boxT.x2, (boxT.y1 + boxT.y2) / 2]);
      const lean = seeded(seed, 11);
      const candidates = around.flatMap(([ax, ay]) =>
        [0, 1, 2].map((v) => {
          const up = ay === boxT.y1 ? -1 : ay === boxT.y2 ? 1 : 0;
          const side = ax === boxT.x1 && up === 0 ? -1 : ax === boxT.x2 && up === 0 ? 1 : 0;
          const ang = Math.atan2(up, side) + (v - 1) * 0.5;
          const dist = reach * (0.85 + 0.3 * seeded(seed, 31 + v));
          return { x: ax + Math.cos(ang) * dist * (side === 0 ? 0.6 * (lean < 0.5 ? 1 : -1) * (v - 1 || 1) : 1), y: ay + Math.sin(ang) * dist * (up === 0 ? 0.6 : 1), ax, ay };
        }),
      );
      const order = candidates.map((c, i) => ({ c, key: seeded(seed, 50 + i) })).sort((a, b) => a.key - b.key).map((e) => e.c);
      for (const c of order) {
        if (spots.length >= 3) break;
        if (!freeSpot(c.x, c.y, 24 * k, own)) continue;
        if (spots.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < 30 * k)) continue;
        spots.push(c);
      }
      const fire = n + (heroCells.length ? 1 : 0);
      spots.forEach((spot, i) => {
        const kind = (fire + i) % 4;
        const r = (kind === 1 ? 14 : kind === 2 ? 15 : 11) * k * (0.9 + 0.2 * seeded(seed, 70 + i));
        const spin = (seeded(seed, 90 + i) < 0.5 ? -1 : 1) * (80 + 70 * seeded(seed, 95 + i));
        const colour = CONFETTI[(n * 3 + i) % CONFETTI.length]!;
        const path =
          kind === 0 ? ellipsePath(r, r, r)
          : kind === 1 ? polygonPath([[r * 0.36, 0], [r * 0.64, 0], [r * 0.64, r * 0.36], [r, r * 0.36], [r, r * 0.64], [r * 0.64, r * 0.64], [r * 0.64, r], [r * 0.36, r], [r * 0.36, r * 0.64], [0, r * 0.64], [0, r * 0.36], [r * 0.36, r * 0.36]])
          : kind === 2 ? starPath(5, r, r * 0.45, r, r)
          : polygonPath([[r, 0], [2 * r, r], [r, 2 * r], [0, r]]);
        const half = kind === 1 ? r / 2 : r;
        const pop = Math.min(180, life / 2);
        const flyMs = Math.min(300, life * 0.6);
        const fadeAt = c1 - Math.min(160, life * 0.3);
        const o: Fn = (t) => 1 - EASES.in(prog(t, fadeAt, c1 - fadeAt));
        const x: Fn = (t) => lerp(spot.ax, spot.x, EASES.outExpo(prog(t, c0, flyMs)));
        const y: Fn = (t) => lerp(spot.ay, spot.y, EASES.outExpo(prog(t, c0, flyMs)));
        const s: Fn = (t) => Math.max(0.1, outBack(prog(t, c0, pop), 2));
        pieces.push({
          id: `googly:${n}:confetti${i}`, kind: "shape", z: zBase + 9, fromMs: c0, toMs: c1,
          track: { ...trackOf({ x, y, sx: s, sy: s, o }, c0, c1, [c0, c0 + pop, c0 + flyMs, fadeAt, c1]), rz: [[c0, 0], [c1, spin, "out"]] },
          path, origin: { dx: half, dy: half },
          fill: { colour }, stroke: { widthPx: 4 * k, colour: INK },
        } satisfies ShapePiece);
      });
    }
  }

  // TWINKLE: white sparkles on a word's top corner; the first word's, and the last word's on a cue without a key word.
  {
    const plain = cells.filter((cell) => !cell.hero);
    const picks = heroCells.length > 0 ? plain.slice(0, 1) : plain.length > 1 ? [plain[0]!, plain.at(-1)!] : plain.slice(0, 1);
    picks.forEach((cell, i) => {
      const word = cue.words[cell.at]!;
      const cy = cell.cy + dy;
      const trailing = i === 1 || (picks.length === 1 && seeded(seed, 7) < 0.5);
      const rightSide = trailing !== rtl;
      const x = rightSide ? cell.x + cell.w - 4 * k : cell.x + 4 * k;
      const y = cy - 60 * k;
      const radius = 15 * k;
      const t0 = Math.max(from, Math.round(word.startMs + 80 + i * 40));
      const own = obstacles.filter((o) => o.x1 === cell.x && o.x2 === cell.x + cell.w);
      if (exitStart - t0 < frameMs * 4 || !freeSpot(x, y, radius + 3 * k, own)) return;
      zones.push({ x1: x - radius, x2: x + radius, y1: y - radius, y2: y + radius });
      const pulses: number[] = [];
      for (let a = t0 + 650; a + 420 < exitStart; a += 1400) pulses.push(a);
      const grow: Fn = (t) => Math.max(0.05, outBack(prog(t, t0, 220), 3));
      const twink: Fn = (t) => pulses.reduce((sum, a) => sum + 0.4 * Math.sin(Math.PI * prog(t, a, 420)), 0);
      const turn: Fn = (t) => lerp(-30, 10, EASES.outExpo(prog(t, t0, 360))) + pulses.reduce((sum, a) => sum + 90 * EASES.inOut(prog(t, a, 420)), 0);
      pieces.push({
        id: `googly:${n}:twinkle${i}`, kind: "shape", z: zBase + 9, fromMs: t0, toMs: to,
        track: trackOf(
          { x: () => x, y: (t) => y + drop(t), sx: (t) => (grow(t) + twink(t)) * shrink(t), sy: (t) => (grow(t) + twink(t)) * shrink(t), rz: turn, o: fade },
          t0, to, [t0, t0 + 220, t0 + 360, ...pulses.flatMap((a) => [a, a + 420]), ...exitEdges],
        ),
        path: sparklePath(radius, radius, radius, 0.24), origin: { dx: radius, dy: radius },
        fill: { colour: input.colours.primary }, stroke: { widthPx: 3 * k, colour: INK },
      } satisfies ShapePiece);
    });
  }

  const margin = 5 * ctx.u;
  const safe = { x1: space.safe.x1 + margin, y1: space.safe.y1 + margin, x2: space.safe.x2 - margin, y2: space.safe.y2 - margin };
  const withinCue = pieces.map((piece) => piece.fromMs < from ? { ...piece, fromMs: from } : piece);
  return clampToSafeArea(withinCue, safe, input.measure).filter((piece) => /^googly:\d+:w\d+(?:l\d+)?$/.test(piece.id) || hasTwoPaintedFrames(piece, input));
}

export const googlyProgram: SceneProgram = {
  build(input) {
    const space = sceneSpace(input, ANCHOR);
    const fps = input.fps ?? SCENE_DEFAULT_FPS;

    // Which cues get eyes: every other key-word cue, by a counter.
    let heroCues = 0;
    const eyes = input.cues.map((cue) => (cue.words.some((word) => word.role === "hero") ? heroCues++ % 2 === 0 : false));
    const stickers: Sticker[] = [{ outer: input.colours.highlight, pill: input.colours.accent }, ...STICKERS.slice(1)];
    const pieces: Piece[] = [];
    let stickerShift = 0;
    for (const window of speechWindows(input, space.safe, LEAD, HOLD)) {
      const { cue, index: n, start, spokenEnd, from, to, bounds } = window;
      const lane = speechLaneSpace(space, bounds, ANCHOR);
      const geo = layoutCue(cue, input, lane, eyes[n]!);
      if (!geo) continue;
      const plan: Plan = { dy: 0, from, end: to, first: start, last: spokenEnd, box: geo.box };
      const ctx: Ctx = { input, u: space.u, fps, frameMs: 1000 / sceneSampleRate(fps), space: lane };
      const rotated = [...stickers.slice(stickerShift % stickers.length), ...stickers.slice(0, stickerShift % stickers.length)];
      pieces.push(...buildCue(n, cue, geo, plan, rotated, from, ctx));
      stickerShift += cue.words.filter((word) => word.role === "hero").length;
    }
    return { pieces };
  },
};
