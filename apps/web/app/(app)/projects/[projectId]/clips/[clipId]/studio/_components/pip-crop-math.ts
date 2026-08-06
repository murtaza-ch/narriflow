import type { ClipLayoutAnalysisPipRect } from "@narriflow/validators";

/**
 * Screen packet C (PiP persistence, preview true facecam crop): a normalized
 * 0..1 crop rect, all four fields expressed as a fraction of the SOURCE
 * frame's own width/height — the same normalization `pipRect` itself uses
 * (see `clip-layout-analysis.ts`'s doc comment). NOT re-normalized to the
 * tile box the crop is displayed in — see `split-secondary-tile.tsx`'s
 * `SplitSecondaryTileCropRect` for the pairing with the tile's own px
 * dimensions that turns this into concrete CSS.
 */
export interface NormalizedCropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mirrors the worker's `PIP_TILE_MARGIN_FRAC` (screen-layout.ts) exactly —
 *  the ~8% breathing-room margin applied to the detected rect before fitting
 *  it to the tile's aspect ratio. Two independent constants, not a shared
 *  import (this package has no dependency on apps/worker) — if the worker's
 *  value ever changes, this one must be updated to match by hand. */
const PIP_TILE_MARGIN_FRAC = 0.08;

/**
 * Client-side twin of the worker's `fitPipCropToTile`
 * (apps/worker/src/tasks/screen-layout.ts) — REPLICATES that function's
 * "grow the short axis around center to hit the tile's aspect ratio exactly,
 * then clamp/shrink-to-fit inside the source frame" math bit-for-bit, except
 * expressed entirely in NORMALIZED (0..1, fraction-of-source) coordinates
 * instead of source pixels, and returning a normalized result instead of a
 * pixel `{x,y,w,h}` — the caller (video-preview.tsx) only has the source's
 * pixel dimensions available via `videoWidth`/`videoHeight` once metadata
 * has loaded, and normalized output is what `split-secondary-tile.tsx`'s
 * explicit-size crop math wants directly (see its `videoDisplayW`/
 * `videoDisplayH` formula).
 *
 * `fitPipCropToTile` is the parity source of truth for this function's
 * math — the two are NOT unified behind a shared import (this package has
 * no dependency on apps/worker, and apps/worker's tasks are not published as
 * a library), so any future change to the worker's growth/clamp/shrink
 * order must be mirrored here by hand. `apps/worker/src/tasks/
 * screen-layout.test.ts`'s `fitPipCropToTile` fixtures are the nearest thing
 * to a cross-package regression guard if the two ever drift.
 *
 * Returns `null` for any degenerate input (a non-finite/non-positive
 * `probe` dimension, a non-finite/non-positive `tileRatio`, a `pipRect`
 * with zero/negative width or height, or a fitted result that rounds down
 * to zero px on either axis) — callers treat `null` exactly like "no
 * pipRect at all" and fall back to the existing static center-cover crop.
 */
export function fitPipCropToTileNormalized(
  pipRect: ClipLayoutAnalysisPipRect,
  tileRatio: number,
  probe: { width: number; height: number },
): NormalizedCropRect | null {
  if (!Number.isFinite(probe.width) || probe.width <= 0) return null;
  if (!Number.isFinite(probe.height) || probe.height <= 0) return null;
  if (!Number.isFinite(tileRatio) || tileRatio <= 0) return null;
  if (!Number.isFinite(pipRect.w) || pipRect.w <= 0) return null;
  if (!Number.isFinite(pipRect.h) || pipRect.h <= 0) return null;

  // Same order of operations as `fitPipCropToTile`: center first (from the
  // UNGROWN rect), then grow the margin, then grow the short axis to hit
  // tileRatio, then shrink-to-fit, then round + clamp.
  const cx = (pipRect.x + pipRect.w / 2) * probe.width;
  const cy = (pipRect.y + pipRect.h / 2) * probe.height;

  let w = pipRect.w * probe.width * (1 + 2 * PIP_TILE_MARGIN_FRAC);
  let h = pipRect.h * probe.height * (1 + 2 * PIP_TILE_MARGIN_FRAC);

  const currentRatio = w / h;
  if (currentRatio < tileRatio) {
    w = h * tileRatio;
  } else if (currentRatio > tileRatio) {
    h = w / tileRatio;
  }

  const shrink = Math.min(1, probe.width / w, probe.height / h);
  w *= shrink;
  h *= shrink;

  const roundedW = Math.round(w);
  const roundedH = Math.round(h);
  if (roundedW <= 0 || roundedH <= 0) return null;

  const x = Math.round(Math.max(0, Math.min(probe.width - roundedW, cx - roundedW / 2)));
  const y = Math.round(Math.max(0, Math.min(probe.height - roundedH, cy - roundedH / 2)));

  return {
    x: x / probe.width,
    y: y / probe.height,
    w: roundedW / probe.width,
    h: roundedH / probe.height,
  };
}

/** H1 (adversarial review): mirrors the worker's `PIP_MIN_CROP_WIDTH_FRAC`
 *  (screen-layout.ts) exactly — the minimum fraction of the render OUTPUT
 *  tile's own width a fitted crop must reach before `decidePipUsage`'s
 *  `pip_too_small` gate (render-clips.ts) still prefers it over the
 *  face-tracked/static-center band fallback. Two independently-maintained
 *  constants for the same "no cross-package import" reason
 *  `fitPipCropToTileNormalized`'s own doc comment gives for
 *  `PIP_TILE_MARGIN_FRAC` — if the worker's value ever changes, this one
 *  must be updated to match by hand. */
const PIP_MIN_CROP_WIDTH_FRAC = 0.4;

/**
 * Client-side analogue of the worker's `pipCropTooSmall` (screen-layout.ts,
 * M3) — `decidePipUsage`'s per-output `pip_too_small` gate has no preview
 * equivalent today, so a detected rect that the render pipeline would
 * reject as "too small to be worth it" could otherwise still show up in the
 * preview's bottom tile. Compares the fitted crop's SOURCE-PIXEL width
 * (`fittedNormalizedWidth * sourceWidthPx` — NOT the tile's on-screen CSS
 * pixel width, which has no relationship to the render's own output
 * resolution) against the RENDER OUTPUT tile's own width in px
 * (`outputTileWidthPx` — the clip's target aspect ratio's own width, e.g.
 * 1080 for 9:16, matching `screenTileGeometry`'s `tileWidth` exactly, NOT
 * the preview container's rendered size).
 */
export function pipCropTooSmallNormalized(
  fittedNormalizedWidth: number,
  sourceWidthPx: number,
  outputTileWidthPx: number,
): boolean {
  const fittedWidthPx = fittedNormalizedWidth * sourceWidthPx;
  return fittedWidthPx < PIP_MIN_CROP_WIDTH_FRAC * outputTileWidthPx;
}
