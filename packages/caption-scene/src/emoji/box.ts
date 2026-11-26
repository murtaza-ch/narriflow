import type { Box } from "../scene";

/** The axis-aligned bounds of `box` turned by `deg` (clockwise on screen) about `pivot` (the origin by default). */
export function turnedBox(box: Box, deg: number, pivot: { readonly x: number; readonly y: number } = { x: 0, y: 0 }): Box {
  if (deg === 0) return box;
  const angle = (deg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners = [[box.x1, box.y1], [box.x2, box.y1], [box.x2, box.y2], [box.x1, box.y2]] as const;
  const xs = corners.map(([x, y]) => pivot.x + (x - pivot.x) * cos - (y - pivot.y) * sin);
  const ys = corners.map(([x, y]) => pivot.y + (x - pivot.x) * sin + (y - pivot.y) * cos);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/** The smallest box holding every box; null for none. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    x1 = Math.min(x1, box.x1);
    y1 = Math.min(y1, box.y1);
    x2 = Math.max(x2, box.x2);
    y2 = Math.max(y2, box.y2);
  }
  return { x1, y1, x2, y2 };
}
