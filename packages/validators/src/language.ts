import { z } from "zod";

/** ElevenLabs speech-to-text model every transcript is produced with. */
export const SCRIBE_MODEL_ID = "scribe_v2";

export type LanguageScript =
  | "Latin"
  | "Cyrillic"
  | "Greek"
  | "Arabic"
  | "Hebrew"
  | "Han"
  | "Japanese"
  | "Hangul"
  | "Devanagari"
  | "Bengali"
  | "Gurmukhi"
  | "Gujarati"
  | "Oriya"
  | "Tamil"
  | "Telugu"
  | "Kannada"
  | "Malayalam"
  | "Sinhala"
  | "Thai"
  | "Lao"
  | "Khmer"
  | "Myanmar"
  | "Armenian"
  | "Georgian"
  | "Ethiopic";

export type LanguageDirection = "ltr" | "rtl";

/**
 * Scribe v2's catalog (https://elevenlabs.io/docs/overview/capabilities/speech-to-text,
 * 100 listed languages) plus Yoruba, which the API accepts and the page lists
 * only in its accuracy breakdown. Rows: canonical code, label, the ISO 639-3
 * code Scribe sends and returns, and the language's primary script (a script
 * variant such as Serbian Latin or Sorani Kurdish cannot be told apart by
 * language alone; cue direction and fonts follow the text itself).
 *
 * Canonical code = ISO 639-1 where one exists, else ISO 639-3. Ordered by label.
 */
