import { describe, expect, test } from "bun:test";
import { CAPTION_SOFT_BREAK_GAP_SEC, captionSoftBreaks, groupCaptionTokens } from "./caption-cues";

const letters = (count: number) => Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index));
const breaksAt = (count: number, ...at: number[]) => Array.from({ length: count }, (_, index) => at.includes(index));

describe("groupCaptionTokens with soft breaks (spec 5.4)", () => {
  test("without the argument, or with no breaks, grouping is the budget alone", () => {
    const tokens = letters(7);
    const plain = [{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 7 }];
    expect(groupCaptionTokens(tokens, 3)).toEqual(plain);
    expect(groupCaptionTokens(tokens, 3, breaksAt(7))).toEqual(plain);
  });

  test("an overflowing cue closes after its latest soft break", () => {
    // "a b, c d e f": the cue overflows at d and closes after "b,".
    expect(groupCaptionTokens(letters(6), 3, breaksAt(6, 1))).toEqual([
      { start: 0, end: 2 }, { start: 2, end: 5 }, { start: 5, end: 6 },
    ]);
  });

  test("the latest break wins when a cue holds several", () => {
    expect(groupCaptionTokens(letters(6), 4, breaksAt(6, 1, 2))).toEqual([{ start: 0, end: 3 }, { start: 3, end: 6 }]);
  });

  test("a break that would leave one token in the closed cue is ignored", () => {
    expect(groupCaptionTokens(letters(4), 3, breaksAt(4, 0))).toEqual([{ start: 0, end: 3 }, { start: 3, end: 4 }]);
  });

  test("a soft break never closes a cue that is not overflowing", () => {
    expect(groupCaptionTokens(letters(3), 3, breaksAt(3, 1))).toEqual([{ start: 0, end: 3 }]);
    expect(groupCaptionTokens(letters(5), 5, breaksAt(5, 1, 3))).toEqual([{ start: 0, end: 5 }]);
  });

  test("a break on the last token before the overflow closes there, as the budget would", () => {
    expect(groupCaptionTokens(letters(4), 3, breaksAt(4, 2))).toEqual([{ start: 0, end: 3 }, { start: 3, end: 4 }]);
  });

  test("carried tokens start the next cue and the budget still holds", () => {
    const groups = groupCaptionTokens(letters(10), 4, breaksAt(10, 1, 6));
    // Closes after "b" at the first overflow; at the second the open cue (c..f) holds no break.
    expect(groups).toEqual([{ start: 0, end: 2 }, { start: 2, end: 6 }, { start: 6, end: 10 }]);
    for (const group of groups) expect(group.end - group.start).toBeLessThanOrEqual(4);
    expect(groups.at(-1)!.end).toBe(10);
  });

  test("character budgets for no-space scripts still apply", () => {
    // Six kana fill a 3-word cue; the clause mark after the second token closes the cue early.
    const tokens = ["今日", "は、", "天", "気", "が", "い", "い"];
    expect(groupCaptionTokens(tokens, 3, breaksAt(7, 1))).toEqual([{ start: 0, end: 2 }, { start: 2, end: 7 }]);
  });
});

describe("captionSoftBreaks", () => {
  const word = (raw: string, startSec: number, endSec: number) => ({ raw, startSec, endSec });

  test("sentence and clause punctuation in the raw text are soft breaks", () => {
    expect(captionSoftBreaks([
      word("Well,", 0, 0.2), word("so", 0.2, 0.4), word("today.", 0.4, 0.6), word("\"Stop!\"", 0.6, 0.8),
      word("یہ،", 0.8, 1), word("ہے۔", 1, 1.2), word("नमस्ते।", 1.2, 1.4), word("今日は、", 1.4, 1.6), word("last", 1.6, 1.8),
    ])).toEqual([true, false, true, true, true, true, true, true, false]);
  });

  test("a gap of 0.35 s or more after a word is a soft break", () => {
    expect(captionSoftBreaks([
      word("one", 0, 0.2), word("two", 0.2 + CAPTION_SOFT_BREAK_GAP_SEC, 0.8), word("three", 1.1, 1.3), word("four", 1.3, 1.5),
    ])).toEqual([true, false, false, false]);
  });

  test("apostrophes and hyphens inside a word are not breaks", () => {
    expect(captionSoftBreaks([word("don't", 0, 0.2), word("state-of-the-art", 0.2, 0.4), word("go", 0.4, 0.6)]))
      .toEqual([false, false, false]);
  });
});
