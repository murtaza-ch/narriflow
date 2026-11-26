import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the vendored caption font files. The worker hands this
 * directory to libass (`ass=...:fontsdir=`) and measures words from the same
 * files, so burn-in never falls back to a system font. The web app loads the
 * same files through next/font/local (apps/web/app/caption-fonts.ts).
 */
export const CAPTION_FONTS_DIRECTORY = fileURLToPath(new URL("../fonts/", import.meta.url));

export function captionFontFilePath(file: string): string {
  return join(CAPTION_FONTS_DIRECTORY, file);
}
