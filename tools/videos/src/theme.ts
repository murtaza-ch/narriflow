// Blueline design tokens (mirrors packages/ui/src/theme.ts studio palette)
export const C = {
  canvas: "#0E1013",
  surface: "#171B21",
  raised: "#242A33",
  border: "#242A33",
  borderStrong: "#3E4756",
  fg: "#E9EBEE",
  fgMuted: "#9AA3B0",
  fgSubtle: "#828D9C",
  accent: "#5B6CFF",
  accentDeep: "#2438E8",
  timecode: "#7FD4E4",
  karaoke: "#00FF88",
  fire: "#FF6A2B",
  gold: "#E8C15A",
  danger: "#E5484D",
  porcelain: "#FBFBFC",
  ink: "#101318",
};

import { loadFont as loadArchivo } from "@remotion/google-fonts/Archivo";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";

const archivo = loadArchivo("normal", { weights: ["500", "600", "700", "800"] });
const geistMono = loadGeistMono("normal", { weights: ["400", "500", "600"] });

export const FONT_DISPLAY = archivo.fontFamily;
export const FONT_MONO = geistMono.fontFamily;
