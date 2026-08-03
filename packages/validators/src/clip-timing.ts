import type { TranscriptUtterance, TranscriptWord } from "./transcript";
import { isTerminalWordText } from "./utterance-split";

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
// The tail pad must never swallow the start of the next word: when speech
// continues immediately after the chosen sentence end, the clip has to end
// just before the next word rather than a fixed pad past the last one —
// production clips were hard-cutting 0.1-0.3s INTO the next sentence.
const SPEECH_COLLISION_GAP_SEC = 0.04;
// Small pre-roll before the first word so its opening phoneme is never
// clipped, bounded so it can never reach back into the previous word.
const START_PRE_ROLL_SEC = 0.15;
const PRE_ROLL_MIN_GAP_SEC = 0.02;

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
  return isTerminalWordText(wordText(word));
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

// How far back the sentence-start walk may reach from its anchor token. On a
// transcript with sparse/no terminal punctuation an unbounded walk collapses
// every clip start to token 0, which (combined with the containment guard)
// used to fail entire detection runs. Sentence-split utterances are capped at
// ~30s, so a healthy transcript never hits this bound.
const MAX_SENTENCE_LOOKBACK_SEC = 30;

function findSentenceStartTokenIndex(tokens: SpeechToken[], tokenIndex: number) {
  let index = clamp(tokenIndex, 0, tokens.length - 1);
  const floorSec = tokens[index]!.startSec - MAX_SENTENCE_LOOKBACK_SEC;

  while (
    index > 0 &&
    !tokens[index - 1]!.terminal &&
    tokens[index - 1]!.startSec >= floorSec
  ) {
    index -= 1;
  }

  return index;
}

/** Pads a token's end without ever crossing into the next token: when the
 *  speaker keeps talking, the clip ends just before the next word starts
 *  instead of a fixed pad past the last one. */
function collisionSafePaddedEnd(
  tokens: SpeechToken[],
  index: number,
  sourceDurationSec: number,
  tailPadSec: number,
) {
  const token = tokens[index]!;
  const next = tokens[index + 1];
  let paddedEnd = Math.min(sourceDurationSec, token.endSec + tailPadSec);

  if (next) {
    paddedEnd = Math.min(
      paddedEnd,
      Math.max(token.endSec, next.startSec - SPEECH_COLLISION_GAP_SEC),
    );
  }

  return paddedEnd;
}

