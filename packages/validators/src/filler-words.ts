import { FLOAT_SLACK, normalizeDeletedRanges, type ClipWindow, type SourceRange } from "./edit-ranges";
import { buildCoverageSpans, SILENCE_DEFAULT_MIN_SILENCE_SEC, SILENCE_DEFAULT_PAD_SEC, silenceLeadInSec } from "./silence-detection";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";

// Filler-word removal: hesitation sounds become `SourceRange`s in the same
// absolute-source-second model as manual deletes and silence cuts, so the
// render, captions and Studio undo handle them without new machinery.

/** Hesitation sounds per transcript language. Only sounds that are never a
 *  real word in that language: "like" and "you know" carry meaning too often
 *  to delete blindly, and "um"/"er" are real words in Portuguese and German,
 *  so the list is keyed by language rather than applied everywhere. */
const FILLER_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set(["um", "umm", "ummm", "uhm", "uh", "uhh", "uhhh", "er", "erm"]),
};

/** Languages whose filler words are recognised. */
export function supportsFillerWordRemoval(languageCode: string | null | undefined): boolean {
  return fillerSet(languageCode) !== null;
}

function fillerSet(languageCode: string | null | undefined): ReadonlySet<string> | null {
  if (!languageCode) return null;
  return FILLER_WORDS[languageCode.toLowerCase().split(/[-_]/)[0]!] ?? null;
}

/** Whether a transcript word is a filler in `languageCode`, ignoring case and
 *  punctuation ("Um," and "uh..." match; "uh-huh" does not). */
export function isFillerWord(word: Pick<TranscriptWord, "word">, languageCode: string | null | undefined): boolean {
  const set = fillerSet(languageCode);
  return set !== null && set.has(word.word.toLowerCase().replace(/[^\p{L}]/gu, ""));
}

export interface DetectFillerWordOptions {
  languageCode: string | null | undefined;
  /** Kept after the preceding speech. @default SILENCE_DEFAULT_PAD_SEC */
  padSec?: number;
  /** A pause beside a filler this long or longer is a silence, not part of
   *  the hesitation: the cut stops at the filler. @default SILENCE_DEFAULT_MIN_SILENCE_SEC */
  minSilenceSec?: number;
}

/**
 * Ranges that remove each run of consecutive filler words inside `window`.
 * A run's cut always covers the fillers' own timing, so captions drop them,
 * and extends into a pause shorter than `minSilenceSec` on either side down
 * to `padSec` after the previous speech and `silenceLeadInSec(padSec)`
 * before the next, so "so, um, we" closes up instead of leaving two pauses.
 * Longer pauses are left to silence removal. A filler with
 * single-instant timing, or one inside speech of unknown timing, is left
 * alone. Unsupported languages return no ranges.
 */
export function detectFillerWordRanges(
  utterances: TranscriptUtterance[],
  window: ClipWindow,
  opts: DetectFillerWordOptions,
): SourceRange[] {
  if (!supportsFillerWordRemoval(opts.languageCode)) return [];
  const padSec = opts.padSec ?? SILENCE_DEFAULT_PAD_SEC;
  const leadInSec = silenceLeadInSec(padSec);
  const minSilenceSec = opts.minSilenceSec ?? SILENCE_DEFAULT_MIN_SILENCE_SEC;
  const isFiller = (word: TranscriptWord) => isFillerWord(word, opts.languageCode);

  const speech = buildCoverageSpans(utterances, window, isFiller);
  const fillers = utterances
    .flatMap((utterance) => utterance.words)
    .filter((word) => isFiller(word) && word.endSec > word.startSec && word.startSec < window.endSec && word.endSec > window.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  // Group fillers that no speech separates into runs.
  const runs: SourceRange[] = [];
  for (const filler of fillers) {
    const last = runs[runs.length - 1];
    const speechBetween = last && speech.some((s) => s.startSec < filler.startSec && s.endSec > last.endSec);
    if (last && !speechBetween) last.endSec = Math.max(last.endSec, filler.endSec);
    else runs.push({ startSec: filler.startSec, endSec: filler.endSec });
  }

  const cuts: SourceRange[] = [];
  for (const run of runs) {
    // Speech of unknown timing (a whole-utterance span) overlapping the run.
    if (speech.some((s) => s.startSec < run.endSec - FLOAT_SLACK && s.endSec > run.startSec + FLOAT_SLACK)) continue;
    const previous = speech.filter((s) => s.endSec <= run.startSec + FLOAT_SLACK).at(-1);
    const next = speech.find((s) => s.startSec >= run.endSec - FLOAT_SLACK);
    const before = previous ? run.startSec - previous.endSec : run.startSec - window.startSec;
    const after = next ? next.startSec - run.endSec : window.endSec - run.endSec;
    const startSec = before >= minSilenceSec ? run.startSec : previous ? Math.min(run.startSec, previous.endSec + padSec) : window.startSec;
    const endSec = after >= minSilenceSec ? run.endSec : next ? Math.max(run.endSec, next.startSec - leadInSec) : window.endSec;
    cuts.push({ startSec: Math.max(window.startSec, startSec), endSec: Math.min(window.endSec, endSec) });
  }
  return normalizeDeletedRanges(cuts, window);
}
