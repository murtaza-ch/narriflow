import { z } from "zod";
import { CAPTION_EMPHASIS_EN } from "./caption-emphasis-words-en";
import { CAPTION_EMPHASIS_HI } from "./caption-emphasis-words-hi";
import { CAPTION_EMPHASIS_ROMAN } from "./caption-emphasis-words-roman";
import { CAPTION_EMPHASIS_UR } from "./caption-emphasis-words-ur";
import { normalizeProviderLanguageCode } from "./language";
import { isNoSpaceScriptChar } from "./text-script";

// Caption Roles for dynamic caption styles: which word of a cue is the hero,
// which are minor (closed-class, drawn small) and which are body. A
// deterministic scorer over transcript words, timings and language; it runs
// in the browser and the worker, so it is pure code-point arithmetic with no
// `Intl` or locale API (browser and Bun ICU differ).

/** The part a word plays in a Caption Block. */
export type CaptionWordRole = "hero" | "body" | "minor";

/** A user's choice for one Word Key: be the hero, be the hero with the next word, or never be the hero. */
export const captionEmphasisOverrideSchema = z.enum(["hero", "pair", "plain"]);
export type CaptionEmphasisOverride = z.infer<typeof captionEmphasisOverrideSchema>;

/** Stored overrides per clip. Overrides whose key matches no word are kept, not cleaned up. */
export const CAPTION_EMPHASIS_OVERRIDE_LIMIT = 2000;

export interface CaptionEmphasisWord {
  /** Word Key; null for dub captions. */
  readonly key: string | null;
  /** Transcript text before punctuation stripping and case. */
  readonly raw: string;
  readonly sourceStartSec: number;
  /** The word's own end, not the next word's start. */
  readonly sourceEndSec: number;
  readonly utteranceIndex: number;
  readonly utteranceFinal: boolean;
  /** Edited-time gap to the previous kept word. */
  readonly pauseBeforeSec: number;
  /** A censor caption mask applies. */
  readonly masked: boolean;
}

export type CaptionEmphasisPolicy = "auto" | "never";

/** Starting weights. Tune only on the tuning half of the G1 sheet. */
export const CAPTION_EMPHASIS_WEIGHTS = {
  number: 2.0,
  negation: 1.0,
  power: 1.0,
  /** Stretch score is `clamp(ratio - stretchFloor, 0, 1) * stretchMax`. */
  stretchMax: 1.5,
  stretchFloor: 1.15,
  pause: 1.0,
  pauseMinSec: 0.25,
  allCaps: 1.0,
  sentenceFinal: 1.0,
  topic: 0.5,
  topicMinCount: 3,
  cueFinal: 0.25,
  capitalised: 0.25,
  lengthPerLetter: 0.05,
  lengthMax: 0.5,
  repeat: -1.0,
  gateMinScore: 1.5,
  gateMargin: 0.5,
} as const;

export type CaptionEmphasisWeights = { readonly [K in keyof typeof CAPTION_EMPHASIS_WEIGHTS]: number };

export interface CaptionEmphasisInput {
  readonly cues: readonly (readonly CaptionEmphasisWord[])[];
  readonly language: string | null;
  readonly overrides: Readonly<Record<string, CaptionEmphasisOverride>>;
  readonly policy: CaptionEmphasisPolicy;
  /** Tuning only; production uses `CAPTION_EMPHASIS_WEIGHTS`. */
  readonly weights?: CaptionEmphasisWeights;
}

export interface CaptionCueRoles {
  /** Parallel to the cue's words. */
  readonly roles: CaptionWordRole[];
  /** Inclusive word indexes of the hero (one word or a 2-word unit), or null. */
  readonly heroSpan: readonly [number, number] | null;
}

/** A word's Word Key: its source start time in whole milliseconds. */
export function captionWordKey(sourceStartSec: number): string {
  return String(Math.round(sourceStartSec * 1000));
}

interface WordList {
  readonly minor: ReadonlySet<string>;
  readonly filler: ReadonlySet<string>;
  readonly negation: ReadonlySet<string>;
  readonly number: ReadonlySet<string>;
  readonly power: ReadonlySet<string>;
}

