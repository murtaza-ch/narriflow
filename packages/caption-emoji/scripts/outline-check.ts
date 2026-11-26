/**
 * Checks a compiled sticker outline against an exact raster dilation of the silhouette: the
 * silhouette (the union of the layers) is rendered as a mask over `CAPTION_EMOJI_BOX`, a Euclidean
 * distance transform gives every pixel's distance to it, and the outline must cover every pixel
 * nearer than the outline width (no gap at a concave corner, no thin spot). The outline keeps a hole only when it holds
 * a disc of `CAPTION_EMOJI_KEPT_HOLE_GRID`; any other hole is a fault, and one narrower than a sliver is counted apart.
 */
import { CAPTION_EMOJI_BOX, CAPTION_EMOJI_KEPT_HOLE_GRID, CAPTION_EMOJI_OUTLINE_GRID } from "../src/geometry";
import { distanceSquared, mask } from "./raster";

/** Mask pixels across the drawing box: about 7.5 per grid unit. */
const SIZE = 512;
const SCALE = SIZE / CAPTION_EMOJI_BOX.width;
/** Pixels this close to the band's ideal edge are anti-aliasing, not a defect. */
const EDGE_PX = 1.5;
/** A hole whose widest point is narrower than this (grid units) is a sliver. */
export const SLIVER_GRID = 1;

export interface OutlineScore {
  /** Pixels nearer the silhouette than the band width that the outline leaves uncovered. */
  missing: number;
  /** Silhouette pixels outside the outline. */
  uncovered: number;
  /** Outline pixels farther out than the band width: the holes and narrow notches it fills. */
  filled: number;
  /** Holes in the outline narrower than `SLIVER_GRID`. */
  slivers: number;
  /** Holes the outline should have filled: not slivers, and too small to keep. */
  holes: number;
  /** Holes kept open: each holds a disc of `CAPTION_EMOJI_KEPT_HOLE_GRID`. */
  kept: number;
}

/** Scores `outline` against the silhouette of `layers` (their path data). */
export function scoreOutline(layers: readonly string[], outline: string): OutlineScore {
  const shape = mask(layers, SIZE);
  const band = mask([outline], SIZE);
  const toShape = distanceSquared(shape, SIZE);
  const width = CAPTION_EMOJI_OUTLINE_GRID * SCALE;
  let missing = 0;
  let uncovered = 0;
  let filled = 0;
  for (let i = 0; i < band.length; i += 1) {
    const distance = Math.sqrt(toShape[i]!);
    if (shape[i] && !band[i]) uncovered += 1;
    if (!band[i] && distance <= width - EDGE_PX) missing += 1;
    if (band[i] && distance > width + EDGE_PX) filled += 1;
  }

  // Holes: background regions that do not reach the box's edge. A hole's half-width is its
  // largest distance to the outline.
  const label = new Int32Array(SIZE * SIZE).fill(-1);
  const toBand = distanceSquared(band, SIZE);
  let slivers = 0;
  let holes = 0;
  let kept = 0;
  const stack: number[] = [];
  for (let start = 0; start < band.length; start += 1) {
    if (band[start] || label[start] !== -1) continue;
    let touchesEdge = false;
    let widest = 0;
    label[start] = start;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const [x, y] = [i % SIZE, Math.floor(i / SIZE)];
      if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) touchesEdge = true;
      widest = Math.max(widest, toBand[i]!);
      for (const j of [i - 1, i + 1, i - SIZE, i + SIZE]) {
        if (j < 0 || j >= band.length || band[j] || label[j] !== -1) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === SIZE - 1)) continue;
        label[j] = start;
        stack.push(j);
      }
    }
    if (touchesEdge) continue;
    if (Math.sqrt(widest) * 2 < SLIVER_GRID * SCALE) slivers += 1;
    else if (Math.sqrt(widest) >= CAPTION_EMOJI_KEPT_HOLE_GRID * SCALE - EDGE_PX) kept += 1;
    else holes += 1;
  }
  return { missing, uncovered, filled, slivers, holes, kept };
}
