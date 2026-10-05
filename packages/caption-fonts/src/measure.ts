import { readFileSync } from "node:fs";
import { create, type Font } from "fontkit";
import { captionFontFace, type CaptionFontName } from "@narriflow/validators";
import { captionFontFilePath } from "./paths";

const fonts = new Map<CaptionFontName, Font>();

function loadFont(name: CaptionFontName): Font {
  const cached = fonts.get(name);
  if (cached) return cached;
  const font = create(readFileSync(captionFontFilePath(captionFontFace(name).file)));
  if (!("layout" in font)) throw new Error(`Caption font ${name} is a collection`);
  fonts.set(name, font);
  return font;
}

/**
 * Advance width of `text` in em, shaped (kerning, ligatures) the way libass
 * shapes it, plus `letterSpacingEm` after every character — libass adds its
 * `\fsp` after each glyph and the browser adds CSS letter-spacing after each
 * character, so both renderers measure the same box.
 * Returns null when the face lacks a glyph for any character: libass would
 * substitute a fallback font whose metrics we cannot predict.
 */
export function measureCaptionTextEm(
  name: CaptionFontName,
  text: string,
  letterSpacingEm: number,
): number | null {
  const font = loadFont(name);
  const characters = [...text];
  for (const character of characters) {
    if (!font.hasGlyphForCodePoint(character.codePointAt(0)!)) return null;
  }
  const run = font.layout(text);
  return run.advanceWidth / font.unitsPerEm + letterSpacingEm * characters.length;
}
