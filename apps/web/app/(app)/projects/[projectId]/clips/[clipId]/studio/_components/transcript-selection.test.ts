import { describe, expect, test } from "bun:test";
import {
  collectSelectedWords,
  computeRevertCoveringRange,
  isWordDeleted,
  selectedWordsToSourceRange,
  wordCharRanges,
  type SelectableWord,
  type UtteranceWordSource,
} from "./transcript-selection";

// ─── wordCharRanges ─────────────────────────────────────────────────────────

describe("wordCharRanges", () => {
  test("single-space-joined char spans, matching the reducer's words.join(\" \")", () => {
    const ranges = wordCharRanges([{ word: "hello" }, { word: "there" }, { word: "world" }]);
    expect(ranges).toEqual([
      { charStart: 0, charEnd: 5 }, // "hello"
      { charStart: 6, charEnd: 11 }, // "there" (index 5 is the space)
      { charStart: 12, charEnd: 17 }, // "world"
    ]);
  });
});

// ─── collectSelectedWords ───────────────────────────────────────────────────

const utterances: UtteranceWordSource[] = [
  {
    utteranceIndex: 0,
    words: [
      { word: "hello", startSec: 0, endSec: 0.4 },
      { word: "there", startSec: 0.4, endSec: 0.8 },
      { word: "friend", startSec: 0.8, endSec: 1.2 },
    ],
  },
  {
    utteranceIndex: 1,
    words: [
      { word: "how", startSec: 2, endSec: 2.2 },
      { word: "are", startSec: 2.2, endSec: 2.4 },
      { word: "you", startSec: 2.4, endSec: 2.6 },
    ],
  },
  {
    utteranceIndex: 2,
    words: [
      { word: "today", startSec: 4, endSec: 4.5 },
      { word: "friend", startSec: 4.5, endSec: 5 },
    ],
  },
];

describe("collectSelectedWords", () => {
  test("selection fully inside one word includes only that word (partial overlap policy)", () => {
    // "hello there friend" — offsets: hello[0,5) there[6,11) friend[12,18)
    // Select chars [2,4) — squarely inside "hello" — the whole word counts.
    const words = collectSelectedWords(
      utterances,
      { utteranceIndex: 0, charOffset: 2 },
      { utteranceIndex: 0, charOffset: 4 },
    );
    expect(words).toEqual([{ utteranceIndex: 0, wordIndex: 0, startSec: 0, endSec: 0.4 }]);
  });

  test("selection starting mid-word and ending mid-next-word includes both whole words", () => {
    // Select chars [3,8) — spans the tail of "hello" (ends at 5) and the
    // head of "there" (starts at 6) — both words intersect, both included.
    const words = collectSelectedWords(
      utterances,
      { utteranceIndex: 0, charOffset: 3 },
      { utteranceIndex: 0, charOffset: 8 },
    );
    expect(words.map((w) => w.wordIndex)).toEqual([0, 1]);
  });

  test("touching a word's boundary exactly does not select it (zero-length overlap)", () => {
    // "hello" ends at char 5; selecting [5,6) is only the joining space —
    // no word's [charStart,charEnd) has non-zero overlap with it.
    const words = collectSelectedWords(
      utterances,
      { utteranceIndex: 0, charOffset: 5 },
      { utteranceIndex: 0, charOffset: 6 },
    );
    expect(words).toEqual([]);
  });

  test("multi-utterance span: partial tail of first, all of middle, partial head of last", () => {
    // Anchor mid-"friend" (utterance 0, word 2) through mid-"today"
    // (utterance 2, word 0) — should pick up: friend(u0), how/are/you(u1
    // in full), today(u2). "friend" in u2 must NOT be included.
    const words = collectSelectedWords(
      utterances,
      { utteranceIndex: 0, charOffset: 14 }, // inside "friend" [12,18)
      { utteranceIndex: 2, charOffset: 2 }, // inside "today" [0,5)
    );
    expect(words).toEqual([
      { utteranceIndex: 0, wordIndex: 2, startSec: 0.8, endSec: 1.2 },
      { utteranceIndex: 1, wordIndex: 0, startSec: 2, endSec: 2.2 },
      { utteranceIndex: 1, wordIndex: 1, startSec: 2.2, endSec: 2.4 },
      { utteranceIndex: 1, wordIndex: 2, startSec: 2.4, endSec: 2.6 },
      { utteranceIndex: 2, wordIndex: 0, startSec: 4, endSec: 4.5 },
    ]);
  });

  test("reversed endpoints (drag right-to-left) produce the same result", () => {
    const forward = collectSelectedWords(
      utterances,
      { utteranceIndex: 0, charOffset: 14 },
      { utteranceIndex: 2, charOffset: 2 },
    );
    const backward = collectSelectedWords(
      utterances,
      { utteranceIndex: 2, charOffset: 2 },
      { utteranceIndex: 0, charOffset: 14 },
    );
    expect(backward).toEqual(forward);
  });

  test("collapsed selection (equal endpoints) selects nothing", () => {
    const words = collectSelectedWords(
      utterances,
      { utteranceIndex: 1, charOffset: 3 },
      { utteranceIndex: 1, charOffset: 3 },
    );
    expect(words).toEqual([]);
  });
});

