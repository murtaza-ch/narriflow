import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import { type PathCmd, type Piece, type ShapePiece, type TextPiece, type Track, pieceBounds } from "../scene";

/**
 * Hype (`samples/templates/m08-sticker.js`, after Motion Array "Really Big Deal Titles"): loud condensed italic caps set like a
 * sticker, the whole block tilted and gently rocking. Every word is cream with a dark outline and a long solid extrusion down
 * and to the right and slaps on from 135 % with a spring; the key word lands letter by letter in a scattered order in green,
 * yellow or red with a deeper extrusion, and four-point sparkles blink around it again and again.
 *
 * Geometry is the sample's: Barlow Condensed Black Italic capitals, 148 px (key word 256 px, a lone word 170 px), 0.005 em
 * letter spacing, `line-height: 0.9` boxes with the baseline 0.85 em down, 29.6 px between words, rows centred, -6 px (-22 px
 * for a row with the key word) between rows, the block centred on y 1290, tilted about -7.5 degrees; the outline is the
 * outside half of a 0.05 em stroke and the extrusion is copies stepped `0.0115 em` down and `0.8` of that right.
 *
 * What changed from the sample, and why (gallery-2 brief, 2026-11-21):
 *  - The sample's `lines` / `breaks` are tables for five demo cues. Rows come from the words: the key word is its own row, the
 *    words before and after wrap into body rows (one row when 0.8 of their width fits, as "okay this is"), a single short word
 *    before or after it shares its row when that fits ("for REAL"), and a cue with no key word and three or more words takes
 *    two even rows. Every row is fitted to the safe area with the tilt, the rock and the extrusion counted, a single long word
 *    shrinks with no floor, and a stack too tall for the frame (16:9) shrinks as a whole.
 *  - Extrusion: 9 offset copies per word and 14 per key-word letter are 3 and 5 `shadows` of the same piece (steps 9, 6, 3 and
 *    14, 11, 8, 5, 2 of the sample's), spaced so that the outline's band closes every gap: the edge is the sample's to the eye.
 *  - Recurring decoration, by counters (never the cue index): the key-word fill cycles green, yellow, red by key-word cue; a cue
 *    with no key word gets two sparkles on opposite corners of its last word (the pair alternates and mirrors), so every cue
 *    sparkles; sparkle spots mirror on alternate cues and hang off the key word's own box, are jittered by a seeded hash of the
 *    cue's index and text and are clamped into the safe area (the sample's spot at 1.1 of the width could pass x 1000). The
 *    tilt cycles -7.5, -5.5, -9, -6.5 degrees with a small hash jitter and the entrance turn alternates -5 / +5 degrees.
 *  - Sparkles twinkle every 1150 ms for the whole hold (one small piece per twinkle, only while visible), so long holds keep
 *    their life; the rock (+/-1.4 degrees, 2.6 s) and the rows' drift (+/-5 px, 1.9 s) run on every piece as in the sample.
 *  - The sample's `sort(() => r() - 0.5)` for the letters' order is a seeded Fisher-Yates.
 *  - Real speech: the exit (150 ms ending 60 ms before the cue's end) never starts before the last word has been visible for
 *    220 ms and never runs more than 60 ms into the next cue; letters' stagger shrinks for a long key word.
 *  - Scripts that need shaping, CJK and right-to-left words are never split into letters (the key word slaps as one piece);
 *    capitals only for cased scripts; right-to-left rows run right to left and sparkle spots mirror. A word's pop never takes
 *    it out of the safe area: the 135 % start scale is reduced for words at the edge.
 */

export const HYPE_DEMO: DemoScript = {
  lines: [
    "okay:b this:m is:m huge:h@560",
    "we:m just:b hit 10K:h@620",
    "subscribers",
    "thank:b you:m so:m much",
    "for:m real:h@600",
  ],
  options: { rate: 280, cueGap: 150, tail: 820 },
};

