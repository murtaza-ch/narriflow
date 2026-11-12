import { z } from "zod";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";
import { splitUtterancesIntoSentences } from "./utterance-split";

// AI filler tagging for transcripts the built-in lists do not cover. Pure
// contract: chunking, prompt, schema, acceptance and identity. The provider
// call lives in services; this module never touches the network.
//
// Measured basis (2026-11-12, gpt-5.6-luna / low reasoning, this prompt and
// schema): 1 accepted tag in 86,659 tokens of FLEURS read speech across 102
// languages; 82% recall of Scribe-written fillers on the Nyra verbatim
// benchmark (10 languages); 125/125 English fillers and no Hindi/Urdu trap
// words on real dev clips.

export const FILLER_TAGGING_PROMPT = `You find hesitation sounds in a speech transcript, in any language.
A hesitation sound is a vocalized pause with no dictionary meaning, like English "um", "uh", "er": a sound, not a word.
For each token you consider, decide whether it is a dictionary word of the transcript's language (or of any language the speaker mixes in).
Report a token only if it is a pure hesitation sound and NOT a dictionary word.
Words never count, even when used as filler: particles, linking particles, conjunctions, articles, pronouns, honorifics, terms of address,
discourse markers ("like", "you know", "so", "well", "actually", "maybe"), interjections with meaning, replies ("yes", "no"),
backchannels ("uh-huh", "mm-hmm"), repeated or cut-off words, names and numbers.
If you are not certain, leave it out. Most transcripts contain few or no hesitation sounds; returning none is normal.`;

export const FILLER_TAGGING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["fillers"],
  properties: { fillers: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["id", "text", "is_dictionary_word", "kind"],
    properties: { id: { type: "integer" }, text: { type: "string" }, is_dictionary_word: { type: "boolean" },
      kind: { type: "string", enum: ["hesitation_sound", "discourse_word", "other_word", "unsure"] } } } } },
} as const;

/** Chunk size the measurements used (mean 125-224 words per request). */
export const FILLER_TAGGING_CHUNK_WORDS = 250;
/** 99.94% of human-labelled fillers have at most 6 letters; the model never accepted more than 4. */
export const FILLER_TAG_MAX_LETTERS = 6;
/** Bounds on what the selection input freezes: about 1 MB at most, far above
 *  a three-hour source's measured need (fillers are ~1% of words). */
export const FILLER_TAG_MAX_KEYS = 5_000;
export const FILLER_TAG_MAX_KEY_LENGTH = 200;

export interface FillerTaggingToken { speaker: number | null; word: TranscriptWord }
export interface FillerTaggingChunk {
  tokens: FillerTaggingToken[];
  /** The user message, or null when the chunk's text could forge prompt structure. */
  prompt: string | null;
}

/** Clip slicing rounds every word time this way (clip-timing normalizeTime),
 *  so a source key and its sliced word's key agree exactly. */
const keyTime = (sec: number) => Math.max(0, Math.round(sec * 1000) / 1000).toFixed(3);

/** Identity of one transcript word: speaker ("-" when unknown), exact text and millisecond timing. */
export function fillerWordKey(speaker: number | null, word: Pick<TranscriptWord, "word" | "startSec" | "endSec">): string {
  return `${speaker ?? "-"}|${word.word}|${keyTime(word.startSec)}|${keyTime(word.endSec)}`;
}

/** Letters used to compare a reported token with the transcript token:
 *  canonical composition, case-folded, letters and marks plus joiners. */
export function fillerTagLetters(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase("und").replace(/[^\p{L}\p{M}‌‍]/gu, "");
}

// Rendering separates tokens with spaces, ids with ":" and lines with "\n".
// A token containing whitespace, a line or paragraph separator or a control
// character could forge that structure ("um 17:go"), so its whole chunk goes
// untagged (no measured transcript token has one). A colon inside a token
// ("sagte:", "10:30"; in 8-19% of measured chunks) is shown as a fullwidth
// colon so it cannot read as an id separator; letters, which acceptance
// compares, are unchanged. Format characters such as ZWNJ stay (Persian).
const FORGES_STRUCTURE = /[\s\p{Z}\p{Cc}]/u;
const shownToken = (text: string) => text.replaceAll(":", "\uFF1A");

/** Sentence-split chunks of at most FILLER_TAGGING_CHUNK_WORDS words, with the prompt rendered as evaluated. */
export function chunkTranscriptForFillerTagging(utterances: TranscriptUtterance[], languageCode: string): FillerTaggingChunk[] {
  const chunks: FillerTaggingChunk[] = [];
  let lines: { speaker: number | null; words: TranscriptWord[] }[] = [];
  let count = 0;
  const flush = () => {
    if (count === 0) return;
    const tokens = lines.flatMap((line) => line.words.map((word) => ({ speaker: line.speaker, word })));
    const unsafe = tokens.some((token) => FORGES_STRUCTURE.test(token.word.word));
    let id = 0;
    const body = lines.map((line) => `S${line.speaker ?? "?"}: ${line.words.map((word) => `${id++}:${shownToken(word.word)}`).join(" ")}`).join("\n");
    chunks.push({ tokens, prompt: unsafe ? null : `Language: ${languageCode}\nTokens:\n${body}` });
    lines = [];
    count = 0;
  };
  for (const sentence of splitUtterancesIntoSentences(utterances)) {
    const words = sentence.words.filter((word) => word.word.length > 0);
    if (words.length === 0) continue;
    if (count + words.length > FILLER_TAGGING_CHUNK_WORDS) flush();
    lines.push({ speaker: sentence.speaker, words });
    count += words.length;
    if (count >= FILLER_TAGGING_CHUNK_WORDS) flush();
  }
  flush();
  return chunks;
}

