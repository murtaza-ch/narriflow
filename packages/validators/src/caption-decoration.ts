import type { CaptionKeyframe } from "./caption-style";

// Drawn details of Dynamic Styles (spec 5.10): Marker's hand-drawn underline and Stack's
// stars. Each shape is ONE point list in a unit box, made of `M`, `L` and `C` commands only,
// that both painters serialise from: an SVG path in the Studio, an ASS `\p1` drawing in the
// worker. Shared geometry (`layoutCaptionBlock`) decides where each one goes.

export type CaptionShapeCommand =
  | { readonly op: "M"; readonly x: number; readonly y: number }
  | { readonly op: "L"; readonly x: number; readonly y: number }
  | { readonly op: "C"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly x: number; readonly y: number };

/**
 * A filled shape in the unit box: every point, control points included, lies in [0, 1] x [0, 1]
 * and the extremes touch all four edges, so the box is both the shape's ink box and its control
 * box (libass aligns an `\an5` drawing on the latter). Drawn at `aspect` (width / height).
 */
export interface CaptionShape {
  readonly aspect: number;
  readonly commands: readonly CaptionShapeCommand[];
}

/** Timing and size of the decorations, in em of the hero's size unless named otherwise. */
export const CAPTION_DECORATION = {
  /** A decoration is drawn only when the cue has at least this much time left at the hero's onset. */
  minRemainingMs: 300,
  underline: {
    /** The squiggle's centre line sits this far below the hero's baseline (spec 5.10)... */
    offsetEm: 0.12,
    /** ...or lower, so its box clears the hero's lowest ink by this much (descenders, Nastaliq; ticket 06). */
    clearanceEm: 0.03,
    thicknessEm: 0.04,
    /** Height of the squiggle's box: its thickness plus the wave's swing. */
    heightEm: 0.1,
    /** Width as a share of the hero row's advance, from the row's start (reference 04). */
    widthFraction: 0.6,
    /** Full waves along the squiggle. */
    waves: 3,
    /** The wipe starts this long after the hero's onset and runs this long. */
    delayMs: 60,
    wipeMs: 120,
    colour: "#FFFFFF",
  },
  stars: {
    /** Star heights, in pop order: the first star at the leading top corner, then the other top corner, then the bottom corner under the second. */
    sizesEm: [0.28, 0.2, 0.2],
    /** Each star's centre sits this far out from its corner of the block's ink box, on both axes. */
    pushEm: 0.3,
    delayMs: 60,
    staggerMs: 40,
    /** Pop from the star's centre: 0 to 1.1 to 1 over 120 ms. */
    pop: [
      { at: 0, scaleX: 0, scaleY: 0 },
      { at: 80, scaleX: 1.1, scaleY: 1.1, ease: "out" },
      { at: 120, scaleX: 1, scaleY: 1 },
    ] as const satisfies readonly CaptionKeyframe[],
    /** A slot (or literal hex): stars follow the accent colour. */
    colour: "accent",
  },
  /** The underline's wipe clip reaches this far past its box on every side, in em of the support size S, so the shadow's blur is not cut. */
  clipMarginEm: 0.5,
} as const;

/** Inner radius of the star as a fraction of its outer radius (fuller than the regular 0.382, as in reference 08). */
const STAR_INNER_RATIO = 0.45;

function starShape(): CaptionShape {
  const points = Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? 1 : STAR_INNER_RATIO;
    const angle = ((-90 + 36 * index) * Math.PI) / 180;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const width = right - left;
  const height = bottom - top;
  return {
    aspect: width / height,
    commands: points.map((point, index) => ({ op: index === 0 ? "M" : "L", x: (point.x - left) / width, y: (point.y - top) / height })),
  };
}

/**
 * Cubic Bezier through a quarter of a sine wave, from its zero to its peak, in units of the
 * quarter's length and the wave's amplitude: (0, 0), (0.3343, 0.5251), (0.6401, 1), (1, 1).
 * The control points never pass the peak, so the squiggle's control box is its ink box.
 */
