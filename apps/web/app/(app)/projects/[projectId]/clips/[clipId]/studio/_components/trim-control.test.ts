import { expect, test } from "bun:test";
import { resolveTrimPosition, trimLimits, trimSourceCeilingSec } from "./trim-control";

test("end trimming stops at the source end and preserves the minimum clip length", () => {
  expect(resolveTrimPosition({ side: "end", startSec: 20, endSec: 40,
    candidateSec: 80, sourceDurationSec: 55, wholeSource: false })).toBe(55);
  expect(resolveTrimPosition({ side: "end", startSec: 20, endSec: 40,
    candidateSec: 21, sourceDurationSec: 55, wholeSource: false })).toBe(30);
});

test("start trimming respects source zero, minimum duration, and maximum duration", () => {
  expect(resolveTrimPosition({ side: "start", startSec: 20, endSec: 50,
    candidateSec: -10, sourceDurationSec: 200, wholeSource: false })).toBe(0);
  expect(resolveTrimPosition({ side: "start", startSec: 20, endSec: 50,
    candidateSec: 49, sourceDurationSec: 200, wholeSource: false })).toBe(40);
  expect(resolveTrimPosition({ side: "start", startSec: 100, endSec: 150,
    candidateSec: 0, sourceDurationSec: 200, wholeSource: false })).toBe(30);
});

test("word snapping cannot move a trim outside its allowed window", () => {
  expect(resolveTrimPosition({ side: "start", startSec: 20, endSec: 50,
    candidateSec: 39.9, sourceDurationSec: 100, wholeSource: false,
    words: [{ word: "later", startSec: 40.05, endSec: 40.2 }],
  })).toBe(40);
});

test("a whole-source clip trims between 1 and 180 seconds; a detected clip keeps 10 to 120", () => {
  const trim = (wholeSource: boolean, side: "start" | "end", candidateSec: number, startSec = 20, endSec = 28) =>
    resolveTrimPosition({ side, startSec, endSec, candidateSec, sourceDurationSec: 300, wholeSource });
  // An 8-second whole-source clip can shrink to 1 second but a detected clip can't go under 10.
  expect(trim(true, "end", 20.2)).toBe(21);
  expect(trim(true, "start", 27.5)).toBe(27);
  expect(trim(false, "end", 20.2, 20, 40)).toBe(30);
  // A 3-minute window is reachable only for a whole-source clip.
  expect(trim(true, "end", 400, 0, 5)).toBeCloseTo(180.499, 3);
  expect(trim(false, "end", 400, 0, 50)).toBe(120);
  expect(trim(true, "start", -5, 100, 280)).toBeCloseTo(99.501, 3);
  expect(trim(false, "start", -5, 100, 220)).toBe(100);
});

test("the handles' accessible range is the same limit", () => {
  expect(trimLimits({ side: "end", startSec: 0, endSec: 8, sourceDurationSec: 8, wholeSource: true })).toEqual({ minimum: 1, maximum: 8 });
  expect(trimLimits({ side: "start", startSec: 0, endSec: 180, sourceDurationSec: 180, wholeSource: true })).toEqual({ minimum: 0, maximum: 179 });
  expect(trimLimits({ side: "end", startSec: 0, endSec: 60, sourceDurationSec: 300, wholeSource: false })).toEqual({ minimum: 10, maximum: 120 });
});

test("a whole-source clip's handles reach the exact end of its source", () => {
  // An 8.4 second source whose rounded duration is 8: the end handle stops at 8.4, not 8.
  expect(trimLimits({ side: "end", startSec: 0, endSec: 8.4, sourceDurationSec: 8.4, wholeSource: true })).toEqual({ minimum: 1, maximum: 8.4 });
  expect(resolveTrimPosition({ side: "end", startSec: 0, endSec: 8.4, candidateSec: 9, sourceDurationSec: 8.4, wholeSource: true })).toBe(8.4);
  // A 180.4 second source is a 3 minute source: its start handle still sits at 0.
  expect(trimLimits({ side: "start", startSec: 0, endSec: 180.4, sourceDurationSec: 180.4, wholeSource: true }).minimum).toBe(0);
  expect(trimLimits({ side: "end", startSec: 0, endSec: 100, sourceDurationSec: 180.4, wholeSource: true }).maximum).toBe(180.4);
});

test("a whole-source clip trims against its source edge even with no transcript words", () => {
  // A silent or caption-less video has no last word; its transcript ceiling is 0.
  expect(trimSourceCeilingSec({ wholeSource: true, sourceEdgeSec: 8.4 }, 0)).toBe(8.4);
  expect(trimSourceCeilingSec({ wholeSource: true, sourceEdgeSec: null }, 7.9)).toBe(7.9);
  expect(trimSourceCeilingSec({ wholeSource: false, sourceEdgeSec: 600 }, 590)).toBe(590);
  const ceiling = trimSourceCeilingSec({ wholeSource: true, sourceEdgeSec: 8.4 }, 0);
  expect(resolveTrimPosition({ side: "end", startSec: 0, endSec: 8.4, candidateSec: 5, sourceDurationSec: ceiling, wholeSource: true })).toBe(5);
});
