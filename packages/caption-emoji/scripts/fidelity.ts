/**
 * The pixel comparison behind `verify.ts` and the fidelity test: both images are rendered by
 * resvg at 4x and box-filtered to 128 px, because resvg's own stroker is coarse at small sizes
 * (at 1024 px the source and compiled strokes agree to about 0.003 grid units).
 */
import { Resvg } from "@resvg/resvg-js";
import type { CaptionEmojiArt } from "../src/art";
import { type CaptionEmojiPalette, resolveCaptionEmojiColour } from "../src/index";

/** A pixel is wrong when a premultiplied channel differs by more than this (of 255). */
export const PIXEL_TOLERANCE = 64;
/**
 * Largest share of a design's drawn pixels that may be wrong. Every design measures 0; a lost
 * hole, a missing cap or a misplaced part costs far more than 0.2% of a design's pixels.
 */
export const MAX_WRONG_SHARE = 0.002;
const SIZE = 128;

export function compiledSvg(art: CaptionEmojiArt, palette: CaptionEmojiPalette, tone = 0, size = SIZE): string {
  const paths = art.layers
    .map((layer) => {
      const colour = resolveCaptionEmojiColour(layer.colour, palette, tone);
      if (!colour) return "";
      return `<path d="${layer.d}" fill="${colour}"${layer.alpha === undefined ? "" : ` fill-opacity="${layer.alpha}"`}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">${paths}</svg>`;
}

/** Supersampling factor: resvg's own stroker is coarse at small sizes (see the ticket's Evidence). */
const SUPERSAMPLE = 4;

/** Premultiplied RGBA (0 to 255) at `size`, box-filtered from a render at 4x. */
export function render(svg: string, size = SIZE): Float32Array {
  const big = size * SUPERSAMPLE;
  const image = new Resvg(svg, { fitTo: { mode: "width", value: big }, font: { loadSystemFonts: false } }).render();
  if (image.width !== big || image.height !== big) throw new Error("unexpected render size");
  const px = image.pixels;
  const out = new Float32Array(size * size * 4);
  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const i = (y * big + x) * 4;
      const o = (Math.floor(y / SUPERSAMPLE) * size + Math.floor(x / SUPERSAMPLE)) * 4;
      const alpha = px[i + 3]! / 255;
      out[o] = out[o]! + px[i]! * alpha;
      out[o + 1] = out[o + 1]! + px[i + 1]! * alpha;
      out[o + 2] = out[o + 2]! + px[i + 2]! * alpha;
      out[o + 3] = out[o + 3]! + px[i + 3]!;
    }
  }
  for (let i = 0; i < out.length; i += 1) out[i] = out[i]! / (SUPERSAMPLE * SUPERSAMPLE);
  return out;
}

export interface Score {
  /** Largest premultiplied channel difference of any pixel (0 to 255). */
  maxError: number;
  wrongShare: number;
  wrong: number;
  meanError: number;
}

export function compare(a: Float32Array, b: Float32Array): Score {
  let wrong = 0;
  let drawn = 0;
  let total = 0;
  let maxError = 0;
  for (let i = 0; i < a.length; i += 4) {
    let worst = 0;
    for (let c = 0; c < 4; c += 1) worst = Math.max(worst, Math.abs(a[i + c]! - b[i + c]!));
    if (a[i + 3]! > 0.5 || b[i + 3]! > 0.5) drawn += 1;
    if (worst > PIXEL_TOLERANCE) wrong += 1;
    total += worst;
    maxError = Math.max(maxError, worst);
  }
  return { maxError, wrong, wrongShare: drawn === 0 ? 0 : wrong / drawn, meanError: total / (a.length / 4) };
}
