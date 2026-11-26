import type { StudioTextLayer } from "@narriflow/validators";
import { computeSnap, type SnapGuide } from "./snap-guides";

/**
 * What the canvas gestures on a Text Layer do to it (title-text spec section 6). Positions and the
 * wrap width are percentages of the canvas; the layer's position is the centre of its frame.
 * A gesture starts from the layer as it was when the pointer went down.
 */

export const TEXT_LAYER_FONT_SIZE = { min: 8, max: 240 } as const;
export const TEXT_LAYER_WIDTH_PCT = { min: 10, max: 100 } as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, step: number) => Math.round(value / step) * step;

export type TextLayerGeometry = Pick<StudioTextLayer, "positionX" | "positionY" | "widthPct"> & { readonly fontSize: number };

/**
 * How far a frame may leave the canvas: its size and the overlap that must stay inside, in percent
 * of the canvas on each axis.
 */
export interface TextLayerReach {
  readonly widthPct: number;
  readonly heightPct: number;
  /** Frame that stays inside on each axis (24 preview px, as a percentage of the canvas). */
  readonly overlapXPct: number;
  readonly overlapYPct: number;
}

/** The frame's centre on one axis: at least `overlap` of the frame stays inside, and the centre itself never leaves. */
function clampAxis(centre: number, size: number, overlap: number): number {
  const keep = Math.min(overlap, size);
  return clamp(centre, Math.max(0, keep - size / 2), Math.min(100, 100 - keep + size / 2));
}

/** A centre kept where the frame's grips stay reachable (`TextLayerReach`). */
export function keepTextLayerReachable(positionX: number, positionY: number, reach: TextLayerReach): { positionX: number; positionY: number } {
  return {
    positionX: round(clampAxis(positionX, reach.widthPct, reach.overlapXPct), 0.01),
    positionY: round(clampAxis(positionY, reach.heightPct, reach.overlapYPct), 0.01),
  };
}

/**
 * A drag by `dxPct, dyPct` of the canvas: the centre snaps to the guides, then is held so part of
 * the frame stays on the canvas (`keepTextLayerReachable`; without a reach, the centre stays inside).
 */
export function dragTextLayer(start: Pick<TextLayerGeometry, "positionX" | "positionY">, dxPct: number, dyPct: number, reach?: TextLayerReach): { positionX: number; positionY: number; guides: SnapGuide[] } {
  const snapped = computeSnap(clamp(start.positionX + dxPct, 0, 100), clamp(start.positionY + dyPct, 0, 100));
  const kept = keepTextLayerReachable(snapped.x, snapped.y, reach ?? { widthPct: 0, heightPct: 0, overlapXPct: 0, overlapYPct: 0 });
  // A guide shows only where the layer actually sits.
  const guides = snapped.guides.filter((guide) => (guide.axis === "x" ? kept.positionX : kept.positionY) === guide.position);
  return { ...kept, guides };
}

/** An arrow-key nudge: no snapping, the same reach rule as a drag. */
export function nudgeTextLayer(start: Pick<TextLayerGeometry, "positionX" | "positionY">, dxPct: number, dyPct: number, reach: TextLayerReach): { positionX: number; positionY: number } {
  return keepTextLayerReachable(start.positionX + dxPct, start.positionY + dyPct, reach);
}

/**
 * A corner grip: font size and wrap width scale together by `factor` about the frame's centre, so
 * the text keeps its line breaks. The factor is held where either would leave its range, so the two
 * never drift apart.
 */
export function cornerResizeTextLayer(start: Pick<TextLayerGeometry, "fontSize" | "widthPct">, factor: number): { fontSize: number; widthPct: number } {
  const low = Math.max(TEXT_LAYER_FONT_SIZE.min / start.fontSize, TEXT_LAYER_WIDTH_PCT.min / start.widthPct);
  const high = Math.min(TEXT_LAYER_FONT_SIZE.max / start.fontSize, TEXT_LAYER_WIDTH_PCT.max / start.widthPct);
  const held = Number.isFinite(factor) && factor > 0 ? clamp(factor, Math.min(low, 1), Math.max(high, 1)) : 1;
  return {
    fontSize: clamp(round(start.fontSize * held, 0.5), TEXT_LAYER_FONT_SIZE.min, TEXT_LAYER_FONT_SIZE.max),
    widthPct: clamp(round(start.widthPct * held, 0.1), TEXT_LAYER_WIDTH_PCT.min, TEXT_LAYER_WIDTH_PCT.max),
  };
}

/**
 * A side grip: the wrap width follows the pointer (`pointerXPct` of the canvas) and the opposite
 * edge stays put. The centre stays inside the canvas.
 */
export function sideResizeTextLayer(start: Pick<TextLayerGeometry, "positionX" | "widthPct">, side: "left" | "right", pointerXPct: number): { positionX: number; widthPct: number } {
  const fixed = side === "right" ? start.positionX - start.widthPct / 2 : start.positionX + start.widthPct / 2;
  const reach = side === "right" ? pointerXPct - fixed : fixed - pointerXPct;
  const widthPct = clamp(round(reach, 0.1), TEXT_LAYER_WIDTH_PCT.min, TEXT_LAYER_WIDTH_PCT.max);
  const positionX = side === "right" ? fixed + widthPct / 2 : fixed - widthPct / 2;
  return { positionX: clamp(round(positionX, 0.01), 0, 100), widthPct };
}

/** Where the floating toolbar goes: under the frame, above it when there is no room below, always inside `bounds`. */
export function textToolbarPlacement(
  frame: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  toolbar: { readonly width: number; readonly height: number },
  bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  gap = 10,
): { left: number; top: number; placement: "below" | "above" } {
  const centre = (frame.left + frame.right) / 2;
  const left = clamp(centre - toolbar.width / 2, bounds.left, Math.max(bounds.left, bounds.right - toolbar.width));
  const below = frame.bottom + gap;
  if (below + toolbar.height <= bounds.bottom) return { left, top: below, placement: "below" };
  const above = frame.top - gap - toolbar.height;
  if (above >= bounds.top) return { left, top: above, placement: "above" };
  // No room either side: inside the bounds, as low as it fits.
  return { left, top: clamp(below, bounds.top, Math.max(bounds.top, bounds.bottom - toolbar.height)), placement: "below" };
}
