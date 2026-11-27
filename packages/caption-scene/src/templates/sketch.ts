import { captionTextClusters } from "@narriflow/caption-fonts/caption-block";
import { CAPTION_SCENE_BRAND_MIN_CONTRAST, captionColourContrast } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { clamp, EASES, type Frames, prog } from "../ease";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneWord } from "../input";
import { balancedRows, rowVisualOrder } from "../layout";
import type { PathCmd, Piece, TextPiece } from "../scene";
import { pathBounds } from "../shapes";
import { galleryScene, rotatePoint } from "./gallery-layout";

/**
 * Sketch (`samples/templates/m80-sketch.js`, after Motion Array "Lyrics Text Animated"): handwritten cream lyric
 * captions on a slightly uphill staircase. Every word is first a rough pencil loop that grows in the word's slot just
 * before it is spoken and crossfades into the written word on the beat; the key word's wider gold loop contracts onto a
 * larger gold word. When the timing leaves room, a cue leaves by fading its words in a short stagger while each slot
 * flashes back to a small loop that shrinks away.
 *
 * Changes from the sample, and why:
 * - **Rows come from the words.** The sample split a cue at its key word (words before it, then the key word and the
 *   rest; a cue without one in two halves). That split stays, and any line wider than the column wraps into more lines
 *   (balanced), each stepping in further, the step shrinking when the staircase would not fit. Row pitch comes from the
 *   measured ink of each line (so a Devanagari matra or a Caveat descender never touches the next line), not the
 *   sample's fixed pitch. A word wider than the column shrinks to a floor (120 px key word, 96 px other words), then
 *   breaks into the fewest rows any split at the floor fits (measured cluster widths), balanced (least squared row
 *   widths); closing punctuation stays on the row before it and opening punctuation on the row after it. Latin,
 *   Cyrillic, Greek and CJK only; a joined script is never split and shrinks instead. When the caption band cannot
 *   hold the cue at its floor (a long CJK sentence, a tall cue at 2x) the cue uses the whole lane before it gives up
 *   size; a key word whose rows do not fit the lane at 120 px takes the body floor; one word breaks into at most ten rows.
 * - **Loops never sit on a readable word.** The loop is the word's passing state, not its face (like Strike's ghosts):
 *   the readable word carries the `w…` id and paints whole on its spoken onset frame. Each loop is measured against its
 *   slot: its widest pose stays inside half the gap to each neighbour on its line, half the row gap above and below,
 *   and the safe area, and it ends on the export frame before its word first paints (Sol and Astra, round 1).
 * - **Real speech timing.** A cue opens at most 100 ms before its first word, so the first word's loop gets what that
 *   lead allows (none when the previous cue hands off at once); later words get the sample's 230 ms (260 ms for the key
 *   word). Every contour is planned on the export frames: at least two painted frames, clearly visible on each (the
 *   last at half strength holds the key word's contracted pose, so the hand-off never blinks), else none. The face and
 *   its keyline fade in before the word and are fully opaque on its first spoken frame; when the lead is short the
 *   loop keeps its two frames and the face appears opaque at onset. The key word's rise and scale finish 35 ms after
 *   onset (sooner for a short word) and never move again.
 * - **Exit.** The staggered fade (earlier words first) runs only when two painted frames fit after the last word's
 *   reading hold, and ends at the window's end (a one-word cue hands off without a blank frame). The loops flash back
 *   (the reference's exit) only after each word has faded, when two painted frames remain. Otherwise the cue cuts at
 *   the next cue's first paint, so the outgoing words read up to the moment the next sentence starts.
 * - **Extra recurring beats, from the reference's small pencil circles.** A tiny seed loop leaves each word's slot and
 *   travels through free space (the gap after the word, under its ink) to the next word's slot, arriving as the next
 *   loop starts to grow around it (a window too short to travel holds it still on the way for two frames). When a cue's
 *   last word lands, loose word-style pencil loops (40-56 px wide; two, three on a key-word cue with one gold, fewer
 *   on a short last line) pop out under the last line, drift down and shrink away; a long hold repeats them every
 *   1.6 s, and they finish before the exit starts. Both are behind the text and never cross a readable word.
 * - **Edge and shadow.** Caveat is thin, so the charcoal edge is 0.04 em (the sample's 0.075 em centred stroke drew
 *   about 0.0375 em outside the glyph) and the soft drop shadow stays; Sol's settled 230 px-wide legibility holds.
 *   Loops keep their drop shadow; the echo stroke has none (it is half-transparent and short-lived).
 * - **Every language.** Whole words only (the sample has no per-letter effect), so joined scripts are never split. RTL
 *   lines read right to left, the staircase steps left and the tilt mirrors. Caveat has no Devanagari, Arabic or CJK:
 *   those words go through the glyph-coverage fallback face, and lines, loops and seeds are sized from its measured
 *   ink.
 * - **Brand colours.** Cream words and loops take the primary colour, the key word and its loop the highlight colour,
 *   seeds and settle loops the accent colour; each is checked at 3:1 against the charcoal edge it is drawn with and
 *   falls back to the default when it fails.
 */

export const SKETCH_DEMO: DemoScript = {
  lines: [
    "most:b people:b never:m start:b",
    "start:b before:b you're:m ready:h@560",
    "courage:h@600 is:m quiet:b",
    "you:m are:b unstoppable:h@720",
    "keep:b going:h@520",
  ],
  options: { rate: 205, gap: 30, cueGap: 240, tail: 200, lead: 300 },
};

