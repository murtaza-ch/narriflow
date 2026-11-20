import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, lerp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import type { PathCmd, Piece, ShapePiece, TextPiece } from "../scene";
import { pathBounds } from "../shapes";

/**
 * Doodle (`samples/templates/42-doodle.js`): the caption is handwritten with a paint marker as it is
 * spoken. Every word is wiped in left to right over 85 % of its spoken time; the hero (Permanent
 * Marker, tipped -3 degrees) gets one pen loop, three ticks and, with a lead-in, a hooked arrow
 * pointing at it; a cue without a hero gets an underline. Every mark is revealed by a wipe, and the
 * whole cue fades in 120 ms.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`
 * and a probe of the marks' paths): a word's wipe box is its box padded 0.2 em on every side; rows are
 * flex rows with a 0.3 em gap and sit at the sample's `cy` lines; a `line-height: 1` box puts the
 * baseline at 0.83 em (Caveat Brush) and 0.896 em (Permanent Marker, from the face's ascent and
 * descent). All of it is computed in the sample's 1080 x 1920 px and mapped through `sceneSpace`.
 *
 * Deviations (spec 7): the hero's wipe is a canvas-axis `clip` where the sample's inset rotates with the
 * hero (its edge leans 3 degrees); marks are shape strokes, and the wipe of a mark is a clip too.
 */

export const DOODLE_DEMO: DemoScript = {
  lines: [
    "nobody:b tells:b you:m this",
    "motivation:b+260 is:m a:m myth:h@560",
    "systems:h@600+580 beat:b willpower:b",
    "small:b wins:b every:m day:h@520",
    "promise:h@620+580",
  ],
  options: { rate: 265, cueGap: 140, tail: 720 },
};

const ANCHOR_LINE = 1290;
const CX = 540;
const BODY = 100;
const SOLO = 112;
const HERO_MAX = 190;
const HERO_FIT = 760;
const PEN = 9;
const PAD = 0.2;
const MARK_PAD = PEN + 6;
const GAP_EM = 0.3;
const ROW_STEP = 1.05;
const HERO_TILT_DEG = -3;
const EXIT = 120;
/** Widest a row may be before it wraps, share of the canvas width. */
const MAX_ROW_SHARE = 0.9;
/** Sample px a no-hero row leaves for its underline: 18 before the word, 26 after it, and the pen width on each side. */
const UNDERLINE_ROOM = 18 + 26 + 2 * PEN;
const BODY_FACE = "Caveat Brush" as const;
const HERO_FACE = "Permanent Marker" as const;
/** Baseline of a `line-height: 1` box, em from its top: (1 - (ascent + descent)) / 2 + ascent. */
const BASELINE = { body: 0.83, hero: 0.896 } as const;
const TEXT_SHADOWS = [
  { dy: 4, blur: 7, alpha: 0.6 },
  { dy: 2, blur: 1.5, alpha: 0.45 },
] as const;
/** `drop-shadow(0 3px 5px ...)`: a CSS blur radius is twice the sigma. */
const MARK_SHADOW = { dy: 3, blur: 2.5, alpha: 0.55 } as const;

type Pt = readonly [number, number];

/** The most the tick pop's spring ever scales a tick to. */
const SPRING_PEAK = Math.max(...Array.from({ length: 101 }, (_, at) => EASES.spring(at / 100)));

/** Catmull-Rom through the points as one smooth cubic path (the sample's `smooth`). */
export function smoothPath(pts: readonly Pt[]): PathCmd[] {
  const out: PathCmd[] = [["M", pts[0]![0], pts[0]![1]]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    out.push(["C", p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]]);
  }
  return out;
}

function boxOf(pts: readonly Pt[], pad: number) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

/**
 * A pen loop around a box: starts at the left just above centre, runs clockwise over the top, under the
 * bottom, and overshoots past its start on a slightly wider radius. The radius wobbles with two
 * incommensurate waves so no two loops match (`seed`).
 */
