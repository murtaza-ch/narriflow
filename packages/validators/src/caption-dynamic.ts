import type { CaptionWordRole } from "./caption-emphasis";
import type { CaptionFontName } from "./caption-font";
import type { CaptionPreset } from "./caption-preset";
import { CAPTION_MOTIONS, type CaptionAnimationName, type CaptionMotionSpec } from "./caption-style";

// Dynamic Styles: caption looks where one word of a cue (the hero) is large
// and the cue is laid out as a Caption Block of one to three rows. A style is
// data. Shared geometry (`@narriflow/caption-fonts/caption-block`) places every
// word from it, and each renderer only measures and paints (ADR 0020).

/** Which of the preset's colours a role is drawn in. */
export type CaptionColourSlot = "primary" | "highlight" | "accent";

/** How one Caption Role is typeset in a style. */
export interface CaptionRoleType {
  /** "text": the preset's `fontName`/`fontAsset`. "hero": `heroFontName`, else the style's. */
  readonly font: "text" | "hero";
  /** Size as a multiple of the body size S (`fontSize`). Hero fill replaces it when the style sets one. */
  readonly sizeEm: number;
  /** "inherit" is the preset's `textTransform`. */
  readonly transform: "inherit" | "uppercase" | "lowercase" | "capitalize" | "none";
  /** Em. "inherit" is the preset's `letterSpacing`. */
  readonly letterSpacing: number | "inherit";
  readonly colour: CaptionColourSlot;
}

export interface CaptionDynamicStyle {
  /** Display name. */
  readonly name: string;
  /** "stack": lead row, hero row, tail row. "row": one row. */
  readonly layout: "stack" | "row";
  readonly align: "center" | "left";
  readonly roles: Readonly<Record<CaptionWordRole, CaptionRoleType>>;
  /** Size (multiple of S) of every non-minor word in a cue that has no hero. */
  readonly noHeroSizeEm: number;
  readonly heroFontName: CaptionFontName;
  /** Hero colour alternates between these by the block seed. One entry = no alternation. */
  readonly heroColours: readonly CaptionColourSlot[];
  /** Scale the hero row to this fraction of the frame width, hero size clamped to `[minEm, maxEm] × S`. */
  readonly heroFill?: { readonly widthFraction: number; readonly minEm: number; readonly maxEm: number };
  /** Ink-to-ink gap between rows, multiple of S. May be negative. */
  readonly rowGapEm: number;
  /** Sideways shift of lead and tail rows, multiple of S. */
  readonly staggerEm: number;
  /** Default `positionX` of a left-aligned style: the block's left edge, percent of frame width. */
  readonly leftGuidePct?: number;
  /** The motion used when the preset's `animation` cannot drive a block (see `captionBlockAnimation`). */
  readonly defaultMotion: CaptionAnimationName;
  /** `accentColor` when the preset has none. */
  readonly accentColor?: string;
  /**
   * The soft shadow when the preset's `shadow` is "soft", in em of each word's own size, so it scales
   * with the word. Absent = `CAPTION_SOFT_SHADOW`. `blurEm` is the Gaussian standard deviation.
   */
  readonly softShadow?: { readonly offsetYEm: number; readonly blurEm: number; readonly opacity: number };
  readonly tile?: {
    readonly fill: Readonly<Record<CaptionWordRole, CaptionColourSlot | string>>;
    readonly tiltsDeg: readonly number[];
    readonly radiusEm: number;
    readonly padXEm: number;
    readonly padYEm: number;
  };
  /** Phase 2 only. */
  readonly gradient?: { readonly top: string; readonly bottom: string };
  readonly decorations?: readonly ("underline" | "stars")[];
}

const textRole = (sizeEm: number): CaptionRoleType => ({
  font: "text",
  sizeEm,
  transform: "inherit",
  letterSpacing: "inherit",
  colour: "primary",
});

/**
 * The Dynamic Style catalog (spec section 6). Values are starting points for
 * visual review; renderers read them, never copy them.
 */
export const CAPTION_DYNAMIC_STYLES = {
  /** Reference 01: small support rows around a huge hero filling 80% of the width. */
  headline: {
    name: "Headline",
    layout: "stack",
    align: "center",
    roles: {
      // Minor words at body size: mixed minor and body sizes in one row looked uneven (ticket 02).
      minor: textRole(1),
      body: textRole(1),
      hero: { font: "hero", sizeEm: 2.2, transform: "none", letterSpacing: -0.03, colour: "highlight" },
    },
    noHeroSizeEm: 1.2,
    heroFontName: "Inter",
    heroColours: ["highlight"],
    heroFill: { widthFraction: 0.8, minEm: 2.2, maxEm: 3.4 },
    rowGapEm: 0.06,
    staggerEm: 0,
    defaultMotion: "slide",
    // Black 65%, CSS 6 px blur (sigma 3 px), 2 px down at S = 80.
    softShadow: { offsetYEm: 0.025, blurEm: 0.0375, opacity: 0.65 },
  },
} as const satisfies Record<string, CaptionDynamicStyle>;

export type CaptionDynamicName = keyof typeof CAPTION_DYNAMIC_STYLES;

export const CAPTION_DYNAMIC_NAMES = Object.keys(CAPTION_DYNAMIC_STYLES) as [CaptionDynamicName, ...CaptionDynamicName[]];

export function captionDynamicStyle(name: CaptionDynamicName): CaptionDynamicStyle {
  return CAPTION_DYNAMIC_STYLES[name];
}

