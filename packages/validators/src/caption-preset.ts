import { z } from "zod";
import { CAPTION_FONT_NAMES } from "./caption-font";
import { CAPTION_ANIMATION_NAMES } from "./caption-style";

export const BRAND_DEFAULT_CAPTION_PRESET_ID = "brand_default";

/**
 * Words per caption cue when a preset does not choose (`wordsPerCue`). The
 * Clip Composition Plan and the studio preview both chunk an utterance's
 * visible words by the preset's `wordsPerCue`, so preview and burn-in cues
 * always match.
 */
export const DEFAULT_CAPTION_WORDS_PER_CUE = 3;

/**
 * Default vertical anchor (percent of frame height, centre of the caption
 * line) for each `position` value. Kept clear of the platform UI that covers
 * the top ~15% and bottom ~20% of a Reel, Short or TikTok. Shared by the
 * composition plan and the studio overlay so preview and export agree.
 */
export const CAPTION_POSITION_Y_DEFAULTS: Record<
  "top" | "center" | "bottom",
  number
> = {
  top: 20,
  center: 50,
  bottom: 72,
};

export const captionAnimationSchema = z.enum(CAPTION_ANIMATION_NAMES);

export type CaptionAnimation = z.infer<typeof captionAnimationSchema>;

export const captionFontNameSchema = z.enum(CAPTION_FONT_NAMES);

export const captionShadowSchema = z.enum(["none", "soft", "hard", "extrude"]);

export type CaptionShadow = z.infer<typeof captionShadowSchema>;

/**
 * Curated keyword → emoji map for "emoji captions" (a 2026 table-stakes style).
 * Deterministic (no LLM cost) and SHARED by the studio preview and the worker
 * burn-in so the exported emoji matches what the user sees.
 */
export const CAPTION_EMOJI_MAP: Record<string, string> = {
  money: "💰", cash: "💰", dollar: "💰", dollars: "💰", rich: "💰",
  fire: "🔥", hot: "🔥", lit: "🔥", amazing: "🔥",
  love: "❤️", heart: "❤️",
  idea: "💡", think: "💡", thought: "💡", smart: "🧠", brain: "🧠",
  time: "⏰", fast: "⚡", quick: "⚡", energy: "⚡", power: "⚡",
  growth: "📈", grow: "📈", growing: "📈", scale: "📈", up: "📈",
  down: "📉", drop: "📉",
  win: "🏆", winner: "🏆", winning: "🏆", best: "🏆", goal: "🎯", goals: "🎯",
  yes: "✅", correct: "✅", right: "✅", true: "✅",
  no: "🚫", never: "🚫", stop: "🛑", wrong: "❌",
  world: "🌍", global: "🌍", everyone: "🌍",
  rocket: "🚀", launch: "🚀", growthhack: "🚀",
  look: "👀", watch: "👀", see: "👀", eyes: "👀",
  music: "🎵", sound: "🎵",
  star: "⭐", magic: "✨", special: "✨",
  warning: "⚠️", important: "⚠️", careful: "⚠️",
  data: "📊", numbers: "📊", stats: "📊",
  build: "🛠️", work: "💪", strong: "💪", hard: "💪",
  question: "❓", why: "❓",
  boom: "💥", huge: "💥", massive: "💥",
};

export function emojiForWord(word: string): string | null {
  const key = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!key) return null;
  return CAPTION_EMOJI_MAP[key] ?? null;
}

// Punctuation/quote/bracket/dash characters stripped from a caption word's
// EDGES only (never the middle) when punctuation display is off — so
// "don't," -> "don't" (trailing comma stripped, intra-word apostrophe kept)
// and "state-of-the-art." -> "state-of-the-art" (trailing period stripped,
// intra-word hyphens kept). Includes ASCII + common Unicode quote/dash forms
// (curly quotes, em/en dash, ellipsis) since AssemblyAI tokens carry real
// punctuation, not just ASCII.
const CAPTION_EDGE_PUNCT_CHARS = ".,!?;:…\"'“”‘’()[\\]{}<>—–_~`*-";
const LEADING_CAPTION_PUNCT_RE = new RegExp(
  `^[${CAPTION_EDGE_PUNCT_CHARS}]+`,
  "u",
);
const TRAILING_CAPTION_PUNCT_RE = new RegExp(
  `[${CAPTION_EDGE_PUNCT_CHARS}]+$`,
  "u",
);

