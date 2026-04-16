import type { CaptionPreset } from "@narriflow/validators";

export interface NamedCaptionPreset {
  id: string;
  name: string;
  preset: CaptionPreset;
}

export const CAPTION_PRESETS: readonly NamedCaptionPreset[] = [
  // ── 1. Minimal: whisper-quiet, no effects, ultra-clean ─────────────
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

  // ── 2. Karaoke: classic bold white + neon green highlight ──────────
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

  // ── 3. Highlighter: hot pink marker box behind active word ─────────
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

  // ── 4. Neon Dreams: electric cyan glow, cyberpunk ──────────────────
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

  // ── 5. Fire: aggressive yellow/red with orange glow ────────────────
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

  // ── 6. Pastel Cloud: soft pink/lavender, dreamy ────────────────────
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

  // ── 7. Street: urban lime green on black, heavy ────────────────────
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

  // ── 8. Frosted Glass: modern backdrop, clean ───────────────────────
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

  // ── 9. Sunset: warm coral/gold tones ───────────────────────────────
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

  // ── 10. Matrix: terminal green, hacker aesthetic ───────────────────
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

  // ── 11. Luxe Gold: premium, refined ────────────────────────────────
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

  // ── 12. Electric: white + blue highlight box, punchy ───────────────
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
      highlightBoxOpacity: 1.0,
    },
  },
];

export function getCaptionPresetById(id: string): NamedCaptionPreset | undefined {
  return CAPTION_PRESETS.find((p) => p.id === id);
}
