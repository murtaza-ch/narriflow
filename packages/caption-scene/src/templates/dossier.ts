import type { DemoScript } from "../demo";
import { type Frames, EASES, kf, lerp, prog } from "../ease";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, rowVisualOrder, sceneSpace } from "../layout";
import type { Clip, PathCmd, Piece, ShapePiece, TextPiece } from "../scene";
import { polygonPath, roundedRectPath } from "../shapes";
import { sampleFrames } from "../frames";

/**
 * Dossier (`samples/templates/51-dossier.js`): the rest of the sentence waits as black redaction bars on
 * typed paper strips. Each bar is wiped away left to right the instant its word is spoken, the hero gets
 * a red rubber stamp, a pause before a word makes its bar blink like a cursor, and the strips roll in and
 * out behind a shared vertical edge.
 *
 * Geometry is the sample's, read from its layout in Chrome (`.scratch/motion-captions/tools/probe-sample.ts`):
 * a strip is the row's words in Courier Prime Bold 72 px (uppercase, 0.02 em tracking, a 0.62 em gap, each
 * word's box 0.02 em narrower than its advance) padded 17 x 11 px; a second strip sits 12 px lower and 22 px
 * to the right; the sample left-aligns the block at x 92, Narriflow centres it on the anchor (x 540, the line y 1300). A bar covers its
 * word 3 px wider each side, from 0.04 em to 0.82 em below the top of the line box; the stamp is a 7 px and a
 * 2 px ring 0.24 em outside the word's cap height. The text baseline sits 51/72 em below the top of the
 * line box (Chrome rounds the face's ascent).
 *
 * Each strip tilts about its left-middle by a fixed angle, and everything on it with it: a piece here pivots
 * on the strip's pivot with the strip's tilt, the bars and stamp adding their own turn (a nested turn is one
 * turn about the strip's pivot plus a constant shift of the piece's rest position). The strip's `clip-path`
 * (the roll in and out) is a canvas rectangle whose edges run at 200 and 160 ms; a bar's tear is a second
 * rectangle, and a bar takes the intersection of the two.
 */

export const DOSSIER_DEMO: DemoScript = {
  lines: [
    "So:m my:m boss:b calls:b me:m in",
    "shuts:b the:m door",
    "and:m goes:b you're:b fired:h@620+900",
    "on:m my:m birthday",
  ],
  options: { rate: 300, cueGap: 170, tail: 900, lead: 380 },
};

const ANCHOR_LINE = 1300;
const SIZE = 72;
const FACE = "Courier Prime" as const;
const LETTER_SPACING = 0.02;
const GAP_EM = 0.62;
const OVERLAP_EM = 0.02;
const MAX_W = 880;
const PAD_X = 17;
const PAD_Y = 11;
const ROW_GAP = 12;
const ROW_INDENT = 22;
const BASELINE_EM = 51 / 72;
const CAP_TOP_EM = 0.14;
const CAP_BOTTOM_EM = 0.72;
const BAR_COLOUR = "#0D0D0D";
const BAR_SIDE = 3;
const BAR_TOP_EM = CAP_TOP_EM - 0.1;
const BAR_HEIGHT_EM = CAP_BOTTOM_EM - CAP_TOP_EM + 0.2;
const BAR_RADIUS = 1;
const PAPER_RADIUS = 2;
const PAPER_SHADOWS = [
  { dy: 10, blur: 11, alpha: 0.3 },
  { dy: 2, blur: 2, alpha: 0.3 },
] as const;
const PAPER_SHADOW_COLOUR = "#281C0A";
const TILTS = [
  [-1.0, 0.6],
  [0.7, -0.5],
  [-0.6, 0.9],
  [0.8, -0.8],
] as const;
/** The clip margin of the sample (px): room for the shadows and the stamp beyond the wipe's own edge. */
const CLIP_MARGIN = 70;
const ENTER_LEAD = 140;
const ENTER_MS = 200;
const EXIT_MS = 160;
const TEAR_LEAD = 70;
const TEAR_MS = 120;
/** A pause this long before a word makes its bar blink. */
const BLINK_PAUSE_MS = 600;
const STAMP = { delay: 90, inflateEm: 0.24, border: 7, radius: 6, innerInset: 4, innerBorder: 2, innerRadius: 3, alpha: 0.94, scaleFrom: 1.6, scaleLow: 0.94, rotFrom: -10, rotTo: -4 } as const;
const NUDGE = { degrees: 0.7, after: 60, up: 100, down: 260 } as const;

