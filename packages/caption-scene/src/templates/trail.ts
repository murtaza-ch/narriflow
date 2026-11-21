import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, kf, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { Clip, PathCmd, Piece, ShapePiece, TextPiece, Track } from "../scene";
import { ellipsePath, roundedRectPath } from "../shapes";

/**
 * Trail (`samples/templates/m17-trail.js`, after Motion Array "Fun Colorful Intro"): toon-pop rounded caps, white with a navy
 * keyline, standing on a stack of three colour copies. The copies follow the word a few frames late, so every entrance stretches
 * the stack into a tall rainbow trail that snaps back into a neat 3D block when the word lands. The key word punches in letter by
 * letter with a bigger bounce, swaps to a warm stack and keeps a slow wave the copies chase.
 *
 * Geometry is the sample's: Lilita One capitals, 116 px (key word 184 px), 0.01 em letter spacing, `line-height: 1` boxes with the
 * baseline 0.8515 em down, 0.2 em between words, -0.06 em between rows, rows centred, the block centred on y 1270. A word is drawn
 * four times, three copies (yellow, mint, blue; the key word's yellow, red, purple) and the white face on top; the keyline is the
 * outside half of a 0.085 em stroke (the sample's centred stroke is painted under the fill). Copy `k` takes the face's height from
 * `k * 38` ms ago (58 for the key word) and rests `0.068 em` (0.062) lower per step.
 *
 * What changed from the sample, and why (gallery-3 brief, 2026-11-21):
 *  - The sample's `lines` / `breaks` and its " / " row splits are tables for five demo cues, and a row holding the key word draws
 *    every word of it at 184 px. Rows come from the words: a run of key words is a row of 184 px letters, the runs of other words
 *    before and after it wrap evenly into 116 px rows (the same rows as the sample's for its five cues), and a row that cannot fit
 *    the safe area (the sample's fixed 900 px column never shrinks) shrinks, the whole stack too when the frame is short (16:9).
 *  - Recurring decoration, in the sample's own colours and keyline, every cue and never indexed by the cue number: (1) a triplet of
 *    rainbow stripes wiping in above the first row (left edge, right edge or from the middle, by a per-cue-type counter; lengths
 *    and the colour order rotate), (2) a landing bar under the last row (a navy bar with a yellow edge, a colour pill, or three
 *    popping dots), (3) a fan of pop ticks flung off the key word's top corners as it punches (the last word of a cue without one).
 *    A seeded hash of the cue's index and text jitters lengths and angles; nothing uses `Math.random`.
 *  - Real speech: the exit (170 ms, ending 60 ms before the cue's end) never starts before the last word has had 300 ms to land and
 *    never runs more than 60 ms into the next cue, so a word is never cut while it rises (the sample starts it at `end - 230`).
 *  - The key word's letter stagger (30 ms) shrinks for a long word; scripts that need shaping, CJK and right-to-left words are
 *    never split into letters (the key word punches in as one word), capitals apply only to cased scripts, right-to-left rows run
 *    right to left and the stripes, bar and ticks mirror. Words wider than the frame shrink with no floor.
 *  - Colours: the face is `primary`, the nearest copy `highlight`, the key word's red copy `accent`; mint, blue and purple are the
 *    template's own.
 */

export const TRAIL_DEMO: DemoScript = {
  lines: [
    "so:m I:m tried:b this:b trick",
    "and:m it:m actually:b worked:h@600",
    "my:m sales:b doubled",
    "in:m one:b week:h@620",
    "no:m joke",
  ],
  options: { rate: 280, cueGap: 150, tail: 780 },
};

