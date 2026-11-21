import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, greedyRows, rowVisualOrder, sceneSpace, shiftPiece } from "../layout";
import { type Box, type Piece, type ShapePiece, type TextPiece, type Track, pieceBounds } from "../scene";
import { polygonPath, roundedRectPath } from "../shapes";

/**
 * Tape (`samples/templates/m05-tape.js`, after Motion Array "Minimal Kinetic Titles"): wide white caps on a zine wall. Each
 * spoken word pops in; the key word bursts letter by letter while translucent cobalt packing-tape strips slap down behind it
 * in a quick starburst, then an acid-lime tape label (printed with the word) or a lime marker tick lands beside it. A line
 * with no key word gets one thin strip of tape under it. The whole block pushes in slowly while it holds and shrinks away as
 * the cue leaves.
 *
 * Geometry is the sample's, read in Chrome (`probe-sample.ts`): Archivo Expanded Black (wdth 125, wght 900) in capitals, 92 px
 * (hero 158 px), -0.01 em, `line-height: 1.04` boxes with the baseline 78 / 135 px down, a box padded 0.13 em each side, rows
 * packed greedily into 900 px and centred, 4 px between rows, the whole block centred on y 1290. The hero is its own row and
 * its letters are inline blocks (no kerning between them).
 *
 * What changed from the sample, and why (gallery-2 brief):
 *  - Label and tick were placed at a fixed offset from the block's centre, and the tick from the hero's right edge, so a wide
 *    hero pushed them off the frame. They hang from the hero's own corners now (label across the top-left, mirrored for a
 *    right-to-left cue; tick off the right edge, mirrored) and each group is shifted inside the 5 % safe area; a tick that
 *    would not fit scales down, then yields to the label.
 *  - Label or tick was `ci === 1` or not: they alternate by a counter of the hero words, so a clip of any length keeps both.
 *  - The strips' fan, lengths, tears and slide directions come from a seeded hash of the cue's index and the hero's text
 *    (a mulberry32 stream like the sample's); the sample's `sort(() => r() - 0.5)` shuffle is a seeded Fisher-Yates. The first
 *    letter always pops in the first third so the word reads.
 *  - Strips are shortened until the whole slapped-down strip, squash and push included, sits inside the safe area; they
 *    slide in from outside the frame as in the sample (`bleed`). The thin strip under a plain cue slides in from the left
 *    and right alternately, tilting the other way each time.
 *  - Everything fits: the hero shrinks until its row, with the letters' 1.35x pop, is inside the safe width; body rows wrap
 *    to the safe width (the pop's 1.22x counted) and shrink for a word wider than a row. A label with a long word prints it
 *    once; the label and tick are clamped inside the safe area.
 *  - Real speech: the sample's exit started 240 ms before the cue's end, which hides a last word that landed late. The exit
 *    waits until every word has landed and been readable for 150 ms, then shortens (60 to 170 ms) and never runs more than
 *    50 ms into the next cue, so the next cue's entrance is never drawn over; letters' pop stagger shrinks for a short hero word, and the label and tick land at least 180 / 220 ms
 *    before the exit.
 *  - Scripts that need shaping (Arabic, Urdu, Devanagari, Thai ...), CJK, emoji and right-to-left words are never split into
 *    letters: the hero pops as one piece. Capitals only for Latin, Cyrillic and Greek words.
 *  - The ink's box-shadow on the tick (`0 3px 10px`) is fully clipped by the sample's own `clip-path`, so it is not drawn.
 */

export const TAPE_DEMO: DemoScript = {
  lines: [
    "nobody:b is:m coming:b to:m save:b you",
    "your:m career:h@620",
    "is:m on:m you",
    "so:m ship:h@560",
    "every:b single:b week",
  ],
  options: { rate: 270, cueGap: 160, tail: 760 },
};

