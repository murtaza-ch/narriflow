import { expect, test } from "bun:test";
import { resolveTrimPosition } from "./trim-control";

test("end trimming stops at the source end and preserves the minimum clip length", () => {
  expect(resolveTrimPosition({ side: "end", startSec: 20, endSec: 40,
    candidateSec: 80, sourceDurationSec: 55 })).toBe(55);
  expect(resolveTrimPosition({ side: "end", startSec: 20, endSec: 40,
    candidateSec: 21, sourceDurationSec: 55 })).toBe(30);
});

test("start trimming respects source zero, minimum duration, and maximum duration", () => {
  expect(resolveTrimPosition({ side: "start", startSec: 20, endSec: 50,
    candidateSec: -10, sourceDurationSec: 200 })).toBe(0);
  expect(resolveTrimPosition({ side: "start", startSec: 20, endSec: 50,
    candidateSec: 49, sourceDurationSec: 200 })).toBe(40);
  expect(resolveTrimPosition({ side: "start", startSec: 100, endSec: 150,
    candidateSec: 0, sourceDurationSec: 200 })).toBe(30);
});

test("word snapping cannot move a trim outside its allowed window", () => {
  expect(resolveTrimPosition({ side: "start", startSec: 20, endSec: 50,
    candidateSec: 39.9, sourceDurationSec: 100,
    words: [{ word: "later", startSec: 40.05, endSec: 40.2 }],
  })).toBe(40);
});
