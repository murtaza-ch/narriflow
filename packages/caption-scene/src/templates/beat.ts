import type { DemoScript } from "../demo";
import { EASES, clamp, lerp, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, greedyRows, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { Clip, PathCmd, Piece, ShapePiece, TextPiece, Track } from "../scene";
import { ellipsePath, pathBounds, rectPath } from "../shapes";

/**
 * Beat (`samples/templates/m06-beat.js`, after Motion Array "Rhythmic Beats"): heavy white caps in Archivo Black, stacked flush
 * left one short row at a time. Every spoken word lands like a drum hit (a hard cut-in and a small kick through the whole block)
 * while the stack slowly pushes in. The key word pops letter by letter in a scattered order, then gets a lime marker mark: a
 * brush swipe under it, a white label bar it is printed on, or a loop drawn around it. A cue with no key word has a lime cursor
 * that hops to the end of each word as it lands.
 *
 * Geometry is the sample's, read in Chrome (`probe-sample.ts`): 120 px body and 150 px hero caps, -0.01 em, words 0.22 em apart,
 * rows 0.9 em tall (the line box is 1 em, so it overhangs 0.05 em), the block centred on y 1300 and flush left at x 112, scaled
 * about its left edge: push 1 + 0.07 (hero cue) or 0.04 over the cue, plus a kick of 0.035 (hero word) or 0.02 per word that
 * decays with a 90 ms time constant, plus 0.05 as it leaves.
 *
 * What changed from the sample, and why (gallery-2 brief, 2026-11-21):
 * - `MARK[ci]` (swipe, label, loop) and the `breaks` table are cue-indexed and baked into the demo text. Marks now cycle by a
 *   counter of the hero cues (swipe, label, loop, swipe ...), and rows come from the words: the lead and tail words wrap greedily
 *   into rows of at most 780 px, the key word is a row of its own (the demo's rows are exactly what these rules give). The
 *   swipe's ragged edge, its tilt (1.2 to 2.6 degrees, alternating side), the loop's end tilt and the scatter order of the
 *   letters are a seeded hash of the cue's index and words, never `Math.random` and never `sort(() => r() - 0.5)` (a seeded
 *   Fisher-Yates). A cue with no key word has the cursor on every cue, so the beat never goes quiet.
 * - Fit: the sample's rows had no width guard. A row that does not fit 780 px (or the safe area) shrinks, down to a floor of
 *   0.62 of its size and then to the full safe width; a stack that is too tall for the frame (16:9) shrinks as a whole; the
 *   marks and the cursor are counted in the width they need, and the block is shifted into the 5 % safe area. Marks, cursor and
 *   thickness scale with the row's size so a shrunk key word keeps its proportions.
 * - Right-to-left cues mirror the template: the stack is flush right, rows run right to left, wipes start at the right edge.
 *   Words in scripts that need shaping (Arabic, Urdu, Devanagari, Thai ...), CJK and emoji are never split into letters (the key
 *   word appears as one piece); capitals only for Latin, Greek and Cyrillic.
 * - The 30 px blurred shadow (`0 12px 30px`, a 15 px sigma) is a smaller soft shadow: the hard 6 px drop is kept exactly.
 * - Real speech: the sample's exit (110 ms ending 70 ms before the cue ends) never starts before the last word has been fully
 *   visible for 150 ms, and is shortened (down to 70 ms) when the next cue is close rather than cutting its entrance; a key
 *   word's marks are compressed to finish before the exit. The letters' 36 ms scatter step shrinks for a long word or a short
 *   hero so the whole word is there while it is still being said. The kick is capped at 0.045 so words said back to back do
 *   not stack up.
 * - The label bar's `0 10px 0` box-shadow is cut away by the sample's own `clip-path` (it never shows), so it is not drawn.
 * - The wipes of the swipe and the loop are the sample's `clip-path: inset()` as axis-aligned clips that follow the block's
 *   scale; the bar's wipe scales the rectangle about its edge so its hard shadow follows.
 */

export const BEAT_DEMO: DemoScript = {
  lines: [
    "talent:b gets:b you:m noticed:h@560",
    "habits:b keep:b you:m there",
    "show:b up",
    "anyway:h@600",
    "that's:m the:m whole:b secret:h@600",
  ],
  options: { rate: 280, cueGap: 150, tail: 760 },
};

const FACE = "Archivo Black" as const;
const LS = -0.01;
const BODY = 120;
const HERO = 150;
const GAP_EM = 0.22;
const ROW_EM = 0.9;
const CENTER_Y = 1300;
const LEFT = 112;
const MAX_W = 780;
/** How far the block's scale (push, kick, exit) can grow beyond 1 while anything is visible. */
const BLOCK_MAX = 1.13;
const PUSH_HERO = 0.07;
const PUSH_PLAIN = 0.04;
const KICK_HERO = 0.035;
const KICK_PLAIN = 0.02;
const KICK_TAU = 90;
const KICK_CAP = 0.045;
const EXIT_GROW = 0.05;
const POP_FROM = 1.12;
const POP_MS = 90;
const WORD_LEAD = 40;
const LETTER_LEAD = 70;
const LETTER_STEP = 36;
const MAX_LETTERS = 18;
const SHRINK_FLOOR = 0.62;
const EXIT = 110;
const CLEAR = 70;
const EXIT_MIN = 70;
/** A word stays fully visible this long before the cue's exit may begin. */
const HOLD = 150;
/** How far a cue's exit may run into the next cue (the engine ends a cue where the next one starts). */
const OVERLAP = 60;
const SWIPE_MS = 320;
const LABEL_MS = 200;
const LABEL_LEAD = 150;
const LOOP_MS = 380;
const LOOP_AFTER = 40;
const MARK_MIN = 120;
/** Room the marks need past the key word's row, and the cursor past a word (sample px, at the sample's sizes). */
const MARK_REACH = 52;
const CURSOR_REACH = 16 + 52;
const SOFT_ALPHA = 0.5;

export type BeatMark = "swipe" | "label" | "loop";
const MARKS: readonly BeatMark[] = ["swipe", "label", "loop"];

/** FNV-1a of a string: the seed that makes a cue's decoration a pure function of its index and words. */
export function beatHash(text: string): number {
  let h = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The sample's seeded generator (mulberry32). */
export function beatRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded Fisher-Yates permutation of 0..n-1: the order the key word's letters cut in. */
export function beatShuffle(n: number, r: () => number): number[] {
  const order = Array.from({ length: n }, (_, at) => at);
  for (let at = n - 1; at > 0; at--) {
    const to = Math.floor(r() * (at + 1));
    [order[at], order[to]] = [order[to]!, order[at]!];
  }
  return order;
}

const SIMPLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;
const PICTO = /\p{Extended_Pictographic}/u;

/** `text-transform: uppercase` for cased scripts only. */
export function beatCase(text: string): string {
  return SIMPLE.test(text) && !PICTO.test(text) ? text.toUpperCase() : text;
}

function graphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
  return Segmenter ? [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment) : [...text];
}

/** Chrome's baseline of a `line-height: 1` Archivo Black box: ascent 0.878 and descent 0.21 em round to whole px (100 of 120, 125 of 150). */
export function beatBaseline(sizePx: number): number {
  const ascent = Math.round(0.878 * sizePx);
  const descent = Math.round(0.21 * sizePx);
  return (sizePx - (ascent + descent)) / 2 + ascent;
}

/** The block's scale about its leading edge: slow push over the cue, a decaying kick per word, a small swell as it leaves. */
export function beatBlockScale(t: number, cue: { startMs: number; endMs: number; hero: boolean; wordStarts: readonly number[] }, exit: { from: number; dur: number }): number {
  const push = 1 + (cue.hero ? PUSH_HERO : PUSH_PLAIN) * EASES.out(prog(t, cue.startMs, Math.max(1, cue.endMs - cue.startMs)));
  return push + beatKick(t, cue.wordStarts, cue.hero) + EXIT_GROW * EASES.in(prog(t, exit.from, exit.dur));
}

function beatKick(t: number, starts: readonly number[], hero: boolean): number {
  let kick = 0;
  for (const start of starts) if (t >= start) kick += (hero ? KICK_HERO : KICK_PLAIN) * Math.exp(-(t - start) / KICK_TAU);
  return Math.min(KICK_CAP, kick);
}

interface Counters {
  heroes: number;
}

interface WordInfo {
  readonly index: number;
  readonly text: string;
  readonly hero: boolean;
  readonly letters: readonly string[] | null;
}

interface PlacedWord {
  readonly word: WordInfo;
  readonly left: number;
  readonly width: number;
}

interface RowGeo {
  readonly hero: boolean;
  /** Sample px. */
  readonly size: number;
  /** Canvas px. */
  readonly sizeC: number;
  readonly top: number;
  readonly words: PlacedWord[];
}

const quad = (from: readonly [number, number], control: readonly [number, number], to: readonly [number, number]): PathCmd => [
  "C",
  from[0] + (2 / 3) * (control[0] - from[0]),
  from[1] + (2 / 3) * (control[1] - from[1]),
  to[0] + (2 / 3) * (control[0] - to[0]),
  to[1] + (2 / 3) * (control[1] - to[1]),
  to[0],
  to[1],
];

function buildCue(cue: SceneCue, cueNumber: number, input: SceneInput, counters: Counters): Piece[] {
  const space = sceneSpace(input, CENTER_Y);
  const { u, safe } = space;
  const rtl = cueDirection(cue) === "rtl";
  const sgn = rtl ? -1 : 1;
  const edge = rtl ? space.x(1080 - LEFT) : space.x(LEFT);
  const PY = space.y(CENTER_Y);
  const band = cueNumber * 12;
  const seed = beatHash(`${cue.index}|${cue.words.map((word) => word.text).join(" ")}`);
  const hasHero = cue.words.some((word) => word.role === "hero");
  const heroNumber = hasHero ? counters.heroes++ : 0;

  const words: WordInfo[] = cue.words.map((word, index) => {
    const text = beatCase(word.text);
    const hero = word.role === "hero";
    const parts = graphemes(text);
    const letters = hero && !rtl && SIMPLE.test(text) && !PICTO.test(text) && parts.length > 1 && parts.length <= MAX_LETTERS ? parts : null;
    return { index, text, hero, letters };
  });
  const adv = (text: string, sizeC: number) => input.measure(text, FACE, sizeC, LS).advance + LS * sizeC;
  const wordWidth = (at: number, sizeC: number) => {
    const word = words[at]!;
    return word.letters ? word.letters.reduce((sum, ch) => sum + adv(ch, sizeC), 0) : adv(word.text, sizeC);
  };

  // --- rows: lead and tail words wrap greedily into short rows, each key word run is a row of its own ---
  const reach = (hero: boolean) => (hero ? MARK_REACH : hasHero ? 0 : CURSOR_REACH);
  const room = Math.max((rtl ? edge - safe.x1 : safe.x2 - edge) / BLOCK_MAX, 0.55 * ((safe.x2 - safe.x1) / BLOCK_MAX));
  const limitOf = (hero: boolean) => Math.min(MAX_W * u, room - reach(hero) * u);
  const hardOf = (hero: boolean) => room - reach(hero) * u;
  const segments: { hero: boolean; indices: number[] }[] = [];
  words.forEach((word) => {
    const last = segments[segments.length - 1];
    if (last && last.hero === word.hero) last.indices.push(word.index);
    else segments.push({ hero: word.hero, indices: [word.index] });
  });
  const plans: { hero: boolean; indices: number[] }[] = [];
  for (const segment of segments) {
    const base = (segment.hero ? HERO : BODY) * u;
    const widths = segment.indices.map((at) => wordWidth(at, base));
    const rows = segment.hero ? balancedRows(widths, GAP_EM * base, limitOf(true)) : greedyRows(widths, GAP_EM * base, limitOf(false));
    for (const row of rows) plans.push({ hero: segment.hero, indices: row.map((at) => segment.indices[at]!) });
  }

  const layout = (k: number): { rows: RowGeo[]; height: number } => {
    const sized = plans.map((plan) => {
      const base = (plan.hero ? HERO : BODY) * k;
      const natural = (s: number) => {
        const widths = plan.indices.map((at) => wordWidth(at, s * u));
        return rowWidth(widths, widths.map((_, at) => at), GAP_EM * s * u);
      };
      let size = base;
      let width = natural(size);
      if (width > limitOf(plan.hero)) {
        size *= limitOf(plan.hero) / width;
        width = natural(size);
        if (size < SHRINK_FLOOR * base) size = Math.min(base, base * (hardOf(plan.hero) / natural(base)));
        else if (width > limitOf(plan.hero)) size *= limitOf(plan.hero) / width;
        width = natural(size);
        if (width > hardOf(plan.hero)) size *= hardOf(plan.hero) / width;
      }
      return { plan, size };
    });
    const height = sized.reduce((sum, row) => sum + ROW_EM * row.size, 0);
    let top = PY - (height * u) / 2;
    const rows = sized.map(({ plan, size }): RowGeo => {
      const sizeC = size * u;
      const order = rtl ? rowVisualOrder(plan.indices.map((at) => words[at]!.text), "rtl").map((at) => plan.indices[at]!) : plan.indices;
      const widths = order.map((at) => wordWidth(at, sizeC));
      const total = rowWidth(widths, widths.map((_, at) => at), GAP_EM * sizeC);
      let left = rtl ? edge - total : edge;
      const placed = order.map((at, position): PlacedWord => {
        const box = { word: words[at]!, left, width: widths[position]! };
        left += widths[position]! + GAP_EM * sizeC;
        return box;
      });
      const row: RowGeo = { hero: plan.hero, size, sizeC, top, words: placed };
      top += ROW_EM * sizeC;
      return row;
    });
    return { rows, height };
  };
  // A stack too tall for the frame (16:9) shrinks as a whole.
  const availableHeight = (safe.y2 - safe.y1) / u / BLOCK_MAX;
  let fitted = layout(1);
  if (fitted.height > availableHeight) fitted = layout(Math.max(0.45, availableHeight / fitted.height));
  const { rows } = fitted;

  // --- timing: the sample's cut-ins; the exit waits for the last word to have been seen ---
  const spokenOf = (index: number) => cue.words[index]!;
  const starts = new Map<number, number[]>();
  const wordRng = beatRng(seed ^ 0x9e3779b9);
  for (const word of words) {
    const spoken = spokenOf(word.index);
    if (word.letters) {
      const n = word.letters.length;
      const step = clamp((0.7 * Math.max(spoken.endMs - spoken.startMs, 300)) / n, 10, LETTER_STEP);
      const ranks = new Array<number>(n);
      beatShuffle(n, wordRng).forEach((letter, at) => {
        ranks[letter] = at;
      });
      starts.set(word.index, ranks.map((rank) => spoken.startMs - LETTER_LEAD + rank * step));
    } else if (word.hero) starts.set(word.index, [spoken.startMs - LETTER_LEAD]);
    else starts.set(word.index, [spoken.startMs - WORD_LEAD]);
  }
  const landOf = (word: WordInfo) => (word.hero ? Math.max(...starts.get(word.index)!) : starts.get(word.index)![0]! + POP_MS);
  const lastLand = Math.max(...words.map(landOf));
  const exitFrom = Math.min(Math.max(cue.endMs - CLEAR - EXIT, lastLand + HOLD), cue.endMs + OVERLAP - EXIT_MIN);
  const exitDur = clamp(cue.endMs - CLEAR - exitFrom, EXIT_MIN, EXIT);
  const exitTo = exitFrom + exitDur;
  const wordStarts = cue.words.map((word) => word.startMs);
  const S = (t: number) => beatBlockScale(t, { startMs: cue.startMs, endMs: cue.endMs, hero: hasHero, wordStarts }, { from: exitFrom, dur: exitDur });
  const about = (centre: number, p: number, t: number) => centre + S(t) * (p - centre);
  const baseEdges = [cue.startMs, cue.endMs, exitFrom, exitTo, ...wordStarts, ...wordStarts.map((at) => at + KICK_TAU)];
  const chan = (fn: (t: number) => number, from: number, to: number, edges: readonly number[], tolerance: number) =>
    sampleFrames(fn, [from, ...edges, ...baseEdges, to], tolerance, { range: [from, to], wholeMs: true, simplify: true });
  const fade = (from: number) => (from < exitFrom ? ([[from, 1], [exitFrom, 1], [exitTo, 0, "in"]] as const) : ([[from, 1], [exitTo, 0, "in"]] as const));
  /** A piece carried by the block: rest pivot (px, py), own scale and turn; `bx` is the pivot x of the block. */
  const carried = (px: number, py: number, from: number, own: (t: number) => number, edges: readonly number[], rz?: Frames_): Track => ({
    x: chan((t) => about(edge, px, t), from, exitTo, edges, 0.2),
    y: chan((t) => about(PY, py, t), from, exitTo, edges, 0.2),
    sx: chan((t) => S(t) * own(t), from, exitTo, edges, 0.002),
    sy: chan((t) => S(t) * own(t), from, exitTo, edges, 0.002),
    o: fade(from),
    ...(rz ? { rz } : {}),
  });

  const pieces: Piece[] = [];
  const hard = input.colours.accent;

  // --- words ---
  const markRow = hasHero ? rows.find((row) => row.hero) ?? null : null;
  const markKind = MARKS[heroNumber % MARKS.length]!;
  const labelled = markRow !== null && markKind === "label";
  const centreOf = (row: RowGeo) => row.top + 0.45 * row.sizeC;
  const wordsOnScreen: { row: RowGeo; placed: PlacedWord }[] = [];
  for (const row of rows) {
    const s = row.sizeC;
    const cy = centreOf(row);
    const baseline = row.top - 0.05 * s + beatBaseline(s);
    const onBar = labelled && row === markRow;
    const shadows = onBar
      ? undefined
      : [
          { dx: 0, dy: 6 * (s / HERO), blur: 0, colour: hard, alpha: 1 },
          { dx: 0, dy: 10 * (s / HERO), blur: 6 * (s / HERO), colour: input.colours.shadow, alpha: SOFT_ALPHA },
        ];
    for (const placed of row.words) {
      wordsOnScreen.push({ row, placed });
      const { word } = placed;
      const mk = (id: string, text: string, left: number, width: number, from: number, own: (t: number) => number, edges: readonly number[]): TextPiece => ({
        id: `beat:${cueNumber}:${id}`,
        kind: "text",
        z: band + 2,
        fromMs: from,
        toMs: exitTo,
        track: carried(left + width / 2, cy, from, own, edges),
        origin: { dx: width / 2, dy: cy - baseline },
        text,
        face: FACE,
        sizePx: s,
        letterSpacingEm: LS,
        fill: onBar ? hard : input.colours.primary,
        ...(shadows ? { shadows } : {}),
        anchor: "baseline-left",
        language: cue.language,
      });
      const at = starts.get(word.index)!;
      if (!word.hero) {
        pieces.push(mk(`w${word.index}`, word.text, placed.left, placed.width, at[0]!, (t) => lerp(POP_FROM, 1, EASES.out(prog(t, at[0]!, POP_MS))), [at[0]! + POP_MS]));
      } else if (word.letters) {
        let x = placed.left;
        word.letters.forEach((ch, j) => {
          const w = adv(ch, s);
          pieces.push(mk(`w${word.index}l${j}`, ch, x, w, at[j]!, () => 1, []));
          x += w;
        });
      } else pieces.push(mk(`w${word.index}`, word.text, placed.left, placed.width, at[0]!, () => 1, []));
    }
  }

  // --- the key word's mark ---
  const shape = (id: string, path: readonly PathCmd[], pivot: { x: number; y: number } /* local, from the path's own origin */, from: number, track: (bounds: ReturnType<typeof pathBounds>) => Track, extra: Partial<ShapePiece>, z: number): ShapePiece => {
    const bounds = pathBounds(path);
    const local = path.map((cmd) => {
      if (cmd[0] === "Z") return cmd;
      const mapped: number[] = [];
      for (let at = 1; at < cmd.length; at += 2) mapped.push((cmd[at] as number) - bounds.x1, (cmd[at + 1] as number) - bounds.y1);
      return [cmd[0], ...mapped] as unknown as PathCmd;
    });
    return {
      id: `beat:${cueNumber}:${id}`,
      kind: "shape",
      z,
      fromMs: from,
      toMs: exitTo,
      origin: { dx: pivot.x - bounds.x1, dy: pivot.y - bounds.y1 },
      path: local,
      track: track(bounds),
      ...extra,
    } as ShapePiece;
  };
  /** An axis-aligned wipe rectangle (canvas px, rest position) that grows from `start` along the reading direction, carried by the block's scale. */
  const wipeClip = (from: number, x0: number, x1: number, y0: number, y1: number, p: (t: number) => number, edges: readonly number[]): Clip => {
    const end = (t: number) => x0 + (x1 - x0) * p(t);
    const a = (t: number) => about(edge, x0, t);
    const b = (t: number) => about(edge, end(t), t);
    return {
      x1: chan((t) => Math.min(a(t), b(t)), from, exitTo, edges, 0.2),
      x2: chan((t) => Math.max(a(t), b(t)), from, exitTo, edges, 0.2),
      y1: chan((t) => about(PY, y0, t), from, exitTo, edges, 0.2),
      y2: chan((t) => about(PY, y1, t), from, exitTo, edges, 0.2),
    };
  };

  if (markRow) {
    const s = markRow.sizeC;
    const m = s / (HERO * u);
    const heroWords = markRow.words;
    const left = Math.min(...heroWords.map((p) => p.left));
    const right = Math.max(...heroWords.map((p) => p.left + p.width));
    const span = right - left;
    const cx = (left + right) / 2;
    const cy = centreOf(markRow);
    // The reading order: the first and last key word of the row by time.
    const byTime = [...heroWords].sort((a, b) => spokenOf(a.word.index).startMs - spokenOf(b.word.index).startMs);
    const firstWord = byTime[0]!.word;
    const lastWord = byTime[byTime.length - 1]!.word;
    const lettersDone = (word: WordInfo) => Math.max(...starts.get(word.index)!);
    const done = lettersDone(lastWord);
    /** Duration of a mark window that starts at `at`, compressed to end before the exit when it can. */
    const fitDur = (at: number, nominal: number) => clamp(exitFrom - at, Math.min(MARK_MIN, nominal), nominal);
    if (markKind === "swipe") {
      const bw = span + 24 * m * u;
      const bh = 40 * m * u;
      const r = beatRng(seed ^ 0x51ed270b);
      const k = (v: number) => v * m * u;
      const pts: [number, number][] = [[0, k(14)]];
      for (let i = 1; i <= 9; i++) pts.push([(bw * i) / 10, k(3 + r() * 5 + (i > 7 ? (i - 7) * 3 : 0))]);
      pts.push([bw, k(8)], [bw - k(10 + r() * 8), k(15)], [bw + k(4), k(19)], [bw - k(24), k(24)]);
      for (let i = 9; i >= 1; i--) pts.push([(bw * i) / 10, bh - k(2 + r() * 5 + (i < 2 ? 4 : 0))]);
      pts.push([k(6), k(22)]);
      const mirrored = pts.map(([x, y]): [number, number] => [sgn > 0 ? x : bw - x, y]);
      const path: PathCmd[] = [["M", mirrored[0]![0], mirrored[0]![1]], ...mirrored.slice(1).map(([x, y]) => ["L", x, y] as PathCmd), ["Z"]];
      const x0 = sgn > 0 ? left - k(24) : right + k(24) - bw;
      const top = markRow.top + 0.8 * s;
      const tilt = (1.2 + 1.4 * r()) * (heroNumber % 2 === 0 ? -1 : 1) * sgn;
      const at = done;
      const dur = fitDur(at, SWIPE_MS);
      const p = (t: number) => EASES.outExpo(prog(t, at, dur));
      const from = Math.round(at) + 1;
      const pivot = { x: x0 + bw / 2, y: top + bh / 2 };
      const clipStart = sgn > 0 ? x0 - k(10) : x0 + bw + k(10);
      const clipEnd = sgn > 0 ? x0 + bw + k(12) : x0 - k(12);
      pieces.push(
        shape(
          "mark",
          path,
          { x: bw / 2, y: bh / 2 },
          from,
          () => ({ ...carried(pivot.x, pivot.y, from, () => 1, [at, at + dur], undefined), rz: [[from, tilt]] }),
          { fill: { colour: input.colours.highlight }, clip: wipeClip(from, clipStart, clipEnd, top - k(10), top + bh + k(10), p, [at, at + dur]) },
          band + 1,
        ),
      );
    } else if (markKind === "label") {
      const pad = 26 * m * u;
      const h = 0.92 * s + 12 * m * u;
      const w = span + 2 * pad;
      const x0 = sgn > 0 ? left - pad : right + pad;
      const at = spokenOf(firstWord.index).startMs - LABEL_LEAD;
      const dur = fitDur(at, LABEL_MS);
      const from = Math.round(at) + 4;
      const wipe = (t: number) => Math.max(0.02, EASES.outExpo(prog(t, at, dur)));
      const pivot = { x: x0, y: cy };
      pieces.push(
        shape(
          "mark",
          rectPath(0, 0, w, h),
          { x: sgn > 0 ? 0 : w, y: h / 2 },
          from,
          () => {
            const base = carried(pivot.x, pivot.y, from, () => 1, [at + dur]);
            return { ...base, sx: chan((t) => S(t) * wipe(t), from, exitTo, [at + dur], 0.002) };
          },
          { fill: { colour: input.colours.primary } },
          band + 1,
        ),
      );
    } else {
      const lw = span + 90 * m * u;
      const lh = 1.2 * s;
      const stroke = 9 * m * u;
      const r = beatRng(seed ^ 0x2545f491);
      const endTilt = (3.5 + 3 * r()) * (heroNumber % 2 === 0 ? -1 : 1) * sgn;
      const startTilt = endTilt * (14 / 5) ;
      const rx = lw / 2 - 6 * m * u;
      const ry = lh / 2 - 6 * m * u;
      const flip = (x: number) => (sgn > 0 ? x : lw - x);
      const ring = ellipsePath(lw / 2, lh / 2, rx, ry);
      const over: PathCmd[] = [["M", flip(lw * 0.12), lh * 0.28], quad([flip(lw * 0.12), lh * 0.28], [flip(lw * 0.3), -lh * 0.06], [flip(lw * 0.62), lh * 0.02])];
      const path = [...ring, ...over];
      const at = done + LOOP_AFTER;
      const dur = fitDur(at, LOOP_MS);
      const p = (t: number) => EASES.out(prog(t, at, dur));
      const from = Math.round(at) + 1;
      const pivot = { x: cx, y: cy + 8 * m * u };
      const margin = 34 * m * u;
      const clipStart = sgn > 0 ? cx - lw / 2 - margin : cx + lw / 2 + margin;
      const clipEnd = sgn > 0 ? cx + lw / 2 + margin : cx - lw / 2 - margin;
      const turn = chan((t) => lerp(startTilt, endTilt, p(t)), from, exitTo, [at + dur], 0.08);
      pieces.push(
        shape(
          "mark",
          path,
          { x: lw / 2, y: lh / 2 },
          from,
          () => ({ ...carried(pivot.x, pivot.y, from, () => 1, [at + dur]), rz: turn }),
          { stroke: { widthPx: stroke, colour: input.colours.highlight }, clip: wipeClip(from, clipStart, clipEnd, pivot.y - lh * 0.8, pivot.y + lh * 0.8, p, [at + dur]) },
          band + 1,
        ),
      );
    }
  } else {
    // --- no key word: a cursor hops to the end of each word as it lands ---
    const spots = wordsOnScreen
      .map(({ row, placed }) => ({ row, placed, at: starts.get(placed.word.index)![0]! }))
      .sort((a, b) => a.at - b.at);
    spots.forEach((spot, at) => {
      const f = spot.row.sizeC / (BODY * u);
      const w = 52 * f * u;
      const h = 15 * f * u;
      const x = sgn > 0 ? spot.placed.left + spot.placed.width + 16 * f * u + w / 2 : spot.placed.left - 16 * f * u - w / 2;
      const y = centreOf(spot.row) + 0.3 * spot.row.sizeC + 0.5 * f * u;
      const from = Math.round(spot.at);
      const to = at + 1 < spots.length ? Math.max(from + 2, Math.round(spots[at + 1]!.at)) : exitTo;
      const pop = (t: number) => lerp(1.6, 1, EASES.outExpo(prog(t, spot.at, 140)));
      const track = carried(x, y, from, () => 1, [spot.at + 140]);
      const sxFrames = chan((t) => S(t) * pop(t), from, to, [spot.at + 140], 0.002);
      const cut = (frames: ReturnType<typeof chan>) => sampleCut(frames, from, to);
      pieces.push({
        id: `beat:${cueNumber}:cur${at}`,
        kind: "shape",
        z: band + 3,
        fromMs: from,
        toMs: to,
        origin: { dx: w / 2, dy: h / 2 },
        path: rectPath(0, 0, w, h),
        fill: { colour: input.colours.highlight },
        shadows: [{ dx: 0, dy: 6 * f * u, blur: 0, colour: hard, alpha: 1 }],
        track: { x: cut(track.x!), y: cut(track.y!), sx: cut(sxFrames), sy: cut(track.sy!), o: to >= exitTo ? fade(from) : [[from, 1]] },
      });
    });
  }

  return clampToSafeArea(pieces, safe, input.measure);
}

type Frames_ = NonNullable<Track["x"]>;

/** The frames of a channel restricted to [from, to]: the value at both ends, the frames between them. */
function sampleCut(frames: Frames_, from: number, to: number): Frames_ {
  if (frames.length === 0) return frames;
  const at = (t: number) => {
    let previous = frames[0]!;
    for (const frame of frames) {
      if (frame[0] >= t) {
        if (frame[0] === previous[0]) return frame[1];
        const along = (t - previous[0]) / (frame[0] - previous[0]);
        return previous[1] + (frame[1] - previous[1]) * along;
      }
      previous = frame;
    }
    return previous[1];
  };
  const inner = frames.filter((frame) => frame[0] > from && frame[0] < to);
  return [[from, at(from)], ...inner, [to, at(to)]] as Frames_;
}

export const beatProgram: SceneProgram = {
  build(input) {
    const counters: Counters = { heroes: 0 };
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, input, counters))) };
  },
};
