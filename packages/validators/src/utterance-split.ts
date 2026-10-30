import { joinTranscriptWords } from "./text-script";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";

// Sentence terminals: Latin `.!?`, CJK `。！？．`, Arabic `؟`, Urdu `۔`, Indic
// `।` `॥`, Ethiopic `።`, Myanmar `။`, Armenian `։`, Greek question mark U+037E.
// ASCII `;` is deliberately not one: it is a clause mark in English.
const SENTENCE_TERMINALS = ".!?。！？．؟۔।॥።။։\u037E";
// Closing quotes and brackets that may trail a terminal.
const CLOSING_MARKS = "\"')\\]’”」』）】〉》»";
const OPENING_MARKS = "\"'(\\[‘“「『（【〈《«¿¡";

/** Matches a word that ends a sentence, allowing trailing close-quotes or
 *  brackets after the terminal punctuation (e.g. `done."`, `right?)`, `。」`). */
export const TERMINAL_PUNCTUATION_RE = new RegExp(
  `[${SENTENCE_TERMINALS}][${CLOSING_MARKS}]*$`,
  "u",
);
const LEADING_OPENING_MARKS_RE = new RegExp(`^[${OPENING_MARKS}]+`, "u");

// Dotted tokens that end in "." without ending a sentence. Treating these as
// terminal fragments the transcript ("Dr." became its own utterance) and lets
// the clip end-picker cut right after "the U.S." mid-sentence.
const NON_TERMINAL_ABBREVIATIONS = new Set([
  "dr.", "mr.", "mrs.", "ms.", "prof.", "rev.", "gen.", "sgt.", "capt.",
  "lt.", "col.", "jr.", "sr.", "st.", "vs.", "etc.", "inc.", "ltd.", "co.",
  "no.", "approx.", "dept.", "est.", "fig.", "min.", "max.", "e.g.", "i.e.",
  "a.m.", "p.m.", "u.s.", "u.k.", "ave.", "blvd.", "rd.",
]);
// Single initials ("J.") and short list markers ("1.", "12.").
const INITIAL_RE = /^[A-Za-z]\.$/;
const LIST_MARKER_RE = /^\d{1,2}\.$/;
// Dotted acronyms not in the set above ("U.S.A.", "a.k.a.").
const DOTTED_ACRONYM_RE = /^([A-Za-z]\.){2,}$/;

export function isTerminalWordText(text: string) {
  const trimmed = text.trim();

  if (!TERMINAL_PUNCTUATION_RE.test(trimmed)) {
    return false;
  }

  const bare = trimmed.replace(LEADING_OPENING_MARKS_RE, "");

  if (NON_TERMINAL_ABBREVIATIONS.has(bare.toLowerCase())) {
    return false;
  }

  return (
    !INITIAL_RE.test(bare) &&
    !LIST_MARKER_RE.test(bare) &&
    !DOTTED_ACRONYM_RE.test(bare)
  );
}

// Providers that diarize by speaker turn (Scribe) return one utterance per
// continuous turn — for a single-speaker monologue that is the ENTIRE video as
// one utterance. Everything downstream that treats an utterance as a usable
// unit (the clip-detection LLM prompt's per-line timestamps, SRT/VTT cues,
// transcript views) degrades badly on turn-sized utterances, so sentence-sized
// is the ceiling we enforce here.
const DEFAULT_MAX_SENTENCE_DURATION_SEC = 30;
const DEFAULT_MAX_SENTENCE_WORDS = 80;

export interface SplitUtterancesOptions {
  maxSentenceDurationSec?: number;
  maxSentenceWords?: number;
}

function buildSentenceUtterance(
  source: TranscriptUtterance,
  words: TranscriptWord[],
): TranscriptUtterance | null {
  const text = joinTranscriptWords(words);

  if (!text) {
    return null;
  }

  return {
    ...source,
    index: 0, // reassigned after the full pass
    startSec: words[0]!.startSec,
    endSec: words[words.length - 1]!.endSec,
    text,
    words,
  };
}

/** Split point (index to split AFTER) at the largest inter-word silence, so a
 *  forced split of a long unpunctuated stretch lands on a natural pause
 *  instead of mid-phrase. Ties prefer the later gap. */
function bestSplitIndex(words: TranscriptWord[]): number {
  let best = words.length - 1;
  let bestGap = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1]!.startSec - words[i]!.endSec;
    if (gap >= bestGap) {
      bestGap = gap;
      best = i;
    }
  }

  return best;
}

/**
 * Splits utterances into sentence-level utterances using word timings and
 * terminal punctuation, force-splitting (at the largest pause) any stretch
 * that exceeds the duration/word ceilings without punctuation. Utterances
 * without word timings are passed through unchanged. Idempotent: already
 * sentence-sized utterances come back as-is (modulo reindexing).
 */
export function splitUtterancesIntoSentences(
  utterances: TranscriptUtterance[],
  options?: SplitUtterancesOptions,
): TranscriptUtterance[] {
  const maxDurationSec =
    options?.maxSentenceDurationSec ?? DEFAULT_MAX_SENTENCE_DURATION_SEC;
  const maxWords = options?.maxSentenceWords ?? DEFAULT_MAX_SENTENCE_WORDS;
  const result: TranscriptUtterance[] = [];

  for (const utterance of utterances) {
    if (utterance.words.length === 0) {
      result.push({ ...utterance });
      continue;
    }

    // This runs on the READ path over arbitrary stored utterancesJson, so
    // never trust word ordering or validity: unsorted input would otherwise
    // emit utterances with endSec < startSec.
    const sourceWords = [...utterance.words]
      .filter((word) => word.endSec >= word.startSec)
      .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

    if (sourceWords.length === 0) {
      continue;
    }

    let buffer: TranscriptWord[] = [];

    const flush = (words: TranscriptWord[]) => {
      if (words.length === 0) return;
      const sentence = buildSentenceUtterance(utterance, words);
      if (sentence) result.push(sentence);
    };

    for (const word of sourceWords) {
      buffer.push(word);

      if (isTerminalWordText(word.word)) {
        flush(buffer);
        buffer = [];
        continue;
      }

      const bufferDurationSec = word.endSec - buffer[0]!.startSec;
      if (bufferDurationSec >= maxDurationSec || buffer.length >= maxWords) {
        const splitAt = bestSplitIndex(buffer);
        flush(buffer.slice(0, splitAt + 1));
        buffer = buffer.slice(splitAt + 1);
      }
    }

    flush(buffer);
  }

  return result.map((utterance, index) => ({ ...utterance, index }));
}
