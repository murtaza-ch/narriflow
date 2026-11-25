import type { DemoScript } from "../demo";
import { EASES, lerp, prog } from "../ease";
import { exportFrameTimes, paintedFrameCount, sceneSampleRate } from "../frame-grid";
import { sampleFrames } from "../frames";
import { balancedRows, rowVisualOrder } from "../layout";
import { type Box, type Frames, type PathCmd, type Piece, type Track, sceneBoundsAt } from "../scene";
import { ellipsePath, pathBounds, polygonPath, polylinePath } from "../shapes";
import { caps, galleryScene, rotatePoint } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

/**
 * Snip Snap (`samples/templates/m66-snipsnap.js`, after Motion Array "Snip Snap Branding Pack"): a paper-cut collage. Every line
 * rides a hand-cut polygon label (yellow, cyan, pink or lime) with a second label in a contrasting colour peeking out from behind
 * it; the labels tilt alternately, overlap, and snap in with a spring from small and twisted. The label grows as each word is said.
 * Type is Londrina Solid Black in a colour that sits on its label, with a hard offset shadow. Cut-paper doodles (zigzag, spiral,
 * burst, heart, flower, pointing hand) pop beside the key word.
 *
 * What changed from the sample, and why (gallery-5 brief, 2026-11-25):
 * - Doodles never sit on a word. The sample hangs a 176 px doodle on the key label's corner, which on a real cue lies over the
 *   first or last letters. Each doodle is a circle of its full pop size and is walked outward from the label's corner (then the
 *   other corners) until it is clear of every spoken word of the cue, the other doodles and the safe area; a doodle with no free
 *   spot is dropped rather than put on ink. Doodles are the only decoration drawn over the type; tape and scraps stay under it.
 * - Cue-indexed picks became counters. The doodle kind cycled by `ci * 2 + di` (a cue with one doodle never reached half the kinds,
 *   and the tilt `10 + ci * 4` degrees grew without bound); the kind now follows a running doodle count over the whole clip and the
 *   tilt is a seeded 10-30 degrees. Label colours, outlines and tilts cycle by cue and row exactly as the sample does, with the
 *   sample's own seeded cut-edge jitter (a pure function of the cue and row, never `Math.random`).
 * - Rows come from the words: a key word has a row of its own and the words around it wrap into evenly filled rows (balanced), not
 *   greedy, so a lone word never trails. Every row and key word is fitted (the sample's 800 / 780 px caps), then the whole block is
 *   fitted to the safe area by the shared gallery fit. A label is as tall as the measured ink needs, so Devanagari and Urdu fit.
 * - Real speech: a label first paints at most 40 ms before its word and its spring is compressed into the word's own time when the
 *   word is short (a static pose under two painted frames). The label grows by whole words as in the sample; a growth step that
 *   would last under two painted frames is merged into the next one (never narrower than its words). The exit starts no earlier than
 *   150 ms after the last word's spoken end and is dropped for a cut when there are fewer than two painted frames of room.
 * - Right-to-left cues mirror the stagger, tilts and growth (the label grows from its right edge) and place words in bidi order;
 *   words are never split, so every script works, and the case change applies only to cased scripts.
 * - Brand colours: the yellow, pink and cyan papers take the preset's primary, highlight and accent (`readsOn` guards the ink).
 * - New recurring beats, in the cut-paper language and on every cue: a strip of washi TAPE pinned to the leading top corner of the
 *   first label, and four paper SCRAPS (cut triangles and quads in the label colours) that tumble out from the key label (the last
 *   label when there is no key word) and settle in free space. Both sit under the type, are placed clear of every word, and are dropped
 *   when no free spot is found.
 * - Cost: no blur anywhere; the sample's soft nothing is a hard shadow on the type and a hard offset copy on each doodle.
 */

export const SNIPSNAP_DEMO: DemoScript = {
  lines: [
    "your:m bright:b story:h@700",
    "change:b the:m game:h@560",
    "make:b your:m own:b magic:h@660",
    "just:m keep:b it:m simple:b",
    "focus:b on:m creativity:h@820",
  ],
  options: { rate: 260, cueGap: 150, tail: 900, lead: 400 },
};

const FACE = "Londrina Solid Black" as const;
const SPACING = 0.01;
const ANCHOR = 1285;
const BODY = 112;
const HERO_MAX = 236;
const MAX_TEXT_W = 800;
const HERO_TEXT_W = 780;
const PAD_X = 46;
const GAP_EM = 0.26;
const ROW_GAP = 6;
const LEAD = 40;
/** A word is split across rows (never shrunk) when fitting it would take it under this share of the body size. */
const MIN_FIT = 0.64;
/** The two entrance springs start here (the sample's 0.35 and 0.55 multiplied to 19 % on the first frame). */
const HOLDER_FROM = 0.6;
const POP_FROM = 0.85;
/** The caption band, as shares of the canvas height around the anchor line (860-1650 px of a 1920 px frame at the default position). */
const BAND_UP = 425 / 1920;
const BAND_DOWN = 365 / 1920;
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}\p{P}]+$/u;
const LIME = "#93E63E";
const BLUE = "#3355FF";
const ORANGE = "#FF9F1C";
const DOODLE_SHADOW = "#2B1D9E";
const KINDS = ["burst", "zigzag", "heart", "hand", "flower", "spiral"] as const;
type Kind = (typeof KINDS)[number];