/** The sample's deterministic jitter: a hand-placed look that is the same every time. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Where the tilt of the strip that holds the hero is nudged by the stamp's impact, degrees, at `t`. */
export function dossierNudge(t: number, heroStartMs: number): number {
  const hit = heroStartMs + STAMP.delay;
  return kf(t, [[hit + NUDGE.after, 0], [hit + NUDGE.up, NUDGE.degrees, "out"], [hit + NUDGE.down, 0, "out"]]);
}

/** The sample's strip tilt, degrees, for row `row` of cue number `cue`. */
export function dossierTilt(cue: number, row: number): number {
  return TILTS[cue % TILTS.length]![row] ?? (hash(cue * 10 + row + 50) - 0.5) * 2;
}

/** Pointwise `pick` of two linear keyframe lists, with the crossing added so the result stays exact between frames. */
function pointwise(a: Frames, b: Frames, pick: (x: number, y: number) => number): Frames {
  const times = [...new Set([...a, ...b].map((frame) => frame[0]))].sort((x, y) => x - y);
  const out: [number, number][] = [];
  const gap = (t: number) => kf(t, a) - kf(t, b);
  times.forEach((t, index) => {
    if (index > 0) {
      const before = times[index - 1]!;
      const d0 = gap(before);
      const d1 = gap(t);
      if (d0 * d1 < 0) {
        const crossing = before + ((t - before) * d0) / (d0 - d1);
        out.push([crossing, pick(kf(crossing, a), kf(crossing, b))]);
      }
    }
    out.push([t, pick(kf(t, a), kf(t, b))]);
  });
  return out;
}

/** Linear frames through the points, dropping any that repeat a time. */
function linear(points: readonly (readonly [number, number])[]): Frames {
  const frames: [number, number][] = [];
  for (const [at, value] of points) if (frames.length === 0 || at > frames[frames.length - 1]![0]) frames.push([at, value]);
  return frames;
}

