import { CAPTION_PRESETS, captionFontFace, type NamedCaptionPreset } from "@narriflow/validators";

/* Blueline studio palette (mirrors packages/ui/src/theme.ts studio.* + accent). */
export const P = {
  night: "#08090C",
  canvas: "#0E1013",
  surface: "#15181E",
  raised: "#20252E",
  border: "#262C36",
  borderStrong: "#3E4756",
  fg: "#E9EBEE",
  fgMuted: "#9AA3B0",
  fgSubtle: "#6B7483",
  accent: "#5B6CFF",
  accentDeep: "#2438E8",
  accentSoft: "#9DA8F8",
  timecode: "#7FD4E4",
  success: "#4CC38A",
  warm: "#FFB35C",
  danger: "#E5484D",
} as const;

/** How the stage draws a caption cue; the web page maps validators presets onto this. */
export type CaptionStyle = {
  name: string;
  font: string;
  weight: number;
  primary: string;
  highlight: string;
  outline: string;
  /** Preset outline width 0–4; default 3. 0 draws no stroke. */
  outlineWidth?: number;
  /** Box behind the active word. */
  box?: string;
  glow?: string;
  /** Plate behind the whole cue (Frosted Glass). */
  background?: string;
  transform: "uppercase" | "capitalize" | "none" | "lowercase";
  letterSpacing: number;
  punctuation: boolean;
};

const withAlpha = (hex: string, alpha: number) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/** Map current product presets onto the marketing canvas drawing kit. */
export function captionStyleFromPreset({ name, preset: p }: NamedCaptionPreset): CaptionStyle & { center: boolean } {
  return {
    name,
    font: p.fontName,
    weight: captionFontFace(p.fontName).weight,
    primary: p.primaryColor,
    highlight: p.highlightColor,
    outline: p.outlineColor,
    outlineWidth: p.outlineWidth,
    box: p.highlightBoxColor ? withAlpha(p.highlightBoxColor, p.highlightBoxOpacity ?? 1) : undefined,
    glow: p.glowColor && (p.glowIntensity ?? 0) > 0 ? p.glowColor : undefined,
    background: p.backgroundColor ? withAlpha(p.backgroundColor, p.backgroundOpacity ?? 1) : undefined,
    transform: p.textTransform,
    letterSpacing: p.letterSpacing,
    punctuation: p.punctuation !== false,
    center: p.position === "center",
  };
}

function styleFor(id: NamedCaptionPreset["id"]) {
  const named = CAPTION_PRESETS.find((preset) => preset.id === id);
  if (!named) throw new Error(`Caption preset ${id} is unavailable`);
  return captionStyleFromPreset(named);
}

// Storyboard aliases select their styles from the canonical product catalog.
export const PRESETS = {
  karaoke: styleFor("karaoke"),
  boldPop: styleFor("bold-pop"),
  highlighter: styleFor("highlighter"),
  neon: styleFor("neon"),
  bubblegum: styleFor("bubblegum"),
  electric: styleFor("electric"),
  cinema: styleFor("cinema"),
  street: styleFor("street"),
} satisfies Record<string, CaptionStyle>;

export type PresetId = keyof typeof PRESETS;
export type Preset = CaptionStyle;
