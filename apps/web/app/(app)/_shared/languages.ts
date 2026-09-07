import {
  ASSEMBLYAI_LANGUAGES,
  getAssemblyAiAccuracyLabel,
  type AssemblyAiTranscriptLanguageCode,
} from "@narriflow/validators";

export type LanguageOption = Readonly<{
  code: AssemblyAiTranscriptLanguageCode | "auto";
  label: string;
}>;

const coreLanguages = ASSEMBLYAI_LANGUAGES.filter(
  (language) => language.modelSupport === "u35-direct",
);
const extendedLanguages = ASSEMBLYAI_LANGUAGES.filter(
  (language) => language.modelSupport === "u2-fallback",
);

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = Object.freeze([
  Object.freeze({ code: "auto", label: "Auto-detect · recommended" }),
  ...coreLanguages.map((language) =>
    Object.freeze({
      code: language.code,
      label: `${language.label} · U3.5 Pro`,
    }),
  ),
  ...extendedLanguages.map((language) =>
    Object.freeze({
      code: language.code,
      label: `${language.label} · Universal-2${
        language.accuracyBand
          ? ` · ${getAssemblyAiAccuracyLabel(language.accuracyBand)}`
          : ""
      }`,
    }),
  ),
]);
