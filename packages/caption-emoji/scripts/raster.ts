/**
 * Raster helpers for the outline: a mask of path data over `CAPTION_EMOJI_BOX`, and an exact
 * Euclidean distance transform of a mask.
 */
import { Resvg } from "@resvg/resvg-js";
import { CAPTION_EMOJI_BOX } from "../src/geometry";

/** The union of `paths` (each a non-zero fill) as a mask. */
export function mask(paths: readonly string[], size: number): Uint8Array {
  const { x, y, width, height } = CAPTION_EMOJI_BOX;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${size}" height="${size}">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
  const px = new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels;
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i += 1) out[i] = px[i * 4 + 3]! >= 128 ? 1 : 0;
  return out;
}

/** Squared distance (pixels) from each pixel to the nearest set pixel (Felzenszwalb and Huttenlocher). */
export function distanceSquared(set: Uint8Array, size: number): Float64Array {
  const INF = 1e12;
  const grid = new Float64Array(size * size);
  for (let i = 0; i < grid.length; i += 1) grid[i] = set[i] ? 0 : INF;
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const pass = (get: (i: number) => number, put: (i: number, value: number) => void) => {
    for (let i = 0; i < size; i += 1) f[i] = get(i);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < size; q += 1) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k -= 1;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < size; q += 1) {
      while (z[k + 1]! < q) k += 1;
      d[q] = (q - v[k]!) ** 2 + f[v[k]!]!;
    }
    for (let i = 0; i < size; i += 1) put(i, d[i]!);
  };
  for (let x = 0; x < size; x += 1) pass((i) => grid[i * size + x]!, (i, value) => (grid[i * size + x] = value));
  for (let y = 0; y < size; y += 1) pass((i) => grid[y * size + i]!, (i, value) => (grid[y * size + i] = value));
  return grid;
}

