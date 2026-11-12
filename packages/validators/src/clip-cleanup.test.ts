import { describe, expect, test } from "bun:test";

import {
  decodeQuietRanges,
  detectClipCleanupRanges,
  encodedQuietRangesSchema,
  encodeQuietRanges,
  QUIET_RANGES_MAX_INTERVALS,
} from "./clip-cleanup";
import type { ClipWindow } from "./edit-ranges";
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

  test("cuts that would empty the clip are dropped", () => {
    const onlyFiller = [utterance([word(0.2, 0.8, "um")])];
    expect(detectClipCleanupRanges(onlyFiller, { startSec: 0, endSec: 1 }, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "en" })).toEqual([]);
  });
});
