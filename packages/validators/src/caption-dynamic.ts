import { CAPTION_DECORATION } from "./caption-decoration";
import type { CaptionWordRole } from "./caption-emphasis";
import type { CaptionFontName } from "./caption-font";
import type { CaptionPreset } from "./caption-preset";
import { CAPTION_MOTIONS, captionEntranceKeyframes, type CaptionAnimationName, type CaptionMotionSpec } from "./caption-style";

// Dynamic Styles: caption looks where one word of a cue (the hero) is large
// and the cue is laid out as a Caption Block of one to three rows. A style is
// data. Shared geometry (`@narriflow/caption-fonts/caption-block`) places every
// word from it, and each renderer only measures and paints (ADR 0020).

/** Which of the preset's colours a role is drawn in. */
export type CaptionColourSlot = "primary" | "highlight" | "accent";

/** One layer of a style's soft shadow, in em of the word's size; `blurEm` is the Gaussian standard deviation. */
export interface CaptionSoftShadowLayer {
  readonly offsetYEm: number;
  readonly blurEm: number;
  readonly opacity: number;
}

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
  /** A slot follows the user's colours; a literal hex string is a style constant (Cutout's ink on pink tiles). */
  readonly colour: CaptionColourSlot | string;
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
  /** "never": the style draws no hero (tile styles), so the scorer runs with `policy: "never"`. Absent = "auto". */
  readonly emphasis?: "never";
  /**
   * Scale the hero row to this fraction of the frame width, hero size clamped to `[minEm, maxEm] × S`.
   * A hero in all caps (every cased letter upper, at least one) clamps at `maxEmCaps` instead: caps
   * have no x-height, so at the same size they read larger than mixed case.
   */
  readonly heroFill?: { readonly widthFraction: number; readonly minEm: number; readonly maxEm: number; readonly maxEmCaps?: number };
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
   * The soft shadow when the preset's `shadow` is "soft": one or more layers, drawn in order (the
   * first lowest), in em of each word's own size, so it scales with the word. Absent =
   * `CAPTION_SOFT_SHADOW`. `blurEm` is the Gaussian standard deviation.
   */
  readonly softShadow?: readonly CaptionSoftShadowLayer[];
  /**
   * One rounded rectangle behind each word, sharing the word's pivot and entrance. Lengths are
   * em of the word's own size. The tile spans the word's advance plus `padXEm` on each side and
   * its row's ink plus `padYEm`, so tiles of one row share a height. `gapEm` is the visible gap
   * between neighbouring tiles; it replaces `CAPTION_BLOCK.wordGapEm`.
   */
  readonly tile?: {
    /** Tile fill of every word but the short ones; their ink is their role's colour. */
    readonly fill: CaptionColourSlot | string;
    /**
     * Words of at most `maxLetters` letters and digits (`captionTileWordLength`) take this tile
     * fill and ink instead, whatever their role (Cutout's pink tiles).
     */
    readonly short?: { readonly maxLetters: number; readonly fill: CaptionColourSlot | string; readonly ink: CaptionColourSlot | string };
    readonly tiltsDeg: readonly number[];
    readonly radiusEm: number;
    readonly padXEm: number;
    readonly padYEm: number;
    readonly gapEm: number;
    /** Hard shadow of the tile in the preset's `shadowColor`, offset this far right and down. 0 = none. */
    readonly shadowEm: number;
  };
  /**
   * Vertical gradient over the hero's rest ink box, top colour to bottom colour (spec 5.10).
   * Literal colours: style constants. Drawn only while the hero colour is the style's own
   * (`bottom`) and the hero's motion neither scales nor turns it (`captionHeroGradient`).
   */
  readonly gradient?: { readonly top: string; readonly bottom: string };
  /** Drawn details placed by the shared geometry (`CAPTION_DECORATION`, spec 5.10). */
  readonly decorations?: readonly CaptionDecorationKind[];
}

/** Marker's hand-drawn underline under the hero, Stack's stars at the block's corners. */
export type CaptionDecorationKind = "underline" | "stars";

const textRole = (sizeEm: number, colour: CaptionColourSlot | string = "primary"): CaptionRoleType => ({
  font: "text",
  sizeEm,
  transform: "inherit",
  letterSpacing: "inherit",
  colour,
});

/*
 * Soft shadows of the styles drawn without an outline (spec section 6 rule 5). Each is the weakest
 * shadow tried that gives every white support word of the style's fixture cases at least 3:1
 * contrast (WCAG AA for large text) against the mean luminance of a ring 1 px to 0.075 em around
 * its ink, on the bright fixture frame (ticket 05 comments). Lengths are em of each word's size.
 */
