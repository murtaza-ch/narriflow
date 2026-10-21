import { CAPTION_POSITION_Y_DEFAULTS, CAPTION_PRESETS } from "@narriflow/validators";

/**
 * A caption preset flattened to the values the homepage demo needs. Built on
 * the server from the real preset catalog, so the demo shows the same fonts,
 * colours and cue sizes a clip exports with, without shipping zod to the client.
 */
export type CaptionStyle = {
  id: string;
  name: string;
  fontName: string;
  /** CSS custom property holding the caption font family. */
  fontVar: string;
  /** Canvas px on a 1080-wide frame. */
  size: number;
  transform: "uppercase" | "lowercase" | "capitalize" | "none";
  /** em */
  tracking: number;
  color: string;
  highlight: string;
  outlineColor: string;
  /** Canvas px. */
  outlineWidth: number;
  shadow: string;
  shadowColor: string;
  box: string | null;
  plate: string | null;
  glow: string | null;
  highlightGlow: string | null;
  animation: string;
  wordsPerCue: number;
};

/** Vertical centre of a bottom caption line, percent of frame height. */
export const CAPTION_LINE_Y = CAPTION_POSITION_Y_DEFAULTS.bottom;

function rgba(hex: string, alpha: number) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function fontVar(fontName: string) {
  return `--font-caption-${fontName.toLowerCase().replace(/\s+/g, "-")}`;
}

export function buildCaptionStyles(): Record<string, CaptionStyle> {
  const styles: Record<string, CaptionStyle> = {};
  for (const { id, name, preset } of CAPTION_PRESETS) {
    styles[id] = {
      id,
      name,
      fontName: preset.fontName,
      fontVar: fontVar(preset.fontName),
      size: preset.fontSize,
      transform: preset.textTransform,
      tracking: preset.letterSpacing,
      color: preset.primaryColor,
      highlight: preset.highlightColor,
      outlineColor: preset.outlineColor,
      outlineWidth: preset.outlineWidth,
      shadow: preset.shadow,
      shadowColor: preset.shadowColor,
      box: preset.highlightBoxColor ? rgba(preset.highlightBoxColor, preset.highlightBoxOpacity ?? 1) : null,
      plate: preset.backgroundColor ? rgba(preset.backgroundColor, preset.backgroundOpacity ?? 1) : null,
      glow: preset.glowColor ?? null,
      highlightGlow: preset.highlightGlowColor ?? null,
      animation: preset.animation,
      wordsPerCue: preset.wordsPerCue,
    };
  }
  return styles;
}
