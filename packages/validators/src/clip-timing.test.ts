import { describe, expect, test } from "bun:test";
import {
  expandClipToCompleteSpeech,
  getEffectiveClipTiming,
} from "./clip-timing";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";

const POLICY = {
  minDurationSec: 15,
  preferredMinDurationSec: 30,
  preferredMaxDurationSec: 60,
  maxDurationSec: 90,
};

/** Continuous speech: sentences of `wordsPerSentence` words, terminal
 *  punctuation on the last word, `interSentenceGapSec` of silence between
 *  sentences and `interWordGapSec` inside them. */
function makeSpeech(options: {
  sentenceCount: number;
  wordsPerSentence?: number;
  wordSec?: number;
  interWordGapSec?: number;
  interSentenceGapSec?: number;
  startSec?: number;
}): TranscriptUtterance[] {
  const wordsPerSentence = options.wordsPerSentence ?? 8;
  const wordSec = options.wordSec ?? 0.3;
  const interWordGapSec = options.interWordGapSec ?? 0.06;
  const interSentenceGapSec = options.interSentenceGapSec ?? 0.4;
  let cursor = options.startSec ?? 0;
  const utterances: TranscriptUtterance[] = [];

  for (let s = 0; s < options.sentenceCount; s++) {
    const words: TranscriptWord[] = [];
    for (let w = 0; w < wordsPerSentence; w++) {
      const last = w === wordsPerSentence - 1;
      words.push({
        word: `s${s}w${w}${last ? "." : ""}`,
        startSec: Math.round(cursor * 1000) / 1000,
        endSec: Math.round((cursor + wordSec) * 1000) / 1000,
        confidence: 0.95,
      });
      cursor += wordSec + (last ? interSentenceGapSec : interWordGapSec);
    }
    utterances.push({
      index: s,
      speaker: 0,
      speakerLabel: "Speaker 1",
      startSec: words[0]!.startSec,
      endSec: words.at(-1)!.endSec,
      text: words.map((w) => w.word).join(" "),
      confidence: 0.95,
      words,
    });
  }

  return utterances;
}

function allWords(utterances: TranscriptUtterance[]): TranscriptWord[] {
  return utterances.flatMap((u) => u.words);
}

/** True when `sec` falls strictly inside some word's span — i.e. the cut
 *  would land mid-word. */
function cutsInsideAWord(utterances: TranscriptUtterance[], sec: number) {
  return allWords(utterances).some(
    (word) => word.startSec < sec && word.endSec > sec,
  );
}

describe("market-window end selection (LLM rawEnd)", () => {
  test("snaps to the sentence end nearest the requested end, not the first one after preferredMin", () => {
    // Sentences ~3.28s + 0.4s gap apart; terminals roughly every 3.7s.
    const utterances = makeSpeech({ sentenceCount: 20 });
    const rawEnd = 45;

    const effective = getEffectiveClipTiming({
      utterances,
      startSec: 0.05,
      endSec: rawEnd,
      sourceDurationSec: 120,
      ...POLICY,
    });

    // Old behavior collapsed to the first terminal >= 30s. The requested end
    // must survive to within one sentence.
    expect(effective.endSec).toBeGreaterThan(42);
    expect(effective.endSec).toBeLessThan(49);
    expect(cutsInsideAWord(utterances, effective.endSec)).toBe(false);
  });

  test("degenerate raw span falls back to the preferred window", () => {
    const utterances = makeSpeech({ sentenceCount: 20 });

    const effective = getEffectiveClipTiming({
      utterances,
      startSec: 8.2,
      endSec: 9.4, // 1.2s — far below minDurationSec
      sourceDurationSec: 120,
      ...POLICY,
    });

    expect(effective.durationSec).toBeGreaterThanOrEqual(
      POLICY.preferredMinDurationSec - 1,
    );
    expect(effective.durationSec).toBeLessThanOrEqual(
      POLICY.preferredMaxDurationSec,
    );
  });
});