const FACE = "Caveat Bold";
const ANCHOR = 1290;
/** Sample px: words around a key word, words of a cue with no key word, the key word. */
const BODY = 132;
const SOLO = 148;
const HERO = 210;
/** The smallest a word is fitted to before it breaks across rows. */
const MIN_BODY = 96;
const MIN_HERO = 120;
const COLUMN = 840;
const GAP_EM = 0.26;
/** Each line steps in from the one above by this much (more, up to the max, where the line above leaves room). */
const INDENT = 84;
const INDENT_MAX = 116;
const ROW_GAP = 12;
const TILT = -2;
const EDGE = "#2B2623";
const EDGE_EM = 0.04;
/** A cue opens at most this long before its first word (the conformance lead). */
const LEAD = 100;
/** How long before its word a loop starts: an ordinary word, the key word. */
const GROW = 230;
const HERO_GROW = 260;
const FACE_IN = 90;
/** How long a word takes to fade out before its slot flashes back to a loop. */
const FACE_OUT = 60;
const LOOP_W = 4;
/** The loop starts this small and grows to its rest size. */
const LOOP_FROM = 0.35;
const SEED_MS = 160;
const BUBBLE_MS = 360;
const BUBBLE_EVERY = 1600;
/** Room under the last line for the settle loops, sample px. */
const BUBBLE_ROOM = 72;
/** The caption band of the sample (y 860..1650 of 1920), above and below the anchor line. */
const BAND_ABOVE = ANCHOR - 860;
const BAND_BELOW = 1650 - ANCHOR;
const DEFAULT = { primary: "#FFF1D2", highlight: "#FFC93C", accent: "#FFF1D2" } as const;

/** Words that may break between glyph clusters when one is wider than the column (CJK has no spaces to break at). */
/** Glyphs a row may not start with (closing and trailing punctuation) or end with (opening punctuation). */
const NO_ROW_START = /^[\p{Pe}\p{Pf}\p{Po}]/u;
const NO_ROW_END = /^[\p{Ps}\p{Pi}]$/u;
/** The most rows one word breaks into before it gives up size instead. */
const MAX_ROWS = 10;
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{M}\p{N}\p{P}\p{S}]+$/u;

/** Words in a script Caveat draws; anything else goes to the fallback face, whose letters stand taller at one size. */
const CAVEAT_SCRIPT = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]+$/u;
/** The fallback face at this share of the size matches Caveat's visual weight (its x-height is small). */
const FALLBACK_SCALE = 0.88;

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const textHash = (text: string) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return (h >>> 0) / 4294967296;
};

/** Catmull-Rom through points, as cubic segments. */
function smooth(points: readonly (readonly [number, number])[]): PathCmd[] {
  const path: PathCmd[] = [["M", points[0]![0], points[0]![1]]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    path.push(["C", p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]]);
  }
  return path;
}

/** A wobbly squarish pencil loop centred on (0, 0) that overshoots its own start (the sample's `loopPath`). */
export function sketchLoopPath(w: number, h: number, seed: number, turn = 0, dx = 0, dy = 0): PathCmd[] {
  const n = 15;
  const a0 = hash(seed) * Math.PI * 2;
  const total = Math.PI * 2 + 0.6;
  const points: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (total * i) / n;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const sc = Math.sign(c) * Math.abs(c) ** 0.55;
    const ss = Math.sign(s) * Math.abs(s) ** 0.55;
    const k = 0.88 + 0.09 * (hash(seed + i * 3.1) - 0.5) * 2 + (i / n) * 0.07;
    const [x, y] = rotatePoint((sc * w * k) / 2, (ss * h * k) / 2, turn);
    points.push([x + dx, y + dy]);
  }
  return smooth(points);
}

interface Metrics {
  readonly advance: number;
  readonly inkTop: number;
  readonly inkBottom: number;
}

interface Item {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  /** Sample px. */
  readonly size: number;
  /** The smallest this word may be drawn, sample px at the natural size. */
  readonly floor: number;
  readonly m: Metrics;
}

/** A laid-out word (or piece of one), in block-local px before the tilt: `x` is the middle of its advance. */
interface Cell extends Item {
  readonly line: number;
  readonly x: number;
  readonly baseline: number;
  readonly width: number;
  readonly px: number;
  /** How far the loop may reach from its centre, px, before it meets a neighbour, the next row or the safe area. */
  readonly roomX: number;
  readonly roomY: number;
}

