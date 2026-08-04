import { describe, expect, test } from "bun:test";

import {
  buildEditedTimeMap,
  editedToSource,
  hasRenderableContent,
  isSourceTimeDeleted,
  MIN_KEPT_SEGMENT_SEC,
  normalizeDeletedRanges,
  sourceRangeToEdited,
  sourceToEdited,
} from "./edit-ranges";

const WINDOW = { startSec: 10, endSec: 40 };

describe("normalizeDeletedRanges", () => {
  test("clamps to the clip window and drops degenerate ranges", () => {
    expect(
      normalizeDeletedRanges(
        [
          { startSec: 0, endSec: 12 },
          { startSec: 39, endSec: 90 },
          { startSec: 20, endSec: 20.0004 },
          { startSec: 25, endSec: 24 },
        ],
        WINDOW,
      ),
    ).toEqual([
      { startSec: 10, endSec: 12 },
      { startSec: 39, endSec: 40 },
    ]);
  });

  test("sorts and merges overlapping and near-adjacent ranges", () => {
    expect(
      normalizeDeletedRanges(
        [
          { startSec: 30, endSec: 32 },
          { startSec: 15, endSec: 18 },
          { startSec: 17, endSec: 20 },
          { startSec: 20.0005, endSec: 22 },
        ],
        WINDOW,
      ),
    ).toEqual([
      { startSec: 15, endSec: 22 },
      { startSec: 30, endSec: 32 },
    ]);
  });

  test("empty input stays empty", () => {
    expect(normalizeDeletedRanges([], WINDOW)).toEqual([]);
  });
});

describe("buildEditedTimeMap", () => {
  test("no deletions is the identity window", () => {
    const map = buildEditedTimeMap([], WINDOW);
    expect(map.segments).toEqual([
      { sourceStartSec: 10, sourceEndSec: 40, editedStartSec: 0 },
    ]);
    expect(map.editedDurationSec).toBe(30);
  });

  test("interior cut splits into contiguous edited segments", () => {
    const map = buildEditedTimeMap([{ startSec: 20, endSec: 25 }], WINDOW);
    expect(map.segments).toEqual([
      { sourceStartSec: 10, sourceEndSec: 20, editedStartSec: 0 },
      { sourceStartSec: 25, sourceEndSec: 40, editedStartSec: 10 },
    ]);
    expect(map.editedDurationSec).toBe(25);
  });

  test("cuts touching the window edges shrink the first/last segment", () => {
    const map = buildEditedTimeMap(
      [
        { startSec: 10, endSec: 12 },
        { startSec: 38, endSec: 40 },
      ],
      WINDOW,
    );
    expect(map.segments).toEqual([
      { sourceStartSec: 12, sourceEndSec: 38, editedStartSec: 0 },
    ]);
    expect(map.editedDurationSec).toBe(26);
  });

  test("deleting everything yields an empty map", () => {
    const map = buildEditedTimeMap([{ startSec: 0, endSec: 100 }], WINDOW);
    expect(map.segments).toEqual([]);
    expect(map.editedDurationSec).toBe(0);
  });
});

