import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CAPTION_EMOJI_ATLAS, CAPTION_EMOJI_HEIGHT_EM, resolveCaptionEmoji } from "@narriflow/caption-fonts/emoji";
import { CAPTION_FONT_FACES } from "@narriflow/validators";
import { CaptionEmoji, captionFontStyle } from "./caption-style-engine";

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

describe("caption emoji", () => {
  const markup = (emoji: string) => renderToStaticMarkup(createElement(CaptionEmoji, { emoji }));

  test("draws the export's atlas artwork 0.8em above the word, centred", () => {
    const html = markup("💰");
    const sprite = resolveCaptionEmoji("💰")!;
    expect(html).toContain(`data-caption-emoji="${sprite.key}"`);
    expect(html).toContain("bottom:100%");
    expect(html).toContain("left:50%");
    expect(html).toContain(`height:${CAPTION_EMOJI_HEIGHT_EM}em`);
    expect(html).toContain(`background-size:${CAPTION_EMOJI_ATLAS.columns * 100}% ${CAPTION_EMOJI_ATLAS.rows * 100}%`);
    expect(html).toContain("atlas");
  });

  test("keeps a ZWJ family whole and shows nothing for a sequence the atlas lacks", () => {
    expect(markup("👨\u200d👩\u200d👧")).toContain('data-caption-emoji="1f468_200d_1f469_200d_1f467"');
    expect(markup("🇵🇰")).toBe("");
  });
});
