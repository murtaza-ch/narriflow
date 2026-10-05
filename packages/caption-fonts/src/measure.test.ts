import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { create } from "fontkit";
import { CAPTION_FONT_FACES } from "@narriflow/validators";
import { measureCaptionTextEm } from "./measure";
import { captionFontFilePath } from "./paths";

describe("vendored caption faces", () => {
  for (const face of CAPTION_FONT_FACES) {
    test(`${face.name} has the libass name and metrics used by preview`, () => {
      const bytes = readFileSync(captionFontFilePath(face.file));
      const font = create(bytes);
      if (!("layout" in font)) throw new Error("Expected a static font face");
      expect(font.fullName).toBe(face.assName);
      // Read OS/2 directly: fontkit's public ascent uses hhea, while libass
      // and the browser overrides deliberately use the Windows metrics.
      let os2 = -1;
      for (let index = 0; index < bytes.readUInt16BE(4); index++) {
        const record = 12 + index * 16;
        if (bytes.toString("ascii", record, record + 4) === "OS/2") {
          os2 = bytes.readUInt32BE(record + 8);
          break;
        }
      }
      expect(os2).toBeGreaterThan(0);
      expect(bytes.readUInt16BE(os2 + 74) / font.unitsPerEm).toBeCloseTo(face.ascent, 4);
      expect(bytes.readUInt16BE(os2 + 76) / font.unitsPerEm).toBeCloseTo(face.descent, 4);
      expect(font.glyphForCodePoint(72).bbox.maxY / font.unitsPerEm).toBeCloseTo(face.capHeight, 4);
      expect(measureCaptionTextEm(face.name, "READY", 0)).toBeGreaterThan(0);
    });
  }

  test("includes trailing letter spacing and preserves kerning", () => {
    const font = create(readFileSync(captionFontFilePath("Montserrat-Black.ttf")));
    if (!("layout" in font)) throw new Error("Expected a static font face");
    expect(measureCaptionTextEm("Montserrat", "AV", 0.04))
      .toBeCloseTo(font.layout("AV").advanceWidth / font.unitsPerEm + 0.08, 8);
    expect(measureCaptionTextEm("Montserrat", "", 0.04)).toBe(0);
  });

  test("requests degradation when a glyph needs a system fallback", () => {
    expect(measureCaptionTextEm("Anton", "READY💰", 0)).toBeNull();
  });
});
