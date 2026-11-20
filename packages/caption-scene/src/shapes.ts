import type { PathCmd } from "./scene";

/**
 * Drawing helpers: paths are a small command list (`M`, `L`, `C`, `Z`) in local px, (0, 0) at the
 * piece's anchor. Both renderers turn the same list into an SVG path (`pathToSvg`) or an ASS `\p`
 * drawing (`pathToAss`), so a shape is the same on both.
 */

const K = 0.5522847498307936; // cubic Bezier circle constant

const rect = (x1: number, y1: number, x2: number, y2: number): PathCmd[] => [["M", x1, y1], ["L", x2, y1], ["L", x2, y2], ["L", x1, y2], ["Z"]];

/** A rectangle with its top-left corner at (x, y). */
export function rectPath(x: number, y: number, width: number, height: number): PathCmd[] {
  return rect(x, y, x + width, y + height);
}

/** A rectangle centred on (0, 0). */
export function centredRect(width: number, height: number): PathCmd[] {
  return rect(-width / 2, -height / 2, width / 2, height / 2);
}

/** A rounded rectangle with its top-left at (x, y), corner radii clamped to half the shorter side. */
export function roundedRectPath(x: number, y: number, width: number, height: number, radius: number | readonly [number, number, number, number]): PathCmd[] {
  const limit = Math.min(width, height) / 2;
  const [tl, tr, br, bl] = (typeof radius === "number" ? [radius, radius, radius, radius] : radius).map((r) => Math.max(0, Math.min(r, limit))) as [number, number, number, number];
  const right = x + width;
  const bottom = y + height;
  return [
    ["M", x + tl, y],
    ["L", right - tr, y],
    ["C", right - tr + tr * K, y, right, y + tr - tr * K, right, y + tr],
    ["L", right, bottom - br],
    ["C", right, bottom - br + br * K, right - br + br * K, bottom, right - br, bottom],
    ["L", x + bl, bottom],
    ["C", x + bl - bl * K, bottom, x, bottom - bl + bl * K, x, bottom - bl],
    ["L", x, y + tl],
    ["C", x, y + tl - tl * K, x + tl - tl * K, y, x + tl, y],
    ["Z"],
  ];
}

/** An ellipse centred on (cx, cy). */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number = rx): PathCmd[] {
  return [
    ["M", cx + rx, cy],
    ["C", cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry],
    ["C", cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy],
    ["C", cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry],
    ["C", cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy],
    ["Z"],
  ];
}

/** A closed polygon through the points. */
export function polygonPath(points: readonly (readonly [number, number])[]): PathCmd[] {
  if (points.length === 0) return [];
  return [["M", points[0]![0], points[0]![1]], ...points.slice(1).map(([x, y]) => ["L", x, y] as const), ["Z"]];
}

/** An open polyline (stroke it). */
export function polylinePath(points: readonly (readonly [number, number])[]): PathCmd[] {
  if (points.length === 0) return [];
  return [["M", points[0]![0], points[0]![1]], ...points.slice(1).map(([x, y]) => ["L", x, y] as const)];
}

/** A four-pointed sparkle of the sample's proportions (`0.13` waist), `radius` from centre to tip. */
export function sparklePath(radius: number, cx = 0, cy = 0, waist = 0.13): PathCmd[] {
  const w = radius * waist;
  return polygonPath([[cx, cy - radius], [cx + w, cy - w], [cx + radius, cy], [cx + w, cy + w], [cx, cy + radius], [cx - w, cy + w], [cx - radius, cy], [cx - w, cy - w]]);
}

