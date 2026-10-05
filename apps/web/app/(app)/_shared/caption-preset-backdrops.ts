import type { CaptionPresetId } from "@narriflow/validators";

type CatalogPresetId = Exclude<CaptionPresetId, "brand_default">;

/**
 * Talking-head frame each caption preset previews over, so a style is judged
 * on footage instead of a flat panel. Two presets share each frame; the
 * pairing follows the mood of the style.
 */
const BACKDROP_BY_PRESET: Record<CatalogPresetId, string> = {
  "bold-pop": "dark-studio",
  blast: "brick-street",
  punch: "green-studio",
  spotlight: "navy-podcast",
  street: "brick-street",
  electric: "blue-studio",
  rise: "office",
  focus: "bright-room",
  glass: "warm-podcast",
  sticker: "lamp-study",
  "frosted-glass": "office",
  highlighter: "navy-podcast",
  bubblegum: "pastel-room",
  jelly: "pastel-room",
  candy: "sunset-coast",
  retro: "sunset-coast",
  afterglow: "music-studio",
  cinema: "lamp-study",
  karaoke: "warm-podcast",
  neon: "music-studio",
  glitch: "green-studio",
  flip: "dark-studio",
  typewriter: "bright-room",
  block: "blue-studio",
};

export function captionPresetBackdropSrc(id: CatalogPresetId): string {
  return `/images/caption-backdrops/${BACKDROP_BY_PRESET[id]}.webp`;
}
