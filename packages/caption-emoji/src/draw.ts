/**
 * What a painter needs to draw art it already holds: the grid, the path parser and the colour
 * roles. No catalog data, so a renderer's initial chunk can import it; the art itself comes from
 * `@narriflow/caption-emoji/art`.
 */
export {
  CAPTION_EMOJI_INK,
  CAPTION_EMOJI_SKIN_TONES,
  type CaptionEmojiColour,
  type CaptionEmojiPalette,
  type CaptionEmojiRole,
  resolveCaptionEmojiColour,
} from "./colour";
export { CAPTION_EMOJI_BOX, CAPTION_EMOJI_GRID, CAPTION_EMOJI_OUTLINE_GRID } from "./geometry";
export { type CaptionEmojiPathCmd, parseCaptionEmojiPath } from "./path";