/** An n-pointed star, outer and inner radius, first point up. */
export function starPath(points: number, outer: number, inner: number, cx = 0, cy = 0): PathCmd[] {
  const vertices: [number, number][] = [];
  for (let index = 0; index < points * 2; index++) {
    const angle = -Math.PI / 2 + (index * Math.PI) / points;
    const radius = index % 2 === 0 ? outer : inner;
    vertices.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return polygonPath(vertices);
}

/** An arc of a circle from `startDeg` to `endDeg` (clockwise on screen, 0 = right), as cubic segments; open. */
export function arcPath(cx: number, cy: number, radius: number, startDeg: number, endDeg: number): PathCmd[] {
  const sweep = endDeg - startDeg;
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / 90));
  const step = ((sweep / segments) * Math.PI) / 180;
  const handle = (4 / 3) * Math.tan(step / 4);
  const commands: PathCmd[] = [];
  let angle = (startDeg * Math.PI) / 180;
  commands.push(["M", cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  for (let index = 0; index < segments; index++) {
    const next = angle + step;
    commands.push([
      "C",
      cx + radius * (Math.cos(angle) - handle * Math.sin(angle)),
      cy + radius * (Math.sin(angle) + handle * Math.cos(angle)),
      cx + radius * (Math.cos(next) + handle * Math.sin(next)),
      cy + radius * (Math.sin(next) - handle * Math.cos(next)),
      cx + radius * Math.cos(next),
      cy + radius * Math.sin(next),
    ]);
    angle = next;
  }
  return commands;
}

/** A corner bracket: an open L of two arms from the corner (x, y), pointing right/down by `dx`, `dy`. */
export function bracketPath(x: number, y: number, armX: number, armY: number): PathCmd[] {
  return polylinePath([[x + armX, y], [x, y], [x, y + armY]]);
}

/** A speech bubble body (rounded rectangle) with its tail corner left sharp: `side` is the sharp bottom corner. */
export function chatBubblePath(width: number, height: number, radius: number, tailRadius: number, side: "left" | "right"): PathCmd[] {
  return roundedRectPath(-width / 2, -height / 2, width, height, side === "left" ? [radius, radius, radius, tailRadius] : [radius, radius, tailRadius, radius]);
}

/**
 * The path drawn forward and then back to its start, which is a closed shape of no area. libass
 * draws every `\p` drawing as a closed fill; its border (`\bord`) of a zero-area drawing is a
 * stroke of the line itself, centred on it, with round joins and caps, which is how an open path
 * (a polyline, a bracket) or a closed outline (an ellipse ring) is stroked.
 */
export function retracePath(path: readonly PathCmd[]): PathCmd[] {
  const out: PathCmd[] = [];
  let start: [number, number] | null = null;
  let current: [number, number] | null = null;
  const forward: PathCmd[] = [];
  const backward: PathCmd[] = [];
  const flush = () => {
    if (start && forward.length > 0) {
      out.push(...forward, ...backward.reverse());
    }
    forward.length = 0;
    backward.length = 0;
  };
  for (const command of path) {
    if (command[0] === "M") {
      flush();
      start = [command[1], command[2]];
      current = start;
      forward.push(command);
    } else if (command[0] === "L" && current) {
      backward.push(["L", current[0], current[1]]);
      forward.push(command);
      current = [command[1], command[2]];
    } else if (command[0] === "C" && current) {
      backward.push(["C", command[3], command[4], command[1], command[2], current[0], current[1]]);
      forward.push(command);
      current = [command[5], command[6]];
    } else if (command[0] === "Z" && current && start) {
      backward.push(["L", current[0], current[1]]);
      forward.push(["L", start[0], start[1]]);
      current = start;
    }
  }
  flush();
  return out;
}

const fixed = (value: number) => String(Math.round(value * 100) / 100);

/** SVG `d` of a path. */
export function pathToSvg(path: readonly PathCmd[]): string {
  return path
    .map((command) => {
      if (command[0] === "Z") return "Z";
      return `${command[0]}${command.slice(1).map((value) => fixed(value as number)).join(" ")}`;
    })
    .join(" ");
}

/**
 * An ASS `\p` drawing of a path, coordinates multiplied by `2^(precision - 1)` (the `\pN` scale
 * divides them back), so sub-pixel curves survive the integer-looking drawing grammar.
 */
export function pathToAss(path: readonly PathCmd[], precision = 1): string {
  const k = 2 ** (precision - 1);
  const f = (value: number) => fixed(value * k);
  const out: string[] = [];
  let open = false;
  for (const command of path) {
    if (command[0] === "M") {
      out.push(`m ${f(command[1])} ${f(command[2])}`);
      open = true;
    } else if (command[0] === "L") out.push(`l ${f(command[1])} ${f(command[2])}`);
    else if (command[0] === "C") out.push(`b ${f(command[1])} ${f(command[2])} ${f(command[3])} ${f(command[4])} ${f(command[5])} ${f(command[6])}`);
    else if (open) open = false;
  }
  return out.join(" ");
}

/** Bounds of a path's control points. */
export function pathBounds(path: readonly PathCmd[]): { x1: number; y1: number; x2: number; y2: number } {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (const command of path) {
    for (let index = 1; index + 1 <= command.length - 1; index += 2) {
      const x = command[index] as number;
      const y = command[index + 1] as number;
      x1 = Math.min(x1, x);
      x2 = Math.max(x2, x);
      y1 = Math.min(y1, y);
      y2 = Math.max(y2, y);
    }
  }
  return Number.isFinite(x1) ? { x1, y1, x2, y2 } : { x1: 0, y1: 0, x2: 0, y2: 0 };
}
