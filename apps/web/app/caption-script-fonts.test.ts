import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CAPTION_FONT_FACES, CAPTION_PILL, CAPTION_PLATE } from "@narriflow/validators";
import {
  CAPTION_FACE_OWN_SCRIPTS,
  CAPTION_INK_MARGIN_EM,
  CAPTION_SCRIPT_FACES,
  NO_CAPTION_INK,
  captionDecorationExtentEm,
  captionFaceDraws,
  captionFallbackInkEm,
  captionFallbackRuns,
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

describe("pill and plate extent", () => {
  const ANTON_CAP = 0.8594;

  test("keeps the margin under fallback ink the burn-in leaves", () => {
    const worker = readFileSync(new URL("../../worker/src/caption-ass.ts", import.meta.url), "utf8");
    expect(worker).toContain(`const CAPTION_INK_MARGIN_EM = ${CAPTION_INK_MARGIN_EM};`);
  });

  test("without fallback ink it is the catalog metrics exactly", () => {
    for (const pad of [CAPTION_PILL, CAPTION_PLATE]) {
      const extent = captionDecorationExtentEm(ANTON_CAP, pad, NO_CAPTION_INK);
      expect(extent.aboveBaselineEm).toBe(ANTON_CAP + pad.padTopEm);
      expect(extent.belowBaselineEm).toBe(pad.padBottomEm);
    }
  });

  test("grows to the fallback ink that stands above the cap height or hangs below the pad", () => {
    // Anton + Urdu مُحَبَّتُوں: the export's shaped ink is about 1.46 em above and 0.5 em below the baseline.
    const extent = captionDecorationExtentEm(ANTON_CAP, CAPTION_PILL, { topEm: 1.46, bottomEm: 0.5 });
    expect(extent.aboveBaselineEm).toBeCloseTo(1.46 + CAPTION_PILL.padTopEm, 6);
    expect(extent.belowBaselineEm).toBeCloseTo(0.5 + CAPTION_INK_MARGIN_EM, 6);
    // Ink inside the pad changes nothing.
    expect(captionDecorationExtentEm(ANTON_CAP, CAPTION_PILL, { topEm: 0.5, bottomEm: 0.1 })).toEqual(
      captionDecorationExtentEm(ANTON_CAP, CAPTION_PILL, NO_CAPTION_INK),
    );
  });
});

describe("fallback-drawn runs", () => {
  const latinOnly = (cluster: string) => /^[A-Za-z0-9 ]+$/.test(cluster);

  test("keeps neighbouring clusters and their marks together, and skips what the requested face draws", () => {
    expect(captionFallbackRuns("Hello", latinOnly)).toEqual([]);
    expect(captionFallbackRuns("مُحَبَّتُوں", latinOnly)).toEqual(["مُحَبَّتُوں"]);
    expect(captionFallbackRuns("Anton مُحَبَّت 2026 नमस्ते", latinOnly)).toEqual(["مُحَبَّت", "नमस्ते"]);
  });

  test("takes the highest and deepest ink among the runs, and none for Latin-only text", () => {
    const heights: Record<string, { topEm: number; bottomEm: number }> = {
      "مُحَبَّت": { topEm: 1.4, bottomEm: 0.2 },
      "नमस्ते": { topEm: 0.9, bottomEm: 0.6 },
    };
    const measure = (run: string) => heights[run]!;
    expect(captionFallbackInkEm("Anton مُحَبَّت x नमस्ते", latinOnly, measure)).toEqual({ topEm: 1.4, bottomEm: 0.6 });
    expect(captionFallbackInkEm("Anton", latinOnly, measure)).toBe(NO_CAPTION_INK);
  });
});

describe("which script the requested face draws", () => {
  test("Latin, digits and punctuation always; other scripts only where the face covers them", () => {
    expect(captionFaceDraws("é")).toBe(true);
    expect(captionFaceDraws("2026")).toBe(true);
    expect(captionFaceDraws("!")).toBe(true);
    expect(captionFaceDraws("م")).toBe(false);
    expect(captionFaceDraws("مُ")).toBe(false);
    expect(captionFaceDraws("क्ष")).toBe(false);
    expect(captionFaceDraws("Ж")).toBe(false);
    expect(captionFaceDraws("Ж", ["Cyrillic"])).toBe(true);
    expect(captionFaceDraws("Ω", ["Cyrillic"])).toBe(false);
    expect(captionFaceDraws("Ω", ["Cyrillic", "Greek"])).toBe(true);
  });

  test("the own-script table is what the catalog's font files cover", () => {
    // fontkit lives with the worker; ask it from there so the web graph stays free of it.
    const script = `
      import { captionFontFilePath, fontFileCovers } from "@narriflow/caption-fonts";
      import { CAPTION_FONT_FACES } from "@narriflow/validators";
      const probes = { Cyrillic: "Жщцуф", Greek: "ΩαβγΣ" };
      console.log(JSON.stringify(Object.fromEntries(CAPTION_FONT_FACES.map((face) => [face.name,
        Object.keys(probes).filter((script) => fontFileCovers(captionFontFilePath(face.file), probes[script])).sort()]))));`;
    const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: new URL("../../worker/", import.meta.url).pathname });
    expect(run.exitCode).toBe(0);
    const covered = JSON.parse(run.stdout.toString()) as Record<string, string[]>;
    for (const face of CAPTION_FONT_FACES) {
      expect([...(CAPTION_FACE_OWN_SCRIPTS[face.name] ?? [])].sort()).toEqual(covered[face.name]!);
    }
  });
});
