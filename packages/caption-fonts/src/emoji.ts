import atlas from "../emoji/atlas.json";

/**
 * Emoji artwork shared by the Studio preview and the export overlays.
 *
 * Both draw the same Noto Emoji raster from emoji/atlas.png, so an emoji looks
 * identical in the Studio and in the exported file and never depends on the
 * viewer's or the worker host's emoji font. This module is browser-safe: no
 * Node imports, only the atlas index.
 *
 * Lookup order for a grapheme cluster:
 *  1. the exact sequence (Noto names its files without U+FE0F, so the key
 *     drops it and a fully-qualified sequence matches directly);
 *  2. the same sequence with its emoji-presentation selector removed or added,
 *     which is semantically identical;
 *  3. nothing: the caller falls back to a monochrome glyph or fails. A ZWJ,
 *     skin-tone or flag cluster is never split into its parts here.
 */

export const CAPTION_EMOJI_ATLAS = atlas;

/** Noto's artwork cell is drawn for a 109 ppem font; the preset's emoji is 0.8em of font size. */
export const CAPTION_EMOJI_FONT_EM = 0.8;
/** Height of the emoji picture in caption em: the 0.8em glyph scaled to its artwork cell. */
export const CAPTION_EMOJI_HEIGHT_EM = (CAPTION_EMOJI_FONT_EM * atlas.cell.height) / 109;
export const CAPTION_EMOJI_WIDTH_EM = (CAPTION_EMOJI_HEIGHT_EM * atlas.cell.width) / atlas.cell.height;

export interface CaptionEmojiSprite {
  /** Atlas key (lower-case hex code points joined by `_`, without U+FE0F). */
  readonly key: string;
  readonly column: number;
  readonly row: number;
}

const VARIATION_SELECTOR_16 = 0xfe0f;
const VARIATION_SELECTOR_15 = 0xfe0e;
const sequences: Readonly<Record<string, { column: number; row: number }>> = atlas.sequences;

function codePointsOf(sequence: string): number[] {
  return [...sequence].map((character) => character.codePointAt(0)!);
}

/** The atlas key of a sequence: hex code points without U+FE0F. */
export function captionEmojiKey(sequence: string): string {
  return codePointsOf(sequence)
    .filter((codePoint) => codePoint !== VARIATION_SELECTOR_16)
    .map((codePoint) => codePoint.toString(16))
    .join("_");
}

/** Artwork for one emoji grapheme cluster, or null when the atlas has none. */
export function resolveCaptionEmoji(sequence: string): CaptionEmojiSprite | null {
  // A text-presentation request (U+FE0E) asks for the monochrome glyph, not this artwork.
  if (codePointsOf(sequence).includes(VARIATION_SELECTOR_15)) return null;
  const key = captionEmojiKey(sequence);
  const cell = sequences[key];
  return cell ? { key, column: cell.column, row: cell.row } : null;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** User-perceived characters: a ZWJ family, a flag or a skin-tone pair is one cluster. */
export function captionGraphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

const EMOJI_CLUSTER = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** True when a grapheme cluster is an emoji (including flags and keycaps). */
export function isCaptionEmojiCluster(cluster: string): boolean {
  return EMOJI_CLUSTER.test(cluster);
}

/** Where a sprite sits inside the atlas picture, as CSS background percentages. */
export function captionEmojiSpriteCss(sprite: CaptionEmojiSprite): {
  backgroundSize: string;
  backgroundPosition: string;
} {
  const { columns, rows } = atlas;
  return {
    backgroundSize: `${columns * 100}% ${rows * 100}%`,
    backgroundPosition: `${columns > 1 ? (sprite.column / (columns - 1)) * 100 : 0}% ${rows > 1 ? (sprite.row / (rows - 1)) * 100 : 0}%`,
  };
}
