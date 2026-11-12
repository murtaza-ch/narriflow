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

/** Whether a transcript word is a filler in `languageCode`, ignoring
 *  punctuation and sentence case ("Um," and "uh..." match; "uh-huh" does
 *  not). An all-capitals token is an acronym ("ER", "UM"), never a filler. */
export function isFillerWord(word: Pick<TranscriptWord, "word">, languageCode: string | null | undefined): boolean {
  const set = fillerSet(languageCode);
  if (set === null) return false;
  const letters = word.word.replace(/[^\p{L}]/gu, "");
  if (letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return false;
  return set.has(letters.toLowerCase());
}

/** Decides whether one transcript word is a filler. The utterance carries
 *  the word's speaker, which AI tags are keyed by. */
export type FillerClassifier = (word: TranscriptWord, utterance: TranscriptUtterance) => boolean;

/** The built-in list for `languageCode`, or null where none is known. */
export function listFillerClassifier(languageCode: string | null | undefined): FillerClassifier | null {
  return supportsFillerWordRemoval(languageCode) ? (word) => isFillerWord(word, languageCode) : null;
}

export interface DetectFillerWordOptions {
  /** Picks the built-in list when `isFiller` is not given. */
  languageCode?: string | null | undefined;
  /** Overrides the language list (AI-tagged fillers). Null: no fillers. */
  isFiller?: FillerClassifier | null;
  /** Kept after the preceding speech. @default SILENCE_DEFAULT_PAD_SEC */
  padSec?: number;
  /** A pause beside a filler this long or longer is a silence, not part of
   *  the hesitation: the cut stops at the filler. @default SILENCE_DEFAULT_MIN_SILENCE_SEC */
  minSilenceSec?: number;
}

/** The filler words in `window` that removal will cut: timed fillers that
 *  no kept word overlaps. A filler someone talks over, or one timed as a
 *  single instant, stays and counts as speech, and so does any filler that
 *  overlaps a kept one. */
export function removableFillerWords(
  utterances: TranscriptUtterance[],
  window: ClipWindow,
  isFiller: FillerClassifier | null,
): Set<TranscriptWord> {
  if (!isFiller) return new Set();
  const overlaps = (spans: SourceRange[], word: TranscriptWord) =>
    spans.some((s) => s.startSec < word.endSec - FLOAT_SLACK && s.endSec > word.startSec + FLOAT_SLACK);
  let removable = new Set(utterances.flatMap((utterance) => utterance.words.filter((word) =>
    isFiller(word, utterance) && word.endSec > word.startSec && word.startSec < window.endSec && word.endSec > window.startSec)));
  // Keeping a filler can make an overlapping filler unsafe to cut; repeat
  // until no removable filler overlaps anything kept.
  for (;;) {
    const kept = buildCoverageSpans(utterances, window, (word) => removable.has(word));
    const next = new Set([...removable].filter((word) => !overlaps(kept, word)));
    if (next.size === removable.size) return removable;
    removable = next;
  }
}

/** The classifier an options object selects: `isFiller` when given, else the language list. */
export function fillerClassifier(opts: Pick<DetectFillerWordOptions, "languageCode" | "isFiller">): FillerClassifier | null {
  return opts.isFiller !== undefined ? opts.isFiller : listFillerClassifier(opts.languageCode);
}

/**
 * Ranges that remove each run of consecutive removable filler words (see
 * `removableFillerWords`) inside `window`. A run's cut always covers the
 * fillers' own timing, so captions drop them, and extends into a pause
 * shorter than `minSilenceSec` on either side down to `padSec` after the
 * previous speech and `silenceLeadInSec(padSec)` before the next, so "so,
 * um, we" closes up instead of leaving two pauses. Longer pauses are left to
 * silence removal. Every word not removed, kept fillers included, bounds the
 * cuts. Unsupported languages return no ranges.
 */
export function detectFillerWordRanges(
  utterances: TranscriptUtterance[],
  window: ClipWindow,
  opts: DetectFillerWordOptions,
): SourceRange[] {
  const removable = removableFillerWords(utterances, window, fillerClassifier(opts));
  if (removable.size === 0) return [];
  const padSec = opts.padSec ?? SILENCE_DEFAULT_PAD_SEC;
  const leadInSec = silenceLeadInSec(padSec);
  const minSilenceSec = opts.minSilenceSec ?? SILENCE_DEFAULT_MIN_SILENCE_SEC;
  const bounds = buildCoverageSpans(utterances, window, (word) => removable.has(word));
  const fillers = [...removable].sort((a, b) => a.startSec - b.startSec);

  // Group fillers that nothing kept separates, and no silence-length pause
  // separates, into runs. A long pause between fillers is silence removal's
  // to judge against measured quiet audio, never cut here.
  const runs: SourceRange[] = [];
  for (const filler of fillers) {
    const last = runs[runs.length - 1];
    if (last && filler.startSec - last.endSec < minSilenceSec - FLOAT_SLACK &&
      !bounds.some((s) => s.startSec < filler.startSec && s.endSec > last.endSec)) {
      last.endSec = Math.max(last.endSec, filler.endSec);
    } else {
      runs.push({ startSec: filler.startSec, endSec: filler.endSec });
    }
  }

  const cuts: SourceRange[] = [];
  for (const run of runs) {
    // Never reached after removableFillerWords; a backstop against cutting kept speech.
    if (bounds.some((s) => s.startSec < run.endSec - FLOAT_SLACK && s.endSec > run.startSec + FLOAT_SLACK)) continue;
    const previous = bounds.filter((s) => s.endSec <= run.startSec + FLOAT_SLACK).at(-1);
    const next = bounds.find((s) => s.startSec >= run.endSec - FLOAT_SLACK);
    const before = previous ? run.startSec - previous.endSec : run.startSec - window.startSec;
    const after = next ? next.startSec - run.endSec : window.endSec - run.endSec;
    const startSec = before >= minSilenceSec ? run.startSec : previous ? Math.min(run.startSec, previous.endSec + padSec) : window.startSec;
    const endSec = after >= minSilenceSec ? run.endSec : next ? Math.max(run.endSec, next.startSec - leadInSec) : window.endSec;
    cuts.push({ startSec: Math.max(window.startSec, startSec), endSec: Math.min(window.endSec, endSec) });
  }
  return normalizeDeletedRanges(cuts, window);
}