// ─── selectedWordsToSourceRange ─────────────────────────────────────────────

describe("selectedWordsToSourceRange", () => {
  test("empty selection returns null", () => {
    expect(selectedWordsToSourceRange([])).toBeNull();
  });

  test("spans the min startSec to max endSec across possibly-unordered words", () => {
    const words: SelectableWord[] = [
      { utteranceIndex: 1, wordIndex: 0, startSec: 2, endSec: 2.2 },
      { utteranceIndex: 0, wordIndex: 2, startSec: 0.8, endSec: 1.2 },
      { utteranceIndex: 2, wordIndex: 0, startSec: 4, endSec: 4.5 },
    ];
    expect(selectedWordsToSourceRange(words)).toEqual({ startSec: 0.8, endSec: 4.5 });
  });
});

// ─── isWordDeleted / computeRevertCoveringRange ─────────────────────────────

describe("isWordDeleted", () => {
  test("word fully inside a deleted range is deleted", () => {
    expect(isWordDeleted({ startSec: 5, endSec: 6 }, [{ startSec: 4, endSec: 10 }])).toBe(true);
  });

  test("word with no overlap is not deleted", () => {
    expect(isWordDeleted({ startSec: 1, endSec: 2 }, [{ startSec: 4, endSec: 10 }])).toBe(false);
  });

  test("word adjacent to (touching but not overlapping) a deleted range is not deleted", () => {
    expect(isWordDeleted({ startSec: 2, endSec: 4 }, [{ startSec: 4, endSec: 10 }])).toBe(false);
  });

  test("word partially straddling a cut boundary counts as deleted", () => {
    // A cut can land mid-word if the word itself wasn't the delete unit at
    // cut time (e.g. a segment delete) — any overlap is enough.
    expect(isWordDeleted({ startSec: 3, endSec: 5 }, [{ startSec: 4, endSec: 10 }])).toBe(true);
  });
});

describe("computeRevertCoveringRange", () => {
  const deletedRanges = [{ startSec: 0.5, endSec: 3 }];

  test("selection entirely within one deleted range returns its covering span", () => {
    const words: SelectableWord[] = [
      { utteranceIndex: 0, wordIndex: 0, startSec: 1, endSec: 1.5 },
      { utteranceIndex: 0, wordIndex: 1, startSec: 1.5, endSec: 2 },
    ];
    expect(computeRevertCoveringRange(words, deletedRanges)).toEqual({
      startSec: 1,
      endSec: 2,
    });
  });

  test("mixed selection (some words not deleted) returns null — Delete stays the action", () => {
    const words: SelectableWord[] = [
      { utteranceIndex: 0, wordIndex: 0, startSec: 1, endSec: 1.5 }, // deleted
      { utteranceIndex: 0, wordIndex: 1, startSec: 4, endSec: 4.5 }, // kept
    ];
    expect(computeRevertCoveringRange(words, deletedRanges)).toBeNull();
  });

  test("selection spanning two separate deleted ranges with a kept sliver between them is not all-deleted", () => {
    const twoRanges = [
      { startSec: 0, endSec: 1 },
      { startSec: 2, endSec: 3 },
    ];
    const words: SelectableWord[] = [
      { utteranceIndex: 0, wordIndex: 0, startSec: 0.2, endSec: 0.6 }, // in range 1
      { utteranceIndex: 0, wordIndex: 1, startSec: 1.2, endSec: 1.6 }, // kept sliver
      { utteranceIndex: 0, wordIndex: 2, startSec: 2.2, endSec: 2.6 }, // in range 2
    ];
    expect(computeRevertCoveringRange(words, twoRanges)).toBeNull();
  });

  test("empty selection returns null", () => {
    expect(computeRevertCoveringRange([], deletedRanges)).toBeNull();
  });
});
