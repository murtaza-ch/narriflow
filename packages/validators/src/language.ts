import { z } from "zod";

/**
 * AssemblyAI's current submit-transcript language enum. It contains 102 codes
 * for 99 languages because English exposes global, Australian, British and US
 * variants. Keep this list aligned with TranscriptLanguageCode; `auto` is a UI
 * mode and must never be sent as `language_code`.
 */
export const ASSEMBLYAI_TRANSCRIPT_LANGUAGE_CODES = Object.freeze([
  "en",
  "en_au",
  "en_uk",
  "en_us",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "af",
  "sq",
  "am",
  "ar",
  "hy",
  "as",
  "az",
  "ba",
  "eu",
  "be",
  "bn",
  "bs",
  "br",
  "bg",
  "my",
  "ca",
  "zh",
  "hr",
  "cs",
  "da",
  "et",
  "fo",
  "fi",
  "gl",
  "ka",
  "el",
  "gu",
  "ht",
  "ha",
  "haw",
  "he",
  "hi",
  "hu",
  "is",
  "id",
  "ja",
  "jw",
  "kn",
  "kk",
  "km",
  "ko",
  "lo",
  "la",
  "lv",
  "ln",
  "lt",
  "lb",
  "mk",
  "mg",
  "ms",
  "ml",
  "mt",
  "mi",
  "mr",
  "mn",
  "ne",
  "no",
  "nn",
  "oc",
  "pa",
  "ps",
  "fa",
  "pl",
  "ro",
  "ru",
  "sa",
  "sr",
  "sn",
  "sd",
  "si",
  "sk",
  "sl",
  "so",
  "su",
  "sw",
  "sv",
  "tl",
  "tg",
  "ta",
  "tt",
  "te",
  "th",
  "bo",
  "tr",
  "tk",
  "uk",
  "ur",
  "uz",
  "vi",
  "cy",
  "yi",
  "yo",
] as const);

export type AssemblyAiTranscriptLanguageCode =
  (typeof ASSEMBLYAI_TRANSCRIPT_LANGUAGE_CODES)[number];

export const ASSEMBLYAI_SPEECH_MODEL_CHAIN = Object.freeze([
  "universal-3-5-pro",
  "universal-2",
] as const);

/** 21 exact provider codes representing AssemblyAI's 18 U3.5 core languages. */
export const ASSEMBLYAI_U35_LANGUAGE_CODES = Object.freeze([
  "ar",
  "zh",
  "da",
  "nl",
  "en",
  "en_au",
  "en_uk",
  "en_us",
  "fi",
  "fr",
  "de",
  "he",
  "hi",
  "it",
  "ja",
  "no",
  "pt",
  "es",
  "sv",
  "tr",
  "vi",
] as const satisfies readonly AssemblyAiTranscriptLanguageCode[]);

const LANGUAGE_LABELS = Object.freeze({
  en: "English (global)",
  en_au: "English (Australian)",
  en_uk: "English (British)",
  en_us: "English (US)",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  af: "Afrikaans",
  sq: "Albanian",
  am: "Amharic",
  ar: "Arabic",
  hy: "Armenian",
  as: "Assamese",
  az: "Azerbaijani",
  ba: "Bashkir",
  eu: "Basque",
  be: "Belarusian",
  bn: "Bengali",
  bs: "Bosnian",
  br: "Breton",
  bg: "Bulgarian",
  my: "Burmese",
  ca: "Catalan",
  zh: "Chinese",
  hr: "Croatian",
  cs: "Czech",
  da: "Danish",
  et: "Estonian",
  fo: "Faroese",
  fi: "Finnish",
  gl: "Galician",
  ka: "Georgian",
  el: "Greek",
  gu: "Gujarati",
  ht: "Haitian",
  ha: "Hausa",
  haw: "Hawaiian",
  he: "Hebrew",
  hi: "Hindi",
  hu: "Hungarian",
  is: "Icelandic",
  id: "Indonesian",
  ja: "Japanese",
  jw: "Javanese",
  kn: "Kannada",
  kk: "Kazakh",
  km: "Khmer",
  ko: "Korean",
  lo: "Lao",
  la: "Latin",
  lv: "Latvian",
  ln: "Lingala",
  lt: "Lithuanian",
  lb: "Luxembourgish",
  mk: "Macedonian",
  mg: "Malagasy",
  ms: "Malay",
  ml: "Malayalam",
  mt: "Maltese",
  mi: "Maori",
  mr: "Marathi",
  mn: "Mongolian",
  ne: "Nepali",
  no: "Norwegian",
  nn: "Norwegian Nynorsk",
  oc: "Occitan",
  pa: "Panjabi",
  ps: "Pashto",
  fa: "Persian",
  pl: "Polish",
  ro: "Romanian",
  ru: "Russian",
  sa: "Sanskrit",
  sr: "Serbian",
  sn: "Shona",
  sd: "Sindhi",
  si: "Sinhala",
  sk: "Slovak",
  sl: "Slovenian",
  so: "Somali",
  su: "Sundanese",
  sw: "Swahili",
  sv: "Swedish",
  tl: "Tagalog",
  tg: "Tajik",
  ta: "Tamil",
  tt: "Tatar",
  te: "Telugu",
  th: "Thai",
  bo: "Tibetan",
  tr: "Turkish",
  tk: "Turkmen",
  uk: "Ukrainian",
  ur: "Urdu",
  uz: "Uzbek",
  vi: "Vietnamese",
  cy: "Welsh",
  yi: "Yiddish",
  yo: "Yoruba",
} satisfies Record<AssemblyAiTranscriptLanguageCode, string>);

