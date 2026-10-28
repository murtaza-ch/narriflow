import { matchCaptionPreset, type CaptionPreset, type CaptionPresetId } from "@narriflow/validators";

type CatalogPresetId = Exclude<CaptionPresetId, "brand_default">;

/** Talking-head frames under `public/images/caption-backdrops`. */
export const CAPTION_BACKDROPS = [
  "dark-studio",
  "bright-room",
  "navy-podcast",
  "brick-street",
  "warm-podcast",
  "pastel-room",
  "office",
  "music-studio",
  "green-studio",
  "blue-studio",
  "lamp-study",
  "sunset-coast",
] as const;
export type CaptionBackdrop = (typeof CAPTION_BACKDROPS)[number];

/**
 * Talking-head frame each caption preset previews over, so a style is judged
 * on footage instead of a flat panel. Two presets share each frame; the
 * pairing follows the mood of the style.
 */
const BACKDROP_BY_PRESET: Record<CatalogPresetId, CaptionBackdrop> = {
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

export function captionBackdropSrc(backdrop: CaptionBackdrop): string {
  return `/images/caption-backdrops/${backdrop}.webp`;
}

export function captionPresetBackdropSrc(id: CatalogPresetId): string {
  return captionBackdropSrc(BACKDROP_BY_PRESET[id]);
}

/** A saved style previews over its catalog look's frame, else a frame picked from `seed` so a library varies. */
export function captionStyleBackdrop(preset: CaptionPreset, seed: string): CaptionBackdrop {
  const named = matchCaptionPreset(preset);
  if (named) return BACKDROP_BY_PRESET[named.id as CatalogPresetId];
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return CAPTION_BACKDROPS[Math.abs(hash) % CAPTION_BACKDROPS.length]!;
}
