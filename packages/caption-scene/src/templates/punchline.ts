import type { DemoScript } from "../demo";
import { detectPunchlines } from "../detect";
import { type Frames, EASES, clamp, kf, lerp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram, SceneWord } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, sceneSpace, shiftPiece, type SceneSpace } from "../layout";
import { type Box, type PathCmd, type Piece, type ShapePiece, type TextPiece, sceneBoundsAt } from "../scene";
import { arcPath, ellipsePath, polygonPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Punchline (`samples/templates/52-punchline.js`): ordinary lines pop in like stickers (Lilita One, a thick
 * outline, a hard drop shadow). A short line that ends a sentence after a real pause is a punchline: three dots
 * drumroll through the pause, then the line slams onto a yellow starburst with a shock ring. The signal is
 * read from timings alone (`detectPunchlines`).
 *
 * Geometry is the sample's, read in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`): a word is a
 * `line-height: 1.06` block (its baseline `lineBaseline(size)` below the top), a row is a baseline-aligned flex
 * row with a gap of 0.24 of the row's size (rounded), rows stack with 2 px between them (none on a punchline)
 * and the stack is centred on the anchor line (y 1290). The burst, the ring, the dots and the group's kick all
 * turn and scale about that centre.
 */

export const PUNCHLINE_DEMO: DemoScript = {
  lines: [
    "So:m I:m finally:b tried:b meal:b prep",
    "cooked:b for:m the:m whole:b week:h@480",
    "Gone:b+760 by:m Tuesday.:b@520",
    "I'm:m not:b even:b sorry",
  ],
  options: { rate: 290, cueGap: 140, tail: 800, lead: 360 },
};

const FACE = "Lilita One" as const;
const OUTLINE = "#1B0B2E";
const PUNCH_INK = "#1B0B2E";
const ANCHOR_LINE = 1290;
const BODY = 80;
const HERO = Math.round(BODY * 1.4);
const PUNCH = Math.round(BODY * 1.5);
const MAX_W = 860;
const LINE_HEIGHT = 1.06;
/** The sample's `transform-origin: 50% 55%` on every word. */
const PIVOT_Y = 0.55;
const OUTLINE_EM = 0.09;
const SHADOW_EM = 0.075;
const ROW_GAP = Math.round(BODY * 0.02);
const STAR_SHADOW_DY = 14;
const STAR_STROKE = 7;
const RING_STROKE = 9;
const DOT = Math.round(BODY * 0.7);
const DOT_BORDER = 8;
const DOT_SHADOW_DY = 7;
const EXIT = 120;
/** libass draws a piece scaled to exactly 0 badly: tracks never go below this. */
const MIN_SCALE = 0.02;

/** The sample's `hash`. */
export const punchHash = (n: number): number => {
  const x = Math.sin(n * 91.7 + 17.3) * 43758.5453;
  return x - Math.floor(x);
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The sample's `starPoints`: 12 outer and 12 inner points with a hand-drawn irregularity fixed by `seed`, one decimal. */
export function punchStarPoints(rx: number, ry: number, seed: number): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2 - Math.PI / 2 + (punchHash(seed + i) - 0.5) * 0.07;
    const outer = i % 2 === 0;
    const k = outer ? 0.92 + punchHash(seed + i * 3) * 0.16 : 0.76 + punchHash(seed + i * 5) * 0.05;
    points.push([round1(Math.cos(angle) * rx * k), round1(Math.sin(angle) * ry * k)]);
  }
  return points;
}

/** Distance from the top of a `line-height: 1.06` Lilita One box to its baseline, as Chrome rounds it (ascent .923, descent .22). */
export function lineBaseline(sizePx: number): number {
  const ascent = Math.round(0.923 * sizePx);
  const descent = Math.round(0.22 * sizePx);
  return Math.round((LINE_HEIGHT * sizePx - ascent - descent) / 2 + ascent);
}

/** An ordinary word's tilt in degrees (CSS sign): held for the cue. */
export const stickerTilt = (cueNumber: number, wordIndex: number): number => (punchHash(cueNumber * 13 + wordIndex) - 0.5) * 6;

// ─── The sample's formulas (tests read them) ────────────────────────────────

