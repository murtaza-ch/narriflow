import { describe, expect, test } from "bun:test";
import { buildEditedTimeMap } from "@narriflow/validators";
import { RIPPLE_END_EPSILON_SEC, rippleSeekSourceSec, stepRipple } from "./ripple-playback";

describe("stepRipple", () => {
  test("identity map (no deletions) mirrors pre-ripple source-relative time", () => {
    const map = buildEditedTimeMap([], { startSec: 10, endSec: 40 });

    expect(stepRipple(map, 10).editedTime).toBe(0);
    expect(stepRipple(map, 25).editedTime).toBe(15);
    expect(stepRipple(map, 25).atEnd).toBe(false);
  });

  test("identity map ends at clipEndSec - epsilon, matching legacy slack", () => {
    const map = buildEditedTimeMap([], { startSec: 0, endSec: 20 });

    const justBefore = stepRipple(map, 20 - RIPPLE_END_EPSILON_SEC - 0.001);
    expect(justBefore.atEnd).toBe(false);

    const atSlack = stepRipple(map, 20 - RIPPLE_END_EPSILON_SEC);
    expect(atSlack.atEnd).toBe(true);
    expect(atSlack.editedTime).toBe(20);
  });

  test("entering a mid-clip cut jumps the video forward and keeps the clock continuous", () => {
    // Window 0-20, cut 8-12 -> kept segments [0,8) edited [0,8), [12,20) edited [8,16).
    const map = buildEditedTimeMap([{ startSec: 8, endSec: 12 }], { startSec: 0, endSec: 20 });

    const justBeforeCut = stepRipple(map, 7.99);
    expect(justBeforeCut.editedTime).toBeCloseTo(7.99, 5);
    expect(justBeforeCut.skipToSourceSec).toBeUndefined();

    const insideCut = stepRipple(map, 9);
    expect(insideCut.atEnd).toBe(false);
    expect(insideCut.skipToSourceSec).toBe(12);
    // No visual jump: the edited time at the cut boundary is the same
    // whether we ask "just before" (7.99 -> ~8) or "inside the cut" (-> 8).
    expect(insideCut.editedTime).toBeCloseTo(8, 5);

    const justAfterSkip = stepRipple(map, 12);
    expect(justAfterSkip.editedTime).toBe(8);
    expect(justAfterSkip.atEnd).toBe(false);
  });

  test("a tail cut clamps to end/pause instead of finding a next segment", () => {
    // Window 0-10, cut 8-10 (touches clip end) -> one kept segment [0,8).
    const map = buildEditedTimeMap([{ startSec: 8, endSec: 10 }], { startSec: 0, endSec: 10 });

    const insideTailCut = stepRipple(map, 8.5);
    expect(insideTailCut.atEnd).toBe(true);
    expect(insideTailCut.editedTime).toBe(8);
    expect(insideTailCut.skipToSourceSec).toBeUndefined();
  });

  test("a leading cut (deletion at clip start) skips forward from time zero", () => {
    // Window 0-10, cut 0-3 -> kept segment [3,10) edited [0,7).
    const map = buildEditedTimeMap([{ startSec: 0, endSec: 3 }], { startSec: 0, endSec: 10 });

    const atStart = stepRipple(map, 0);
    expect(atStart.atEnd).toBe(false);
    expect(atStart.skipToSourceSec).toBe(3);
    expect(atStart.editedTime).toBe(0);
  });

  test("everything deleted (no kept segments) is a degenerate atEnd state", () => {
    const map = buildEditedTimeMap([{ startSec: 0, endSec: 10 }], { startSec: 0, endSec: 10 });
    expect(map.segments).toHaveLength(0);

    const step = stepRipple(map, 5);
    expect(step.atEnd).toBe(true);
    expect(step.editedTime).toBe(0);
  });
});

describe("rippleSeekSourceSec", () => {
  test("delegates to editedToSource (never lands inside a cut)", () => {
    const map = buildEditedTimeMap([{ startSec: 8, endSec: 12 }], { startSec: 0, endSec: 20 });

    expect(rippleSeekSourceSec(map, 0)).toBe(0);
    expect(rippleSeekSourceSec(map, 8)).toBe(12);
    expect(rippleSeekSourceSec(map, 16)).toBe(20);
  });
});