const FACE = "Barlow Condensed Black Italic" as const;
const BODY = 148;
const HERO = 256;
const LONE = BODY * 1.15;
const LS = 0.005;
const GAP = BODY * 0.2;
const CY = 1290;
const MAX_ROW = 900;
const BASELINE_EM = 0.85;
const LINE_EM = 0.9;
const INK = "#1E1411";
const RED = "#FF4651";
const SPARKLE = "#FFFFFF";
const STROKE_EM = 0.025;
const STEP_EM = 0.0115;
/** Extrusion copies drawn, deepest first (the sample's `i` of 9 and 14). */
export const HYPE_BODY_STEPS: readonly number[] = [9, 5, 2];
export const HYPE_HERO_STEPS: readonly number[] = [14, 10, 6, 2];
const TILTS = [-7.5, -5.5, -9, -6.5] as const;
const ROCK_DEG = 1.4;
const ROCK_MS = 2600;
const DRIFT_PX = 5;
const DRIFT_MS = 1900;
const BODY_POP = 220;
const HERO_POP = 170;
const POP_FROM = 1.35;
const EXIT_MS = 150;
const EXIT_MIN_MS = 70;
const EXIT_END_MS = 60;
const HOLD_MS = 220;
const OVERLAP_MS = 60;
const MAX_LETTERS = 12;
const TWINKLE_PERIOD = 1150;
const TWINKLE_MS = 360;
const SPARKLE_STROKE = 1.6 * 4.6;
/** Pieces one cue may draw, with shadow layers counted, kept under the engine's 150. */
const BUDGET = 144;

/** FNV-1a, 32 bit: the seed of a cue's jitter (never `Math.random`). */
export function hypeHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The sample's seeded generator (mulberry32). */
export function hypeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASED = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{P}\p{S}\p{M}\s]+$/u;
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{P}\p{S}]+$/u;

/** `text-transform: uppercase`, for the scripts that have case only. */
export const hypeDisplay = (text: string): string => (CASED.test(text) ? text.toUpperCase() : text);

/** A key word's letters, or null when it must slap on as one word (shaped scripts, CJK, very long words). */
export function hypeLetters(text: string): string[] | null {
  if (!SPLITTABLE.test(text)) return null;
  const letters = typeof Intl !== "undefined" && "Segmenter" in Intl ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment) : [...text];
  return letters.length >= 1 && letters.length <= MAX_LETTERS ? letters : null;
}

/** The sample's four-point sparkle (`M0,-9 C0.9,-1.8 ...` in a -10..10 box), scaled by `scale`, drawn from its own top-left. */
export function hypeSparklePath(scale: number): PathCmd[] {
  const p = (x: number, y: number): [number, number] => [(x + 9) * scale, (y + 9) * scale];
  const c = (a: [number, number], b: [number, number], to: [number, number]): PathCmd => ["C", a[0], a[1], b[0], b[1], to[0], to[1]];
  return [
    ["M", ...p(0, -9)],
    c(p(0.9, -1.8), p(1.8, -0.9), p(9, 0)),
    c(p(1.8, 0.9), p(0.9, 1.8), p(0, 9)),
    c(p(-0.9, 1.8), p(-1.8, 0.9), p(-9, 0)),
    c(p(-1.8, -0.9), p(-0.9, -1.8), p(0, -9)),
    ["Z"],
  ];
}

interface Item {
  readonly index: number;
  readonly hero: boolean;
  readonly base: number;
  readonly text: string;
  readonly letters: string[] | null;
}

interface RowPlan {
  readonly items: Item[];
  readonly hero: boolean;
}

interface ItemGeo {
  readonly item: Item;
  /** Sample px. */
  readonly size: number;
  readonly left: number;
  readonly width: number;
  readonly letters: { text: string; left: number; width: number }[] | null;
}

interface RowGeo {
  readonly plan: RowPlan;
  readonly items: ItemGeo[];
  readonly width: number;
  readonly height: number;
  readonly bottom: number;
  readonly maxSize: number;
}

