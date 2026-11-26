import { describe, expect, test } from "bun:test";
import { loadCaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { CAPTION_EMOJI_PALETTES, captionEmojiPalette, captionEmojiTemplateColours, getCaptionPresetById } from "@narriflow/validators";
import { captionEmojiDrawing } from "./drawing";
import { captionEmojiCueDirection, captionEmojiLayerEmojis, captionEmojiLayerStyle } from "./style";

const preset = (id: string) => getCaptionPresetById(id)!.preset;

describe("the emoji layer's style from a preset (one derivation for the Studio and the export)", () => {
  test("defaults: template palette, size 1, auto position, sticker on, the template's shadow colour", () => {
    const lyrics = preset("lyrics");
    expect(captionEmojiLayerStyle(lyrics)).toEqual({
      palette: captionEmojiPalette(captionEmojiTemplateColours(lyrics)),
      size: 1,
      position: "auto",
      sticker: true,
      shadowColour: lyrics.shadowColor,
      slot: "beside-end",
    });
  });

  test("the preset's own fields win; classic and Dynamic presets take the above slot", () => {
    const palette = { a: "#ff0000", b: "#00ff00", c: "#0000ff" };
    const style = captionEmojiLayerStyle({ ...preset("bold-pop"), emojiPalette: palette, emojiSize: 1.25, emojiPosition: "below", emojiSticker: false });
    expect(style).toMatchObject({ palette, size: 1.25, position: "below", sticker: false, slot: "above" });
    expect(captionEmojiLayerStyle(preset("headline")).slot).toBe("above");
    expect(captionEmojiLayerStyle(preset("dialogue")).slot).toBe("below");
  });

  test("under the template's palette a face takes the template's body like every design; a named palette colours it too", async () => {
    const art = await loadCaptionEmojiArt(["heart-eyes", "sun-with-face", "rocket"]);
    // The colour each design's body (`a`) layers paint with.
    const bodies = (id: string, palette: ReturnType<typeof captionEmojiLayerStyle>["palette"]) => {
      const design = art.get(id)!;
      const drawing = captionEmojiDrawing(design, { sizePx: 64, palette, sticker: false, shadowColour: "#000000", tiltDeg: 0 });
      return new Set(design.layers.flatMap((layer, index) => ("role" in layer.colour && layer.colour.role === "a" ? [drawing.parts.find((part) => part.key === String(index))!.colour] : [])));
    };
    const headline = captionEmojiLayerStyle(preset("headline")).palette;
    expect(headline.a).not.toBe("#ffe45c");
    expect(bodies("heart-eyes", headline)).toEqual(new Set([headline.a]));
    expect(bodies("sun-with-face", headline)).toEqual(new Set([headline.a]));
    expect(bodies("rocket", headline)).toEqual(new Set([headline.a]));
    const jelly = captionEmojiLayerStyle({ ...preset("headline"), emojiPalette: CAPTION_EMOJI_PALETTES[1].palette }).palette;
    expect(bodies("heart-eyes", jelly)).toEqual(new Set([CAPTION_EMOJI_PALETTES[1].palette.a]));
  });

  test("plan emojis carry their cue and clip ms; a cue reads in its words' direction", () => {
    expect(captionEmojiLayerEmojis([{ cueIndex: 3, emojis: [{ id: "flame", atSec: 1.25, order: 4 }, { id: "thumbs-up", tone: 4, atSec: 2, order: 5 }] }])).toEqual([
      { cueIndex: 3, id: "flame", atMs: 1250, order: 4 },
      { cueIndex: 3, id: "thumbs-up", tone: 4, atMs: 2000, order: 5 },
    ]);
    expect(captionEmojiCueDirection([{ text: "یہ" }, { text: "خیال" }], "ur")).toBe("rtl");
    expect(captionEmojiCueDirection([{ text: "This" }, { text: "idea" }], "en")).toBe("ltr");
  });
});