const exitOut = (t: number, end: number) => EASES.in(prog(t, end - EXIT, EXIT));
/** A sticker word's scale before the cue's exit factor. */
export function stickerPop(t: number, wordStartMs: number): number {
  const ws = wordStartMs - 40;
  return t < ws + 100 ? lerp(0.6, 1.08, EASES.out(prog(t, ws, 100))) : lerp(1.08, 1, EASES.in(prog(t, ws + 100, 70)));
}
export const stickerScale = (t: number, wordStartMs: number, end: number): number => stickerPop(t, wordStartMs) * (1 - 0.25 * exitOut(t, end));
export const stickerOpacity = (t: number, wordStartMs: number, end: number): number => clamp((t - (wordStartMs - 40)) / 30) * (1 - exitOut(t, end));
/** A punchline word's slam scale (before the group's exit). */
export function slamWordScale(t: number, wordStartMs: number): number {
  const ws = wordStartMs - 40;
  return t < ws + 90 ? lerp(1.6, 0.95, EASES.in(prog(t, ws, 90))) : lerp(0.95, 1, EASES.out(prog(t, ws + 90, 60)));
}
/** The burst's scale, its turn (degrees, CSS sign) and the shock ring's progress at `t` for a punchline starting at `cs`, ending at `end`. */
export const burstScale = (t: number, cs: number): number => (t < cs + 90 ? lerp(0, 1.18, EASES.out(prog(t, cs - 60, 150))) : lerp(1.18, 1, EASES.in(prog(t, cs + 90, 90))));
export const burstTurn = (t: number, cs: number, end: number): number =>
  t < cs + 180 ? lerp(-25, 0, EASES.out(prog(t, cs - 60, 240))) : lerp(0, 6, prog(t, cs + 180, end - cs - 180));
export const ringProgress = (t: number, cs: number): number => EASES.out(prog(t, cs + 20, 260));
/** The punchline group's kick (degrees). */
export const kickAt = (t: number, cs: number): number => kf(t, [[cs + 110, 0], [cs + 150, -2], [cs + 190, 1.5, "inOut"], [cs + 230, 0, "out"]]);
/** A dot's scale (before the vanish) and the vanish factor. */
export const dotPop = (t: number, at: number): number => (t < at + 90 ? lerp(0, 1.2, EASES.out(prog(t, at, 90))) : lerp(1.2, 1, EASES.in(prog(t, at + 90, 60))));
export const dotGone = (t: number, cs: number): number => EASES.in(prog(t, cs - 110, 70));
/** The held dots of a gap over 1500 ms pulse between full and 60 % opacity every 600 ms. */
export const dotPulse = (t: number, at: number): number => (t > at + 600 ? kf((t - at - 600) % 600, [[0, 1], [300, 0.6], [600, 1]]) : 1);

// ─── Keyframes from functions ───────────────────────────────────────────────

/**
 * `fn` over [from, to] as keyframes (`sampleFrames`). Pieces of Punchline multiply several eased windows (a pop and an
 * exit, a kick and a turn), which no single eased segment draws.
 */
const sampled = (fn: (t: number) => number, from: number, to: number, edges: readonly number[], tolerance: number): Frames => sampleFrames(fn, edges, tolerance, { range: [from, to] });

const TOL = { px: 0.15, scale: 0.002, degrees: 0.05, alpha: 0.01 } as const;

// ─── Layout ─────────────────────────────────────────────────────────────────

interface Placed {
  readonly index: number;
  readonly word: SceneWord;
  readonly size: number;
  readonly hero: boolean;
  readonly width: number;
  readonly left: number;
  readonly baselineY: number;
  /** Where the word's own scale and tilt turn: the middle of its box, 55 % of the way down. */
  readonly pivot: { readonly x: number; readonly y: number };
}

interface Block {
  readonly items: readonly Placed[];
  /** The stack's size: the burst is drawn around it. */
  readonly width: number;
  readonly height: number;
  /** The stack's centre: the group's pivot. */
  readonly centre: { readonly x: number; readonly y: number };
}

/**
 * The widest a punchline's row may be. The sample wraps every cue at 860, but a burst is at most 480 across from its
 * centre and its slam (1.18 times, points 1.08 times) must stay in the safe area, so a wide row would hang its first
 * and last letters over the burst's edge (dark ink on the video). Rows stay inside the star's inner points (0.76 of
 * its radius). A punchline of the sample's own demo (rows of 416 and 455) is unaffected.
 */
function punchRowLimit(space: SceneSpace): number {
  const radius = Math.min(480 * space.u, (space.safe.x2 - space.safe.x1) / 2 / (1.18 * 1.08));
  return 2 * 0.9 * 0.76 * radius;
}

