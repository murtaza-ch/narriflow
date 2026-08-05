import { describe, expect, test } from "bun:test";
import { buildEditedTimeMap } from "@narriflow/validators";
import type { TranscriptUtterance } from "@narriflow/validators";
import {
  averageUtteranceDurationSec,
  averageWordDurationSec,
  findActiveWordId,
  FIT_SENTENCE_TARGET_PX,
  FIT_WORD_TARGET_PX_PER_WORD,
  projectWordsToEdited,
  pxPerWordForZoom,
  selectVisibleWordChips,
  shouldRenderWordChips,
  TIMELINE_BASE_PX_PER_SEC,
  TIMELINE_ZOOM_MAX,
  TIMELINE_ZOOM_MIN,
  WORD_CHIP_MIN_PX_PER_WORD,
  zoomForFitToSentence,
  zoomForFitToWord,
  type WordChipDatum,
} from "./word-chips";

function utterance(
  index: number,
  startSec: number,
  words: { word: string; startSec: number; endSec: number }[],
): TranscriptUtterance {
  return {
    index,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec,
    endSec: words.at(-1)?.endSec ?? startSec,
    text: words.map((w) => w.word).join(" ") || "x",
    confidence: 1,
    words: words.map((w) => ({ ...w, confidence: 1 })),
  };
}

describe("pxPerWordForZoom / shouldRenderWordChips", () => {
  test("scales linearly with zoom and average word duration", () => {
    expect(pxPerWordForZoom(1, 0.35)).toBeCloseTo(TIMELINE_BASE_PX_PER_SEC * 0.35);
    expect(pxPerWordForZoom(2, 0.35)).toBeCloseTo(TIMELINE_BASE_PX_PER_SEC * 2 * 0.35);
  });

  test("threshold is inclusive at exactly WORD_CHIP_MIN_PX_PER_WORD", () => {
    expect(shouldRenderWordChips(WORD_CHIP_MIN_PX_PER_WORD)).toBe(true);
    expect(shouldRenderWordChips(WORD_CHIP_MIN_PX_PER_WORD - 0.01)).toBe(false);
    expect(shouldRenderWordChips(WORD_CHIP_MIN_PX_PER_WORD + 5)).toBe(true);
  });
});

describe("averageWordDurationSec / averageUtteranceDurationSec", () => {
  test("computes the mean over all words/utterances", () => {
    const utterances = [
      utterance(0, 0, [
        { word: "hello", startSec: 0, endSec: 0.2 },
        { word: "world", startSec: 0.2, endSec: 0.6 },
      ]),
      utterance(1, 1, [{ word: "again", startSec: 1, endSec: 1.4 }]),
    ];

    expect(averageWordDurationSec(utterances)).toBeCloseTo((0.2 + 0.4 + 0.4) / 3);
    expect(averageUtteranceDurationSec(utterances)).toBeCloseTo(((0.6 - 0) + (1.4 - 1)) / 2);
  });

  test("falls back to a sane default with no timed words/utterances", () => {
    expect(averageWordDurationSec([])).toBeGreaterThan(0);
    expect(averageUtteranceDurationSec([])).toBeGreaterThan(0);
  });
});

describe("zoomForFitToWord / zoomForFitToSentence", () => {
  test("targets the fit constants and clamps to the timeline zoom range", () => {
    // avg word duration 0.5s -> unclamped zoom = 40 / (80*0.5) = 1
    const utterances = [utterance(0, 0, [{ word: "hi", startSec: 0, endSec: 0.5 }])];
    const zoom = zoomForFitToWord(utterances);
    expect(zoom).toBeCloseTo(FIT_WORD_TARGET_PX_PER_WORD / (TIMELINE_BASE_PX_PER_SEC * 0.5));
    expect(zoom).toBeGreaterThanOrEqual(TIMELINE_ZOOM_MIN);
    expect(zoom).toBeLessThanOrEqual(TIMELINE_ZOOM_MAX);

    // Extremely short words would need zoom >> 4 — must clamp to the max.
    const tinyWordUtterances = [utterance(0, 0, [{ word: "a", startSec: 0, endSec: 0.01 }])];
    expect(zoomForFitToWord(tinyWordUtterances)).toBe(TIMELINE_ZOOM_MAX);

    // Extremely long words would need zoom << 0.5 — must clamp to the min.
    const longWordUtterances = [utterance(0, 0, [{ word: "a", startSec: 0, endSec: 30 }])];
    expect(zoomForFitToWord(longWordUtterances)).toBe(TIMELINE_ZOOM_MIN);
  });

  test("fit-to-sentence targets FIT_SENTENCE_TARGET_PX and clamps", () => {
    const utterances = [
      utterance(0, 0, [
        { word: "a", startSec: 0, endSec: 1 },
        { word: "b", startSec: 1, endSec: 2 },
      ]),
    ];
    const zoom = zoomForFitToSentence(utterances);
    expect(zoom).toBeCloseTo(FIT_SENTENCE_TARGET_PX / (TIMELINE_BASE_PX_PER_SEC * 2));

    const longSentence = [utterance(0, 0, [{ word: "a", startSec: 0, endSec: 60 }])];
    expect(zoomForFitToSentence(longSentence)).toBe(TIMELINE_ZOOM_MIN);
  });
});