export type AssemblyAiAccuracyBand = "high" | "good" | "moderate" | "fair";
export type AssemblyAiModelSupport = "u35-direct" | "u2-fallback";

export type AssemblyAiLanguage = Readonly<{
  code: AssemblyAiTranscriptLanguageCode;
  label: string;
  modelSupport: AssemblyAiModelSupport;
  /** Universal-2 WER band from the official supported-languages table. */
  accuracyBand: AssemblyAiAccuracyBand | null;
}>;

const U35_LANGUAGE_CODE_SET = new Set<string>(ASSEMBLYAI_U35_LANGUAGE_CODES);

const HIGH_ACCURACY_CODES = new Set<AssemblyAiTranscriptLanguageCode>([
  "en",
  "en_au",
  "en_uk",
  "en_us",
  "es",
  "fr",
  "de",
  "id",
  "it",
  "ja",
  "nl",
  "pl",
  "pt",
  "ru",
  "sv",
  "tr",
  "uk",
  "ca",
]);

const GOOD_ACCURACY_CODES = new Set<AssemblyAiTranscriptLanguageCode>([
  "ar",
  "az",
  "bg",
  "bs",
  "zh",
  "cs",
  "da",
  "el",
  "et",
  "fi",
  "gl",
  "he",
  "hi",
  "hr",
  "hu",
  "ko",
  "mk",
  "ms",
  "no",
  "ro",
  "sk",
  "tl",
  "th",
  "ur",
  "vi",
]);

const MODERATE_ACCURACY_CODES = new Set<AssemblyAiTranscriptLanguageCode>([
  "af",
  "be",
  "cy",
  "fa",
  "hy",
  "is",
  "kk",
  "lt",
  "lv",
  "mi",
  "mr",
  "sl",
  "sw",
  "ta",
]);

const FAIR_ACCURACY_CODES = new Set<AssemblyAiTranscriptLanguageCode>([
  "am",
  "as",
  "bn",
  "gu",
  "ha",
  "jw",
  "ka",
  "km",
  "kn",
  "lb",
  "ln",
  "lo",
  "ml",
  "mn",
  "mt",
  "my",
  "ne",
  "oc",
  "pa",
  "ps",
  "sd",
  "sn",
  "so",
  "sr",
  "te",
  "tg",
  "uz",
  "yo",
]);

function accuracyBandForCode(
  code: AssemblyAiTranscriptLanguageCode,
): AssemblyAiAccuracyBand | null {
  if (HIGH_ACCURACY_CODES.has(code)) return "high";
  if (GOOD_ACCURACY_CODES.has(code)) return "good";
  if (MODERATE_ACCURACY_CODES.has(code)) return "moderate";
  if (FAIR_ACCURACY_CODES.has(code)) return "fair";
  return null;
}

export const ASSEMBLYAI_LANGUAGES: readonly AssemblyAiLanguage[] =
  Object.freeze(
    ASSEMBLYAI_TRANSCRIPT_LANGUAGE_CODES.map((code) =>
      Object.freeze({
        code,
        label: LANGUAGE_LABELS[code],
        modelSupport: U35_LANGUAGE_CODE_SET.has(code)
          ? "u35-direct"
          : "u2-fallback",
        accuracyBand: accuracyBandForCode(code),
      }),
    ),
  );

const LANGUAGE_BY_CODE = new Map(
  ASSEMBLYAI_LANGUAGES.map((language) => [language.code, language]),
);

export const assemblyAiTranscriptLanguageCodeSchema = z.enum(
  ASSEMBLYAI_TRANSCRIPT_LANGUAGE_CODES,
);

/** A manual provider language code, or null when automatic detection is used. */
export const sourceLanguageCodeSchema = z.preprocess(
  (value) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  assemblyAiTranscriptLanguageCodeSchema.nullable(),
);

export type SourceLanguageCode = z.infer<typeof sourceLanguageCodeSchema>;

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

export function getAssemblyAiLanguage(
  code: AssemblyAiTranscriptLanguageCode,
): AssemblyAiLanguage {
  return LANGUAGE_BY_CODE.get(code)!;
}

export function getSourceLanguageLabel(code: SourceLanguageCode): string {
  return code === null ? "Auto-detect" : getAssemblyAiLanguage(code).label;
}

export function getAssemblyAiAccuracyLabel(
  band: AssemblyAiAccuracyBand,
): string {
  switch (band) {
    case "high":
      return "high accuracy (≤10% WER)";
    case "good":
      return "good accuracy (>10–25% WER)";
    case "moderate":
      return "moderate accuracy (>25–50% WER)";
    case "fair":
      return "fair accuracy (>50% WER)";
  }
}