type Pt = readonly [number, number];
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly hx: number;
  readonly hy: number;
  readonly rot: number;
}

/** Seeded jitter in -1..1, so a label's cut edges are always the same (the sample's hash). */
const rnd = (seed: number, i: number) => {
  const v = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
};

/** A hand-cut label outline for width `w`, height `h` (px): a loosely cut rectangle, with a pennant point, a notch or a tail. */
function labelPoints(w: number, h: number, style: number, seed: number, u: number): Pt[] {
  const j = (i: number, a: number) => rnd(seed, i) * a * u;
  const P: Pt[] = [
    [j(0, 7), j(1, 7)],
    [w * 0.3 + j(2, 6), -5 * u + j(3, 6)],
    [w * 0.68 + j(4, 6), 3 * u + j(5, 6)],
    [w + j(6, 8), j(7, 8)],
  ];
  if (style === 1) P.push([w + 26 * u, h * 0.5 + j(8, 6)]);
  if (style === 2) P.push([w + j(9, 8) - 4 * u, h * 0.45]);
  P.push([w + j(10, 8), h + j(11, 8)]);
  if (style === 3) P.push([w * 0.62, h + 6 * u], [w * 0.52, h + 30 * u], [w * 0.46, h + 4 * u]);
  P.push([w * 0.55 + j(12, 6), h + 4 * u + j(13, 6)], [w * 0.22 + j(14, 6), h - 3 * u + j(15, 6)]);
  P.push([j(16, 8), h + j(17, 8)]);
  if (style === 2) P.push([-12 * u, h * 0.5]);
  return P;
}

const starPoints = (spikes: number, outer: number, inner: number, rot: number): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner + (i % 4 === 1 ? 2 : -2);
    const a = ((rot + (i * 180) / spikes) * Math.PI) / 180;
    pts.push([50 + r * Math.cos(a), 50 + r * Math.sin(a)]);
  }
  return pts;
};

const spiralPoints = (): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= 44; i++) {
    const a = i * 0.42;
    const r = 4 + a * 3.1;
    pts.push([50 + r * Math.cos(a), 50 + r * Math.sin(a)]);
  }
  return pts;
};

interface Part {
  readonly path: readonly PathCmd[];
  readonly fill?: string;
  readonly stroke?: { readonly widthPx: number; readonly colour: string };
  readonly shadow: boolean;
}

/** One cut-paper doodle on the sample's 100 grid; `k` is canvas px per grid unit, the grid centre is the origin. */
function doodleParts(kind: Kind, k: number, c: { primary: string; highlight: string; accent: string }): Part[] {
  const at = (pts: readonly Pt[]): Pt[] => pts.map(([x, y]) => [(x - 50) * k, (y - 50) * k]);
  const poly = (pts: readonly Pt[], fill: string, shadow = true): Part => ({ path: polygonPath(at(pts)), fill, shadow });
  switch (kind) {
    case "zigzag":
      return [{ path: polylinePath(at([[6, 64], [24, 30], [42, 66], [60, 28], [78, 66], [94, 30]])), stroke: { widthPx: 12 * k, colour: BLUE }, shadow: true }];
    case "spiral":
      return [{ path: polylinePath(at(spiralPoints())), stroke: { widthPx: 9 * k, colour: BLUE }, shadow: true }];
    case "burst":
      return [poly(starPoints(10, 48, 26, -80), c.primary), poly(starPoints(10, 28, 15, -80), ORANGE, false)];
    case "heart":
      return [poly([[50, 92], [8, 50], [10, 22], [32, 12], [50, 30], [68, 12], [90, 22], [92, 50]], c.highlight)];
    case "flower":
      return [
        poly([[50, 4], [64, 22], [88, 20], [80, 44], [96, 62], [72, 70], [66, 94], [50, 80], [34, 94], [28, 70], [4, 62], [20, 44], [12, 20], [36, 22]], c.accent),
        { path: ellipsePath(0, 0, 16 * k), fill: c.primary, shadow: false },
      ];
    case "hand":
      return [poly([[4, 38], [28, 34], [28, 80], [4, 76]], c.highlight), poly([[28, 38], [64, 36], [66, 26], [94, 32], [96, 48], [68, 52], [70, 62], [62, 74], [28, 76]], c.primary)];
  }
}

/** Farthest a doodle's drawing (with its offset copy and stroke) reaches from its centre, per grid unit, however it is turned. */
function doodleReach(kind: Kind, c: { primary: string; highlight: string; accent: string }): number {
  let reach = 0;
  for (const part of doodleParts(kind, 1, c)) {
    const bounds = pathBounds(part.path);
    const stroke = part.stroke?.widthPx ?? 0;
    for (const x of [bounds.x1 - stroke, bounds.x2 + stroke + 5]) for (const y of [bounds.y1 - stroke, bounds.y2 + stroke + 6]) reach = Math.max(reach, Math.hypot(x, y));
  }
  return reach;
}

