import { CAPTION_COVERED_RANGES } from "./glyph-coverage-data";

/**
 * Which caption characters the burn-in can draw, answerable in the browser.
 * The export planner (apps/worker/src/caption-glyphs.ts) walks the pinned
 * fallback chain with fontkit; this table is that chain's code point union,
 * so the Studio can warn before an export leaves a character out.
 */

/** Code points that draw nothing and ride with the glyph before them. */
const IGNORABLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xe0020, 0xe007f],
];

const inRanges = (ranges: readonly (readonly [number, number])[], codePoint: number): boolean => {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [from, to] = ranges[middle]!;
    if (codePoint < from) high = middle - 1;
    else if (codePoint > to) low = middle + 1;
    else return true;
  }
  return false;
};

/** `U+1F1FA`: the label shown for a code point that cannot be drawn. */
export function captionCodePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Code points of `text` that no pinned face draws, as `U+XXXX` labels in order
 * of first appearance. Control characters are line structure, not glyphs.
 */
export function captionUndrawableCodePoints(text: string): string[] {
  const found = new Set<string>();
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    if (inRanges(IGNORABLE_RANGES, codePoint) || inRanges(CAPTION_COVERED_RANGES, codePoint)) continue;
    found.add(captionCodePointLabel(codePoint));
  }
  return [...found];
}
