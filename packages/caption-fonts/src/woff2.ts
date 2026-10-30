import { createRequire } from "node:module";

/**
 * WOFF2 to sfnt for HarfBuzz, which reads sfnt only (`wawoff2`, Google's woff2 decoder compiled to WASM).
 * libass keeps opening the uploaded file itself; this only gives the measuring side the same glyphs.
 * The module is imported by the worker alone (the web client takes `./locale-precedence` and `./emoji`).
 */
interface Woff2Binding {
  onRuntimeInitialized?: () => void;
  decompress?: (bytes: Uint8Array) => Uint8Array | false;
}

const binding = createRequire(import.meta.url)("wawoff2/build/decompress_binding.js") as Woff2Binding;
await new Promise<void>((resolve) => {
  binding.onRuntimeInitialized = resolve;
});

export const isWoff2 = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32;

/** The sfnt (TrueType or CFF) bytes inside a WOFF2 file; throws when the file is not a valid WOFF2. */
export function woff2ToSfnt(bytes: Uint8Array): Uint8Array {
  const sfnt = binding.decompress?.(bytes);
  if (!sfnt || sfnt.length === 0) throw new Error("WOFF2 could not be decompressed");
  return sfnt;
}