/** The shape of a paper scrap: a cut triangle or quad around the origin, `r` px across. */
function scrapPath(variant: number, r: number): PathCmd[] {
  switch (variant % 3) {
    case 0: return polygonPath([[-r, r * 0.7], [r * 0.2, -r * 0.8], [r, r * 0.5]]);
    case 1: return polygonPath([[-r, -r * 0.5], [r * 0.9, -r * 0.7], [r * 0.6, r * 0.6], [-r * 0.7, r * 0.8]]);
    default: return polygonPath([[-r * 0.8, -r * 0.2], [0, -r], [r * 0.9, r * 0.1], [r * 0.1, r * 0.9]]);
  }
}

const TAPE: readonly Pt[] = [[-37, -13], [37, -13], [32, -6], [37, 0], [32, 6], [37, 13], [-37, 13], [-32, 6], [-37, 0], [-32, -6]];
const TAPE_COLOURS = ["#FFF4B0", "#C8F7F2", "#FFD1E6"] as const;

/** Distance from a point to the box a rotated rectangle sweeps (the box a renderer's selection or an occlusion check sees). */
function distanceTo(rect: Rect, x: number, y: number): number {
  const a = Math.abs(rect.rot) * Math.PI / 180;
  const hx = rect.hx * Math.cos(a) + rect.hy * Math.sin(a);
  const hy = rect.hx * Math.sin(a) + rect.hy * Math.cos(a);
  return Math.hypot(Math.max(Math.abs(x - rect.x) - hx, 0), Math.max(Math.abs(y - rect.y) - hy, 0));
}

/** One piece of layout: a spoken word, or one segment of a word too long to read on a single label. */
interface Item {
  readonly at: number;
  readonly part: number | null;
  readonly text: string;
  readonly startMs: number;
  /** Advance per px of font size. */
  readonly perPx: number;
}

/** Distance from a point to a rotated rectangle itself (0 inside). */
function distanceToRect(rect: Rect, x: number, y: number): number {
  const [vx, vy] = rotatePoint(x - rect.x, y - rect.y, -rect.rot);
  return Math.hypot(Math.max(Math.abs(vx) - rect.hx, 0), Math.max(Math.abs(vy) - rect.hy, 0));
}

interface Row {
  readonly items: number[];
  readonly hero: boolean;
  readonly size: number;
  readonly h: number;
  readonly cx: number;
  readonly cy: number;
  readonly left: number;
  readonly width: number;
  readonly cells: Map<number, SpeechCell>;
  readonly rot: number;
  readonly style: number;
  readonly seed: number;
  readonly set: { paper: string; peek: string; ink: string; shadow: string };
  readonly peek: Pt;
  readonly peekRot: number;
}

interface Layout {
  readonly rows: Row[];
  /** Canvas px per sample px after the block was fitted to the band. */
  readonly u: number;
}