function layoutBlock(cue: SceneCue, punch: boolean, input: SceneInput, space: SceneSpace, fit: number): Block {
  const { u } = space;
  const rowSize = punch ? PUNCH : BODY;
  const sizeOf = (word: SceneWord) => (punch ? PUNCH : word.role === "hero" ? HERO : BODY) * u * fit;
  const gap = Math.round(rowSize * 0.24) * u * fit;
  const rowGap = (punch ? 0 : ROW_GAP) * u * fit;
  const sizes = cue.words.map(sizeOf);
  const widths = cue.words.map((word, at) => input.measure(word.text, FACE, sizes[at]!, 0).advance);
  const direction = cueDirection(cue);
  const rows = balancedRows(widths, gap, (punch ? punchRowLimit(space) : MAX_W * u) * fit).map((row) => rowVisualOrder(row.map((at) => cue.words[at]!.text), direction).map((at) => row[at]!));

  const metrics = rows.map((row) => {
    const above = Math.max(...row.map((at) => lineBaseline(sizes[at]!)));
    const below = Math.max(...row.map((at) => LINE_HEIGHT * sizes[at]! - lineBaseline(sizes[at]!)));
    const width = row.reduce((sum, at) => sum + widths[at]!, 0) + gap * (row.length - 1);
    return { above, height: above + below, width };
  });
  const height = metrics.reduce((sum, row) => sum + row.height, 0) + rowGap * (rows.length - 1);
  const width = Math.max(...metrics.map((row) => row.width));
  const centre = { x: space.x(540), y: space.y(ANCHOR_LINE) };
  let top = centre.y - height / 2;
  const items: Placed[] = [];
  rows.forEach((row, rowAt) => {
    const baselineY = top + metrics[rowAt]!.above;
    let left = centre.x - metrics[rowAt]!.width / 2;
    for (const at of row) {
      const size = sizes[at]!;
      const nodeTop = baselineY - lineBaseline(size);
      items.push({
        index: at,
        word: cue.words[at]!,
        size,
        hero: !punch && cue.words[at]!.role === "hero",
        width: widths[at]!,
        left,
        baselineY,
        pivot: { x: left + widths[at]! / 2, y: nodeTop + PIVOT_Y * LINE_HEIGHT * size },
      });
      left += widths[at]! + gap;
    }
    top += metrics[rowAt]!.height + rowGap;
  });
  items.sort((a, b) => a.index - b.index);
  return { items, width, height, centre };
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

/** The burst's fit: its width and its height shrink on their own. */
interface Fit2 {
  readonly x: number;
  readonly y: number;
}

interface Parts {
  readonly words: Piece[];
  /** The star: what the burst's fit measures. */
  readonly burst: Piece[];
  readonly ring: ShapePiece | null;
  readonly dots: Piece[];
}

const zOf = (cueNumber: number, role: number) => cueNumber * 10 + role;
const Z = { ring: 1, star: 3, words: 4 } as const;
/** The dots are drawn over every cue (the sample appends them after the cue groups). */
const DOT_Z = 100_000;

function textPiece(item: Placed, cue: SceneCue, id: string, z: number, from: number, to: number, track: TextPiece["track"], punch: boolean, input: SceneInput): TextPiece {
  const base = {
    id,
    kind: "text" as const,
    z,
    fromMs: from,
    toMs: to,
    track,
    origin: { dx: item.pivot.x - item.left, dy: item.pivot.y - item.baselineY },
    text: item.word.text,
    face: FACE,
    sizePx: item.size,
    letterSpacingEm: 0,
    anchor: "baseline-left" as const,
    language: cue.language,
  };
  if (punch) return { ...base, fill: PUNCH_INK };
  return {
    ...base,
    fill: item.hero ? input.colours.highlight : input.colours.primary,
    stroke: { widthPx: OUTLINE_EM * item.size, colour: OUTLINE },
    shadows: [{ dx: 0, dy: SHADOW_EM * item.size, blur: 0, colour: OUTLINE, alpha: 1 }],
  };
}

function stickerWord(item: Placed, cue: SceneCue, cueNumber: number, end: number, input: SceneInput): TextPiece | null {
  const ws = item.word.startMs - 40;
  const from = ws;
  if (end <= from) return null;
  const tilt = stickerTilt(cueNumber, item.index);
  const separate = end - EXIT > ws + 170;
  const sx: Frames = separate
    ? [[from, 0.6], [ws + 100, 1.08, "out"], [ws + 170, 1, "in"], [end - EXIT, 1], [end, 0.75, "in"]]
    : sampled((t) => stickerScale(t, item.word.startMs, end), from, end, [ws + 100, ws + 170, end - EXIT], TOL.scale);
  const o: Frames = end - EXIT > ws + 30
    ? [[from, 0], [ws + 30, 1], [end - EXIT, 1], [end, 0, "in"]]
    : sampled((t) => stickerOpacity(t, item.word.startMs, end), from, end, [ws + 30, end - EXIT], TOL.alpha);
  const track: TextPiece["track"] = { x: [[from, item.pivot.x]], y: [[from, item.pivot.y]], sx, sy: sx, rz: [[from, tilt]], o };
  return textPiece(item, cue, `punchline:${cueNumber}:w${item.index}`, zOf(cueNumber, Z.words), from, end, track, false, input);
}

/** The pivot of every piece of a punchline: the stack's centre; a word turns about its own centre, carried round it by the group. */
function slamWord(item: Placed, cue: SceneCue, cueNumber: number, block: Block, end: number, input: SceneInput): TextPiece | null {
  const cs = cue.startMs;
  const ws = item.word.startMs - 40;
  if (end <= ws) return null;
  const edges = [ws + 30, ws + 90, ws + 150, cs + 110, cs + 150, cs + 190, cs + 230, end - EXIT];
  const group = (t: number) => 1 - exitOut(t, end);
  const dx = item.pivot.x - block.centre.x;
  const dy = item.pivot.y - block.centre.y;
  const carried = (t: number, axis: "x" | "y") => {
    const angle = (kickAt(t, cs) * Math.PI) / 180;
    const rotated = axis === "x" ? dx * Math.cos(angle) - dy * Math.sin(angle) : dx * Math.sin(angle) + dy * Math.cos(angle);
    return (axis === "x" ? block.centre.x : block.centre.y) + group(t) * rotated;
  };
  const scale = sampled((t) => Math.max(MIN_SCALE, slamWordScale(t, item.word.startMs) * group(t)), ws, end, edges, TOL.scale);
  const track: TextPiece["track"] = {
    x: sampled((t) => carried(t, "x"), ws, end, edges, TOL.px),
    y: sampled((t) => carried(t, "y"), ws, end, edges, TOL.px),
    sx: scale,
    sy: scale,
    rz: sampled((t) => kickAt(t, cs), ws, end, edges, TOL.degrees),
    o: [[ws, 0], [ws + 30, 1]],
  };
  return textPiece(item, cue, `punchline:${cueNumber}:w${item.index}`, zOf(cueNumber, Z.words), ws, end, track, true, input);
}

function burstPieces(cue: SceneCue, cueNumber: number, block: Block, end: number, space: SceneSpace, fitText: number, fitBurst: Fit2, input: SceneInput): { burst: Piece[]; ring: ShapePiece } {
  const { u } = space;
  const cs = cue.startMs;
  const sampleRx = Math.min(480 * u, block.width * 0.74 + BODY * 0.6 * u * fitText);
  const rx = sampleRx * fitBurst.x;
  // The sample caps the height at 320; a stack taller than that (three rows) keeps its star around it.
  // The fit narrows the star first: it is the width that meets the safe area; the height only on a short canvas.
  const ry = clamp(Math.max(sampleRx * 0.62, block.height * 0.98), 0, Math.max(320 * u, block.height * 0.98)) * fitBurst.y;
  const points = punchStarPoints(rx, ry, cueNumber * 7 + 3);
  const path = polygonPath(points);
  const from = cs - 60;
  const group = (t: number) => 1 - exitOut(t, end);
  const edges = [cs + 20, cs + 90, cs + 110, cs + 150, cs + 180, cs + 190, cs + 230, cs + 280, end - EXIT];
  const turn = (t: number) => burstTurn(t, cs, end) + kickAt(t, cs);
  const starScale = sampled((t) => Math.max(MIN_SCALE, burstScale(t, cs) * group(t)), from, end, edges, TOL.scale);
  const starTrack: TextPiece["track"] = {
    x: [[from, block.centre.x]],
    y: [[from, block.centre.y]],
    sx: starScale,
    sy: starScale,
    rz: sampled(turn, from, end, edges, TOL.degrees),
  };
  const star: ShapePiece = {
    id: `punchline:${cueNumber}:star`,
    kind: "shape",
    z: zOf(cueNumber, Z.star),
    fromMs: from,
    toMs: end,
    track: starTrack,
    path,
    fill: { colour: input.colours.accent },
    stroke: { widthPx: STAR_STROKE * u, colour: OUTLINE },
    // `drop-shadow(0 14px 0)` on the whole drawing moves the star's silhouette with its outline down. The writer draws a
    // shape's shadow from its fill alone, which is 3.5 px (half the outline) smaller all round: 17.5 px down lands its
    // lower edges where the sample's are and keeps the rest under the outline. One layer, not two: the burst is the
    // biggest bitmap on screen, and libass blends every layer's whole box on every frame.
    shadows: [{ dx: 0, dy: (STAR_SHADOW_DY + STAR_STROKE / 2) * u, blur: 0, colour: OUTLINE, alpha: 1 }],
  };
  const ringTo = Math.min(end, cs + 280);
  const ringFrom = cs + 20;
  const ringScale = sampled((t) => Math.max(MIN_SCALE, lerp(1, 1.45, ringProgress(t, cs)) * group(t)), ringFrom, ringTo, edges, TOL.scale);
  const ring: ShapePiece = {
    id: `punchline:${cueNumber}:ring`,
    kind: "shape",
    z: zOf(cueNumber, Z.ring),
    fromMs: ringFrom,
    toMs: ringTo,
    track: {
      x: [[ringFrom, block.centre.x]],
      y: [[ringFrom, block.centre.y]],
      sx: ringScale,
      sy: ringScale,
      rz: sampled(turn, ringFrom, ringTo, edges, TOL.degrees),
      o: sampled((t) => 1 - ringProgress(t, cs), ringFrom, ringTo, [], TOL.alpha),
    },
    path,
    stroke: { widthPx: RING_STROKE * u, colour: input.colours.accent },
  };
  return { burst: [star], ring };
}

/** A dot with its hard shadow: a ring (the outline plus the crescent the shadow shows under it) and the face, which stay in step. */
function dotPieces(cue: SceneCue, cueNumber: number, k: number, centre: { x: number; y: number }, gapStart: number, space: SceneSpace, input: SceneInput): Piece[] {
  const { u } = space;
  const cs = cue.startMs;
  const at = gapStart + 150 + k * 180;
  const to = cs - 40;
  if (to <= at + 1) return [];
  const from = at;
  const long = cs - gapStart > 1500;
  const edges = [at + 90, at + 150, cs - 110];
  if (long) for (let pulse = at + 600; pulse < to; pulse += 300) edges.push(pulse);
  const scale = sampled((t) => Math.max(MIN_SCALE, dotPop(t, at) * (1 - dotGone(t, cs))), from, to, edges, TOL.scale);
  const o: Frames | undefined = long ? sampled((t) => (t > at + 600 ? dotPulse(t, at) : 1), from, to, edges, TOL.alpha) : undefined;
  const track: TextPiece["track"] = {
    x: [[from, centre.x + (k - 1) * DOT * 1.6 * u]],
    y: [[from, centre.y]],
    sx: scale,
    sy: scale,
    ...(o ? { o } : {}),
  };
  const radius = (DOT / 2) * u;
  const hole = radius - DOT_BORDER * u;
  const lift = DOT_SHADOW_DY * u;
  const half = (Math.asin(lift / 2 / radius) * 180) / Math.PI;
  const lower = arcPath(0, lift, radius, -half, 180 + half);
  const upper = arcPath(0, 0, radius, 180 - half, 360 + half);
  const inner = arcPath(0, 0, hole, 0, -360);
  const ringPath: PathCmd[] = [...lower, ...upper.slice(1), ["Z"], ...inner, ["Z"]];
  const base = { kind: "shape" as const, z: DOT_Z, fromMs: from, toMs: to, track };
  return [
    { ...base, id: `punchline:${cueNumber}:dot${k}`, path: ringPath, fill: { colour: OUTLINE } },
    { ...base, id: `punchline:${cueNumber}:dot${k}:face`, z: DOT_Z + 1, path: ellipsePath(0, 0, hole + 0.5 * u), fill: { colour: input.colours.primary } },
  ];
}

function buildParts(cue: SceneCue, cueNumber: number, punch: boolean, gapBeforeMs: number, end: number, input: SceneInput, space: SceneSpace, fitText: number, fitBurst: Fit2): Parts {
  const block = layoutBlock(cue, punch, input, space, fitText);
  if (!punch) {
    const words = block.items.map((item) => stickerWord(item, cue, cueNumber, end, input)).filter((piece): piece is TextPiece => piece !== null);
    return { words, burst: [], ring: null, dots: [] };
  }
  const words = block.items.map((item) => slamWord(item, cue, cueNumber, block, end, input)).filter((piece): piece is TextPiece => piece !== null);
  const { burst, ring } = burstPieces(cue, cueNumber, block, end, space, fitText, fitBurst, input);
  const gapStart = cue.startMs - gapBeforeMs;
  const dots = [0, 1, 2].flatMap((k) => dotPieces(cue, cueNumber, k, block.centre, gapStart, space, input));
  return { words, burst, ring, dots };
}

/** The box the pieces ever cover, over their whole window. */
function unionBox(pieces: readonly Piece[], measure: SceneInput["measure"], step = 16): Box | null {
  if (pieces.length === 0) return null;
  const from = Math.min(...pieces.map((piece) => piece.fromMs));
  const to = Math.max(...pieces.map((piece) => piece.toMs));
  let union: Box | null = null;
  for (let ms = from; ms < to; ms += step) {
    const box = sceneBoundsAt(pieces, ms, measure);
    if (!box) continue;
    union = union ? { x1: Math.min(union.x1, box.x1), y1: Math.min(union.y1, box.y1), x2: Math.max(union.x2, box.x2), y2: Math.max(union.y2, box.y2) } : box;
  }
  return union;
}

function buildCue(cue: SceneCue, cueNumber: number, punch: boolean, gapBeforeMs: number, showUntilMs: number, input: SceneInput): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const end = Math.max(showUntilMs, cue.startMs + 60);
  // A little under the safe area: the shift below samples every 16 ms and would miss the sharp peak of the slam by a pixel or two.
  const room = { width: (space.safe.x2 - space.safe.x1) * 0.99, height: (space.safe.y2 - space.safe.y1) * 0.99 };
  const over = (box: Box | null) => (box ? Math.min(room.width / (box.x2 - box.x1), room.height / (box.y2 - box.y1)) : 1);
  // Fit: shrink the words when they cannot all stay in the safe area (a stamp starts at 1.6 times its size), then the burst
  // when its slam would pass it. A shift cannot do either; `clampToSafeArea` only moves a cue.
  let fitText = 1;
  let fitBurst: Fit2 = { x: 1, y: 1 };
  let parts = buildParts(cue, cueNumber, punch, gapBeforeMs, end, input, space, fitText, fitBurst);
  for (let pass = 0; pass < 12; pass++) {
    const words = over(unionBox(parts.words, input.measure, 4));
    const burstBox = unionBox(parts.burst, input.measure, 4);
    const burstX = burstBox ? room.width / (burstBox.x2 - burstBox.x1) : 1;
    const burstY = burstBox ? room.height / (burstBox.y2 - burstBox.y1) : 1;
    const both = over(unionBox([...parts.words, ...parts.burst], input.measure, 4));
    if (words >= 1 && burstX >= 1 && burstY >= 1 && both >= 1) break;
    if (words < 1) fitText *= words * 0.995;
    else if (burstX < 1 || burstY < 1) fitBurst = { x: fitBurst.x * Math.min(1, burstX * 0.995), y: fitBurst.y * Math.min(1, burstY * 0.995) };
    else fitText *= both * 0.995; // a wide stamp passes the star: the star follows the words' size
    parts = buildParts(cue, cueNumber, punch, gapBeforeMs, end, input, space, fitText, fitBurst);
  }
  // The cue is shifted as one into the safe area, the ring with it. The ring grows past the frame as it fades, so it takes no
  // part in the fit; it is cut at the safe area instead.
  const others = [...parts.burst, ...parts.words, ...parts.dots];
  const shifted = clampToSafeArea(others, space.safe, input.measure);
  const first = others[0];
  const moved = shifted[0];
  const dx = first && moved ? firstValue(moved.track.x) - firstValue(first.track.x) : 0;
  const dy = first && moved ? firstValue(moved.track.y) - firstValue(first.track.y) : 0;
  if (!parts.ring) return shifted;
  const at = parts.ring.fromMs;
  const cut = { x1: [[at, space.safe.x1]], y1: [[at, space.safe.y1]], x2: [[at, space.safe.x2]], y2: [[at, space.safe.y2]] } as const;
  return [{ ...shiftPiece(parts.ring, dx, dy), clip: cut } satisfies ShapePiece, ...shifted];
}

const firstValue = (frames: Frames | undefined): number => frames?.[0]?.[1] ?? 0;

export const punchlineProgram: SceneProgram = {
  build(input) {
    const punch = detectPunchlines(input.cues);
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, number, punch[number]!.punch, punch[number]!.gapBeforeMs, punch[number]!.showUntilMs, input)) };
  },
};
