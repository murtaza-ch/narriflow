import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CAPTION_EMOJI_ATLAS, CAPTION_EMOJI_HEIGHT_EM, captionEmojiPose, resolveCaptionEmoji } from "@narriflow/caption-fonts/emoji";
import { CAPTION_FONT_FACES, captionPresetSchema } from "@narriflow/validators";
import { CaptionCue, CaptionEmoji, captionFontStyle } from "./caption-style-engine";

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

  test("starts a pop-in at the shared curve's first pose and stays static without motion", () => {
    const pop = renderToStaticMarkup(createElement(CaptionEmoji, { emoji: "💰", windowSec: 0.6, animated: true }));
    expect(pop).toContain("opacity:0");
    expect(pop).toContain("scale(0.6");
    expect(markup("💰")).not.toContain("scale(0.6");
  });

  test("with a clock the emoji is the export's pose at that instant: entrance, settled, exit, and the gap to the next word", () => {
    const at = (elapsedSec: number, windowSec: number, animated = true) =>
      renderToStaticMarkup(createElement(CaptionEmoji, { emoji: "💰", windowSec, elapsedSec, animated }));
    const opacityOf = (html: string) => Number(/;opacity:([\d.e-]+)/.exec(html)![1]);
    const scaleOf = (html: string) => Number(/transform:scale\(([\d.e-]+)\)/.exec(html)![1]);
    // A 600 ms window at 560 ms is mid fade-out: the shared pose has alpha 0.5, and the export is at the same value.
    expect(captionEmojiPose(0.56, 0.6).alpha).toBeCloseTo(0.5, 6);
    expect(opacityOf(at(0.56, 0.6))).toBeCloseTo(0.5, 6);
    // Seeking into the middle of the window shows the settled picture, not a fresh entrance.
    expect(opacityOf(at(0.3, 0.6))).toBe(1);
    expect(scaleOf(at(0.3, 0.6))).toBe(1);
    // The start of the window is the first pose; the entrance overshoot is the shared curve's.
    expect(opacityOf(at(0, 0.6))).toBe(0);
    expect(scaleOf(at(0, 0.6))).toBeCloseTo(captionEmojiPose(0, 0.6).scale, 9);
    expect(scaleOf(at(0.1, 0.6))).toBeCloseTo(captionEmojiPose(0.1, 0.6).scale, 9);
    // A word followed by a pause is scheduled through the gap: the exit sits at the window's end, not the word's.
    expect(opacityOf(at(0.5, 1.2))).toBe(1);
    expect(opacityOf(at(1.2 - 0.04, 1.2))).toBeCloseTo(0.5, 6);
    // Reduced motion keeps the settled pose throughout, even at the window's end.
    expect(opacityOf(at(0.58, 0.6, false))).toBe(1);
    // A scrub past either end clamps to the window.
    expect(at(-1, 0.6)).toBe(at(0, 0.6));
    expect(at(5, 0.6)).toBe(at(0.6, 0.6));
  });

  test("a cue shows the emoji at the clock's time over the word's export window", () => {
    const words = [{ word: "money", isActive: true, durationMs: 400, emojiWindow: { startSec: 2, endSec: 2.6 } }];
    const html = (timeSec: number) =>
      renderToStaticMarkup(createElement(CaptionCue, { preset: captionPresetSchema.parse({}), words, scale: 1, cueKey: 0, showEmojis: true, timeSec }));
    const emojiOpacity = (markup: string) => Number(/;opacity:([\d.e-]+)/.exec(markup.slice(markup.indexOf("data-caption-emoji")))![1]);
    expect(emojiOpacity(html(2.56))).toBeCloseTo(0.5, 6);
    expect(emojiOpacity(html(2.3))).toBe(1);
  });

  test("the emoji is not inside the word's entrance motion", () => {
    const words = [{ word: "money", isActive: true, durationMs: 400 }];
    const html = renderToStaticMarkup(
      createElement(CaptionCue, { preset: captionPresetSchema.parse({ animation: "pop" }), words, scale: 1, cueKey: 0, showEmojis: true }),
    );
    // The word's entrance span closes before the emoji starts: the emoji is its sibling, not its child.
    expect(html).toMatch(/MONEY<\/span><\/span><span[^>]*data-caption-emoji=/);
  });
});
