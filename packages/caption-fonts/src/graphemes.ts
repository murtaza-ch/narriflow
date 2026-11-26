/**
 * Grapheme clusters for caption text. Browser-safe: the Studio, the plan and
 * the worker split and test text with the same two functions.
 */

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

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}|\uFE0F|\u20E3/u;

/** True when a cluster shows as a picture: a default-emoji character, a U+FE0F
 * request, a skin tone, flag or keycap. Text symbols such as ™ © ‼ ♥ are
 * pictographic but read as text, so they are not. */
export function isCaptionEmojiPresentation(cluster: string): boolean {
  return !cluster.includes("\uFE0E") && EMOJI_PRESENTATION.test(cluster);
}
