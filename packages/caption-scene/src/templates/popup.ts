import type { DemoScript } from "../demo";
import { EASES, type Frames, prog } from "../ease";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, sceneSpace } from "../layout";
import { type Box, type PathCmd, type Piece, type ShapePiece, type TextPiece, type Track, sceneBoundsAt } from "../scene";
import { ellipsePath, pathBounds, polygonPath, roundedRectPath } from "../shapes";

/**
 * Popup (`samples/templates/m16-y2k.js`): a Y2K desktop sticker pop. Spoken words are chunky white Lilita One letters
 * with a violet outline and a hard block shadow that pop in with an overshoot. The hero opens a retro OS window (pink
 * title bar, three dots) that cascades into a stack of two copies; inside, the hero pops in letter by letter in
 * alternating pastels over a pink starburst, with three sparkles, and bobs gently while it holds.
 *
 * Geometry is the sample's, read in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`): body words are Lilita One
 * 92 px (outline 8, shadow 6 / 8) in rows 6 / 14 px padded and 26 px apart; the hero is Chango at the size that makes its
 * letters 640 px long (130 px at most), in a window 0.84 em plus 10 px wider than them and 60 px plus 1.52 em tall
 * (5 px violet border, 50 px title bar); the block is centred on y 1290.
 *
 * What changed from the sample, and why:
 * - Words that need shaping (Arabic, Urdu, Devanagari, ...) and CJK are never split into letters: the hero pops as one word.
 *   The window's chrome mirrors for a right-to-left cue (dots, starburst and cascade on the right).
 * - Nothing is cue-indexed. The hero cues cycle through variants by a counter of hero cues: the pastel the letters start
 *   on (4), the side the copies cascade to (2), where the starburst sits (start, end, middle of the word) and its spike
 *   count, and the sparkles mirror with the cascade. A cue without a hero (the sample draws only its words) gets two small
 *   sparkles that twinkle on its first and last word, cycling among three placements by a counter of those cues.
 * - A very long hero shrinks past the sample's 640 px letter run until the window and its sparkles fit the safe area.
 *   Rows of body words shrink for a word wider than a row, and wrap evenly (the sample wraps greedily).
 * - The window, starburst and sparkles are drawn from the cue's start, not at a fixed offset: sparkles anchor to the window's
 *   corners (hero) or to a word's box (no hero).
 * - Real speech: the sample's exit (170 ms before `end - 40`) would hide the last word almost as it lands when cues run
 *   back to back. The exit now waits until the last spoken word (the hero's last letter) has been fully visible for 160 ms,
 *   shortening to 100 ms (never under 70) and running at most 40 ms into the next cue's entrance.
 * - The sample's invented timing constants are kept, but jitter comes from the sample's own hash of the word's index and
 *   start time (words) and of the hero counter (starburst, letters), never `Math.random`.
 *
 * The starburst's 13 spikes, the letters' tilts and the starburst jitter are the sample's `rnd`, exactly, for the first hero.
 */

export const POPUP_DEMO: DemoScript = {
  lines: [
    "my:m edits:b used:b to:m take:b hours",
    "now:m it's:m basically:b instant:h@600",
    "one:m button",
    "and:m it:m looks:b so:m clean:h@600",
    "seriously:h@640 try:b it",
  ],
  options: { rate: 270 },
};