function buildCue(cue: SceneCue, cueNumber: number, counters: { hero: number; plain: number }, input: SceneInput): Piece[] {
  const space = sceneSpace(input, CY);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const seed = hypeHash(`${cue.index}|${cue.words.map((word) => word.text).join(" ")}`);
  const rng = hypeRng(seed);
  const hasHero = cue.words.some((word) => word.role === "hero");
  const heroCounter = hasHero ? counters.hero++ : 0;
  const plainCounter = hasHero ? 0 : counters.plain++;
  const fills = [input.colours.highlight, input.colours.accent, RED];
  const heroFill = fills[(hasHero ? heroCounter : plainCounter) % fills.length]!;
  const lone = cue.words.length === 1 && !hasHero;
  const band = cueNumber * 4;
  const phase = rng() * Math.PI * 2;
  const theta0 = TILTS[cueNumber % TILTS.length]! + (rng() - 0.5) * 0.8;
  const mirror = (heroCounter + plainCounter) % 2 === 1;

  const items: Item[] = cue.words.map((word, index) => {
    const hero = word.role === "hero";
    const text = hypeDisplay(word.text);
    return { index, hero, base: hero ? HERO : lone ? LONE : BODY, text, letters: hero ? hypeLetters(text) : null };
  });
  const advance = (text: string, size: number) => input.measure(text, FACE, size * u, LS).advance + LS * size * u;
  const itemWidth = (item: Item, size: number) => (item.letters ? item.letters.reduce((sum, letter) => sum + advance(letter, size), 0) : advance(item.text, size)) / u;

  // --- rows ---
  const limit = Math.min(MAX_ROW, (space.safe.x2 - space.safe.x1) / u - 90);
  const widthsOf = (list: readonly Item[]) => list.map((item) => itemWidth(item, item.base));
  const splitInTwo = (widths: readonly number[]): number[][] => {
    let best = 1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let cut = 1; cut < widths.length; cut++) {
      const a = rowWidth(widths, widths.slice(0, cut).map((_, at) => at), GAP);
      const b = rowWidth(widths, widths.slice(cut).map((_, at) => cut + at), GAP);
      if (a * a + b * b < bestCost) {
        bestCost = a * a + b * b;
        best = cut;
      }
    }
    return [widths.slice(0, best).map((_, at) => at), widths.slice(best).map((_, at) => best + at)];
  };
  const segments: Item[][] = [];
  for (const item of items) {
    const last = segments[segments.length - 1];
    if (last && last[0]!.hero === item.hero) last.push(item);
    else segments.push([item]);
  }
  let plans: RowPlan[] = [];
  for (const segment of segments) {
    const widths = widthsOf(segment);
    let rows = balancedRows(widths, GAP, limit);
    if (hasHero && !segment[0]!.hero && rows.length > 1 && rowWidth(widths, widths.map((_, at) => at), GAP) * 0.8 <= limit) rows = [widths.map((_, at) => at)];
    if (!hasHero && rows.length === 1 && widths.length >= 3) rows = splitInTwo(widths);
    for (const row of rows) plans.push({ items: row.map((at) => segment[at]!), hero: segment[0]!.hero });
  }
  // A single word before or after a single key-word row shares its row when that fits ("for REAL").
  const heroRows = plans.filter((plan) => plan.hero);
  if (hasHero && heroRows.length === 1) {
    const at = plans.indexOf(heroRows[0]!);
    const mergedWidth = (rows: RowPlan[]) => rowWidth(widthsOf(rows.flatMap((row) => row.items)), rows.flatMap((row) => row.items).map((_, i) => i), GAP);
    const before = plans[at - 1];
    if (before && before.items.length === 1 && mergedWidth([before, plans[at]!]) <= limit) {
      plans = [...plans.slice(0, at - 1), { items: [...before.items, ...plans[at]!.items], hero: true }, ...plans.slice(at + 1)];
    }
    const now = plans.findIndex((plan) => plan.hero);
    const after = plans[now + 1];
    if (after && after.items.length === 1 && mergedWidth([plans[now]!, after]) <= limit) {
      plans = [...plans.slice(0, now), { items: [...plans[now]!.items, ...after.items], hero: true }, ...plans.slice(now + 2)];
    }
  }

  // --- geometry: sample px, the block centred on (540, 1290) before it tilts ---
  const geometry = (k: number, fs: readonly number[]): { rows: RowGeo[]; height: number } => {
    const sized = plans.map((plan, ri) => {
      const m = fs[ri]! * k;
      const gap = GAP * m;
      const order = rowVisualOrder(plan.items.map((item) => item.text), rtl ? "rtl" : "ltr").map((at) => plan.items[at]!);
      const widths = order.map((item) => itemWidth(item, item.base * m));
      const width = widths.reduce((sum, w) => sum + w, 0) + gap * (order.length - 1);
      const maxSize = Math.max(...plan.items.map((item) => item.base * m));
      return { plan, order, widths, width, maxSize, m, gap };
    });
    const margins = sized.map((row, ri) => (ri === 0 ? 0 : (row.plan.hero ? -22 : -6) * k));
    const height = sized.reduce((sum, row, ri) => sum + LINE_EM * row.maxSize + margins[ri]!, 0);
    let top = CY - height / 2;
    const rows = sized.map((row, ri): RowGeo => {
      top += margins[ri]!;
      const bottom = top + LINE_EM * row.maxSize;
      let left = 540 - row.width / 2;
      const geos = row.order.map((item, at): ItemGeo => {
        const size = item.base * row.m;
        let x = left;
        const letters = item.letters
          ? item.letters.map((text) => {
              const w = advance(text, size) / u;
              const letter = { text, left: x, width: w };
              x += w;
              return letter;
            })
          : null;
        const geo: ItemGeo = { item, size, left, width: row.widths[at]!, letters };
        left += row.widths[at]! + row.gap;
        return geo;
      });
      top = bottom;
      return { plan: row.plan, items: geos, width: row.width, height: LINE_EM * row.maxSize, bottom, maxSize: row.maxSize };
    });
    return { rows, height };
  };

  // Fit: every row's rotated extent (rock and drift counted) inside the safe width, the stack inside the safe height.
  const px0 = space.x(540);
  const py0 = space.y(CY);
  const xLo = (space.safe.x1 - px0) / u + 2;
  const xHi = (space.safe.x2 - px0) / u - 2;
  const yLo = (space.safe.y1 - py0) / u + 2;
  const yHi = (space.safe.y2 - py0) / u - 2;
  const angles = [theta0 - ROCK_DEG, theta0 + ROCK_DEG].map((deg) => (deg * Math.PI) / 180);
  const extent = (x1: number, x2: number, y1: number, y2: number) => {
    let ax1 = Number.POSITIVE_INFINITY;
    let ax2 = Number.NEGATIVE_INFINITY;
    let ay1 = Number.POSITIVE_INFINITY;
    let ay2 = Number.NEGATIVE_INFINITY;
    for (const a of angles) {
      for (const [x, y] of [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] as const) {
        const rx = x * Math.cos(a) - y * Math.sin(a);
        const ry = x * Math.sin(a) + y * Math.cos(a);
        ax1 = Math.min(ax1, rx);
        ax2 = Math.max(ax2, rx);
        ay1 = Math.min(ay1, ry);
        ay2 = Math.max(ay2, ry);
      }
    }
    return { x1: ax1, x2: ax2, y1: ay1, y2: ay2 };
  };
  let k = 1;
  const fs = plans.map(() => 1);
  const rowExtent = (row: RowGeo) => {
    const padL = 0.04 * row.maxSize;
    const padR = (row.plan.hero ? 0.16 : 0.12) * row.maxSize;
    return extent(-row.width / 2 - padL - DRIFT_PX, row.width / 2 + padR + DRIFT_PX, row.bottom - row.height - CY, row.bottom + 0.1 * row.maxSize - CY);
  };
  const rowFits = (row: RowGeo) => {
    const e = rowExtent(row);
    return e.x2 <= xHi && e.x1 >= xLo;
  };
  let rows = geometry(k, fs).rows;
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let ri = 0; ri < plans.length; ri++) {
      if (rowFits(rows[ri]!)) continue;
      // Shrink this row until it fits: the tilt moves it sideways by a fixed amount, so bisect rather than scale.
      let lo = 0.15;
      let hi = fs[ri]!;
      for (let tries = 0; tries < 14; tries++) {
        const mid = (lo + hi) / 2;
        const trial = fs.slice();
        trial[ri] = mid;
        if (rowFits(geometry(k, trial).rows[ri]!)) lo = mid;
        else hi = mid;
      }
      fs[ri] = lo;
      rows = geometry(k, fs).rows;
      changed = true;
    }
    const stackFits = (list: RowGeo[]) => {
      const top = Math.min(...list.map((row) => row.bottom - row.height)) - CY;
      const bottom = Math.max(...list.map((row) => row.bottom + 0.1 * row.maxSize)) - CY;
      const half = Math.max(...list.map((row) => row.width)) / 2;
      const stack = extent(-half, half, top - 0.02 * HERO, bottom + 0.07 * HERO);
      return stack.y1 >= yLo && stack.y2 <= yHi;
    };
    if (!stackFits(rows)) {
      // A stack too tall for the frame (16:9) shrinks as a whole.
      let lo = 0.3;
      let hi = k;
      for (let tries = 0; tries < 14; tries++) {
        const mid = (lo + hi) / 2;
        if (stackFits(geometry(mid, fs).rows)) lo = mid;
        else hi = mid;
      }
      k = lo;
      rows = geometry(k, fs).rows;
      changed = true;
    }
    if (!changed) break;
  }

  // --- exit ---
  const wordFrom = (geo: ItemGeo, letterAt = 0, stagger = 0) => (geo.item.hero ? cue.words[geo.item.index]!.startMs - 70 + letterAt * stagger : cue.words[geo.item.index]!.startMs - 50);
  const allGeos = rows.flatMap((row) => row.items);
  const lastFrom = Math.max(...allGeos.map((geo) => wordFrom(geo, geo.letters ? geo.letters.length - 1 : 0, geo.letters ? Math.min(32, 200 / geo.letters.length) : 0)));
  const exitStart = Math.min(Math.max(cue.endMs - EXIT_END_MS - EXIT_MS, lastFrom + HOLD_MS), cue.endMs + OVERLAP_MS - EXIT_MIN_MS);
  const exitMs = clamp(cue.endMs - EXIT_END_MS - exitStart, EXIT_MIN_MS, EXIT_MS);
  const exitEnd = exitStart + exitMs;
  const out = (t: number) => EASES.in(prog(t, exitStart, exitMs));
  const opacity: Frames = [[exitStart, 1], [exitEnd, 0, "in"]];

  // --- the block's pose: tilt and rock about (540, 1290), rows drifting in the block's own frame ---
  const tiltAt = (t: number) => theta0 + ROCK_DEG * Math.sin((t / ROCK_MS) * Math.PI * 2 + phase);
  const pointAt = (ri: number, sx: number, sy: number, t: number) => {
    const e = out(t);
    const kk = 1 - 0.12 * e;
    const a = (tiltAt(t) * Math.PI) / 180;
    const vx = (sx + DRIFT_PX * Math.sin((t / DRIFT_MS) * Math.PI * 2 + phase + ri * 1.9) - 540) * u;
    const vy = (sy - CY) * u;
    return { x: px0 + kk * (vx * Math.cos(a) - vy * Math.sin(a)), y: py0 + kk * (vx * Math.sin(a) + vy * Math.cos(a)), k: kk };
  };

  const pieces: Piece[] = [];
  let used = 0;
  const heroItemRows: { ri: number; geo: ItemGeo }[] = [];

  const makeWord = (id: string, text: string, ri: number, geo: ItemGeo, left: number, width: number, fill: string, steps: readonly number[], from: number, popMs: number, turn: number): void => {
    const row = rows[ri]!;
    const size = geo.size;
    const sizeC = size * u;
    const cx = left + width / 2;
    const cyS = row.bottom - 0.5 * LINE_EM * size;
    const baseline = row.bottom - (LINE_EM - BASELINE_EM) * size;
    const popEnd = from + popMs;
    const to = Math.max(exitEnd, from + 2);
    const step = STEP_EM * sizeC;
    const build = (s0: number): TextPiece => {
      const own = (t: number) => {
        const p = prog(t, from, popMs);
        return { s: lerp(s0, 1, EASES.spring(p)), rot: turn * (1 - EASES.outExpo(p)) };
      };
      const channel = (pick: (pose: { x: number; y: number; rz: number; s: number }) => number, tolerance: number) =>
        sampleFrames(
          (t) => {
            const at = pointAt(ri, cx, cyS, t);
            const o = own(t);
            return pick({ x: at.x, y: at.y, rz: tiltAt(t) + o.rot, s: at.k * o.s });
          },
          [from, popEnd, exitStart, exitEnd],
          tolerance,
          { range: [from, to], wholeMs: true, simplify: true },
        );
      const scale = channel((pose) => pose.s, 0.003);
      const track: Track = { x: channel((pose) => pose.x, 0.3), y: channel((pose) => pose.y, 0.3), rz: channel((pose) => pose.rz, 0.1), sx: scale, sy: scale, o: opacity };
      return {
        id: `hype:${cueNumber}:${id}`,
        kind: "text",
        z: band + 1,
        fromMs: from,
        toMs: to,
        track,
        origin: { dx: (width / 2) * u, dy: (cyS - baseline) * u },
        text,
        face: FACE,
        sizePx: sizeC,
        letterSpacingEm: LS,
        fill,
        stroke: { widthPx: STROKE_EM * sizeC, colour: INK },
        shadows: steps.map((i) => ({ dx: i * step * 0.8, dy: i * step, blur: 0, colour: INK, alpha: 1 })),
        anchor: "baseline-left",
        language: cue.language,
      } satisfies TextPiece;
    };
    // The 135 % start scale is reduced until the pop stays inside the safe area (a word at the edge of a full row).
    const overflow = (candidate: TextPiece) => {
      let over = 0;
      for (let t = from; t <= popEnd; t += 16) {
        const box = pieceBounds(candidate, t, input.measure);
        if (box) over = Math.max(over, space.safe.x1 - box.x1, box.x2 - space.safe.x2, space.safe.y1 - box.y1, box.y2 - space.safe.y2);
      }
      return over;
    };
    let piece = build(POP_FROM);
    if (overflow(piece) > 0) {
      let lo = 1;
      let hi = POP_FROM;
      for (let tries = 0; tries < 6; tries++) {
        const mid = (lo + hi) / 2;
        if (overflow(build(mid)) > 0) hi = mid;
        else lo = mid;
      }
      piece = build(lo);
    }
    used += 1 + steps.length;
    pieces.push(piece);
  };

  rows.forEach((row, ri) => {
    for (const geo of row.items) {
      const word = cue.words[geo.item.index]!;
      if (!geo.item.hero) {
        makeWord(`w${geo.item.index}`, geo.item.text, ri, geo, geo.left, geo.width, input.colours.primary, HYPE_BODY_STEPS, word.startMs - 50, BODY_POP, (geo.item.index + cueNumber) % 2 === 0 ? -5 : 5);
        continue;
      }
      heroItemRows.push({ ri, geo });
      if (!geo.letters) {
        makeWord(`w${geo.item.index}`, geo.item.text, ri, geo, geo.left, geo.width, heroFill, HYPE_HERO_STEPS, word.startMs - 70, 200, 0);
        continue;
      }
      // Letters land out of order (a seeded Fisher-Yates), 32 ms apart, each from 135 %.
      const n = geo.letters.length;
      const order = Array.from({ length: n }, (_, at) => at);
      for (let at = n - 1; at > 0; at--) {
        const j = Math.floor(rng() * (at + 1));
        [order[at], order[j]] = [order[j]!, order[at]!];
      }
      const stagger = Math.min(32, 200 / n);
      geo.letters.forEach((letter, li) => {
        makeWord(`w${geo.item.index}l${li}`, letter.text, ri, geo, letter.left, letter.width, heroFill, HYPE_HERO_STEPS, word.startMs - 70 + order.indexOf(li) * stagger, HERO_POP, 0);
      });
    }
  });

  // --- sparkles: four around the key word (two on the last word of a cue without one), twinkling every 1150 ms ---
  let anchor: { ri: number; geo: ItemGeo } | null = heroItemRows[heroItemRows.length - 1] ?? null;
  if (!anchor) {
    let best: { ri: number; geo: ItemGeo } | null = null;
    rows.forEach((row, ri) => {
      for (const geo of row.items) if (!best || geo.item.index > best.geo.item.index) best = { ri, geo };
    });
    anchor = best;
  }
  if (anchor) {
    const { ri, geo } = anchor;
    const row = rows[ri]!;
    const hw = geo.width;
    const hh = LINE_EM * geo.size;
    const top = row.bottom - hh;
    const shared = row.items.length > 1;
    const spots: (readonly [number, number])[] = hasHero
      ? [shared ? [0.04, -0.12] : [-0.16, 0.5], [1.1, 0.3], [0.92, 1.12], [0.08, 1.02]]
      : plainCounter % 2 === 0
        ? [[1.1, 0.3], [0.08, 1.02]]
        : [[0.04, -0.12], [0.92, 1.12]];
    const flip = rtl !== mirror;
    const heroStart = cue.words[geo.item.index]!.startMs;
    const perSparkle = clamp(Math.floor((BUDGET - used) / spots.length), 0, 8);
    spots.forEach(([fx0, fy], si) => {
      const fx = flip ? 1 - fx0 : fx0;
      const sizeK = 0.8 + rng() * 0.45;
      const spin = (rng() - 0.5) * 40;
      const jx = (rng() - 0.5) * 30;
      const jy = (rng() - 0.5) * 30;
      const start = Math.min(heroStart + 140 + si * 170 + rng() * 80, exitEnd - 220);
      const sc = 4.6 * sizeK * u;
      const R = 9 * sc;
      const reach = R + SPARKLE_STROKE * sizeK * u + 14 * u;
      const sx = geo.left + fx * hw + jx;
      const sy = top + fy * hh + jy;
      const fill = si % 2 === 1 ? SPARKLE : heroFill;
      for (let n = 0; n < perSparkle; n++) {
        const at = start + n * TWINKLE_PERIOD;
        if (at + 120 > exitEnd) break;
        const from = Math.round(at) + 4;
        const to = Math.round(Math.min(at + TWINKLE_MS, exitEnd));
        if (to <= from + 20) break;
        const place = (t: number) => {
          const p = pointAt(ri, sx, sy, t);
          return { x: clamp(p.x, space.safe.x1 + reach, space.safe.x2 - reach), y: clamp(p.y, space.safe.y1 + reach, space.safe.y2 - reach) };
        };
        const mid = Math.round((from + to) / 2);
        const grow = Math.round(at + 0.35 * TWINKLE_MS);
        const piece: ShapePiece = {
          id: `hype:${cueNumber}:sp${si}t${n}`,
          kind: "shape",
          z: band + 2,
          fromMs: from,
          toMs: to,
          track: {
            x: [[from, place(from).x], [mid, place(mid).x], [to, place(to).x]],
            y: [[from, place(from).y], [mid, place(mid).y], [to, place(to).y]],
            rz: [[from, tiltAt(from)], [to, tiltAt(to) + spin]],
            sx: [[from, 0.12], [Math.min(grow, to - 1), 1, "outBack"], [to, 0.02, "in"]],
            sy: [[from, 0.12], [Math.min(grow, to - 1), 1, "outBack"], [to, 0.02, "in"]],
            o: opacity,
          },
          origin: { dx: R, dy: R },
          path: hypeSparklePath(sc),
          fill: { colour: fill },
          stroke: { widthPx: SPARKLE_STROKE * sizeK * u, colour: INK },
        };
        pieces.push(piece);
      }
    });
  }

  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const hypeProgram: SceneProgram = {
  build(input) {
    const counters = { hero: 0, plain: 0 };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, counters, input))) };
  },
};