const SCRIBE_LANGUAGE_ROWS = [
  ["af", "Afrikaans", "afr", "Latin"],
  ["am", "Amharic", "amh", "Ethiopic"],
  ["ar", "Arabic", "ara", "Arabic"],
  ["hy", "Armenian", "hye", "Armenian"],
  ["as", "Assamese", "asm", "Bengali"],
  ["ast", "Asturian", "ast", "Latin"],
  ["az", "Azerbaijani", "aze", "Latin"],
  ["be", "Belarusian", "bel", "Cyrillic"],
  ["bn", "Bengali", "ben", "Bengali"],
  ["bs", "Bosnian", "bos", "Latin"],
  ["bg", "Bulgarian", "bul", "Cyrillic"],
  ["my", "Burmese", "mya", "Myanmar"],
  ["yue", "Cantonese", "yue", "Han"],
  ["ca", "Catalan", "cat", "Latin"],
  ["ceb", "Cebuano", "ceb", "Latin"],
  ["ny", "Chichewa", "nya", "Latin"],
  ["zh", "Chinese", "zho", "Han"],
  ["hr", "Croatian", "hrv", "Latin"],
  ["cs", "Czech", "ces", "Latin"],
  ["da", "Danish", "dan", "Latin"],
  ["nl", "Dutch", "nld", "Latin"],
  ["en", "English", "eng", "Latin"],
  ["et", "Estonian", "est", "Latin"],
  ["fil", "Filipino", "fil", "Latin"],
  ["fi", "Finnish", "fin", "Latin"],
  ["fr", "French", "fra", "Latin"],
  ["ff", "Fulah", "ful", "Latin"],
  ["gl", "Galician", "glg", "Latin"],
  ["lg", "Ganda", "lug", "Latin"],
  ["ka", "Georgian", "kat", "Georgian"],
  ["de", "German", "deu", "Latin"],
  ["el", "Greek", "ell", "Greek"],
  ["gu", "Gujarati", "guj", "Gujarati"],
  ["ha", "Hausa", "hau", "Latin"],
  ["he", "Hebrew", "heb", "Hebrew"],
  ["hi", "Hindi", "hin", "Devanagari"],
  ["hu", "Hungarian", "hun", "Latin"],
  ["is", "Icelandic", "isl", "Latin"],
  ["ig", "Igbo", "ibo", "Latin"],
  ["id", "Indonesian", "ind", "Latin"],
  ["ga", "Irish", "gle", "Latin"],
  ["it", "Italian", "ita", "Latin"],
  ["ja", "Japanese", "jpn", "Japanese"],
  ["jv", "Javanese", "jav", "Latin"],
  ["kea", "Kabuverdianu", "kea", "Latin"],
  ["kn", "Kannada", "kan", "Kannada"],
  ["kk", "Kazakh", "kaz", "Cyrillic"],
  ["km", "Khmer", "khm", "Khmer"],
  ["ko", "Korean", "kor", "Hangul"],
  ["ku", "Kurdish", "kur", "Latin"],
  ["ky", "Kyrgyz", "kir", "Cyrillic"],
  ["lo", "Lao", "lao", "Lao"],
  ["lv", "Latvian", "lav", "Latin"],
  ["ln", "Lingala", "lin", "Latin"],
  ["lt", "Lithuanian", "lit", "Latin"],
  ["luo", "Luo", "luo", "Latin"],
  ["lb", "Luxembourgish", "ltz", "Latin"],
  ["mk", "Macedonian", "mkd", "Cyrillic"],
  ["ms", "Malay", "msa", "Latin"],
  ["ml", "Malayalam", "mal", "Malayalam"],
  ["mt", "Maltese", "mlt", "Latin"],
  ["mi", "Māori", "mri", "Latin"],
  ["mr", "Marathi", "mar", "Devanagari"],
  ["mn", "Mongolian", "mon", "Cyrillic"],
  ["ne", "Nepali", "nep", "Devanagari"],
  ["nso", "Northern Sotho", "nso", "Latin"],
  ["no", "Norwegian", "nor", "Latin"],
  ["oc", "Occitan", "oci", "Latin"],
  ["or", "Odia", "ori", "Oriya"],
  ["ps", "Pashto", "pus", "Arabic"],
  ["fa", "Persian", "fas", "Arabic"],
  ["pl", "Polish", "pol", "Latin"],
  ["pt", "Portuguese", "por", "Latin"],
  ["pa", "Punjabi", "pan", "Gurmukhi"],
  ["ro", "Romanian", "ron", "Latin"],
  ["ru", "Russian", "rus", "Cyrillic"],
  ["sr", "Serbian", "srp", "Cyrillic"],
  ["sn", "Shona", "sna", "Latin"],
  ["sd", "Sindhi", "snd", "Arabic"],
  ["si", "Sinhala", "sin", "Sinhala"],
  ["sk", "Slovak", "slk", "Latin"],
  ["sl", "Slovenian", "slv", "Latin"],
  ["so", "Somali", "som", "Latin"],
  ["es", "Spanish", "spa", "Latin"],
  ["sw", "Swahili", "swa", "Latin"],
  ["sv", "Swedish", "swe", "Latin"],
  ["tg", "Tajik", "tgk", "Cyrillic"],
  ["ta", "Tamil", "tam", "Tamil"],
  ["te", "Telugu", "tel", "Telugu"],
  ["th", "Thai", "tha", "Thai"],
  ["tr", "Turkish", "tur", "Latin"],
  ["uk", "Ukrainian", "ukr", "Cyrillic"],
  ["umb", "Umbundu", "umb", "Latin"],
  ["ur", "Urdu", "urd", "Arabic"],
  ["uz", "Uzbek", "uzb", "Latin"],
  ["vi", "Vietnamese", "vie", "Latin"],
  ["cy", "Welsh", "cym", "Latin"],
  ["wo", "Wolof", "wol", "Latin"],
  ["xh", "Xhosa", "xho", "Latin"],
  ["yo", "Yoruba", "yor", "Latin"],
  ["zu", "Zulu", "zul", "Latin"],
] as const;

export type SourceLanguageCodeValue =
  (typeof SCRIBE_LANGUAGE_ROWS)[number][0];

export type ScribeLanguage = Readonly<{
  /** Canonical stored code: ISO 639-1 when it exists, else ISO 639-3. */
  code: SourceLanguageCodeValue;
  label: string;
  /** ISO 639-3 code sent to and returned by Scribe. */
  providerCode: string;
  script: LanguageScript;
  direction: LanguageDirection;
}>;

export const SCRIBE_LANGUAGES: readonly ScribeLanguage[] = Object.freeze(
  SCRIBE_LANGUAGE_ROWS.map(([code, label, providerCode, script]) =>
    Object.freeze({
      code,
      label,
      providerCode,
      script,
      direction: (script === "Arabic" || script === "Hebrew"
        ? "rtl"
        : "ltr") as LanguageDirection,
    }),
  ),
);

export const SCRIBE_LANGUAGE_CODES = Object.freeze(
  SCRIBE_LANGUAGES.map(({ code }) => code),
);

const LANGUAGE_BY_CODE: ReadonlyMap<string, ScribeLanguage> = new Map(
  SCRIBE_LANGUAGES.map((language) => [language.code, language]),
);

/** Canonical code -> the ISO 639-3 code Scribe expects as `language_code`. */
export const CANONICAL_TO_PROVIDER_LANGUAGE_CODE: Readonly<
  Record<SourceLanguageCodeValue, string>