const rotate = (x: number, y: number, degrees: number): [number, number] => {
  const a = (degrees * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};

interface Item {
  readonly index: number;
  /** Visual left edge of the word's box, canvas px. */
  readonly left: number;
  readonly boxWidth: number;
}

interface Row {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  /** Distance of the strip's leading edge from the block's, px. */
  readonly indent: number;
  readonly items: readonly Item[];
  readonly tilt: number;
  readonly pivot: { x: number; y: number };
}

function buildCue(cue: SceneCue, input: SceneInput, number: number): Piece[] {
  const space = sceneSpace(input, ANCHOR_LINE);
  const { u } = space;
  const rtl = cueDirection(cue) === "rtl";
  const texts = cue.words.map((word) => word.text.toUpperCase());
  const maxRow = Math.min(MAX_W * u, space.safe.x2 - space.safe.x1);

  // A word's flex item is 0.02 em narrower than its advance plus tracking (`margin-right: -0.02em`).
  const widthsAt = (size: number) => texts.map((text) => input.measure(text, FACE, size, LETTER_SPACING).advance + (LETTER_SPACING - OVERLAP_EM) * size);
  let size = SIZE * u;
  let widths = widthsAt(size);
  const scale = fitScale(Math.max(...widths) + 2 * PAD_X * u, maxRow);
  if (scale < 1) {
    size *= scale;
    widths = widthsAt(size);
  }
  const f = size / SIZE;
  const gap = GAP_EM * size;
  const pad = { x: PAD_X * f, y: PAD_Y * f };
  const height = size + 2 * pad.y;
  const margin = CLIP_MARGIN * f;
  const direction = rtl ? -1 : 1;

  // The sample splits a cue that does not fit into two rows of the least widest; more rows only when two cannot hold it.
  const groups = balancedRows(widths, gap, maxRow - 2 * pad.x);
  // The block (the strips and the later strips' indent) is centred on the anchor; its leading edge is the strips' shared edge.
  const rowWidth = (group: readonly number[]) => group.reduce((sum, at) => sum + widths[at]!, 0) + gap * (group.length - 1) + 2 * pad.x;
  const blockWidth = Math.max(...groups.map((group, ri) => (ri > 0 ? ROW_INDENT * f : 0) + rowWidth(group)));
  const edge = space.x(540) - (direction * blockWidth) / 2;
  const blockHeight = groups.length * height + (groups.length - 1) * ROW_GAP * f;
  const blockTop = space.y(ANCHOR_LINE) - blockHeight / 2;
  const heroAt = cue.words.findIndex((word) => word.role === "hero");

  const rows: Row[] = groups.map((group, ri) => {
    const order = rowVisualOrder(group.map((at) => cue.words[at]!.text), rtl ? "rtl" : "ltr").map((at) => group[at]!);
    const width = rowWidth(order);
    const indent = ri > 0 ? ROW_INDENT * f : 0;
    const left = rtl ? edge - indent - width : edge + indent;
    let x = left + pad.x;
    const items = order.map((at) => {
      const item = { index: at, left: x, boxWidth: widths[at]! + OVERLAP_EM * size };
      x += widths[at]! + gap;
      return item;
    });
    const top = blockTop + ri * (height + ROW_GAP * f);
    return { top, left, width, indent, items, tilt: dossierTilt(number, ri), pivot: { x: rtl ? left + width : left, y: top + height / 2 } };
  });
  const reach = Math.max(...rows.map((row) => row.indent + row.width));
  const heroRow = heroAt >= 0 ? rows.findIndex((row) => row.items.some((item) => item.index === heroAt)) : -1;
  const hit = heroAt >= 0 ? cue.words[heroAt]!.startMs + STAMP.delay : Number.POSITIVE_INFINITY;

  const fromMs = cue.startMs - ENTER_LEAD;
  const toMs = cue.endMs;
  const enterStart = cue.startMs - ENTER_LEAD;
  const exitStart = cue.endMs - EXIT_MS;
  // Distance from the block's leading edge (b) and canvas x are one mirror apart.
  const toX = (b: number) => edge + direction * b;

  const pieces: Piece[] = [];
  rows.forEach((row, ri) => {
    const z = ri * 10;
    const { pivot } = row;
    const nudged = ri === heroRow;
    const rowAngle = (t: number) => row.tilt + (nudged ? dossierNudge(t, cue.words[heroAt]!.startMs) : 0);
    const rzOf = (extra: number): Frames =>
      nudged
        ? [[fromMs, row.tilt + extra], [hit + NUDGE.after, row.tilt + extra], [hit + NUDGE.up, row.tilt + NUDGE.degrees + extra, "out"], [hit + NUDGE.down, row.tilt + extra, "out"]]
        : [[fromMs, row.tilt + extra]];
    const pivotTrack = (extra = 0) => ({ x: [[fromMs, pivot.x]] as Frames, y: [[fromMs, pivot.y]] as Frames, rz: rzOf(extra) });
    const originFor = (ax: number, ay: number) => ({ dx: pivot.x - ax, dy: pivot.y - ay });

    // The strip's roll in and out: visible distances [low, high] from the block's edge, clamped to this strip and its margin.
    const lo = row.indent - margin;
    const hi = row.indent + row.width + margin;
    const rampIn = (b: number) => enterStart + (ENTER_MS * (b + margin)) / (reach + 2 * margin);
    const rampOut = (b: number) => exitStart + (EXIT_MS * (b + margin)) / (reach + 2 * margin);
    const stripLow = linear([[fromMs, lo], [rampOut(lo), lo], [rampOut(hi), hi]]);
    const stripHigh = linear([[fromMs, lo], [rampIn(lo), lo], [rampIn(hi), hi]]);
    const rowY1: Frames = [[fromMs, row.top - margin]];
    const rowY2: Frames = [[fromMs, row.top + height + margin]];
    /** The clip of a piece that is only cut by the strip, or by the strip and `extra` (b-space [low, high] frames). */
    const clipOf = (low: Frames, high: Frames): Clip => {
      const high2 = pointwise(high, low, Math.max);
      const bx = rtl ? { x1: high2.map(([at, b]) => [at, toX(b)] as const), x2: low.map(([at, b]) => [at, toX(b)] as const) } : { x1: low.map(([at, b]) => [at, toX(b)] as const), x2: high2.map(([at, b]) => [at, toX(b)] as const) };
      return { x1: bx.x1 as unknown as Frames, x2: bx.x2 as unknown as Frames, y1: rowY1, y2: rowY2 };
    };
    const stripClip = clipOf(stripLow, stripHigh);

    const paper: ShapePiece = {
      id: `dossier:${number}:r${ri}`,
      kind: "shape",
      z: z + 1,
      fromMs,
      toMs,
      track: pivotTrack(),
      clip: stripClip,
      origin: originFor(row.left, row.top),
      path: roundedRectPath(0, 0, row.width, height, PAPER_RADIUS * f),
      fill: { colour: input.colours.accent, alpha: 1 },
      shadows: PAPER_SHADOWS.map((shadow) => ({ dx: 0, dy: shadow.dy * f, blur: shadow.blur * f, colour: PAPER_SHADOW_COLOUR, alpha: shadow.alpha })),
    };
    pieces.push(paper);

    for (const item of row.items) {
      const word = cue.words[item.index]!;
      const ws = word.startMs;
      const spanTop = row.top + pad.y;
      const baseline = spanTop + BASELINE_EM * size;
      const tearFrom = Math.max(fromMs, ws - TEAR_LEAD);
      const tearTo = ws - TEAR_LEAD + TEAR_MS;
      const isHero = word.role === "hero";
      const stampStart = ws + STAMP.delay;

      // The word: ink from the moment its bar starts to go; a hero turns the highlight colour when the stamp lands.
      const textPiece = (suffix: string, from: number, to: number, fill: string): TextPiece => ({
        id: `dossier:${number}:t${item.index}${suffix}`,
        kind: "text",
        z: z + 2,
        fromMs: from,
        toMs: to,
        track: pivotTrack(),
        clip: stripClip,
        origin: originFor(item.left, baseline),
        text: texts[item.index]!,
        face: FACE,
        sizePx: size,
        letterSpacingEm: LETTER_SPACING,
        fill,
        anchor: "baseline-left",
        language: cue.language,
      });
      const inkEnd = isHero ? Math.min(stampStart, toMs) : toMs;
      if (tearFrom < inkEnd) pieces.push(textPiece("", tearFrom, inkEnd, input.colours.primary));
      if (isHero && stampStart < toMs) pieces.push(textPiece("h", Math.max(stampStart, tearFrom), toMs, input.colours.highlight));

      // The bar: wiped away from its leading edge, and blinking when a long pause came before the word.
      const barW = item.boxWidth + 2 * BAR_SIDE * f;
      const barH = BAR_HEIGHT_EM * size;
      const c0x = item.left + item.boxWidth / 2;
      const c0y = spanTop + (BAR_TOP_EM + BAR_HEIGHT_EM / 2) * size;
      const own = (hash(number * 10 + item.index) - 0.5) * 1.2;
      const dy = (hash(number * 10 + item.index + 5) - 0.5) * 4 * f;
      const [rx, ry] = rotate(c0x - pivot.x, c0y - pivot.y, -own);
      const rest = { x: c0x + (rx - (c0x - pivot.x)), y: c0y + (ry - (c0y - pivot.y)) + dy };
      const barEnd = Math.min(tearTo, toMs);
      if (tearFrom < barEnd) {
        const bLeft = rtl ? edge - (item.left + item.boxWidth + BAR_SIDE * f) : item.left - BAR_SIDE * f - edge;
        const bRight = bLeft + barW;
        const tearLow = linear([[fromMs, bLeft], [tearFrom, bLeft], [tearTo, bRight]]);
        const tearHigh: Frames = [[fromMs, bRight + 4 * f]];
        const low = pointwise(stripLow, tearLow, Math.max);
        const high = pointwise(stripHigh, tearHigh, Math.min);
        const prev = cue.words[item.index - 1];
        const pause = prev ? ws - prev.endMs : 0;
        const bar: ShapePiece = {
          id: `dossier:${number}:b${item.index}`,
          kind: "shape",
          z: z + 3,
          fromMs,
          toMs: barEnd,
          track: {
            ...pivotTrack(own),
            ...(pause >= BLINK_PAUSE_MS
              ? (() => {
                  const g = prev!.endMs + 120;
                  return { o: linear([[fromMs, 1], [g, 1], [g + 60, 0.3], [g + 240, 0.3], [g + 300, 1], [g + 420, 1], [g + 480, 0.3], [g + 660, 0.3], [g + 720, 1]]) };
                })()
              : {}),
          },
          clip: clipOf(low, high),
          origin: originFor(rest.x, rest.y),
          path: roundedRectPath(-barW / 2, -barH / 2, barW, barH, BAR_RADIUS * f),
          fill: { colour: BAR_COLOUR, alpha: 1 },
        };
        pieces.push(bar);
      }

      // The stamp on the hero: slams in at 1.6x, lands at 0.94 and settles at 1, tilting from -10 to -4 degrees.
      if (isHero && stampStart < toMs) {
        const inflate = STAMP.inflateEm * size;
        const w = item.boxWidth + 2 * inflate;
        const h = (CAP_BOTTOM_EM - CAP_TOP_EM) * size + 2 * inflate;
        const cx = item.left + item.boxWidth / 2;
        const cy = spanTop + CAP_TOP_EM * size - inflate + h / 2;
        const ring = (inset: number, band: number, radius: number): PathCmd[] => [
          ...roundedRectPath(-w / 2 + inset, -h / 2 + inset, w - 2 * inset, h - 2 * inset, radius),
          ...polygonPath([[-w / 2 + inset + band, -h / 2 + inset + band], [-w / 2 + inset + band, h / 2 - inset - band], [w / 2 - inset - band, h / 2 - inset - band], [w / 2 - inset - band, -h / 2 + inset + band]]),
        ];
        const rot = (t: number) => lerp(STAMP.rotFrom, STAMP.rotTo, EASES.out(prog(t, stampStart, 160)));
        const centre = (t: number) => {
          const [ox, oy] = rotate(cx - pivot.x, cy - pivot.y, rowAngle(t));
          return { x: pivot.x + ox, y: pivot.y + oy };
        };
        const edges = [stampStart, stampStart + NUDGE.after, stampStart + NUDGE.up, stampStart + 160, stampStart + NUDGE.down];
        const stamp: ShapePiece = {
          id: `dossier:${number}:s${item.index}`,
          kind: "shape",
          z: z + 4,
          fromMs: stampStart,
          toMs,
          track: {
            x: sampleFrames((t) => centre(t).x, edges, 0.05),
            y: sampleFrames((t) => centre(t).y, edges, 0.05),
            rz: sampleFrames((t) => rowAngle(t) + rot(t), edges, 0.05),
            sx: [[stampStart, STAMP.scaleFrom], [stampStart + 90, STAMP.scaleLow, "in"], [stampStart + 160, 1, "out"]],
            sy: [[stampStart, STAMP.scaleFrom], [stampStart + 90, STAMP.scaleLow, "in"], [stampStart + 160, 1, "out"]],
            o: [[stampStart, 0], [stampStart + 40, STAMP.alpha]],
          },
          clip: stripClip,
          path: [...ring(0, STAMP.border * f, STAMP.radius * f), ...ring((STAMP.border + STAMP.innerInset) * f, STAMP.innerBorder * f, STAMP.innerRadius * f)],
          fill: { colour: input.colours.highlight, alpha: 1 },
        };
        pieces.push(stamp);
      }
    }
  });
  return clampToSafeArea(pieces, space.safe, input.measure);
}

export const dossierProgram: SceneProgram = {
  build(input) {
    return { pieces: input.cues.flatMap((cue, number) => buildCue(cue, input, number)) };
  },
};

/** Used by the tests: the sample's bar-tear progress (0 = whole bar, 1 = gone) of a word at `t`. */
export function dossierTear(t: number, wordStartMs: number): number {
  return prog(t, wordStartMs - TEAR_LEAD, TEAR_MS);
}

/** Used by the tests: the sample's strip edges (distance from the block's edge, `reach` = the widest strip's far end) at `t`. */
export function dossierEdges(t: number, cueStartMs: number, cueEndMs: number, reach: number, margin = CLIP_MARGIN): { enter: number; exit: number } {
  return {
    enter: lerp(-margin, reach + margin, prog(t, cueStartMs - ENTER_LEAD, ENTER_MS)),
    exit: lerp(-margin, reach + margin, prog(t, cueEndMs - EXIT_MS, EXIT_MS)),
  };
}