const CX = 540;
const CENTER_Y = 1290;
const BODY = 92;
const BODY_FACE = "Lilita One" as const;
const HERO_FACE = "Chango" as const;
const LS = 0.01;
const OUT = 8;
const SHADOW = { dx: 6, dy: 8 } as const;
const ROW_MAX = 900;
const ROW_GAP = 26;
const ROW_LINE_GAP = 4;
const ROW_PAD = { top: 6, bottom: 14 } as const;
const HERO_MAX = 130;
const HERO_FIT = 640;
const HERO_LINE = 1.1;
const BAR = 50;
const EDGE = 5;
const RADIUS = 16;
const DOT = { box: 24, gap: 10, pad: 18 } as const;
const INK = "#2A1A5E";
const MINT = "#7DE0C1";
const VIOLET = "#B58CFF";
const WINDOW = "#FFFFFF";
const WORD_POP = 380;
const WIN_POP = 260;
const EXIT = 170;
const EXIT_SCALE = 0.75;
/** The exit's opacity is 1 - p^3, so it is still above 0.9 until this share of the window. */
const CLEAR_SHARE = 0.1 ** (1 / 3);
const READ_MS = 160;
const SHORT_EXIT = 100;
const LETTER_STEP = 9;
const BOB_MS = 1700;
const BOB_PX = 4;
const MAX_LETTERS = 24;
/** The most the spring ever scales a popping word. */
const SPRING_PEAK = Math.max(...Array.from({ length: 201 }, (_, at) => EASES.spring(at / 200)));

type Fn = (t: number) => number;

/** The sample's `outBack(p, s)`: the named ease is fixed at 1.70158. */
const outBack = (p: number, s: number) => 1 + (s + 1) * (p - 1) ** 3 + s * (p - 1) ** 2;

/** The sample's seeded jitter. */
const rnd = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const SIMPLE_SCRIPT = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]+$/u;

/** The letters of a hero: grapheme clusters of a simple script, else the whole word (no letter splitting for shaped scripts or CJK). */
export function popupLetters(text: string): string[] {
  if (!SIMPLE_SCRIPT.test(text)) return [text];
  const letters = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
  return letters.length > MAX_LETTERS ? [text] : letters;
}

/** Chrome's baseline of a `line-height: L` box: the face's rounded ascent and descent, half-leading, floored. */
function baselineOf(size: number, line: number, ascent: number, descent: number): number {
  const a = Math.round(ascent * size);
  const d = Math.round(descent * size);
  return Math.floor(a + (line * size - a - d) / 2);
}
export const popupBodyBaseline = (size: number) => baselineOf(size, 1, 0.923, 0.22);
export const popupHeroBaseline = (size: number) => baselineOf(size, HERO_LINE, 0.995, 0.216);

/** The sample's window size for a hero of `size` whose letters are `lettersWidth` long (both sample px), whole px as `offsetWidth` reads. */
export function popupWindow(size: number, lettersWidth: number): { width: number; height: number } {
  return { width: Math.round(2 * EDGE + 0.84 * size + lettersWidth), height: Math.round(EDGE + BAR + 0.16 * size + HERO_LINE * size + 0.26 * size + EDGE) };
}

/** The sample's starburst polygon in its 120 unit view box, `variant` shifting the jitter (0 is the sample's). */
export function popupBurstPoints(spikes: number, variant: number): [number, number][] {
  return Array.from({ length: spikes * 2 }, (_, i) => {
    const a = (Math.PI * i) / spikes - Math.PI / 2;
    const r = i % 2 ? 36 : 58 * (0.86 + 0.14 * rnd(i + 3 + 29 * variant));
    return [Math.round(Math.cos(a) * r * 10) / 10, Math.round(Math.sin(a) * r * 10) / 10];
  });
}

function sparkPath(r: number): PathCmd[] {
  const k = r * 0.2;
  return [["M", 0, -r], ["C", k, -k, k, -k, r, 0], ["C", k, k, k, k, 0, r], ["C", -k, k, -k, k, -r, 0], ["C", -k, -k, -k, -k, 0, -r], ["Z"]];
}

/** The path drawn from its own top-left with the pivot (in the path's coordinates) given as `origin`: libass places a drawing by its box. */
function anchored(path: readonly PathCmd[], pivot = { x: 0, y: 0 }): { path: PathCmd[]; origin: { dx: number; dy: number } } {
  const box = pathBounds(path);
  const moved = path.map((cmd): PathCmd => {
    if (cmd[0] === "Z") return cmd;
    if (cmd[0] === "C") return ["C", cmd[1] - box.x1, cmd[2] - box.y1, cmd[3] - box.x1, cmd[4] - box.y1, cmd[5] - box.x1, cmd[6] - box.y1];
    return [cmd[0], cmd[1] - box.x1, cmd[2] - box.y1];
  });
  return { path: moved, origin: { dx: pivot.x - box.x1, dy: pivot.y - box.y1 } };
}

