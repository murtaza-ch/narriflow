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

describe("caption cues in other languages", () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(CaptionCue, { preset: captionPresetSchema.parse({ animation: "pop" }), scale: 1, cueKey: 0, ...props } as never),
    );
  const text = (html: string) => html.replace(/<[^>]+>/g, "");

  test("a cue carries its language and the direction of its first strong character", () => {
    const urdu = render({ words: [{ word: "اردو", isActive: true }, { word: "زبان", isActive: false }], language: "ur" });
    expect(urdu).toContain('lang="ur"');
    expect(urdu).toContain('dir="rtl"');
    // The language's direction is only the fallback: an English cue stays left to right.
    expect(render({ words: [{ word: "Hello", isActive: true }], language: "ur" })).toContain('dir="ltr"');
    // Numbers alone take the language's direction, each word isolated in its own direction.
    const numbers = render({ words: [{ word: "2026", isActive: true }], language: "ar" });
    expect(numbers).toContain('dir="rtl"');
    expect(render({ words: [{ word: "Hello", isActive: true }], language: null })).not.toContain("lang=");
  });

  test("the cue's direction is the first strong character of the whole line, as the burn-in scans it", () => {
    const lineDir = (words: string[], language: string | null) =>
      /<div lang="[^"]*" dir="(ltr|rtl)"|<div dir="(ltr|rtl)"/.exec(render({ words: words.map((word) => ({ word, isActive: false })), language }))!
        .slice(1)
        .find(Boolean);
    // A number or mark ahead of the text has no direction of its own: the Arabic after it leads an English cue...
    expect(lineDir(["2026", "مرحبا"], "en")).toBe("rtl");
    expect(lineDir(["—", "2026", "مرحبا"], "en")).toBe("rtl");
    // ...and the Latin after a number leads an Arabic one.
    expect(lineDir(["2026", "OpenAI", "نظام"], "ar")).toBe("ltr");
    // A line with no strong character anywhere takes the language's direction.
    expect(lineDir(["2026", "!?"], "ar")).toBe("rtl");
    expect(lineDir(["...", "—"], "en")).toBe("ltr");
    expect(lineDir(["2026"], null)).toBe("ltr");
  });

  test("Arabic words keep their numbers and Latin names in their own direction", () => {
    const html = render({ words: [{ word: "عام", isActive: false }, { word: "2026", isActive: true }, { word: "OpenAI", isActive: false }], language: "ar" });
    expect(html.match(/<span dir="rtl"/g)?.length).toBe(2);
    expect(html).toContain('<span dir="ltr"');
    expect(text(html)).toContain("عام 2026");
  });

  test("Japanese tokens abut, and a provider space is kept where the script would drop it", () => {
    const tokens = ["日", "本", "語"].map((word, index) => ({ word, isActive: index === 1 }));
    // Every glyph layer repeats the cue's text; none of them puts a space between characters.
    expect(text(render({ words: tokens, language: "ja" }))).toMatch(/^[日本語]+$/);
    expect(text(render({ words: tokens, language: "ja" }))).toContain("日日本本語語");
    const phrases = [{ word: "สวัสดี", isActive: true }, { word: "ครับ", isActive: false, spaceBefore: true }];
    expect(text(render({ words: phrases, language: "th", preformatted: true }))).toContain("สวัสดี ครับ");
  });

  test("complex scripts take no letter spacing; Latin beside them keeps it", () => {
    const preset = captionPresetSchema.parse({ letterSpacing: 0.04, animation: "pop" });
    const html = render({ preset, words: [{ word: "नमस्ते", isActive: true }, { word: "world", isActive: false }], language: "hi" });
    expect(html).toContain("letter-spacing:0.04em");
    expect(html).toContain('<span style="letter-spacing:0">नमस्ते</span>');
    expect(html).not.toContain('<span style="letter-spacing:0">WORLD');
  });

  test("the karaoke sweep reveals a right-to-left word from the right", () => {
    const preset = captionPresetSchema.parse({ animation: "karaoke" });
    const sweep = (word: string, language: string) => render({ preset, words: [{ word, isActive: true, durationMs: 500 }], language });
    expect(sweep("سلام", "ar")).toContain("clip-path:inset(0 0 0 100%)");
    expect(sweep("hello", "en")).toContain("clip-path:inset(0 100% 0 0)");
  });

  test("casing follows the cue's language and leaves caseless and Georgian text alone", () => {
    const upper = (word: string, language: string | null) =>
      text(render({ preset: captionPresetSchema.parse({ textTransform: "uppercase", animation: "pop" }), words: [{ word, isActive: true }], language }));
    expect(upper("istanbul", "tr")).toContain("İSTANBUL");
    expect(upper("istanbul", "en")).toContain("ISTANBUL");
    expect(upper("ქართული", "ka")).toContain("ქართული");
    expect(upper("اردو", "ur")).toContain("اردو");
  });

  test("the font stack is the requested face, the cue language's face, script faces, symbols, emoji", () => {
    const family = (language: string | null) => String(captionFontStyle("Montserrat", language).fontFamily);
    expect(family("ur").indexOf('"Noto Nastaliq Urdu"')).toBeGreaterThan(family("ur").indexOf("var(--font-caption-montserrat)"));
    expect(family("ur").indexOf('"Noto Nastaliq Urdu"')).toBeLessThan(family("ur").indexOf('"Noto Sans Arabic"'));
    expect(family("ja").indexOf('"Noto Sans JP"')).toBeLessThan(family("ja").indexOf('"Noto Sans SC"'));
    expect(family("en")).not.toContain("Nastaliq");
    expect(family("en").endsWith('"Noto Sans Symbols 2", "Noto Emoji", sans-serif')).toBe(true);
    expect(captionFontStyle("Montserrat").fontSynthesis).toBe("none");
  });
});