/**
 * Shared pure helper — the ONE place caption cue text is formatted for
 * punctuation display, consumed by Clip Composition Plan caption cues and the
 * studio preview (`caption-style-engine.tsx`'s `CaptionCue`) so preview and
 * burn-in can never fork. When `punctuation` is
 * false, strips leading/trailing punctuation from the token while preserving
 * intra-word apostrophes/hyphens; a token that is pure punctuation (e.g.
 * "...") collapses to `""` — callers (cue builders) must skip empty tokens
 * rather than render/emit a blank word. When `punctuation` is true the word
 * passes through unchanged.
 */
export function formatCaptionWord(
  word: string,
  opts: { punctuation: boolean },
): string {
  if (opts.punctuation) return word;
  return word
    .replace(LEADING_CAPTION_PUNCT_RE, "")
    .replace(TRAILING_CAPTION_PUNCT_RE, "");
}

/**
 * Shared pure helper — the ONE place caption cue text gets its case, used by
 * Clip Composition Plan caption cues and the studio preview so preview text
 * can never fork from burn-in text.
 */
export function applyCaptionTextTransform(
  text: string,
  transform: CaptionPreset["textTransform"],
): string {
  switch (transform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "capitalize":
      return text.replace(/(^|[\s\-])(\p{L})/gu, (_match, lead: string, letter: string) => lead + letter.toUpperCase());
    default:
      return text;
  }
}

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/**
 * A caption style. Sizes and stroke widths are canvas pixels (the export
 * frame, e.g. 1080 wide for 9:16); the studio scales them to the preview.
 * The schema defaults ARE the Bold Pop preset, so a clip without a stored
 * style renders as Bold Pop. The look of every field is specified in
 * caption-style.ts and rendered identically by the preview and the burn-in.
 */
export const captionPresetSchema = z.object({
  fontName: captionFontNameSchema.default("Montserrat"),
  /** Font size (the em) in canvas px. */
  fontSize: z.number().min(16).max(200).default(84),
  textTransform: z
    .enum(["uppercase", "lowercase", "capitalize", "none"])
    .default("uppercase"),
  /** Letter spacing in em. */
  letterSpacing: z.number().min(-0.1).max(0.5).default(-0.01),
  primaryColor: hexColor.default("#FFFFFF"),
  /** Colour of the active (currently spoken) word. */
  highlightColor: hexColor.default("#FFE11A"),
  outlineColor: hexColor.default("#000000"),
  /** Stroke around the glyphs, canvas px. */
  outlineWidth: z.number().int().min(0).max(16).default(7),
  /** Second stroke outside the first, canvas px (die-cut sticker look). */
  outerOutlineColor: hexColor.optional(),
  outerOutlineWidth: z.number().int().min(0).max(16).optional(),
  shadow: captionShadowSchema.default("soft"),
  shadowColor: hexColor.default("#000000"),
  /** Glow behind every visible word. */
  glowColor: hexColor.optional(),
  /** Glow behind the active word; wins over `glowColor` for that word. */
  highlightGlowColor: hexColor.optional(),
  glowIntensity: z.number().min(0).max(20).optional(),
  /** Rounded pill behind the active word. */
  highlightBoxColor: hexColor.optional(),
  highlightBoxOpacity: z.number().min(0).max(1).optional(),
  /** Rounded plate behind the whole cue. */
  backgroundColor: hexColor.optional(),
  backgroundOpacity: z.number().min(0).max(1).optional(),
  animation: captionAnimationSchema.default("pop"),
  wordsPerCue: z.number().int().min(1).max(5).default(DEFAULT_CAPTION_WORDS_PER_CUE),
  position: z.enum(["bottom", "top", "center"]).default("bottom"),
  positionX: z.number().min(0).max(100).optional(),
  positionY: z.number().min(0).max(100).optional(),
  emojis: z.boolean().optional(),
  /** Subtitle display on/off (vizard-parity Phase C). Absent/true = shown;
   *  false hides subtitle burn-in AND the studio's on-video caption overlay
   *  (style controls stay live either way — only display is gated). */
  visible: z.boolean().optional(),
  /** Punctuation on/off (vizard-parity Phase C). Absent/true = keep
   *  punctuation as transcribed; false routes cue text through
   *  `formatCaptionWord` in both the composition plan and the preview. */
  punctuation: z.boolean().optional(),
});

