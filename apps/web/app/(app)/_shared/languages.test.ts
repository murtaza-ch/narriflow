import { expect, test } from "bun:test";
import { SCRIBE_LANGUAGES, sourceLanguageCodeFromFormValue } from "@narriflow/validators";
import { LANGUAGE_OPTIONS } from "./languages";

test("the language picker is one flat list: Auto first, then every Scribe language once", () => {
  expect(LANGUAGE_OPTIONS[0]).toEqual({ code: "auto", label: "Auto-detect · recommended" });
  expect(LANGUAGE_OPTIONS.slice(1).map((option) => option.code)).toEqual(SCRIBE_LANGUAGES.map((language) => language.code));
  expect(new Set(LANGUAGE_OPTIONS.map((option) => option.code)).size).toBe(LANGUAGE_OPTIONS.length);
});

test("every option is a name the pickers show whole, and a code the intake accepts", () => {
  for (const option of LANGUAGE_OPTIONS.slice(1)) {
    // Recipe and picker summaries cut a label at " · " to drop Auto's "recommended".
    expect(option.label.split(" · ")[0]).toBe(option.label);
    expect(option.label).not.toMatch(/accuracy|model|beta|experimental/i);
    expect(sourceLanguageCodeFromFormValue(option.code)).toBe(option.code);
  }
  expect(sourceLanguageCodeFromFormValue("auto")).toBeNull();
});
