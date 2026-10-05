import { describe, expect, test } from "bun:test";
import { CAPTION_FONT_FACES } from "@narriflow/validators";
import { captionFontStyle } from "./caption-style-engine";

describe("caption preview font faces", () => {
  test("uses the static vendored weights without browser synthesis", () => {
    expect(captionFontStyle("Montserrat").fontWeight).toBe(900);
    expect(captionFontStyle("Inter SemiBold").fontWeight).toBe(600);
    expect(captionFontStyle("Bebas Neue").fontWeight).toBe(400);
    expect(captionFontStyle("Instrument Serif").fontStyle).toBe("italic");
    for (const face of CAPTION_FONT_FACES) {
      const style = captionFontStyle(face.name);
      expect(style.fontFamily).toContain("var(--font-caption-");
      expect(style.fontWeight).toBe(face.weight);
      expect(style.fontStyle).toBe(face.style);
    }
  });
});
