import { describe, expect, test } from "bun:test";
import {
  buildTranscriptSliceForWindow,
  expandClipToCompleteSpeech,
  getEffectiveClipTiming,
  mergeCorrectedWordsIntoWindow,
} from "./clip-timing";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";
import { splitUtterancesIntoSentences } from "./utterance-split";

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

describe("buildTranscriptSliceForWindow (vizard-parity.md Phase B step 13, in-studio trim)", () => {
  test("matches the server boundary path (getEffectiveClipTiming) when the window already sits on sentence edges", () => {
    // A window that's already sentence-aligned makes expandClipToMarketWindow
    // a no-op, so getEffectiveClipTiming's own transcriptSlice reduces to
    // exactly the same normalizeTranscriptSliceForClip pass this helper
    // runs — the two client/server paths must agree byte-for-byte here.
    const raw = makeSpeech({ sentenceCount: 6, startSec: 5 });
    const window = {
      startSec: raw[1]!.words[0]!.startSec,
      endSec: raw[4]!.words.at(-1)!.endSec,
    };

    const clientSlice = buildTranscriptSliceForWindow(raw, window);
    const serverSlice = getEffectiveClipTiming({
      utterances: splitUtterancesIntoSentences(raw),
      startSec: window.startSec,
      endSec: window.endSec,
      tailPadSec: 0,
    }).transcriptSlice;

    expect(clientSlice).toEqual(serverSlice);
  });

  test("intersects the window and snaps/clamps words at its edges", () => {
    const raw = makeSpeech({ sentenceCount: 4, startSec: 0 });
    const midWord = raw[1]!.words[2]!;
    // A window ending mid-word clamps that word's endSec to the window
    // instead of dropping it — matches normalizeTranscriptSliceForClip.
    const window = { startSec: raw[0]!.words[0]!.startSec, endSec: midWord.startSec + 0.05 };

    const slice = buildTranscriptSliceForWindow(raw, window);
    const lastUtterance = slice.at(-1)!;
    const lastWord = lastUtterance.words.at(-1)!;
    expect(lastWord.word).toBe(midWord.word);
    expect(lastWord.endSec).toBeCloseTo(window.endSec, 2);
    // Nothing past the window survives (small epsilon for the same
    // millisecond rounding normalizeTranscriptSliceForClip applies).
    expect(slice.every((u) => u.endSec <= window.endSec + 0.001)).toBe(true);
  });

  test("extending the window pulls in words that were previously outside it", () => {
    const raw = makeSpeech({ sentenceCount: 5, startSec: 0 });
    const narrowSlice = buildTranscriptSliceForWindow(raw, {
      startSec: raw[2]!.words[0]!.startSec,
      endSec: raw[2]!.words.at(-1)!.endSec,
    });
    expect(narrowSlice).toHaveLength(1);

    const extendedSlice = buildTranscriptSliceForWindow(raw, {
      startSec: raw[0]!.words[0]!.startSec,
      endSec: raw[4]!.words.at(-1)!.endSec,
    });
    expect(extendedSlice).toHaveLength(5);
    expect(extendedSlice[0]!.text).toBe(raw[0]!.text);
    expect(extendedSlice.at(-1)!.text).toBe(raw[4]!.text);
  });

  test("an empty window (no overlapping speech) returns an empty slice", () => {
    const raw = makeSpeech({ sentenceCount: 2, startSec: 0 });
    const lastWordEnd = raw.at(-1)!.words.at(-1)!.endSec;
    const slice = buildTranscriptSliceForWindow(raw, {
      startSec: lastWordEnd + 5,
      endSec: lastWordEnd + 10,
    });
    expect(slice).toEqual([]);
  });
});

