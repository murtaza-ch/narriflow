import { describe, expect, test } from "bun:test";
import { sourceToEdited } from "@narriflow/validators";
import { buildClipCutPlan, MIN_KEPT_SEGMENT_SEC } from "./cut-plan";

const window = { startSec: 10, endSec: 40 }; // 30s clip

describe("buildClipCutPlan (no deletions)", () => {
  test("is uncut: one segment spanning the whole window, edited duration == window duration", () => {
    const plan = buildClipCutPlan([], window);
    expect(plan.isUncut).toBe(true);
    expect(plan.isEmpty).toBe(false);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]).toEqual({
      sourceStartSec: 10,
      sourceEndSec: 40,
      editedStartSec: 0,
    });
    expect(plan.editedDurationSec).toBe(30);
    expect(plan.droppedSliverCount).toBe(0);
  });

  test("ranges entirely outside the window normalize to empty -> still uncut", () => {
    const plan = buildClipCutPlan([{ startSec: 100, endSec: 105 }], window);
    expect(plan.isUncut).toBe(true);
    expect(plan.editedDurationSec).toBe(30);
  });
});

describe("buildClipCutPlan (mid-clip cut)", () => {
  test("one deletion in the middle produces two kept segments with contiguous edited offsets", () => {
    const plan = buildClipCutPlan([{ startSec: 20, endSec: 25 }], window);
    expect(plan.isUncut).toBe(false);
    expect(plan.isEmpty).toBe(false);
    expect(plan.segments).toEqual([
      { sourceStartSec: 10, sourceEndSec: 20, editedStartSec: 0 },
      { sourceStartSec: 25, sourceEndSec: 40, editedStartSec: 10 },
    ]);
    // 30s window - 5s deleted = 25s edited duration
    expect(plan.editedDurationSec).toBe(25);
    expect(plan.map.editedDurationSec).toBe(25);
  });

  test("multiple deletions produce N+1 kept segments in source order", () => {
    const plan = buildClipCutPlan(
      [
        { startSec: 15, endSec: 18 },
        { startSec: 30, endSec: 32 },
      ],
      window,
    );
    expect(plan.segments.map((s) => [s.sourceStartSec, s.sourceEndSec])).toEqual([
      [10, 15],
      [18, 30],
      [32, 40],
    ]);
    // 30 - 3 - 2 = 25
    expect(plan.editedDurationSec).toBe(25);
  });

  test("a deletion at the very start leaves a single (shorter) kept segment - still classified as cut, not uncut", () => {
    const plan = buildClipCutPlan([{ startSec: 10, endSec: 12 }], window);
    expect(plan.isUncut).toBe(false);
    expect(plan.segments).toEqual([
      { sourceStartSec: 12, sourceEndSec: 40, editedStartSec: 0 },
    ]);
    expect(plan.editedDurationSec).toBe(28);
  });
});

describe("buildClipCutPlan (everything deleted -> guard)", () => {
  test("deleting the entire window yields isEmpty with zero segments and zero duration", () => {
    const plan = buildClipCutPlan([{ startSec: 10, endSec: 40 }], window);
    expect(plan.isEmpty).toBe(true);
    expect(plan.isUncut).toBe(false);
    expect(plan.segments).toHaveLength(0);
    expect(plan.editedDurationSec).toBe(0);
  });

  test("multiple deletions that jointly cover the whole window also guard", () => {
    const plan = buildClipCutPlan(
      [
        { startSec: 10, endSec: 25 },
        { startSec: 25, endSec: 40 },
      ],
      window,
    );
    expect(plan.isEmpty).toBe(true);
  });
});

describe("buildClipCutPlan (sub-100ms sliver dropping)", () => {
  test("MIN_KEPT_SEGMENT_SEC is the frame-safe 100ms floor (2 frames at 20fps)", () => {
    // Pinned so a future accidental change to the shared constant surfaces
    // here, not just as a silent shift in which slivers get dropped.
    expect(MIN_KEPT_SEGMENT_SEC).toBe(0.1);
  });

  test("a kept segment shorter than MIN_KEPT_SEGMENT_SEC is dropped and folded into the surrounding gap", () => {
    // Two deletions leave a 30ms sliver between them (20.00 - 20.03).
    const plan = buildClipCutPlan(
      [
        { startSec: 10, endSec: 20 },
        { startSec: 20.03, endSec: 40 },
      ],
      window,
    );
    expect(plan.droppedSliverCount).toBe(1);
    expect(plan.segments).toHaveLength(0);
    expect(plan.isEmpty).toBe(true);
  });

  test("a sliver next to a real kept segment is dropped while the real segment survives", () => {
    const plan = buildClipCutPlan(
      [
        { startSec: 12, endSec: 20 }, // leaves [10,12) as a 2s kept segment
        { startSec: 20.03, endSec: 40 }, // leaves [20,20.03) as a 30ms sliver, then nothing after
      ],
      window,
    );
    expect(plan.droppedSliverCount).toBe(1);
    expect(plan.segments).toEqual([
      { sourceStartSec: 10, sourceEndSec: 12, editedStartSec: 0 },
    ]);
    expect(plan.editedDurationSec).toBe(2);
  });

  test("a segment exactly at the threshold is kept (>=, not >)", () => {
    const plan = buildClipCutPlan(
      [{ startSec: 10 + MIN_KEPT_SEGMENT_SEC, endSec: 40 }],
      window,
    );
    // kept segment is exactly [10, 10+0.1) = 0.1s long
    expect(plan.segments).toHaveLength(1);
    expect(plan.droppedSliverCount).toBe(0);
  });

  test("threshold delta vs the old 50ms floor: a 70ms sliver used to survive, now gets dropped", () => {
    // Two deletions leave a 70ms sliver (20.00 - 20.07) — kept under the old
    // 0.05s floor, dropped under the new 0.1s frame-safe floor.
    const plan = buildClipCutPlan(
      [
        { startSec: 10, endSec: 20 },
        { startSec: 20.07, endSec: 40 },
      ],
      window,
    );
    expect(plan.droppedSliverCount).toBe(1);
    expect(plan.segments).toHaveLength(0);
    expect(plan.isEmpty).toBe(true);
  });
});

describe("buildClipCutPlan.map integrates with the shared source<->edited helpers", () => {
  test("sourceToEdited via plan.map matches the segment's own editedStartSec math", () => {
    const plan = buildClipCutPlan([{ startSec: 20, endSec: 25 }], window);
    // A word at source time 30 (in the second kept segment) should land at
    // editedStartSec(10) + (30 - 25) = 15 on the edited timeline.
    expect(sourceToEdited(plan.map, 30)).toBe(15);
    // A word inside the deleted range collapses forward onto the cut point.
    expect(sourceToEdited(plan.map, 22)).toBe(10);
  });
});
