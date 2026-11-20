import type { DemoScript } from "../demo";
import { EASES, type Frames, kf, lerp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { Piece, ShapePiece, TextPiece } from "../scene";
import { roundedRectPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Wordform (`samples/templates/55-wordform.js`): under the caption runs a strip of up to 44 bars laid out on the
 * cue's own time axis: a bar where a word is spoken (taller for a weightier word, hero bars in the highlight
 * colour), a flat dot where the speaker breathes, and a playhead that lights them as the line plays. The strip
 * grows in as a left-to-right wave and folds away right to left; the words fade in out of a small blur.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`): a
 * row is a flex row of `line-height: 1.18` boxes aligned on their baselines with a 17 px gap, centred; the
 * block's last row is placed so its baseline falls 1.02 em of its biggest word under 1262 and earlier rows stack
 * above it (the sample's own approximation of the baseline, kept because the sample is the design). A 64 px Inter
 * box has its baseline 61 px down, a 90 px Bricolage box 83 px. The strip's centre line is 1404; bars 9 px wide
 * every 18 px, 42 of them, centred on 540.
 */

export const WORDFORM_DEMO: DemoScript = {
  lines: [
    "most:m of:m us:m aren't:b tired:h@560",
    "we're:m just:b overstimulated:h@820+760",
    "so:m put:b your:m phone:b down:b tonight",
    "and:m breathe:h@760",
  ],
  options: { rate: 280, lead: 420, cueGap: 160, tail: 700 },
};

const ANCHOR_LINE = 1330;
const BODY = 64;
const HERO = Math.round(BODY * 1.4);
const Y_TEXT = 1262;
const Y_STRIP = 1404;
const STRIP_W = 756;
const PITCH = 18;
const BAR_W = 9;
const BARS = Math.min(44, Math.floor(STRIP_W / PITCH));
const X0 = 540 - ((BARS - 1) * PITCH) / 2;
const ROLE_H = { minor: 0.46 * BODY, body: 0.82 * BODY, hero: 1.28 * BODY } as const;
const DOT = 8;
const UNLIT_ALPHA = 0.28;
const PLAYHEAD = { width: 3, height: 1.7 * BODY, alpha: 0.9 } as const;
const TEXT_SHADOWS = [
  { dy: 2, blur: 2, alpha: 0.45 },
  { dy: 6, blur: 10, alpha: 0.5 },
] as const;
const BODY_FACE = "Inter SemiBold" as const;
const HERO_FACE = "Bricolage Grotesque" as const;
const LETTER_SPACING = { body: -0.02, hero: -0.03 } as const;
const LINE = 1.18;
/** Chrome's baseline of a `line-height: 1.18` box, as a share of its font size (61 / 64 and 83 / 90 in the probe). */
const ABOVE = { body: 61 / 64, hero: 83 / 90 } as const;
/** `transform-origin: 50% 70%` of a word's line box. */
const PIVOT_Y = 0.7 * LINE;
const GAP = Math.round(BODY * 0.26);
/** Widest a row may be, share of the canvas width (the safe area). */
const MAX_ROW_SHARE = 0.9;

/** The sample's deterministic variation in [0, 1) from (word, cue, bar). */
export function wordformHash(text: string): number {
  let h = 2166136261;
  for (let at = 0; at < text.length; at++) {
    h ^= text.charCodeAt(at);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
}

/** `sampleFrames` on whole milliseconds: a one-millisecond segment is a jump. */
const sampled = (fn: (t: number) => number, edges: readonly number[], tolerance: number): Frames => sampleFrames(fn, edges, tolerance, { wholeMs: true });

/** A piecewise-linear function as keyframes at its corners. */
function cornered(fn: (t: number) => number, edges: readonly number[]): Frames {
  const sorted = [...new Set(edges)].sort((a, b) => a - b);
  return sorted.map((t) => [t, fn(t)] as const);
}

interface Item {
  readonly index: number;
  readonly hero: boolean;
  readonly size: number;
  /** Box width: advance plus the trailing letter spacing CSS adds, px. */
  readonly box: number;
  left: number;
}

function buildCue(cue: SceneCue, input: SceneInput, cueNumber: number): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u } = space;
  const direction = cueDirection(cue);
  const rtl = direction === "rtl";
  const words = cue.words;
  const maxRow = MAX_ROW_SHARE * space.canvas.width;
  const isHero = words.map((word) => word.role === "hero");

  const measureAll = (k: number): Item[] =>
    words.map((word, index) => {
      const hero = isHero[index]!;
      const size = (hero ? HERO : BODY) * u * k;
      const ls = hero ? LETTER_SPACING.hero : LETTER_SPACING.body;
      const m = input.measure(word.text, hero ? HERO_FACE : BODY_FACE, size, ls);
      return { index, hero, size, box: m.advance + ls * size, left: 0 };
    });

  // The sample never wraps and never shrinks; a word wider than a row shrinks the whole cue so the rows still fit.
  let k = 1;
  let items = measureAll(1);
  const widest = Math.max(...items.map((item) => item.box));
  if (widest > maxRow) {
    k = fitScale(widest, maxRow);
    items = measureAll(k);
  }
  const gap = GAP * u * k;
  const boxes = items.map((item) => item.box);

  // One row of up to five words; six or more split by count into two, as the sample does; evenly wrapped when still too wide.
  const n = words.length;
  const split = n >= 6 ? Math.ceil(n / 2) : n;
  const range = (a: number, b: number) => Array.from({ length: b - a }, (_, at) => a + at);
  let lines = split < n ? [range(0, split), range(split, n)] : [range(0, n)];
  if (lines.some((line) => rowWidth(boxes, line, gap) > maxRow)) lines = balancedRows(boxes, gap, maxRow);

  interface Row {
    readonly order: readonly number[];
    readonly above: number;
    readonly height: number;
    readonly biggest: number;
  }
  const rows: Row[] = lines.map((line) => {
    const order = rowVisualOrder(line.map((at) => words[at]!.text), direction).map((at) => line[at]!);
    const above = Math.max(...line.map((at) => (isHero[at]! ? ABOVE.hero : ABOVE.body) * items[at]!.size));
    const below = Math.max(...line.map((at) => LINE * items[at]!.size - (isHero[at]! ? ABOVE.hero : ABOVE.body) * items[at]!.size));
    return { order, above, height: above + below, biggest: Math.max(...line.map((at) => items[at]!.size)) };
  });
  // The block's top: the sample anchors the last row's baseline at 1.02 em of its biggest word under Y_TEXT, less the
  // rows above it (their heights as whole px, since it reads `offsetHeight`).
  const total = rows.reduce((sum, row) => sum + row.height, 0);
  const last = rows[rows.length - 1]!;
  const stackAbove = (Math.round(total / u) - Math.round(last.height / u)) * u;
  const blockTop = space.y(Y_TEXT) - stackAbove - ((LINE - 1) / 2 + 0.93) * last.biggest;

  const cs = cue.startMs;
  const ce = cue.endMs;
  const dur = ce - cs || 1;
  const pieces: Piece[] = [];
  const z = cueNumber * 4;

  // ---- the strip -------------------------------------------------------------------------------------------------
  // Words own the short joins between them; only a real gap (>= 140 ms) reads as a breath.
  const spans = words.map((word, at) => {
    const next = words[at + 1];
    return { word, from: word.startMs, to: next && next.startMs - word.endMs < 140 ? next.startMs : word.endMs };
  });
  const barX = (i: number) => space.x(X0 + (rtl ? BARS - 1 - i : i) * PITCH);
  for (let i = 0; i < BARS; i++) {
    const ti = cs + ((i + 0.5) / BARS) * dur;
    const span = spans.find((s) => ti >= s.from && ti < s.to);
    const role = span?.word.role ?? null;
    const heightPx = role && span ? Math.max(DOT + 4, ROLE_H[role] * lerp(0.7, 1.15, wordformHash(`${span.word.text}:${cue.index}:${i}`))) : DOT;
    const growStart = cs - 120 + i * 4;
    const growEnd = growStart + 240;
    const foldStart = ce - 200 + (BARS - 1 - i) * 1.6;
    const foldEnd = foldStart + 110;
    // A bar is built at scale 0 and folds to 0: its window starts and ends where the scale is a few percent.
    const from = growStart + 4;
    const to = foldEnd - 1;
    if (to <= from) continue;
    const pulse = (t: number) =>
      role
        ? kf(t, [
            [ti - 30, 1],
            [ti + 50, 1.22, "out"],
            [ti + 190, 1, "in"],
          ])
        : 1;
    const scale = (t: number) => EASES.out(prog(t, growStart, 240)) * (1 - EASES.in(prog(t, foldStart, 110))) * pulse(t);
    // Grow, pulse and fold are separate windows for almost every bar: eased segments, exact. Otherwise sample.
    const edges = role ? [growStart, growEnd, ti - 30, ti + 50, ti + 190, foldStart, foldEnd] : [growStart, growEnd, foldStart, foldEnd];
    const apart = edges.every((edge, at) => at === 0 || edge > edges[at - 1]!);
    const sy: Frames = apart
      ? role
        ? [[growStart, 0], [growEnd, 1, "out"], [ti - 30, 1], [ti + 50, 1.22, "out"], [ti + 190, 1, "in"], [foldStart, 1], [foldEnd, 0, "in"]]
        : [[growStart, 0], [growEnd, 1, "out"], [foldStart, 1], [foldEnd, 0, "in"]]
      : sampled(scale, edges, 0.004);
    const lit = (t: number) => lerp(UNLIT_ALPHA, 1, prog(t, ti - 30, 60));
    const o = cornered(lit, [from, ti - 30, ti + 30, to].filter((t) => t >= from && t <= to));
    const bar: ShapePiece = {
      id: `wordform:${cueNumber}:bar${i}`,
      kind: "shape",
      z,
      fromMs: from,
      toMs: to,
      track: { x: [[from, barX(i)]], y: [[from, space.y(Y_STRIP)]], sy, o },
      // Drawn from its own top-left with the pivot at its centre, so that scaling it moves nothing (libass aligns a drawing by its box).
      origin: { dx: (BAR_W / 2) * u, dy: (heightPx / 2) * u },
      path: roundedRectPath(0, 0, BAR_W * u, heightPx * u, (BAR_W / 2) * u),
      // No `box-shadow: 0 2px 10px`: 42 blurred shadow layers per cue cost 1.8x Headline (the strip alone), without them 1.0x, and on
      // the sample's dark backdrop the shadow is not visible. The words keep theirs.
      fill: { colour: role === "hero" ? input.colours.highlight : input.colours.primary },
    };
    pieces.push(bar);
  }

  // The playhead rides the cue's time axis; it appears with the strip and leaves with it.
  {
    const riseEnd = cs - 60 + 160;
    const fallStart = ce - 200;
    const fallEnd = fallStart + 120;
    const from = cs - 60 + 4;
    const to = fallEnd - 1;
    if (to > from) {
      const show = (t: number) => EASES.out(prog(t, cs - 60, 160)) * (1 - EASES.in(prog(t, fallStart, 120)));
      const apart = riseEnd < fallStart;
      const showFrames = (peak: number): Frames =>
        apart ? [[cs - 60, 0], [riseEnd, peak, "out"], [fallStart, peak], [fallEnd, 0, "in"]] : sampled((t) => show(t) * peak, [cs - 60, riseEnd, fallStart, fallEnd], 0.004 * peak);
      const xStart = X0 - PITCH / 2;
      const xEnd = xStart + BARS * PITCH;
      const at = (x: number) => space.x(rtl ? X0 + (BARS - 1) * PITCH + PITCH / 2 - (x - xStart) : x);
      const playhead: ShapePiece = {
        id: `wordform:${cueNumber}:playhead`,
        kind: "shape",
        z: z + 1,
        fromMs: from,
        toMs: to,
        track: { x: [[from, at(xStart)], [cs, at(xStart)], [ce, at(xEnd)]], y: [[from, space.y(Y_STRIP)]], sy: showFrames(1), o: showFrames(PLAYHEAD.alpha) },
        origin: { dx: (PLAYHEAD.width / 2) * u, dy: (PLAYHEAD.height / 2) * u },
        path: roundedRectPath(0, 0, PLAYHEAD.width * u, PLAYHEAD.height * u, (PLAYHEAD.width / 2) * u),
        fill: { colour: input.colours.primary },
      };
      pieces.push(playhead);
    }
  }

  // ---- the words -------------------------------------------------------------------------------------------------
  const exitFrom = ce - 190;
  const exitEnd = exitFrom + 130;
  let cursor = blockTop;
  for (const row of rows) {
    const baseline = cursor + row.above;
    cursor += row.height;
    const width = rowWidth(boxes, row.order, gap);
    let x = space.x(540) - width / 2;
    for (const at of row.order) {
      const item = items[at]!;
      item.left = x;
      x += item.box + gap;
      const word = words[at]!;
      const from = word.startMs - 70;
      const to = exitEnd;
      if (to <= from) continue;
      const faceAbove = (item.hero ? ABOVE.hero : ABOVE.body) * item.size;
      const pivotX = item.left + item.box / 2;
      const pivotY = baseline - faceAbove + PIVOT_Y * item.size;
      const fadeEnd = from + 100;
      const o: Frames =
        fadeEnd < exitFrom
          ? [[from, 0], [fadeEnd, 1], [exitFrom, 1], [exitEnd, 0, "in"]]
          : sampled((t) => prog(t, from, 100) * (1 - EASES.in(prog(t, exitFrom, 130))), [from, fadeEnd, exitFrom, exitEnd], 0.01);
      const track: TextPiece["track"] = { x: [[from, pivotX]], y: [[from, pivotY]], o, blur: [[from, 0.06 * item.size], [from + 150, 0, "out"]] };
      if (item.hero) {
        track.sx = [[from, 1.06], [from + 180, 1, "out"]];
        track.sy = track.sx;
      }
      pieces.push({
        id: `wordform:${cueNumber}:w${at}`,
        kind: "text",
        z: z + 2,
        fromMs: from,
        toMs: to,
        track,
        origin: { dx: item.box / 2, dy: pivotY - baseline },
        text: word.text,
        face: item.hero ? HERO_FACE : BODY_FACE,
        sizePx: item.size,
        letterSpacingEm: item.hero ? LETTER_SPACING.hero : LETTER_SPACING.body,
        fill: item.hero ? input.colours.highlight : input.colours.primary,
        shadows: TEXT_SHADOWS.map((shadow) => ({ dx: 0, dy: shadow.dy * u, blur: shadow.blur * u, colour: input.colours.shadow, alpha: shadow.alpha })),
        anchor: "baseline-left",
        language: cue.language,
      });
    }
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const wordformProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number)) };
  },
};