describe("mergeCorrectedWordsIntoWindow (Phase B closing review finding 1: commitTrim discards word corrections)", () => {
  test("a correction inside the kept window survives a shrink then an extend", () => {
    const raw = makeSpeech({ sentenceCount: 5, startSec: 0 });
    const fullWindow = {
      startSec: raw[0]!.words[0]!.startSec,
      endSec: raw[4]!.words.at(-1)!.endSec,
    };
    const initialSlice = buildTranscriptSliceForWindow(raw, fullWindow);
    const correctedWord = initialSlice[2]!.words[1]!;

    // Correct one word inside sentence 2.
    const correctedSlice = initialSlice.map((u, i) => {
      if (i !== 2) return u;
      const words = u.words.map((w, wi) => (wi === 1 ? { ...w, word: "CORRECTED" } : w));
      return { ...u, words, text: words.map((w) => w.word).join(" ") };
    });

    // Shrink: new window drops sentences 0 and 4 but keeps the corrected word.
    const shrinkWindow = {
      startSec: raw[1]!.words[0]!.startSec,
      endSec: raw[3]!.words.at(-1)!.endSec,
    };
    const shrinkRaw = buildTranscriptSliceForWindow(raw, shrinkWindow);
    const shrinkMerged = mergeCorrectedWordsIntoWindow(shrinkRaw, correctedSlice);
    const shrinkWord = shrinkMerged
      .flatMap((u) => u.words)
      .find((w) => Math.abs(w.startSec - correctedWord.startSec) < 0.001);
    expect(shrinkWord?.word).toBe("CORRECTED");

    // Extend back out to the full window — the correction now lives in
    // `shrinkMerged` (the current doc slice at this point) and must still
    // survive being merged into a freshly rebuilt, wider raw slice.
    const extendRaw = buildTranscriptSliceForWindow(raw, fullWindow);
    const extendMerged = mergeCorrectedWordsIntoWindow(extendRaw, shrinkMerged);
    const extendWord = extendMerged
      .flatMap((u) => u.words)
      .find((w) => Math.abs(w.startSec - correctedWord.startSec) < 0.001);
    expect(extendWord?.word).toBe("CORRECTED");
    const owningUtterance = extendMerged.find((u) => u.words.some((w) => w.word === "CORRECTED"));
    expect(owningUtterance?.text).toContain("CORRECTED");
    // Sentences that re-entered the window on the extend (0 and 4) never
    // appeared in `shrinkMerged` — they must come back with raw text.
    expect(extendMerged[0]!.text).toBe(raw[0]!.text);
    expect(extendMerged.at(-1)!.text).toBe(raw[4]!.text);
  });

  test("words newly entering the window on an extend keep their raw text", () => {
    const raw = makeSpeech({ sentenceCount: 5, startSec: 0 });
    const narrowWindow = {
      startSec: raw[2]!.words[0]!.startSec,
      endSec: raw[2]!.words.at(-1)!.endSec,
    };
    const currentSlice = buildTranscriptSliceForWindow(raw, narrowWindow);
    expect(currentSlice).toHaveLength(1);

    const widerWindow = {
      startSec: raw[0]!.words[0]!.startSec,
      endSec: raw[4]!.words.at(-1)!.endSec,
    };
    const widerRaw = buildTranscriptSliceForWindow(raw, widerWindow);
    const merged = mergeCorrectedWordsIntoWindow(widerRaw, currentSlice);

    // Sentence 0 never appeared in `currentSlice` (the pre-extend doc slice)
    // — it must come through byte-for-byte from the raw transcript.
    expect(merged[0]!.text).toBe(raw[0]!.text);
    expect(merged[0]!.words.map((w) => w.word)).toEqual(raw[0]!.words.map((w) => w.word));
  });

  test("preserves corrections spread across multiple utterances", () => {
    const raw = makeSpeech({ sentenceCount: 4, startSec: 0 });
    const window = {
      startSec: raw[0]!.words[0]!.startSec,
      endSec: raw[3]!.words.at(-1)!.endSec,
    };
    const rawSlice = buildTranscriptSliceForWindow(raw, window);

    const corrected = rawSlice.map((u, i) => {
      if (i !== 0 && i !== 3) return u;
      const words = u.words.map((w, wi) => (wi === 0 ? { ...w, word: `FIXED${i}` } : w));
      return { ...u, words, text: words.map((w) => w.word).join(" ") };
    });

    const merged = mergeCorrectedWordsIntoWindow(rawSlice, corrected);
    expect(merged[0]!.words[0]!.word).toBe("FIXED0");
    expect(merged[3]!.words[0]!.word).toBe("FIXED3");
    // Untouched utterances keep their original raw text.
    expect(merged[1]!.text).toBe(rawSlice[1]!.text);
    expect(merged[2]!.text).toBe(rawSlice[2]!.text);
  });
});
