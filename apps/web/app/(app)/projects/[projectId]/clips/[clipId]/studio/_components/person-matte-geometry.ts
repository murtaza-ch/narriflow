import type { CaptionCanvasMatte } from "@narriflow/caption-fonts/caption-block";

// Pure geometry for the Studio's person matte (dynamic captions spec 5.12). The segmenter sees the
// main source layer's visible crop; placement reads the matte in canvas space, mapped through the
// plan's crop → destination, the same geometry the render's matte pass uses.

/**
 * The tasks-vision WASM (14.6 MB, fetched once, only when a behind hero first shows), at the exact
 * version the app installs (a test keeps them equal). The package's exports do not expose the WASM
 * files for the bundler to emit, so they come from jsDelivr's immutable versioned path.
 */
export const MEDIAPIPE_TASKS_VISION_VERSION = "1.2.2";
export const MEDIAPIPE_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}/wasm`;

export interface MatteRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One segmenter result: confidence 0 to 255 over `region` of the source frame, source px. */
export interface RegionMatte {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
  readonly region: MatteRect;
}

/** The source rectangle the segmenter reads, in the preview video's own pixels. */
export function videoRegion(region: MatteRect, source: { readonly width: number; readonly height: number }, video: { readonly width: number; readonly height: number }): MatteRect {
  const kx = video.width / source.width;
  const ky = video.height / source.height;
  const x = Math.max(0, Math.min(video.width - 1, Math.round(region.x * kx)));
  const y = Math.max(0, Math.min(video.height - 1, Math.round(region.y * ky)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(video.width - x, Math.round(region.width * kx))),
    height: Math.max(1, Math.min(video.height - y, Math.round(region.height * ky))),
  };
}

/**
 * The matte in canvas space at `1 / downscale` of the canvas: each pixel's canvas point is taken
 * back through the layer's `destination` to its `crop` (source px) and read from the segmenter's
 * region (nearest). Zero outside the destination and outside the region.
 */
export function canvasMatteFromRegionMask(input: {
  readonly matte: RegionMatte;
  readonly crop: MatteRect;
  readonly destination: MatteRect;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly downscale?: number;
}): CaptionCanvasMatte {
  const { matte, crop, destination, canvas } = input;
  const downscale = input.downscale ?? 4;
  const width = Math.max(1, Math.round(canvas.width / downscale));
  const height = Math.max(1, Math.round(canvas.height / downscale));
  const data = new Uint8Array(width * height);
  const { region } = matte;
  for (let row = 0; row < height; row++) {
    const canvasY = ((row + 0.5) * canvas.height) / height;
    if (canvasY < destination.y || canvasY >= destination.y + destination.height) continue;
    const sourceY = crop.y + ((canvasY - destination.y) * crop.height) / destination.height;
    const my = Math.floor(((sourceY - region.y) / region.height) * matte.height);
    if (my < 0 || my >= matte.height) continue;
    for (let column = 0; column < width; column++) {
      const canvasX = ((column + 0.5) * canvas.width) / width;
      if (canvasX < destination.x || canvasX >= destination.x + destination.width) continue;
      const sourceX = crop.x + ((canvasX - destination.x) * crop.width) / destination.width;
      const mx = Math.floor(((sourceX - region.x) / region.width) * matte.width);
      if (mx < 0 || mx >= matte.width) continue;
      data[row * width + column] = matte.data[my * matte.width + mx]!;
    }
  }
  return { width, height, data };
}