export const snipsnapProgram = galleryScene("snipsnap", ANCHOR, (ctx) => {
  const { cue, index, to } = ctx.window;
  const { input, space, side, fps, exit, exitAt } = ctx;
  const u0 = space.u;
  const c = input.colours;
  const sets = [
    { paper: c.primary, peek: c.highlight, ink: "#3B2BD9", shadow: c.highlight },
    { paper: c.accent, peek: c.primary, ink: "#5B1FD4", shadow: c.highlight },
    // The sample's yellow ink on pink reads at 2.4:1: violet ink (5.2:1) with the yellow as its hard shadow.
    { paper: c.highlight, peek: c.accent, ink: "#1E1280", shadow: "#FFF04D" },
    { paper: LIME, peek: "#7A3BFF", ink: "#2B1D9E", shadow: "#FFFFFF" },
  ];
  const texts = cue.words.map((word) => caps(word, cue));
  const direction = ctx.rtl ? "rtl" : "ltr";

  // Items: a word on one label, or a long word cut into the fewest segments that each read at the minimum size.
  const items: Item[] = [];
  const itemsOfWord: number[][] = [];
  cue.words.forEach((word, at) => {
    const text = texts[at]!;
    const chars = [...text];
    const per = (part: string) => input.measure(part, FACE, 100, SPACING).advance / 100;
    const cap = (word.role === "hero" ? HERO_TEXT_W : MAX_TEXT_W) * u0;
    const own: number[] = [];
    let pieces = [text];
    if (per(text) * MIN_FIT * BODY * u0 > cap && chars.length > 1 && SPLITTABLE.test(text)) {
      for (let n = 2; n <= chars.length; n++) {
        const size = Math.ceil(chars.length / n);
        pieces = Array.from({ length: n }, (_, k) => chars.slice(k * size, (k + 1) * size).join("")).filter((piece) => piece.length > 0);
        if (Math.max(...pieces.map(per)) * MIN_FIT * BODY * u0 <= cap) break;
      }
    }
    pieces.forEach((piece, part) => {
      own.push(items.length);
      items.push({ at, part: pieces.length > 1 ? part : null, text: piece, startMs: word.startMs + Math.round((part * (word.endMs - word.startMs) * 0.5) / pieces.length), perPx: per(piece) });
    });
    itemsOfWord.push(own);
  });
  const wordOf = (item: Item) => cue.words[item.at]!;
  const virtual = (item: Item) => ({ ...wordOf(item), startMs: item.startMs });

  /** Rows of the block at `k` of the sample size, `dy` canvas px below the anchor line. */
  const layoutRows = (k: number, dy: number): Layout => {
    const u = u0 * k;
    const groups: number[][] = [];
    let run: number[] = [];
    const flush = () => {
      if (run.length === 0) return;
      for (const row of balancedRows(run.map((i) => items[i]!.perPx * BODY * u), GAP_EM * BODY * u, MAX_TEXT_W * u)) groups.push(row.map((at) => run[at]!));
      run = [];
    };
    cue.words.forEach((word, at) => {
      const own = itemsOfWord[at]!;
      if (word.role === "hero" || own.length > 1) {
        flush();
        for (const i of own) groups.push([i]);
      } else run.push(own[0]!);
    });
    flush();
    const sized = groups.map((ids) => {
      const hero = wordOf(items[ids[0]!]!).role === "hero";
      let size = (hero ? HERO_MAX : BODY) * u;
      const natural = ids.reduce((sum, i) => sum + items[i]!.perPx * size, 0) + GAP_EM * size * (ids.length - 1);
      const cap = (hero ? HERO_TEXT_W : MAX_TEXT_W) * u;
      if (natural > cap) size *= cap / natural;
      const metrics = [...ids.map((i) => input.measure(items[i]!.text, FACE, size, SPACING)), input.measure("H", FACE, size, SPACING)];
      const inkTop = Math.min(...metrics.map((m) => m.inkTop));
      const inkBottom = Math.max(...metrics.map((m) => m.inkBottom));
      const h = Math.max(size * 0.86 + 44 * u, inkBottom - inkTop + 44 * u);
      return { ids, hero, size, inkTop, inkBottom, h, metrics };
    });
    const total = sized.reduce((sum, row) => sum + row.h, 0) + ROW_GAP * u * (sized.length - 1);
    let top = space.y(ANCHOR) + dy - total / 2;
    const rows: Row[] = sized.map((row, li) => {
      const { ids, hero, size } = row;
      const gap = GAP_EM * size;
      const widths = ids.map((i) => items[i]!.perPx * size);
      const textW = widths.reduce((sum, w) => sum + w, 0) + gap * (ids.length - 1);
      const width = textW + 2 * PAD_X * u;
      const style = (index + li) % 4;
      const shift = hero ? 0 : (li % 2 === 0 ? -52 : 56) * u * side;
      const rot = (hero ? -3.2 : li % 2 === 0 ? -4.2 : 3.4) * side;
      // Keep the whole label (tilt, pennant, the peeking label) inside the safe area.
      const reach = width / 2 + (style === 1 ? 26 : style === 2 ? 12 : 0) * u + 24 * u + 12 * u + (row.h / 2) * Math.sin((Math.abs(rot) * Math.PI) / 180);
      const centre = space.x(540) + shift;
      const cx = reach * 2 >= space.safe.x2 - space.safe.x1 ? (space.safe.x1 + space.safe.x2) / 2 : Math.min(space.safe.x2 - 3 - reach, Math.max(space.safe.x1 + 3 + reach, centre));
      const cy = top + row.h / 2;
      top += row.h + ROW_GAP * u;
      const left = cx - width / 2;
      const cells = new Map<number, SpeechCell>();
      let x = left + PAD_X * u;
      for (const at of rowVisualOrder(ids.map((i) => items[i]!.text), direction)) {
        const i = ids[at]!;
        const metric = row.metrics[at]!;
        cells.set(i, { at: items[i]!.at, text: items[i]!.text, size, face: FACE, spacing: SPACING, x: x + widths[at]! / 2, baseline: cy - (row.inkTop + row.inkBottom) / 2, width: widths[at]!, inkTop: metric.inkTop, inkBottom: metric.inkBottom });
        x += widths[at]! + gap;
      }
      const slot = li % 2 === 0 ? 1 : -1;
      return {
        items: ids, hero, size, h: row.h, cx, cy, left, width, cells, rot, style, seed: index * 7 + li * 3 + 1,
        set: sets[(index + li * 2 + (hero ? 1 : 0)) % sets.length]!,
        peek: [24 * u * slot * side, -19 * u], peekRot: slot * 5 * side,
      };
    });
    return { rows, u };
  };

  const out = (t: number) => (exit ? EASES.in(prog(t, exitAt, to - exitAt)) : 0);
  const bake = (fn: (t: number) => number, tolerance: number, from: number, extra: number[]): Frames =>
    sampleFrames(fn, [exitAt, to, ...extra], tolerance, { range: [from, to], simplify: true });
  /** Opacity of a free decoration: 1 until the exit, then out with it. */
  const fade = (from: number): Frames => (exit && exitAt > from ? [[from, 1], [exitAt, 1], [to, 0, "in"]] : [[from, 1]]);

  /** The label's own spring, tilt and exit: the one pose its plates, words and tape share. */
  const holderFor = (row: Row) => {
    const lineIn = ctx.enter(virtual(items[row.items[0]!]!), 300, LEAD);
    const lineDur = lineIn.motion ? lineIn.settled - lineIn.from : 0;
    const twist = row.rot < 0 ? 16 : -16;
    return {
      lineIn,
      lineDur,
      pose(t: number) {
        const q = lineDur > 0 ? EASES.spring(prog(t - lineIn.from, 0, lineDur)) : 1;
        const eo = out(t);
        return {
          s: Math.max(0.0001, lerp(HOLDER_FROM, 1, q)) * (1 - 0.7 * eo),
          r: row.rot + (1 - q) * twist + eo * 14 * (row.rot < 0 ? 1 : -1),
          o: 1 - eo,
          q,
        };
      },
    };
  };

  /** The labels and their words. */
  const drawRows = (layout: Layout): Piece[] => {
    const pieces: Piece[] = [];
    layout.rows.forEach((row, li) => {
      const holderOf = holderFor(row);
      const { lineIn, lineDur } = holderOf;
      const holder = (t: number) => holderOf.pose(t);
      const slide = (t: number) => (lineDur > 0 ? EASES.outExpo(prog(t - lineIn.from, (lineDur * 70) / 300, (lineDur * 260) / 300)) : 1);
      const lineEdges = [lineIn.from, lineIn.from + lineDur, lineIn.from + (lineDur * 70) / 300, lineIn.from + (lineDur * 330) / 300];
      // The point `local` (px from the label's centre) on the canvas at `t`.
      const onLabel = (local: Pt, t: number): Pt => {
        const { s, r } = holder(t);
        const [dx, dy] = rotatePoint(local[0] * s, local[1] * s, r);
        return [row.cx + dx, row.cy + dy];
      };

      // The label grows by whole words; a step shorter than two painted frames joins the next.
      const entries = row.items.map((i) => ({ i, ...ctx.enter(virtual(items[i]!), 220, LEAD) }));
      const steps: { from: number; shown: number[] }[] = [];
      let carry: number | null = null;
      entries.forEach((entry, k) => {
        const next = entries[k + 1];
        const from: number = carry ?? entry.from;
        if (next && paintedFrameCount(from, next.from, fps) < 2) {
          carry = from;
          return;
        }
        carry = null;
        steps.push({ from, shown: entries.slice(0, k + 1).map((e) => e.i) });
      });
      steps.forEach((step, k) => {
        const spanLeft = Math.max(0, Math.min(...step.shown.map((i) => row.cells.get(i)!.x - row.cells.get(i)!.width / 2)) - PAD_X * layout.u - row.left);
        const spanRight = Math.min(row.width, Math.max(...step.shown.map((i) => row.cells.get(i)!.x + row.cells.get(i)!.width / 2)) + PAD_X * layout.u - row.left);
        const w = spanRight - spanLeft;
        const toMs = steps[k + 1]?.from ?? to;
        const paperPts = labelPoints(w, row.h, row.style, row.seed, layout.u).map(([x, y]): Pt => [x + spanLeft - row.width / 2, y - row.h / 2]);
        const scale = bake((t) => holder(t).s, 0.003, step.from, lineEdges);
        const paperTrack: Track = {
          x: [[step.from, row.cx]], y: [[step.from, row.cy]], sx: scale, sy: scale,
          rz: bake((t) => holder(t).r, 0.12, step.from, lineEdges), o: bake((t) => holder(t).o, 0.004, step.from, lineEdges),
        };
        // The peeking label: the same span, a different cut, sliding out from behind and tipping.
        const middle: Pt = [spanLeft + w / 2 - row.width / 2, 0];
        const peekPts = labelPoints(w, row.h, (row.style + 2) % 4, row.seed + 9, layout.u).map(([x, y]): Pt => [x - w / 2, y - row.h / 2]);
        const peekAt = (t: number): Pt => onLabel([middle[0] + row.peek[0] * slide(t), middle[1] + row.peek[1] * slide(t)], t);
        const peekTrack: Track = {
          x: bake((t) => peekAt(t)[0], 0.2, step.from, lineEdges), y: bake((t) => peekAt(t)[1], 0.2, step.from, lineEdges),
          sx: paperTrack.sx, sy: paperTrack.sy,
          rz: bake((t) => holder(t).r + row.peekRot * slide(t), 0.12, step.from, lineEdges), o: paperTrack.o,
        };
        const z = li * 2;
        pieces.push({ ...ctx.shape(`p${li}s${k}peek`, step.from, polygonPath(peekPts), peekTrack, row.set.peek), z: 2 + z, toMs });
        pieces.push({ ...ctx.shape(`p${li}s${k}`, step.from, polygonPath(paperPts), paperTrack, row.set.paper), z: 3 + z, toMs });
      });

      // The words: each pops from 0.85 and 7 degrees on top of the label's own spring.
      for (const entry of entries) {
        const item = items[entry.i]!;
        const cell = row.cells.get(entry.i)!;
        const dur = entry.motion ? entry.settled - entry.from : 0;
        const pop = (t: number) => (dur > 0 ? EASES.spring(prog(t - entry.from, 0, dur)) : 1);
        const local: Pt = [cell.x - row.cx, 0];
        const edges = [...lineEdges, entry.from, entry.from + dur];
        const at = (t: number) => onLabel(local, t);
        const shadow = { dx: cell.size * 0.035, dy: cell.size * 0.045, blur: 0, colour: row.set.shadow, alpha: 1 };
        const scale = bake((t) => holder(t).s * lerp(POP_FROM, 1, pop(t)), 0.003, entry.from, edges);
        const track: Track = {
          x: bake((t) => at(t)[0], 0.2, entry.from, edges), y: bake((t) => at(t)[1], 0.2, entry.from, edges),
          sx: scale, sy: scale,
          rz: bake((t) => holder(t).r + (1 - pop(t)) * -7 * side, 0.12, entry.from, edges),
          o: bake((t) => holder(t).o, 0.004, entry.from, edges),
        };
        const face = ctx.face(cell, entry.from, row.set.ink, track);
        pieces.push({ ...face, id: item.part === null ? face.id : `${ctx.id}:w${item.at}l${item.part}`, z: 40 + li, origin: { dx: 0, dy: row.cy - cell.baseline }, shadows: [shadow] });
      }
    });
    return pieces;
  };

  // The caption band: 860-1650 px of a 1920 px frame at the default position, the same share of any canvas, never past the safe area.
  const ay = space.y(ANCHOR);
  const grow = Math.max(1, input.scale);
  const band: Box = {
    x1: space.safe.x1 + 3, x2: space.safe.x2 - 3,
    y1: Math.max(space.safe.y1 + 3, ay - BAND_UP * input.canvas.height * grow),
    y2: Math.min(space.safe.y2 - 3, ay + BAND_DOWN * input.canvas.height * grow),
  };
  /** Where the block's pieces ever are, entrance overshoot and exit included. */
  const motionBox = (pieces: readonly Piece[]): Box => {
    const from = Math.min(...pieces.map((piece) => piece.fromMs));
    const times = new Set(exportFrameTimes(from, to, fps));
    for (let t = from; t < to; t += 16) times.add(t);
    let box: Box | null = null;
    for (const t of times) {
      const at = sceneBoundsAt(pieces, t, input.measure);
      if (at) box = box ? { x1: Math.min(box.x1, at.x1), y1: Math.min(box.y1, at.y1), x2: Math.max(box.x2, at.x2), y2: Math.max(box.y2, at.y2) } : at;
    }
    return box ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
  };

  // Fit: shrink the block until its animated stack fits the band, then slide it in.
  let k = 1;
  let dy = 0;
  let layout = layoutRows(k, dy);
  let pieces = drawRows(layout);
  for (let tries = 0; tries < 8; tries++) {
    const box = motionBox(pieces);
    const fit = Math.min(1, (band.x2 - band.x1) / Math.max(1, box.x2 - box.x1), (band.y2 - band.y1) / Math.max(1, box.y2 - box.y1));
    if (fit < 1) {
      k *= Math.max(0.3, fit * 0.98);
      dy = 0;
    } else {
      const slide = box.y1 < band.y1 ? band.y1 - box.y1 : box.y2 > band.y2 ? band.y2 - box.y2 : 0;
      if (slide === 0) break;
      dy += slide;
    }
    layout = layoutRows(k, dy);
    pieces = drawRows(layout);
  }
  const { rows, u } = layout;

  // ---- extras: doodles beside the key row, tape on the first label, scraps from the key row -------------------------
  // Every extra sits clear of every word, inside the band, and (when the cue is too short for its entrance) shows in a static pose.
  const ink: Rect[] = rows.flatMap((row) => [...row.cells.values()].map((cell): Rect => {
    const [dx, dy2] = rotatePoint(cell.x - row.cx, cell.baseline + (cell.inkTop + cell.inkBottom) / 2 - row.cy, row.rot);
    return { x: row.cx + dx, y: row.cy + dy2, hx: cell.width / 2 * 1.06, hy: (cell.inkBottom - cell.inkTop) / 2 * 1.06, rot: row.rot };
  }));
  const plates: Rect[] = rows.map((row) => ({ x: row.cx, y: row.cy, hx: row.width / 2, hy: row.h / 2, rot: row.rot }));
  const clear = (x: number, y: number, radius: number, margin = 16 * u) => ink.every((rect) => distanceTo(rect, x, y) >= radius + margin);
  const inside = (x: number, y: number, radius: number) => x - radius >= band.x1 && x + radius <= band.x2 && y - radius >= band.y1 && y + radius <= band.y2;
  const frameMs = 1000 / sceneSampleRate(fps);
  const firstFrom = holderFor(rows[0]!).lineIn.from;
  /** When an extra can show: at `wanted`, or earlier so that it paints on two frames; a static pose when its entrance cannot. */
  const showing = (wanted: number, duration: number) => {
    const onset = Math.max(firstFrom, Math.min(wanted, to - 3 * frameMs));
    if (paintedFrameCount(onset, to, fps) < 2) return null;
    const run = Math.min(duration, to - onset);
    return { onset, dur: paintedFrameCount(onset, onset + run, fps) >= 2 ? run : 0 };
  };

  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const anchorRow = rows.find((row) => row.hero) ?? rows.at(-1)!;
  const anchorLi = rows.indexOf(anchorRow);
  const anchorWord = cue.words[items[anchorRow.items[0]!]!.at]!;
  const doodlesBefore = input.cues.slice(0, index).reduce((sum, prior) => sum + (prior.words.length === 0 ? 0 : prior.words.some((word) => word.role === "hero") ? 2 : 1), 0);
  const taken: { x: number; y: number; r: number }[] = [];

  // The corners of a label, in the order a doodle tries them (the sample's top right, then bottom left).
  const corner = (row: Row, sx: number, sy: number): Pt => {
    const [dx, dy2] = rotatePoint(sx * (row.width / 2), sy * (row.h / 2), row.rot);
    return [row.cx + dx, row.cy + dy2];
  };
  const doodleCount = heroAt >= 0 ? 2 : 1;
  for (let di = 0; di < doodleCount; di++) {
    const kind = KINDS[(doodlesBefore + di) % KINDS.length]!;
    const nominal = (heroAt >= 0 ? (di === 0 ? 176 : 150) : 160) * u;
    const order = (heroAt >= 0 ? (di === 0 ? [[1, -1], [-1, 1], [1, 1], [-1, -1]] : [[-1, 1], [1, 1], [-1, -1], [1, -1]]) : [[1, 1], [-1, 1], [1, -1], [-1, -1]]) as readonly Pt[];
    const reach = doodleReach(kind, c);
    const seeds: [Row, number, number][] = [
      ...order.map(([sx, sy]): [Row, number, number] => [anchorRow, sx, sy]),
      ...([[1, -1], [-1, -1]] as const).map(([sx, sy]): [Row, number, number] => [rows[0]!, sx, sy]),
      ...([[-1, 1], [1, 1]] as const).map(([sx, sy]): [Row, number, number] => [rows.at(-1)!, sx, sy]),
    ];
    /** The largest doodle that clears the words, tried at the label corners first and walked outward only as far as it must; a smaller one beside the paper beats a big one far from it. */
    const find = (attached: boolean) => {
      for (const shrink of [1, 0.8, 0.62, 0.5, 0.4]) {
        const size = nominal * shrink;
        const radius = reach * (size / 100) * 1.07 + 6 * u;
        for (const [row, sx, sy] of seeds) {
          const [cornerX, cornerY] = corner(row, sx * side, sy);
          const norm = Math.hypot(sx, sy);
          for (let step = 0; step <= 40; step++) {
            const x = cornerX + (sx * side * step * 6 * u) / norm;
            const y = cornerY + (sy * step * 6 * u) / norm;
            if (!inside(x, y, radius) || !clear(x, y, radius) || !taken.every((o) => Math.hypot(o.x - x, o.y - y) >= o.r + radius)) continue;
            if (attached && Math.min(...plates.map((plate) => distanceToRect(plate, x, y))) > reach * (size / 100) + 20 * u) continue;
            return { x, y, size };
          }
        }
      }
      return null;
    };
    const spot = find(true) ?? find(false);
    if (!spot) continue;
    const when = showing(anchorWord.startMs + 50 + di * 120, 340);
    if (!when) continue;
    taken.push({ x: spot.x, y: spot.y, r: reach * (spot.size / 100) * 1.07 + 6 * u });
    const hash = rnd(index * 5 + di, 3);
    const angle = (di % 2 ? -1 : 1) * (10 + 20 * (hash * 0.5 + 0.5)) * side;
    const phase = rnd(index * 5 + di, 7) * Math.PI;
    const { onset, dur } = when;
    const { x: spotX, y: spotY, size: spotSize } = spot;
    const kk = spotSize / 100;
    // The spring's overshoot is capped at 6 % so the doodle's reach stays inside the space found for it.
    const q = (t: number) => (dur > 0 ? Math.min(1.06, EASES.spring(prog(t, onset, dur))) : 1);
    const bob = (t: number) => Math.sin((t / 1000) * Math.PI * 1.2 + phase);
    const edges = [onset, onset + dur, onset + dur / 6];
    const baked = (fn: (t: number) => number, tolerance: number) => bake(fn, tolerance, onset, edges);
    const scale = baked((t) => Math.max(0.02, q(t)) * (1 - 0.98 * out(t)), 0.003);
    const track: Track = {
      x: [[onset, spotX]], y: baked((t) => spotY + bob(t) * 6 * u, 0.2), sx: scale, sy: scale,
      rz: baked((t) => angle * (0.4 + 0.6 * q(t)) + bob(t) * 4, 0.12), o: fade(onset),
    };
    const parts = doodleParts(kind, kk, c);
    parts.forEach((part, pi) => {
      if (!part.shadow) return;
      const moved = part.path.map((cmd): PathCmd => (cmd[0] === "Z" ? cmd : cmd[0] === "C" ? ["C", cmd[1] + 5 * kk, cmd[2] + 6 * kk, cmd[3] + 5 * kk, cmd[4] + 6 * kk, cmd[5] + 5 * kk, cmd[6] + 6 * kk] : [cmd[0], cmd[1] + 5 * kk, cmd[2] + 6 * kk]));
      pieces.push({
        ...ctx.shape(`doodle${di}-${pi}s`, onset, moved, track),
        z: 50, toMs: to,
        ...(part.stroke ? { stroke: { widthPx: part.stroke.widthPx, colour: DOODLE_SHADOW } } : { fill: { colour: DOODLE_SHADOW } }),
      });
    });
    parts.forEach((part, pi) => {
      pieces.push({
        ...ctx.shape(`doodle${di}-${pi}`, onset, part.path, track),
        z: 52 + pi, toMs: to,
        ...(part.stroke ? { stroke: { widthPx: part.stroke.widthPx, colour: part.stroke.colour } } : { fill: { colour: part.fill! } }),
      });
    });
  }

  // Washi tape pinned to the leading top corner of the first label (clear of the words; dropped when nothing is clear).
  {
    const row = rows[0]!;
    const holderOf = holderFor(row);
    const hash = rnd(index * 3 + 1, 5);
    // The fixed edge of the growing label: left for a left-to-right cue, right for right-to-left. The strip crosses the corner.
    const angle = -side * (38 + 14 * Math.abs(hash));
    const [lx, ly] = rotatePoint(-side * (row.width / 2 - 6 * u), -row.h / 2 + 2 * u, row.rot);
    let place: Pt | null = null;
    for (let step = 0; step <= 16 && !place; step++) {
      const x = row.cx + lx - side * step * 3.5 * u;
      const y = row.cy + ly - step * 3.5 * u;
      if (inside(x, y, 38 * u) && clear(x, y, 38 * u, 0)) place = [x, y];
    }
    const when = place ? showing(holderOf.lineIn.from + 60, 260) : null;
    if (place && when) {
      const { onset, dur } = when;
      const q = (t: number) => (dur > 0 ? EASES.spring(prog(t, onset, dur)) : 1);
      // The tape rides the label's own spring and exit, so it stays pinned to its corner.
      const back = rotatePoint(place[0] - row.cx, place[1] - row.cy, -row.rot);
      const at = (t: number): Pt => {
        const { s, r } = holderOf.pose(t);
        const [dx, dy2] = rotatePoint(back[0] * s, back[1] * s, r);
        return [row.cx + dx, row.cy + dy2];
      };
      const edges = [onset, onset + dur, holderOf.lineIn.from, holderOf.lineIn.settled];
      const scale = bake((t) => Math.max(0.02, q(t)) * holderOf.pose(t).s, 0.003, onset, edges);
      const track: Track = {
        x: bake((t) => at(t)[0], 0.2, onset, edges), y: bake((t) => at(t)[1], 0.2, onset, edges), sx: scale, sy: scale,
        rz: bake((t) => holderOf.pose(t).r - row.rot + angle * (0.5 + 0.5 * q(t)), 0.12, onset, edges), o: fade(onset),
      };
      const colour = TAPE_COLOURS[(index + (hash > 0 ? 1 : 0)) % TAPE_COLOURS.length]!;
      pieces.push({ ...ctx.shape("tape", onset, polygonPath(TAPE.map(([x, y]): Pt => [x * u, y * u])), track), fill: { colour, alpha: 0.9 }, z: 20, toMs: to });
    }
  }

  // Paper scraps tumbling out of the key label into free space around it.
  {
    const row = anchorRow;
    const base = Math.floor((rnd(index * 11 + anchorLi, 2) * 0.5 + 0.5) * 8);
    let placed = 0;
    for (let n = 0; n < 8 && placed < 4; n++) {
      const angle = (((base + n * 3) % 8) * Math.PI) / 4 + rnd(index + n, 9) * 0.25;
      const margin = (30 + 14 * (rnd(index * 7 + n, 4) * 0.5 + 0.5)) * u;
      const x = row.cx + Math.cos(angle) * (row.width / 2 + margin) * side;
      const y = row.cy + Math.sin(angle) * (row.h / 2 + margin);
      const radius = 20 * u;
      if (!inside(x, y, radius * 1.3) || !clear(x, y, radius * 1.3, 6 * u) || taken.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + radius * 1.3)) continue;
      const when = showing(anchorWord.startMs + 20 + placed * 40, 380);
      if (!when) continue;
      taken.push({ x, y, r: radius * 1.3 });
      const { onset: start, dur } = when;
      const q = (t: number) => (dur > 0 ? EASES.outExpo(prog(t, start, dur)) : 1);
      const turn = (rnd(index * 13 + n, 6) > 0 ? 1 : -1) * (180 + 120 * Math.abs(rnd(index + n * 5, 8)));
      const edges = [start, start + dur];
      const fromX = row.cx;
      const fromY = row.cy;
      const scale = bake((t) => (0.4 + 0.6 * q(t)) * (1 - 0.98 * out(t)), 0.003, start, edges);
      const track: Track = {
        x: bake((t) => lerp(fromX, x, q(t)), 0.2, start, edges), y: bake((t) => lerp(fromY, y, q(t)), 0.2, start, edges), sx: scale, sy: scale,
        rz: bake((t) => turn * (1 - q(t)) + 30 * n, 0.12, start, edges), o: fade(start),
      };
      const colour = [c.primary, c.highlight, c.accent, LIME][(index + n) % 4]!;
      pieces.push({ ...ctx.shape(`scrap${placed}`, start, scrapPath(n, radius), track, colour), z: 18, toMs: to });
      placed++;
    }
  }

  return pieces;
});
