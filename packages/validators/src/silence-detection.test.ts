import { describe, expect, test } from "bun:test";

import { buildEditedTimeMap, normalizeDeletedRanges, type ClipWindow } from "./edit-ranges";
import { detectSilenceRanges, SILENCE_LEAD_IN_EXTRA_SEC } from "./silence-detection";
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

  test("padding shrinks an interior gap, keeping more before speech resumes", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [
      utterance(0, 5, 6, [word(5, 6)]),
      utterance(1, 8, 9, [word(8, 9)]),
    ];
    // Gap [6, 8) is 2s, well above the 1.0 default. 0.15 kept after speech,
    // 0.15 + 0.1 lead-in kept before the next word -> [6.15, 7.75].
    expect(SILENCE_LEAD_IN_EXTRA_SEC).toBe(0.1);
    const result = detectSilenceRanges(utterances, window, { padSec: 0.15 });
    expect(result).toContainEqual({ startSec: 6.15, endSec: 7.75 });
  });

  test("leading and trailing edges are included but padded only on the interior side", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [utterance(0, 5, 15, [word(5, 15)])];
    const result = detectSilenceRanges(utterances, window, { padSec: 0.15, minSilenceSec: 1 });
    // Leading gap [0,5): only the right (speech-facing) edge is padded,
    // with the lead-in margin.
    expect(result).toContainEqual({ startSec: 0, endSec: 4.75 });
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

  test("a single-instant word protects its instant, not its whole utterance", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    // Scribe emits a few words timed as one instant ("I"@974.524-974.524 in
    // a real interview). The pauses around it are still pauses.
    const utterances = [
      utterance(0, 0, 1, [word(0, 1)]),
      utterance(1, 2, 12, [word(2, 3), word(6, 6), word(11, 12)]),
    ];
    const result = detectSilenceRanges(utterances, window, { padSec: 0, minSilenceSec: 1 });
    expect(result).toContainEqual({ startSec: 3, endSec: 6 });
    expect(result).toContainEqual({ startSec: 6.01, endSec: 11 });
    expect(result.some((r) => r.startSec < 6.01 && r.endSec > 6)).toBe(false);
  });

  test("an utterance with untimed words is protected whole", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [
      utterance(0, 0, 1, [word(0, 1)]),
      utterance(1, 5, 8, [word(6, Number.NaN)]),
    ];
    const result = detectSilenceRanges(utterances, window, { padSec: 0, minSilenceSec: 1 });
    expect(result.some((r) => r.startSec < 8 && r.endSec > 5)).toBe(false);
    expect(result).toContainEqual({ startSec: 1, endSec: 5 });
  });

  test("quietRanges keeps a cut only where the audio is quiet", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [
      utterance(0, 0, 1, [word(0, 1)]),
      utterance(1, 6, 7, [word(6, 7)]),
    ];
    // Transcript gap [1, 6) -> padded [1.15, 5.75]. Music fills 2.5-4.0; the
    // audio is quiet elsewhere, plus a 0.2 s quiet blip that is too short.
    const quietRanges = [
      { startSec: 0.9, endSec: 2.5 },
      { startSec: 4.0, endSec: 4.2 },
      { startSec: 4.6, endSec: 6.2 },
    ];
    expect(detectSilenceRanges(utterances, window, { quietRanges })).toEqual([
      { startSec: 1.15, endSec: 2.5 },
      { startSec: 4.6, endSec: 5.75 },
    ]);
  });

  test("a short speechless blip between quiet runs joins the cuts", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [utterance(0, 0, 1, [word(0, 1)]), utterance(1, 6, 7, [word(6, 7)])];
    // A 0.13 s click at 3.0-3.13 splits the quiet: one cut, not two.
    const quietRanges = [{ startSec: 0.9, endSec: 3.0 }, { startSec: 3.13, endSec: 6.2 }];
    expect(detectSilenceRanges(utterances, window, { quietRanges })).toEqual([{ startSec: 1.15, endSec: 5.75 }]);
  });

  test("a chain of short sounds is not joined past the blip budget", () => {
    const window: ClipWindow = { startSec: 0, endSec: 40 };
    const utterances = [utterance(0, 0, 1, [word(0, 1)]), utterance(1, 30, 31, [word(30, 31)])];
    // Quiet broken by 0.24 s and 0.13 s sounds: only the first joins (0.37 s > 0.3 s budget).
    const quietRanges = [{ startSec: 1, endSec: 21.19 }, { startSec: 21.43, endSec: 22.63 }, { startSec: 22.76, endSec: 30 }];
    expect(detectSilenceRanges(utterances, window, { quietRanges }).slice(0, 2)).toEqual([
      { startSec: 1.15, endSec: 22.63 },
      { startSec: 22.76, endSec: 29.75 },
    ]);
  });

  test("a longer sound between quiet runs stays", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [utterance(0, 0, 1, [word(0, 1)]), utterance(1, 6, 7, [word(6, 7)])];
    const quietRanges = [{ startSec: 0.9, endSec: 3.0 }, { startSec: 3.4, endSec: 6.2 }];
    expect(detectSilenceRanges(utterances, window, { quietRanges })).toEqual([
      { startSec: 1.15, endSec: 3.0 },
      { startSec: 3.4, endSec: 5.75 },
    ]);
  });

  test("a short manual cut inside a pause is not proposed again", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [utterance(0, 0, 1, [word(0, 1)]), utterance(1, 6, 7, [word(6, 7)])];
    expect(detectSilenceRanges(utterances, window, { existingDeleted: [{ startSec: 3, endSec: 3.2 }] }).slice(0, 2)).toEqual([
      { startSec: 1.15, endSec: 3 },
      { startSec: 3.2, endSec: 5.75 },
    ]);
  });

  test("an empty quietRanges means measured loud: nothing is cut", () => {
    const window: ClipWindow = { startSec: 0, endSec: 20 };
    const utterances = [utterance(0, 0, 1, [word(0, 1)]), utterance(1, 6, 7, [word(6, 7)])];
    expect(detectSilenceRanges(utterances, window, { quietRanges: [] })).toEqual([]);
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
    // Interior gap [11.0, 14.0) padded -> [11.15, 13.75]; trailing gap
    // [14.9, 16) padded on its speech-facing side only -> [15.05, 16].
    expect(detected).toEqual([
      { startSec: 11.15, endSec: 13.75 },
      { startSec: 15.05, endSec: 16 },
    ]);

    const union = normalizeDeletedRanges([...detected, ...manual], window);
    const map = buildEditedTimeMap(union, window);
    // Window duration 6s, minus detected (2.6 + 0.95) minus manual (0.1).
    expect(map.editedDurationSec).toBeCloseTo(6 - 2.6 - 0.95 - 0.1, 5);
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
