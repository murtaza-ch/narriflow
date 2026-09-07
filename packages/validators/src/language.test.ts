import { describe, expect, test } from "bun:test";
import {
  ASSEMBLYAI_LANGUAGES,
  ASSEMBLYAI_TRANSCRIPT_LANGUAGE_CODES,
  ASSEMBLYAI_U35_LANGUAGE_CODES,
  assemblyAiTranscriptLanguageCodeSchema,
  getAssemblyAiLanguage,
  sourceLanguageCodeFromFormValue,
  sourceLanguageCodeSchema,
} from "./language";

describe("AssemblyAI language registry", () => {
  test("contains every unique current TranscriptLanguageCode enum value", () => {
    expect(ASSEMBLYAI_TRANSCRIPT_LANGUAGE_CODES).toHaveLength(102);
    expect(new Set(ASSEMBLYAI_TRANSCRIPT_LANGUAGE_CODES).size).toBe(102);
    expect(ASSEMBLYAI_LANGUAGES).toHaveLength(102);
    expect(new Set(ASSEMBLYAI_LANGUAGES.map(({ code }) => code)).size).toBe(102);
  });

  test("maps the exact U3.5 codes to all 18 documented core languages", () => {
    expect(ASSEMBLYAI_U35_LANGUAGE_CODES).toHaveLength(21);
    const coreLanguages = new Set(
      ASSEMBLYAI_LANGUAGES.filter(
        ({ modelSupport }) => modelSupport === "u35-direct",
      ).map(({ code, label }) => {
        if (code.startsWith("en")) return "English";
        if (code === "zh") return "Chinese (Mandarin)";
        return label;
      }),
    );

    expect([...coreLanguages].sort()).toEqual(
      [
        "Arabic",
        "Chinese (Mandarin)",
        "Danish",
        "Dutch",
        "English",
        "Finnish",
        "French",
        "German",
        "Hebrew",
        "Hindi",
        "Italian",
        "Japanese",
        "Norwegian",
        "Portuguese",
        "Spanish",
        "Swedish",
        "Turkish",
        "Vietnamese",
      ].sort(),
    );
  });

  test("marks representative extended languages and official U2 bands", () => {
    expect(getAssemblyAiLanguage("ur")).toEqual(
      expect.objectContaining({
        label: "Urdu",
        modelSupport: "u2-fallback",
        accuracyBand: "good",
      }),
    );
    expect(getAssemblyAiLanguage("ko")).toEqual(
      expect.objectContaining({
        label: "Korean",
        modelSupport: "u2-fallback",
        accuracyBand: "good",
      }),
    );
    expect(getAssemblyAiLanguage("ru")).toEqual(
      expect.objectContaining({
        label: "Russian",
        modelSupport: "u2-fallback",
        accuracyBand: "high",
      }),
    );
  });

  test("preserves every previously offered manual source code", () => {
    for (const code of [
      "en",
      "es",
      "pt",
      "fr",
      "de",
      "it",
      "nl",
      "ru",
      "tr",
      "id",
      "hi",
      "ar",
      "zh",
      "ja",
      "ko",
    ]) {
      expect(assemblyAiTranscriptLanguageCodeSchema.safeParse(code).success).toBe(
        true,
      );
    }
  });

  test("normalizes official manual codes but rejects UI and invented codes", () => {
    expect(sourceLanguageCodeSchema.parse(" EN_US ")).toBe("en_us");
    expect(assemblyAiTranscriptLanguageCodeSchema.safeParse("auto").success).toBe(
      false,
    );
    expect(assemblyAiTranscriptLanguageCodeSchema.safeParse("en-US").success).toBe(
      false,
    );
    expect(assemblyAiTranscriptLanguageCodeSchema.safeParse("xx").success).toBe(
      false,
    );
  });

  test("converts Auto form mode to null", () => {
    expect(sourceLanguageCodeFromFormValue("auto")).toBeNull();
    expect(sourceLanguageCodeFromFormValue("")).toBeNull();
    expect(sourceLanguageCodeFromFormValue(null)).toBeNull();
    expect(sourceLanguageCodeFromFormValue(" UR ")).toBe("ur");
  });
});