/** Headline (S = 80): black 85%, CSS blur 12 px (sigma 6 px), 2.4 px down. */
const HEADLINE_SOFT_SHADOW: readonly CaptionSoftShadowLayer[] = [{ offsetYEm: 0.03, blurEm: 0.075, opacity: 0.85 }];
/**
 * Small support sizes (40 to 60 px) need a tight edge as well as a wide halo: a wide layer (black
 * 80%, sigma 0.12 em, 0.04 em down) under a tight one (black 80%, sigma 0.04 em, 0.01 em down).
 */
const SMALL_TEXT_SOFT_SHADOW: readonly CaptionSoftShadowLayer[] = [
  { offsetYEm: 0.04, blurEm: 0.12, opacity: 0.8 },
  { offsetYEm: 0.01, blurEm: 0.04, opacity: 0.8 },
];

/**
 * Marker (S = 52, Inter SemiBold since ticket 06b): both layers at 100%, the tight one 0.05 em.
 * Inter SemiBold's strokes are thinner than the Poppins ExtraBold it replaced; on the bright
 * fixture frame "in" over the white table read 2.44:1 with the small-text pair, 2.84 with it at
 * 100%, and 3.05 with this, the weakest tried that reaches 3:1 (ticket 06b).
 */
const MARKER_SOFT_SHADOW: readonly CaptionSoftShadowLayer[] = [
  { offsetYEm: 0.04, blurEm: 0.12, opacity: 1 },
  { offsetYEm: 0.01, blurEm: 0.05, opacity: 1 },
];

/**
 * Groove (S = 64 when chosen; ticket 06b raised it to 80): the small-text layers at 90%. Serif caps have hairline strokes; on the bright
 * fixture frame the catalog's single "4 px soft shadow" (black 85%, sigma 2 px) left "W/" at 2.07:1
 * and the 80% small-text pair at 2.86:1; this is the weakest tried that reaches 3:1 (ticket 06).
 */
