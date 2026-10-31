import type { FrameFaceOptions } from "./layout-engine";

/**
 * The durable Automatic plan can be produced from a Studio proxy before an
 * export worker probes the source. Proxy dimensions are not durable source
 * facts and can even be upscaled, so they must not change the saved crop.
 *
 * Original dimensions remain part of the evidence identity. Let the existing
 * face-size calculation fill a speaker tile, while bounding enlargement.
 * A 1.1 ceiling left wide-shot faces at about 12% of each tile's height;
 * the 26% framing target needs roughly 2.4 zoom for those podcast shots.
 * Use one ceiling for preview and export so proxy size cannot change framing.
 */
export const AUTOMATIC_LAYOUT_MAX_ZOOM = 2.5;

export function automaticLayoutFrameOptions(): Pick<FrameFaceOptions, "maxZoom"> {
  return { maxZoom: AUTOMATIC_LAYOUT_MAX_ZOOM };
}
