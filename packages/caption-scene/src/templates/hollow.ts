import type { DemoScript } from "../demo";
import { clamp, EASES, type Frames, kf, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, rowVisualOrder, sceneSpace } from "../layout";
import type { Piece } from "../scene";
import { sampleFrames } from "../frames";

/**
 * Hollow (`samples/templates/21-hollow.js`): tall condensed caps wait as outlines and fill solid as each
 * word is spoken. The hero fills in the highlight colour and fires three outline echoes upward (each shows
 * only the slice above the copy in front of it), the lead row rides up on top of them, and they collapse
 * back into the hero as the cue leaves.
 *
 * Everything is laid out in the sample's 1080 x 1920 px and mapped to the canvas at the end. The sample's
 * CSS: a block of rows (flex column, centred), a row is a flex row with a gap of 0.2 em, a word's box is
 * exactly its cap height tall (`line-height` = cap height) with the baseline on its bottom edge, and the
 * whole word box (outline, shade, fill and echoes) scales together about 50 % / 55 % of the box.
 *
 * What the model cannot draw, and how it is stood in for (spec 7, Hollow):
 *  - `-webkit-text-stroke: 4px` on a transparent word is a ring 2 px inside and 2 px outside the contour. A
 *    hollow piece's stroke is an outside band only, so the waiting outline and the echoes are a band of `RING`
 *    (4) px outside the contour; the outline goes the moment the fill is solid, and the fill (the sample's fill plus its own 4 px
 *    stroke) is the contour grown by 2 px, as in the sample.
 *  - the dark halo under the outline (a blurred 14 px stroke) and the soft drop shadow under the fill
 *    (`0 10px 26px`) are one blurred dark copy of the word: libass pays per layer and per glyph area, and these
 *    two were most of the cost. A hollow stroke cannot be blurred inwards in libass as it is in Chrome, so the
 *    copy is a filled glyph (the interior of a waiting word is darker than the sample's, which is only dark
 *    near its edges), which both renderers draw the same.
 *  - an echo's `clip-path: inset()` lives in the echo's own coordinates in the sample (it moves with the box's
 *    scale); a piece's clip does not move, so each clip edge is the sample's edge pushed through the box's scale.
 *    The echoes' tiny drop shadow is dropped (a blurred layer each, invisible at 2 px).
 */

export const HOLLOW_DEMO: DemoScript = {
  lines: [
    "you:m don't:b need:b motivation",
    "you:m need:b discipline:h@560",
    "every:m single:b day:h@500",
    "zero:b excuses@600",
    "that's:m how:m champions:h@600 are:m built",
  ],
  options: { rate: 270, lead: 300, cueGap: 160, tail: 620 },
};

const FACE = "Anton" as const;
const LETTER_SPACING = 0.012;
const BODY = 124;
const PLAIN = 156; // a no-hero cue's two rows (then justified to one width)
const PLAIN_MAX_W = 860;
const HERO_MAX = 340;
const HERO_MIN = 200;
const HERO_FIT = 0.84 * 1080;
const STROKE = 4;
/** Outside band of a fill: half the sample's centred stroke, so the edge is the sample's outer edge. */
const OUTLINE = STROKE / 2;
/**
 * The ring a waiting word and an echo are drawn with: the sample's 4 px, all of it outside the contour (see the
 * header). Half of it (the fill's band) reads as a hairline on an empty word and vanishes in the Studio's preview.
 */
const RING = 4;
/**
 * The one dark blurred copy under every word: the sample's halo under the outline (a blurred 14 px stroke) and
 * its soft drop shadow under the fill (`0 10px 26px`) in a single layer, dropped a little (share of the size).
 */