const FACE = "Lilita One" as const;
const BODY = 116;
const HERO = 184;
const LS = 0.01;
const GAP_EM = 0.2;
const MARGIN_EM = -0.06;
const CY = 1270;
const MAX_ROW = 900;
const BASELINE_EM = 0.8515;
const CAP_EM = 0.701;
export const TRAIL_KEYLINE = "#1D2152";
const MINT = "#7DF58A";
const BLUE = "#5BB8F0";
const PURPLE = "#7A3CE6";
const WHITE = "#FFFFFF";
/** The visible keyline: the outside half of the sample's 0.085 em centred stroke. */
const STROKE_EM = 0.0425;
const LAG = 38;
const HERO_LAG = 58;
const REST_BODY = 0.068;
const REST_HERO = 0.062;
const DROP_BODY = 110;
const DROP_HERO = 115;
const WAVE_PX = 12;
const WAVE_MS = 1500;
const ENTER_LEAD = 60;
const LETTER_STAGGER = 30;
const LETTER_STAGGER_TOTAL = 240;
const MAX_LETTERS = 12;
const EXIT_MS = 170;
const EXIT_MIN_MS = 70;
const EXIT_END_MS = 60;
const HOLD_MS = 300;
const OVERLAP_MS = 60;
const LIFT_PX = 60;
const BUDGET = 140;

/** FNV-1a, 32 bit: the seed of a cue's jitter (never `Math.random`). */
export function trailHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The sample's seeded generator (mulberry32). */
export function trailRng(seed: number): () => number {
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
export const trailDisplay = (text: string): string => (CASED.test(text) ? text.toUpperCase() : text);

/** A key word's letters, or null when it must punch in as one word (shaped scripts, CJK, very long words). */
export function trailLetters(text: string): string[] | null {
  if (!SPLITTABLE.test(text)) return null;
  const letters = typeof Intl !== "undefined" && "Segmenter" in Intl ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment) : [...text];
  return letters.length >= 1 && letters.length <= MAX_LETTERS ? letters : null;
}

/** The sample's `ease.outBack(p, s)`: the shared one has the fixed 1.70158 overshoot. */
const outBack = (p: number, s: number) => 1 + (s + 1) * (p - 1) ** 3 + s * (p - 1) ** 2;

const HERO_SCALE: Frames = [
  [0, 0],
  [150, 1.4, "out"],
  [290, 0.9, "inOut"],
  [430, 1.04, "inOut"],
  [540, 1, "inOut"],
];

/** The face's scale `tau` ms after its start (the sample's `poseAt`). */
export function trailScale(hero: boolean, tau: number): number {
  const t = Math.max(0, tau);
  return hero ? kf(t, HERO_SCALE) : lerp(0.3, 1, outBack(prog(t, 0, 300), 2.2));
}

/** The face's rise, sample px below rest, `tau` ms after its start; `time` and `letter` drive the key word's wave. */
export function trailRise(hero: boolean, tau: number, time = 0, letter = 0): number {
  const t = Math.max(0, tau);
  if (!hero) return (1 - EASES.outExpo(prog(t, 0, 380))) * DROP_BODY;
  const settle = prog(t, 450, 400);
  return (1 - EASES.outExpo(prog(t, 0, 420))) * DROP_HERO + settle * WAVE_PX * Math.sin((time / WAVE_MS) * Math.PI * 2 - letter * 0.7);
}

interface Item {
  readonly index: number;
  readonly hero: boolean;
  readonly text: string;
  readonly letters: string[] | null;
}

interface RowPlan {
  readonly items: Item[];
  readonly hero: boolean;
}

interface Unit {
  readonly item: Item;
  readonly letter: number;
  readonly text: string;
  readonly left: number;
  readonly width: number;
  readonly begin: number;
  readonly size: number;
}

interface RowGeo {
  readonly plan: RowPlan;
  readonly size: number;
  readonly top: number;
  readonly baseline: number;
  readonly width: number;
  readonly left: number;
  readonly units: Unit[];
  /** Each item's left and right edge (sample px), in the order of `plan.items`. */
  readonly spans: { left: number; right: number }[];
}

const pillPath = (length: number, thickness: number): PathCmd[] => roundedRectPath(0, 0, length, thickness, thickness / 2);

