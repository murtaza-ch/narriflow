import { describe, expect, test } from "bun:test";

import { buildEditedTimeMap, normalizeDeletedRanges, type ClipWindow } from "./edit-ranges";
import { detectSilenceRanges } from "./silence-detection";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";

function word(startSec: number, endSec: number, text = "w"): TranscriptWord {
  return { word: text, startSec, endSec, confidence: null };
}

function utterance(
  index: number,
  startSec: number,
  endSec: number,
  words: TranscriptWord[],
): TranscriptUtterance {
  return {
    index,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec,
    endSec,
    text: words.map((w) => w.word).join(" ") || "x",
    confidence: null,
    words,
  };
}

describe("detectSilenceRanges", () => {
  test("a gap at or above minSilenceSec qualifies; a shorter one doesn't", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    // Two utterances 1.0s apart (qualifies at the 1.0 default) and, in a
    // second fixture, 0.9s apart (doesn't).
    const qualifying = [
      utterance(0, 5, 6, [word(5, 6)]),
      utterance(1, 7, 8, [word(7, 8)]),
    ];
    const short = [
      utterance(0, 5, 6, [word(5, 6)]),
      utterance(1, 6.9, 7.9, [word(6.9, 7.9)]),
    ];

    const qualifyingResult = detectSilenceRanges(qualifying, window, { padSec: 0 });
    expect(qualifyingResult).toContainEqual({ startSec: 6, endSec: 7 });

    const shortResult = detectSilenceRanges(short, window, { padSec: 0 });
    expect(shortResult.some((r) => r.startSec >= 6 && r.endSec <= 6.9)).toBe(false);
  });

  test("padding shrinks an interior gap on both sides", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [
      utterance(0, 5, 6, [word(5, 6)]),
      utterance(1, 8, 9, [word(8, 9)]),
    ];
    // Gap [6, 8) is 2s, well above the 1.0 default. Padded by 0.15 on each
    // side (both edges border real coverage) -> [6.15, 7.85].
    const result = detectSilenceRanges(utterances, window, { padSec: 0.15 });
    expect(result).toContainEqual({ startSec: 6.15, endSec: 7.85 });
  });

  test("leading and trailing edges are included but padded only on the interior side", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [utterance(0, 5, 15, [word(5, 15)])];
    const result = detectSilenceRanges(utterances, window, { padSec: 0.15, minSilenceSec: 1 });
    // Leading gap [0,5): only the right (speech-facing) edge is padded.
    expect(result).toContainEqual({ startSec: 0, endSec: 4.85 });
    // Trailing gap [15,20): only the left (speech-facing) edge is padded.
    expect(result).toContainEqual({ startSec: 15.15, endSec: 20 });
  });

  test("a gap that spans an utterance boundary is detected as one cross-utterance gap", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [
      utterance(0, 2, 4, [word(2, 3), word(3.1, 4)]),
      utterance(1, 7, 9, [word(7, 8), word(8.1, 9)]),
    ];
    // The gap [4, 7) straddles the utterance boundary and is not itself
    // inside either utterance's own word list — it must still be found.
    const result = detectSilenceRanges(utterances, window, { padSec: 0 });
    expect(result).toContainEqual({ startSec: 4, endSec: 7 });
  });

  test("a candidate fully inside an existing deletion is dropped", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [
      utterance(0, 0, 1, [word(0, 1)]),
      utterance(1, 5, 6, [word(5, 6)]),
    ];
    // Gap [1, 5) (4s) would normally qualify.
    const withoutExisting = detectSilenceRanges(utterances, window, { padSec: 0 });
    expect(withoutExisting).toContainEqual({ startSec: 1, endSec: 5 });

    const withExisting = detectSilenceRanges(utterances, window, {
      padSec: 0,
      existingDeleted: [{ startSec: 0.5, endSec: 5.5 }],
    });
    expect(withExisting.some((r) => r.startSec >= 1 && r.endSec <= 5)).toBe(false);
  });

  test("a partial overlap with an existing deletion is trimmed to the remainder", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [
      utterance(0, 0, 1, [word(0, 1)]),
      utterance(1, 6, 7, [word(6, 7)]),
    ];
    // Gap [1, 6) (5s) qualifies; an existing deletion punches a hole in the
    // middle, leaving two remainder pieces.
    const result = detectSilenceRanges(utterances, window, {
      padSec: 0,
      existingDeleted: [{ startSec: 2, endSec: 3 }],
    });
    expect(result).toContainEqual({ startSec: 1, endSec: 2 });
    expect(result).toContainEqual({ startSec: 3, endSec: 6 });
    expect(result.some((r) => r.startSec < 2 && r.endSec > 2 && r.startSec < 3)).toBe(false);
  });

  test("words with zero/absent timing fall back to utterance-level coverage", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [
      utterance(0, 0, 1, [word(0, 1)]),
      // Zero-duration word timing (endSec === startSec): the whole
      // utterance span [5, 8] must be treated as speech, so no cut is
      // proposed anywhere inside it even though the "word" itself claims a
      // single instant.
      utterance(1, 5, 8, [word(6, 6)]),
    ];
    const result = detectSilenceRanges(utterances, window, { padSec: 0, minSilenceSec: 1 });
    for (const range of result) {
      const overlapsUtterance1 = range.startSec < 8 && range.endSec > 5;
      expect(overlapsUtterance1).toBe(false);
    }
    // The real gap [1, 5) on either side of it is still detected normally.
    expect(result).toContainEqual({ startSec: 1, endSec: 5 });
  });

  test("rounding two candidates onto the same instant merges them via normalizeDeletedRanges", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    // A sub-millisecond "word" splits what is otherwise one long silence
    // into two gap candidates. With no padding, both candidates round
    // (roundMs, nearest ms) onto the exact same boundary instant, so the
    // detector's own normalize pass must merge them into a single range
    // spanning the whole window instead of returning two touching pieces.
    const utterances = [utterance(0, 9.9995, 10.0002, [word(9.9995, 10.0002)])];
    const result = detectSilenceRanges(utterances, window, { padSec: 0, minSilenceSec: 1 });
    expect(result).toEqual([{ startSec: 0, endSec: 20 }]);
  });

  test("integration: detect, union with a manual cut, and check the edited duration", () => {
    const window: ClipWindow = { startSec: 10, endSec: 16 };
    const utterances = [
      utterance(0, 10, 11.0, [word(10, 10.5), word(10.6, 11.0)]),
      utterance(1, 14.0, 14.9, [word(14.0, 14.4), word(14.5, 14.9)]),
    ];
    const manual = [{ startSec: 14.2, endSec: 14.3 }];

    const detected = detectSilenceRanges(utterances, window, {
      padSec: 0.15,
      minSilenceSec: 1,
      existingDeleted: manual,
    });
    // Interior gap [11.0, 14.0) padded -> [11.15, 13.85]; trailing gap
    // [14.9, 16) padded on its speech-facing side only -> [15.05, 16].
    expect(detected).toEqual([
      { startSec: 11.15, endSec: 13.85 },
      { startSec: 15.05, endSec: 16 },
    ]);

    const union = normalizeDeletedRanges([...detected, ...manual], window);
    const map = buildEditedTimeMap(union, window);
    // Window duration 6s, minus detected (2.7 + 0.95) minus manual (0.1).
    expect(map.editedDurationSec).toBeCloseTo(6 - 2.7 - 0.95 - 0.1, 5);
  });

  test("no utterances: the whole window is one unpadded gap candidate", () => {
    const window: ClipWindow = { startSec: 0, endSec: 5 };
    const result = detectSilenceRanges([], window, { minSilenceSec: 1 });
    expect(result).toEqual([{ startSec: 0, endSec: 5 }]);
  });

  test("no qualifying gaps returns an empty array", () => {
    const window: ClipWindow = { startSec: 0, endSec: 2 };
    const utterances = [utterance(0, 0, 2, [word(0, 2)])];
    expect(detectSilenceRanges(utterances, window)).toEqual([]);
  });
});