const CX = 540;
const CENTER_Y = 1290;
const BODY = 92;
const HERO = 158;
const FACE = "Archivo Expanded Black" as const;
const LABEL_FACE = "Archivo ExtraBold Italic" as const;
const LS = -0.01;
const PAD = 0.13;
const LINE = 1.04;
const ROW_GAP = 4;
const ROW_MAX = 900;
/** Chrome's baseline of a `line-height: 1.04` Archivo box, as a share of the size (78 of 92 px, 135 of 158 px). */
const BASELINE_BODY = 78 / 92;
const BASELINE_HERO = 135 / 158;
const INK = "#101010";
const TAPE_ALPHA = 0.74;
const PUSH = 0.035;
const PUSH_MAX = 1 + PUSH;
const SHRINK = 0.06;
const WORD_POP = { from: 1.22, dur: 140, lead: 60 } as const;
const LETTER_POP = { from: 1.35, dur: 120, lead: 70, step: 34 } as const;
const MAX_LETTERS = 18;
/** The exit slot of the sample (ends 70 ms before the cue's end), and how long a landed word stays readable. */
const EXIT = 170;
const CLEAR = 70;
const HOLD = 150;
const SLAP = 190;
const THIN_SLAP = 320;
/** The block is never taller than this (sample px); nine words wrap into four rows and still fit. */
const MAX_BLOCK = 640;

const LABEL = { w: 330, h: 62, size: 25, ls: 0.16, baselineEm: 0.334, offset: [112, 92] as const, from: [-58, -30] as const, move: [-60, -40] as const, scale: 1.4 };
const TICK = { thick: 20, radius: 9, a: { len: 74, ang: 48 }, b: { len: 158, ang: -60 }, start: [18, -4] as const, reach: 150 };

/** The sample's seeded generator (mulberry32). */
export function tapeRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of a string: the seed that makes a cue's decoration a pure function of its index and words. */
export function tapeHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A seeded Fisher-Yates permutation of 0..n-1. */
export function tapeShuffle(n: number, r: () => number): number[] {
  const order = Array.from({ length: n }, (_, at) => at);
  for (let at = n - 1; at > 0; at--) {
    const to = Math.floor(r() * (at + 1));
    [order[at], order[to]] = [order[to]!, order[at]!];
  }
  return order;
}

/** Pop rank of each letter: a seeded shuffle, with the first letter always among the first third. */
export function tapeLetterRanks(n: number, r: () => number): number[] {
  const order = tapeShuffle(n, r);
  const rank = new Array<number>(n);
  order.forEach((letter, at) => {
    rank[letter] = at;
  });
  const limit = Math.floor(n / 3);
  if (n > 2 && rank[0]! > limit) {
    const want = Math.floor(r() * (limit + 1));
    const other = rank.indexOf(want);
    [rank[0], rank[other]] = [rank[other]!, rank[0]!];
  }
  return rank;
}

/** The sample's torn tape: a long flat rectangle with zig-zag ends, points in the strip's own px from its top-left. */
export function tapePoints(len: number, thick: number, r: () => number): [number, number][] {
  const teeth = 4;
  const step = thick / teeth;
  const points: [number, number][] = [];
  for (let i = 0; i <= teeth; i++) points.push([len - (i % 2 ? 7 + r() * 6 : r() * 4), i * step]);
  for (let i = teeth; i >= 0; i--) points.push([i % 2 ? 7 + r() * 6 : r() * 4, i * step]);
  return points;
}

/** The block's scale about its centre: the slow push across the cue, times the exit's 6 % shrink. */
export function tapeBlockScale(t: number, cueStartMs: number, cueEndMs: number, exitFrom: number, exitDur: number): number {
  return (1 + PUSH * EASES.out(prog(t, cueStartMs, Math.max(1, cueEndMs - cueStartMs)))) * (1 - SHRINK * EASES.in(prog(t, exitFrom, exitDur)));
}

const SIMPLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;

/** Capitals for cased scripts only; any other script is drawn as spoken. */
export function tapeCase(text: string): string {
  return SIMPLE.test(text) && !PICTO.test(text) ? text.toUpperCase() : text;
}

function graphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
  return Segmenter ? [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment) : [...text];
}

interface Counters {
  heroes: number;
  plains: number;
}

interface Word {
  readonly index: number;
  readonly text: string;
  readonly hero: boolean;
  readonly letters: readonly string[] | null;
}

