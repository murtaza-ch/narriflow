import { describe, expect, test } from "bun:test";
import { CAPTION_FALLBACK_FONTS } from "./fallback-fonts";
import { canonicalCaptionLanguage, captionRunScript, LOCALE_LEAD_SCRIPTS, orderCaptionFallbackFaces } from "./locale-precedence";

const scriptFaces = CAPTION_FALLBACK_FONTS.filter((font) => font.role === "script");
const order = (language: string | null, text: string) => orderCaptionFallbackFaces(scriptFaces, language, text).map((font) => font.assName);
const defaultOrder = scriptFaces.map((font) => font.assName);

describe("locale font precedence", () => {
  test("Japanese Han and kana try Noto Sans JP before the generic Han face", () => {
    expect(order("ja", "漢字")[0]).toBe("Noto Sans JP");
    expect(order("ja", "ひらがな")[0]).toBe("Noto Sans JP");
    expect(order("ja", "カタカナー")[0]).toBe("Noto Sans JP");
    expect(order("ja-JP", "漢")[0]).toBe("Noto Sans JP");
  });

  test("Cantonese Han tries Noto Sans TC first; kana stays with the default order", () => {
    expect(order("yue", "我哋")[0]).toBe("Noto Sans TC");
    expect(order("yue", "ひらがな")).toEqual(defaultOrder);
  });

  test("Urdu Arabic-script runs try Nastaliq first, other Arabic-script languages do not", () => {
    expect(order("ur", "زبان")[0]).toBe("Noto Nastaliq Urdu Regular");
    expect(order("fa", "زبان")).toEqual(defaultOrder);
    expect(order("ar", "زبان")).toEqual(defaultOrder);
  });

  test("Mandarin and unknown languages keep the catalog order, which starts the Han run at Noto Sans SC", () => {
    expect(order("zh", "漢字")).toEqual(defaultOrder);
    expect(defaultOrder.indexOf("Noto Sans SC")).toBeLessThan(defaultOrder.indexOf("Noto Sans JP"));
    expect(defaultOrder.indexOf("Noto Sans SC")).toBeLessThan(defaultOrder.indexOf("Noto Sans TC"));
    expect(order(null, "漢字")).toEqual(defaultOrder);
    expect(order("xx", "漢字")).toEqual(defaultOrder);
  });

  test("a language's face leads only the scripts it owns", () => {
    expect(order("ja", "Hello")).toEqual(defaultOrder);
    expect(order("ur", "漢字")).toEqual(defaultOrder);
    expect(order("ja", "مرحبا")).toEqual(defaultOrder);
  });

  test("the reordering keeps every face once and the others in their relative order", () => {
    const reordered = order("ja", "漢");
    expect([...reordered].sort()).toEqual([...defaultOrder].sort());
    expect(reordered.slice(1)).toEqual(defaultOrder.filter((name) => name !== "Noto Sans JP"));
  });

  test("every language-aware face in the catalog is led by a language the table knows", () => {
    for (const font of CAPTION_FALLBACK_FONTS) {
      if (!("languages" in font)) continue;
      for (const language of font.languages) expect(Object.keys(LOCALE_LEAD_SCRIPTS)).toContain(language);
    }
    for (const language of Object.keys(LOCALE_LEAD_SCRIPTS)) {
      expect(CAPTION_FALLBACK_FONTS.some((font) => "languages" in font && (font.languages as readonly string[]).includes(language))).toBe(true);
    }
  });

  test("script classes and language normalization", () => {
    expect(captionRunScript("、漢")).toBe("han");
    expect(captionRunScript("123 ひ")).toBe("kana");
    expect(captionRunScript("۱۲ زبان")).toBe("arabic");
    expect(captionRunScript("abc")).toBe("other");
    expect(captionRunScript("123")).toBe("other");
    expect(canonicalCaptionLanguage(" JA_jp ")).toBe("ja");
    expect(canonicalCaptionLanguage(null)).toBeNull();
    expect(canonicalCaptionLanguage("")).toBeNull();
  });
});
