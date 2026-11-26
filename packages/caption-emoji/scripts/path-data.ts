/**
 * Path plumbing for the compiler: Skia path helpers, contour extraction with nesting depth, and
 * the compact absolute `M/L/C/Z` writer whose contour directions fill correctly under non-zero.
 */
import type { CanvasKit, Path } from "canvaskit-wasm";
import { CAPTION_EMOJI_BOX } from "../src/geometry";
import type { Matrix } from "./svg";

/** Stroke resolution multiplier: the grid is drawn up to about 6x (a large sticker on 4K). */
export const STROKE_PRECISION = 4;

/**
 * Non-overlapping, non-crossing contours (Skia's simplify). Skia's own `makeAsWinding` misses
 * some holes (the fire engine's ladder), so contour direction for non-zero winding is set when
 * the path is written out (`orientedContours`).
 */
export function normalise(_ck: CanvasKit, path: Path): Path | null {
  return (path as unknown as { _makeSimplified(): Path | null })._makeSimplified();
}

export function transformPath(ck: CanvasKit, path: Path, m: Matrix): Path | null {
  const cmds = Array.from(path.toCmds());
  const out: number[] = [];
  const point = (x: number, y: number) => out.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
  for (let i = 0; i < cmds.length; ) {
    const verb = cmds[i++]!;
    out.push(verb);
    const pairs = verb === ck.MOVE_VERB || verb === ck.LINE_VERB ? 1 : verb === ck.QUAD_VERB || verb === ck.CONIC_VERB ? 2 : verb === ck.CUBIC_VERB ? 3 : 0;
    for (let p = 0; p < pairs; p += 1) point(cmds[i++]!, cmds[i++]!);
    if (verb === ck.CONIC_VERB) out.push(cmds[i++]!);
  }
  const result = ck.Path.MakeFromCmds(out);
  result?.setFillType(path.getFillType());
  return result;
}

type Segment = [number, number, number, number, number, number, number, number];

/** Cubic segments per contour: conics are split to 90 degrees or less and then fitted. */
function contours(ck: CanvasKit, path: Path): { cubics: Segment[]; closed: boolean }[] {
  const cmds = path.toCmds();
  const result: { cubics: Segment[]; closed: boolean }[] = [];
  let current: { cubics: Segment[]; closed: boolean } | null = null;
  let x = 0;
  let y = 0;
  const cubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    current!.cubics.push([x, y, x1, y1, x2, y2, x3, y3]);
    x = x3;
    y = y3;
  };
  const conic = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, w: number) => {
    if (w < 0.7) {
      const nw = Math.sqrt((1 + w) / 2);
      const mx = (x0 + 2 * w * x1 + x2) / (2 * (1 + w));
      const my = (y0 + 2 * w * y1 + y2) / (2 * (1 + w));
      conic(x0, y0, (x0 + w * x1) / (1 + w), (y0 + w * y1) / (1 + w), mx, my, nw);
      conic(mx, my, (w * x1 + x2) / (1 + w), (w * y1 + y2) / (1 + w), x2, y2, nw);
      return;
    }
    const k = (4 * w) / (3 * (1 + w));
    cubic(x0 + k * (x1 - x0), y0 + k * (y1 - y0), x2 + k * (x1 - x2), y2 + k * (y1 - y2), x2, y2);
  };
  for (let i = 0; i < cmds.length; ) {
    const verb = cmds[i++]!;
    if (verb === ck.MOVE_VERB) {
      current = { cubics: [], closed: false };
      result.push(current);
      x = cmds[i++]!;
      y = cmds[i++]!;
    } else if (verb === ck.LINE_VERB) {
      const [x1, y1] = [cmds[i++]!, cmds[i++]!];
      current!.cubics.push([x, y, Number.NaN, 0, 0, 0, x1, y1]);
      x = x1;
      y = y1;
    } else if (verb === ck.QUAD_VERB) {
      const [x1, y1, x2, y2] = [cmds[i++]!, cmds[i++]!, cmds[i++]!, cmds[i++]!];
      cubic(x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y), x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2), x2, y2);
    } else if (verb === ck.CONIC_VERB) {
      const [x1, y1, x2, y2, w] = [cmds[i++]!, cmds[i++]!, cmds[i++]!, cmds[i++]!, cmds[i++]!];
      conic(x, y, x1, y1, x2, y2, w);
    } else if (verb === ck.CUBIC_VERB) {
      const [x1, y1, x2, y2, x3, y3] = [cmds[i++]!, cmds[i++]!, cmds[i++]!, cmds[i++]!, cmds[i++]!, cmds[i++]!];
      cubic(x1, y1, x2, y2, x3, y3);
    } else if (verb === ck.CLOSE_VERB) {
      if (current) {
        const start = current.cubics[0];
        if (start && (start[0] !== x || start[1] !== y)) {
          current.cubics.push([x, y, Number.NaN, 0, 0, 0, start[0], start[1]]);
          x = start[0];
          y = start[1];
        }
        current.closed = true;
      }
    } else {
      throw new Error(`unknown verb ${verb}`);
    }
  }
  return result;
}

