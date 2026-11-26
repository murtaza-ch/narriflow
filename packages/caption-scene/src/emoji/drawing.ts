import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { CAPTION_EMOJI_BOX, CAPTION_EMOJI_GRID, type CaptionEmojiPalette, parseCaptionEmojiPath, resolveCaptionEmojiColour } from "@narriflow/caption-emoji/draw";
import { CAPTION_EMOJI_STICKER_WHITE } from "@narriflow/validators";
import type { Box, PathCmd } from "../scene";
import { pathBounds } from "../shapes";
import { unionBox } from "./box";

/**
 * One emoji's art as fills in local px (spec D3). Every part shares one drawing box: the art's
 * `CAPTION_EMOJI_BOX` grown by the sticker shadow's reach, scaled, with its top-left corner at
 * the local origin. Each part's path starts with a move to each corner of that box, which draws
 * nothing, but libass sizes and aligns a `\p1` drawing by all its points, moves included, and
 * `pathBounds` reads them too. So every part has the same bounds, its pivot (the box centre) is
 * the point libass aligns it by, and the writer keeps one `\pos` for the whole pop instead of
 * cutting an event per frame per layer. The Studio draws paths at their own coordinates and is
 * unaffected by the corners.
 */

/** The sticker shadow's offset, down and to the right on screen, as a fraction of the emoji's size. */
export const CAPTION_EMOJI_SHADOW_OFFSET = 0.04;

/** The shadow's reach in grid units along either axis whatever the tilt (the offset turns against the emoji). */
const SHADOW_REACH = CAPTION_EMOJI_SHADOW_OFFSET * CAPTION_EMOJI_GRID * Math.SQRT2;

/** The shared drawing box in grid units: `CAPTION_EMOJI_BOX` grown on every side, so it stays centred on the grid. */
const DRAWING_BOX = {
  x: CAPTION_EMOJI_BOX.x - SHADOW_REACH,
  y: CAPTION_EMOJI_BOX.y - SHADOW_REACH,
  side: CAPTION_EMOJI_BOX.width + 2 * SHADOW_REACH,
} as const;

/** The art's sticker backing, white: the palette keeps the rim apart from it. */
export { CAPTION_EMOJI_STICKER_WHITE };

export interface CaptionEmojiDrawingPart {
  /** `shadow`, `outline`, or the colour layer's index in the art. */
  readonly key: string;
  readonly path: readonly PathCmd[];
  readonly colour: string;
  readonly alpha?: number;
}

export interface CaptionEmojiDrawing {
  /** Side of the shared drawing box, px; the pivot is its centre, `(side / 2, side / 2)` in local px. */
  readonly side: number;
  /** Paint order, bottom first. */
  readonly parts: readonly CaptionEmojiDrawingPart[];
  /** What the parts paint, relative to the pivot, before the emoji's tilt. */
  readonly ink: Box;
}

interface ParsedArt {
  readonly outline: readonly PathCmd[];
  readonly outlineBounds: Box;
  readonly layers: readonly { readonly path: readonly PathCmd[]; readonly bounds: Box }[];
}

const parsed = new WeakMap<CaptionEmojiArt, ParsedArt>();

function parse(art: CaptionEmojiArt): ParsedArt {
  let found = parsed.get(art);
  if (!found) {
    const outline = parseCaptionEmojiPath(art.outline) as PathCmd[];
    found = {
      outline,
      outlineBounds: pathBounds(outline),
      layers: art.layers.map((layer) => {
        const path = parseCaptionEmojiPath(layer.d) as PathCmd[];
        return { path, bounds: pathBounds(path) };
      }),
    };
    parsed.set(art, found);
  }
  return found;
}

/** Grid path to local px: moved by `(dx, dy)` grid units, scaled by `k`, the box corner at the origin, the corners first. */
function place(path: readonly PathCmd[], k: number, dx: number, dy: number): PathCmd[] {
  const side = DRAWING_BOX.side * k;
  const x = (value: number) => (value + dx - DRAWING_BOX.x) * k;
  const y = (value: number) => (value + dy - DRAWING_BOX.y) * k;
  const out: PathCmd[] = [["M", 0, 0], ["M", side, side]];
  for (const command of path) {
    switch (command[0]) {
      case "Z":
        out.push(command);
        break;
      case "C":
        out.push(["C", x(command[1]), y(command[2]), x(command[3]), y(command[4]), x(command[5]), y(command[6])]);
        break;
      default:
        out.push([command[0], x(command[1]), y(command[2])]);
    }
  }
  return out;
}

/**
 * The parts of one emoji drawn `sizePx` tall (the 64 grid). With `sticker`: its outline as a hard
 * shadow in `shadowColour`, offset down-right on screen however the emoji is turned (`tiltDeg`),
 * then the outline in white; then the colour layers at the palette and tone. A layer the tone does
 * not draw is left out.
 */
export function captionEmojiDrawing(
  art: CaptionEmojiArt,
  options: {
    readonly sizePx: number;
    readonly palette: CaptionEmojiPalette;
    readonly tone?: number;
    readonly sticker: boolean;
    readonly shadowColour: string;
    readonly tiltDeg: number;
  },
): CaptionEmojiDrawing {
  const source = parse(art);
  const k = options.sizePx / CAPTION_EMOJI_GRID;
  const side = DRAWING_BOX.side * k;
  const centre = (CAPTION_EMOJI_GRID / 2) * k;
  const parts: CaptionEmojiDrawingPart[] = [];
  const inks: Box[] = [];
  const grow = (bounds: Box, dx: number, dy: number) => {
    inks.push({ x1: (bounds.x1 + dx) * k - centre, y1: (bounds.y1 + dy) * k - centre, x2: (bounds.x2 + dx) * k - centre, y2: (bounds.y2 + dy) * k - centre });
  };
  if (options.sticker) {
    // Down-right on screen: the local offset is turned back by the emoji's tilt.
    const angle = (-options.tiltDeg * Math.PI) / 180;
    const offset = CAPTION_EMOJI_SHADOW_OFFSET * CAPTION_EMOJI_GRID;
    const dx = offset * (Math.cos(angle) - Math.sin(angle));
    const dy = offset * (Math.sin(angle) + Math.cos(angle));
    parts.push({ key: "shadow", path: place(source.outline, k, dx, dy), colour: options.shadowColour });
    parts.push({ key: "outline", path: place(source.outline, k, 0, 0), colour: CAPTION_EMOJI_STICKER_WHITE });
    grow(source.outlineBounds, dx, dy);
    grow(source.outlineBounds, 0, 0);
  }
  art.layers.forEach((layer, index) => {
    const colour = resolveCaptionEmojiColour(layer.colour, options.palette, options.tone ?? 0);
    if (colour === null) return;
    const parsedLayer = source.layers[index]!;
    parts.push({ key: String(index), path: place(parsedLayer.path, k, 0, 0), colour, ...(layer.alpha !== undefined ? { alpha: layer.alpha } : {}) });
    // A layer's bounds (control points included) can reach past the outline's.
    grow(parsedLayer.bounds, 0, 0);
  });
  return { side, parts, ink: unionBox(inks) ?? { x1: 0, y1: 0, x2: 0, y2: 0 } };
}
