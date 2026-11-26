import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CAPTION_FONT_FACES, captionPresetSchema } from "@narriflow/validators";
import { CaptionCue, captionFontStyle } from "./caption-style-engine";

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
  test("a classic cue draws no emoji of its own: the emoji layer draws them for every preset kind", () => {
    const html = renderToStaticMarkup(
      createElement(CaptionCue, { preset: captionPresetSchema.parse({ emojis: true }), words: [{ word: "money", isActive: true, durationMs: 400 }], scale: 1, cueKey: 0 }),
    );
    expect(html).not.toContain("data-caption-emoji");
  });
});

describe("caption cues in other languages", () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(CaptionCue, { preset: captionPresetSchema.parse({ animation: "pop" }), scale: 1, cueKey: 0, ...props } as never),
    );
  const text = (html: string) => html.replace(/<[^>]+>/g, "");
  // One copy of every word's text (no shadow layers) and no case change, so the markup reads as the line.
  const plainPreset = captionPresetSchema.parse({ animation: "pop", shadow: "none", textTransform: "none" });
  const renderPlain = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(CaptionCue, { preset: plainPreset, scale: 1, cueKey: 0, ...props } as never));

  test("a cue carries its language and its displayed script direction", () => {
    const urdu = render({ words: [{ word: "اردو", isActive: true }, { word: "زبان", isActive: false }], language: "ur" });
    expect(urdu).toContain('lang="ur"');
    expect(urdu).toContain('data-caption-direction="rtl"');
    // The language's direction is only the fallback: an English cue stays left to right.
    expect(render({ words: [{ word: "Hello", isActive: true }], language: "ur" })).toContain('data-caption-direction="ltr"');
    // Numbers alone take the language's direction, each word isolated in its own direction.
    const numbers = render({ words: [{ word: "2026", isActive: true }], language: "ar" });
    expect(numbers).toContain('data-caption-direction="rtl"');
    expect(render({ words: [{ word: "Hello", isActive: true }], language: null })).not.toContain("lang=");
  });

  test("the cue resolves the whole line, using its language for a balanced mix", () => {
    const lineDir = (words: string[], language: string | null) =>
      /data-caption-direction="(ltr|rtl)"/.exec(render({ words: words.map((word) => ({ word, isActive: false })), language }))![1];
    // A number or mark ahead of the text has no direction of its own: the Arabic after it leads an English cue...
    expect(lineDir(["2026", "مرحبا"], "en")).toBe("rtl");
    expect(lineDir(["—", "2026", "مرحبا"], "en")).toBe("rtl");
    // A balanced mix keeps the surrounding language, even after an English name.
    expect(lineDir(["2026", "OpenAI", "نظام"], "ar")).toBe("rtl");
    // A line with no strong character anywhere takes the language's direction.
    expect(lineDir(["2026", "!?"], "ar")).toBe("rtl");
    expect(lineDir(["...", "—"], "en")).toBe("ltr");
    expect(lineDir(["2026"], null)).toBe("ltr");
    // Timed CJK tokens count alike in every painter even though they draw without spaces.
    expect(lineDir(["你", "好", "שלום"], "ur")).toBe("ltr");
  });

  test("Arabic words keep their numbers and Latin names in their own direction", () => {
    const html = renderPlain({ words: [{ word: "عام", isActive: false }, { word: "2026", isActive: true }, { word: "OpenAI", isActive: false }], language: "ar" });
    expect(html.match(/<span dir="rtl"/g)?.length).toBe(2);
    expect(html).toContain('<span dir="ltr"');
    // Drawn in the burn-in's visual order: the name, the number, then the Arabic word at the right.
    expect(text(html)).toContain("OpenAI 2026 عام");
  });

  test("words stand in the burn-in's visual order inside a left-to-right line, so the browser does not order them again", () => {
    const html = renderPlain({
      words: [{ word: "اس", isActive: false }, { word: "کے", isActive: false }, { word: "لیے", isActive: false }, { word: "Extended", isActive: true }, { word: "Family", isActive: false }],
      language: "ur",
    });
    // The cue's base direction is Urdu's, but the words are laid out in a line that does not reorder them.
    expect(html).toMatch(/<div lang="ur" dir="ltr" data-caption-direction="rtl"/);
    // The English phrase stays LTR within the Urdu line, as libass draws it.
    expect(text(html)).toBe("Extended Family لیے کے اس");
    expect(html.indexOf("Extended")).toBeLessThan(html.indexOf("Family"));
    expect(html.indexOf("Family")).toBeLessThan(html.indexOf("لیے"));
    // Each word keeps its own direction for shaping inside its box.
    expect(html.match(/<span dir="(ltr|rtl)"/g)).toEqual(['<span dir="ltr"', '<span dir="ltr"', '<span dir="rtl"', '<span dir="rtl"', '<span dir="rtl"']);
    // Baseline anchors stay keyed by the logical word, for the ink measurement.
    expect(html.match(/data-caption-baseline="(\d)"/g)).toEqual(['data-caption-baseline="3"', 'data-caption-baseline="4"', 'data-caption-baseline="2"', 'data-caption-baseline="1"', 'data-caption-baseline="0"']);
  });

  test("a pure right-to-left cue runs its words right to left", () => {
    const html = renderPlain({ words: [{ word: "آپ", isActive: false }, { word: "کو", isActive: false }, { word: "بتایا", isActive: false }], language: "ur" });
    expect(text(html)).toBe("بتایا کو آپ");
  });

  test("typewriter letters reveal in the word's logical order", () => {
    const html = renderToStaticMarkup(
      createElement(CaptionCue, {
        preset: captionPresetSchema.parse({ animation: "typewriter", shadow: "none", textTransform: "none" }),
        words: [{ word: "لیے", isActive: false }, { word: "Extended", isActive: true, durationMs: 800 }],
        scale: 1,
        cueKey: 0,
        language: "ur",
      } as never),
    );
    const letters = (html.match(/>([A-Za-z])<\/span>/g) ?? []).map((match) => match[1]).join("");
    expect(letters.startsWith("Extended")).toBe(true);
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