describe("sourceToEdited / editedToSource", () => {
  const map = buildEditedTimeMap(
    [
      { startSec: 15, endSec: 18 },
      { startSec: 30, endSec: 35 },
    ],
    WINDOW,
  );
  // kept: [10,15) [18,30) [35,40] → edited duration 22

  test("maps kept instants linearly across cuts", () => {
    expect(sourceToEdited(map, 10)).toBe(0);
    expect(sourceToEdited(map, 14)).toBe(4);
    expect(sourceToEdited(map, 18)).toBe(5);
    expect(sourceToEdited(map, 29)).toBe(16);
    expect(sourceToEdited(map, 35)).toBe(17);
    expect(sourceToEdited(map, 40)).toBe(22);
  });

  test("instants inside a cut collapse onto the cut point", () => {
    expect(sourceToEdited(map, 16.5)).toBe(5);
    expect(sourceToEdited(map, 32)).toBe(17);
  });

  test("out-of-window instants clamp to the edited bounds", () => {
    expect(sourceToEdited(map, 2)).toBe(0);
    expect(sourceToEdited(map, 99)).toBe(22);
  });

  test("editedToSource inverts kept instants; cut points map to the next frame", () => {
    expect(editedToSource(map, 0)).toBe(10);
    expect(editedToSource(map, 4)).toBe(14);
    // edited 5 is exactly the cut: the frame that plays there is source 18
    expect(editedToSource(map, 5)).toBe(18);
    expect(editedToSource(map, 16.5)).toBe(29.5);
    expect(editedToSource(map, 22)).toBe(40);
  });

  test("editedToSource clamps outside [0, editedDuration]", () => {
    expect(editedToSource(map, -3)).toBe(10);
    expect(editedToSource(map, 500)).toBe(40);
  });

  test("edited-space round-trips exactly across the whole timeline", () => {
    for (let e = 0; e <= map.editedDurationSec; e += 0.2) {
      expect(sourceToEdited(map, editedToSource(map, e))).toBeCloseTo(e, 3);
    }
  });

  test("source-space round-trips for kept instants off cut boundaries", () => {
    // A kept-segment end that abuts a cut shares its edited instant with the
    // next segment's start, so only that boundary instant collapses forward.
    const cutEdges = new Set(
      map.segments.flatMap((s) => [s.sourceStartSec, s.sourceEndSec]),
    );
    for (let t = 10; t <= 40; t += 0.25) {
      if (isSourceTimeDeleted(map, t) || cutEdges.has(t)) continue;
      expect(editedToSource(map, sourceToEdited(map, t))).toBeCloseTo(t, 3);
    }
  });

  test("empty map degrades safely", () => {
    const empty = buildEditedTimeMap([{ startSec: 0, endSec: 100 }], WINDOW);
    expect(sourceToEdited(empty, 20)).toBe(0);
    expect(editedToSource(empty, 5)).toBe(10);
  });
});

describe("isSourceTimeDeleted", () => {
  const map = buildEditedTimeMap([{ startSec: 20, endSec: 25 }], WINDOW);

  test("flags cut interiors and out-of-window times, keeps boundaries", () => {
    expect(isSourceTimeDeleted(map, 22)).toBe(true);
    expect(isSourceTimeDeleted(map, 5)).toBe(true);
    expect(isSourceTimeDeleted(map, 45)).toBe(true);
    expect(isSourceTimeDeleted(map, 20)).toBe(false);
    expect(isSourceTimeDeleted(map, 25)).toBe(false);
    expect(isSourceTimeDeleted(map, 10)).toBe(false);
  });
});

describe("hasRenderableContent", () => {
  test("no deletions always has renderable content", () => {
    expect(hasRenderableContent(WINDOW, [])).toBe(true);
  });

  test("deleting everything leaves nothing renderable", () => {
    expect(
      hasRenderableContent(WINDOW, [{ startSec: 0, endSec: 100 }]),
    ).toBe(false);
  });

  test("a real kept segment is renderable", () => {
    expect(
      hasRenderableContent(WINDOW, [{ startSec: 20, endSec: 25 }]),
    ).toBe(true);
  });

  test("only a sub-MIN_KEPT_SEGMENT_SEC sliver survives -> not renderable", () => {
    // Two deletions leave a 30ms sliver between them, well under the 0.1s
    // frame-safe floor.
    expect(
      hasRenderableContent(WINDOW, [
        { startSec: 10, endSec: 20 },
        { startSec: 20.03, endSec: 40 },
      ]),
    ).toBe(false);
  });

  test("a segment exactly at MIN_KEPT_SEGMENT_SEC counts as renderable", () => {
    expect(
      hasRenderableContent(WINDOW, [
        { startSec: 10 + MIN_KEPT_SEGMENT_SEC, endSec: 40 },
      ]),
    ).toBe(true);
  });
});

describe("sourceRangeToEdited", () => {
  const map = buildEditedTimeMap([{ startSec: 20, endSec: 25 }], WINDOW);

  test("maps a range that straddles a cut by shrinking it", () => {
    expect(sourceRangeToEdited(map, { startSec: 18, endSec: 27 })).toEqual({
      startSec: 8,
      endSec: 12,
    });
  });

  test("returns null for ranges swallowed by a cut", () => {
    expect(sourceRangeToEdited(map, { startSec: 21, endSec: 24 })).toBeNull();
  });

  test("keeps fully-retained ranges intact", () => {
    expect(sourceRangeToEdited(map, { startSec: 11, endSec: 14 })).toEqual({
      startSec: 1,
      endSec: 4,
    });
  });
});
