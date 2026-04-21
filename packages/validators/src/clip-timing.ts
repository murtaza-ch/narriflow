import type { TranscriptUtterance, TranscriptWord } from "./transcript";

export interface ClipTimingInput {
  utterances: TranscriptUtterance[];
  startSec: number;
  endSec: number;
  sourceDurationSec?: number | null;
  tailPadSec?: number;
  minDurationSec?: number;
  preferredMinDurationSec?: number;
  preferredMaxDurationSec?: number;
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

interface SpeechToken {
  startSec: number;
  endSec: number;
  terminal: boolean;
}

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

function getSpeechTokens(utterances: TranscriptUtterance[]): SpeechToken[] {
  const words = utterances.flatMap((utterance) =>
    utterance.words.map((word) => ({
      startSec: word.startSec,
      endSec: word.endSec,
      terminal: isTerminalWord(word),
    })),
  );

  if (words.length > 0) {
    return words
      .filter((word) => word.endSec >= word.startSec)
      .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  }

  return utterances
    .map((utterance) => ({
      startSec: utterance.startSec,
      endSec: utterance.endSec,
      terminal: true,
    }))
    .filter((utterance) => utterance.endSec >= utterance.startSec)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

function findTokenIndexForRange(
  tokens: SpeechToken[],
  startSec: number,
  endSec: number,
) {
  const overlapping = tokens.findIndex(
    (token) => token.endSec > startSec && token.startSec < endSec,
  );

  if (overlapping >= 0) {
    return overlapping;
  }

  const next = tokens.findIndex((token) => token.startSec >= startSec);

  if (next >= 0) {
    return next;
  }

  return tokens.length - 1;
}

function findSentenceStartTokenIndex(tokens: SpeechToken[], tokenIndex: number) {
  let index = clamp(tokenIndex, 0, tokens.length - 1);

  while (index > 0 && !tokens[index - 1]!.terminal) {
    index -= 1;
  }

  return index;
}

function chooseMarketWindowEnd(input: {
  tokens: SpeechToken[];
  startIndex: number;
  startSec: number;
  sourceDurationSec: number;
  minDurationSec: number;
  preferredMinDurationSec: number;
  preferredMaxDurationSec: number;
  maxDurationSec: number;
  tailPadSec: number;
}) {
  const minEnd = Math.min(
    input.sourceDurationSec,
    input.startSec + input.minDurationSec,
  );
  const preferredMinEnd = Math.min(
    input.sourceDurationSec,
    input.startSec + input.preferredMinDurationSec,
  );
  const preferredMaxEnd = Math.min(
    input.sourceDurationSec,
    input.startSec + input.preferredMaxDurationSec,
  );
  const maxEnd = Math.min(
    input.sourceDurationSec,
    input.startSec + input.maxDurationSec,
  );
  const terminalEnds: number[] = [];
  let lastTokenEnd: number | null = null;

  for (let index = input.startIndex; index < input.tokens.length; index++) {
    const token = input.tokens[index]!;

    if (token.startSec > maxEnd) {
      break;
    }

    const paddedEnd = Math.min(
      input.sourceDurationSec,
      token.endSec + input.tailPadSec,
    );

    if (paddedEnd <= input.startSec) {
      continue;
    }

    lastTokenEnd = paddedEnd;

    if (token.terminal) {
      terminalEnds.push(paddedEnd);
    }
  }

  const preferredTerminal = terminalEnds.find(
    (endSec) => endSec >= preferredMinEnd && endSec <= preferredMaxEnd,
  );

  if (preferredTerminal !== undefined) {
    return preferredTerminal;
  }

  const validTerminal = terminalEnds.find(
    (endSec) => endSec >= minEnd && endSec <= maxEnd,
  );

  if (validTerminal !== undefined) {
    return validTerminal;
  }

  const lastTerminalWithinMax = terminalEnds
    .filter((endSec) => endSec <= maxEnd)
    .at(-1);

  if (lastTerminalWithinMax !== undefined) {
    return lastTerminalWithinMax;
  }

  return lastTokenEnd ?? maxEnd;
}

export function expandClipToMarketWindow(
  input: ClipTimingInput,
): EffectiveClipTiming {
  const completeSpeechTiming = expandClipToCompleteSpeech(input);
  const minDurationSec = input.minDurationSec;
  const preferredMinDurationSec = input.preferredMinDurationSec;
  const preferredMaxDurationSec = input.preferredMaxDurationSec;

  if (
    typeof minDurationSec !== "number" ||
    typeof preferredMinDurationSec !== "number" ||
    typeof preferredMaxDurationSec !== "number"
  ) {
    return completeSpeechTiming;
  }

  const sourceDurationSec =
    typeof input.sourceDurationSec === "number" && input.sourceDurationSec > 0
      ? input.sourceDurationSec
      : Number.POSITIVE_INFINITY;
  const maxDurationSec = input.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
  const tailPadSec = input.tailPadSec ?? DEFAULT_TAIL_PAD_SEC;
  const tokens = getSpeechTokens(input.utterances);

  if (tokens.length === 0) {
    return completeSpeechTiming;
  }

  const rawStart = Math.min(sourceDurationSec, Math.max(0, input.startSec));
  const rawEnd = Math.min(
    sourceDurationSec,
    Math.max(rawStart + MIN_WORD_DURATION_SEC, input.endSec),
  );
  const hookIndex = findTokenIndexForRange(tokens, rawStart, rawEnd);
  let startIndex = findSentenceStartTokenIndex(tokens, hookIndex);
  let effectiveStart = tokens[startIndex]!.startSec;
  let effectiveEnd = chooseMarketWindowEnd({
    tokens,
    startIndex,
    startSec: effectiveStart,
    sourceDurationSec,
    minDurationSec,
    preferredMinDurationSec,
    preferredMaxDurationSec,
    maxDurationSec,
    tailPadSec,
  });

  while (
    effectiveEnd - effectiveStart < minDurationSec &&
    startIndex > 0
  ) {
    startIndex = findSentenceStartTokenIndex(tokens, startIndex - 1);
    effectiveStart = tokens[startIndex]!.startSec;
  }

  effectiveStart = normalizeTime(clamp(effectiveStart, 0, sourceDurationSec));
  effectiveEnd = normalizeTime(
    clamp(
      effectiveEnd,
      effectiveStart,
      Math.min(sourceDurationSec, effectiveStart + maxDurationSec),
    ),
  );

  if (effectiveEnd <= effectiveStart) {
    effectiveEnd = normalizeTime(
      Math.min(sourceDurationSec, effectiveStart + MIN_WORD_DURATION_SEC),
    );
  }

  return {
    startSec: effectiveStart,
    endSec: effectiveEnd,
    durationSec: normalizeTime(effectiveEnd - effectiveStart),
  };
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
  const timing = expandClipToMarketWindow(input);
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
