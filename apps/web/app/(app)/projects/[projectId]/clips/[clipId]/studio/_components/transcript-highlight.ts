import type { CaptionPreset } from "@narriflow/validators";

/** How the transcript marks the spoken word. */
export interface TranscriptHighlight {
  /** The spoken word's text colour. */
  color: string;
  /** The caption style's pill behind the active word, when it has one. */
  pill: string | null;
}

/**
 * The caption style's colour, as the dark Studio transcript can show it on
 * the spoken word: pill styles keep their pill, the rest colour the word
 * with the highlight. A white highlight would vanish among the transcript's
 * white text, so a style that only colours its other words (green words,
 * a white spoken word) lends the word that colour instead. Null when the
 * style has no colour that stands out on the near-black panel, so the
 * caller keeps the Studio accent.
 */
export function transcriptHighlight(preset: CaptionPreset): TranscriptHighlight | null {
  if (preset.highlightBoxColor) {
    if (luminance(preset.highlightBoxColor) < 0.02) return null;
    return {
      color: preset.highlightColor,
      pill: rgba(preset.highlightBoxColor, preset.highlightBoxOpacity ?? 1),
    };
  }
  const color = [preset.highlightColor, preset.primaryColor].find(standsOut);
  if (!color) return null;
  return { color, pill: null };
}

/** Readable on the near-black panel and unlike the transcript's white text. */
function standsOut(hex: string): boolean {
  return luminance(hex) >= 0.1 && !isNearWhite(hex);
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255) as [number, number, number];
}

function rgba(hex: string, opacity: number): string {
  const [r, g, b] = channels(hex).map((channel) => Math.round(channel * 255));
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A light grey or white: on the transcript it reads as ordinary text. */
function isNearWhite(hex: string): boolean {
  const values = channels(hex);
  return Math.max(...values) - Math.min(...values) < 0.12 && luminance(hex) > 0.6;
}
