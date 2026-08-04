import { describe, expect, test } from "bun:test";
import {
  STUDIO_MIN_KEPT_SEGMENT_SEC,
  buildStudioCutPlan,
  deletedRangesToCutMarkers,
  projectSegmentToEdited,
} from "./edited-timeline";

describe("buildStudioCutPlan", () => {
  test("no deletions is the identity fast path: single segment, exact window duration", () => {
    const plan = buildStudioCutPlan([], { startSec: 5, endSec: 35 });

    expect(plan.isUncut).toBe(true);
    expect(plan.isEmpty).toBe(false);
    expect(plan.editedDurationSec).toBe(30);
    expect(plan.segments).toEqual([{ sourceStartSec: 5, sourceEndSec: 35, editedStartSec: 0 }]);
    expect(plan.droppedSliverCount).toBe(0);
  });

  test("a mid-clip deletion shrinks the edited duration and offsets the trailing segment", () => {
    const plan = buildStudioCutPlan([{ startSec: 8, endSec: 12 }], { startSec: 0, endSec: 20 });

    expect(plan.isUncut).toBe(false);
    expect(plan.editedDurationSec).toBe(16);
    expect(plan.segments).toEqual([
      { sourceStartSec: 0, sourceEndSec: 8, editedStartSec: 0 },
      { sourceStartSec: 12, sourceEndSec: 20, editedStartSec: 8 },
    ]);
  });

  test("deleting the entire window is isEmpty with zero edited duration", () => {
    const plan = buildStudioCutPlan([{ startSec: 0, endSec: 20 }], { startSec: 0, endSec: 20 });

    expect(plan.isEmpty).toBe(true);
    expect(plan.editedDurationSec).toBe(0);
    expect(plan.segments).toHaveLength(0);
  });

  test("drops sub-threshold slivers and folds them into the surrounding gap", () => {
    // Window 0-20 with cuts leaving a 20ms kept sliver at [10, 10.02) between
    // two much larger deletions — below STUDIO_MIN_KEPT_SEGMENT_SEC (50ms).
    const sliverSec = STUDIO_MIN_KEPT_SEGMENT_SEC / 2.5;
    const plan = buildStudioCutPlan(
      [
        { startSec: 5, endSec: 10 },
        { startSec: 10 + sliverSec, endSec: 20 },
      ],
      { startSec: 0, endSec: 20 },
    );

    expect(plan.droppedSliverCount).toBe(1);
    expect(plan.segments).toEqual([{ sourceStartSec: 0, sourceEndSec: 5, editedStartSec: 0 }]);
    expect(plan.editedDurationSec).toBe(5);
  });
});

describe("projectSegmentToEdited", () => {
  test("identity map: projected range equals the source-relative input", () => {
    const plan = buildStudioCutPlan([], { startSec: 10, endSec: 40 });
    const projected = projectSegmentToEdited({ startSec: 2, endSec: 6 }, 10, plan.map);

    expect(projected).toEqual({ startSec: 2, endSec: 6 });
  });

  test("a segment straddling a cut collapses to its kept portion", () => {
    const plan = buildStudioCutPlan([{ startSec: 8, endSec: 12 }], { startSec: 0, endSec: 20 });
    // Segment [6, 14) clip-relative == source [6,14): kept portions are
    // [6,8) and [12,14) -> sourceRangeToEdited spans the whole projected
    // envelope [6, 10) on the edited timeline (8 -> edited 8, 14 -> edited 10).
    const projected = projectSegmentToEdited({ startSec: 6, endSec: 14 }, 0, plan.map);

    expect(projected).toEqual({ startSec: 6, endSec: 10 });
  });

  test("a segment entirely inside a cut projects to null (collapsed, not drawn)", () => {
    const plan = buildStudioCutPlan([{ startSec: 8, endSec: 12 }], { startSec: 0, endSec: 20 });
    const projected = projectSegmentToEdited({ startSec: 9, endSec: 11 }, 0, plan.map);

    expect(projected).toBeNull();
  });
});

describe("deletedRangesToCutMarkers", () => {
  test("one marker per deleted range, positioned at the collapsed edited second", () => {
    const ranges = [{ startSec: 8, endSec: 12 }];
    const plan = buildStudioCutPlan(ranges, { startSec: 0, endSec: 20 });

    const markers = deletedRangesToCutMarkers(ranges, plan.map);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.editedSec).toBe(8);
    expect(markers[0]!.durationSec).toBe(4);
    expect(markers[0]!.range).toEqual({ startSec: 8, endSec: 12 });
  });

  test("no markers when nothing is deleted", () => {
    expect(deletedRangesToCutMarkers([], buildStudioCutPlan([], { startSec: 0, endSec: 20 }).map)).toEqual([]);
  });
});