const SHADE_BLUR_EM = 0.03;
const SHADE_DY = 0.03;
/** Below this size a row's strokes shrink with it. */
const STROKE_FULL_SIZE = 110;
const SHADE = "#080A0C";
const SHADE_O = 0.42;
const ECHO_STEP = 0.4; // echoes rest at 0.4, 0.8 and 1.2 hero heights above it
const ECHO_O = [0.85, 0.55, 0.28] as const;
const SLICE_GAP = 7; // air between an echo's slice and the copy in front of it
const CENTER = 1268;
const TOP_LIMIT = 878;
const BOTTOM_LIMIT = 1636;
/** Peak of a word's pulse: its box scales to this for a moment. */
const PULSE_PEAK = 1.06;
/**
 * Widest a row may be: the sample never wraps, real words can be longer. At its pulse's peak, with its halo, a row
 * must still fit the safe width (90 % of the canvas), because the safe-area clamp only shifts.
 */
const MAX_ROW = (0.9 * 1080) / PULSE_PEAK - 2 * RING;
const PIVOT_Y = 0.55;

/** `sampleFrames` on whole milliseconds: a one-millisecond segment is a jump. */
const sampled = (fn: (t: number) => number, edges: readonly number[], tolerance: number): Frames => sampleFrames(fn, edges, tolerance, { wholeMs: true });

/** The edges of `all` inside `[from, to]`, with both ends. */
const within = (all: readonly number[], from: number, to: number) => [from, ...all.filter((edge) => edge > from && edge < to), to];

/** Times in `[from, to]` where `flag` changes, found at 2 ms steps (edges for a step function). */
function flips(flag: (t: number) => boolean, from: number, to: number): number[] {
  const out: number[] = [];
  let last = flag(from);
  for (let t = from + 2; t <= to; t += 2) {
    const now = flag(t);
    if (now !== last) out.push(t - 2, t);
    last = now;
  }
  return out;
}

interface Row {
  readonly kind: "plain" | "lead" | "hero" | "tail";
  readonly size: number;
  /** Cue word indices, left to right as the viewer reads them. */
  readonly words: readonly number[];
  top: number;
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, at) => from + at);

