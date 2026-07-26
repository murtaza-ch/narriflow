import { z } from "zod";

export const BRAND_DEFAULT_CAPTION_PRESET_ID = "brand_default";
export const LEGACY_DEFAULT_CAPTION_PRESET_ID = "default";

/**
 * Number of words shown together as one caption cue. Shared by the studio
 * preview (`getCurrentCaptionState`) and the worker burn-in renderer so the
 * exported video matches the on-screen preview exactly. Do not fork this value.
 */
export const CAPTION_CHUNK_SIZE = 3;

/**
 * Default vertical anchor (percent of frame height, center of the caption
 * block) for each `position` enum value. Mirrored in the studio overlay
 * (`POSITION_Y_PRESETS`) so preview and export agree.
 */
export const CAPTION_POSITION_Y_DEFAULTS: Record<
  "top" | "center" | "bottom",
  number
> = {
  top: 10,
  center: 50,
  bottom: 88,
};

export const captionAnimationSchema = z.enum([
  "none",
  "word-by-word",
  "karaoke",
  "bounce",
  "blur-in",
  "grow",
  "breathe",
  "soft-landing",
  "glitch",
  "seamless-bounce",
]);

export type CaptionAnimation = z.infer<typeof captionAnimationSchema>;

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

export const captionPresetSchema = z.object({
  fontName: z.string().max(100).default("Bebas Neue"),
  emojis: z.boolean().optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#FFFFFF"),
  outlineColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#000000"),
  outlineWidth: z.number().int().min(0).max(4).default(2),
  shadow: z.number().int().min(0).max(1).default(1),
  bold: z.boolean().default(true),
  position: z.enum(["bottom", "top", "center"]).default("bottom"),
  highlightColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#00FF88"),
  animation: captionAnimationSchema.default("word-by-word"),
  fontSize: z.number().min(8).max(120).default(36),
  positionX: z.number().min(0).max(100).optional(),
  positionY: z.number().min(0).max(100).optional(),

  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  backgroundOpacity: z.number().min(0).max(1).optional(),
  highlightBoxColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  highlightBoxOpacity: z.number().min(0).max(1).optional(),
  glowColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  glowIntensity: z.number().min(0).max(20).optional(),
  // Defaults match the studio preview's fallbacks so the burned export looks
  // identical to the preview even when a preset omits these fields.
  textTransform: z
    .enum(["uppercase", "lowercase", "capitalize", "none"])
    .default("uppercase"),
  letterSpacing: z.number().min(-0.1).max(0.5).default(0.04),
});

export type CaptionPreset = z.infer<typeof captionPresetSchema>;

/**
 * The canonical caption preset built entirely from the schema defaults.
 * Derived via `captionPresetSchema.parse({})` so it can never drift from the
 * schema; fields without defaults (emojis, positionX/Y, background/glow
 * options) are intentionally absent.
 */
export const DEFAULT_CAPTION_PRESET: CaptionPreset = captionPresetSchema.parse({});

export interface NamedCaptionPreset {
  id: string;
  name: string;
  preset: CaptionPreset;
}

