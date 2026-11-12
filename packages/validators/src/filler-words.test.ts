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
    for (const text of ["um", "Um,", "Uh...", "uhm", "erm.", "Uhh", "U"+"m—"]) {
      expect(isFillerWord({ word: text }, "en")).toBe(true);
    }
  });

  test("keeps words that carry meaning", () => {
    for (const text of ["uh-huh", "like", "umbrella", "her", "hmm", "you", "ER", "UM", "UH."]) {
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

  test("a filler another speaker talks over is kept without keeping its neighbours", () => {
    // Speaker 2's "uh" overlaps speaker 1's "people"; the later "erm" overlaps nothing.
    const utterances = [
      utterance(0, [word(11.187, 11.791, "people")]),
      utterance(1, [word(11.697, 12.025, "uh"), word(12.306, 12.77, "erm."), word(12.805, 13.398, "a")]),
    ];
    const cuts = detectFillerWordRanges(utterances, window, { languageCode: "en" });
    expect(cuts.some((c) => c.startSec <= 12.306 && c.endSec >= 12.77)).toBe(true);
    expect(cuts.some((c) => c.startSec < 12.025 && c.endSec > 11.697)).toBe(false);
  });

  test("a filler overlapping a kept filler is kept too", () => {
    // "erm" is talked over by "build", so it stays; "Um" overlaps "erm" and must stay with it.
    const utterances = [
      utterance(0, [word(14.6, 14.79, "so"), word(15.517, 15.992, "erm.")]),
      utterance(1, [word(15.429, 15.558, "Um,"), word(15.777, 16.112, "build")]),
      utterance(2, [word(16.179, 16.753, "we")]),
    ];
    expect(detectFillerWordRanges(utterances, window, { languageCode: "en" })).toEqual([]);
  });

  test("fillers far apart are separate cuts, never one cut over the pause (Sol P2)", () => {
    const utterances = [utterance(0, [word(0, 1, "So"), word(1.2, 1.4, "um"), word(8.5, 8.7, "uh"), word(9, 10, "go")])];
    expect(detectFillerWordRanges(utterances, window, { languageCode: "en" })).toEqual([
      { startSec: 1.15, endSec: 1.4 },
      { startSec: 8.5, endSec: 8.75 },
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