/** The sample's pop of a body word, `p` 0..1 over 380 ms: scale, rise in sample px, tilt in degrees (before the word's tilt). */
export function popupWordPop(p: number): { scale: number; rise: number; tilt: number } {
  return { scale: Math.max(0, EASES.spring(p)), rise: (1 - EASES.outExpo(p)) * 40, tilt: 1 - EASES.out(p) };
}

/** Cue counters of the two cycles: how many cues before this one had a hero, and how many had none. */
function cycleCounters(cues: readonly SceneCue[]): { hero: number; plain: number }[] {
  let hero = 0;
  let plain = 0;
  return cues.map((cue) => {
    const counters = { hero, plain };
    if (cue.words.some((word) => word.role === "hero")) hero++;
    else plain++;
    return counters;
  });
}

interface Ctx {
  readonly ox: number;
  readonly oy: number;
  readonly exitFrom: number;
  readonly exitTo: number;
  readonly e: Fn;
}

interface Motion {
  readonly from: number;
  readonly x: Fn;
  readonly y: Fn;
  readonly sx?: Fn;
  readonly sy?: Fn;
  readonly rz?: Fn;
  readonly edges: readonly number[];
}

/**
 * One piece's track: its own motion composed with the cue's exit (the block shrinks about its centre and fades), sampled
 * between every window's edges; a constant stays one frame, so a settled piece costs libass nothing.
 */
function trackOf(ctx: Ctx, m: Motion): { fromMs: number; toMs: number; track: Track } | null {
  const fromMs = m.from;
  const toMs = ctx.exitTo;
  if (fromMs >= toMs) return null;
  const edges = [...m.edges, ctx.exitFrom, ctx.exitTo];
  const sample = (fn: Fn, tolerance: number): Frames => sampleFrames(fn, edges, tolerance, { range: [fromMs, toMs], simplify: true });
  const exitScale: Frames = [[ctx.exitFrom, 1], [ctx.exitTo, EXIT_SCALE, "in"]];
  const track: Track = {
    x: sample((t) => ctx.ox + ctx.e(t) * (m.x(t) - ctx.ox), 0.25),
    y: sample((t) => ctx.oy + ctx.e(t) * (m.y(t) - ctx.oy), 0.25),
    sx: m.sx ? sample((t) => m.sx!(t) * ctx.e(t), 0.004) : exitScale,
    sy: m.sy ? sample((t) => m.sy!(t) * ctx.e(t), 0.004) : exitScale,
    o: [[ctx.exitFrom, 1], [ctx.exitTo, 0, "in"]],
  };
  if (m.rz) track.rz = sample(m.rz, 0.05);
  return { fromMs, toMs, track };
}

const quarterEdges = (from: number, step: number, until: number) => {
  const edges: number[] = [];
  for (let at = from + step; at < until; at += step) edges.push(at);
  return edges;
};

interface Placed {
  readonly index: number;
  /** Sample px: left edge of the word's box and top of its line box. */
  readonly left: number;
  readonly top: number;
  readonly box: number;
  readonly size: number;
}

