/**
 * The caption emoji index: every design's id, name, glyph, group and search words. Small and
 * dependency-free so the Worker can import it; the art lives in `@narriflow/caption-emoji/art`.
 */
import { INDEX_JSON } from "./generated/index-data";

export {
  CAPTION_EMOJI_DEFAULT_PALETTE,
  CAPTION_EMOJI_INK,
  CAPTION_EMOJI_SKIN_TONES,
  type CaptionEmojiColour,
  type CaptionEmojiPalette,
  type CaptionEmojiRole,
  type CaptionEmojiSkinTone,
  resolveCaptionEmojiColour,
} from "./colour";
export { CAPTION_EMOJI_BOX, CAPTION_EMOJI_GRID, CAPTION_EMOJI_OUTLINE_GRID } from "./geometry";

export interface CaptionEmojiGroup {
  readonly id: string;
  readonly name: string;
}

export interface CaptionEmojiEntry {
  /** Stable kebab slug of the name, e.g. `money-bag`. */
  readonly id: string;
  readonly name: string;
  /** The Unicode emoji (two for a phrase badge), for the AI, search and alt text. */
  readonly glyph: string;
  /** A `CaptionEmojiGroup` id. */
  readonly group: string;
  /** Lowercase search words from the name, keywords and caption. */
  readonly keywords: readonly string[];
  /** True for the designs drawn in the six skin tones. */
  readonly hasTones: boolean;
  /** `phrase` is a badge: a main emoji with a second one in a disc. */
  readonly kind: "single" | "phrase";
}

const data = JSON.parse(INDEX_JSON) as {
  groups: [string, string][];
  rows: [string, string, string, string, string, number][];
};

export const CAPTION_EMOJI_GROUPS: readonly CaptionEmojiGroup[] = Object.freeze(
  data.groups.map(([id, name]) => Object.freeze({ id, name })),
);

export const CAPTION_EMOJI_INDEX: readonly CaptionEmojiEntry[] = Object.freeze(
  data.rows.map(([id, name, glyph, group, keywords, flags]) =>
    Object.freeze({
      id,
      name,
      glyph,
      group,
      keywords: Object.freeze(keywords === "" ? [] : keywords.split(" ")),
      hasTones: (flags & 1) !== 0,
      kind: flags & 2 ? ("phrase" as const) : ("single" as const),
    }),
  ),
);

const byId = new Map(CAPTION_EMOJI_INDEX.map((entry) => [entry.id, entry]));

/** Every emoji the pack has, each skin tone of a design with skin counted once: the designs plus five tones of each toned design. */
export const CAPTION_EMOJI_COUNT = CAPTION_EMOJI_INDEX.length + 5 * CAPTION_EMOJI_INDEX.filter((entry) => entry.hasTones).length;

export function captionEmojiById(id: string): CaptionEmojiEntry | undefined {
  return byId.get(id);
}

/** A stored emoji: a catalog id and, for designs with tones, the skin tone (1 to 5; absent is the default yellow). */
export interface CaptionEmojiRef {
  readonly id: string;
  readonly tone?: 1 | 2 | 3 | 4 | 5;
}

/** Drops presentation selectors (U+FE0F) and skin-tone modifiers. */
function glyphKey(glyph: string): string {
  return glyph.trim().replace(/[\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, "");
}

// Every design by its glyph: one emoji for a single design, the pair of a phrase badge (no badge's
// pair is a single design's glyph; tested).
const byGlyph = new Map<string, string>();
for (const entry of CAPTION_EMOJI_INDEX) byGlyph.set(glyphKey(entry.glyph), entry.id);

/** The single designs' glyphs in catalog order: the emojis the AI picks from. */
export const CAPTION_EMOJI_AI_GLYPHS: readonly string[] = Object.freeze(
  CAPTION_EMOJI_INDEX.filter((entry) => entry.kind === "single").map((entry) => entry.glyph),
);

/** The phrase badges the AI picks from, in catalog order: the badge's two-emoji glyph and its name, which says the moment it shows. */
export const CAPTION_EMOJI_AI_BADGES: readonly { readonly glyph: string; readonly name: string }[] = Object.freeze(
  CAPTION_EMOJI_INDEX.filter((entry) => entry.kind === "phrase").map((entry) => Object.freeze({ glyph: entry.glyph, name: entry.name })),
);

const GENDER_SIGN = /\u200D[\u2640\u2642]/gu;
const GENDERED_PERSON = /^[\u{1F468}\u{1F469}]/u;
const SKIN_MODIFIER = /[\u{1F3FB}-\u{1F3FF}]/u;

/**
 * The design for a Unicode emoji, or null when Narriflow has none (never drawn with a system
 * font). A phrase badge is found by its two emojis in order. U+FE0F is ignored. A skin-tone
 * modifier becomes `tone` when the design has tones and is ignored when it does not. A gendered
 * sequence without its own design falls back to the neutral one (`🏃‍♂️` to Person running, `👨‍🚀` to
 * Astronaut when Man astronaut is missing).
 */
export function emojiRefForGlyph(glyph: string): CaptionEmojiRef | null {
  const key = glyphKey(glyph);
  if (key === "") return null;
  const candidates = [key, key.replace(GENDER_SIGN, ""), key.replace(GENDERED_PERSON, "\u{1F9D1}")];
  candidates.push(candidates[1]!.replace(GENDERED_PERSON, "\u{1F9D1}"));
  const id = candidates.map((candidate) => byGlyph.get(candidate)).find((found) => found !== undefined);
  if (!id) return null;
  const modifier = SKIN_MODIFIER.exec(glyph)?.[0];
  const tone = modifier ? (modifier.codePointAt(0)! - 0x1f3fa) as 1 | 2 | 3 | 4 | 5 : undefined;
  return tone !== undefined && byId.get(id)!.hasTones ? { id, tone } : { id };
}
