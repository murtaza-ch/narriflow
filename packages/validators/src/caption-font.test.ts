import { describe, expect, test } from "bun:test";
import { CAPTION_FONT_FACES, CAPTION_FONT_NAMES, CAPTION_PICKER_FONT_NAMES } from "./caption-font";
import { CAPTION_PRESETS, captionFontNameSchema } from "./caption-preset";

/** The faces added for the Scene Style templates (spec section 4, then gallery 2). */
const TEMPLATE_FACES = [
  "Inter Tight SemiBold",
  "Inter Tight Bold",
  "Inter Tight ExtraBold",
  "JetBrains Mono Medium",
  "JetBrains Mono Bold",
  "Unbounded Medium",
  "Unbounded Black",
  "Caveat Brush",
  "Permanent Marker",
  "Inter Tight Medium",
  "Inter Tight Regular",
  "Instrument Serif Regular",
  "Archivo Expanded ExtraBold",
  "Archivo Expanded ExtraBold Italic",
  "Archivo Expanded Black",
  "Archivo Expanded Black Italic",
  "Archivo ExtraBold Italic",
  "Rubik Black",
  "Yesteryear",
  "Big Shoulders Display Black",
  "Shrikhand",
  "Barlow Condensed Black Italic",
  "Lexend Exa Light",
  "Chango",
  "Alfa Slab One",
  "Abril Fatface",
  "Montserrat ExtraBold",
  "Rubik ExtraBold",
  "DM Serif Display Italic",
  "Inter Tight Light",
  "Inter Tight Light Italic",
  "Inter Tight Medium Italic",
  "Inter Tight ExtraBold Italic",
  "Barlow Condensed Medium",
  "Barlow Condensed Bold",
  "Barlow Condensed ExtraBold Italic",
  "Playfair Display Bold",
  "Playfair Display Bold Italic",
  "Space Grotesk Bold",
  "DM Sans Bold",
  "DM Sans Black",
  "Manrope Bold",
  "Manrope ExtraBold",
  "Space Mono Bold",
  "Silkscreen Bold",
  "Bagel Fat One",
  "Space Mono Regular",
  "Newsreader Medium",
  "Newsreader SemiBold",
  "Newsreader SemiBold Italic",
  "Plus Jakarta Sans Bold",
  "Plus Jakarta Sans ExtraBold",
  "Fredoka SemiBold",
  "Fredoka Bold",
  "Pixelify Sans Bold",
  "Londrina Solid Black",
];

describe("template-only caption faces", () => {
  test("exactly the template faces are marked, and nothing else", () => {
    const marked = CAPTION_FONT_FACES.filter((face) => "templateOnly" in face).map((face) => face.name);
    expect(marked.sort()).toEqual([...TEMPLATE_FACES].sort());
  });

  test("the classic pickers list every face but those", () => {
    expect(CAPTION_PICKER_FONT_NAMES).toHaveLength(CAPTION_FONT_NAMES.length - TEMPLATE_FACES.length);
    for (const name of TEMPLATE_FACES) expect(CAPTION_PICKER_FONT_NAMES as readonly string[]).not.toContain(name);
    for (const name of ["Anton", "Inter", "Inter SemiBold", "Montserrat", "Unbounded", "Courier Prime", "Oswald"]) expect(CAPTION_PICKER_FONT_NAMES as readonly string[]).toContain(name);
  });

  test("the preset schema still accepts them, and the Scene Style presets use them", () => {
    for (const name of TEMPLATE_FACES) expect(captionFontNameSchema.safeParse(name).success).toBe(true);
    const sceneFonts = CAPTION_PRESETS.filter((named) => named.preset.scene).map((named) => named.preset.fontName);
    expect(sceneFonts.some((name) => TEMPLATE_FACES.includes(name))).toBe(true);
  });
});
