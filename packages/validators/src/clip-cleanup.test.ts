import { describe, expect, test } from "bun:test";

import {
  decodeQuietRanges,
  detectClipCleanupRanges,
  encodedQuietRangesSchema,
  encodeQuietRanges,
  QUIET_RANGES_MAX_INTERVALS,
} from "./clip-cleanup";
import { buildClipCutPlan, sourceWordToEdited, type ClipWindow } from "./edit-ranges";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";

function word(startSec: number, endSec: number, text = "w"): TranscriptWord {
  return { word: text, startSec, endSec, confidence: null };
}

function utterance(words: TranscriptWord[]): TranscriptUtterance {
  return { index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, text: "x", confidence: null, words };
}

describe("quiet range encoding", () => {
  test("round-trips as centisecond gap/length pairs", () => {
    const ranges = [{ startSec: 1.5, endSec: 2.25 }, { startSec: 4, endSec: 7.1 }];
    const encoded = encodeQuietRanges(ranges)!;
    expect(encoded).toEqual([150, 75, 175, 310]);
    expect(encodedQuietRangesSchema.parse(encoded)).toEqual(encoded);
    expect(decodeQuietRanges(encoded)).toEqual(ranges);
  });

  test("shrinks to whole centiseconds so a quiet interval never grows", () => {
    expect(decodeQuietRanges(encodeQuietRanges([{ startSec: 1.234, endSec: 2.346 }])!)).toEqual([{ startSec: 1.24, endSec: 2.34 }]);
    expect(encodeQuietRanges([{ startSec: 1.231, endSec: 1.239 }])).toEqual([]);
  });

  test("silencedetect's negative first start clamps to zero", () => {
    expect(decodeQuietRanges(encodeQuietRanges([{ startSec: -0.02, endSec: 0.5 }])!)).toEqual([{ startSec: 0, endSec: 0.5 }]);
  });

  test("too many intervals stores none", () => {
    const many = Array.from({ length: QUIET_RANGES_MAX_INTERVALS + 1 }, (_, i) => ({ startSec: i, endSec: i + 0.5 }));
    expect(encodeQuietRanges(many)).toBeNull();
  });

  test("an odd-length encoding is rejected", () => {
    expect(encodedQuietRangesSchema.safeParse([1, 2, 3]).success).toBe(false);
  });
});

describe("detectClipCleanupRanges", () => {
  const window: ClipWindow = { startSec: 0, endSec: 10 };
  // "So [2.5 s pause] um we": a long pause, then a filler.
  const utterances = [utterance([word(0, 1, "So"), word(3.5, 3.8, "um"), word(3.9, 5, "we"), word(5.1, 10, "go")])];
  const quiet = [{ startSec: 0.9, endSec: 3.6 }];

  test("nothing asked for, nothing cut", () => {
    expect(detectClipCleanupRanges(utterances, window, { removeSilences: false, removeFillerWords: false, quietRanges: quiet, languageCode: "en" })).toEqual([]);
  });

  test("silence removal needs measured quiet audio", () => {
    const options = { removeSilences: true, removeFillerWords: false, languageCode: "en" };
    expect(detectClipCleanupRanges(utterances, window, { ...options, quietRanges: null })).toEqual([]);
    expect(detectClipCleanupRanges(utterances, window, { ...options, quietRanges: quiet })).toEqual([{ startSec: 1.15, endSec: 3.25 }]);
  });

  test("silences and fillers union into normalized cuts", () => {
    expect(detectClipCleanupRanges(utterances, window, { removeSilences: true, removeFillerWords: true, quietRanges: quiet, languageCode: "en" })).toEqual([
      { startSec: 1.15, endSec: 3.8 },
    ]);
  });

  test("filler removal works without quiet ranges", () => {
    expect(detectClipCleanupRanges(utterances, window, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "en" })).toEqual([
      { startSec: 3.5, endSec: 3.8 },
    ]);
  });

  test("a short word between two cuts is never joined over", () => {
    // "um" cut, then "a" (0.1 s, real speech), then a quiet pause cut.
    const words = [utterance([word(0, 1, "So"), word(1.1, 1.3, "um"), word(1.35, 1.45, "a"), word(1.5, 2, "b"), word(4, 10, "c")])];
    const cuts = detectClipCleanupRanges(words, window, { removeSilences: true, removeFillerWords: true, quietRanges: [{ startSec: 1.9, endSec: 4.1 }], languageCode: "en" });
    expect(cuts.some((c) => c.startSec < 1.45 && c.endSec > 1.35)).toBe(false);
  });

  test("a word between two close filler cuts survives the render (Sol P1)", () => {
    const words = [utterance([word(0, 0.5, "So"), word(0.55, 0.79, "um"), word(0.8, 0.85, "a"), word(0.86, 1.1, "uh"), word(1.2, 3, "plan")])];
    const cuts = detectClipCleanupRanges(words, window, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "en" });
    expect(sourceWordToEdited(buildClipCutPlan(cuts, window).map, { startSec: 0.8, endSec: 0.85 })).not.toBeNull();
  });

  test("more cuts than the editor holds keeps the longest, not none (Sol P2)", () => {
    const long: ClipWindow = { startSec: 0, endSec: 2000 };
    const many = [utterance(Array.from({ length: 700 }, (_, i) => word(i * 2.5, i * 2.5 + 0.5, "w")))];
    const quiet = [{ startSec: 0, endSec: 2000 }];
    const cuts = detectClipCleanupRanges(many, long, { removeSilences: true, removeFillerWords: false, quietRanges: quiet, languageCode: "en" });
    expect(cuts.length).toBe(500);
  });

  test("cuts that would empty the clip are dropped", () => {
    const onlyFiller = [utterance([word(0.2, 0.8, "um")])];
    expect(detectClipCleanupRanges(onlyFiller, { startSec: 0, endSec: 1 }, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "en" })).toEqual([]);
  });
});
