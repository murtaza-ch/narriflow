import type { FrameFaceOptions } from "./layout-engine";

/**
 * The durable Automatic plan can be produced from a Studio proxy before an
 * export worker probes the source. Proxy dimensions are not durable source
 * facts and can even be upscaled, so they must not change the saved crop.
 *
 * Original dimensions remain part of the evidence identity. Keep extra zoom
 * conservative for every source: a portrait crop already enlarges a landscape
 * source, and 1.1 limits additional softness on small originals.
 */
export const AUTOMATIC_LAYOUT_MAX_ZOOM = 1.1;

export function automaticLayoutFrameOptions(): Pick<FrameFaceOptions, "maxZoom"> {
  return { maxZoom: AUTOMATIC_LAYOUT_MAX_ZOOM };
}
