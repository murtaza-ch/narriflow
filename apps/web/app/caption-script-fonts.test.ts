import { describe, expect, test } from "bun:test";
import {
  CAPTION_SCRIPT_FACES,
  captionFallbackFamilies,
  captionFontStack,
  captionLetterSpacingRuns,
  hasUnspacedScript,
} from "./caption-script-fonts";

describe("caption font stack", () => {
  test("puts the cue language's own face before the default faces, and no other language's", () => {
    expect(captionFallbackFamilies("ja")[0]).toBe("Noto Sans JP");
    expect(captionFallbackFamilies("yue")[0]).toBe("Noto Sans TC");
    expect(captionFallbackFamilies("ur")[0]).toBe("Noto Nastaliq Urdu");
    for (const language of ["en", "ar", "zh", null]) {
      const families = captionFallbackFamilies(language);
      expect(families).not.toContain("Noto Sans JP");
      expect(families).not.toContain("Noto Nastaliq Urdu");
      expect(families[0]).toBe("Noto Sans");
    }
    expect(captionFallbackFamilies("en").slice(-2)).toEqual(["Noto Sans Symbols 2", "Noto Emoji"]);
  });

  test("starts with the requested face so a deliberate brand font wins wherever it has the glyph", () => {
    expect(captionFontStack('"Brand Font"', "ja").startsWith('"Brand Font", "Noto Sans JP"')).toBe(true);
  });
});

describe("letter spacing runs", () => {
  test("every script whose face disables letter spacing is recognised, and the others are not", () => {
    const samples: Record<string, string> = {
      "Noto Sans": "Привет", "Noto Sans Arabic": "سلام", "Noto Sans Hebrew": "שלום", "Noto Sans Devanagari": "नमस्ते", "Noto Sans Thai": "สวัสดี",
      "Noto Sans Armenian": "Բարեւ", "Noto Sans Bengali": "নমস্কার", "Noto Sans Gurmukhi": "ਸਤਿ", "Noto Sans Gujarati": "નમસ્તે",
      "Noto Sans Oriya": "ନମସ୍କାର", "Noto Sans Tamil": "வணக்கம்", "Noto Sans Telugu": "నమస్కారం", "Noto Sans Kannada": "ನಮಸ್ಕಾರ",
      "Noto Sans Malayalam": "നമസ്കാരം", "Noto Sans Sinhala": "ආයුබෝවන්", "Noto Sans Lao": "ສະບາຍດີ", "Noto Sans Khmer": "សួស្តី",
      "Noto Sans Myanmar": "မင်္ဂလာပါ", "Noto Sans Georgian": "გამარჯობა", "Noto Sans Ethiopic": "ሰላም", "Noto Sans SC": "你好",
      "Noto Sans KR": "안녕", "Noto Sans JP": "こんにちは", "Noto Sans TC": "你好", "Noto Nastaliq Urdu": "اردو",
    };
    for (const face of CAPTION_SCRIPT_FACES) {
      const sample = samples[face.family];
      expect(sample).toBeDefined();
      expect(hasUnspacedScript(sample!)).toBe(face.letterSpacing === "disabled");
    }
    expect(hasUnspacedScript("Hello 2026!")).toBe(false);
  });

  test("splits only where the script changes, and keeps digits and joiners with the run they sit in", () => {
    expect(captionLetterSpacingRuns("Hello")).toEqual([{ text: "Hello", spaced: true }]);
    expect(captionLetterSpacingRuns("سلام 2026!")).toEqual([{ text: "سلام 2026!", spaced: false }]);
    expect(captionLetterSpacingRuns("OpenAI نظام")).toEqual([
      { text: "OpenAI ", spaced: true },
      { text: "نظام", spaced: false },
    ]);
    expect(captionLetterSpacingRuns("क्षत्रिय‍")).toEqual([{ text: "क्षत्रिय‍", spaced: false }]);
  });
});
