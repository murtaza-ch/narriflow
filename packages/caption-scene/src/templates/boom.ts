import type { DemoScript } from "../demo";
import { type Frames, EASES, clamp, lerp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, fitScale, rowVisualOrder, sceneSpace } from "../layout";
import { type PathCmd, type Piece, type ShapePiece, type TextPiece, mixColour } from "../scene";
import { ellipsePath, pathBounds, polygonPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Boom (`samples/templates/41-boom.js`): a comic-book panel bursting out of the caption. The hero is a fat yellow
 * Luckiest Guy block with a hot-pink extrusion and a black rim; a two-layer starburst (white back, pink front with
 * Ben-Day dots) stamps in behind it with a spring and turns slowly, eight tapered speed lines shoot out of it, and
 * the support words pop around it like lettering (Lilita One, a thick black outline and a hard shadow). A cue
 * without a hero is two rows of bigger lettering with a smaller burst behind its last word.
 *
 * Geometry is the sample's, read in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`): the hero is sized
 * so its glyphs span 790 px (at most 230 px), its baseline 0.7045 em below the top of its `line-height: 1` box,
 * the box dropped 0.06 em under the hero's centre line; the burst is an ellipse of `min(470, w / 2 + 130)` by
 * `0.62 F + 118` px; the lead row sits `ry - 6` above the hero's centre and the tail `ry - 2` below, the block
 * centred on y 1290. The bursts and the dots are the sample's seeded shapes, exactly.
 *
 * Shape outlines join round (the sample mitres its burst's 8 px stroke); bursts and speed lines bleed past the
 * safe area as the sample's do (`bleed`), the words do not.
 */

export const BOOM_DEMO: DemoScript = {
  lines: [
    "don't:b touch:b the:m red:b button:b@400",
    "so:m he:b obviously:b SMASHED:h@560 it:m",
    "and:m the:m whole:b server",
    "just:b EXPLODED:h@640",
    "GG:h@560",
  ],
  options: { rate: 270, cueGap: 160 },
};

const CX = 540;
const CENTER_Y = 1290;
const HERO_MAX = 230;
const HERO_FIT = 790;
const SUPPORT = 86;
const SOLO = 110;
const HERO_FACE = "Luckiest Guy" as const;
const SUPPORT_FACE = "Lilita One" as const;
const SUPPORT_LS = 0.01;
/** Centred 28 px, so 14 px outside the glyph; the black rim copies 44. */
const FACE_STROKE = 28;
const RIM_STROKE = FACE_STROKE + 16;
const STEP = [1.7, 2.15] as const;
const BURST_STROKE = 8;
const INK = "#000000";
/** The burst's face is the extrusion's pink lightened (the sample's `#FF85B8` over `#FF3D7F`). */
const BURST_LIGHTEN = 0.4;
/** Chrome puts Luckiest Guy's baseline this far below the top of a `line-height: 1` box (162 of 230, 134 of 190 px). */
const HERO_BASELINE_EM = 0.7045;
const HERO_DROP_EM = 0.06;
const EXIT = 120;
const HERO_POP = 360;
const WORD_POP = 260;
const LINE_MS = 220;
/** The most the spring ever scales a popping word. */
const POP_PEAK = Math.max(...Array.from({ length: 201 }, (_, at) => EASES.spring(at / 200)));

/** Extrusion copies drawn, deepest first: the sample's `i` for the black rim (3..18) and the pink stack (1..18). */
export const BOOM_RIM_STEPS: readonly number[] = [18, 10, 3];
export const BOOM_EXTRUDE_STEPS: readonly number[] = [18, 12, 6, 1];

/** The sample's seeded generator (mulberry32). */
export function boomRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** The sample's `burstPoints`, one decimal, centred on (0, 0). */
export function boomBurstPoints(seed: number, rx: number, ry: number, spikes: number, inner: number): [number, number][] {
  const r = boomRng(seed);
  const points: [number, number][] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const tip = i % 2 === 0;
    const a = ((i + (r() - 0.5) * 0.5) / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const k = tip ? 0.86 + r() * 0.14 : inner + r() * 0.07;
    points.push([Math.round(Math.cos(a) * rx * k * 10) / 10, Math.round(Math.sin(a) * ry * k * 10) / 10]);
  }
  return points;
}

/** The sample's `halftone`: Ben-Day dots inside the burst, growing toward the bottom right. */
export function boomHalftone(rx: number, ry: number, reach: number): { x: number; y: number; r: number }[] {
  const gap = 30;
  const dots: { x: number; y: number; r: number }[] = [];
  for (let y = -ry; y <= ry; y += gap * 0.87) {
    const row = Math.round(y / (gap * 0.87));
    for (let x = -rx + (row % 2 ? gap / 2 : 0); x <= rx; x += gap) {
      const e = (x / rx) ** 2 + (y / ry) ** 2;
      if (e > reach * reach) continue;
      const f = clamp((x / rx + y / ry + 1.1) / 2.2);
      const r = 2 + 7.5 * f * (1 - 0.35 * e);
      if (r < 2.6) continue;
      dots.push({ x, y, r });
    }
  }
  return dots;
}

/** Distance from the top of a `line-height: 1` Lilita One box to its baseline, as Chrome rounds it (ascent .923, descent .22). */
export function boomSupportBaseline(sizePx: number): number {
  const ascent = Math.round(0.923 * sizePx);
  const descent = Math.round(0.22 * sizePx);
  return ascent + (sizePx - ascent - descent) / 2;
}

/** A path drawn from its own top-left with its pivot (local (0, 0)) in `origin`: libass places a drawing by its box. */
function anchored(path: readonly PathCmd[]): { path: PathCmd[]; origin: { dx: number; dy: number } } {
  const box = pathBounds(path);
  const moved = path.map((cmd): PathCmd => {
    if (cmd[0] === "Z") return cmd;
    if (cmd[0] === "C") return ["C", cmd[1] - box.x1, cmd[2] - box.y1, cmd[3] - box.x1, cmd[4] - box.y1, cmd[5] - box.x1, cmd[6] - box.y1];
    return [cmd[0], cmd[1] - box.x1, cmd[2] - box.y1];
  });
  return { path: moved, origin: { dx: -box.x1, dy: -box.y1 } };
}

function buildCue(cue: SceneCue, cueNumber: number, input: SceneInput): Piece[] {
  const space = sceneSpace(input, CENTER_Y);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const band = cueNumber * 10;
  const fromMs = cue.startMs - 60;
  const toMs = cue.endMs - 50;
  const exitFrom = cue.endMs - 50 - EXIT;
  const exitTo = cue.endMs - 50;
  const burstFace = mixColour(input.colours.accent, "#FFFFFF", BURST_LIGHTEN);
  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const pieces: Piece[] = [];

  // The block shrinks to 0.85 about (540, originY) and fades over the last 120 ms before `end - 50`.
  const exitScale = (t: number) => lerp(1, 0.85, EASES.in(prog(t, exitFrom, EXIT)));
  const exitOpacity: Frames = [[exitFrom, 1], [exitTo, 0, "in"]];
  /**
   * A track that is the piece's own animation (settled at `settle`) composed with the block's exit: exact eased segments
   * when the two windows are apart, sampled when the exit starts before the piece has settled.
   */
  const composed = (own: Frames, ownAt: (t: number) => number, settle: number, combine: (value: number, e: number) => number, from: number, tolerance: number): Frames => {
    if (settle <= exitFrom) {
      const rest = own[own.length - 1]![1];
      return [...own, [exitFrom, combine(rest, 1)], [exitTo, combine(rest, 0.85), "in"]];
    }
    return sampleFrames((t) => combine(ownAt(t), exitScale(t)), [from, settle, exitFrom, exitTo].filter((t) => t >= from).sort((a, b) => a - b), tolerance);
  };
  const about = (origin: number) => (value: number, e: number) => origin + e * (value - origin);
  const times = (value: number, e: number) => value * e;
  const ox = space.x(CX);
  let originY = space.y(CENTER_Y);

  // --- support words: Lilita One with a 0.233 em centred outline and a hard shadow, popped with a spring and a tilt ---
  interface RowWord {
    readonly index: number;
    readonly width: number;
    left: number;
  }
  interface Row {
    readonly words: RowWord[];
    readonly size: number;
    readonly cy: number;
  }
  const rows: Row[] = [];
  const maxRow = 0.9 * space.canvas.width;
  const makeRow = (indices: readonly number[], nominal: number, cy: number) => {
    const widthsAt = (size: number) => indices.map((at) => input.measure(cue.words[at]!.text.toUpperCase(), SUPPORT_FACE, size, SUPPORT_LS).advance + SUPPORT_LS * size);
    let size = nominal * u;
    let widths = widthsAt(size);
    // A row is fitted at its widest moment: each word pops about its own centre past its rest size (the spring's peak), so the
    // end words reach out by half their overshoot; the outline, the hard shadow and the tilt's lean add about 0.4 em.
    const reach = (list: number[], s: number) =>
      list.reduce((sum, w) => sum + w, 0) + 0.26 * s * (list.length - 1) + ((POP_PEAK - 1) * (list[0]! + list[list.length - 1]!)) / 2 + 0.4 * s;
    const shrink = fitScale(reach(widths, size), maxRow);
    if (shrink < 1) {
      size *= shrink;
      widths = widthsAt(size);
    }
    const gap = 0.26 * size;
    const ordered = rowVisualOrder(indices.map((at) => cue.words[at]!.text), rtl ? "rtl" : "ltr");
    const width = ordered.reduce((sum, at) => sum + widths[at]!, 0) + gap * (ordered.length - 1);
    let x = ox - width / 2;
    const words = ordered.map((at) => {
      const word = { index: indices[at]!, width: widths[at]!, left: x };
      x += widths[at]! + gap;
      return word;
    });
    rows.push({ words, size, cy });
  };

  // --- the burst: a white back layer and a pink front layer with dots, stamping in with a spring and turning slowly ---
  const burst = (seedBack: number, seedFront: number, rx: number, ry: number, spikes: number, inner: number, backScale: [number, number], x: number, y: number, start: number, big: boolean) => {
    const b0 = start - 60;
    const turn = (t: number) => -9 + (8 * (t - b0)) / 1000;
    const layer = (part: string, z: number, path: PathCmd[], fill: string, stroke: boolean, delay: number, dur: number, extra: number) => {
      const shape = anchored(path);
      const from = Math.max(fromMs, b0 + delay + 4);
      const ownScale: Frames = [[b0 + delay, 0], [b0 + delay + dur, 1, "spring"]];
      const scaleAt = (t: number) => (t < b0 + delay ? 0 : EASES.spring(prog(t, b0 + delay, dur)));
      const s = composed(ownScale, scaleAt, b0 + delay + dur, times, from, 0.004);
      const piece: ShapePiece = {
        id: `boom:${cueNumber}:${part}`,
        kind: "shape",
        z: band + z,
        fromMs: from,
        toMs,
        bleed: true,
        track: {
          x: composed([[from, x]], () => x, from, about(ox), from, 0.25),
          y: composed([[from, y]], () => y, from, about(originY), from, 0.25),
          sx: s,
          sy: s,
          rz: [[from, turn(from) + extra], [toMs, turn(toMs) + extra]],
          o: exitOpacity,
        },
        origin: shape.origin,
        path: shape.path,
        fill: { colour: fill },
        ...(stroke ? { stroke: { widthPx: BURST_STROKE * u, colour: INK } } : {}),
      };
      pieces.push(piece);
    };
    const back = boomBurstPoints(seedBack, rx * backScale[0], ry * backScale[1], spikes, inner).map(([px, py]) => [px * u, py * u] as [number, number]);
    const front = boomBurstPoints(seedFront, rx, ry, spikes, inner + 0.02).map(([px, py]) => [px * u, py * u] as [number, number]);
    const dots = boomHalftone(rx, ry, big ? 0.64 : 0.6).flatMap((dot) => ellipsePath(dot.x * u, dot.y * u, dot.r * u));
    const frontDelay = big ? 30 : 0;
    const frontDur = big ? 360 : 380;
    layer("burst-back", 0, polygonPath(back), input.colours.primary, true, 0, 380, big ? 3 : 0);
    layer("burst-front", 1, polygonPath(front), burstFace, true, frontDelay, frontDur, 0);
    if (dots.length > 0) layer("dots", 2, dots, input.colours.accent, false, frontDelay, frontDur, 0);
  };

  if (heroAt < 0) {
    // Two rows split by length; a small burst behind the last word.
    const words = cue.words;
    const total = words.reduce((sum, word) => sum + word.text.length, 0);
    let split = 1;
    let acc = 0;
    for (let i = 0; i < words.length - 1; i++) {
      acc += words[i]!.text.length;
      split = i + 1;
      if (acc >= total / 2) break;
    }
    const groups = [words.slice(0, split).map((_, at) => at), words.slice(split).map((_, at) => split + at)].filter((group) => group.length > 0);
    const rowGap = SOLO * 1.12;
    const top0 = CENTER_Y - ((groups.length - 1) * rowGap) / 2;
    groups.forEach((group, gi) => {
      makeRow(group, SOLO, space.y(top0 + gi * rowGap));
    });
    const lastRow = rows[rows.length - 1]!;
    const last = lastRow.words.reduce((a, b) => (b.index > a.index ? b : a));
    const wx = last.left + last.width / 2;
    const rx = last.width / u / 2 + 120;
    const ry = SOLO * 0.5 + 92;
    burst(7 + cue.index, 3 + cue.index, rx, ry, 12, 0.6, [1.14, 1.16], wx, lastRow.cy - SOLO * 0.05 * u, cue.words[last.index]!.startMs, false);
  } else {
    const word = cue.words[heroAt]!;
    const lead = cue.words.slice(0, heroAt).map((_, at) => at);
    const tail = cue.words.slice(heroAt + 1).map((_, at) => heroAt + 1 + at);
    const text = word.text;
    // The hero at full size, then fitted (the sample reads `offsetWidth`, whole px).
    const probeW = Math.round(input.measure(text, HERO_FACE, HERO_MAX * u, 0).advance / u);
    const F = Math.min(HERO_MAX, (HERO_MAX * HERO_FIT) / probeW);
    const heroW = (probeW * F) / HERO_MAX;
    const ry = F * 0.62 + 118;
    const rx = Math.min(470, heroW / 2 + 130);
    const leadOff = lead.length ? ry - 6 : 0;
    const tailOff = tail.length ? ry - 2 : 0;
    const topExt = lead.length ? leadOff + SUPPORT / 2 : ry;
    const botExt = tail.length ? tailOff + SUPPORT / 2 : ry;
    const hy = CENTER_Y + (topExt - botExt) / 2;
    originY = space.y(hy);
    burst(11 + cue.index, 29 + cue.index, rx, ry, 16, 0.64, [1.1, 1.16], ox, space.y(hy), word.startMs, true);

    // Speed lines: tapered wedges, thin end toward the hero, flying out along the burst's ellipse for 220 ms.
    const since0 = word.startMs - 60;
    for (let i = 0; i < 8; i++) {
      const a = ((i + 0.5) / 8) * Math.PI * 2 + (i % 2 ? 0.12 : -0.08);
      const len = 190 + (i % 3) * 50;
      const w = 44 + (i % 2) * 14;
      const ex = Math.cos(a) * rx;
      const ey = Math.sin(a) * ry;
      const rim = Math.hypot(ex, ey);
      const ang = Math.atan2(ey, ex);
      const reach = Math.min(500 / Math.max(0.01, Math.abs(Math.cos(ang))), (Math.sin(ang) < 0 ? hy - 860 : 1650 - hy) / Math.max(0.01, Math.abs(Math.sin(ang))));
      const far = Math.min(rim * 1.12, reach - len - 6);
      const d0 = rim * 0.5;
      const d1 = Math.max(rim * 0.7, far);
      const from = Math.max(fromMs, since0);
      const to = Math.min(toMs, since0 + LINE_MS);
      if (to <= from) continue;
      const shape = anchored(polygonPath([[0, 0], [len * u, (-w / 2) * u], [(len + 6) * u, 0], [len * u, (w / 2) * u]]));
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      const dAt = (t: number) => lerp(d0, d1, EASES.outExpo(prog(t, since0, LINE_MS)));
      const lineO = (t: number) => 1 - EASES.in(clamp((prog(t, since0, LINE_MS) - 0.55) / 0.45));
      const free = since0 + LINE_MS <= exitFrom;
      const track: ShapePiece["track"] = free
        ? {
            x: [[since0, ox + d0 * u * cos], [since0 + LINE_MS, ox + d1 * u * cos, "outExpo"]],
            y: [[since0, space.y(hy) + d0 * u * sin], [since0 + LINE_MS, space.y(hy) + d1 * u * sin, "outExpo"]],
            sx: [[since0, 1], [since0 + LINE_MS, 0.35, "in"]],
            sy: [[since0, 1], [since0 + LINE_MS, 0.6]],
            rz: [[from, (ang * 180) / Math.PI]],
            o: [[since0 + 0.55 * LINE_MS, 1], [since0 + LINE_MS, 0, "in"]],
          }
        : {
            x: sampleFrames((t) => ox + exitScale(t) * dAt(t) * u * cos, [from, exitFrom, to], 0.25),
            y: sampleFrames((t) => space.y(hy) + exitScale(t) * dAt(t) * u * sin, [from, exitFrom, to], 0.25),
            sx: sampleFrames((t) => exitScale(t) * lerp(1, 0.35, EASES.in(prog(t, since0, LINE_MS))), [from, exitFrom, to], 0.004),
            sy: sampleFrames((t) => exitScale(t) * lerp(1, 0.6, prog(t, since0, LINE_MS)), [from, exitFrom, to], 0.004),
            rz: [[from, (ang * 180) / Math.PI]],
            o: sampleFrames((t) => lineO(t) * (1 - EASES.in(prog(t, exitFrom, EXIT))), [from, since0 + 0.55 * LINE_MS, exitFrom, to].filter((at) => at >= from).sort((p, q) => p - q), 0.01),
          };
      pieces.push({
        id: `boom:${cueNumber}:line${i}`,
        kind: "shape",
        z: band + 3,
        fromMs: from,
        toMs: to,
        bleed: true,
        track,
        origin: { dx: shape.origin.dx, dy: shape.origin.dy },
        path: shape.path,
        fill: { colour: INK },
      });
    }

    // The hero: the black rim stack, the pink stack, then the face, all one group popping with a spring and a turn about (540, hy).
    const size = F * u;
    const pivotY = space.y(hy);
    const baselineY = space.y(hy - F / 2 + HERO_DROP_EM * F + HERO_BASELINE_EM * F);
    const hs = word.startMs - 60;
    const heroFrom = Math.max(fromMs, hs);
    const scaleOwn: Frames = [[hs, 0.3], [hs + HERO_POP, 1, "spring"]];
    const scaleAt = (t: number) => lerp(0.3, 1, EASES.spring(prog(t, hs, HERO_POP)));
    const s = composed(scaleOwn, scaleAt, hs + HERO_POP, times, heroFrom, 0.003);
    const y = composed([[heroFrom, pivotY]], () => pivotY, heroFrom, about(originY), heroFrom, 0.25);
    const rz: Frames = [[hs, -18], [hs + HERO_POP, -6, "spring"]];
    const copy = (part: string, z: number, fill: string, stroke: { widthPx: number; colour: string }, step: number): TextPiece => ({
      id: `boom:${cueNumber}:${part}`,
      kind: "text",
      z: band + z,
      fromMs: heroFrom,
      toMs,
      track: { x: [[heroFrom, ox]], y, sx: s, sy: s, rz, o: exitOpacity },
      origin: { dx: -STEP[0] * step * u, dy: pivotY - (baselineY + STEP[1] * step * u) },
      text,
      face: HERO_FACE,
      sizePx: size,
      letterSpacingEm: 0,
      fill,
      stroke,
      anchor: "baseline-center",
      language: cue.language,
    });
    // The rim copies' insides are always under the pink stack, so they are outline only (one image each in libass, not two).
    for (const step of BOOM_RIM_STEPS) pieces.push({ ...copy(`rim${step}`, 4, INK, { widthPx: (RIM_STROKE / 2) * u, colour: INK }, step), fillAlpha: 0 });
    for (const step of BOOM_EXTRUDE_STEPS) pieces.push(copy(`ext${step}`, 5, input.colours.accent, { widthPx: (FACE_STROKE / 2) * u, colour: input.colours.accent }, step));
    pieces.push(copy("hero", 6, input.colours.highlight, { widthPx: (FACE_STROKE / 2) * u, colour: INK }, 0));

    if (lead.length) makeRow(lead, SUPPORT, space.y(hy - leadOff));
    if (tail.length) makeRow(tail, SUPPORT, space.y(hy + tailOff));
  }

  // The support words, over everything; tilts alternate -3 and 3 degrees in reading order across rows.
  let n = 0;
  for (const row of rows) {
    const top = row.cy - row.size / 2;
    const baseline = top + boomSupportBaseline(row.size / u) * u;
    for (const item of [...row.words].sort((a, b) => a.index - b.index)) {
      const word = cue.words[item.index]!;
      const tilt = n++ % 2 === 0 ? -3 : 3;
      const ws = word.startMs - 60;
      const from = Math.max(fromMs, ws + 4);
      if (from >= toMs) continue;
      const pivot = { x: item.left + item.width / 2, y: row.cy };
      const scaleAt = (t: number) => EASES.spring(prog(t, ws, WORD_POP));
      const s = composed([[ws, 0], [ws + WORD_POP, 1, "spring"]], scaleAt, ws + WORD_POP, times, from, 0.004);
      pieces.push({
        id: `boom:${cueNumber}:w${item.index}`,
        kind: "text",
        z: band + 8,
        fromMs: from,
        toMs,
        track: {
          x: composed([[from, pivot.x]], () => pivot.x, from, about(ox), from, 0.25),
          y: composed([[from, pivot.y]], () => pivot.y, from, about(originY), from, 0.25),
          sx: s,
          sy: s,
          rz: [[ws, tilt * 3], [ws + WORD_POP, tilt, "spring"]],
          o: exitOpacity,
        },
        origin: { dx: item.width / 2, dy: pivot.y - baseline },
        text: word.text.toUpperCase(),
        face: SUPPORT_FACE,
        sizePx: row.size,
        letterSpacingEm: SUPPORT_LS,
        fill: input.colours.primary,
        stroke: { widthPx: 0.1165 * row.size, colour: INK },
        shadows: [{ dx: 0.07 * row.size, dy: 0.09 * row.size, blur: 0, colour: INK, alpha: 1 }],
        anchor: "baseline-left",
        language: cue.language,
      });
    }
  }
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const boomProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => (cue.words.length === 0 ? [] : buildCue(cue, number, input))) };
  },
};