function buildCue(cue: SceneCue, cueNumber: number, counters: { hero: number; plain: number }, input: SceneInput): Piece[] {
  const space = sceneSpace(input, CENTER_Y);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const startSign = rtl ? -1 : 1;
  const band = cueNumber * 100;
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const hero = heroAt >= 0 ? cue.words[heroAt]! : null;
  const heroLetters = hero ? popupLetters(hero.text) : [];
  const heroCue = counters.hero;
  const plainCue = counters.plain;
  const accent = input.colours.accent;
  const highlight = input.colours.highlight;
  const palette = [MINT, VIOLET, highlight, accent];

  // --- the exit: 170 ms ending 40 ms before the cue's end, held back until the last word has been read for 160 ms ---
  const lastLand = Math.max(...cue.words.map((word, at) => word.startMs + (at === heroAt ? LETTER_STEP * (heroLetters.length - 1) : 0)));
  const readUntil = lastLand + READ_MS;
  const base = { from: cue.endMs - 40 - EXIT, to: cue.endMs - 40 };
  const held = Math.round(readUntil - CLEAR_SHARE * SHORT_EXIT) - 4;
  // Never later than 40 ms into the next cue (cue ends already leave a last word 100 ms), and at least 70 ms long.
  const to = Math.min(held + SHORT_EXIT, cue.endMs + 40);
  const window = base.from + CLEAR_SHARE * EXIT >= readUntil ? base : { from: Math.min(held, to - 70), to };
  const ctx: Ctx = {
    ox: space.x(CX),
    oy: space.y(CENTER_Y),
    exitFrom: window.from,
    exitTo: window.to,
    e: (t) => 1 - (1 - EXIT_SCALE) * EASES.in(prog(t, window.from, window.to - window.from)),
  };

  // --- body words: Lilita One rows, wrapped evenly, shrunk for a word wider than a row ---
  const limit = Math.min(ROW_MAX, (0.9 * space.canvas.width) / u - 30);
  interface Group {
    readonly size: number;
    readonly k: number;
    readonly rows: { indices: number[]; width: number }[];
    readonly widths: Map<number, number>;
    readonly height: number;
  }
  const bodyGroup = (indices: readonly number[], reserve: number): Group | null => {
    if (indices.length === 0) return null;
    const widthsAt = (size: number) => indices.map((at) => input.measure(cue.words[at]!.text, BODY_FACE, size * u, LS).advance / u + LS * size);
    let size = BODY;
    let widths = widthsAt(size);
    const shrink = fitScale(Math.max(...widths) * SPRING_PEAK + 24, limit - reserve);
    if (shrink < 1) {
      size = BODY * shrink;
      widths = widthsAt(size);
    }
    const k = size / BODY;
    const gap = ROW_GAP * k;
    const lines = balancedRows(widths, gap, limit - reserve);
    const rows = lines.map((line) => {
      const ordered = rowVisualOrder(line.map((at) => cue.words[indices[at]!]!.text), rtl ? "rtl" : "ltr").map((at) => line[at]!);
      return { indices: ordered.map((at) => indices[at]!), width: ordered.reduce((sum, at) => sum + widths[at]!, 0) + gap * (ordered.length - 1) };
    });
    return {
      size,
      k,
      rows,
      widths: new Map(indices.map((at, i) => [at, widths[i]!])),
      height: (ROW_PAD.top + ROW_PAD.bottom) * k + rows.length * size + (rows.length - 1) * ROW_LINE_GAP * k,
    };
  };
  const placeGroup = (group: Group, top: number): Placed[] =>
    group.rows.flatMap((row, line) => {
      const rowTop = top + (ROW_PAD.top + line * ROW_LINE_GAP) * group.k + line * group.size;
      let x = CX - row.width / 2;
      return row.indices.map((index) => {
        const box = group.widths.get(index)!;
        const placed = { index, left: x, top: rowTop, box, size: group.size };
        x += box + ROW_GAP * group.k;
        return placed;
      });
    });

  const pieces: Piece[] = [];
  const add = (piece: Piece | null) => {
    if (piece) pieces.push(piece);
  };

  const wordPiece = (placed: Placed): TextPiece | null => {
    const word = cue.words[placed.index]!;
    const ws = word.startMs - 70;
    const k = placed.size / BODY;
    const jitter = (rnd(placed.index + word.startMs) - 0.5) * 10;
    const px = space.x(placed.left + placed.box / 2);
    const py = space.y(placed.top + 0.8 * placed.size);
    const baseline = space.y(placed.top + popupBodyBaseline(placed.size));
    const pop = (t: number) => prog(t, ws, WORD_POP);
    const moved = trackOf(ctx, {
      from: ws + 4,
      x: () => px,
      y: (t) => py + (1 - EASES.outExpo(pop(t))) * 40 * u,
      sx: (t) => EASES.spring(pop(t)),
      sy: (t) => EASES.spring(pop(t)),
      rz: (t) => jitter * (1 - EASES.out(pop(t))),
      edges: [ws, ws + WORD_POP],
    });
    if (!moved) return null;
    return {
      id: `popup:${cueNumber}:w${placed.index}`,
      kind: "text",
      z: band + 8,
      ...moved,
      origin: { dx: (placed.box * u) / 2, dy: py - baseline },
      text: word.text,
      face: BODY_FACE,
      sizePx: placed.size * u,
      letterSpacingEm: LS,
      fill: input.colours.primary,
      stroke: { widthPx: OUT * k * u, colour: INK },
      shadows: [{ dx: SHADOW.dx * k * u, dy: SHADOW.dy * k * u, blur: 0, colour: INK, alpha: 1 }],
      anchor: "baseline-left",
      language: cue.language,
    };
  };

  /** A sparkle twinkling at canvas (cx, cy): a spring pop with a turn, then a pulse until the exit. */
  const sparkle = (part: string, z: number, cx: number, cy: number, radius: number, at: number, colour: string): ShapePiece | null => {
    const vb = radius / (radius + 4);
    const shape = anchored(sparkPath(radius * u * vb));
    const pop = (t: number) => EASES.spring(prog(t, at, 360));
    const pulse = (t: number) => 1 + 0.12 * Math.sin(((t - at) / 900) * Math.PI * 2) * EASES.out(prog(t, at + 360, 200));
    const moved = trackOf(ctx, {
      from: at + 4,
      x: () => cx,
      y: () => cy,
      sx: (t) => Math.max(0, pop(t)) * pulse(t),
      sy: (t) => Math.max(0, pop(t)) * pulse(t),
      rz: (t) => (1 - pop(t)) * 120,
      edges: [at, at + 360, at + 560, ...quarterEdges(at + 560, 225, ctx.exitFrom)],
    });
    if (!moved) return null;
    return { id: `popup:${cueNumber}:${part}`, kind: "shape", z: band + z, ...moved, origin: shape.origin, path: shape.path, fill: { colour }, stroke: { widthPx: 3 * vb * u, colour: INK } };
  };

  if (!hero) {
    // No hero: the words alone in one block, and two small sparkles on its first and last word.
    const group = bodyGroup(cue.words.map((_, at) => at), 60)!;
    const top = CENTER_Y - group.height / 2;
    const placed = placeGroup(group, top);
    for (const item of placed) add(wordPiece(item));
    const byIndex = [...placed].sort((a, b) => a.index - b.index);
    const first = byIndex[0]!;
    const last = byIndex[byIndex.length - 1]!;
    const middle = byIndex[Math.floor((byIndex.length - 1) / 2)]!;
    const corner = (p: Placed, sx: -1 | 0 | 1, sy: -1 | 1, reach: number) => ({ x: space.x(p.left + p.box / 2 + (sx * p.box) / 2 + sx * reach * 0.4), y: space.y(p.top + p.size * 0.5 + (sy * p.size) / 2 + sy * reach * 0.1) });
    const cycle = plainCue % 3;
    const bigAt = [last, first, middle][cycle]!;
    const smallAt = [first, last, last][cycle]!;
    const big = corner(bigAt, cycle === 2 ? 0 : cycle === 0 ? 1 : -1, -1, 26);
    const small = corner(smallAt, cycle === 0 ? -1 : 1, 1, 15);
    const bigWord = cue.words[bigAt.index]!;
    const smallWord = cue.words[smallAt.index]!;
    add(sparkle("sp0", 20, big.x, big.y, 26, bigWord.startMs + 120, highlight));
    add(sparkle("sp1", 20, small.x, small.y, 15, smallWord.startMs + 200, plainCue % 2 === 0 ? accent : highlight));
    return clampToSafeArea(pieces, space.safe, input.measure);
  }

  // --- a hero: lead words, the window, the tail words ---
  const lead = cue.words.slice(0, heroAt).map((_, at) => at);
  const tail = cue.words.slice(heroAt + 1).map((_, at) => heroAt + 1 + at);
  const leadGroup = bodyGroup(lead, 0);
  const tailGroup = bodyGroup(tail, 0);
  const letterWidths = (size: number) => heroLetters.map((letter) => input.measure(letter, HERO_FACE, size * u, LS).advance / u + LS * size);
  const probe = Math.round(input.measure(hero.text, HERO_FACE, HERO_MAX * u, LS).advance / u + LS * HERO_MAX);
  const natural = Math.min(HERO_MAX, (HERO_MAX * HERO_FIT) / Math.max(1, probe));
  const dir = (heroCue % 2 === 0 ? 1 : -1) * startSign;
  const burstSide = ([1, -1, 0] as const)[heroCue % 3]! * startSign;
  const spikes = ([13, 11, 15] as const)[heroCue % 3]!;
  const offset = heroCue % palette.length;

  const heroPieces = (size: number): Piece[] => {
    const out: Piece[] = [];
    const push = (piece: Piece | null) => {
      if (piece) out.push(piece);
    };
    const widths = letterWidths(size);
    const lettersWidth = widths.reduce((sum, w) => sum + w, 0);
    const win = popupWindow(size, lettersWidth);
    const leadH = leadGroup ? leadGroup.height : 0;
    const tailH = tailGroup ? tailGroup.height : 0;
    const total = leadH + 4 + win.height + 10 + tailH;
    const blockTop = CENTER_Y - total / 2;
    const holderTop = blockTop + leadH + 4;
    const holderLeft = CX - win.width / 2;
    if (leadGroup) for (const item of placeGroup(leadGroup, blockTop)) push(wordPiece(item));
    if (tailGroup) for (const item of placeGroup(tailGroup, holderTop + win.height + 10)) push(wordPiece(item));

    const hs = hero.startMs;
    const winAt = hs - 80;
    const winCx = space.x(holderLeft + win.width / 2);
    const winCy = space.y(holderTop + win.height / 2);
    const sw = (t: number) => 0.6 + 0.4 * outBack(prog(t, winAt, WIN_POP), 1.2);
    /** A point of the window at rest, moved by the window's scale about its centre. */
    const inWin = (rx: number, ry: number) => ({ x: (t: number) => winCx + sw(t) * (rx - winCx), y: (t: number) => winCy + sw(t) * (ry - winCy) });
    const winEdges = [winAt, winAt + WIN_POP];
    const W = win.width * u;
    const H = win.height * u;

    // The window and the two copies behind it: border, title bar and body, each a shape on the window's centre.
    const chrome = (part: string, z: number, motion: Omit<Motion, "from" | "edges" | "x" | "y"> & { x: Fn; y: Fn; from: number; edges: readonly number[] }) => {
      const parts: { name: string; path: PathCmd[]; fill: string }[] = [
        { name: "frame", path: roundedRectPath(0, 0, W, H, RADIUS * u), fill: INK },
        { name: "bar", path: roundedRectPath(EDGE * u, EDGE * u, W - 2 * EDGE * u, (BAR - EDGE) * u, [(RADIUS - EDGE) * u, (RADIUS - EDGE) * u, 0, 0]), fill: accent },
        { name: "body", path: roundedRectPath(EDGE * u, (BAR + EDGE) * u, W - 2 * EDGE * u, H - (BAR + 2 * EDGE) * u, [0, 0, (RADIUS - EDGE) * u, (RADIUS - EDGE) * u]), fill: WINDOW },
      ];
      parts.forEach((item, i) => {
        const shape = anchored(item.path, { x: W / 2, y: H / 2 });
        const moved = trackOf(ctx, motion);
        if (!moved) return;
        out.push({ id: `popup:${cueNumber}:${part}-${item.name}`, kind: "shape", z: band + z + i, ...moved, origin: shape.origin, path: shape.path, fill: { colour: item.fill } });
      });
    };
    for (const copy of [2, 1]) {
      const at = winAt + WIN_POP + copy * 110;
      const move = (t: number) => outBack(prog(t, at, 240), 1.3) * copy * 16 * u;
      chrome(`copy${copy}`, copy === 2 ? 10 : 13, { from: at + 4, x: (t) => winCx + dir * move(t), y: (t) => winCy + move(t), edges: [at, at + 240] });
    }
    chrome("win", 16, { from: winAt + 4, x: () => winCx, y: () => winCy, sx: sw, sy: sw, edges: winEdges });

    // The three title-bar dots spring in one after another.
    const dotColours = [MINT, VIOLET, highlight];
    for (let i = 0; i < 3; i++) {
      const at = winAt + 120 + i * 50;
      const dotLeft = startSign > 0 ? holderLeft + EDGE + DOT.pad + i * (DOT.box + DOT.gap) : holderLeft + win.width - EDGE - DOT.pad - DOT.box - i * (DOT.box + DOT.gap);
      const mirrored = space.x(dotLeft + DOT.box / 2);
      const ry = space.y(holderTop + EDGE + (BAR - EDGE) / 2);
      const pos = inWin(mirrored, ry);
      const spring = (t: number) => Math.max(0, EASES.spring(prog(t, at, 240)));
      const shape = anchored(ellipsePath(0, 0, ((DOT.box - 3) / 2) * u));
      const moved = trackOf(ctx, { from: at + 4, x: pos.x, y: pos.y, sx: (t) => sw(t) * spring(t), sy: (t) => sw(t) * spring(t), edges: [...winEdges, at, at + 240] });
      if (moved) out.push({ id: `popup:${cueNumber}:dot${i}`, kind: "shape", z: band + 20, ...moved, origin: shape.origin, path: shape.path, fill: { colour: dotColours[i]! }, stroke: { widthPx: 3 * u, colour: INK } });
    }

    // The starburst behind the word's start (or end, or middle), spinning slowly.
    const burstSize = size * 1.25;
    const contentLeft = holderLeft + EDGE;
    const contentTop = holderTop + EDGE + BAR;
    const burstX = burstSide === 0 ? holderLeft + win.width / 2 : burstSide > 0 ? contentLeft + 0.52 * size : holderLeft + win.width - EDGE - 0.52 * size;
    const burstY = contentTop + 0.71 * size;
    const burstPos = inWin(space.x(burstX), space.y(burstY));
    const k = (burstSize * u) / 120;
    const burstShape = anchored(polygonPath(popupBurstPoints(spikes, heroCue).map(([px, py]) => [px * k, py * k] as [number, number])));
    const grow = (t: number) => outBack(prog(t, winAt, 380), 1.8);
    const burstMoved = trackOf(ctx, {
      from: winAt + 4,
      x: burstPos.x,
      y: burstPos.y,
      sx: (t) => sw(t) * Math.max(0, grow(t)),
      sy: (t) => sw(t) * Math.max(0, grow(t)),
      rz: (t) => -140 * (1 - grow(t)) + (t - hs) * 0.006,
      edges: [...winEdges, winAt + 380, winAt + 760],
    });
    if (burstMoved) out.push({ id: `popup:${cueNumber}:burst`, kind: "shape", z: band + 22, ...burstMoved, origin: burstShape.origin, path: burstShape.path, fill: { colour: accent }, stroke: { widthPx: 3.5 * k, colour: INK } });

    // The hero, letter by letter, bobbing while it holds.
    const spanTop = contentTop + 0.16 * size;
    const baselineY = spanTop + popupHeroBaseline(size);
    const pivotY = spanTop + 0.85 * HERO_LINE * size;
    let left = contentLeft + 0.42 * size + (win.width - 2 * EDGE - 0.84 * size - lettersWidth) / 2;
    heroLetters.forEach((letter, i) => {
      const box = widths[i]!;
      const at = winAt + i * LETTER_STEP;
      const tilt = (rnd(i + 11 + 7 * heroCue) - 0.5) * 10;
      const pop = (t: number) => prog(t, at, 320);
      const pos = inWin(space.x(left + box / 2), space.y(pivotY));
      const bob = (t: number) => Math.sin(((t - hs) / BOB_MS) * Math.PI * 2 - i * 0.7) * BOB_PX * u * EASES.out(prog(t, at + 320, 300));
      if (letter.trim() !== "") {
        const moved = trackOf(ctx, {
          from: at + 4,
          x: pos.x,
          y: (t) => pos.y(t) + bob(t),
          sx: (t) => sw(t) * Math.max(0, EASES.spring(pop(t))),
          sy: (t) => sw(t) * Math.max(0, EASES.spring(pop(t))),
          rz: (t) => tilt * (1 - EASES.out(pop(t))) + tilt * 0.3,
          edges: [...winEdges, at, at + 320, at + 620, ...quarterEdges(at + 620, BOB_MS / 4, ctx.exitFrom)],
        });
        if (moved)
          out.push({
            id: `popup:${cueNumber}:l${i}`,
            kind: "text",
            z: band + 24,
            ...moved,
            origin: { dx: (box * u) / 2, dy: (pivotY - baselineY) * u },
            text: letter,
            face: HERO_FACE,
            sizePx: size * u,
            letterSpacingEm: LS,
            fill: palette[(i + offset) % palette.length]!,
            stroke: { widthPx: 0.035 * size * u, colour: INK },
            shadows: [{ dx: 0.05 * size * u, dy: 0.065 * size * u, blur: 0, colour: INK, alpha: 1 }],
            anchor: "baseline-left",
            language: cue.language,
          });
      }
      left += box;
    });

    // Sparkles: one inside the window's top corner, one outside its bottom corner, one on its side.
    const sparks: [number, number, number, number][] = [
      [win.width - 0.34 * size, BAR + 0.3 * size, 0.2 * size, 0],
      [-0.18 * size, win.height - 0.18 * size, 0.24 * size, 80],
      [win.width + 0.05 * size, win.height * 0.82, 0.13 * size, 150],
    ];
    sparks.forEach(([sx, sy, radius, delay], i) => {
      const mx = dir > 0 ? sx : win.width - sx;
      push(sparkle(`sp${i}`, 30, space.x(holderLeft + mx), space.y(holderTop + sy), radius, hs + 160 + delay, highlight));
    });
    return out;
  };

  // The window and its sparkles stay inside the safe width: shrink the hero until the whole cue does.
  const safeWidth = space.safe.x2 - space.safe.x1;
  const widthOf = (list: readonly Piece[]) => {
    let x1 = Number.POSITIVE_INFINITY;
    let x2 = Number.NEGATIVE_INFINITY;
    const from = Math.min(...list.map((piece) => piece.fromMs));
    const to = Math.max(...list.map((piece) => piece.toMs));
    for (let ms = from; ms < to; ms += 16) {
      const box: Box | null = sceneBoundsAt(list, ms, input.measure);
      if (!box) continue;
      x1 = Math.min(x1, box.x1);
      x2 = Math.max(x2, box.x2);
    }
    return x2 - x1;
  };
  let size = natural;
  let list = heroPieces(size);
  for (let attempt = 0; attempt < 8 && list.length > 0; attempt++) {
    const width = widthOf(list);
    if (width <= safeWidth * 0.995) break;
    size *= Math.max(0.5, (safeWidth / width) * 0.985);
    list = heroPieces(size);
  }
  pieces.push(...list);
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const popupProgram: SceneProgram = {
  build(input) {
    const counters = cycleCounters(input.cues);
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, counters[number]!, input))) };
  },
};