function flatten(cubics: Segment[]): [number, number][] {
  const points: [number, number][] = [];
  for (const s of cubics) {
    if (Number.isNaN(s[2])) {
      points.push([s[6], s[7]]);
      continue;
    }
    for (let k = 1; k <= 8; k += 1) {
      const t = k / 8;
      const u = 1 - t;
      points.push([
        u * u * u * s[0] + 3 * u * u * t * s[2] + 3 * u * t * t * s[4] + t * t * t * s[6],
        u * u * u * s[1] + 3 * u * u * t * s[3] + 3 * u * t * t * s[5] + t * t * t * s[7],
      ]);
    }
  }
  return points;
}

function signedArea(points: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

function pointInside(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Contours never cross after simplify, so a majority of sampled points decides nesting. */
function containsContour(outer: [number, number][], inner: [number, number][]): boolean {
  const step = Math.max(1, Math.floor(inner.length / 15));
  let votes = 0;
  let total = 0;
  for (let i = 0; i < inner.length; i += step) {
    total += 1;
    if (pointInside(inner[i]![0], inner[i]![1], outer)) votes += 1;
  }
  return votes * 2 > total;
}

function reverseContour(cubics: Segment[]): Segment[] {
  return cubics
    .map((s): Segment => (Number.isNaN(s[2]) ? [s[6], s[7], Number.NaN, 0, 0, 0, s[0], s[1]] : [s[6], s[7], s[4], s[5], s[2], s[3], s[0], s[1]]))
    .reverse();
}

export interface NestedContour {
  cubics: Segment[];
  closed: boolean;
  /** The contour flattened to points. */
  polygon: [number, number][];
  /** How many other contours enclose it: even is filled, odd is a hole (simplified paths only). */
  depth: number;
}

/** Contours with their nesting depth; meaningful for a simplified path, whose contours never cross. */
export function nestedContours(ck: CanvasKit, path: Path): NestedContour[] {
  const list = contours(ck, path).filter((contour) => contour.cubics.length > 0);
  const polygons = list.map((contour) => flatten(contour.cubics));
  return list.map((contour, i) => {
    let depth = 0;
    for (let j = 0; j < list.length; j += 1) if (j !== i && containsContour(polygons[j]!, polygons[i]!)) depth += 1;
    return { ...contour, polygon: polygons[i]!, depth };
  });
}

/** An even-odd path from contours (the fill rule simplified paths carry). */
export function pathFromContours(ck: CanvasKit, list: readonly NestedContour[]): Path {
  const builder = new ck.PathBuilder();
  for (const { cubics, closed } of list) {
    builder.moveTo(cubics[0]![0], cubics[0]![1]);
    for (const s of cubics) {
      if (Number.isNaN(s[2])) builder.lineTo(s[6], s[7]);
      else builder.cubicTo(s[2], s[3], s[4], s[5], s[6], s[7]);
    }
    if (closed) builder.close();
  }
  const path = builder.detachAndDelete();
  path.setFillType(ck.FillType.EvenOdd);
  return path;
}

/**
 * Contours directed for non-zero winding: positive area at even nesting depth, negative at odd,
 * so holes stay holes in libass and in SVG. `area` is signed the same way.
 */
function orientedContours(ck: CanvasKit, path: Path): { cubics: Segment[]; closed: boolean; area: number }[] {
  return nestedContours(ck, path).map((contour) => {
    const area = signedArea(contour.polygon);
    const positive = contour.depth % 2 === 0;
    return {
      cubics: area > 0 === positive ? contour.cubics : reverseContour(contour.cubics),
      closed: contour.closed,
      area: positive ? Math.abs(area) : -Math.abs(area),
    };
  });
}

export function round(value: number, per = 100): number {
  const r = Math.round(value * per) / per;
  return Object.is(r, -0) ? 0 : r;
}

function num(value: number): string {
  const text = String(value);
  return text.startsWith("0.") ? text.slice(1) : text.startsWith("-0.") ? `-${text.slice(2)}` : text;
}

/**
 * Splits a cubic in half until its control points lie inside the drawing box: libass sizes a
 * drawing by every point, control points included. The curve itself is unchanged.
 */
function insideBox(s: Segment, depth = 0): Segment[] {
  const { x, y, width, height } = CAPTION_EMOJI_BOX;
  const inside = (px: number, py: number) => px >= x && py >= y && px <= x + width && py <= y + height;
  if (Number.isNaN(s[2]) || depth >= 12 || (inside(s[2], s[3]) && inside(s[4], s[5]))) return [s];
  const mid = (a: number, b: number) => (a + b) / 2;
  const [ax, ay, bx, by] = [mid(s[0], s[2]), mid(s[1], s[3]), mid(s[2], s[4]), mid(s[3], s[5])];
  const [cx, cy] = [mid(s[4], s[6]), mid(s[5], s[7])];
  const [dx, dy, ex, ey] = [mid(ax, bx), mid(ay, by), mid(bx, cx), mid(by, cy)];
  const [fx, fy] = [mid(dx, ex), mid(dy, ey)];
  return [...insideBox([s[0], s[1], ax, ay, dx, dy, fx, fy], depth + 1), ...insideBox([fx, fy, ex, ey, cx, cy, s[6], s[7]], depth + 1)];
}

/**
 * Compact absolute path data: `M x y`, `L x y`, `C x1 y1 x2 y2 x y`, `Z`; a repeated command
 * letter is left out. Coordinates are rounded to `decimals` places.
 */
export function pathData(ck: CanvasKit, path: Path, decimals = 2): string {
  const per = 10 ** decimals;
  let out = "";
  let lastLetter = "";
  let lastNumber = "";
  const emit = (letter: string, values: number[]) => {
    if (letter !== lastLetter || letter === "M" || letter === "Z") {
      out += letter;
      lastNumber = "";
    }
    for (const value of values) {
      const n = num(value);
      const glue = lastNumber === "" || n.startsWith("-") || (n.startsWith(".") && lastNumber.includes(".")) ? "" : " ";
      out += glue + n;
      lastNumber = n;
    }
    lastLetter = letter;
  };
  for (const contour of orientedContours(ck, path)) {
    const segments = contour.cubics
      .flatMap((s) => insideBox(s))
      .map((s) => s.map((v, i) => (i === 2 && Number.isNaN(v) ? v : round(v, per))) as Segment)
      .filter((s) => !(s[0] === s[6] && s[1] === s[7] && (Number.isNaN(s[2]) || (s[2] === s[0] && s[3] === s[1] && s[4] === s[0] && s[5] === s[1]))));
    if (segments.length === 0) continue;
    const first = segments[0]!;
    emit("M", [first[0], first[1]]);
    segments.forEach((s, index) => {
      const isClosingLine = contour.closed && index === segments.length - 1 && Number.isNaN(s[2]) && s[6] === first[0] && s[7] === first[1];
      if (isClosingLine) return;
      if (Number.isNaN(s[2])) emit("L", [s[6], s[7]]);
      else emit("C", [s[2], s[3], s[4], s[5], s[6], s[7]]);
    });
    if (contour.closed) emit("Z", []);
  }
  return out;
}

/** Filled area in grid units squared (curves flattened). */
export function pathArea(ck: CanvasKit, path: Path): number {
  return orientedContours(ck, path).reduce((sum, contour) => sum + contour.area, 0);
}