/** Block layout constants shared by every Dynamic Style. */
export const CAPTION_BLOCK = {
  /** Gap between adjacent words of a row, multiple of the larger word's size (Inter SemiBold's space). */
  wordGapEm: 0.232,
  /** The block, its decorations and its entrance travel stay inside these fractions of the frame. */
  safeArea: { left: 0.06, right: 0.94, top: 0.1, bottom: 0.82 },
  /** `wordsPerCue` of a dynamic preset is clamped to this range. */
  minWordsPerCue: 2,
  maxWordsPerCue: 5,
} as const;

/** A cue laid out as one to three rows (Caption Block). Lives on a caption layer as `block`. */
export interface CaptionBlock {
  readonly style: CaptionDynamicName;
  /** Parallel to the layer's `words`. */
  readonly roles: readonly CaptionWordRole[];
  /** Display text per word after the role's case transform. Subtitles keep `words[].text`. */
  readonly texts: readonly string[];
  /** Word Keys; null for dub captions. */
  readonly keys: readonly (string | null)[];
  /** Row entries index `words`, in spoken order. */
  readonly rows: readonly (readonly number[])[];
  /** Stable per-cue seed: FNV-1a of the first word's key, else of the cue index. */
  readonly seed: number;
}

/**
 * Rows of a Caption Block, without measurement. "stack" puts the hero alone
 * on its row, the words before it on a lead row and the words after it on a
 * tail row, dropping empty rows. "row" and a cue with no hero are one row.
 */
export function captionBlockRows(
  roles: readonly CaptionWordRole[],
  heroSpan: readonly [number, number] | null,
  style: Pick<CaptionDynamicStyle, "layout">,
): number[][] {
  const all = roles.map((_, index) => index);
  if (all.length === 0) return [];
  if (style.layout === "row" || heroSpan === null) return [all];
  const [first, last] = heroSpan;
  return [all.slice(0, first), all.slice(first, last + 1), all.slice(last + 1)].filter((row) => row.length > 0);
}

/** 32-bit FNV-1a over UTF-16 code units. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The block seed: the first word's Word Key, so cuts elsewhere never reshuffle a cue's look. */
export function captionBlockSeed(firstKey: string | null, cueIndex: number): number {
  return fnv1a32(firstKey ?? String(cueIndex));
}

/** Motions that last longer than most cue windows. */
const CAPTION_BLOCK_EXCLUDED_MOTIONS: ReadonlySet<CaptionAnimationName> = new Set(["jelly"]);

/**
 * The motion a Caption Block enters with: the preset's `animation` when it is
 * a word-reveal motion without a renderer effect, else the style's default.
 */
export function captionBlockAnimation(preset: Pick<CaptionPreset, "animation">, style: CaptionDynamicStyle): CaptionAnimationName {
  const motion: CaptionMotionSpec = CAPTION_MOTIONS[preset.animation];
  const usable = motion.reveal === "word" && motion.effect === undefined && !CAPTION_BLOCK_EXCLUDED_MOTIONS.has(preset.animation);
  return usable ? preset.animation : style.defaultMotion;
}

/**
 * Motions only a Caption Block can draw (spec 5.7, "Motion pickers"): they
 * travel sideways (`offsetXEm`), turn (`rotateZDeg`) or give the hero its own
 * track.
 */
export function isDynamicOnlyMotion(motion: CaptionMotionSpec): boolean {
  const frames = [...motion.word, ...(motion.hero ?? [])];
  return motion.hero !== undefined || frames.some((frame) => frame.offsetXEm !== undefined || frame.rotateZDeg !== undefined);
}

/** The motion a classic (single-line) preset draws: a dynamic-only motion renders as `fade` in both painters. */
export function captionClassicAnimation(preset: Pick<CaptionPreset, "animation">): CaptionAnimationName {
  return isDynamicOnlyMotion(CAPTION_MOTIONS[preset.animation]) ? "fade" : preset.animation;
}

/** `wordsPerCue` of a dynamic preset, clamped to 2..5. */
export function captionBlockWordsPerCue(wordsPerCue: number): number {
  return Math.min(CAPTION_BLOCK.maxWordsPerCue, Math.max(CAPTION_BLOCK.minWordsPerCue, wordsPerCue));
}

/** A Caption Role's resolved type for one cue: which font slot, face, case, spacing and colour. */
export interface CaptionRoleLook {
  readonly font: "text" | "hero";
  /** The built-in face. For the text slot the preset's `fontAsset` wins when it is loaded. */
  readonly fontName: CaptionFontName;
  readonly transform: CaptionPreset["textTransform"];
  readonly letterSpacing: number;
  readonly color: string;
}

function slotColour(slot: CaptionColourSlot | string, preset: CaptionPreset, style: CaptionDynamicStyle): string {
  switch (slot) {
    case "primary":
      return preset.primaryColor;
    case "highlight":
      return preset.highlightColor;
    case "accent":
      return preset.accentColor ?? style.accentColor ?? preset.highlightColor;
    default:
      return slot;
  }
}

/**
 * How a word of `role` is drawn in a cue with `seed`. Text-slot roles take
 * `textTransform` and `letterSpacing` from the preset when the style says
 * "inherit"; hero-slot roles take both from the style (spec 5.2).
 */
export function captionRoleLook(
  preset: CaptionPreset,
  style: CaptionDynamicStyle,
  role: CaptionWordRole,
  seed: number,
): CaptionRoleLook {
  const type = style.roles[role];
  const hero = type.font === "hero";
  const colourSlot = role === "hero" && style.heroColours.length > 0
    ? style.heroColours[seed % style.heroColours.length]!
    : type.colour;
  return {
    font: type.font,
    fontName: hero ? preset.heroFontName ?? style.heroFontName : preset.fontName,
    transform: type.transform === "inherit" ? preset.textTransform : type.transform,
    letterSpacing: type.letterSpacing === "inherit" ? preset.letterSpacing : type.letterSpacing,
    color: slotColour(colourSlot, preset, style),
  };
}