const MARK_RE = /\p{M}/u;
const LETTER_RE = /\p{L}/u;
const NUMERIC_RE = /[\p{Nd}%٪\p{Sc}]/u;
const DIGIT_RE = /\p{Nd}/u;
const WHITESPACE_RE = /\s/u;
const ARABIC_RE = /\p{Script=Arabic}/u;
const DEVANAGARI_RE = /\p{Script=Devanagari}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const SENTENCE_END_RE = /[.!?…۔؟।॥。！？]["'”’)\]»]*$/u;

/** Lowercase, Urdu letter forms, no Arabic vowel marks, letters/marks/digits and inner apostrophes only. */
function normaliseWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’‘ʼ`]/g, "'")
    .replace(/[ً-ٰٟ]/g, "")
    .replace(/ك/g, "ک")
    .replace(/[يى]/g, "ی")
    .replace(/ه/g, "ہ")
    .replace(/[^\p{L}\p{M}\p{N}']/gu, "")
    .replace(/^'+|'+$/g, "");
}

/** Code points excluding combining marks and apostrophes. */
function letterCount(normalised: string): number {
  let count = 0;
  for (const char of normalised) if (char !== "'" && !MARK_RE.test(char)) count += 1;
  return count;
}

function wordSet(words: string): ReadonlySet<string> {
  return new Set(words.split(/\s+/).filter(Boolean).map(normaliseWord));
}

function wordList(source: Readonly<Record<keyof WordList, string>>): WordList {
  return {
    minor: wordSet(source.minor),
    filler: wordSet(source.filler),
    negation: wordSet(source.negation),
    number: wordSet(source.number),
    power: wordSet(source.power),
  };
}

const EN = wordList(CAPTION_EMPHASIS_EN);
const UR = wordList(CAPTION_EMPHASIS_UR);
const HI = wordList(CAPTION_EMPHASIS_HI);
const ROMAN = wordList(CAPTION_EMPHASIS_ROMAN);
const UNIT_WORDS = wordSet(
  [CAPTION_EMPHASIS_EN, CAPTION_EMPHASIS_UR, CAPTION_EMPHASIS_HI, CAPTION_EMPHASIS_ROMAN]
    .map((list) => list.unit)
    .join(" "),
);

/** The lists that apply to one token, or null when the language has none. */
function listsForToken(language: string | null, raw: string): readonly WordList[] | null {
  if (language === "en") return [EN];
  if (language === "ur" || language === "hi") {
    if (ARABIC_RE.test(raw)) return [UR];
    if (DEVANAGARI_RE.test(raw)) return [HI];
    if (LATIN_RE.test(raw)) return [ROMAN, EN];
    return [];
  }
  return null;
}

function isCasedUpper(char: string): boolean {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

interface WordFacts {
  readonly normalised: string;
  readonly letters: number;
  readonly minor: boolean;
  readonly filler: boolean;
  readonly number: boolean;
  readonly negation: boolean;
  readonly power: boolean;
  readonly unit: boolean;
  readonly allCaps: boolean;
  readonly capitalised: boolean;
  readonly sentenceEnd: boolean;
}

function wordFacts(word: CaptionEmphasisWord, language: string | null): WordFacts {
  const normalised = normaliseWord(word.raw);
  const letters = letterCount(normalised);
  const lists = listsForToken(language, word.raw);
  const inList = (pick: (list: WordList) => ReadonlySet<string>) =>
    lists !== null && lists.some((list) => pick(list).has(normalised));
  const number = NUMERIC_RE.test(word.raw) || inList((list) => list.number);
  const negation = inList((list) => list.negation);
  const power = inList((list) => list.power);
  const listedMinor = lists === null
    ? letters <= 2 && !Array.from(normalised).some(isNoSpaceScriptChar)
    : inList((list) => list.minor);
  const minor = !number && !negation && !power && (letters === 0 || listedMinor);
  const sourceLetters = Array.from(word.raw).filter((char) => LETTER_RE.test(char));
  const casedLetters = sourceLetters.filter((char) => char !== char.toUpperCase() || char !== char.toLowerCase());
  return {
    normalised,
    letters,
    minor,
    filler: !minor && inList((list) => list.filler),
    number,
    negation,
    power,
    unit: UNIT_WORDS.has(normalised),
    allCaps: sourceLetters.length >= 2 && casedLetters.length === sourceLetters.length &&
      casedLetters.every(isCasedUpper),
    capitalised: sourceLetters.length > 0 && isCasedUpper(sourceLetters[0]!),
    sentenceEnd: SENTENCE_END_RE.test(word.raw.trim()),
  };
}

/** One caption word holding a whole utterance (no word timings). */
function isUntimedCue(cue: readonly CaptionEmphasisWord[]): boolean {
  return cue.length === 1 && WHITESPACE_RE.test(cue[0]!.raw.trim());
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

interface ScoredWord {
  readonly word: CaptionEmphasisWord;
  readonly facts: WordFacts;
  /** Can be picked automatically: not minor, filler or masked. */
  readonly eligible: boolean;
  readonly score: number;
  readonly sentenceInitial: boolean;
}

interface Candidate {
  readonly span: readonly [number, number];
  readonly text: string;
  readonly score: number;
}

function scoreWords(input: CaptionEmphasisInput, weights: CaptionEmphasisWeights): (ScoredWord[] | null)[] {
  const language = normalizeProviderLanguageCode(input.language);
  const timed = input.cues.map((cue) => !isUntimedCue(cue));
  const facts = input.cues.map((cue, cueIndex) =>
    timed[cueIndex] ? cue.map((word) => wordFacts(word, language)) : null,
  );

  // Seconds per letter, with letters clamped to 3..12 as in the stretch ratio,
  // so an utterance's typical word has a ratio of 1.
  const perLetter = new Map<number, number[]>();
  const counts = new Map<string, number>();
  input.cues.forEach((cue, cueIndex) => {
    const cueFacts = facts[cueIndex];
    if (!cueFacts) return;
    cue.forEach((word, index) => {
      const fact = cueFacts[index]!;
      if (fact.normalised) counts.set(fact.normalised, (counts.get(fact.normalised) ?? 0) + 1);
      const duration = word.sourceEndSec - word.sourceStartSec;
      if (duration <= 0 || fact.letters === 0) return;
      const values = perLetter.get(word.utteranceIndex) ?? [];
      values.push(duration / clamp(fact.letters, 3, 12));
      perLetter.set(word.utteranceIndex, values);
    });
  });
  const medianPerLetter = new Map([...perLetter].map(([utterance, values]) => [utterance, median(values)!]));

  let previous: { word: CaptionEmphasisWord; facts: WordFacts } | null = null;
  return input.cues.map((cue, cueIndex) => {
    const cueFacts = facts[cueIndex];
    if (!cueFacts) {
      previous = null;
      return null;
    }
    return cue.map((word, index) => {
      const fact = cueFacts[index]!;
      const firstOfUtterance = previous === null || previous.word.utteranceIndex !== word.utteranceIndex;
      const sentenceInitial = firstOfUtterance || previous!.facts.sentenceEnd;
      previous = { word, facts: fact };
      let score = 0;
      if (fact.number) score += weights.number;
      if (fact.negation) score += weights.negation;
      if (fact.power) score += weights.power;
      const perLetterSec = medianPerLetter.get(word.utteranceIndex);
      const duration = word.sourceEndSec - word.sourceStartSec;
      if (perLetterSec !== undefined && perLetterSec > 0 && duration > 0 && fact.letters > 0) {
        const ratio = duration / (perLetterSec * clamp(fact.letters, 3, 12));
        score += clamp(ratio - weights.stretchFloor, 0, 1) * weights.stretchMax;
      }
      if (word.pauseBeforeSec >= weights.pauseMinSec && !firstOfUtterance) score += weights.pause;
      if (fact.allCaps) score += weights.allCaps;
      if (word.utteranceFinal || fact.sentenceEnd) score += weights.sentenceFinal;
      if (fact.normalised && (counts.get(fact.normalised) ?? 0) >= weights.topicMinCount) score += weights.topic;
      if (index === cue.length - 1) score += weights.cueFinal;
      if (fact.capitalised && !sentenceInitial) score += weights.capitalised;
      score += Math.min(weights.lengthMax, fact.letters * weights.lengthPerLetter);
      return {
        word,
        facts: fact,
        eligible: !fact.minor && !fact.filler && !word.masked,
        score,
        sentenceInitial,
      };
    });
  });
}

/** Single words and 2-word units that can be the cue's hero. */
function cueCandidates(words: readonly ScoredWord[]): Candidate[] {
  const candidates: Candidate[] = [];
  const titled = (entry: ScoredWord | undefined) =>
    entry !== undefined && entry.eligible && entry.facts.capitalised && !entry.sentenceInitial;
  for (let index = 0; index < words.length; index += 1) {
    const entry = words[index]!;
    if (!entry.eligible) continue;
    const next = words[index + 1];
    if (entry.facts.number && next !== undefined && next.facts.unit && !next.word.masked) {
      candidates.push({ span: [index, index + 1], text: `${entry.facts.normalised} ${next.facts.normalised}`, score: entry.score });
      index += 1;
      continue;
    }
    if (titled(entry) && titled(next)) {
      candidates.push({
        span: [index, index + 1],
        text: `${entry.facts.normalised} ${next!.facts.normalised}`,
        score: Math.max(entry.score, next!.score),
      });
      index += 1;
      continue;
    }
    candidates.push({ span: [index, index], text: entry.facts.normalised, score: entry.score });
  }
  return candidates;
}

/** The confidence gate: the top candidate wins only by a clear margin. Ties go to the later word. */
function gatedPick(
  candidates: readonly Candidate[],
  previousAutomatic: string | null,
  weights: CaptionEmphasisWeights,
): Candidate | null {
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      score: candidate.score + (previousAutomatic !== null && candidate.text === previousAutomatic ? weights.repeat : 0),
    }))
    .sort((left, right) => right.score - left.score || right.span[0] - left.span[0]);
  const top = ranked[0];
  if (!top || top.score < weights.gateMinScore) return null;
  const runnerUp = ranked[1];
  return runnerUp && top.score - runnerUp.score < weights.gateMargin ? null : top;
}

function overriddenPick(
  words: readonly ScoredWord[],
  overrides: Readonly<Record<string, CaptionEmphasisOverride>>,
): readonly [number, number] | null {
  let best: { index: number; score: number; pair: boolean } | null = null;
  for (const [index, entry] of words.entries()) {
    const value = entry.word.key === null ? undefined : overrides[entry.word.key];
    if ((value !== "hero" && value !== "pair") || entry.word.masked) continue;
    if (best === null || entry.score >= best.score) best = { index, score: entry.score, pair: value === "pair" };
  }
  if (best === null) return null;
  const next = words[best.index + 1];
  return best.pair && next !== undefined && !next.word.masked ? [best.index, best.index + 1] : [best.index, best.index];
}

/**
 * Assigns a Caption Role to every word of a target's cues, as a second pass
 * after grouping. A cue gets at most one hero (one word or a 2-word unit):
 * an override, else the scorer's pick when it clears the confidence gate.
 * The repeat penalty looks at the previous cue's automatic pick only, so an
 * override never changes another cue. Untimed utterances get no hero.
 */
export function assignCaptionRoles(input: CaptionEmphasisInput): CaptionCueRoles[] {
  const weights = input.weights ?? CAPTION_EMPHASIS_WEIGHTS;
  const scored = scoreWords(input, weights);
  let previousAutomatic: string | null = null;
  return scored.map((words, cueIndex) => {
    if (words === null) {
      previousAutomatic = null;
      return { roles: input.cues[cueIndex]!.map(() => "body" as const), heroSpan: null };
    }
    const candidates = cueCandidates(words);
    const automatic = gatedPick(candidates, previousAutomatic, weights);
    let heroSpan: readonly [number, number] | null = null;
    if (input.policy === "auto") {
      heroSpan = overriddenPick(words, input.overrides);
      if (heroSpan === null) {
        const plain = (index: number) => {
          const key = words[index]!.word.key;
          return key !== null && input.overrides[key] === "plain";
        };
        const allowed = candidates.filter((candidate) => !plain(candidate.span[0]) && !plain(candidate.span[1]));
        heroSpan = gatedPick(allowed, previousAutomatic, weights)?.span ?? null;
      }
    }
    previousAutomatic = automatic?.text ?? null;
    return {
      roles: words.map((entry, index): CaptionWordRole =>
        heroSpan !== null && index >= heroSpan[0] && index <= heroSpan[1]
          ? "hero"
          : entry.facts.minor ? "minor" : "body"),
      heroSpan,
    };
  });
}

/**
 * The G1 comparison rule: the last word with a digit, else the last word that
 * is not minor, filler or masked. Untimed utterances get none.
 */
export function baselineCaptionHero(input: {
  readonly cues: readonly (readonly CaptionEmphasisWord[])[];
  readonly language: string | null;
}): (readonly [number, number] | null)[] {
  const language = normalizeProviderLanguageCode(input.language);
  return input.cues.map((cue) => {
    if (isUntimedCue(cue)) return null;
    const eligible = cue.flatMap((word, index) => {
      const fact = wordFacts(word, language);
      return fact.minor || fact.filler || word.masked ? [] : [{ index, digit: DIGIT_RE.test(word.raw) }];
    });
    const pick = eligible.filter((entry) => entry.digit).at(-1) ?? eligible.at(-1);
    return pick ? [pick.index, pick.index] : null;
  });
}
