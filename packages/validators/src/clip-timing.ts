import type { TranscriptUtterance, TranscriptWord } from "./transcript";

export interface ClipTimingInput {
  utterances: TranscriptUtterance[];
  startSec: number;
  endSec: number;
  sourceDurationSec?: number | null;
  tailPadSec?: number;
  maxDurationSec?: number;
}

export interface EffectiveClipTiming {
  startSec: number;
  endSec: number;
  durationSec: number;
}

const DEFAULT_TAIL_PAD_SEC = 0.25;
const DEFAULT_MAX_DURATION_SEC = 120;
const MIN_WORD_DURATION_SEC = 0.01;
const TERMINAL_PUNCTUATION_RE = /[.!?]["')\]]?$/;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeTime(value: number) {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function wordText(word: TranscriptWord) {
  return word.word.trim();
}

function rebuildText(words: TranscriptWord[]) {
  return words.map(wordText).filter(Boolean).join(" ").trim();
}

function isTerminalWord(word: TranscriptWord) {
  return TERMINAL_PUNCTUATION_RE.test(wordText(word));
}

function getTimedWords(utterance: TranscriptUtterance[]) {
  return utterance.flatMap((u) =>
    u.words.map((word) => ({
      utterance: u,
      word,
    })),
  );
}

function findLastOverlappingWord(
  utterances: TranscriptUtterance[],
  startSec: number,
  endSec: number,
) {
  const words = getTimedWords(utterances);
  let last:
    | {
        utterance: TranscriptUtterance;
        word: TranscriptWord;
        index: number;
      }
    | null = null;

  for (const [index, entry] of words.entries()) {
    if (entry.word.endSec > startSec && entry.word.startSec < endSec) {
      last = { ...entry, index };
    }
  }

  return { words, last };
}

function findLastOverlappingUtterance(
  utterances: TranscriptUtterance[],
  startSec: number,
  endSec: number,
) {
  let last: TranscriptUtterance | null = null;

  for (const utterance of utterances) {
    if (utterance.endSec > startSec && utterance.startSec < endSec) {
      last = utterance;
    }
  }

  return last;
}

export function expandClipToCompleteSpeech(
  input: ClipTimingInput,
): EffectiveClipTiming {
  const sourceDurationSec =
    typeof input.sourceDurationSec === "number" && input.sourceDurationSec > 0
      ? input.sourceDurationSec
      : Number.POSITIVE_INFINITY;
  const maxDurationSec = input.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
  const tailPadSec = input.tailPadSec ?? DEFAULT_TAIL_PAD_SEC;
  const startLimit = Math.min(sourceDurationSec, Math.max(0, input.startSec));
  const endLimit = Math.min(sourceDurationSec, Math.max(startLimit, input.endSec));

  let effectiveStart = startLimit;
  let effectiveEnd = endLimit;

  const { words, last } = findLastOverlappingWord(
    input.utterances,
    startLimit,
    endLimit,
  );

  if (last) {
    const firstOverlap = words.find(
      (entry) =>
        entry.word.endSec > startLimit && entry.word.startSec < endLimit,
    );

    if (firstOverlap && firstOverlap.word.startSec < startLimit) {
      effectiveStart = firstOverlap.word.startSec;
    }

    let sentenceEnd = last.word.endSec;
    const remainingWords = words.slice(last.index);
    const terminal = remainingWords.find((entry) => isTerminalWord(entry.word));

    if (terminal) {
      sentenceEnd = terminal.word.endSec;
    } else {
      sentenceEnd = last.utterance.endSec;
    }

    effectiveEnd = Math.max(effectiveEnd, sentenceEnd + tailPadSec);
  } else {
    const lastUtterance = findLastOverlappingUtterance(
      input.utterances,
      startLimit,
      endLimit,
    );

    if (lastUtterance) {
      if (lastUtterance.startSec < startLimit) {
        effectiveStart = lastUtterance.startSec;
      }
      effectiveEnd = Math.max(effectiveEnd, lastUtterance.endSec + tailPadSec);
    }
  }

  effectiveStart = normalizeTime(clamp(effectiveStart, 0, sourceDurationSec));
  effectiveEnd = normalizeTime(
    clamp(effectiveEnd, effectiveStart, Math.min(sourceDurationSec, effectiveStart + maxDurationSec)),
  );

  if (effectiveEnd <= effectiveStart) {
    effectiveEnd = normalizeTime(Math.min(sourceDurationSec, effectiveStart + MIN_WORD_DURATION_SEC));
  }

  return {
    startSec: effectiveStart,
    endSec: effectiveEnd,
    durationSec: normalizeTime(effectiveEnd - effectiveStart),
  };
}

export function normalizeTranscriptSliceForClip(
  utterances: TranscriptUtterance[],
  startSec: number,
  endSec: number,
): TranscriptUtterance[] {
  const normalized: TranscriptUtterance[] = [];

  for (const utterance of utterances) {
    if (utterance.endSec <= startSec || utterance.startSec >= endSec) {
      continue;
    }

    const clampedStart = normalizeTime(Math.max(utterance.startSec, startSec));
    const clampedEnd = normalizeTime(Math.min(utterance.endSec, endSec));

    if (clampedEnd <= clampedStart) {
      continue;
    }

    if (utterance.words.length > 0) {
      const words = utterance.words
        .filter((word) => word.endSec > startSec && word.startSec < endSec)
        .map((word) => ({
          ...word,
          startSec: normalizeTime(Math.max(word.startSec, startSec)),
          endSec: normalizeTime(Math.min(word.endSec, endSec)),
        }))
        .filter((word) => word.endSec - word.startSec >= MIN_WORD_DURATION_SEC);

      const text = rebuildText(words);

      if (!text) {
        continue;
      }

      normalized.push({
        ...utterance,
        index: normalized.length,
        startSec: words[0]?.startSec ?? clampedStart,
        endSec: words[words.length - 1]?.endSec ?? clampedEnd,
        text,
        words,
      });
      continue;
    }

    normalized.push({
      ...utterance,
      index: normalized.length,
      startSec: clampedStart,
      endSec: clampedEnd,
      words: [],
    });
  }

  return normalized;
}

export function getEffectiveClipTiming(input: ClipTimingInput) {
  const timing = expandClipToCompleteSpeech(input);
  const transcriptSlice = normalizeTranscriptSliceForClip(
    input.utterances,
    timing.startSec,
    timing.endSec,
  );

  return {
    ...timing,
    transcriptSlice,
  };
}
