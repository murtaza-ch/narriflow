import { describe, expect, test } from "bun:test";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";
import { splitUtterancesIntoSentences } from "./utterance-split";

function makeWords(
  sentences: string[][],
  options?: { startSec?: number; wordSec?: number; gapSec?: number },
): TranscriptWord[] {
  const wordSec = options?.wordSec ?? 0.3;
  const gapSec = options?.gapSec ?? 0.05;
  let cursor = options?.startSec ?? 0;
  const words: TranscriptWord[] = [];

  for (const sentence of sentences) {
    for (const word of sentence) {
      words.push({
        word,
        startSec: Math.round(cursor * 1000) / 1000,
        endSec: Math.round((cursor + wordSec) * 1000) / 1000,
        confidence: 0.95,
      });
      cursor += wordSec + gapSec;
    }
  }

  return words;
}

function makeTurn(words: TranscriptWord[]): TranscriptUtterance {
  return {
    index: 0,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec: words[0]!.startSec,
    endSec: words[words.length - 1]!.endSec,
    text: words.map((w) => w.word).join(" "),
    confidence: 0.95,
    words,
  };
}

describe("splitUtterancesIntoSentences", () => {
  test("splits a monologue speaker turn into sentence-level utterances", () => {
    const words = makeWords([
      ["What's", "up", "everybody?"],
      ["Check", "this", "design", "out."],
      ["I'm", "going", "to", "show", "you."],
    ]);
    const result = splitUtterancesIntoSentences([makeTurn(words)]);

    expect(result).toHaveLength(3);
    expect(result[0]!.text).toBe("What's up everybody?");
    expect(result[1]!.text).toBe("Check this design out.");
    expect(result[2]!.text).toBe("I'm going to show you.");
    expect(result.map((u) => u.index)).toEqual([0, 1, 2]);
    // Timing comes from the sentence's own words, not the source turn.
    expect(result[1]!.startSec).toBe(result[1]!.words[0]!.startSec);
    expect(result[1]!.endSec).toBe(result[1]!.words.at(-1)!.endSec);
    // Speaker identity is preserved.
    expect(result.every((u) => u.speaker === 0)).toBe(true);
  });

  test("force-splits a long unpunctuated stretch at the largest pause", () => {
    const words: TranscriptWord[] = [];
    // 40 words, one per second, no punctuation — with a 3s pause after word 17.
    let cursor = 0;
    for (let i = 0; i < 40; i++) {
      words.push({
        word: `w${i}`,
        startSec: cursor,
        endSec: cursor + 0.5,
        confidence: 0.9,
      });
      cursor += i === 17 ? 3.5 : 1;
    }

    const result = splitUtterancesIntoSentences([makeTurn(words)], {
      maxSentenceDurationSec: 25,
    });

    expect(result.length).toBeGreaterThan(1);
    // The first forced split lands at the 3.5s pause (after w17), not at an
    // arbitrary word.
    expect(result[0]!.words.at(-1)!.word).toBe("w17");
  });

  test("is idempotent on already sentence-sized utterances", () => {
    const words = makeWords([["Hello", "there."], ["Great", "stuff."]]);
    const once = splitUtterancesIntoSentences([makeTurn(words)]);
    const twice = splitUtterancesIntoSentences(once);

    expect(twice).toEqual(once);
  });

  test("passes through utterances without word timings", () => {
    const utterance: TranscriptUtterance = {
      index: 0,
      speaker: 0,
      speakerLabel: "Speaker 1",
      startSec: 0,
      endSec: 10,
      text: "No words here. Two sentences though.",
      confidence: null,
      words: [],
    };

    const result = splitUtterancesIntoSentences([utterance]);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe(utterance.text);
  });
});

describe("abbreviation-aware terminal detection", () => {
  test("does not split on Dr. / U.S. / list markers", () => {
    const words = makeWords([
      ["Dr.", "Smith", "went", "to", "the", "U.S.", "in", "1999."],
      ["He", "stayed."],
    ]);
    const result = splitUtterancesIntoSentences([makeTurn(words)]);

    expect(result.map((u) => u.text)).toEqual([
      "Dr. Smith went to the U.S. in 1999.",
      "He stayed.",
    ]);
  });

  test("list markers like '1.' do not close a sentence", () => {
    const words = makeWords([["1.", "Set", "up", "the", "design", "system."]]);
    const result = splitUtterancesIntoSentences([makeTurn(words)]);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("1. Set up the design system.");
  });

  test("unsorted or invalid word timings are sorted/filtered, never emitting endSec < startSec", () => {
    const words = makeWords([["Hello", "there."], ["Great", "stuff."]]);
    const shuffled = [words[2]!, words[0]!, words[3]!, words[1]!];
    const result = splitUtterancesIntoSentences([makeTurn(shuffled)]);

    for (const utterance of result) {
      expect(utterance.endSec).toBeGreaterThanOrEqual(utterance.startSec);
    }
    expect(result.map((u) => u.text)).toEqual(["Hello there.", "Great stuff."]);
  });
});
