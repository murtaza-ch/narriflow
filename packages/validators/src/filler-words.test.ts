import { describe, expect, test } from "bun:test";

import type { ClipWindow } from "./edit-ranges";
import { detectFillerWordRanges, isFillerWord, supportsFillerWordRemoval } from "./filler-words";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";

function word(startSec: number, endSec: number, text: string): TranscriptWord {
  return { word: text, startSec, endSec, confidence: null };
}

function utterance(index: number, words: TranscriptWord[]): TranscriptUtterance {
  return {
    index,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec: words[0]?.startSec ?? 0,
    endSec: words.at(-1)?.endSec ?? 0,
    text: words.map((w) => w.word).join(" "),
    confidence: null,
    words,
  };
}

const window: ClipWindow = { startSec: 0, endSec: 20 };

describe("isFillerWord", () => {
  test("matches hesitation sounds regardless of case and punctuation", () => {
    for (const text of ["um", "Um,", "UH...", "uhm", "erm.", "Uhh"]) {
      expect(isFillerWord({ word: text }, "en")).toBe(true);
    }
  });

  test("keeps words that carry meaning", () => {
    for (const text of ["uh-huh", "like", "umbrella", "her", "hmm", "you"]) {
      expect(isFillerWord({ word: text }, "en")).toBe(false);
    }
  });

  test("only for supported languages", () => {
    // "um" is Portuguese for "a"; "er" is German for "he".
    expect(isFillerWord({ word: "um" }, "pt")).toBe(false);
    expect(isFillerWord({ word: "er" }, "de")).toBe(false);
    expect(isFillerWord({ word: "um" }, null)).toBe(false);
    expect(supportsFillerWordRemoval("en")).toBe(true);
    expect(supportsFillerWordRemoval("en-US")).toBe(true);
    expect(supportsFillerWordRemoval("ur")).toBe(false);
  });
});

describe("detectFillerWordRanges", () => {
  test("removes a filler and closes up the pauses around it", () => {
    // "I was, um, like" — was ends 10.26, um 10.40-10.60, like starts 10.70.
    const utterances = [utterance(0, [word(10.0, 10.26, "was,"), word(10.4, 10.6, "um,"), word(10.7, 10.9, "like")])];
    // Tight gaps: the cut is the filler's own timing.
    expect(detectFillerWordRanges(utterances, window, { languageCode: "en" })).toEqual([{ startSec: 10.4, endSec: 10.6 }]);
  });

  test("closes up hesitation pauses but keeps padding beside speech", () => {
    // "so .. uh .. we": 0.15 kept after "so", 0.25 kept before "we".
    const utterances = [utterance(0, [word(1, 1.5, "So"), word(2.2, 2.5, "uh"), word(3.3, 3.6, "we")])];
    expect(detectFillerWordRanges(utterances, window, { languageCode: "en" })).toEqual([{ startSec: 1.65, endSec: 3.05 }]);
  });

  test("leaves a pause of silence length beside a filler to silence removal", () => {
    // 1.5 s pause after "uh": the cut stops at the filler on that side.
    const utterances = [utterance(0, [word(1, 1.5, "So"), word(1.9, 2.2, "uh"), word(3.7, 4, "we")])];
    expect(detectFillerWordRanges(utterances, window, { languageCode: "en" })).toEqual([{ startSec: 1.65, endSec: 2.2 }]);
  });

  test("a run of fillers is one cut, across utterances", () => {
    const utterances = [
      utterance(0, [word(1, 1.5, "Well"), word(1.6, 1.8, "um,")]),
      utterance(1, [word(1.9, 2.1, "uh,"), word(2.2, 2.6, "yes")]),
    ];
    expect(detectFillerWordRanges(utterances, window, { languageCode: "en" })).toEqual([{ startSec: 1.6, endSec: 2.1 }]);
  });

  test("a filler at the clip start removes the lead-in too", () => {
    const utterances = [utterance(0, [word(0.5, 0.8, "Um,"), word(1.3, 2, "today")])];
    expect(detectFillerWordRanges(utterances, { startSec: 0, endSec: 5 }, { languageCode: "en" })).toEqual([
      { startSec: 0, endSec: 1.05 },
    ]);
  });

  test("leaves fillers it cannot place safely", () => {
    const instant = [utterance(0, [word(1, 1.5, "So"), word(2, 2, "um"), word(3, 3.5, "yes")])];
    expect(detectFillerWordRanges(instant, window, { languageCode: "en" })).toEqual([]);
  });

  test("returns nothing for an unsupported language", () => {
    const utterances = [utterance(0, [word(1, 1.5, "eu"), word(2, 2.3, "um"), word(3, 3.5, "livro")])];
    expect(detectFillerWordRanges(utterances, window, { languageCode: "pt" })).toEqual([]);
  });
});
