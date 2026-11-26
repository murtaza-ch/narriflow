/** Palette roles: `a` body, `b` accent rim, `c` detail, `ink` the fixed outline colour, `skin` the tone. */
export type CaptionEmojiRole = "a" | "b" | "c" | "ink" | "skin";

/**
 * A layer's colour. `tone` holds one colour per skin tone (index 0 to 5) for the face features the
 * pack redraws on dark tones; `null` there means the layer is not drawn at that tone.
 */
export type CaptionEmojiColour =
  | { readonly role: CaptionEmojiRole }
  | { readonly hex: string }
  | { readonly tone: readonly (string | null)[] };

export interface CaptionEmojiPalette {
  readonly a: string;
  readonly b: string;
  readonly c: string;
}

/** The pack's own colours (its "Bubblegum" palette). */
export const CAPTION_EMOJI_DEFAULT_PALETTE: CaptionEmojiPalette = { a: "#ffe45c", b: "#ff4f9a", c: "#ffffff" };

/** The fixed outline and feature colour. */
export const CAPTION_EMOJI_INK = "#271e35";

export interface CaptionEmojiSkinTone {
  /** 0 is the pack's default yellow; 1 to 5 are the Unicode Fitzpatrick tones, light to dark. */
  readonly tone: 0 | 1 | 2 | 3 | 4 | 5;
  readonly name: "default" | "light" | "medium-light" | "medium" | "medium-dark" | "dark";
  readonly hex: string;
  /** The Unicode skin-tone modifier, or null for the default. */
  readonly modifier: string | null;
}

export const CAPTION_EMOJI_SKIN_TONES: readonly CaptionEmojiSkinTone[] = [
  { tone: 0, name: "default", hex: "#ffc759", modifier: null },
  { tone: 1, name: "light", hex: "#ffdfc5", modifier: "\u{1F3FB}" },
  { tone: 2, name: "medium-light", hex: "#eac09d", modifier: "\u{1F3FC}" },
  { tone: 3, name: "medium", hex: "#c28c65", modifier: "\u{1F3FD}" },
  { tone: 4, name: "medium-dark", hex: "#996748", modifier: "\u{1F3FE}" },
  { tone: 5, name: "dark", hex: "#694738", modifier: "\u{1F3FF}" },
];

/**
 * The `#rrggbb` a layer paints with, or null when the layer is not drawn at this tone. A tone
 * outside 0 to 5 reads as 0.
 */
export function resolveCaptionEmojiColour(
  colour: CaptionEmojiColour,
  palette: CaptionEmojiPalette,
  tone = 0,
): string | null {
  const t = Number.isInteger(tone) && tone >= 0 && tone <= 5 ? tone : 0;
  if ("hex" in colour) return colour.hex;
  if ("tone" in colour) return colour.tone[t] ?? null;
  switch (colour.role) {
    case "a":
      return palette.a;
    case "b":
      return palette.b;
    case "c":
      return palette.c;
    case "ink":
      return CAPTION_EMOJI_INK;
    case "skin":
      return CAPTION_EMOJI_SKIN_TONES[t]!.hex;
  }
}