export const sketchProgram = galleryScene(
  "sketch",
  ANCHOR,
  (ctx) => {
    const { cue, index: cueIndex, from: cueFrom, to, bounds } = ctx.window;
    const { exit, exitAt, fps, rtl, space } = ctx;
    const pieces: Piece[] = [];
    const words = cue.words;
    const keep = (colour: string, fallback: string) => (captionColourContrast(colour, EDGE) >= CAPTION_SCENE_BRAND_MIN_CONTRAST ? colour : fallback);
    const colours = {
      primary: keep(ctx.input.colours.primary, DEFAULT.primary),
      highlight: keep(ctx.input.colours.highlight, DEFAULT.highlight),
      accent: keep(ctx.input.colours.accent, DEFAULT.accent),
      shadow: ctx.input.colours.shadow,
    };
    const heroAt = words.findIndex((word) => word.role === "hero");
    const heroed = heroAt >= 0;
    const isHero = (at: number) => words[at]!.role === "hero";

    // Measure once at 100 sample px; every size is linear from it.
    const memo = new Map<string, Metrics>();
    const at100 = (text: string): Metrics => {
      let m = memo.get(text);
      if (!m) {
        const r = ctx.input.measure(text, FACE, 100 * space.u, 0);
        m = { advance: r.advance / space.u, inkTop: r.inkTop / space.u, inkBottom: r.inkBottom / space.u };
        memo.set(text, m);
      }
      return m;
    };
    const widthOf = (text: string, size: number) => (at100(text).advance * size) / 100;

    // The column, in sample px: the sample's 840, or what the lane leaves.
    const column = Math.min(COLUMN, (bounds.x2 - bounds.x1) / space.u - 48);

    /**
     * Breakable units of a word: glyph clusters, with closing and other trailing punctuation kept on the unit before it
     * and opening punctuation on the unit after it, so no row starts with `」` or `，` and none ends with `「`.
     */
    const unitsOf = (text: string): string[] => {
      const units: string[] = [];
      let pending = "";
      for (const cluster of captionTextClusters(text)) {
        if (units.length > 0 && !pending && NO_ROW_START.test(cluster)) units[units.length - 1] += cluster;
        else if (NO_ROW_END.test(cluster)) pending += cluster;
        else {
          units.push(pending + cluster);
          pending = "";
        }
      }
      if (pending) {
        if (units.length > 0) units[units.length - 1] += pending;
        else units.push(pending);
      }
      return units;
    };

    /** Greedy rows of units no wider than `limit` (unit widths summed, sample px at size 100). */
    const greedy = (widths: readonly number[], limit: number): number[] => {
      const cuts: number[] = [];
      let run = 0;
      widths.forEach((width, i) => {
        if (run > 0 && run + width > limit) {
          cuts.push(i);
          run = 0;
        }
        run += width;
      });
      return cuts;
    };

    /**
     * The fewest rows a word breaks into at `size` within `room` (measured cluster widths: the smallest feasible count),
     * then the most even split with that count (least sum of squared row widths, no row over the room). Null when it
     * needs more than `MAX_ROWS`.
     */
    const split = (text: string, size: number, room: number): string[] | null => {
      const units = unitsOf(text);
      const widths = units.map((unit) => widthOf(unit, 100));
      const limit = (room * 0.98 * 100) / size;
      const rows = greedy(widths, limit).length + 1;
      if (rows > MAX_ROWS) return null;
      const count = units.length;
      const prefix = [0];
      for (const width of widths) prefix.push(prefix.at(-1)! + width);
      const best = Array.from({ length: rows + 1 }, () => new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY));
      const from = Array.from({ length: rows + 1 }, () => new Array<number>(count + 1).fill(0));
      best[0]![0] = 0;
      for (let r = 1; r <= rows; r++) {
        for (let i = r; i <= count; i++) {
          for (let j = i - 1; j >= r - 1; j--) {
            const width = prefix[i]! - prefix[j]!;
            if (width > limit && i - j > 1) break;
            const cost = best[r - 1]![j]! + width * width;
            if (cost < best[r]![i]!) {
              best[r]![i] = cost;
              from[r]![i] = j;
            }
          }
        }
      }
      const cuts = [count];
      for (let r = rows; r >= 1; r--) cuts.unshift(from[r]![cuts[0]!]!);
      return cuts.slice(1).map((cut, j) => units.slice(cuts[j], cut).join(""));
    };

    /** A word's size and pieces: the sample size, fitted to the column down to the floor, then broken. */
    const sized = words.map((word, at) => {
      const base = (isHero(at) ? HERO : heroed ? BODY : SOLO) * (CAVEAT_SCRIPT.test(word.text) ? 1 : FALLBACK_SCALE);
      let floor = Math.min(base, isHero(at) ? MIN_HERO : MIN_BODY);
      const width = widthOf(word.text, base);
      if (width <= column) return { size: base, floor, parts: [word.text] };
      const fit = (base * column) / width;
      if (fit >= floor || !SPLITTABLE.test(word.text) || captionTextClusters(word.text).length < 2) return { size: fit, floor: Math.min(floor, fit), parts: [word.text] };
      // A key word whose rows at the key-word floor are taller than the lane (a 90-character token on 1:1) is a
      // sentence, not a key word: it takes the body floor.
      if (isHero(at)) {
        const rows = split(word.text, floor, column)?.length ?? MAX_ROWS + 1;
        const lane = (bounds.y2 - bounds.y1) / (space.u / ctx.input.scale);
        if (rows * (floor * 1.12 + ROW_GAP) + BUBBLE_ROOM > lane * 0.95) floor = Math.min(base, MIN_BODY);
      }
      // A token too long for the row cap at the floor (hundreds of characters) gives up size until it fits the cap.
      let trySize = floor;
      let parts = split(word.text, trySize, column);
      while (!parts && trySize > 12) {
        trySize *= 0.9;
        parts = split(word.text, trySize, column);
      }
      const pieces = parts ?? [word.text];
      const widest = Math.max(...pieces.map((part) => widthOf(part, 100)));
      const size = Math.min(base, (100 * column) / widest);
      return { size, floor: Math.min(floor, size), parts: pieces };
    });

    // The sample's staircase: the words before the key word, then the key word and the rest; no key word, two halves.
    const groups: number[][] = [];
    const all = words.map((_, at) => at);
    if (!heroed) {
      const half = words.length <= 2 ? words.length : Math.ceil(words.length / 2);
      groups.push(all.slice(0, half), all.slice(half));
    } else if (heroAt === 0) groups.push([0], all.slice(1));
    else groups.push(all.slice(0, heroAt), all.slice(heroAt));

    // Lines: a broken word takes a row per piece; a line wider than the column (less one step) wraps, balanced.
    const wrap = Math.max(column * 0.6, column - INDENT * 0.5);
    const lines: Item[][] = [];
    for (const group of groups) {
      if (!group.length) continue;
      let run: Item[] = [];
      const flush = () => {
        if (!run.length) return;
        const widths = run.map((item) => widthOf(item.text, item.size));
        const gap = GAP_EM * Math.min(...run.map((item) => item.size));
        for (const row of balancedRows(widths, gap, wrap)) lines.push(row.map((at) => run[at]!));
        run = [];
      };
      for (const at of group) {
        const { size, floor, parts } = sized[at]!;
        const items = parts.map((text, part) => ({ word: at, part, parts: parts.length, text, size, floor, m: at100(text) }));
        if (items.length > 1) {
          flush();
          for (const item of items) lines.push([item]);
        } else run.push(items[0]!);
      }
      flush();
    }

    // Natural size: the band at the user's position (a larger size shrinks to fit it), inside the lane.
    const natural = space.u / ctx.input.scale;
    const anchorY = space.y(ANCHOR);
    let band = { y1: Math.max(bounds.y1 + 3, anchorY - BAND_ABOVE * natural), y2: Math.min(bounds.y2 - 3, anchorY + BAND_BELOW * natural) };
    const tilt = rtl ? -TILT : TILT;

    /** The staircase at size factor `f` (block-local px, centred on the block, before the tilt). */
    const arrange = (f: number) => {
      const k = space.u * f;
      const metrics = lines.map((line) => {
        const visual = rtl ? rowVisualOrder(line.map((item) => item.text), "rtl") : line.map((_, i) => i);
        const ordered = visual.map((i) => line[i]!);
        let x = 0;
        const xs: number[] = [];
        ordered.forEach((item, i) => {
          if (i > 0) x += GAP_EM * Math.max(item.size, ordered[i - 1]!.size) * k * 0.5 + GAP_EM * Math.min(item.size, ordered[i - 1]!.size) * k * 0.5;
          const w = (item.m.advance * item.size * k) / 100;
          xs.push(x + w / 2);
          x += w;
        });
        const above = Math.max(...line.map((item) => (Math.max(-item.m.inkTop, 62) + 100 * EDGE_EM) * item.size)) * k / 100;
        const below = Math.max(...line.map((item) => (Math.max(item.m.inkBottom, 20) + 100 * EDGE_EM) * item.size)) * k / 100;
        return { ordered, xs, width: x, above, below };
      });
      const baselines: number[] = [];
      let y = 0;
      metrics.forEach((line, i) => {
        y += i === 0 ? line.above : metrics[i - 1]!.below + ROW_GAP * k + line.above;
        baselines.push(y);
      });
      const height = y + metrics.at(-1)!.below;
      // Steps: the sample's 84 px (up to 116 where the line above leaves room), shrunk until the staircase fits the column.
      const steps = metrics.map((line, i) => {
        if (i === 0) return 0;
        const room = metrics[i - 1]!.width - line.width;
        return room >= INDENT * k ? Math.min(INDENT_MAX * k, room) : INDENT * k;
      });
      let q = 1;
      const span = () => {
        let left = 0;
        let right = 0;
        metrics.forEach((line, i) => {
          left += steps[i]! * q;
          right = Math.max(right, left + line.width);
        });
        return right;
      };
      while (q > 0.3 && span() > column * k) q -= 0.1;
      const total = span();
      const cells: Cell[] = [];
      let left = 0;
      metrics.forEach((line, i) => {
        left += steps[i]! * q;
        const start = rtl ? total - left - line.width : left;
        line.ordered.forEach((item, j) => {
          cells.push({ ...item, line: i, x: start + line.xs[j]! - total / 2, baseline: baselines[i]! - height / 2, width: (item.m.advance * item.size * k) / 100, px: item.size * k, roomX: 0, roomY: 0 });
        });
      });
      // Extent after the tilt (ink with the edge, and the settle loops' room under the last line).
      let x1 = Number.POSITIVE_INFINITY;
      let x2 = Number.NEGATIVE_INFINITY;
      let y1 = Number.POSITIVE_INFINITY;
      let y2 = Number.NEGATIVE_INFINITY;
      const lastLine = metrics.length - 1;
      for (const cell of cells) {
        const edge = EDGE_EM * cell.px;
        const top = cell.baseline + (cell.m.inkTop * cell.px) / 100 - edge;
        const bottom = cell.baseline + (cell.m.inkBottom * cell.px) / 100 + edge + (cell.line === lastLine ? BUBBLE_ROOM * k : 0.06 * cell.px);
        for (const [cx, cy] of [[cell.x - cell.width / 2 - edge, top], [cell.x + cell.width / 2 + edge, top], [cell.x - cell.width / 2 - edge, bottom], [cell.x + cell.width / 2 + edge, bottom]] as const) {
          const [rx, ry] = rotatePoint(cx, cy, tilt);
          x1 = Math.min(x1, rx);
          x2 = Math.max(x2, rx);
          y1 = Math.min(y1, ry);
          y2 = Math.max(y2, ry);
        }
      }
      return { cells, metrics, baselines, k, x1, x2, y1, y2 };
    };

    // Fit the band; when that would draw a word under its floor, the block may use the whole lane instead (a long CJK
    // sentence, a tall Devanagari cue at 2x), and only shrinks under the floor when even the lane is too small.
    const fFloor = Math.max(...lines.flat().map((item) => (item.floor * natural) / (item.size * space.u)));
    const fitInto = (area: { y1: number; y2: number }) => {
      let f = 1;
      let laid = arrange(f);
      for (let tries = 0; tries < 10; tries++) {
        const fit = Math.min(1, (area.y2 - area.y1) / (laid.y2 - laid.y1), (bounds.x2 - bounds.x1 - 12) / (laid.x2 - laid.x1));
        if (fit >= 1) break;
        f *= Math.min(0.97, fit * 0.98);
        laid = arrange(f);
      }
      return { f, laid };
    };
    let fitted = fitInto(band);
    if (fitted.f < fFloor - 1e-6) {
      band = { y1: bounds.y1 + 3, y2: bounds.y2 - 3 };
      fitted = fitInto(band);
    }
    const arranged = fitted.laid;
    const { metrics, k } = arranged;
    // Where the block centre sits on the canvas: on the anchor, moved into the band and the lane.
    const cx0 = clamp(space.x(540), bounds.x1 + 6 - arranged.x1, bounds.x2 - 6 - arranged.x2);
    const cy0 = clamp(anchorY, band.y1 - arranged.y1, Math.max(band.y1 - arranged.y1, band.y2 - arranged.y2));
    const toCanvas = (x: number, y: number) => {
      const [rx, ry] = rotatePoint(x, y, tilt);
      return [cx0 + rx, cy0 + ry] as const;
    };

    // The loop's box around a cell, block-local: its ink with the edge, a little wider, centred on the ink.
    const loopBox = (cell: Cell) => {
      const top = Math.min((cell.m.inkTop * cell.px) / 100, -0.55 * cell.px);
      const bottom = Math.max((cell.m.inkBottom * cell.px) / 100, 0.08 * cell.px);
      return { cy: cell.baseline + (top + bottom) / 2, w: cell.width + 0.14 * cell.px, h: (bottom - top) * 0.92 };
    };

    // Each loop's room: half the gap to each neighbour on its line (their edge included), half the row gap above and
    // below, and the lane's sides.
    const cells: Cell[] = arranged.cells.map((cell, _, list) => {
      const edge = EDGE_EM * cell.px;
      const row = list.filter((other) => other.line === cell.line);
      const order = row.indexOf(cell);
      const prev = row[order - 1];
      const next = row[order + 1];
      const left = prev ? (prev.x + prev.width / 2 + EDGE_EM * prev.px + cell.x - cell.width / 2 - edge) / 2 : Number.NEGATIVE_INFINITY;
      const right = next ? (cell.x + cell.width / 2 + edge + next.x - next.width / 2 - EDGE_EM * next.px) / 2 : Number.POSITIVE_INFINITY;
      const [canvasX] = toCanvas(cell.x, cell.baseline);
      const lane = Math.min(canvasX - bounds.x1, bounds.x2 - canvasX) - 6;
      // Caveat's cursive strokes overhang the advance box a little: keep that much further off.
      const roomX = Math.min(cell.x - left, right - cell.x, lane) - 0.04 * cell.px;
      // Vertical room from the loop's centre (near the middle of the ink) to half the row gap.
      const line = metrics[cell.line]!;
      const box = loopBox(cell);
      const up = box.cy - (cell.baseline - line.above - (cell.line > 0 ? ROW_GAP * k * 0.5 : 40 * k));
      const down = cell.baseline + line.below + (cell.line < metrics.length - 1 ? ROW_GAP * k * 0.5 : 30 * k) - box.cy;
      return { ...cell, roomX, roomY: Math.min(up, down) };
    });

    const shadowOf = (px: number) => [{ dx: 0, dy: 0.04 * px, blur: 0.05 * px, colour: colours.shadow, alpha: 0.55 }];
    const loopShadow = [{ dx: 0, dy: 2 * k, blur: 1.5 * k, colour: colours.shadow, alpha: 0.65 }];
    const lastFrameOf = (word: SceneWord) => exportFrameAtOrBefore(word.endMs - 1, fps);
    const frames = (fn: (t: number) => number, edges: readonly number[], range: readonly [number, number], error: number): Frames =>
      sampleFrames(fn, edges, error, { range, simplify: true });


    /**
     * Opacity planned on the export frames a piece paints in `[from, until)`: `first` on its first frame, full in the
     * middle, `last` on its last, so a short contour shows two clearly visible poses and never a near-invisible tail.
     * Null when fewer than two frames paint.
     */
    const gridOpacity = (from: number, until: number, first: number, last: number): { o: Frames; times: number[] } | null => {
      const times = exportFrameTimes(from, until, fps);
      if (times.length < 2) return null;
      const o: [number, number][] = times.map((t, i) => [t, i === 0 ? first : i === times.length - 1 ? last : 1]);
      return { o, times };
    };

    // The exit. With room, each word fades first (earlier words a little ahead), then its slot flashes back to a small
    // loop that shrinks away over at least two painted frames; otherwise the words fade in a short stagger to the cut.
    const exitSpan = exit ? Math.max(0, to - exitAt) : 0;
    const n = words.length;
    const loopsOut = exit && exitSpan >= FACE_OUT + 70;
    const stagger = n > 1 ? (loopsOut ? Math.min(10, (exitSpan - FACE_OUT - 70) / (n - 1)) : Math.min(22, (exitSpan * 0.25) / (n - 1))) : 0;
    const fadeSpan = loopsOut ? FACE_OUT : exitSpan - stagger * (n - 1);

    /**
     * Per word: its loop runs `[a, b)` and ends on the frame before the face first paints (`b`); the face fades in from
     * `fs` and is opaque on the first export frame at or after its spoken start (`on`).
     */
    const timing = words.map((word, at) => {
      const s = word.startMs;
      const pre = at === 0 ? LEAD : isHero(at) ? HERO_GROW : GROW;
      const a = Math.max(cueFrom, s - pre);
      const lead = s - a;
      const faceIn = lead >= 160 ? FACE_IN : lead * 0.3;
      const on = exportFrameAtOrAfter(s, fps);
      const fs = Math.max(cueFrom, s - faceIn);
      // When the lead fits the loop's two frames only without the face's fade-in frame, the loop keeps them and the
      // face appears opaque on its onset frame.
      if (faceIn > 0 && exportFrameTimes(a, exportFrameAtOrAfter(fs, fps), fps).length < 2 && exportFrameTimes(a, on, fps).length >= 2) return { s, a, fs: s, on, b: on };
      return { s, a, fs, on, b: exportFrameAtOrAfter(fs, fps) };
    });

    for (const cell of cells) {
      const at = cell.word;
      const word = words[at]!;
      const hero = isHero(at);
      const { s, a, fs, on, b } = timing[at]!;
      const last = Math.max(fs, lastFrameOf(word));
      const fill = hero ? colours.highlight : colours.primary;
      const [x, y] = toCanvas(cell.x, cell.baseline);
      const id = cell.parts > 1 ? `${ctx.id}:w${at}l${cell.part}` : `${ctx.id}:w${at}`;

      // The face, with its keyline: fades in before the word is spoken and is fully opaque on its first spoken frame
      // (at once when there is no lead); the key word rises and grows into place by 35 ms after onset, an ordinary
      // word by 50 ms, then never moves again.
      const fades = exportFrameTimes(fs, on, fps).some((t) => t > fs);
      const o: [number, number, ("out" | "in")?][] = fades ? [[fs, 0], [on, 1, "out"]] : [[fs, 1]];
      const out0 = exitAt + at * stagger;
      if (exit) o.push([out0, 1], [out0 + fadeSpan, 0, "in"]);
      const poseEnd = Math.min(fs + (hero ? 125 : 140), last, s + (hero ? 35 : 50));
      const moves = paintedFrameCount(fs, poseEnd, fps) >= 2;
      const drop = (hero ? 12 : 8) * k;
      const grow = hero ? 0.9 : 0.95;
      const face: TextPiece = {
        id,
        kind: "text",
        z: 6,
        fromMs: fs,
        toMs: to,
        text: cell.text,
        face: FACE,
        sizePx: cell.px,
        letterSpacingEm: 0,
        fill,
        stroke: { widthPx: EDGE_EM * cell.px, colour: EDGE },
        shadows: shadowOf(cell.px),
        anchor: "baseline-center",
        language: cue.language,
        track: {
          x: [[fs, x]],
          y: moves ? [[fs, y + drop], [poseEnd, y, "out"]] : [[fs, y]],
          ...(moves ? { sx: [[fs, grow], [poseEnd, 1, "out"]] as Frames, sy: [[fs, grow], [poseEnd, 1, "out"]] as Frames } : {}),
          rz: [[fs, tilt]],
          o,
        },
      };
      pieces.push(face);

      // The loop and its fainter echo, on the word's slot, under all the text.
      const box = loopBox(cell);
      const seed = cueIndex * 17 + at * 5.3 + cell.part * 2.9 + 1.1 + textHash(cell.text) * 10;
      const mainPath = sketchLoopPath(box.w, box.h, seed);
      const echoPath = sketchLoopPath(box.w * 0.97, box.h * 1.03, seed + 40, 2.5, box.w * 0.015, -box.h * 0.015);
      const reach = (path: readonly PathCmd[], width: number) => {
        const pb = pathBounds(path);
        return { x: Math.max(-pb.x1, pb.x2) + width, y: Math.max(-pb.y1, pb.y2) + width };
      };
      const mainReach = reach(mainPath, LOOP_W * k);
      const echoReach = reach(echoPath, LOOP_W * 0.6 * k);
      const reachX = Math.max(mainReach.x, echoReach.x);
      const reachY = Math.max(mainReach.y, echoReach.y);
      const maxSx = clamp(cell.roomX / reachX, 0.5, hero ? 1.14 : 1.25);
      const maxSy = clamp(cell.roomY / reachY, 0.5, hero ? 1.06 : 1);
      const rest = Math.min(1, maxSx);
      const restY = Math.min(1, maxSy);
      const [lx, ly] = toCanvas(cell.x, box.cy);
      const loopColour = hero ? colours.highlight : colours.primary;
      const addLoop = (suffix: string, from: number, until: number, o: Frames, sx: (t: number) => number, sy: (t: number) => number, rot: (t: number) => number, edges: readonly number[]) => {
        const range = [from, until] as const;
        const track = {
          x: [[from, lx]] as Frames,
          y: [[from, ly]] as Frames,
          sx: frames(sx, edges, range, 0.004),
          sy: frames(sy, edges, range, 0.004),
          rz: frames((t) => tilt + rot(t), edges, range, 0.1),
          o,
        };
        const name = `${ctx.id}:${suffix}${at}${cell.parts > 1 ? `-${cell.part}` : ""}`;
        pieces.push(
          { id: name, kind: "shape", z: 2, fromMs: from, toMs: until, path: mainPath, stroke: { widthPx: LOOP_W * k, colour: loopColour }, shadows: loopShadow, track },
          { id: `${name}e`, kind: "shape", z: 2, fromMs: from, toMs: until, path: echoPath, stroke: { widthPx: LOOP_W * 0.6 * k, colour: loopColour, alpha: 0.55 }, track },
        );
      };

      // The entrance loop paints on at least two export frames before the face's first frame, clearly visible on each
      // (the last keeps half its strength, so the hand-off to the word never blinks); otherwise there is no loop.
      const entrance = gridOpacity(a, b, 0.85, 0.55);
      if (entrance) {
        const end = entrance.times.at(-1)!;
        if (hero) {
          // Grows wider than the word, then contracts onto it; the last loop frame is the contracted pose.
          const growEnd = a + clamp(end - a - 70, Math.min(20, (end - a) * 0.4), Math.max(1, end - a - 1));
          const contract = Math.max(growEnd, end - 80);
          const tight = Math.min(1, maxSx) * 0.97;
          const g = (t: number) => EASES.outExpo(prog(t, a, growEnd - a));
          const c = (t: number) => EASES.inOut(prog(t, contract, end - contract));
          const sx = (t: number) => {
            const grown = LOOP_FROM + (maxSx - LOOP_FROM) * g(t);
            return grown + (tight - grown) * c(t);
          };
          const sy = (t: number) => {
            const grown = LOOP_FROM + (maxSy - LOOP_FROM) * g(t);
            return grown + (Math.min(1, maxSy) - grown) * c(t);
          };
          addLoop("loop", a, b, entrance.o, sx, sy, (t) => -8 * (1 - g(t)), [a, growEnd, contract, end, b]);
        } else {
          const growEnd = a + clamp((end - a) * 0.6, Math.min(20, (end - a) * 0.5), 170);
          const g = (t: number) => EASES.outExpo(prog(t, a, growEnd - a));
          const sx = (t: number) => LOOP_FROM + (rest - LOOP_FROM) * g(t);
          const sy = (t: number) => LOOP_FROM + (restY - LOOP_FROM) * g(t);
          addLoop("loop", a, b, entrance.o, sx, sy, (t) => -6 * (1 - g(t)), [a, growEnd, end, b]);
        }
      }

      // The exit: once the word has faded, its slot flashes back to a small loop that shrinks away.
      if (loopsOut) {
        const from = exportFrameAtOrAfter(out0 + fadeSpan, fps);
        const flash = gridOpacity(from, to, 0.7, 0.4);
        if (flash) {
          const q = (t: number) => EASES.inOut(prog(t, from, flash.times.at(-1)! - from));
          addLoop("out", from, to, flash.o, (t) => rest + (0.4 - rest) * q(t), (t) => restY + (0.4 - restY) * q(t), (t) => 7 * q(t), [from, flash.times.at(-1)!, to]);
        }
      }

      // A seed leaves the slot before and travels through free space to this slot, arriving as the loop starts to grow
      // around it. A window too short to travel holds it still on the way for two frames instead.
      const prevCell = cells.filter((other) => other.word === at - 1).at(-1);
      if (entrance && prevCell && cell.part === 0) {
        const arrive = Math.max(a, Math.min(a + 40, b - 20));
        const seedEnd = Math.min(b, arrive + 30);
        const travels = arrive - Math.max(cueFrom, arrive - SEED_MS) >= 60;
        const seedStart = travels ? Math.max(cueFrom, arrive - SEED_MS) : Math.max(cueFrom, seedEnd - 75);
        const plan = gridOpacity(seedStart, seedEnd, 0.9, 0.6);
        if (plan) {
          const edge = EDGE_EM * prevCell.px;
          const gapX = rtl ? prevCell.x - prevCell.width / 2 - edge - 0.5 * GAP_EM * prevCell.size * k : prevCell.x + prevCell.width / 2 + edge + 0.5 * GAP_EM * prevCell.size * k;
          const below = prevCell.baseline + (Math.max(prevCell.m.inkBottom, 8) * prevCell.px) / 100 + edge + 10 * k;
          const [x0, y0] = [gapX, below];
          const [x1, y1] = [cell.x, box.cy];
          const r = clamp(0.075 * cell.size, 7, 12) * k;
          const travel = (t: number) => (travels ? EASES.inOut(prog(t, seedStart, arrive - seedStart)) : 0.5);
          const arc = (t: number) => Math.sin(Math.PI * travel(t)) * 10 * k;
          const pos = (t: number) => toCanvas(x0 + (x1 - x0) * travel(t), y0 + (y1 - y0) * travel(t) + arc(t));
          const edges = [seedStart, arrive, seedEnd];
          const range = [seedStart, seedEnd] as const;
          const scale = (t: number) => 0.6 + 0.4 * travel(t);
          pieces.push({
            id: `${ctx.id}:seed${at}`,
            kind: "shape",
            z: 2,
            fromMs: seedStart,
            toMs: seedEnd,
            path: sketchLoopPath(2 * r, 2 * r, seed + 7),
            stroke: { widthPx: 2.5 * k, colour: colours.accent },
            shadows: loopShadow,
            track: {
              x: frames((t) => pos(t)[0], edges, range, 0.3),
              y: frames((t) => pos(t)[1], edges, range, 0.3),
              sx: frames(scale, edges, range, 0.01),
              sy: frames(scale, edges, range, 0.01),
              rz: [[seedStart, tilt]],
              o: plan.o,
            },
          });
        }
      }
    }

    // When the last word lands, small loose pencil loops (word loops in miniature) pop out under the last line, drift
    // down and shrink away; a long hold repeats them. They finish before the exit starts, compressed into the time
    // there is; a window too short to animate them holds a still pose for its frames.
    const lastWord = words.at(-1)!;
    const lastLineCells = cells.filter((cell) => cell.line === metrics.length - 1);
    const lineLeft = Math.min(...lastLineCells.map((cell) => cell.x - cell.width / 2));
    const lineRight = Math.max(...lastLineCells.map((cell) => cell.x + cell.width / 2));
    const lineBottom = Math.max(...lastLineCells.map((cell) => cell.baseline + (Math.max(cell.m.inkBottom, 10) * cell.px) / 100 + EDGE_EM * cell.px));
    const landed = Math.max(timing.at(-1)!.on + 40, lastWord.startMs + 30);
    const settleEnd = exit ? exitAt : to;
    const textSeed = textHash(words.map((word) => word.text).join(" "));
    for (let burst = 0; burst < 4; burst++) {
      const t0 = landed + burst * BUBBLE_EVERY;
      if (burst > 0 && t0 + BUBBLE_MS + 80 > settleEnd) break;
      // As many as the last line spaces out (each loop needs about 70 px of it), at least one.
      const count = Math.max(1, Math.min(heroed ? 3 : 2, Math.floor((lineRight - lineLeft) / (70 * k))));
      for (let j = 0; j < count; j++) {
        const h = hash(cueIndex * 31 + burst * 7 + j * 3 + textSeed * 50);
        const from = t0 + j * 40;
        const until = Math.min(settleEnd, from + BUBBLE_MS);
        const painted = paintedFrameCount(from, until, fps);
        if (painted < 2) continue;
        const still = painted < 5;
        const w = (40 + 16 * hash(h * 91 + 3)) * k;
        const ht = w * 0.55;
        const u = (j + 0.5) / count + ((h - 0.5) * 0.25) / count;
        const bx = lineLeft + (lineRight - lineLeft) * (rtl ? 1 - u : u);
        const by = lineBottom + (14 + 6 * hash(h * 13 + 1)) * k + ht / 2;
        const side = (hash(h * 7 + 5) - 0.5) * 12 * k;
        const p = (t: number) => prog(t, from, until - from);
        const pos = (t: number) => (still ? toCanvas(bx, by) : toCanvas(bx + side * EASES.out(p(t)), by + 12 * k * EASES.out(p(t))));
        const scale = (t: number) => (still ? 0.85 : 0.55 + 0.45 * EASES.outExpo(Math.min(1, p(t) * 3)) - 0.25 * EASES.in(p(t)));
        const alpha = (t: number) => (still ? 0.8 : Math.min(1, p(t) * 6) * (1 - EASES.in(p(t))) * 0.9);
        const turn = (t: number) => tilt + (still ? 0 : (hash(h * 3 + 9) - 0.5) * 16 * p(t));
        const edges = [from, from + (until - from) / 6, from + (until - from) / 3, until];
        const range = [from, until] as const;
        pieces.push({
          id: `${ctx.id}:bub${burst}-${j}`,
          kind: "shape",
          z: 2,
          fromMs: from,
          toMs: until,
          path: sketchLoopPath(w, ht, h * 100),
          stroke: { widthPx: 3.5 * k, colour: heroed && j === Math.min(1, count - 1) ? colours.highlight : colours.accent },
          shadows: loopShadow,
          track: {
            x: frames((t) => pos(t)[0], edges, range, 0.3),
            y: frames((t) => pos(t)[1], edges, range, 0.3),
            sx: frames(scale, edges, range, 0.01),
            sy: frames(scale, edges, range, 0.01),
            rz: frames(turn, edges, range, 0.2),
            o: frames(alpha, edges, range, 0.01),
          },
        });
      }
    }
    return pieces;
  },
  undefined,
  LEAD,
);