describe("projectWordsToEdited", () => {
  test("identity map: projected range equals the source words directly", () => {
    const utterances = [
      utterance(0, 0, [
        { word: "hello", startSec: 0, endSec: 0.4 },
        { word: "world", startSec: 0.4, endSec: 0.9 },
      ]),
    ];
    const map = buildEditedTimeMap([], { startSec: 0, endSec: 10 });
    const chips = projectWordsToEdited(utterances, map);

    expect(chips).toEqual([
      { id: "0-0", text: "hello", sourceStartSec: 0, sourceEndSec: 0.4, editedStartSec: 0, editedEndSec: 0.4 },
      { id: "0-1", text: "world", sourceStartSec: 0.4, sourceEndSec: 0.9, editedStartSec: 0.4, editedEndSec: 0.9 },
    ]);
  });

  test("a word entirely inside a cut is skipped (collapsed, not drawn)", () => {
    const utterances = [
      utterance(0, 0, [
        { word: "kept", startSec: 0, endSec: 1 },
        { word: "cut", startSec: 2, endSec: 3 },
        { word: "alsoKept", startSec: 5, endSec: 6 },
      ]),
    ];
    const map = buildEditedTimeMap([{ startSec: 1.5, endSec: 4 }], { startSec: 0, endSec: 8 });
    const chips = projectWordsToEdited(utterances, map);

    expect(chips.map((c) => c.text)).toEqual(["kept", "alsoKept"]);
    // "alsoKept" [5,6) sits after a 2.5s cut -> shifts left by 2.5s.
    expect(chips[1]).toMatchObject({ editedStartSec: 2.5, editedEndSec: 3.5 });
  });

  test("output stays sorted by editedStartSec even if utterances are out of order", () => {
    const utterances = [
      utterance(1, 5, [{ word: "second", startSec: 5, endSec: 6 }]),
      utterance(0, 0, [{ word: "first", startSec: 0, endSec: 1 }]),
    ];
    const map = buildEditedTimeMap([], { startSec: 0, endSec: 10 });
    const chips = projectWordsToEdited(utterances, map);

    expect(chips.map((c) => c.text)).toEqual(["first", "second"]);
  });
});

describe("selectVisibleWordChips", () => {
  const words: WordChipDatum[] = Array.from({ length: 20 }, (_, i) => ({
    id: `w-${i}`,
    text: `word${i}`,
    sourceStartSec: i,
    sourceEndSec: i + 0.8,
    editedStartSec: i,
    editedEndSec: i + 0.8,
  }));

  test("returns only chips intersecting the range", () => {
    const visible = selectVisibleWordChips(words, { startSec: 5, endSec: 8 });
    expect(visible.map((c) => c.id)).toEqual(["w-5", "w-6", "w-7", "w-8"]);
  });

  test("includes a chip straddling the left edge of the range", () => {
    // word 4 spans [4, 4.8); range starts at 4.5, inside that chip's span.
    const visible = selectVisibleWordChips(words, { startSec: 4.5, endSec: 4.6 });
    expect(visible.map((c) => c.id)).toEqual(["w-4"]);
  });

  test("empty input or inverted range returns empty", () => {
    expect(selectVisibleWordChips([], { startSec: 0, endSec: 10 })).toEqual([]);
    expect(selectVisibleWordChips(words, { startSec: 10, endSec: 2 })).toEqual([]);
  });

  test("range fully outside the word list returns empty", () => {
    expect(selectVisibleWordChips(words, { startSec: 100, endSec: 200 })).toEqual([]);
  });

  // Phase B closing review finding 9c: the back-check used to look only one
  // chip behind the binary-search cursor, so a SECOND (or later) preceding
  // chip that also straddles the window's left edge was silently dropped.
  test("scans back past every preceding chip that straddles the left edge, not just one", () => {
    const overlapping: WordChipDatum[] = [
      { id: "w-0", text: "w0", sourceStartSec: 0, sourceEndSec: 6, editedStartSec: 0, editedEndSec: 6 },
      { id: "w-1", text: "w1", sourceStartSec: 0, sourceEndSec: 6, editedStartSec: 0, editedEndSec: 6 },
      { id: "w-2", text: "w2", sourceStartSec: 6, sourceEndSec: 7, editedStartSec: 6, editedEndSec: 7 },
    ];
    const visible = selectVisibleWordChips(overlapping, { startSec: 5, endSec: 5.5 });
    expect(visible.map((c) => c.id)).toEqual(["w-0", "w-1"]);
  });
});

describe("findActiveWordId", () => {
  const words: WordChipDatum[] = [
    { id: "a", text: "a", sourceStartSec: 0, sourceEndSec: 0.5, editedStartSec: 0, editedEndSec: 0.5 },
    { id: "b", text: "b", sourceStartSec: 0.5, sourceEndSec: 1.2, editedStartSec: 0.5, editedEndSec: 1.2 },
    { id: "c", text: "c", sourceStartSec: 2, sourceEndSec: 2.4, editedStartSec: 2, editedEndSec: 2.4 },
  ];

  test("finds the word whose source span contains the time", () => {
    expect(findActiveWordId(words, 0.1)).toBe("a");
    expect(findActiveWordId(words, 0.8)).toBe("b");
    expect(findActiveWordId(words, 2.4)).toBe("c");
  });

  test("returns null in a gap between words", () => {
    expect(findActiveWordId(words, 1.6)).toBeNull();
  });

  test("returns null before the first word or after the last", () => {
    expect(findActiveWordId(words, -1)).toBeNull();
    expect(findActiveWordId(words, 10)).toBeNull();
  });

  test("returns null for an empty word list", () => {
    expect(findActiveWordId([], 1)).toBeNull();
  });
});