> = Object.freeze(
  Object.fromEntries(
    SCRIBE_LANGUAGES.map(({ code, providerCode }) => [code, providerCode]),
  ) as Record<SourceLanguageCodeValue, string>,
);

/**
 * ISO 639-3 code Scribe returns -> canonical code. `cmn` is not documented as
 * a request code but the page and the API use it for Mandarin, so detection
 * results accept it.
 */
export const PROVIDER_TO_CANONICAL_LANGUAGE_CODE: Readonly<
  Record<string, SourceLanguageCodeValue>
> = Object.freeze({
  ...Object.fromEntries(
    SCRIBE_LANGUAGES.map(({ code, providerCode }) => [providerCode, code]),
  ),
  cmn: "zh",
});

/** Retired or alternate codes that map onto a registry language (`tl` is what Scribe calls `fil`). */
const LANGUAGE_CODE_ALIASES: Readonly<Record<string, SourceLanguageCodeValue>> =
  Object.freeze({ tl: "fil", jw: "jv" });

const SOURCE_LANGUAGE_CODE_ENUM = SCRIBE_LANGUAGE_CODES as unknown as readonly [
  SourceLanguageCodeValue,
  ...SourceLanguageCodeValue[],
];

/**
 * Maps any language tag a provider or older record may carry to a registry
 * code, or null when the language is not in the registry: ISO 639-3 (`urd`,
 * `eng`, `zho`, `cmn`), canonical codes, aliases (`tl`, `jw`) and regional
 * tags (`en_us`, `pt-BR`, `zh-TW`), which keep only the language.
 */
export function normalizeProviderLanguageCode(
  code: string | null | undefined,
): SourceLanguageCodeValue | null {
  if (typeof code !== "string") return null;
  const normalized = code.trim().toLowerCase().replaceAll("_", "-");
  if (!normalized) return null;
  const direct = lookupLanguageCode(normalized);
  if (direct) return direct;
  const [language = ""] = normalized.split("-");
  return language === normalized ? null : lookupLanguageCode(language);
}

function lookupLanguageCode(code: string): SourceLanguageCodeValue | null {
  if (LANGUAGE_BY_CODE.has(code)) return code as SourceLanguageCodeValue;
  return (
    PROVIDER_TO_CANONICAL_LANGUAGE_CODE[code] ??
    LANGUAGE_CODE_ALIASES[code] ??
    null
  );
}

/** ISO 639-3 code to send Scribe for a canonical code, or null when unsupported. */
export function toProviderLanguageCode(
  code: string | null | undefined,
): string | null {
  return typeof code === "string"
    ? (LANGUAGE_BY_CODE.get(code)?.providerCode ?? null)
    : null;
}

export function getScribeLanguage(
  code: string | null | undefined,
): ScribeLanguage | null {
  return typeof code === "string" ? (LANGUAGE_BY_CODE.get(code) ?? null) : null;
}

/** Primary script of a registry language; null for Auto or an unknown code. */
export function languageScript(
  code: string | null | undefined,
): LanguageScript | null {
  return getScribeLanguage(code)?.script ?? null;
}

/** Default text direction of a registry language; `ltr` for Auto or an unknown code. */
export function languageDirection(
  code: string | null | undefined,
): LanguageDirection {
  return getScribeLanguage(code)?.direction ?? "ltr";
}

export const scribeLanguageCodeSchema = z.enum(SOURCE_LANGUAGE_CODE_ENUM);

/** A manual canonical language code, or null when automatic detection is used. */
export const sourceLanguageCodeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  scribeLanguageCodeSchema.nullable(),
);

export type SourceLanguageCode = z.infer<typeof sourceLanguageCodeSchema>;

/**
 * Browser input for a source language: the picker's `auto` (or an empty value)
 * means automatic detection and is stored as null; anything else must be a
 * canonical code. Use at HTTP boundaries so `auto` never reaches the worker.
 */
export const sourceLanguageInputSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "auto" ? null : normalized;
}, scribeLanguageCodeSchema.nullable());

export function sourceLanguageCodeFromFormValue(
  value: unknown,
): SourceLanguageCode {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "auto") return null;
    return sourceLanguageCodeSchema.parse(normalized);
  }
  return sourceLanguageCodeSchema.parse(value);
}

export function getSourceLanguageLabel(code: SourceLanguageCode): string {
  return code === null ? "Auto-detect" : LANGUAGE_BY_CODE.get(code)!.label;
}