export function loopPoints(cx: number, cy: number, rx: number, ry: number, seed: number): { top: Pt[]; bottom: Pt[] } {
  const tilt = (-4 * Math.PI) / 180;
  const a0 = Math.PI + 0.16;
  const a1 = 3 * Math.PI + 0.5;
  const mid = 2 * Math.PI + 0.05;
  const make = (from: number, to: number, n: number): Pt[] => {
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const a = lerp(from, to, i / n);
      const k = (a - a0) / (a1 - a0);
      const wob = 1 + 0.04 * Math.sin(2.3 * a + seed) + 0.025 * Math.sin(4.1 * a + seed * 2.7);
      const spiral = 1 - 0.05 + 0.11 * k;
      const flat = a > Math.PI && a < 2 * Math.PI ? 0.96 : 1.02;
      const x = Math.cos(a) * rx * wob * spiral;
      const y = Math.sin(a) * ry * wob * spiral * flat + (k - 0.5) * 10;
      pts.push([cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)]);
    }
    return pts;
  };
  return { top: make(a0, mid, 14), bottom: make(mid, a1, 16) };
}

/** The three ticks off the loop's top right: each is three points, the first on the loop. */
export function tickPoints(cx: number, hy: number, rx: number, ry: number): Pt[][] {
  const tilt = (-4 * Math.PI) / 180;
  const corner = (a: number, k: number): Pt => {
    const x = Math.cos(a) * rx * k;
    const y = Math.sin(a) * ry * k;
    return [cx + x * Math.cos(tilt) - y * Math.sin(tilt), hy - 8 + x * Math.sin(tilt) + y * Math.cos(tilt)];
  };
  return [-0.78, -0.47, -0.17].map((a, i) => {
    const [x0, y0] = corner(a, 1.09);
    const len = [42, 52, 38][i]!;
    const dir = a * 1.15 - 0.12;
    const x1 = x0 + Math.cos(dir) * len;
    const y1 = y0 + Math.sin(dir) * len * 1.1;
    return [[x0, y0], [lerp(x0, x1, 0.5) + 2, lerp(y0, y1, 0.5) - 2], [x1, y1]] as Pt[];
  });
}

/** The hooked arrow from the end of the lead row down to the loop's crown: the shaft's points, tip and two head ends. */
export function arrowPoints(leadEnd: number, leadCy: number, hy: number, ry: number, heroW: number): { shaft: Pt[]; head: [Pt, Pt, Pt] } {
  const x0 = Math.min(leadEnd + 18, 975);
  const y0 = hy + leadCy + BODY * 0.12;
  const tipX = Math.min(x0 - 60, CX + heroW * 0.12);
  const tipY = hy - 8 - ry * 1.02 - 12;
  const span = x0 - tipX;
  const dy = tipY - y0;
  const shaft: Pt[] = [
    [x0, y0],
    [x0 + 30, y0 + dy * 0.26],
    [x0 - span * 0.36, y0 + dy * 0.56],
    [tipX + span * 0.12, tipY - dy * 0.24],
    [tipX, tipY],
  ];
  const [px, py] = shaft[3]!;
  const ang = Math.atan2(tipY - py, tipX - px);
  const end = (da: number, len: number): Pt => [tipX - Math.cos(ang + da) * len, tipY - Math.sin(ang + da) * len];
  return { shaft, head: [end(0.6, 34), [tipX, tipY], end(-0.62, 28)] };
}

/** `[start, duration]` of the handwriting wipe of a word, ms. */
export const doodleWriteWindow = (startMs: number, endMs: number): readonly [number, number] => [startMs - 20, clamp(0.85 * (endMs - startMs), 120, 550)];

type MarkKind = "wipeR" | "wipeL" | "wipeD" | "pop";

/** One pen mark in the sample's px: its commands, the box the sample's svg gets, and how it is revealed. */
interface Mark {
  readonly id: string;
  readonly kind: MarkKind;
  readonly start: number;
  readonly dur: number;
  readonly cmds: readonly PathCmd[];
  readonly box: { x: number; y: number; w: number; h: number };
  /** The scale pivot of a pop: the tick's first point. */
  readonly pivot?: Pt;
}

const mapCmds = (cmds: readonly PathCmd[], fn: (x: number, y: number) => Pt): PathCmd[] =>
  cmds.map((cmd): PathCmd => {
    if (cmd[0] === "Z") return cmd;
    if (cmd[0] === "C") {
      const a = fn(cmd[1], cmd[2]);
      const b = fn(cmd[3], cmd[4]);
      const c = fn(cmd[5], cmd[6]);
      return ["C", a[0], a[1], b[0], b[1], c[0], c[1]];
    }
    const p = fn(cmd[1], cmd[2]);
    return [cmd[0], p[0], p[1]];
  });