export type CaptionPreset = z.infer<typeof captionPresetSchema>;
export type CaptionPresetInput = z.input<typeof captionPresetSchema>;

/** Field-aware equality for canonical caption presets (every field is a primitive). */
export function captionPresetsEqual(
  left: CaptionPreset,
  right: CaptionPreset,
): boolean {
  if (left === right) return true;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof CaptionPreset>;
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * The canonical caption preset built entirely from the schema defaults
 * (Bold Pop). Derived via `captionPresetSchema.parse({})` so it can never
 * drift from the schema.
 */
export const DEFAULT_CAPTION_PRESET: CaptionPreset = captionPresetSchema.parse({});

export type CaptionPresetGroup = "Bold" | "Clean" | "Expressive" | "Effects";

export const CAPTION_PRESET_GROUPS = ["Bold", "Clean", "Expressive", "Effects"] as const satisfies readonly CaptionPresetGroup[];

export interface NamedCaptionPreset {
  id: string;
  name: string;
  group: CaptionPresetGroup;
  preset: CaptionPreset;
}

function namedPreset<const Id extends string>(
  id: Id,
  name: string,
  group: CaptionPresetGroup,
  preset: CaptionPresetInput,
) {
  return { id, name, group, preset: captionPresetSchema.parse(preset) };
}

export const CAPTION_PRESETS = [
  // Bold
  namedPreset("bold-pop", "Bold Pop", "Bold", {
    fontName: "Montserrat", fontSize: 84, textTransform: "uppercase", letterSpacing: -0.01,
    primaryColor: "#FFFFFF", highlightColor: "#FFE11A", outlineWidth: 7, shadow: "soft", animation: "pop",
  }),
  namedPreset("blast", "Blast", "Bold", {
    fontName: "Luckiest Guy", fontSize: 88, textTransform: "uppercase", letterSpacing: 0.02,
    primaryColor: "#FFFFFF", highlightColor: "#48FF6E", outlineWidth: 8, shadow: "hard", animation: "bounce",
  }),
  namedPreset("punch", "Punch", "Bold", {
    fontName: "Anton", fontSize: 132, textTransform: "uppercase", letterSpacing: 0.01,
    primaryColor: "#FFFFFF", highlightColor: "#FFFFFF", outlineWidth: 7, shadow: "soft", animation: "punch", wordsPerCue: 1,
  }),
  namedPreset("spotlight", "Spotlight", "Bold", {
    fontName: "Poppins", fontSize: 76, textTransform: "none", letterSpacing: -0.01,
    primaryColor: "#FFFFFF", highlightColor: "#FFFFFF", outlineWidth: 0, shadow: "soft",
    highlightBoxColor: "#6C4DFF", highlightBoxOpacity: 1, animation: "pop",
  }),
  namedPreset("street", "Street", "Bold", {
    fontName: "Oswald", fontSize: 88, textTransform: "uppercase", letterSpacing: 0.04,
    primaryColor: "#AAFF00", highlightColor: "#FFFFFF", outlineWidth: 8, shadow: "soft", animation: "bounce",
  }),
  namedPreset("electric", "Electric", "Bold", {
    fontName: "Anton", fontSize: 88, textTransform: "uppercase", letterSpacing: 0.04,
    primaryColor: "#FFFFFF", highlightColor: "#FFFFFF", outlineWidth: 7, shadow: "soft",
    highlightBoxColor: "#3B82F6", highlightBoxOpacity: 1, animation: "pop",
  }),
  // Clean
  namedPreset("rise", "Rise", "Clean", {
    fontName: "Inter", fontSize: 78, textTransform: "none", letterSpacing: -0.02,
    primaryColor: "#FFFFFF", highlightColor: "#C6FF3D", outlineWidth: 0, shadow: "soft", animation: "rise",
  }),
  namedPreset("focus", "Focus", "Clean", {
    fontName: "Inter SemiBold", fontSize: 68, textTransform: "none", letterSpacing: -0.015,
    primaryColor: "#FFFFFF", highlightColor: "#FFFFFF", outlineWidth: 0, shadow: "soft", animation: "focus", wordsPerCue: 4,
  }),
  namedPreset("glass", "Glass", "Clean", {
    fontName: "Inter", fontSize: 64, textTransform: "none", letterSpacing: -0.015,
    primaryColor: "#FFFFFF", highlightColor: "#7CE0FF", outlineWidth: 0, shadow: "none",
    backgroundColor: "#0B0D12", backgroundOpacity: 0.62, animation: "pop", wordsPerCue: 4,
  }),
  namedPreset("sticker", "Sticker", "Clean", {
    fontName: "Poppins", fontSize: 68, textTransform: "none", letterSpacing: -0.01,
    primaryColor: "#111111", highlightColor: "#FF2E63", outlineWidth: 0, shadow: "none",
    backgroundColor: "#FFFFFF", backgroundOpacity: 1, animation: "pop",
  }),
  namedPreset("frosted-glass", "Frosted Glass", "Clean", {
    fontName: "Open Sans", fontSize: 64, textTransform: "none", letterSpacing: 0.01,
    primaryColor: "#FFFFFF", highlightColor: "#4ADE80", outlineWidth: 0, shadow: "none",
    backgroundColor: "#0F172A", backgroundOpacity: 0.78, animation: "pop",
  }),
  namedPreset("highlighter", "Highlighter", "Clean", {
    fontName: "Roboto", fontSize: 74, textTransform: "capitalize", letterSpacing: 0.01,
    primaryColor: "#F2F2F2", highlightColor: "#FFFFFF", outlineColor: "#1A1A2E", outlineWidth: 4, shadow: "soft",
    highlightBoxColor: "#FF3CAC", highlightBoxOpacity: 1, animation: "pop",
  }),
  // Expressive
  namedPreset("bubblegum", "Bubblegum", "Expressive", {
    fontName: "Titan One", fontSize: 90, textTransform: "lowercase", letterSpacing: 0.01,
    primaryColor: "#FFFFFF", highlightColor: "#FFE45C", outlineColor: "#FF4F9A", outlineWidth: 8,
    shadow: "hard", shadowColor: "#7A1F4A", animation: "bounce", wordsPerCue: 2,
  }),
  namedPreset("jelly", "Jelly", "Expressive", {
    fontName: "Lilita One", fontSize: 96, textTransform: "uppercase", letterSpacing: 0.02,
    primaryColor: "#FFFFFF", highlightColor: "#A3FF12", outlineColor: "#7C3AED", outlineWidth: 9,
    shadow: "hard", shadowColor: "#2E1065", animation: "jelly", wordsPerCue: 2,
  }),
  namedPreset("candy", "Candy", "Expressive", {
    fontName: "Titan One", fontSize: 82, textTransform: "uppercase", letterSpacing: 0.02,
    primaryColor: "#FF5FA2", highlightColor: "#FFD23F", outlineColor: "#FFFFFF", outlineWidth: 7,
    outerOutlineColor: "#3B1C5A", outerOutlineWidth: 5, shadow: "soft", animation: "pop",
  }),
  namedPreset("retro", "Retro", "Expressive", {
    fontName: "Dela Gothic One", fontSize: 70, textTransform: "uppercase", letterSpacing: 0.01,
    primaryColor: "#FFF3D6", highlightColor: "#59F0D2", outlineColor: "#1A1A1A", outlineWidth: 4,
    shadow: "hard", shadowColor: "#FF5C39", animation: "pop",
  }),
  namedPreset("afterglow", "Afterglow", "Expressive", {
    fontName: "Unbounded", fontSize: 70, textTransform: "lowercase", letterSpacing: -0.02,
    primaryColor: "#FFFFFF", highlightColor: "#FFD6F5", outlineWidth: 0, shadow: "soft",
    highlightGlowColor: "#FF4FD8", glowIntensity: 14, animation: "fade",
  }),
  namedPreset("cinema", "Cinema", "Expressive", {
    fontName: "Instrument Serif", fontSize: 106, textTransform: "lowercase", letterSpacing: 0,
    primaryColor: "#F6EFE4", highlightColor: "#F2C46D", outlineWidth: 0, shadow: "soft", animation: "blur",
  }),
  // Effects
  namedPreset("karaoke", "Karaoke", "Effects", {
    fontName: "Bebas Neue", fontSize: 96, textTransform: "uppercase", letterSpacing: 0.04,
    primaryColor: "#FFFFFF", highlightColor: "#00FF88", outlineWidth: 6, shadow: "soft", animation: "karaoke",
  }),
  namedPreset("neon", "Neon", "Effects", {
    fontName: "Righteous", fontSize: 80, textTransform: "uppercase", letterSpacing: 0.04,
    primaryColor: "#FFE9FB", highlightColor: "#E9FDFF", outlineWidth: 0, shadow: "none",
    glowColor: "#FF2BD6", highlightGlowColor: "#22E4FF", glowIntensity: 16, animation: "neon",
  }),
  namedPreset("glitch", "Glitch", "Effects", {
    fontName: "Chakra Petch", fontSize: 80, textTransform: "uppercase", letterSpacing: 0.02,
    primaryColor: "#FFFFFF", highlightColor: "#FFFFFF", outlineWidth: 0, shadow: "soft", animation: "glitch",
  }),
  namedPreset("flip", "Flip", "Effects", {
    fontName: "Bricolage Grotesque", fontSize: 84, textTransform: "none", letterSpacing: -0.02,
    primaryColor: "#FFFFFF", highlightColor: "#FF8A3D", outlineWidth: 0, shadow: "soft", animation: "flip",
  }),
  namedPreset("typewriter", "Typewriter", "Effects", {
    fontName: "Courier Prime", fontSize: 70, textTransform: "none", letterSpacing: -0.02,
    primaryColor: "#F5F1E8", highlightColor: "#FFFFFF", outlineWidth: 0, shadow: "soft",
    animation: "typewriter", wordsPerCue: 4,
  }),
  namedPreset("block", "Block", "Effects", {
    fontName: "Archivo Black", fontSize: 82, textTransform: "uppercase", letterSpacing: -0.01,
    primaryColor: "#FFD84D", highlightColor: "#FFFFFF", outlineColor: "#14161C", outlineWidth: 4,
    shadow: "extrude", shadowColor: "#14161C", animation: "pop",
  }),
] as const satisfies readonly NamedCaptionPreset[];

export const captionPresetIds = [
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  ...CAPTION_PRESETS.map((preset) => preset.id),
] as const;

export const captionPresetIdSchema = z.enum(captionPresetIds);
export type CaptionPresetId = z.infer<typeof captionPresetIdSchema>;

export const captionPresetOptions = [
  { id: BRAND_DEFAULT_CAPTION_PRESET_ID, name: "Brand default", preset: null },
  ...CAPTION_PRESETS,
] as const;

export function isBrandDefaultCaptionPresetId(id: string) {
  return id === BRAND_DEFAULT_CAPTION_PRESET_ID;
}

export function getCaptionPresetById(id: string): NamedCaptionPreset | undefined {
  return CAPTION_PRESETS.find((preset) => preset.id === id);
}

/** Fields that describe where a caption sits or whether it shows, not how it looks. */
const CAPTION_PLACEMENT_FIELDS = new Set<keyof CaptionPreset>([
  "position",
  "positionX",
  "positionY",
  "emojis",
  "visible",
  "punctuation",
]);

/** The catalog preset whose look `preset` still has unchanged, if any. */
export function matchCaptionPreset(preset: CaptionPreset): NamedCaptionPreset | undefined {
  return CAPTION_PRESETS.find((named) => {
    const keys = new Set([...Object.keys(named.preset), ...Object.keys(preset)]) as Set<keyof CaptionPreset>;
    for (const key of keys) {
      if (CAPTION_PLACEMENT_FIELDS.has(key)) continue;
      if (named.preset[key] !== preset[key]) return false;
    }
    return true;
  });
}

/**
 * Applies a catalog preset's look to `current`, keeping the user's placement
 * and display toggles.
 */
export function applyCaptionPresetLook(current: CaptionPreset, named: NamedCaptionPreset): CaptionPreset {
  const placement: Partial<CaptionPreset> = {};
  for (const key of CAPTION_PLACEMENT_FIELDS) {
    if (current[key] !== undefined) Object.assign(placement, { [key]: current[key] });
  }
  return { ...named.preset, ...placement };
}