const QUARTER_SINE = { x1: 0.3343, y1: 0.5251, x2: 0.6401 } as const;

/**
 * The underline: a ribbon whose centre line is a sine of `waves` full waves, offset up and down
 * by half the thickness. Point-symmetric about the box centre, so it centres the same whether a
 * renderer aligns its ink or its control points.
 */
function squiggleShape(): CaptionShape {
  const { thicknessEm, heightEm, waves } = CAPTION_DECORATION.underline;
  const half = thicknessEm / heightEm / 2;
  const amplitude = 0.5 - half;
  const quarters = 4 * waves;
  const q = 1 / quarters;
  // Centre line height (up is negative) at quarter boundary k: 0, -1, 0, 1, ...
  const level = (k: number) => [0, -1, 0, 1][k % 4]!;
  const edge = (offset: number, reverse: boolean): CaptionShapeCommand[] => {
    const y = (value: number) => 0.5 + offset + amplitude * value;
    const commands: CaptionShapeCommand[] = [];
    for (let step = 0; step < quarters; step++) {
      const k = reverse ? quarters - step : step;
      const next = reverse ? k - 1 : k + 1;
      const from = level(k);
      const to = level(next);
      const x0 = k * q;
      const dx = (next - k) * q;
      // A rising quarter leaves its zero along the sine's slope; a falling one leaves its peak flat.
      const fromZero = from === 0;
      const peak = fromZero ? to : from;
      const c1 = fromZero ? { x: QUARTER_SINE.x1, v: QUARTER_SINE.y1 * peak } : { x: 1 - QUARTER_SINE.x2, v: peak };
      const c2 = fromZero ? { x: QUARTER_SINE.x2, v: peak } : { x: 1 - QUARTER_SINE.x1, v: QUARTER_SINE.y1 * peak };
      commands.push({ op: "C", x1: x0 + c1.x * dx, y1: y(c1.v), x2: x0 + c2.x * dx, y2: y(c2.v), x: x0 + dx, y: y(to) });
    }
    return commands;
  };
  return {
    aspect: Number.NaN,
    commands: [{ op: "M", x: 0, y: 0.5 - half }, ...edge(-half, false), { op: "L", x: 1, y: 0.5 + half }, ...edge(half, true)],
  };
}

/** The shared shapes. The squiggle has no fixed aspect: it stretches to the hero row's width. */
export const CAPTION_SHAPES = { squiggle: squiggleShape(), star: starShape() } as const;

export type CaptionShapeName = keyof typeof CAPTION_SHAPES;

const coordinate = (value: number) => String(Math.round(value * 100) / 100);

/** A shape's points scaled to `width` x `height`, in order, as each serialiser writes them. */
export function captionShapePoints(shape: CaptionShape, width: number, height: number): { readonly op: "M" | "L" | "C"; readonly points: readonly number[] }[] {
  return shape.commands.map((command) => ({
    op: command.op,
    points: (command.op === "C" ? [command.x1, command.y1, command.x2, command.y2, command.x, command.y] : [command.x, command.y]).map((value, index) =>
      Number(coordinate(value * (index % 2 === 0 ? width : height)))),
  }));
}

/** The shape as an SVG path in a `width` x `height` box (the Studio). */
export function captionShapeSvgPath(shape: CaptionShape, width: number, height: number): string {
  return captionShapePoints(shape, width, height).map((command) => `${command.op} ${command.points.map(String).join(" ")}`).join(" ");
}

/** The shape as an ASS `\p1` drawing in a `width` x `height` box (the worker): `m`, `l` and `b`. */
export function captionShapeAssDrawing(shape: CaptionShape, width: number, height: number): string {
  const op = { M: "m", L: "l", C: "b" } as const;
  return captionShapePoints(shape, width, height).map((command) => `${op[command.op]} ${command.points.map(String).join(" ")}`).join(" ");
}