describe("collision-safe tail pad", () => {
  test("never pads into the next word when speech continues immediately", () => {
    // Tiny inter-sentence gap (0.11s): the 0.25s pad would land inside the
    // next sentence's first word — the production "There's"/"Okay?" bug.
    const utterances = makeSpeech({
      sentenceCount: 20,
      interSentenceGapSec: 0.11,
    });
    const words = allWords(utterances);

    const effective = getEffectiveClipTiming({
      utterances,
      startSec: 0.05,
      endSec: 32,
      sourceDurationSec: 120,
      ...POLICY,
    });

    expect(cutsInsideAWord(utterances, effective.endSec)).toBe(false);
    // The end must sit strictly before the next word begins.
    const nextWord = words.find((w) => w.startSec >= effective.endSec - 0.001);
    if (nextWord) {
      expect(effective.endSec).toBeLessThanOrEqual(nextWord.startSec);
    }
    // And the transcript slice must not include a dangling fragment of the
    // next sentence.
    const lastSliceWord = effective.transcriptSlice.at(-1)!.words.at(-1)!;
    expect(lastSliceWord.word.endsWith(".")).toBe(true);
  });

  test("keeps the full pad when real silence follows the sentence end", () => {
    const utterances = makeSpeech({
      sentenceCount: 12,
      interSentenceGapSec: 1.2,
    });

    const effective = getEffectiveClipTiming({
      utterances,
      startSec: 0.05,
      endSec: 33,
      sourceDurationSec: 120,
      ...POLICY,
    });

    const terminalWord = allWords(utterances)
      .filter((w) => w.endSec <= effective.endSec)
      .at(-1)!;
    expect(effective.endSec - terminalWord.endSec).toBeCloseTo(0.25, 2);
  });

  test("studio path (expandClipToCompleteSpeech) also clamps the pad to the next word", () => {
    const utterances = makeSpeech({
      sentenceCount: 4,
      interSentenceGapSec: 0.1,
    });
    const firstSentenceEnd = utterances[0]!.words.at(-1)!;
    const secondSentenceStart = utterances[1]!.words[0]!;

    const timing = expandClipToCompleteSpeech({
      utterances,
      startSec: 0,
      endSec: firstSentenceEnd.endSec - 0.2, // mid final word
      sourceDurationSec: 60,
    });

    expect(timing.endSec).toBeGreaterThanOrEqual(firstSentenceEnd.endSec);
    expect(timing.endSec).toBeLessThanOrEqual(secondSentenceStart.startSec);
  });

  test("tailPadSec 0 makes slice-only re-derivation keep the stored end", () => {
    const utterances = makeSpeech({ sentenceCount: 10 });
    const detected = getEffectiveClipTiming({
      utterances,
      startSec: 0.05,
      endSec: 33,
      sourceDurationSec: 120,
      ...POLICY,
    });

    // Re-derive from the clip's own slice only (what render/preview/snapshot
    // do) — with pad 0 the stored end must come back unchanged.
    const rederived = getEffectiveClipTiming({
      utterances: detected.transcriptSlice,
      startSec: detected.startSec,
      endSec: detected.endSec,
      sourceDurationSec: 120,
      tailPadSec: 0,
    });

    expect(rederived.startSec).toBe(detected.startSec);
    expect(rederived.endSec).toBe(detected.endSec);
  });
});

describe("start pre-roll", () => {
  test("backs off the first word by up to 0.15s into silence", () => {
    const utterances = makeSpeech({
      sentenceCount: 20,
      interSentenceGapSec: 1.0,
      startSec: 5,
    });
    // Ask for a start mid-way through sentence 3: it snaps back to the
    // sentence's first word, minus pre-roll.
    const sentence3Start = utterances[3]!.words[0]!.startSec;

    const effective = getEffectiveClipTiming({
      utterances,
      startSec: sentence3Start + 1,
      endSec: sentence3Start + 35,
      sourceDurationSec: 120,
      ...POLICY,
    });

    expect(sentence3Start - effective.startSec).toBeCloseTo(0.15, 2);
  });

  test("never reaches back into the previous word under contiguous speech", () => {
    const utterances = makeSpeech({
      sentenceCount: 20,
      interSentenceGapSec: 0.05,
      startSec: 5,
    });
    const sentence3Start = utterances[3]!.words[0]!.startSec;
    const prevWordEnd = utterances[2]!.words.at(-1)!.endSec;

    const effective = getEffectiveClipTiming({
      utterances,
      startSec: sentence3Start + 1,
      endSec: sentence3Start + 35,
      sourceDurationSec: 120,
      ...POLICY,
    });

    expect(effective.startSec).toBeGreaterThanOrEqual(prevWordEnd);
    expect(effective.startSec).toBeLessThanOrEqual(sentence3Start);
  });
});