export const CAPTION_PRESETS = [
  {
    id: "minimal",
    name: "Minimal",
    preset: {
      fontName: "Montserrat",
      primaryColor: "#C8C8C8",
      outlineColor: "#000000",
      outlineWidth: 0,
      shadow: 0,
      bold: false,
      position: "bottom",
      highlightColor: "#FFFFFF",
      animation: "word-by-word",
      fontSize: 32,
      textTransform: "none",
      letterSpacing: 0.01,
    },
  },
  {
    id: "karaoke",
    name: "Karaoke",
    preset: {
      fontName: "Bebas Neue",
      primaryColor: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 3,
      shadow: 1,
      bold: true,
      position: "bottom",
      highlightColor: "#00FF88",
      animation: "karaoke",
      fontSize: 42,
      textTransform: "uppercase",
      letterSpacing: 0.04,
    },
  },
  {
    id: "highlighter",
    name: "Highlighter",
    preset: {
      fontName: "Roboto",
      primaryColor: "#E8E8E8",
      outlineColor: "#1A1A2E",
      outlineWidth: 2,
      shadow: 1,
      bold: true,
      position: "bottom",
      highlightColor: "#FFFFFF",
      animation: "word-by-word",
      fontSize: 36,
      textTransform: "capitalize",
      letterSpacing: 0.02,
      highlightBoxColor: "#FF3CAC",
      highlightBoxOpacity: 0.95,
    },
  },
  {
    id: "neon-dreams",
    name: "Neon Dreams",
    preset: {
      fontName: "Bebas Neue",
      primaryColor: "#00F5FF",
      outlineColor: "#002B33",
      outlineWidth: 1,
      shadow: 0,
      bold: true,
      position: "center",
      highlightColor: "#FF00FF",
      animation: "blur-in",
      fontSize: 44,
      textTransform: "uppercase",
      letterSpacing: 0.08,
      glowColor: "#00F5FF",
      glowIntensity: 16,
    },
  },
  {
    id: "fire",
    name: "Fire",
    preset: {
      fontName: "Impact",
      primaryColor: "#FFE100",
      outlineColor: "#000000",
      outlineWidth: 3,
      shadow: 1,
      bold: true,
      position: "bottom",
      highlightColor: "#FF1744",
      animation: "bounce",
      fontSize: 46,
      textTransform: "uppercase",
      letterSpacing: 0.04,
      glowColor: "#FF6D00",
      glowIntensity: 8,
    },
  },
  {
    id: "pastel-cloud",
    name: "Pastel Cloud",
    preset: {
      fontName: "Montserrat",
      primaryColor: "#FFB8D1",
      outlineColor: "#4A2040",
      outlineWidth: 1,
      shadow: 0,
      bold: false,
      position: "bottom",
      highlightColor: "#C490FF",
      animation: "soft-landing",
      fontSize: 34,
      textTransform: "lowercase",
      letterSpacing: 0.03,
      glowColor: "#FFB8D1",
      glowIntensity: 6,
    },
  },
  {
    id: "street",
    name: "Street",
    preset: {
      fontName: "Oswald",
      primaryColor: "#AAFF00",
      outlineColor: "#000000",
      outlineWidth: 4,
      shadow: 1,
      bold: true,
      position: "bottom",
      highlightColor: "#FFFFFF",
      animation: "seamless-bounce",
      fontSize: 40,
      textTransform: "uppercase",
      letterSpacing: 0.06,
    },
  },
  {
    id: "frosted-glass",
    name: "Frosted Glass",
    preset: {
      fontName: "Open Sans",
      primaryColor: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 0,
      shadow: 0,
      bold: true,
      position: "bottom",
      highlightColor: "#4ADE80",
      animation: "word-by-word",
      fontSize: 32,
      textTransform: "none",
      letterSpacing: 0.02,
      backgroundColor: "#0F172A",
      backgroundOpacity: 0.78,
    },
  },
  {
    id: "sunset",
    name: "Sunset",
    preset: {
      fontName: "Bebas Neue",
      primaryColor: "#FF6B6B",
      outlineColor: "#2D1B14",
      outlineWidth: 2,
      shadow: 1,
      bold: true,
      position: "bottom",
      highlightColor: "#FFD93D",
      animation: "grow",
      fontSize: 42,
      textTransform: "uppercase",
      letterSpacing: 0.05,
    },
  },
  {
    id: "matrix",
    name: "Matrix",
    preset: {
      fontName: "Roboto",
      primaryColor: "#00FF41",
      outlineColor: "#003300",
      outlineWidth: 1,
      shadow: 0,
      bold: true,
      position: "center",
      highlightColor: "#7FFF00",
      animation: "glitch",
      fontSize: 36,
      textTransform: "uppercase",
      letterSpacing: 0.1,
      glowColor: "#00FF41",
      glowIntensity: 10,
    },
  },
  {
    id: "luxe-gold",
    name: "Luxe Gold",
    preset: {
      fontName: "Montserrat",
      primaryColor: "#D4AF37",
      outlineColor: "#1A1400",
      outlineWidth: 1,
      shadow: 1,
      bold: true,
      position: "bottom",
      highlightColor: "#FFF1CC",
      animation: "breathe",
      fontSize: 36,
      textTransform: "uppercase",
      letterSpacing: 0.12,
      glowColor: "#D4AF37",
      glowIntensity: 5,
    },
  },
  {
    id: "electric",
    name: "Electric",
    preset: {
      fontName: "Impact",
      primaryColor: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 4,
      shadow: 1,
      bold: true,
      position: "bottom",
      highlightColor: "#FFFFFF",
      animation: "word-by-word",
      fontSize: 44,
      textTransform: "uppercase",
      letterSpacing: 0.04,
      highlightBoxColor: "#3B82F6",
      highlightBoxOpacity: 1,
    },
  },
] as const satisfies readonly NamedCaptionPreset[];

export const captionPresetIds = [
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  LEGACY_DEFAULT_CAPTION_PRESET_ID,
  ...CAPTION_PRESETS.map((preset) => preset.id),
] as const;

export const captionPresetIdSchema = z.enum(captionPresetIds);
export type CaptionPresetId = z.infer<typeof captionPresetIdSchema>;

export const captionPresetOptions = [
  { id: BRAND_DEFAULT_CAPTION_PRESET_ID, name: "Brand default", preset: null },
  ...CAPTION_PRESETS,
] as const;

export function isBrandDefaultCaptionPresetId(id: string) {
  return id === BRAND_DEFAULT_CAPTION_PRESET_ID || id === LEGACY_DEFAULT_CAPTION_PRESET_ID;
}

export function getCaptionPresetById(id: string): NamedCaptionPreset | undefined {
  return CAPTION_PRESETS.find((preset) => preset.id === id);
}