const reportSchema = z.object({ fillers: z.array(z.object({ id: z.number(), text: z.string(), is_dictionary_word: z.boolean(), kind: z.string() }).passthrough()) }).passthrough();

/** Indices of chunk tokens a model report validly marks as fillers. Anything
 *  malformed accepts nothing (fail closed), and a token any entry reports
 *  otherwise (a word, unsure, mismatched text) is never accepted. */
function acceptable(token: string, item: { text: string; is_dictionary_word: boolean; kind: string }): boolean {
  if (item.kind !== "hesitation_sound" || item.is_dictionary_word !== false) return false;
  // Count letters, not combining marks: "अं" is one letter with a mark.
  const count = (token.match(/\p{L}/gu) ?? []).length;
  if (count < 1 || count > FILLER_TAG_MAX_LETTERS || fillerTagLetters(token) !== fillerTagLetters(item.text)) return false;
  if (/\p{N}/u.test(token)) return false;
  const cased = token.replace(/[^\p{L}]/gu, "");
  return !([...cased].length > 1 && cased === cased.toLocaleUpperCase("und") && cased !== cased.toLocaleLowerCase("und"));
}

/** A deliberately coarse form for the stretched-word check, where matching
 *  too much only keeps a filler: letters only, without marks, joiners or
 *  case (dotted/dotless i and final sigma folded), every repeated letter
 *  run shortened. "daaann" and "dann" both become "dan"; "و‌و‌و" becomes "و". */
export function stretchedWordForm(text: string): string {
  return coarseLetters(text).replace(/(\p{L})\1+/gu, "$1");
}

function coarseLetters(text: string): string {
  return text.normalize("NFD").replace(/[^\p{L}]/gu, "").toLocaleLowerCase("und").replace(/[ıİ]/g, "i").replace(/ς/g, "σ");
}

/** Whether a token repeats a letter in its coarse form ("Eee", "daaann", "و‌و‌و"). */
function isStretched(text: string): boolean {
  return /(\p{L})\1/u.test(coarseLetters(text));
}

/** A token written as a plain word: letters (with marks and joiners) and at
 *  most an apostrophe of spelling ("po'", "l'"), no hesitation punctuation
 *  such as commas, dots or hyphens ("э,", "а-а-а"). */
function isPlainWord(text: string): boolean {
  return /^(?:\p{L}|\p{M}|\u200c|\u200d|['’ʼ])+$/u.test(text.normalize("NFC")) && /\p{L}/u.test(text);
}

export function acceptFillerTags(chunk: FillerTaggingChunk, report: unknown): number[] {
  const parsed = reportSchema.safeParse(report);
  if (!parsed.success || chunk.prompt === null) return [];
  const accepted = new Set<number>(), vetoed = new Set<number>();
  for (const item of parsed.data.fillers) {
    if (!Number.isInteger(item.id) || item.id < 0 || item.id >= chunk.tokens.length) continue;
    (acceptable(chunk.tokens[item.id]!.word.word, item) ? accepted : vetoed).add(item.id);
  }
  return [...accepted].filter((id) => !vetoed.has(id)).sort((a, b) => a - b);
}

/**
 * Keys of accepted tokens across all chunks, minus:
 * - keys two source words share (their identity is ambiguous);
 * - stretched words: an accepted token with a repeated letter whose coarse
 *   form (`stretchedWordForm`) equals that of a word the transcript writes
 *   plainly and does not accept (function words appear mid-sentence without
 *   punctuation; hesitations are written "э,", "Э-э"). Both models accepted
 *   Portuguese "eeem" ("em") and "Eee" ("e") and Russian "Иии" ("и") in the
 *   2026-11-12 benchmark; a stretched real word is a word.
 */
export function collectFillerKeys(chunks: FillerTaggingChunk[], acceptedPerChunk: readonly (readonly number[])[]): string[] {
  const seen = new Map<string, number>();
  const wordForms = new Set<string>();
  chunks.forEach((chunk, index) => {
    const accepted = new Set(acceptedPerChunk[index] ?? []);
    chunk.tokens.forEach((token, id) => {
      const key = fillerWordKey(token.speaker, token.word);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (!accepted.has(id) && isPlainWord(token.word.word)) wordForms.add(stretchedWordForm(token.word.word));
    });
  });
  const keys = new Set<string>();
  chunks.forEach((chunk, index) => {
    for (const id of acceptedPerChunk[index] ?? []) {
      const token = chunk.tokens[id]!;
      if (isStretched(token.word.word) && wordForms.has(stretchedWordForm(token.word.word))) continue;
      const key = fillerWordKey(token.speaker, token.word);
      if (seen.get(key) === 1) keys.add(key);
    }
  });
  return [...keys].sort();
}

/** What a selection capsule freezes about AI filler tagging. */
export const fillerTaggingOutcomeSchema = z.strictObject({
  /** Every model listed must accept a token for it to count (agreement). */
  contract: z.strictObject({
    models: z.array(z.strictObject({ model: z.string().min(1).max(80), reasoningEffort: z.string().min(1).max(20) })).min(1).max(2),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    maxOutputTokens: z.number().int().positive(),
  }),
  chunks: z.number().int().nonnegative(),
  tagged: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  unsafe: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  /** True when more tags than FILLER_TAG_MAX_KEYS came back: all were dropped. */
  overflow: z.boolean(),
  keys: z.array(z.string().min(1).max(FILLER_TAG_MAX_KEY_LENGTH)).max(FILLER_TAG_MAX_KEYS),
});
export type FillerTaggingOutcome = z.infer<typeof fillerTaggingOutcomeSchema>;
