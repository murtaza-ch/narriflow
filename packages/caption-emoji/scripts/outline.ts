/**
 * Dilation and the sticker outline. Dilation keeps only outer boundaries. The outline also keeps
 * the holes that stay large once it has grown into them (`CAPTION_EMOJI_KEPT_HOLE_GRID`: heart
 * hands, chain links) and fills the rest: a small hole would show the hard shadow inside the emoji
 * as a speck. Filling also removes Skia's false rings: it strokes a contour's inner side wrongly
 * where the half-width exceeds twice the curve's radius (a tiny sun ray in a 3 unit band), and the
 * flipped inner offset leaves a ring of winding 0, always a hole and always thin.
 */
import type { CanvasKit, Path } from "canvaskit-wasm";
import { CAPTION_EMOJI_BOX, CAPTION_EMOJI_KEPT_HOLE_GRID, CAPTION_EMOJI_OUTLINE_GRID } from "../src/geometry";
import { nestedContours, normalise, pathData, pathFromContours, STROKE_PRECISION } from "./path-data";
import { distanceSquared, mask } from "./raster";

/**
 * The outline is closed with this radius after dilation, so notches narrower than
 * `2 * (CAPTION_EMOJI_OUTLINE_GRID + OUTLINE_CLOSING)` fill instead of leaving slivers.
 */
const OUTLINE_CLOSING = 1;
/** 0.05 grid units at most, a third of a pixel on the largest sticker; the art covers its inner edge. */
export const OUTLINE_DECIMALS = 1;

function band(ck: CanvasKit, path: Path, radius: number): Path | null {
  return path.makeStroked({ width: radius * 2, cap: ck.StrokeCap.Round, join: ck.StrokeJoin.Round, precision: STROKE_PRECISION });
}

/** The path's outer boundaries filled solid. Takes ownership of `path`. */
function solid(ck: CanvasKit, path: Path | null): Path | null {
  if (!path) return null;
  const simple = normalise(ck, path);
  path.delete();
  if (!simple) return null;
  const list = nestedContours(ck, simple);
  if (list.every((contour) => contour.depth === 0)) return simple;
  simple.delete();
  return pathFromContours(ck, list.filter((contour) => contour.depth === 0));
}

/** Every point within `radius` of the shape (round joins and caps), holes kept. */
function grow(ck: CanvasKit, path: Path, radius: number): Path | null {
  const ring = band(ck, path, radius);
  if (!ring) return null;
  const grown = ck.Path.MakeFromOp(path, ring, ck.PathOp.Union);
  ring.delete();
  return grown;
}

/** Every point within `radius` of the shape (round joins and caps), with holes filled. */
export function dilate(ck: CanvasKit, path: Path, radius: number): Path | null {
  return solid(ck, grow(ck, path, radius));
}

/** Mask pixels across the drawing box when measuring a hole: about 15 per grid unit. */
const HOLE_MASK = 1024;

/** The radius of the largest disc inside a hole (one contour, filled), grid units, from an exact raster distance transform. */
function holeRadius(ck: CanvasKit, hole: Path): number {
  const inside = mask([pathData(ck, hole, 3)], HOLE_MASK);
  const outside = inside.map((pixel) => 1 - pixel);
  const toOutside = distanceSquared(outside, HOLE_MASK);
  let widest = 0;
  for (let i = 0; i < inside.length; i += 1) if (inside[i] && toOutside[i]! > widest) widest = toOutside[i]!;
  return (Math.sqrt(widest) * CAPTION_EMOJI_BOX.width) / HOLE_MASK;
}

/** The holes of a simplified path that hold a disc of `CAPTION_EMOJI_KEPT_HOLE_GRID`, filled as one shape; null when none does. */
function keptHoles(ck: CanvasKit, path: Path): Path | null {
  let kept: Path | null = null;
  for (const contour of nestedContours(ck, path)) {
    if (contour.depth !== 1) continue;
    const hole = pathFromContours(ck, [{ ...contour, depth: 0 }]);
    if (holeRadius(ck, hole) < CAPTION_EMOJI_KEPT_HOLE_GRID) {
      hole.delete();
      continue;
    }
    if (!kept) {
      kept = hole;
      continue;
    }
    const united: Path | null = ck.Path.MakeFromOp(kept, hole, ck.PathOp.Union);
    kept.delete();
    hole.delete();
    kept = united;
  }
  return kept;
}

/**
 * The sticker outline: the silhouette dilated by `CAPTION_EMOJI_OUTLINE_GRID`, then closed
 * (dilated further and eroded back by `OUTLINE_CLOSING`), its holes filled except those that hold
 * a disc of `CAPTION_EMOJI_KEPT_HOLE_GRID` (parts of the design inside a kept hole keep their own
 * outline). Erosion is the shape minus a band of the radius round its edge; the dilated shape's
 * curves, outer edges and hole edges alike, are all wider than that band, so Skia strokes them
 * correctly.
 */
export function stickerOutline(ck: CanvasKit, silhouette: Path): Path | null {
  const filled = closeOutline(ck, dilate(ck, silhouette, CAPTION_EMOJI_OUTLINE_GRID + OUTLINE_CLOSING));
  if (!filled) return null;
  // The same outline with its holes, to find the ones worth keeping.
  const raw = grow(ck, silhouette, CAPTION_EMOJI_OUTLINE_GRID + OUTLINE_CLOSING);
  const grown = raw && normalise(ck, raw);
  raw?.delete();
  const cut = grown && closeCut(ck, grown);
  const closed = cut && normalise(ck, cut);
  cut?.delete();
  const kept = closed && keptHoles(ck, closed);
  if (!closed || !kept) {
    closed?.delete();
    return filled;
  }
  // The filled outline less the kept holes, plus the parts of the design inside them (their own holes filled).
  const open = ck.Path.MakeFromOp(filled, kept, ck.PathOp.Difference);
  const inner = solid(ck, ck.Path.MakeFromOp(closed, kept, ck.PathOp.Intersect));
  closed.delete();
  kept.delete();
  filled.delete();
  const outline = open && inner ? ck.Path.MakeFromOp(open, inner, ck.PathOp.Union) : open;
  if (outline !== open) open?.delete();
  inner?.delete();
  const simple = outline && normalise(ck, outline);
  outline?.delete();
  return simple;
}

/** The grown shape eroded back by `OUTLINE_CLOSING` (the shape minus a band of that radius round its edge). Takes ownership. */
function closeCut(ck: CanvasKit, grown: Path): Path | null {
  const edge = band(ck, grown, OUTLINE_CLOSING);
  const eroded = edge && ck.Path.MakeFromOp(grown, edge, ck.PathOp.Difference);
  grown.delete();
  edge?.delete();
  return eroded;
}

/** The closed outline with every hole filled. Takes ownership. */
function closeOutline(ck: CanvasKit, grown: Path | null): Path | null {
  return grown && solid(ck, closeCut(ck, grown));
}