function buildCue(cue: SceneCue, cueNumber: number, counters: { hero: number; plain: number }, input: SceneInput): Piece[] {
  const space = sceneSpace(input, CY);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const hasHero = cue.words.some((word) => word.role === "hero");
  const counter = hasHero ? counters.hero++ : counters.plain++;
  const rng = trailRng(trailHash(`${cue.index}|${cue.words.map((word) => word.text).join(" ")}`));
  const band = cueNumber * 48;
  const { highlight, accent, primary } = input.colours;
  const bodyStack = [highlight, MINT, BLUE];
  const heroStack = [highlight, accent, PURPLE];

  const items: Item[] = cue.words.map((word, index) => {
    const hero = word.role === "hero";
    const text = trailDisplay(word.text);
    return { index, hero, text, letters: hero ? trailLetters(text) : null };
  });
  const advance = (text: string, size: number) => input.measure(text, FACE, size * u, LS).advance / u + LS * size;
  const itemWidth = (item: Item, size: number) => (item.letters ? item.letters.reduce((sum, letter) => sum + advance(letter, size), 0) : advance(item.text, size));
  const indices = (n: number, from = 0) => Array.from({ length: n }, (_, at) => from + at);

  // --- rows: runs of key words and runs of other words; the latter wrap evenly ---
  const halfLimit = (space.safe.x2 - space.safe.x1) / (2 * u) - 2;
  const limit = Math.min(MAX_ROW, 2 * halfLimit - 60);
  const segments: Item[][] = [];
  for (const item of items) {
    const last = segments[segments.length - 1];
    if (last && last[0]!.hero === item.hero) last.push(item);
    else segments.push([item]);
  }
  const plans: RowPlan[] = [];
  for (const segment of segments) {
    const base = segment[0]!.hero ? HERO : BODY;
    const widths = segment.map((item) => itemWidth(item, base));
    for (const row of balancedRows(widths, GAP_EM * base, limit)) plans.push({ items: row.map((at) => segment[at]!), hero: segment[0]!.hero });
  }

  // The row's own fit: its ink (the key word's 1.4x punch, the body words' bounce, the keyline) inside the safe width.
  const rowFit = plans.map((plan) => {
    const base = plan.hero ? HERO : BODY;
    const widths = plan.items.map((item) => itemWidth(item, base));
    const width = rowWidth(widths, indices(widths.length), GAP_EM * base);
    const edge = (item: Item) => (item.letters ? advance(item.letters[0]!, base) : widths[plan.items.indexOf(item)]!);
    const pad = plan.hero
      ? 0.2 * Math.max(edge(plan.items[0]!), edge(plan.items[plan.items.length - 1]!)) + 0.06 * base
      : 0.056 * Math.max(edge(plan.items[0]!), edge(plan.items[plan.items.length - 1]!)) + 0.048 * base;
    return Math.min(1, (2 * halfLimit) / (width + 2 * pad));
  });

  const wordBegin = (item: Item) => cue.words[item.index]!.startMs - ENTER_LEAD;
  const stagger = (letters: number) => Math.min(LETTER_STAGGER, LETTER_STAGGER_TOTAL / Math.max(1, letters));

  // --- geometry, sample px, the block centred on (540, 1270) ---
  const geometry = (k: number): { rows: RowGeo[]; height: number } => {
    const sized = plans.map((plan, ri) => {
      const size = (plan.hero ? HERO : BODY) * rowFit[ri]! * k;
      const gap = GAP_EM * size;
      const order = rowVisualOrder(plan.items.map((item) => item.text), rtl ? "rtl" : "ltr").map((at) => plan.items[at]!);
      const widths = order.map((item) => itemWidth(item, size));
      return { plan, size, gap, order, widths, width: widths.reduce((sum, w) => sum + w, 0) + gap * (order.length - 1) };
    });
    const margins = sized.map((row, ri) => (ri === 0 ? 0 : MARGIN_EM * row.size));
    const height = sized.reduce((sum, row, ri) => sum + row.size + margins[ri]!, 0);
    let top = CY - height / 2;
    const rows = sized.map((row, ri): RowGeo => {
      top += margins[ri]!;
      const rowTop = top;
      top += row.size;
      const left0 = 540 - row.width / 2;
      let left = left0;
      const units: Unit[] = [];
      const spans = new Array<{ left: number; right: number }>(row.plan.items.length);
      row.order.forEach((item, at) => {
        const itemLeft = left;
        if (item.letters) {
          let x = left;
          const n = item.letters.length;
          item.letters.forEach((text, letter) => {
            const w = advance(text, row.size);
            units.push({ item, letter, text, left: x, width: w, begin: wordBegin(item) + letter * stagger(n), size: row.size });
            x += w;
          });
        } else units.push({ item, letter: 0, text: item.text, left, width: row.widths[at]!, begin: wordBegin(item), size: row.size });
        left += row.widths[at]!;
        spans[row.plan.items.indexOf(item)] = { left: itemLeft, right: left };
        left += row.gap;
      });
      return { plan: row.plan, size: row.size, top: rowTop, baseline: rowTop + BASELINE_EM * row.size, width: row.width, left: left0, units, spans };
    });
    return { rows, height };
  };

  // A stack too tall for the frame (16:9) shrinks as a whole: the stripes above, the bar and the entrance's rise below counted.
  const safeHeight = (space.safe.y2 - space.safe.y1) / u - 6;
  const extent = (k: number) => {
    const { rows, height } = geometry(k);
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    return height + 0.55 * first.size + Math.max(0.55 * last.size, (last.plan.hero ? DROP_HERO : DROP_BODY) * (last.size / (last.plan.hero ? HERO : BODY)) + 0.05 * last.size);
  };
  let k = 1;
  if (extent(1) > safeHeight) {
    let lo = 0.2;
    let hi = 1;
    for (let tries = 0; tries < 16; tries++) {
      const mid = (lo + hi) / 2;
      if (extent(mid) > safeHeight) hi = mid;
      else lo = mid;
    }
    k = lo;
  }
  const { rows } = geometry(k);
  const units = rows.flatMap((row) => row.units);

  // --- the cue's exit: the whole block lifts and shrinks about its centre; late words get time to land first ---
  const lastBegin = Math.max(...units.map((unit) => unit.begin));
  const exitStart = Math.min(Math.max(cue.endMs - EXIT_END_MS - EXIT_MS, lastBegin + HOLD_MS), cue.endMs + OVERLAP_MS - EXIT_MIN_MS);
  const exitMs = clamp(cue.endMs - EXIT_END_MS - exitStart, EXIT_MIN_MS, EXIT_MS);
  const exitEnd = Math.round(exitStart + exitMs);
  const out = (t: number) => EASES.in(prog(t, exitStart, exitMs));
  const shrink = (t: number) => Math.max(0.02, 1 - out(t));
  const ccx = space.x(540);
  const ccy = space.y(CY);
  const mapX = (t: number, x: number) => ccx + shrink(t) * (x - ccx);
  const mapY = (t: number, y: number) => ccy - LIFT_PX * u * out(t) + shrink(t) * (y - ccy);

  const pieces: Piece[] = [];
  let used = 0;
  const frames = (fn: (t: number) => number, edges: readonly number[], from: number, to: number, tolerance: number): Frames =>
    sampleFrames(fn, [from, ...edges, exitStart, exitEnd, to], tolerance, { range: [from, to], wholeMs: true, simplify: true });

  // --- the words: three colour copies and the face, every unit ---
  rows.forEach((row, ri) => {
    const hero = row.plan.hero;
    const m = row.size / (hero ? HERO : BODY);
    const lag = hero ? HERO_LAG : LAG;
    const rest = row.size * (hero ? REST_HERO : REST_BODY);
    const stack = hero ? heroStack : bodyStack;
    const pivotY = row.top + 0.5 * row.size;
    for (const unit of row.units) {
      const cx = unit.left + unit.width / 2;
      const from = Math.round(unit.begin) + (hero ? 2 : 0);
      const to = Math.max(exitEnd, from + 2);
      const scaleAt = (t: number) => trailScale(hero, t - unit.begin);
      for (let layer = 3; layer >= 0; layer--) {
        const lagged = layer * lag;
        const yAt = (t: number) => pivotY + trailRise(hero, t - lagged - unit.begin, t - lagged, unit.letter) * m + layer * rest * scaleAt(t);
        const edges = [unit.begin + 300, unit.begin + 380, unit.begin + lagged + 380, unit.begin + lagged + 420, unit.begin + lagged + 450, unit.begin + 540, unit.begin + lagged + 850, unit.begin + 150, unit.begin + 290, unit.begin + 430];
        const scale = frames((t) => scaleAt(t) * shrink(t), edges, from, to, 0.003);
        const track: Track = {
          x: frames((t) => mapX(t, space.x(cx)), [], from, to, 0.3),
          y: frames((t) => mapY(t, space.y(yAt(t))), edges, from, to, 0.3),
          sx: scale,
          sy: scale,
        };
        pieces.push({
          id: `trail:${cueNumber}:w${unit.item.index}l${unit.letter}c${layer}`,
          kind: "text",
          z: band + 4 + ri * 4 + (3 - layer),
          fromMs: from,
          toMs: to,
          track,
          origin: { dx: (unit.width / 2) * u, dy: (0.5 - BASELINE_EM) * unit.size * u },
          text: unit.text,
          face: FACE,
          sizePx: unit.size * u,
          letterSpacingEm: LS,
          fill: layer === 0 ? primary : stack[layer - 1]!,
          stroke: { widthPx: STROKE_EM * unit.size * u, colour: TRAIL_KEYLINE },
          anchor: "baseline-left",
          language: cue.language,
        } satisfies TextPiece);
        used++;
      }
    }
  });

  // --- the decoration: stripes above, a bar below, ticks off the key word; each recurs on every cue and cycles by `counter` ---
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const lead = rtl ? -1 : 1;
  const palette = hasHero ? [highlight, accent, PURPLE] : [highlight, MINT, BLUE];
  const rotated = (at: number) => palette[(at + counter) % palette.length]!;
  const beatStart = Math.min(...units.map((unit) => unit.begin));
  const wipe = (from: number, ms: number) => (t: number) => EASES.outExpo(prog(t, from, ms));

  const wipePiece = (id: string, z: number, from: number, to: number, path: PathCmd[], fill: string, strokePx: number, bounds: { x1: number; y1: number; x2: number; y2: number }, kind: number, ms: number, delay = 0, strokeColour = TRAIL_KEYLINE): void => {
    // `bounds` is the shape's rest box in canvas px; kind 0 wipes from the leading edge, 1 from the trailing edge, 2 from the middle.
    const w = bounds.x2 - bounds.x1;
    const h = bounds.y2 - bounds.y1;
    const pad = strokePx + 2;
    const start = from + delay;
    const progress = wipe(start, ms);
    const edgeLeft = (t: number) => (kind === 0 ? (lead > 0 ? bounds.x1 : bounds.x2 - w * progress(t)) : kind === 1 ? (lead > 0 ? bounds.x2 - w * progress(t) : bounds.x1) : bounds.x1 + (w / 2) * (1 - progress(t)));
    const edgeRight = (t: number) => (kind === 0 ? (lead > 0 ? bounds.x1 + w * progress(t) : bounds.x2) : kind === 1 ? (lead > 0 ? bounds.x2 : bounds.x1 + w * progress(t)) : bounds.x2 - (w / 2) * (1 - progress(t)));
    const edges = [start, start + ms];
    const cx = bounds.x1 + w / 2;
    const cy = bounds.y1 + h / 2;
    const clip: Clip = {
      x1: frames((t) => mapX(t, edgeLeft(t) - pad), edges, from, to, 0.3),
      x2: frames((t) => mapX(t, edgeRight(t) + pad), edges, from, to, 0.3),
      y1: frames((t) => mapY(t, bounds.y1 - pad), [], from, to, 0.3),
      y2: frames((t) => mapY(t, bounds.y2 + pad), [], from, to, 0.3),
    };
    const scale = frames((t) => shrink(t), [], from, to, 0.003);
    pieces.push({
      id,
      kind: "shape",
      z,
      fromMs: from,
      toMs: to,
      track: { x: frames((t) => mapX(t, cx), [], from, to, 0.3), y: frames((t) => mapY(t, cy), [], from, to, 0.3), sx: scale, sy: scale },
      clip,
      origin: { dx: w / 2, dy: h / 2 },
      path,
      fill: { colour: fill },
      stroke: { widthPx: strokePx, colour: strokeColour },
    } satisfies ShapePiece);
    used += 2;
  };

  // (1) Rainbow stripes above the first row.
  {
    const size = first.size;
    const heroFirst = first.plan.hero;
    const thickness = Math.max(7, 0.105 * size) * u;
    const stroke = 0.3 * thickness;
    const pitch = 1.38 * thickness;
    const reach = (heroFirst ? 1.4 : 1.08) * 0.3495 * size * u + STROKE_EM * size * u;
    const pivotTop = space.y(first.top + 0.5 * size) - reach;
    const bottom = pivotTop - 0.12 * size * u;
    const kind = counter % 3;
    const lengths = [1, 0.7, 0.46];
    const longest = [0, 1, 2][(counter + (Math.floor(rng() * 3))) % 3]!;
    const rowLeft = space.x(first.left);
    const rowRight = space.x(first.left + first.width);
    const fullLength = (0.62 + 0.3 * rng()) * (rowRight - rowLeft);
    const from = Math.round(beatStart);
    const to = exitEnd;
    if (used + 6 <= BUDGET && to > from + 60) {
      for (let at = 0; at < 3; at++) {
        const length = Math.max(8 * u, fullLength * lengths[(at + longest) % 3]!);
        const y2 = bottom - at * pitch;
        const y1 = y2 - thickness;
        const x1 = kind === 2 ? (rowLeft + rowRight) / 2 - length / 2 : (kind === 0) === (lead > 0) ? rowLeft : rowRight - length;
        wipePiece(`trail:${cueNumber}:s${at}`, band + at, from, to, pillPath(length, thickness), rotated(at), stroke, { x1, y1, x2: x1 + length, y2 }, kind, 320, at * 45);
      }
    }
  }

  // (2) A landing bar under the last row, once its last word has landed.
  {
    const size = last.size;
    const thickness = Math.max(9, 0.125 * size) * u;
    const stroke = 0.28 * thickness;
    const rest = size * (last.plan.hero ? REST_HERO : REST_BODY);
    const top = space.y(last.baseline + 3 * rest + STROKE_EM * size + 0.1 * size);
    const lastBegin = Math.max(...last.units.map((unit) => unit.begin));
    const from = Math.round(lastBegin + 50);
    const to = exitEnd;
    const kind = (counter + 1) % 3;
    const variant = counter % 3;
    const rowLeft = space.x(last.left);
    const rowRight = space.x(last.left + last.width);
    const length = (0.64 + 0.3 * rng()) * (rowRight - rowLeft);
    const cx = (rowLeft + rowRight) / 2 + (rng() - 0.5) * 0.12 * (rowRight - rowLeft);
    if (to > from + 100 && used + 8 <= BUDGET) {
      if (variant === 2) {
        // Three dots pop in from the middle outwards.
        const radius = 0.55 * thickness;
        for (let at = 0; at < 3; at++) {
          const dx = (at - 1) * 3.1 * radius;
          const start = from + (at === 1 ? 0 : 55);
          const x = cx + dx;
          const y = top + radius;
          const pop = (t: number) => lerp(0.15, 1, outBack(prog(t, start, 260), 2.2));
          pieces.push({
            id: `trail:${cueNumber}:b${at}`,
            kind: "shape",
            z: band + 1,
            fromMs: start,
            toMs: to,
            track: {
              x: frames((t) => mapX(t, x), [], start, to, 0.3),
              y: frames((t) => mapY(t, y), [], start, to, 0.3),
              sx: frames((t) => pop(t) * shrink(t), [start + 130, start + 260], start, to, 0.003),
              sy: frames((t) => pop(t) * shrink(t), [start + 130, start + 260], start, to, 0.003),
            },
            origin: { dx: 0, dy: 0 },
            path: ellipsePath(0, 0, radius),
            fill: { colour: rotated(at + 1) },
            stroke: { widthPx: 0.34 * thickness, colour: TRAIL_KEYLINE },
          } satisfies ShapePiece);
          used += 2;
        }
      } else {
        const bounds = { x1: cx - length / 2, y1: top, x2: cx + length / 2, y2: top + thickness };
        if (variant === 0) {
          wipePiece(`trail:${cueNumber}:b0`, band + 1, from, to, pillPath(length, thickness), TRAIL_KEYLINE, 0.22 * thickness, bounds, kind, 300, 0, WHITE);
          // A thin yellow edge along the bar's top.
          const edge = 0.26 * thickness;
          const inner = { x1: bounds.x1 + 0.4 * thickness, y1: top + 0.2 * thickness, x2: bounds.x2 - 0.4 * thickness, y2: top + 0.2 * thickness + edge };
          wipePiece(`trail:${cueNumber}:b1`, band + 2, from, to, pillPath(inner.x2 - inner.x1, edge), highlight, 0.01, inner, kind, 300, 40);
        } else {
          wipePiece(`trail:${cueNumber}:b0`, band + 1, from, to, pillPath(length, thickness), rotated(0), stroke, bounds, kind, 300);
        }
      }
    }
  }

  // (3) Pop ticks flung off both ends of the key word's row (the last row of a cue without one) as it lands. They sit beside the
  // row, never over a neighbouring row's ink, and a tick with no room inside the safe area is left out.
  {
    let target: RowGeo | undefined;
    if (hasHero) target = rows.find((row) => row.plan.hero);
    else {
      let best = -1;
      for (const row of rows) for (const item of row.plan.items) if (item.index > best) [best, target] = [item.index, row];
    }
    if (target) {
      const row = target;
      const size = row.size;
      const startUnit = row.units.reduce((a, b) => (a.begin <= b.begin ? a : b));
      const sideCount = hasHero ? 3 : 2;
      const peak = Math.round(startUnit.begin + (hasHero ? 160 : 120));
      const cx = space.x(540);
      const boxCy = space.y(row.baseline - (CAP_EM / 2) * size);
      const rx = (row.width / 2 + 0.1 * size) * u;
      const ry = (0.5 * CAP_EM * size + 0.08 * size) * u;
      const len = 0.26 * size * u;
      const width = 0.085 * size * u;
      const travel = 0.2 * size * u;
      const variants = [[-24, 0, 24], [-36, -8, 20], [-14, 12, 36]] as const;
      const offsets = variants[counter % 3]!;
      const shift = counter % 2 === 0 ? 0 : 8;
      const colours = hasHero ? [highlight, WHITE, accent, PURPLE] : [highlight, WHITE, MINT, BLUE];
      const reachLimit = len + width;
      let made = 0;
      for (let side = 0; side < 2; side++) {
        for (let j = 0; j < sideCount && used + 2 <= BUDGET; j++) {
          const off = offsets[j]! + (side === 1 ? shift : 0) + (rng() - 0.5) * 10;
          const theta = ((side === 0 ? off : 180 - off) * Math.PI) / 180;
          const dirX = Math.cos(theta);
          const dirY = Math.sin(theta);
          const start = peak + (side * sideCount + j) * 22;
          const end = Math.min(start + 540, exitEnd);
          if (end < start + 120) continue;
          const x0 = cx + dirX * rx;
          const y0 = boxCy + dirY * ry;
          const x1 = x0 + dirX * travel;
          const y1 = y0 + dirY * travel;
          const inSafe = (x: number, y: number) => x >= space.safe.x1 + reachLimit && x <= space.safe.x2 - reachLimit && y >= space.safe.y1 + reachLimit && y <= space.safe.y2 - reachLimit;
          if (!inSafe(x1, y1) || !inSafe(x0, y0)) continue;
          const grow = 0.32 + 0.1 * rng();
          const at = made++;
          pieces.push({
            id: `trail:${cueNumber}:t${at}`,
            kind: "shape",
            z: band + 44,
            fromMs: start,
            toMs: end,
            track: {
              x: frames((t) => mapX(t, lerp(x0, x1, EASES.outExpo(prog(t, start, 300)))), [start + 300], start, end, 0.3),
              y: frames((t) => mapY(t, lerp(y0, y1, EASES.outExpo(prog(t, start, 300)))), [start + 300], start, end, 0.3),
              rz: [[start, (theta * 180) / Math.PI]],
              sx: frames((t) => lerp(grow, 1, outBack(prog(t, start, 240), 2.2)) * shrink(t), [start + 240], start, end, 0.003),
              sy: frames((t) => lerp(grow, 1, outBack(prog(t, start, 240), 2.2)) * shrink(t), [start + 240], start, end, 0.003),
              o: [[start, 1], [start + 300, 1], [end, 0, "in"]],
            },
            origin: { dx: len / 2, dy: width / 2 },
            path: pillPath(len, width),
            fill: { colour: colours[(at + counter) % colours.length]! },
            stroke: { widthPx: 0.34 * width, colour: TRAIL_KEYLINE },
          } satisfies ShapePiece);
          used += 2;
        }
      }
    }
  }

  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const trailProgram: SceneProgram = {
  build(input) {
    const counters = { hero: 0, plain: 0 };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, counters, input))) };
  },
};