function buildCue(cue: SceneCue, cueNumber: number, input: SceneInput, counters: Counters): Piece[] {
  const space = sceneSpace(input, CENTER_Y);
  const { u, safe } = space;
  const rtl = cueDirection(cue) === "rtl";
  const sign = rtl ? -1 : 1;
  const BX = space.x(CX);
  const BY = space.y(CENTER_Y);
  const safeW = safe.x2 - safe.x1;
  const cap = safeW / PUSH_MAX;
  const limit = Math.min(ROW_MAX * u, cap);
  const band = cueNumber * 10;
  const cueSeed = tapeHash(`${cue.index}|${cue.words.map((word) => word.text).join(" ")}`);

  const words: Word[] = cue.words.map((word, index) => {
    const text = tapeCase(word.text);
    const hero = word.role === "hero";
    const parts = graphemes(text);
    const letters = hero && !rtl && SIMPLE.test(text) && !PICTO.test(text) && parts.length > 1 && parts.length <= MAX_LETTERS ? parts : null;
    return { index, text, hero, letters };
  });
  const adv = (text: string, size: number) => input.measure(text, FACE, size, LS).advance + LS * size;

  // --- sizes: the hero fits its own row at the pop's peak, body words share one scale ---
  const contentOf = (word: Word, size: number) => (word.letters ? word.letters.reduce((sum, ch) => sum + adv(ch, size), 0) : adv(word.text, size));
  const sizes = new Map<number, number>();
  for (const word of words) {
    if (!word.hero) continue;
    const s0 = HERO * u;
    const content = contentOf(word, s0);
    const peak = word.letters ? content + (LETTER_POP.from - 1) * 0.5 * (adv(word.letters[0]!, s0) + adv(word.letters[word.letters.length - 1]!, s0)) : LETTER_POP.from * content;
    const fit = Math.min(1, cap / peak, limit / (content + 2 * PAD * s0));
    sizes.set(word.index, fit < 1 ? s0 * fit * 0.995 : s0);
  }
  const bodyWords = words.filter((word) => !word.hero);
  const boxOf = (word: Word, size: number) => adv(word.text, size) + 2 * PAD * size;
  const rowsOf = (L: number, size: number) => {
    const rows: number[][] = [];
    let run: number[] = [];
    const flush = () => {
      if (run.length === 0) return;
      for (const row of greedyRows(run.map((at) => boxOf(words[at]!, size)), 0, L)) rows.push(row.map((at) => run[at]!));
      run = [];
    };
    for (const word of words) {
      if (word.hero) {
        flush();
        rows.push([word.index]);
      } else run.push(word.index);
    }
    flush();
    return rows;
  };
  let bodySize = BODY * u;
  if (bodyWords.length > 0) {
    const widest = Math.max(...bodyWords.map((word) => boxOf(word, bodySize)));
    // A word wider than a row (with its 1.22x pop) shrinks all the body words.
    bodySize *= Math.min(1, limit / widest, cap / (WORD_POP.from * widest));
  }
  const reachOf = (row: number[], size: number) => {
    const boxes = row.map((at) => boxOf(words[at]!, size));
    const total = boxes.reduce((sum, w) => sum + w, 0);
    return total + (WORD_POP.from - 1) * 0.5 * (adv(words[row[0]!]!.text, size) + adv(words[row[row.length - 1]!]!.text, size));
  };
  const layoutRows = () => {
    let L = limit;
    let rows = rowsOf(L, bodySize);
    for (let tries = 0; tries < 14 && rows.some((row) => !words[row[0]!]!.hero && reachOf(row, bodySize) > cap); tries++) {
      L *= 0.97;
      rows = rowsOf(L, bodySize);
    }
    return rows;
  };
  const sizeOfRow = (row: number[]) => (words[row[0]!]!.hero ? sizes.get(row[0]!)! : bodySize);
  const heightOf = (rows: number[][]) => rows.reduce((sum, row) => sum + LINE * sizeOfRow(row), 0) + ROW_GAP * u * (rows.length - 1);
  let rows = layoutRows();
  for (let tries = 0; tries < 6 && heightOf(rows) > MAX_BLOCK * u; tries++) {
    bodySize *= (MAX_BLOCK * u) / heightOf(rows);
    rows = layoutRows();
  }

  // --- positions: rows centred on the anchor line, each row's boxes packed and centred ---
  const blockH = heightOf(rows);
  const blockTop = BY - blockH / 2;
  interface Placed {
    readonly word: Word;
    readonly size: number;
    /** Left of the ink box, canvas px. */
    readonly inkLeft: number;
    readonly content: number;
    readonly rowTop: number;
    readonly baseline: number;
  }
  const placed: Placed[] = [];
  let top = blockTop;
  let widestRow = 0;
  let lastRowBottom = blockTop;
  for (const row of rows) {
    const size = sizeOfRow(row);
    const hero = words[row[0]!]!.hero;
    const ordered = hero ? row : rowVisualOrder(row.map((at) => words[at]!.text), rtl ? "rtl" : "ltr").map((at) => row[at]!);
    const widths = ordered.map((at) => (hero ? contentOf(words[at]!, size) : adv(words[at]!.text, size)) + (hero ? 0 : 2 * PAD * size));
    const total = widths.reduce((sum, w) => sum + w, 0);
    widestRow = Math.max(widestRow, hero ? total + 2 * PAD * size : total);
    let x = BX - total / 2;
    ordered.forEach((at, i) => {
      const word = words[at]!;
      const content = hero ? widths[i]! : widths[i]! - 2 * PAD * size;
      placed.push({ word, size, inkLeft: hero ? x : x + PAD * size, content, rowTop: top, baseline: top + (hero ? BASELINE_HERO : BASELINE_BODY) * size });
      x += widths[i]!;
    });
    top += LINE * size + ROW_GAP * u;
    lastRowBottom = top - ROW_GAP * u;
  }

  // --- when each word is on screen, and when the block leaves ---
  const timing = new Map<number, { starts: number[]; land: number }>();
  const wordRng = tapeRng(cueSeed ^ 0x9e3779b9);
  for (const item of placed) {
    const spoken = cue.words[item.word.index]!;
    if (item.word.letters) {
      const n = item.word.letters.length;
      const ranks = tapeLetterRanks(n, wordRng);
      const step = clamp((0.7 * Math.max(spoken.endMs - spoken.startMs, 300)) / n, 10, LETTER_POP.step);
      const starts = ranks.map((rank) => spoken.startMs - LETTER_POP.lead + rank * step);
      timing.set(item.word.index, { starts, land: Math.max(...starts) + LETTER_POP.dur });
    } else if (item.word.hero) {
      const start = spoken.startMs - LETTER_POP.lead;
      timing.set(item.word.index, { starts: [start], land: start + LETTER_POP.dur });
    } else {
      const start = spoken.startMs - WORD_POP.lead;
      timing.set(item.word.index, { starts: [start], land: start + WORD_POP.dur });
    }
  }
  const lastLand = Math.max(...[...timing.values()].map((entry) => entry.land));
  // The exit never runs past 50 ms into the next cue (the engine ends a cue where the next starts): a word spoken that late gets less than HOLD.
  const exitFrom = Math.min(Math.max(cue.endMs - CLEAR - EXIT, lastLand + HOLD), cue.endMs + 50 - 60);
  const exitDur = clamp(cue.endMs + 50 - exitFrom, 60, EXIT);
  const exitTo = exitFrom + exitDur;
  const out = (t: number) => EASES.in(prog(t, exitFrom, exitDur));
  const sb = (t: number) => tapeBlockScale(t, cue.startMs, cue.endMs, exitFrom, exitDur);
  const fade: Frames = [[exitFrom, 1], [exitTo, 0, "in"]];

  /** A track from a function of time over the piece's window: exact eased segments where the curve is one, sampled otherwise. */
  const sampled = (fn: (t: number) => number, from: number, edges: readonly number[], tolerance: number): Frames =>
    sampleFrames(fn, edges, tolerance, { range: [from, exitTo], wholeMs: true, simplify: true });
  const baseEdges = [exitFrom, exitTo, cue.endMs];
  const about = (centre: number, p: number, t: number) => centre + sb(t) * (p - centre);
  /** Tracks of a piece that sits at (px, py) in the block and scales by `own(t)` about it: the block's push carries it. */
  const carried = (px: number, py: number, own: (t: number) => number, from: number, edges: readonly number[]): Track => ({
    x: sampled((t) => about(BX, px, t), from, [...edges, ...baseEdges], 0.2),
    y: sampled((t) => about(BY, py, t), from, [...edges, ...baseEdges], 0.2),
    sx: sampled((t) => sb(t) * own(t), from, [...edges, ...baseEdges], 0.002),
    sy: sampled((t) => sb(t) * own(t), from, [...edges, ...baseEdges], 0.002),
    o: fade,
  });

  const pieces: Piece[] = [];
  const shadows = [
    { dx: 0, dy: 6 * u, blur: 11 * u, colour: input.colours.shadow, alpha: 0.55 },
    { dx: 0, dy: 2 * u, blur: 2 * u, colour: input.colours.shadow, alpha: 0.45 },
  ];
  const text = (id: string, content: string, size: number, from: number, track: Track, origin: { dx: number; dy: number }): TextPiece => ({
    id,
    kind: "text",
    z: band + 1,
    fromMs: from,
    toMs: exitTo,
    track,
    origin,
    text: content,
    face: FACE,
    sizePx: size,
    letterSpacingEm: LS,
    fill: input.colours.primary,
    shadows,
    anchor: "baseline-left",
    language: cue.language,
  });

  // --- the words ---
  for (const item of placed) {
    const { word, size } = item;
    const pivotY = item.rowTop + (LINE * size) / 2;
    const dy = pivotY - item.baseline;
    const times = timing.get(word.index)!;
    if (word.letters) {
      let x = item.inkLeft;
      word.letters.forEach((ch, j) => {
        const w = adv(ch, size);
        const start = times.starts[j]!;
        const from = start + 4;
        const pop = (t: number) => lerp(LETTER_POP.from, 1, EASES.outExpo(prog(t, start, LETTER_POP.dur)));
        pieces.push(text(`tape:${cueNumber}:w${word.index}l${j}`, ch, size, from, carried(x + w / 2, pivotY, pop, from, [start, start + LETTER_POP.dur]), { dx: w / 2, dy }));
        x += w;
      });
    } else {
      const start = times.starts[0]!;
      const pop = word.hero ? LETTER_POP : WORD_POP;
      const from = start + 4;
      const scaleAt = (t: number) => lerp(pop.from, 1, EASES.outExpo(prog(t, start, pop.dur)));
      pieces.push(text(`tape:${cueNumber}:w${word.index}`, word.text, size, from, carried(item.inkLeft + item.content / 2, pivotY, scaleAt, from, [start, start + pop.dur]), { dx: item.content / 2, dy }));
    }
  }

  // --- tape ---
  const tapeFill = { colour: input.colours.highlight, alpha: TAPE_ALPHA };
  const strip = (id: string, points: [number, number][], thick: number, centre: { x: number; y: number }, at: number, dur: number, reach: number, dir: number, ang: number, squash: boolean): ShapePiece => {
    const rad = (ang * Math.PI) / 180;
    const from = at + 4;
    const slide = (t: number) => ((1 - EASES.outExpo(prog(t, at, dur))) * reach * dir + out(t) * reach * 0.5 * dir);
    const sy = (t: number) => (squash ? lerp(1.25, 1, EASES.out(prog(t, at + 120, 120))) : 1);
    const ramp = (t: number) => (t > at ? clamp(prog(t, at, dur) * 4) : 0);
    const edges = [at, at + dur, at + dur / 4, at + 120, at + 240];
    const len = Math.max(...points.map(([x]) => x));
    return {
      id,
      kind: "shape",
      z: band,
      fromMs: from,
      toMs: exitTo,
      bleed: true,
      track: {
        x: sampled((t) => about(BX, centre.x + Math.cos(rad) * slide(t), t), from, [...edges, ...baseEdges], 0.2),
        y: sampled((t) => about(BY, centre.y + Math.sin(rad) * slide(t), t), from, [...edges, ...baseEdges], 0.2),
        sx: sampled((t) => sb(t), from, baseEdges, 0.002),
        sy: sampled((t) => sb(t) * sy(t), from, [...edges, ...baseEdges], 0.002),
        rz: [[from, ang]],
        o: sampled((t) => ramp(t) * (1 - out(t)), from, [...edges, ...baseEdges], 0.01),
      },
      origin: { dx: len / 2, dy: thick / 2 },
      path: polygonPath(points),
      fill: tapeFill,
    };
  };
  /** The longest a strip may be, so that it sits inside the safe area at its widest (squash and push included). */
  const fitStrip = (len: number, thick: number, centre: { x: number; y: number }, ang: number) => {
    const rad = (ang * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const s = Math.abs(Math.sin(rad));
    const fits = (l: number) => {
      const hx = (l / 2) * c + (thick * 1.25 * s) / 2;
      const hy = (l / 2) * s + (thick * 1.25 * c) / 2;
      const cx = BX + PUSH_MAX * (centre.x - BX);
      const cy = BY + PUSH_MAX * (centre.y - BY);
      return cx - PUSH_MAX * hx >= safe.x1 && cx + PUSH_MAX * hx <= safe.x2 && cy - PUSH_MAX * hy >= safe.y1 && cy + PUSH_MAX * hy <= safe.y2;
    };
    if (fits(len)) return len;
    let lo = 0;
    let hi = len;
    for (let step = 0; step < 24; step++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return Math.max(lo, 4 * u);
  };
  const scalePoints = (points: [number, number][]) => points.map(([x, y]) => [x * u, y * u] as [number, number]);

  const heroes = placed.filter((item) => item.word.hero);
  const decorations: Piece[][] = [];
  if (heroes.length === 0) {
    const r = tapeRng(cueSeed);
    const flip = counters.plains++ % 2 === 1;
    const dir = (flip ? 1 : -1) * sign;
    const len0 = (widestRow / u + 24 + r() * 16) * u;
    const ang = (-2.5 + r() * 2) * (flip ? -1 : 1) * sign;
    const centre = { x: BX + (r() - 0.5) * 60 * u, y: lastRowBottom + 14 * u };
    const thick = 30 * u;
    const len = fitStrip(len0, thick, centre, ang);
    const points = scalePoints(tapePoints(len / u, 30, r));
    pieces.push(strip(`tape:${cueNumber}:thin`, points, thick, centre, cue.startMs + 60, THIN_SLAP, 900 * u, dir, ang, false));
  }
  for (const item of heroes) {
    const spoken = cue.words[item.word.index]!;
    const r = tapeRng(cueSeed ^ Math.imul(item.word.index + 1, 0x85ebca6b));
    const heroCY = item.rowTop + (LINE * item.size) / 2;
    const heroScale = item.size / (HERO * u);
    const h = item.word.index;
    const base = r() * 180;
    for (let k = 0; k < 5; k++) {
      const ang = ((base + (k * 180) / 5 + (r() - 0.5) * 22) % 180) - 90;
      const steep = Math.abs(Math.sin((ang * Math.PI) / 180));
      const len0 = lerp(820, 430, steep) * (0.92 + r() * 0.14) * u * Math.max(0.5, heroScale);
      const thick = (64 + r() * 16) * u;
      const centre = { x: BX + (r() - 0.5) * 100 * u, y: heroCY + (r() - 0.5) * 40 * u };
      const len = fitStrip(len0, thick, centre, ang);
      const points = scalePoints(tapePoints(len / u, thick / u, r));
      const dir = r() < 0.5 ? -1 : 1;
      const at = Math.max(cue.startMs - 210, spoken.startMs - 210) + k * 60;
      pieces.push(strip(`tape:${cueNumber}:s${h}k${k}`, points, thick, centre, at, SLAP, 420 * (1 - 0.8 * steep) * u, dir, ang, true));
    }
    // The label or the tick: alternating by a counter of the hero words, whichever fits.
    const content = item.content;
    const heroLeft = BX - content / 2;
    const heroRight = BX + content / 2;
    const prefer = counters.heroes++ % 2 === 0 ? "label" : "tick";
    const tickRoom = rtl ? BX - PUSH_MAX * (BX - heroLeft) - safe.x1 : safe.x2 - (BX + PUSH_MAX * (heroRight - BX));
    const tickK = Math.min(1, tickRoom / (TICK.reach * u * PUSH_MAX), Math.max(0.5, heroScale));
    const labelWord = item.word.text;
    const labelAt = clamp(spoken.startMs + 300, spoken.startMs + 40, Math.max(spoken.startMs + 40, exitFrom - 180));
    const tickAt = clamp(spoken.startMs + 260, spoken.startMs + 40, Math.max(spoken.startMs + 40, exitFrom - 220));
    const makeLabel = (): Piece[] | null => {
      const wanted = [`• ${labelWord} • ${labelWord} •`, `• ${labelWord} •`];
      for (const printed of wanted) {
        const textW0 = input.measure(printed, LABEL_FACE, LABEL.size * u, LABEL.ls).advance + LABEL.ls * LABEL.size * u;
        const lw0 = Math.max(LABEL.w * u, textW0 + 24 * u);
        const k = Math.min(1, (0.8 * safeW) / (lw0 * PUSH_MAX), Math.max(0.55, heroScale));
        if (k < (printed === wanted[0] ? 0.55 : 0.4)) continue;
        const lw = lw0 * k;
        const lh = LABEL.h * u * k;
        const labelPoints = tapePoints(lw / u, lh / u, r).map(([x, y]) => [x * u, y * u] as [number, number]);
        const centre = { x: rtl ? heroRight - LABEL.offset[0] * u * Math.max(0.5, heroScale) : heroLeft + LABEL.offset[0] * u * Math.max(0.5, heroScale), y: heroCY - LABEL.offset[1] * u * Math.max(0.5, heroScale) };
        const from = labelAt + 4;
        const pose = (t: number) => EASES.spring(prog(t, labelAt, 260));
        const edges = [labelAt, labelAt + 260];
        const sizeLabel = LABEL.size * u * k;
        const textW = textW0 * k;
        const track = (): Track => ({
          x: sampled((t) => about(BX, centre.x + sign * lerp(LABEL.move[0], 0, pose(t)) * u, t), from, [...edges, ...baseEdges], 0.2),
          y: sampled((t) => about(BY, centre.y + lerp(LABEL.move[1], 0, pose(t)) * u, t), from, [...edges, ...baseEdges], 0.2),
          sx: sampled((t) => sb(t) * lerp(LABEL.scale, 1, pose(t)), from, [...edges, ...baseEdges], 0.002),
          sy: sampled((t) => sb(t) * lerp(LABEL.scale, 1, pose(t)), from, [...edges, ...baseEdges], 0.002),
          rz: sampled((t) => sign * lerp(LABEL.from[0], LABEL.from[1], pose(t)), from, [...edges, ...baseEdges], 0.05),
          o: fade,
        });
        const polygon: ShapePiece = {
          id: `tape:${cueNumber}:lab${h}`,
          kind: "shape",
          z: band + 2,
          fromMs: from,
          toMs: exitTo,
          track: track(),
          origin: { dx: lw / 2, dy: lh / 2 },
          path: polygonPath(labelPoints),
          fill: { colour: input.colours.accent },
        };
        const label: TextPiece = {
          id: `tape:${cueNumber}:lab${h}t`,
          kind: "text",
          z: band + 3,
          fromMs: from,
          toMs: exitTo,
          track: track(),
          origin: { dx: textW / 2, dy: -LABEL.baselineEm * sizeLabel },
          text: printed,
          face: LABEL_FACE,
          sizePx: sizeLabel,
          letterSpacingEm: LABEL.ls,
          fill: INK,
          anchor: "baseline-left",
          language: cue.language,
        };
        return [polygon, label];
      }
      return null;
    };
    const makeTick = (): Piece[] | null => {
      if (tickK < 0.55) return null;
      const k = tickK;
      const edgeX = rtl ? heroLeft : heroRight;
      const cy = heroCY;
      const thick = TICK.thick * u * k;
      const arm = (id: string, start: { x: number; y: number }, len: number, ang: number, wipeAt: number, wipeDur: number, wipe: (p: number) => number): Piece[] => {
        const from = wipeAt + 4;
        const wipeEnd = wipeAt + wipeDur;
        const L = len * u * k;
        const rz = rtl ? 180 - ang : ang;
        const pose = (t: number) => wipe(prog(t, wipeAt, wipeDur));
        const edges = [wipeAt, wipeEnd];
        const common = (sx: Track["sx"], fromMs: number): Track => ({
          x: sampled((t) => about(BX, start.x, t), fromMs, [...edges, ...baseEdges], 0.2),
          y: sampled((t) => about(BY, start.y, t), fromMs, [...edges, ...baseEdges], 0.2),
          sx,
          sy: sampled((t) => sb(t), fromMs, baseEdges, 0.002),
          rz: [[fromMs, rz]],
          o: fade,
        });
        const growing: ShapePiece = {
          id: `${id}w`,
          kind: "shape",
          z: band + 2,
          fromMs: from,
          toMs: wipeEnd,
          track: common(sampled((t) => sb(t) * pose(t), from, [...edges, ...baseEdges], 0.002), from),
          origin: { dx: 0, dy: thick / 2 },
          path: roundedRectPath(0, 0, L, thick, [TICK.radius * u * k, 0, 0, TICK.radius * u * k]),
          fill: { colour: input.colours.accent },
        };
        const done: ShapePiece = {
          id: `${id}r`,
          kind: "shape",
          z: band + 2,
          fromMs: wipeEnd,
          toMs: exitTo,
          track: common(sampled((t) => sb(t), wipeEnd, baseEdges, 0.002), wipeEnd),
          origin: { dx: 0, dy: thick / 2 },
          path: roundedRectPath(0, 0, L, thick, TICK.radius * u * k),
          fill: { colour: input.colours.accent },
        };
        return wipeEnd < exitTo ? [growing, done] : [growing];
      };
      const rad = (TICK.a.ang * Math.PI) / 180;
      const aStart = { x: edgeX + sign * TICK.start[0] * u * k, y: cy + TICK.start[1] * u * k };
      const bStart = { x: edgeX + sign * (TICK.start[0] + TICK.a.len * Math.cos(rad) - 7) * u * k, y: cy + (TICK.start[1] + TICK.a.len * Math.sin(rad) - 2) * u * k };
      return [
        ...arm(`tape:${cueNumber}:tk${h}a`, aStart, TICK.a.len, TICK.a.ang, tickAt, 110, (p) => EASES.out(p)),
        ...arm(`tape:${cueNumber}:tk${h}b`, bStart, TICK.b.len, TICK.b.ang, tickAt + 100, 200, (p) => EASES.outExpo(p)),
      ];
    };
    const group = prefer === "label" ? makeLabel() ?? makeTick() : makeTick() ?? makeLabel();
    if (group) decorations.push(group);
  }

  // --- decorations hang off the hero; each group is shifted whole until everything it draws is inside the safe area ---
  for (const group of decorations) {
    const from = Math.min(...group.map((piece) => piece.fromMs));
    const to = Math.max(...group.map((piece) => piece.toMs));
    let union: Box | null = null;
    for (let t = from; t < to; t += 16) {
      for (const piece of group) {
        const box = pieceBounds(piece, t, input.measure);
        if (!box) continue;
        union = union ? { x1: Math.min(union.x1, box.x1), y1: Math.min(union.y1, box.y1), x2: Math.max(union.x2, box.x2), y2: Math.max(union.y2, box.y2) } : box;
      }
    }
    let dx = 0;
    let dy = 0;
    if (union) {
      if (union.x1 < safe.x1) dx = safe.x1 - union.x1;
      else if (union.x2 > safe.x2) dx = safe.x2 - union.x2;
      if (union.y1 < safe.y1) dy = safe.y1 - union.y1;
      else if (union.y2 > safe.y2) dy = safe.y2 - union.y2;
    }
    for (const piece of group) pieces.push(dx === 0 && dy === 0 ? piece : shiftPiece(piece, dx, dy));
  }
  return clampToSafeArea(pieces, safe, input.measure);
}

export const tapeProgram: SceneProgram = {
  build(input) {
    const counters: Counters = { heroes: 0, plains: 0 };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, input, counters))) };
  },
};
