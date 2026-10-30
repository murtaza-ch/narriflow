import { describe, expect, test } from "bun:test";
import {
  CANONICAL_TO_PROVIDER_LANGUAGE_CODE,
  PROVIDER_TO_CANONICAL_LANGUAGE_CODE,
  SCRIBE_LANGUAGES,
  SCRIBE_LANGUAGE_CODES,
  SCRIBE_MODEL_ID,
  getSourceLanguageLabel,
  languageDirection,
  languageScript,
  normalizeProviderLanguageCode,
  sourceLanguageCodeFromFormValue,
  sourceLanguageCodeSchema,
  sourceLanguageInputSchema,
  toProviderLanguageCode,
} from "./language";

describe("Scribe v2 language registry", () => {
  test("enumerates the documented 100 languages plus Yoruba", () => {
    expect(SCRIBE_MODEL_ID).toBe("scribe_v2");
    expect(SCRIBE_LANGUAGES).toHaveLength(101);
    expect(new Set(SCRIBE_LANGUAGE_CODES).size).toBe(101);
    expect(new Set(SCRIBE_LANGUAGES.map((l) => l.providerCode)).size).toBe(101);
    expect(new Set(SCRIBE_LANGUAGES.map((l) => l.label)).size).toBe(101);
  });

  test("canonical code is ISO 639-1 when one exists, else ISO 639-3", () => {
    for (const { code, providerCode } of SCRIBE_LANGUAGES) {
      expect(providerCode).toMatch(/^[a-z]{3}$/);
      expect(code).toMatch(/^[a-z]{2,3}$/);
      if (code.length === 3) expect(code).toBe(providerCode);
    }
    for (const code of ["yue", "fil", "ceb", "ast", "kea", "luo", "nso", "umb"]) {
      expect(SCRIBE_LANGUAGE_CODES).toContain(code);
    }
    expect(SCRIBE_LANGUAGE_CODES).not.toContain("tl");
  });

  test("forward and reverse maps round-trip", () => {
    for (const { code, providerCode } of SCRIBE_LANGUAGES) {
      expect(CANONICAL_TO_PROVIDER_LANGUAGE_CODE[code]).toBe(providerCode);
      expect(PROVIDER_TO_CANONICAL_LANGUAGE_CODE[providerCode]).toBe(code);
      expect(toProviderLanguageCode(code)).toBe(providerCode);
      expect(normalizeProviderLanguageCode(providerCode)).toBe(code);
      expect(normalizeProviderLanguageCode(code)).toBe(code);
    }
    expect(toProviderLanguageCode("ur")).toBe("urd");
    expect(toProviderLanguageCode("jv")).toBe("jav");
    expect(toProviderLanguageCode("yo")).toBe("yor");
    expect(toProviderLanguageCode("fil")).toBe("fil");
    expect(toProviderLanguageCode("auto")).toBeNull();
    expect(toProviderLanguageCode(null)).toBeNull();
  });

  test("normalizes provider results, aliases and regional tags", () => {
    expect(normalizeProviderLanguageCode("tl")).toBe("fil");
    expect(normalizeProviderLanguageCode("jw")).toBe("jv");
    expect(normalizeProviderLanguageCode("en_us")).toBe("en");
    expect(normalizeProviderLanguageCode("EN-AU")).toBe("en");
    expect(normalizeProviderLanguageCode("pt-BR")).toBe("pt");
    expect(normalizeProviderLanguageCode("eng")).toBe("en");
    expect(normalizeProviderLanguageCode("urd")).toBe("ur");
    expect(normalizeProviderLanguageCode("zho")).toBe("zh");
    expect(normalizeProviderLanguageCode("cmn")).toBe("zh");
    expect(normalizeProviderLanguageCode("yue")).toBe("yue");
    expect(normalizeProviderLanguageCode(" HIN ")).toBe("hi");
  });

  test("returns null for anything outside the registry", () => {
    for (const value of ["", "auto", "xx", "bre", "yi", "la", "hawaiian", null, undefined]) {
      expect(normalizeProviderLanguageCode(value)).toBeNull();
    }
  });

  test("script and direction", () => {
    expect(languageScript("ur")).toBe("Arabic");
    expect(languageScript("hi")).toBe("Devanagari");
    expect(languageScript("ja")).toBe("Japanese");
    expect(languageScript("zh")).toBe("Han");
    expect(languageScript(null)).toBeNull();
    expect(languageScript("xx")).toBeNull();
    const rtl = SCRIBE_LANGUAGES.filter((l) => l.direction === "rtl").map((l) => l.code);
    expect(rtl.sort()).toEqual(["ar", "fa", "he", "ps", "sd", "ur"]);
    expect(languageDirection("he")).toBe("rtl");
    expect(languageDirection("en")).toBe("ltr");
    expect(languageDirection(null)).toBe("ltr");
  });

  test("manual source codes are canonical only; Auto is null", () => {
    expect(sourceLanguageCodeSchema.parse(" UR ")).toBe("ur");
    expect(sourceLanguageCodeSchema.parse(null)).toBeNull();
    for (const bad of ["auto", "en-US", "en_us", "tl", "jw", "urd", "xx"]) {
      expect(sourceLanguageCodeSchema.safeParse(bad).success).toBe(false);
    }
    expect(sourceLanguageInputSchema.parse("auto")).toBeNull();
    expect(sourceLanguageInputSchema.parse("")).toBeNull();
    expect(sourceLanguageInputSchema.parse("Fil")).toBe("fil");
    expect(sourceLanguageInputSchema.safeParse("klingon").success).toBe(false);
  });

  test("converts Auto form mode to null and labels codes", () => {
    expect(sourceLanguageCodeFromFormValue("auto")).toBeNull();
    expect(sourceLanguageCodeFromFormValue("")).toBeNull();
    expect(sourceLanguageCodeFromFormValue(null)).toBeNull();
    expect(sourceLanguageCodeFromFormValue(" UR ")).toBe("ur");
    expect(getSourceLanguageLabel(null)).toBe("Auto-detect");
    expect(getSourceLanguageLabel("ur")).toBe("Urdu");
    expect(getSourceLanguageLabel("yue")).toBe("Cantonese");
  });
});