const GROOVE_SOFT_SHADOW: readonly CaptionSoftShadowLayer[] = [
  { offsetYEm: 0.04, blurEm: 0.12, opacity: 0.9 },
  { offsetYEm: 0.01, blurEm: 0.04, opacity: 0.9 },
];

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
    // Ticket 06b: an all-caps hero caps at 3.0 S, so "AI" or "NASA" does not tower over the rows.
    heroFill: { widthFraction: 0.8, minEm: 2.2, maxEm: 3.4, maxEmCaps: 3 },
    // Ticket 06b: 0.06 → 0.04, the rows sit tighter on the hero as in reference 01.
    rowGapEm: 0.04,
    staggerEm: 0,
    defaultMotion: "slide",
    softShadow: HEADLINE_SOFT_SHADOW,
    // Reference 01: light mint at the top of the hero to the hero green at the bottom.
    gradient: { top: "#A5EBC5", bottom: "#36B780" },
  },
  /**
   * Reference 06, foreground type only (an adaptation): small white sans minor words, cream
   * serif body words and a large lowercase serif hero, with rows offset left and right. Body
   * words sit on the hero font slot, so the text slot (`fontName`) is the minor words' sans.
   */
  editorial: {
    name: "Editorial",
    layout: "stack",
    align: "center",
    roles: {
      // Ticket 06b: 52 px white at S = 68 (was 44 px cream), closer to reference 06's "with".
      minor: textRole(52 / 68, "#FFFFFF"),
      body: { font: "hero", sizeEm: 1, transform: "lowercase", letterSpacing: 0, colour: "primary" },
      // 2.2 S (149.6 px): the body grew to 68 px, and 144 px would put the hero under rule 1's 2.2 times the body.
      hero: { font: "hero", sizeEm: 2.2, transform: "lowercase", letterSpacing: 0, colour: "highlight" },
    },
    noHeroSizeEm: 1.4,
    heroFontName: "Instrument Serif",
    heroColours: ["highlight"],
    rowGapEm: 0.1,
    // Ticket 06b: rows visibly offset (41 px at S = 68), alternating sides by the seed.
    staggerEm: 0.6,
    // Hero-only blur and short travel (spec 6 rule 6); `blur` stays selectable.
    defaultMotion: "slide",
    softShadow: SMALL_TEXT_SOFT_SHADOW,
  },
  /**
   * Reference 05: one caps word per tile, tiles tilted by turns, no hero. Words of one or two
   * letters get pink tiles with dark ink, the rest dark tiles with the text colour.
   */
  cutout: {
    name: "Cutout",
    layout: "row",
    align: "center",
    roles: {
      minor: textRole(1),
      body: textRole(1),
      hero: textRole(1),
    },
    noHeroSizeEm: 1,
    heroFontName: "Anton",
    heroColours: ["primary"],
    emphasis: "never",
    rowGapEm: 0.06,
    staggerEm: 0,
    defaultMotion: "drop",
    accentColor: "#F4B6D2",
    tile: {
      fill: "#16161A",
      // Ticket 06b: by letter count, not by minor role, as in reference 05 ("IT", "SO" pink; "KEEP" dark).
      short: { maxLetters: 2, fill: "accent", ink: "#16161A" },
      tiltsDeg: [-2, 1.5, -1, 2],
      // Ticket 05b: pad 0.16 x 0.12 em and radius 0.1 em read closer to reference 05 than 0.12 x 0.08 and 0.05.
      radiusEm: 0.1,
      padXEm: 0.16,
      padYEm: 0.12,
      gapEm: 0.08,
      // 3 px at S = 84.
      shadowEm: 3 / 84,
    },
  },
  /**
   * References 04 and 07 (partial: one hero, not two): a left-aligned lowercase stack beside the
   * speaker. Support words are the text slot (`fontName` Inter SemiBold, "heavy sans hero with
   * medium sans support"); the hero is Poppins ExtraBold.
   */
  marker: {
    name: "Marker",
    layout: "stack",
    align: "left",
    roles: {
      minor: textRole(1),
      body: textRole(1),
      // 120 px at S = 52 (2.31 S).
      hero: { font: "hero", sizeEm: 120 / 52, transform: "lowercase", letterSpacing: 0, colour: "highlight" },
    },
    noHeroSizeEm: 1.5,
    heroFontName: "Poppins",
    // Yellow, then pink, by the cue's seed.
    heroColours: ["highlight", "accent"],
    rowGapEm: 0.14,
    staggerEm: 0,
    leftGuidePct: 8,
    // Travel of 0.18 em or less (spec 6 rule 6); `rise` (0.32 em) stays selectable.
    defaultMotion: "slide",
    accentColor: "#EF8DB9",
    softShadow: MARKER_SOFT_SHADOW,
    // Reference 04's squiggle under the hero.
    decorations: ["underline"],
  },
  /**
   * Reference 08: light lowercase rows (`fontName` Inter Regular) around a huge lowercase Inter
   * ExtraBold hero, all white.
   */
  stack: {
    name: "Stack",
    layout: "stack",
    align: "center",
    roles: {
      minor: textRole(1),
      body: textRole(1),
      // 2.4 S (154 px at S = 64): support cap height about 42% of the hero's, as in reference 08.
      hero: { font: "hero", sizeEm: 2.4, transform: "lowercase", letterSpacing: -0.03, colour: "highlight" },
    },
    noHeroSizeEm: 1.5,
    heroFontName: "Inter",
    heroColours: ["highlight"],
    rowGapEm: 0.04,
    staggerEm: 0,
    defaultMotion: "slide",
    softShadow: SMALL_TEXT_SOFT_SHADOW,
    // Reference 08's white stars around the block; they follow the accent colour.
    decorations: ["stars"],
    accentColor: "#FFFFFF",
  },
  /**
   * Reference 03: serif caps support around a pink, capitalised display hero ("display hero
   * with serif caps support", spec section 6 rule 2). Support words are the text slot
   * (`fontName` DM Serif Display, preset `textTransform` uppercase).
   */
  groove: {
    name: "Groove",
    layout: "stack",
    align: "center",
    roles: {
      minor: textRole(1),
      body: textRole(1),
      // 176 px at S = 80 (2.2 S). Ticket 06b raised the support caps from 64 px toward reference 03's proportion.
      hero: { font: "hero", sizeEm: 176 / 80, transform: "capitalize", letterSpacing: 0, colour: "highlight" },
    },
    noHeroSizeEm: 1.5,
    heroFontName: "Caprasimo",
    heroColours: ["highlight"],
    // 8 px at S = 80.
    rowGapEm: 8 / 80,
    staggerEm: 0,
    defaultMotion: "slide",
    softShadow: GROOVE_SOFT_SHADOW,
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
  /**
   * Size of a support word (minor or body) drawn in Nastaliq (Urdu), as a multiple of its role size.
   * Nastaliq sets its letters small inside a tall em, so at the role size it read about two thirds
   * as large as the Latin support words around it, and thin (ticket 05b frames). Heroes keep their size.
   */
  nastaliqSupportScale: 1.3,
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
  /** Fill of the word's tile; null when the style has no tiles. */
  readonly tileColor: string | null;
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
 * How a word of `role` with display `text` is drawn in a cue with `seed`.
 * Text-slot roles take `textTransform` and `letterSpacing` from the preset
 * when the style says "inherit"; hero-slot roles take both from the style
 * (spec 5.2). A tile style's short words take its `short` fill and ink.
 */
export function captionRoleLook(
  preset: CaptionPreset,
  style: CaptionDynamicStyle,
  role: CaptionWordRole,
  seed: number,
  text: string,
): CaptionRoleLook {
  const type = style.roles[role];
  const hero = type.font === "hero";
  const colourSlot = role === "hero" && style.heroColours.length > 0
    ? style.heroColours[seed % style.heroColours.length]!
    : type.colour;
  const short = style.tile?.short && captionTileWordLength(text) <= style.tile.short.maxLetters ? style.tile.short : null;
  return {
    font: type.font,
    fontName: hero ? preset.heroFontName ?? style.heroFontName : preset.fontName,
    transform: type.transform === "inherit" ? preset.textTransform : type.transform,
    letterSpacing: type.letterSpacing === "inherit" ? preset.letterSpacing : type.letterSpacing,
    color: slotColour(short ? short.ink : colourSlot, preset, style),
    tileColor: style.tile ? slotColour(short ? short.fill : style.tile.fill, preset, style) : null,
  };
}

const TILE_LETTER_RE = /[\p{L}\p{N}]/u;

/** Letters and digits in a word, combining marks excluded: what a tile style's `short` rule counts. */
export function captionTileWordLength(text: string): number {
  let count = 0;
  for (const char of text) if (TILE_LETTER_RE.test(char)) count += 1;
  return count;
}

/** False for a style that never draws a hero (`emphasis: "never"`, Cutout): hero colour, font, size and emphasis act on nothing. */
export function captionStyleDrawsHero(style: Pick<CaptionDynamicStyle, "emphasis">): boolean {
  return style.emphasis !== "never";
}

/** True when some role, hero alternation, tile or decoration of `style` is drawn in the accent slot (`accentColor`). */
export function captionStyleUsesAccent(style: CaptionDynamicStyle): boolean {
  const slots: readonly (CaptionColourSlot | string)[] = [
    ...Object.values(style.roles).map((role) => role.colour),
    ...style.heroColours,
    ...(style.tile ? [style.tile.fill, ...(style.tile.short ? [style.tile.short.fill, style.tile.short.ink] : [])] : []),
    ...(style.decorations ?? []).map((kind) => captionDecorationSlot(kind)),
  ];
  return slots.includes("accent");
}

function captionDecorationSlot(kind: CaptionDecorationKind): CaptionColourSlot | string {
  return kind === "underline" ? CAPTION_DECORATION.underline.colour : CAPTION_DECORATION.stars.colour;
}

/** The fill of a decoration: the underline is white, stars follow the accent colour. */
export function captionDecorationColour(kind: CaptionDecorationKind, preset: CaptionPreset, style: CaptionDynamicStyle): string {
  return slotColour(captionDecorationSlot(kind), preset, style);
}

/**
 * The hero gradient a cue draws, or null for the flat hero colour (spec 5.10). Null when the
 * style has none; when the hero colour is not the style's own (the user or a brand picked
 * another colour, which then wins flat); and when the block's motion scales or turns the hero
 * (scale, rotateX/Z keyframes, or a tilting motion), because the worker's gradient bands are
 * fixed to the screen while the Studio's gradient moves with the word. Both painters ask this.
 */
export function captionHeroGradient(
  preset: CaptionPreset,
  style: CaptionDynamicStyle,
): { readonly top: string; readonly bottom: string } | null {
  const gradient = style.gradient;
  if (!gradient || preset.highlightColor.toUpperCase() !== gradient.bottom.toUpperCase()) return null;
  const motion: CaptionMotionSpec = CAPTION_MOTIONS[captionBlockAnimation(preset, style)];
  const posed = captionEntranceKeyframes(motion, true).some((frame) =>
    frame.scaleX !== undefined || frame.scaleY !== undefined || frame.rotateXDeg !== undefined || frame.rotateZDeg !== undefined);
  return motion.tilt || posed ? null : gradient;
}
