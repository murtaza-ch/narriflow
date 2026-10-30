import { SCRIBE_LANGUAGES, type SourceLanguageCodeValue } from "@narriflow/validators";

export type LanguageOption = Readonly<{
  code: SourceLanguageCodeValue | "auto";
  label: string;
}>;

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = Object.freeze([
  Object.freeze({ code: "auto", label: "Auto-detect · recommended" }),
  ...SCRIBE_LANGUAGES.map(({ code, label }) => Object.freeze({ code, label })),
]);