function chooseMarketWindowEnd(input: {
  tokens: SpeechToken[];
  startIndex: number;
  startSec: number;
  rawEndSec: number;
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
  // The preferred 30-60s band is deliberately NOT enforced here: the LLM is
  // already prompted toward it and durationOptimality penalizes departures at
  // ranking time. Hard-gating the end to the band is what used to drag every
  // clip back to ~preferredMin and cut payoffs.
  const maxEnd = Math.min(
    input.sourceDurationSec,
    input.startSec + input.maxDurationSec,
  );
  const terminalEnds: Array<{ endSec: number; paddedEnd: number }> = [];
  let lastTokenEnd: number | null = null;

  for (let index = input.startIndex; index < input.tokens.length; index++) {
    const token = input.tokens[index]!;

    if (token.startSec > maxEnd) {
      break;
    }

    // A token whose own end crosses the hard maximum can't be a candidate —
    // the final clamp to maxEnd would slice it mid-word.
    if (token.endSec > maxEnd) {
      continue;
    }

    const paddedEnd = collisionSafePaddedEnd(
      input.tokens,
      index,
      input.sourceDurationSec,
      input.tailPadSec,
    );

    if (paddedEnd <= input.startSec) {
      continue;
    }

    lastTokenEnd = paddedEnd;

    if (token.terminal) {
      terminalEnds.push({ endSec: token.endSec, paddedEnd });
    }
  }

  // The LLM chose its end for a reason — the payoff sits just before it — so
  // complete the sentence CONTAINING the requested end instead of taking the
  // first sentence end past the preferred minimum (the old first-fit rule
  // collapsed every clip to ~preferredMin seconds and amputated payoffs).
  // The raw target is clamped into the allowed window first so an
  // out-of-policy request still lands on the nearest compliant sentence end.
  // Proximity is judged on UNPADDED word ends so the tail pad can't skew it.
  // A raw span shorter than the policy minimum is a degenerate request (the
  // repair will inflate it regardless), so its end carries no payoff signal —
  // target the market-preferred window instead of the raw end.
  const degenerateRawSpan =
    input.rawEndSec - input.startSec < input.minDurationSec;
  const rawTarget = clamp(
    degenerateRawSpan
      ? input.startSec + input.preferredMinDurationSec
      : input.rawEndSec,
    minEnd,
    maxEnd,
  );
  // A raw end that lands shortly after a sentence's final word (the LLM's
  // ends usually include the pause after it) still counts as "inside" that
  // sentence rather than forcing a jump to the next one.
  const completionToleranceSec = 1.0;

  const validCandidates = terminalEnds.filter(
    (candidate) =>
      candidate.paddedEnd >= minEnd && candidate.paddedEnd <= maxEnd,
  );

  if (degenerateRawSpan) {
    const preferredMinEnd = Math.min(
      input.sourceDurationSec,
      input.startSec + input.preferredMinDurationSec,
    );
    const preferredMaxEnd = Math.min(
      input.sourceDurationSec,
      input.startSec + input.preferredMaxDurationSec,
    );
    const preferred = validCandidates.find(
      (candidate) =>
        candidate.paddedEnd >= preferredMinEnd &&
        candidate.paddedEnd <= preferredMaxEnd,
    );

    if (preferred !== undefined) {
      return preferred.paddedEnd;
    }
  }

  const completing = validCandidates.find(
    (candidate) => candidate.endSec >= rawTarget - completionToleranceSec,
  );

  if (completing !== undefined) {
    return completing.paddedEnd;
  }

  // No sentence end at/after the target fits the window — fall back to the
  // valid sentence end nearest the target (ties go to the later one: a
  // slightly longer clip beats a truncated one).
  if (validCandidates.length > 0) {
    return validCandidates.reduce((best, candidate) => {
      const bestDelta = Math.abs(best.endSec - rawTarget);
      const delta = Math.abs(candidate.endSec - rawTarget);
      if (delta < bestDelta) return candidate;
      if (delta === bestDelta && candidate.endSec > best.endSec) {
        return candidate;
      }
      return best;
    }).paddedEnd;
  }

  const lastTerminal = terminalEnds.at(-1);

  if (lastTerminal !== undefined) {
    return lastTerminal.paddedEnd;
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
    rawEndSec: rawEnd,
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

  // Fix the max-duration ceiling to the FIRST WORD's start before applying
  // pre-roll: the pre-roll adds up to 0.15s of leading silence, and letting
  // it lower the ceiling could shave the chosen (word-aligned) end mid-word.
  const endCeilingSec = Math.min(
    sourceDurationSec,
    effectiveStart + maxDurationSec,
  );

  // Pre-roll: back the start off the first word slightly so its opening
  // phoneme isn't clipped, but never into the previous word (contiguous
  // speech keeps the exact word start).
  const prevToken = startIndex > 0 ? tokens[startIndex - 1] : null;
  const preRollStart = Math.max(
    prevToken ? prevToken.endSec + PRE_ROLL_MIN_GAP_SEC : 0,
    effectiveStart - START_PRE_ROLL_SEC,
  );
  effectiveStart = Math.min(effectiveStart, preRollStart);

  effectiveStart = normalizeTime(clamp(effectiveStart, 0, sourceDurationSec));
  effectiveEnd = normalizeTime(
    clamp(effectiveEnd, effectiveStart, endCeilingSec),
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
    let sentenceEndIndex = last.index;
    const remainingWords = words.slice(last.index);
    const terminalOffset = remainingWords.findIndex((entry) =>
      isTerminalWord(entry.word),
    );

    if (terminalOffset >= 0) {
      sentenceEnd = remainingWords[terminalOffset]!.word.endSec;
      sentenceEndIndex = last.index + terminalOffset;
    } else {
      sentenceEnd = last.utterance.endSec;
    }

    // Same collision rule as the market-window path: the pad must not cross
    // into the word that follows the sentence end. In the no-terminal branch
    // sentenceEnd is the UTTERANCE end, so the relevant neighbor is the first
    // word starting after it — not the word adjacent to `last`.
    const nextEntry =
      terminalOffset >= 0
        ? words[sentenceEndIndex + 1]
        : words.find((entry) => entry.word.startSec >= sentenceEnd);
    let paddedSentenceEnd = sentenceEnd + tailPadSec;
    if (nextEntry) {
      paddedSentenceEnd = Math.min(
        paddedSentenceEnd,
        Math.max(
          sentenceEnd,
          nextEntry.word.startSec - SPEECH_COLLISION_GAP_SEC,
        ),
      );
    }

    effectiveEnd = Math.max(effectiveEnd, paddedSentenceEnd);
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