function buildCue(cue: SceneCue, input: SceneInput, cueNumber: number): Piece[] {
  const space = sceneSpace(input, CENTER);
  const { u } = space;
  const direction = cueDirection(cue);
  const texts = cue.words.map((word) => word.text.toUpperCase());
  /** A word's flex box in sample px: CSS adds the letter spacing after every character, the last included. */
  const boxWidth = (text: string, size: number) => {
    const m = input.measure(text, FACE, size * u, LETTER_SPACING);
    return (m.advance + LETTER_SPACING * size * u) / u;
  };
  const cap = Math.max(0.3, -input.measure("H", FACE, 100 * u, 0).inkTop / (100 * u));
  const gapOf = (size: number) => Math.round(size * 0.2);
  const rowSpan = (words: readonly number[], size: number) => words.reduce((sum, at) => sum + boxWidth(texts[at]!, size), 0) + gapOf(size) * Math.max(0, words.length - 1);

  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const rows: Row[] = [];
  const visual = (words: readonly number[]) => rowVisualOrder(words.map((at) => cue.words[at]!.text), direction).map((at) => words[at]!);

  if (heroAt < 0) {
    // Two rows balanced by character count, then justified to one width, poster style, inside a sane size range.
    const chars = cue.words.map((word) => [...word.text].length);
    const total = chars.reduce((sum, n) => sum + n, 0);
    let groups: number[][] = [range(0, cue.words.length)];
    if (cue.words.length > 1) {
      let split = 1;
      let best = Number.POSITIVE_INFINITY;
      for (let at = 1; at < cue.words.length; at++) {
        const left = chars.slice(0, at).reduce((sum, n) => sum + n, 0);
        const distance = Math.abs(left - total / 2);
        if (distance < best) {
          best = distance;
          split = at;
        }
      }
      groups = [range(0, split), range(split, cue.words.length)];
      // Rows that would not fit at the smallest size wrap like body rows instead.
      if (groups.some((group) => rowSpan(group, PLAIN * 0.8) > MAX_ROW)) {
        groups = balancedRows(texts.map((text) => boxWidth(text, PLAIN * 0.8)), PLAIN * 0.8 * 0.2, MAX_ROW);
      }
    }
    const widths = groups.map((group) => rowSpan(group, PLAIN));
    const target = Math.min(PLAIN_MAX_W, Math.max(...widths));
    groups.forEach((group, at) => {
      const justified = clamp((PLAIN * target) / widths[at]!, PLAIN * 0.8, PLAIN * 1.4);
      // A single long word may need to go under the sample's lower bound to stay on the canvas.
      rows.push({ kind: "plain", size: Math.min(justified, (PLAIN * MAX_ROW) / widths[at]!), words: visual(group), top: 0 });
    });
  } else {
    const bodyRows = (kind: "lead" | "tail", words: readonly number[]) => {
      if (words.length === 0) return { size: BODY, rows: [] as Row[] };
      const widest = Math.max(...words.map((at) => boxWidth(texts[at]!, BODY)));
      const size = BODY * Math.min(1, MAX_ROW / widest);
      const groups = balancedRows(words.map((at) => boxWidth(texts[at]!, size)), gapOf(size), MAX_ROW);
      return { size, rows: groups.map((group) => ({ kind, size, words: visual(group.map((at) => words[at]!)), top: 0 })) };
    };
    const lead = bodyRows("lead", range(0, heroAt));
    const tail = bodyRows("tail", range(heroAt + 1, cue.words.length));
    const heroUnit = boxWidth(texts[heroAt]!, 100);
    let heroSize = clamp((HERO_FIT * 100) / heroUnit, HERO_MIN, HERO_MAX);
    heroSize = Math.min(heroSize, (MAX_ROW * 100) / heroUnit);
    // Keep the resting stack (lead above three echoes) inside the caption zone.
    const stackHeight = (group: { size: number; rows: Row[] }, extra: number) => (group.rows.length ? group.rows.length * group.size * cap + (group.rows.length - 1) * 14 + extra : 0);
    const room = BOTTOM_LIMIT - TOP_LIMIT - stackHeight(lead, 22) - stackHeight(tail, 18);
    heroSize = Math.min(heroSize, room / ((lead.rows.length ? 1 + ECHO_STEP * 3 : 1) * cap));
    rows.push(...lead.rows, { kind: "hero", size: heroSize, words: [heroAt], top: 0 }, ...tail.rows);
  }

  // Stack the rows like the sample's flex column.
  let cursor = 0;
  rows.forEach((row, at) => {
    const previous = rows[at - 1];
    cursor += !previous ? 0 : row.kind === "hero" || previous.kind === "hero" ? 20 : 14;
    row.top = cursor;
    cursor += row.size * cap;
  });
  const height = cursor;
  const hero = rows.find((row) => row.kind === "hero");
  const heroH = hero ? hero.size * cap : 0;
  const hasLead = rows.some((row) => row.kind === "lead");
  const reach = heroH * ECHO_STEP * 3;
  // Centre the resting stack (after the lead has ridden up); the echoes' full reach stays below the zone's top.
  let top = CENTER - (height - (hasLead ? reach : 0)) / 2;
  top = Math.max(top, TOP_LIMIT + reach);
  top = Math.min(top, BOTTOM_LIMIT - height);

  const from = cue.startMs - 80;
  const to = Math.max(cue.endMs - 30, from + 1);
  const gone = (t: number) => EASES.in(prog(t, cue.endMs - 110, 80));
  const blockOpacity = (t: number) => Math.min(1, prog(t, cue.startMs - 80, 60)) * (1 - gone(t));
  const appear = (t: number) => EASES.outExpo(prog(t, cue.startMs - 80, 180));
  const collapse = (t: number) => EASES.in(prog(t, cue.endMs - 200, 140));
  const blockEdges = [from, cue.startMs - 20, cue.endMs - 110, to];
  const blockOpacityFrames = (extra?: (t: number) => number, edges: readonly number[] = [], start = from): Frames =>
    sampled((t) => blockOpacity(t) * (extra ? extra(t) : 1), within([...blockEdges, ...edges], start, to), 0.01);

  // The hero's echoes: lift of each, the stack's top, and what each slice shows.
  const heroWord = heroAt >= 0 ? cue.words[heroAt]! : null;
  const echoStart = (at: number) => (heroWord ? heroWord.startMs + at * 60 : 0);
  const lift = (at: number, t: number) => EASES.outExpo(prog(t, echoStart(at), 260)) * (1 - collapse(t)) * ECHO_STEP * (at + 1) * heroH;
  const stackTop = (t: number) => Math.max(0, lift(0, t), lift(1, t), lift(2, t));
  const echoEdges = heroWord ? [0, 1, 2].flatMap((at) => [echoStart(at), echoStart(at) + 260]).concat([cue.endMs - 200, cue.endMs - 60]) : [];
  const band = (at: number, t: number) => lift(at, t) - (at === 0 ? 0 : lift(at - 1, t)) - SLICE_GAP;
  const leadRide = heroWord && hasLead ? sampled(stackTop, within(echoEdges, from, to), 0.25 / u) : null;

  const pieces: Piece[] = [];
  const base = cueNumber * 8;

  for (const row of rows) {
    const size = row.size;
    const boxH = size * cap;
    // The strokes are the sample's at every size it uses (rows of 124 px and up); a word squeezed far below that keeps its counters.
    const k = Math.max(0.6, Math.min(1, size / STROKE_FULL_SIZE));
    const widths = row.words.map((at) => boxWidth(texts[at]!, size));
    const total = widths.reduce((sum, w) => sum + w, 0) + gapOf(size) * Math.max(0, row.words.length - 1);
    let left = 540 - total / 2;
    row.words.forEach((at, order) => {
      const word = cue.words[at]!;
      const boxW = widths[order]!;
      const boxTop = top + row.top;
      const baseline = boxTop + boxH; // the word's baseline is its box's bottom edge
      const isHero = row.kind === "hero";
      const pivot = { x: left + boxW / 2, y: boxTop + PIVOT_Y * boxH };
      const wordLeft = left;
      left += boxW + gapOf(size);

      const PX = space.x(pivot.x);
      const PY = space.y(pivot.y);
      const origin = { dx: PX - space.x(wordLeft), dy: PY - space.y(baseline) };
      const pulse = (t: number) =>
        kf(t, [
          [word.startMs - 20, 1],
          [word.startMs + 80, PULSE_PEAK, "out"],
          [word.startMs + 280, 1, "inOut"],
        ]);
      const scale = (t: number) => (0.93 + 0.07 * appear(t)) * pulse(t) * (1 + gone(t) * 0.04);
      const scaleFrames = sampled(scale, within([cue.startMs + 100, word.startMs - 20, word.startMs + 80, word.startMs + 280, cue.endMs - 110], from, to), 0.0015);
      const common = {
        kind: "text" as const,
        text: texts[at]!,
        face: FACE,
        sizePx: size * u,
        letterSpacingEm: LETTER_SPACING,
        anchor: "baseline-left" as const,
        origin,
        language: cue.language,
        toMs: to,
      };
      const still: Frames = [[from, PX]];
      const lifted = (frames: Frames | null): Frames => (frames ? frames.map(([ms, value]) => [ms, PY - value * u] as [number, number]) : [[from, PY]]);
      const rideY = lifted(isHero ? null : row.kind === "lead" ? leadRide : null);
      const heroColour = input.colours.highlight;
      const fillColour = isHero ? heroColour : input.colours.primary;

      // Echoes first: they sit under everything else of the word.
      if (isHero) {
        for (let echo = 0; echo < ECHO_O.length; echo++) {
          const start = echoStart(echo);
          const pieceFrom = Math.max(from, start);
          if (pieceFrom >= to) continue;
          const edges = within([...echoEdges, ...scaleFrames.map((frame) => frame[0]), ...flips((t) => band(echo, t) > 0.5, pieceFrom, to)], pieceFrom, to);
          const s = scale;
          const lx1 = space.x(wordLeft - 40);
          const lx2 = space.x(wordLeft + boxW + 40);
          const ly1 = space.y(boxTop - reach - 60);
          const front = (t: number) => (echo === 0 ? 0 : lift(echo - 1, t));
          pieces.push({
            ...common,
            id: `hollow:${cueNumber}:w${at}:echo${echo}`,
            z: base,
            fromMs: pieceFrom,
            fill: heroColour,
            fillAlpha: 0,
            stroke: { widthPx: RING * k * u, colour: heroColour },
            track: {
              x: still,
              y: sampled((t) => PY - s(t) * lift(echo, t) * u, edges, 0.25),
              sx: sampled(s, edges, 0.0015),
              sy: sampled(s, edges, 0.0015),
              o: sampled((t) => (band(echo, t) > 0.5 ? ECHO_O[echo]! * blockOpacity(t) : 0), edges, 0.01),
            },
            // The slice above the copy in front, in the box's frame, pushed through the box's scale.
            clip: {
              x1: sampled((t) => PX + s(t) * (lx1 - PX), edges, 0.4),
              x2: sampled((t) => PX + s(t) * (lx2 - PX), edges, 0.4),
              y1: sampled((t) => PY + s(t) * (ly1 - PY), edges, 0.4),
              y2: sampled((t) => PY + s(t) * (space.y(boxTop - front(t) - SLICE_GAP) - PY), edges, 0.3),
            },
          });
        }
      }

      const sx: Frames = scaleFrames;
      // One dark blurred copy under the word: the sample's halo under the outline and the soft drop shadow under the fill.
      pieces.push({
        ...common,
        id: `hollow:${cueNumber}:w${at}:shade`,
        z: base + 1,
        fromMs: from,
        fill: SHADE,
        track: { x: still, y: rideY.map((frame) => [frame[0], frame[1] + SHADE_DY * size * u] as [number, number]), o: blockOpacityFrames((t) => SHADE_O + 0 * t), blur: [[from, size * SHADE_BLUR_EM * u]] },
      });
      // The outline every word waits as.
      pieces.push({
        ...common,
        id: `hollow:${cueNumber}:w${at}:outline`,
        z: base + 2,
        fromMs: from,
        toMs: Math.min(to, word.startMs + 70),
        fill: input.colours.primary,
        fillAlpha: 0,
        stroke: { widthPx: RING * k * u, colour: input.colours.primary },
        // The sample's ring is 2 px inside and 2 px outside the contour; this one is all outside, so it goes
        // the moment the fill is solid (the fill's own edge is the sample's outer edge).
        track: { x: still, y: rideY, sx, sy: sx, o: blockOpacityFrames((t) => (t < word.startMs + 70 ? 1 : 0), [word.startMs + 69, word.startMs + 70]) },
      });
      // The fill that snaps in as the word is spoken.
      const fillFrom = Math.min(Math.max(from, word.startMs - 20), to - 1);
      pieces.push({
        ...common,
        id: `hollow:${cueNumber}:w${at}:fill`,
        z: base + 3,
        fromMs: fillFrom,
        fill: fillColour,
        stroke: { widthPx: OUTLINE * k * u, colour: fillColour },
        track: {
          x: still,
          y: rideY,
          sx,
          sy: sx,
          o: sampled((t) => prog(t, word.startMs - 20, 90) * blockOpacity(t), within([...blockEdges, word.startMs - 20, word.startMs + 70], fillFrom, to), 0.01),
        },
      });
    });
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const hollowProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number)) };
  },
};

/** Used by the tests: the sample's echo lift above the hero (sample px, fraction of the hero's height times 1) at `t`. */
export function hollowEchoLift(t: number, heroStartMs: number, echo: number, cueEndMs: number): number {
  const out = EASES.in(prog(t, cueEndMs - 200, 140));
  return EASES.outExpo(prog(t, heroStartMs + echo * 60, 260)) * (1 - out) * ECHO_STEP * (echo + 1);
}

/** Used by the tests: the sample's scale of a word's box at `t`. */
export function hollowWordScale(t: number, wordStartMs: number, cueStartMs: number, cueEndMs: number): number {
  const pulse = kf(t, [
    [wordStartMs - 20, 1],
    [wordStartMs + 80, PULSE_PEAK, "out"],
    [wordStartMs + 280, 1, "inOut"],
  ]);
  return (0.93 + 0.07 * EASES.outExpo(prog(t, cueStartMs - 80, 180))) * pulse * (1 + EASES.in(prog(t, cueEndMs - 110, 80)) * 0.04);
}
