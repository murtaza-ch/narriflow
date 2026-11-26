import { describe, expect, test } from "bun:test";
import { loadCaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { CAPTION_EMOJI_PALETTES, captionEmojiTemplateColours, getCaptionPresetById, resolveCaptionEmojiPalette } from "@narriflow/validators";
import { captionEmojiSvgMarkup } from "./emoji-glyph";

describe("Studio glyphs draw what the video draws", () => {
  test("under the template's palette a face takes the template's colours like every design; a named palette colours it", async () => {
    const art = await loadCaptionEmojiArt(["heart-eyes", "rocket"]);
    const headline = resolveCaptionEmojiPalette({}, captionEmojiTemplateColours(getCaptionPresetById("headline")!.preset));
    const face = captionEmojiSvgMarkup(art.get("heart-eyes")!, headline, 0, 24);
    // Headline's green body and teal rim, never the pack's yellow.
    expect(face).toContain(`fill="${headline.a}"`);
    expect(face).toContain(`fill="${headline.b}"`);
    expect(face).not.toContain('fill="#ffe45c"');
    expect(captionEmojiSvgMarkup(art.get("rocket")!, headline, 0, 24)).toContain(`fill="${headline.a}"`);
    const jelly = CAPTION_EMOJI_PALETTES[1].palette;
    expect(captionEmojiSvgMarkup(art.get("heart-eyes")!, jelly, 0, 24)).toContain(`fill="${jelly.a}"`);
  });
});