interface PlacedWord {
  readonly index: number;
  readonly text: string;
  readonly adv: number;
  inkLeft: number;
}

interface PlacedRow {
  readonly size: number;
  readonly cy: number;
  readonly words: PlacedWord[];
}

function buildCue(cue: SceneCue, input: SceneInput, cueNumber: number): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u } = space;
  const direction = cueDirection(cue);
  const rtl = direction === "rtl";
  /** A sample x/y/length in canvas px. */
  const X = space.x;
  const Y = space.y;
  const maxRow = (MAX_ROW_SHARE * space.canvas.width) / u;
  const advance = (text: string, face: typeof BODY_FACE | typeof HERO_FACE, size: number) => input.measure(text, face, size * u, 0).advance / u;

  /** Rows of `indices` at `nominal` size: `preferred` lines when they fit, else balanced; a word wider than a row shrinks the size. */
  const lay = (indices: readonly number[], nominal: number, preferred?: number[][], limit = maxRow): { size: number; lines: number[][] } => {
    const widthsAt = (size: number) => indices.map((index) => advance(cue.words[index]!.text, BODY_FACE, size));
    let size = nominal;
    let widths = widthsAt(size);
    const linesAt = (): number[][] => {
      const gap = GAP_EM * size;
      if (preferred && preferred.every((line) => rowWidth(widths, line, gap) <= limit)) return preferred;
      return balancedRows(widths, gap, limit);
    };
    let lines = linesAt();
    const widest = Math.max(...lines.map((line) => rowWidth(widths, line, GAP_EM * size)));
    const scale = fitScale(widest, limit);
    if (scale < 1) {
      size = nominal * scale;
      widths = widthsAt(size);
      lines = linesAt();
    }
    return { size, lines: lines.map((line) => line.map((at) => indices[at]!)) };
  };

  /** One line of word indices as a centred flex row at `cy`, in the order the viewer reads from the left. */
  const place = (line: readonly number[], size: number, cy: number): PlacedRow => {
    const order = rowVisualOrder(line.map((index) => cue.words[index]!.text), direction).map((at) => line[at]!);
    const advs = order.map((index) => advance(cue.words[index]!.text, BODY_FACE, size));
    const gap = GAP_EM * size;
    let x = CX - rowWidth(advs, advs.map((_, at) => at), gap) / 2;
    const words = order.map((index, at): PlacedWord => {
      const placed = { index, text: cue.words[index]!.text, adv: advs[at]!, inkLeft: x };
      x += advs[at]! + gap;
      return placed;
    });
    return { size, cy, words };
  };

  const fromBlock = cue.startMs - 60;
  const toMs = cue.endMs - 40;
  const exitFrom = cue.endMs - 50 - EXIT;
  const exitTo = cue.endMs - 50;
  /** The cue block's opacity: 1, then a linear fade over the last 120 ms before it is hidden. */
  const fade = (from: number): Frames => (exitFrom > from ? [[from, 1], [exitFrom, 1], [exitTo, 0]] : [[from, 1 - prog(from, exitFrom, EXIT)], [exitTo, 0]]);

  const pieces: Piece[] = [];
  const push = (piece: Piece) => {
    if (piece.fromMs < piece.toMs) pieces.push(piece);
  };

  const shadowsOf = (list: readonly { dy: number; blur: number; alpha: number }[]) => list.map((s) => ({ dx: 0, dy: s.dy * u, blur: s.blur * u, colour: input.colours.shadow, alpha: s.alpha }));

  /** A word wiped in over its write window; `rotated` is the hero's row, tipped about (CX, hy). */
  const wordPiece = (row: PlacedRow, word: PlacedWord, hero: { hy: number; heroW: number } | null) => {
    const w = cue.words[word.index]!;
    const [ws, wd] = doodleWriteWindow(w.startMs, w.endMs);
    const from = Math.max(fromBlock, ws);
    const size = row.size;
    const pad = size * PAD * u;
    const contentTop = hero ? hero.hy - size / 2 : row.cy - size / 2;
    const baseline = contentTop + (hero ? BASELINE.hero : BASELINE.body) * size;
    const inkLeft = X(word.inkLeft);
    const inkRight = X(word.inkLeft + word.adv);
    const adv = word.adv * u;
    let clip: TextPiece["clip"];
    let origin: TextPiece["origin"];
    const track: TextPiece["track"] = { x: [[from, inkLeft]], y: [[from, Y(baseline)]], o: fade(from) };
    if (hero) {
      // The row (width 1080, height `size`) turns about its centre (CX, hy); the pivot is that point.
      const a = (HERO_TILT_DEG * Math.PI) / 180;
      const rot = (dx: number, dy: number): Pt => [X(CX) + dx * u * Math.cos(a) - dy * u * Math.sin(a), Y(hero.hy) + dx * u * Math.sin(a) + dy * u * Math.cos(a)];
      const padSample = size * PAD;
      const half = hero.heroW / 2;
      const corners = [rot(-half - padSample, -size / 2 - padSample), rot(half + padSample, -size / 2 - padSample), rot(half + padSample, size / 2 + padSample), rot(-half - padSample, size / 2 + padSample)];
      const left = Math.min(...corners.map((c) => c[0]));
      const right = Math.max(...corners.map((c) => c[0]));
      const edge = (p: number) => X(CX) + (rtl ? half - p * hero.heroW : -half + p * hero.heroW) * u * Math.cos(a);
      clip = {
        x1: rtl ? [[ws, edge(0)], [ws + wd, edge(1)], [ws + wd + 1, left]] : [[ws, left]],
        x2: rtl ? [[ws, right]] : [[ws, edge(0)], [ws + wd, edge(1)], [ws + wd + 1, right]],
        y1: [[ws, Math.min(...corners.map((c) => c[1]))]],
        y2: [[ws, Math.max(...corners.map((c) => c[1]))]],
      };
      track.x = [[from, X(CX)]];
      track.y = [[from, Y(hero.hy)]];
      track.rz = [[from, HERO_TILT_DEG]];
      origin = { dx: X(CX) - inkLeft, dy: Y(hero.hy) - Y(baseline) };
    } else {
      const top = Y(contentTop) - pad;
      const bottom = Y(contentTop + size) + pad;
      clip = {
        x1: rtl ? [[ws, inkRight], [ws + wd, inkLeft], [ws + wd + 1, inkLeft - pad]] : [[ws, inkLeft - pad]],
        x2: rtl ? [[ws, inkRight + pad]] : [[ws, inkLeft], [ws + wd, inkLeft + adv], [ws + wd + 1, inkRight + pad]],
        y1: [[ws, top]],
        y2: [[ws, bottom]],
      };
    }
    push({
      id: `doodle:${cueNumber}:w${word.index}`,
      kind: "text",
      z: 2,
      fromMs: from,
      toMs,
      track,
      clip,
      ...(origin ? { origin } : {}),
      text: word.text,
      face: hero ? HERO_FACE : BODY_FACE,
      sizePx: size * u,
      letterSpacingEm: 0,
      fill: hero ? input.colours.highlight : input.colours.primary,
      shadows: shadowsOf(TEXT_SHADOWS),
      anchor: "baseline-left",
      language: cue.language,
    } satisfies TextPiece);
  };

  /** A pen mark: a stroked shape revealed by a clip wipe (eased in-out) or popped with a spring about its first point. */
  const markPiece = (mark: Mark) => {
    const from = mark.start;
    const pad = MARK_PAD * u;
    const bx1 = X(mark.box.x);
    const bx2 = X(mark.box.x + mark.box.w);
    const by1 = Y(mark.box.y);
    const by2 = Y(mark.box.y + mark.box.h);
    const anchor: Pt = mark.pivot ?? [mark.box.x, mark.box.y];
    const track: ShapePiece["track"] = { x: [[from, X(anchor[0])]], y: [[from, Y(anchor[1])]], o: fade(from) };
    let clip: ShapePiece["clip"];
    const end = mark.start + mark.dur;
    if (mark.kind === "pop") {
      track.sx = [[from, 0], [end, 1, "spring"]];
      track.sy = [[from, 0], [end, 1, "spring"]];
    } else if (mark.kind === "wipeR") clip = { x1: [[from, bx1]], x2: [[from, bx1 + pad], [end, bx2, "inOut"]], y1: [[from, by1]], y2: [[from, by2]] };
    else if (mark.kind === "wipeL") clip = { x1: [[from, bx2 - pad], [end, bx1, "inOut"]], x2: [[from, bx2]], y1: [[from, by1]], y2: [[from, by2]] };
    else clip = { x1: [[from, bx1]], x2: [[from, bx2]], y1: [[from, by1]], y2: [[from, by1 + pad], [end, by2, "inOut"]] };
    push({
      id: `doodle:${cueNumber}:${mark.id}`,
      kind: "shape",
      z: 3,
      fromMs: from,
      toMs,
      track,
      ...(clip ? { clip } : {}),
      path: mapCmds(mark.cmds, (x, y) => [(x - anchor[0]) * u, (y - anchor[1]) * u]),
      stroke: { widthPx: PEN * u, colour: input.colours.primary },
      shadows: shadowsOf([MARK_SHADOW]),
    } satisfies ShapePiece);
  };

  const strokeMark = (id: string, kind: MarkKind, start: number, dur: number, paths: readonly PathCmd[][], pts: readonly Pt[], pivot?: Pt): Mark => ({
    id,
    kind,
    start,
    dur,
    cmds: paths.flat(),
    box: boxOf(pts, MARK_PAD),
    ...(pivot ? { pivot } : {}),
  });

  const heroAt = cue.words.findIndex((word) => word.role === "hero");
  const marks: Mark[] = [];

  if (heroAt < 0) {
    // Two rows of handwriting under each other, an underline wiped in under the last word.
    const all = cue.words.map((_, index) => index);
    const split = Math.ceil(all.length / 2);
    const preferred = [all.slice(0, split), all.slice(split)].filter((line) => line.length > 0);
    // The underline reaches 26 px past the last word, so a row leaves room for it.
    const { size, lines } = lay(all, SOLO, preferred, maxRow - UNDERLINE_ROOM);
    const step = size * ROW_STEP;
    const y0 = ANCHOR_LINE - ((lines.length - 1) * step) / 2 - 10;
    const rows = lines.map((line, at) => place(line, size, y0 + at * step));
    for (const row of rows) for (const word of row.words) wordPiece(row, word, null);
    const lastRow = rows[rows.length - 1]!;
    const last = lastRow.words.reduce((a, b) => (b.index > a.index ? b : a));
    const x0 = last.inkLeft - 18;
    const x1 = last.inkLeft + last.adv + 26;
    const y = lastRow.cy + size * 0.5 + 8;
    const pts: Pt[] = [
      [x0, y + 4],
      [lerp(x0, x1, 0.25), y - 2],
      [lerp(x0, x1, 0.55), y + 2],
      [lerp(x0, x1, 0.8), y - 4],
      [x1, y - 12],
    ];
    const w = cue.words[last.index]!;
    const [ws, wd] = doodleWriteWindow(w.startMs, w.endMs);
    marks.push(strokeMark("underline", rtl ? "wipeL" : "wipeR", ws + wd + 20, 220, [smoothPath(pts)], pts));
  } else {
    const word = cue.words[heroAt]!;
    const lead = cue.words.slice(0, heroAt).map((_, index) => index);
    const tail = cue.words.slice(heroAt + 1).map((_, at) => heroAt + 1 + at);
    // Fit the hero: its ink width at the largest size, shrunk to 760 sample px, and further until the loop and
    // the ticks (the widest marks) fit the safe width too, so a cue is only ever shifted, never wider than the screen.
    const probeW = advance(word.text, HERO_FACE, HERO_MAX);
    const shapeAt = (size: number) => {
      const w = (probeW * size) / HERO_MAX;
      const radiusX = w / 2 + 66;
      const radiusY = (size * 0.78) / 2 + 58;
      const loop = loopPoints(CX, 0, radiusX, radiusY, 1.3 + cueNumber * 0.9);
      // A tick overshoots to SPRING_PEAK of its size about its first point while it pops.
      const ticks = tickPoints(CX, 0, radiusX, radiusY).map((pts) => pts.map((q): Pt => [pts[0]![0] + (q[0] - pts[0]![0]) * SPRING_PEAK, pts[0]![1] + (q[1] - pts[0]![1]) * SPRING_PEAK]));
      const reach = pathBounds([...smoothPath(loop.top), ...smoothPath(loop.bottom), ...ticks.flatMap((pts) => smoothPath(pts))]);
      return { heroW: w, rx: radiusX, ry: radiusY, width: reach.x2 - reach.x1 + 2 * PEN };
    };
    let F = Math.min(HERO_MAX, (HERO_MAX * Math.min(HERO_FIT, maxRow)) / probeW);
    if (shapeAt(F).width > maxRow) {
      // The widest the hero can be: the marks grow with it, so bisect.
      let [low, high] = [0, F];
      for (let pass = 0; pass < 24; pass++) {
        const mid = (low + high) / 2;
        if (shapeAt(mid).width > maxRow) high = mid;
        else low = mid;
      }
      F = low;
    }
    const { heroW, rx, ry } = shapeAt(F);

    const leadLay = lead.length ? lay(lead, BODY) : null;
    const tailLay = tail.length ? lay(tail, BODY) : null;
    const leadCy = leadLay ? -(ry + 160) : 0;
    const tailCy = tailLay ? ry + 66 : 0;
    const leadStep = leadLay ? leadLay.size * ROW_STEP : 0;
    const tailStep = tailLay ? tailLay.size * ROW_STEP : 0;
    const top = leadLay ? leadCy - (leadLay.lines.length - 1) * leadStep - leadLay.size / 2 : -ry - 8;
    const bottom = tailLay ? tailCy + (tailLay.lines.length - 1) * tailStep + tailLay.size / 2 : ry + 8;
    const hy = ANCHOR_LINE - (top + bottom) / 2;

    const heroRow: PlacedRow = { size: F, cy: hy, words: [{ index: heroAt, text: word.text, adv: heroW, inkLeft: CX - heroW / 2 }] };
    wordPiece(heroRow, heroRow.words[0]!, { hy, heroW });
    let leadRows: PlacedRow[] = [];
    if (leadLay) {
      leadRows = leadLay.lines.map((line, at, all) => place(line, leadLay.size, hy + leadCy - (all.length - 1 - at) * leadStep));
      for (const row of leadRows) for (const placed of row.words) wordPiece(row, placed, null);
    }
    if (tailLay) {
      for (const row of tailLay.lines.map((line, at) => place(line, tailLay.size, hy + tailCy + at * tailStep))) for (const placed of row.words) wordPiece(row, placed, null);
    }

    const [hs, hd] = doodleWriteWindow(word.startMs, word.endMs);
    const written = hs + hd;

    // Loop: top half left to right, then bottom half right to left.
    const lp = loopPoints(CX, hy - 8, rx, ry, 1.3 + cueNumber * 0.9);
    marks.push(strokeMark("loopTop", "wipeR", written + 20, 180, [smoothPath(lp.top)], lp.top));
    marks.push(strokeMark("loopBottom", "wipeL", written + 200, 180, [smoothPath(lp.bottom)], lp.bottom));

    // Three ticks off the loop's top right, popping 50 ms apart.
    tickPoints(CX, hy, rx, ry).forEach((pts, i) => {
      marks.push(strokeMark(`tick${i}`, "pop", written + 380 + i * 50, 150, [smoothPath(pts)], pts, pts[0]!));
    });

    // Hooked arrow from the end of the lead row down to the loop, wiped along its direction just before the hero is written.
    if (leadRows.length > 0) {
      const lastRow = leadRows[leadRows.length - 1]!;
      const last = lastRow.words.reduce((a, b) => (b.index > a.index ? b : a));
      // A right-to-left lead ends at its left edge: the arrow is drawn for a left-to-right cue and mirrored.
      const leadEnd = rtl ? CX + (CX - last.inkLeft) : last.inkLeft + last.adv;
      const { shaft, head } = arrowPoints(leadEnd, leadCy, hy, ry, heroW);
      const flip = (p: Pt): Pt => (rtl ? [2 * CX - p[0], p[1]] : p);
      const [h1, tip, h2] = head.map(flip) as [Pt, Pt, Pt];
      const cmds: PathCmd[][] = [smoothPath(shaft.map(flip)), [["M", h1[0], h1[1]], ["L", tip[0], tip[1]], ["L", h2[0], h2[1]]]];
      marks.push(strokeMark("arrow", "wipeD", word.startMs - 230, 210, cmds, [...shaft, ...head].map(flip)));
    }
  }
  for (const mark of marks) markPiece(mark);
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const doodleProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number)) };
  },
};
