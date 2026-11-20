import { describe, expect, test } from "bun:test";
import type { StudioMusicBlock } from "@narriflow/validators";
import {
  MUSIC_MIN_SEC,
  addMusicTrack,
  blockAtTime,
  blockWaveformColumns,
  canSplitBlock,
  computePeaks,
  loopPointsSec,
  moveBlock,
  nearestSnap,
  selectedOrOnlyBlock,
  snapTargets,
  splitBlock,
  trimBlockEnd,
  trimBlockStart,
} from "./music-blocks";

const CLIP = 60;

function block(overrides: Partial<StudioMusicBlock> & { id: string }): StudioMusicBlock {
  return {
    assetId: null,
    url: "https://cdn.example/track.mp3",
    title: "Track",
    startSec: 0,
    endSec: null,
    sourceStartSec: 0,
    volume: 35,
    fadeInSec: 1,
    fadeOutSec: 2,
    ...overrides,
  };
}

const track = { assetId: null, url: "https://cdn.example/new.mp3", title: "New" };

describe("moveBlock", () => {
  test("a flush drop never ends past the next block's start (float ulp)", () => {
    const flush = [
      block({ id: "a", startSec: 28.7, endSec: 52.1 }),
      block({ id: "b", startSec: 57.35, endSec: 59 }),
    ];
    const moved = moveBlock(flush, "a", 40, CLIP);
    expect(moved).not.toBeNull();
    expect(moved!.endSec).not.toBeNull();
    expect(moved!.endSec!).toBeLessThanOrEqual(57.35);
  });

  const blocks = [
    block({ id: "a", startSec: 5, endSec: 15 }),
    block({ id: "b", startSec: 30, endSec: 40 }),
  ];

  test("keeps the block's length", () => {
    expect(moveBlock(blocks, "a", 10, CLIP)).toEqual({ startSec: 10, endSec: 20, guideSec: null });
  });

  test("clamps against the next block instead of reverting", () => {
    expect(moveBlock(blocks, "a", 28, CLIP)).toEqual({ startSec: 20, endSec: 30, guideSec: null });
  });

  test("clamps against the previous block and zero", () => {
    expect(moveBlock(blocks, "b", 2, CLIP)).toEqual({ startSec: 15, endSec: 25, guideSec: null });
    expect(moveBlock(blocks, "a", -9, CLIP)).toEqual({ startSec: 0, endSec: 10, guideSec: null });
  });

  test("clamps at the clip end without truncating, storing null for the last block", () => {
    expect(moveBlock(blocks, "b", 100, CLIP)).toEqual({ startSec: 50, endSec: null, guideSec: null });
  });

  test("a bed running to the clip end keeps its length when it moves left", () => {
    const bed = [block({ id: "bed", startSec: 20, endSec: null })];
    expect(moveBlock(bed, "bed", 5, CLIP)).toEqual({ startSec: 5, endSec: 45, guideSec: null });
    expect(moveBlock(bed, "bed", 99, CLIP)).toEqual({ startSec: 20, endSec: null, guideSec: null });
  });

  test("snaps the start to the playhead and reports the guide", () => {
    const snap = { targetsSec: snapTargets(blocks, "a", 12, CLIP), thresholdSec: 0.3 };
    expect(moveBlock(blocks, "a", 11.9, CLIP, snap)).toEqual({ startSec: 12, endSec: 22, guideSec: 12 });
  });

  test("snaps the end edge to a neighbour's start", () => {
    const snap = { targetsSec: snapTargets(blocks, "a", 0.5, CLIP), thresholdSec: 0.3 };
    const moved = moveBlock(blocks, "a", 19.8, CLIP, snap);
    expect(moved).toEqual({ startSec: 20, endSec: 30, guideSec: 30 });
  });

  test("drops the guide when clamping pulls the edge off its target", () => {
    const snap = { targetsSec: [33], thresholdSec: 1 };
    const moved = moveBlock(blocks, "a", 22.5, CLIP, snap);
    expect(moved?.startSec).toBe(20);
    expect(moved?.guideSec).toBeNull();
  });
});

describe("trimBlockStart", () => {
  test("moves the in-point with the edge", () => {
    const blocks = [block({ id: "a", startSec: 10, endSec: 30, sourceStartSec: 8 })];
    expect(trimBlockStart(blocks, "a", 14, CLIP)).toEqual({ startSec: 14, sourceStartSec: 12, guideSec: null });
  });

  test("cannot extend back past in-point 0", () => {
    const blocks = [block({ id: "a", startSec: 10, endSec: 30, sourceStartSec: 3 })];
    expect(trimBlockStart(blocks, "a", 0, CLIP)).toEqual({ startSec: 7, sourceStartSec: 0, guideSec: null });
  });

  test("cannot cross the previous block or leave less than the minimum", () => {
    const blocks = [
      block({ id: "p", startSec: 0, endSec: 8 }),
      block({ id: "a", startSec: 10, endSec: 30, sourceStartSec: 50 }),
    ];
    expect(trimBlockStart(blocks, "a", 2, CLIP)?.startSec).toBe(8);
    expect(trimBlockStart(blocks, "a", 29.9, CLIP)?.startSec).toBeCloseTo(30 - MUSIC_MIN_SEC, 8);
  });
});

describe("trimBlockEnd", () => {
  const blocks = [
    block({ id: "a", startSec: 5, endSec: 15 }),
    block({ id: "b", startSec: 30, endSec: 40 }),
  ];

  test("clamps to the next block and the minimum length", () => {
    expect(trimBlockEnd(blocks, "a", 35, CLIP)?.endSec).toBe(30);
    expect(trimBlockEnd(blocks, "a", 5.1, CLIP)?.endSec).toBeCloseTo(5 + MUSIC_MIN_SEC, 8);
  });

  test("dragging the last block to the clip end stores null", () => {
    expect(trimBlockEnd(blocks, "b", 75, CLIP)?.endSec).toBeNull();
    expect(trimBlockEnd(blocks, "b", 45, CLIP)?.endSec).toBe(45);
  });

  test("snaps to the playhead with a guide", () => {
    const snap = { targetsSec: [20], thresholdSec: 0.25 };
    expect(trimBlockEnd(blocks, "a", 19.9, CLIP, snap)).toEqual({ endSec: 20, guideSec: 20 });
  });
});

describe("splitBlock", () => {
  const blocks = [block({ id: "a", startSec: 10, endSec: 30, sourceStartSec: 4 })];

  test("makes two independent blocks with their own in-points", () => {
    const result = splitBlock(blocks, "a", 18, CLIP, "b");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blocks).toEqual([
      { ...blocks[0]!, endSec: 18, fadeOutSec: 0 },
      { ...blocks[0]!, id: "b", startSec: 18, endSec: 30, sourceStartSec: 12, fadeInSec: 0 },
    ]);
    expect(result.rightBlockId).toBe("b");
  });

  test("wraps the right in-point to a known track length", () => {
    const result = splitBlock(blocks, "a", 18, CLIP, "b", 10);
    if (!result.ok) throw new Error("expected split");
    expect(result.blocks[1]?.sourceStartSec).toBe(2);
  });

  test("keeps a null end on the right half of the last block", () => {
    const bed = [block({ id: "a", startSec: 0, endSec: null })];
    const result = splitBlock(bed, "a", 20, CLIP, "b");
    if (!result.ok) throw new Error("expected split");
    expect(result.blocks[0]?.endSec).toBe(20);
    expect(result.blocks[1]?.endSec).toBeNull();
  });

  test("refuses a split too close to either edge", () => {
    expect(splitBlock(blocks, "a", 10.2, CLIP, "b")).toEqual({ ok: false, reason: "outside" });
    expect(splitBlock(blocks, "a", 29.8, CLIP, "b")).toEqual({ ok: false, reason: "outside" });
    expect(splitBlock(blocks, "a", 40, CLIP, "b")).toEqual({ ok: false, reason: "outside" });
    expect(canSplitBlock(blocks[0]!, 10 + MUSIC_MIN_SEC, CLIP)).toBe(true);
  });

  test("refuses at the block limit", () => {
    const full = Array.from({ length: 12 }, (_, i) =>
      block({ id: `x${i}`, startSec: i * 5, endSec: i * 5 + 4 }),
    );
    expect(splitBlock(full, "x0", 2, CLIP, "n")).toEqual({ ok: false, reason: "limit" });
  });
});

describe("addMusicTrack", () => {
  test("a first track is a full-length bed from 0", () => {
    const result = addMusicTrack([], track, 12, CLIP, "n");
    expect(result.kind).toBe("added");
    if (result.kind !== "added") return;
    expect(result.blocks[0]).toMatchObject({ id: "n", startSec: 0, endSec: null, sourceStartSec: 0, volume: 35 });
  });

  test("a playhead inside a block replaces its track and keeps timing and mix", () => {
    const blocks = [block({ id: "a", startSec: 10, endSec: 30, sourceStartSec: 6, volume: 20 })];
    const result = addMusicTrack(blocks, track, 15, CLIP, "n");
    expect(result.kind).toBe("replaced");
    if (result.kind !== "replaced") return;
    expect(result.blocks).toEqual([
      { ...blocks[0]!, url: track.url, title: "New", assetId: null, sourceStartSec: 0 },
    ]);
  });

  test("a playhead in a gap inserts up to the next block", () => {
    const blocks = [
      block({ id: "a", startSec: 0, endSec: 10 }),
      block({ id: "b", startSec: 30, endSec: 40 }),
    ];
    const result = addMusicTrack(blocks, track, 12, CLIP, "n");
    if (result.kind !== "added") throw new Error("expected insert");
    expect(result.blocks.map((b) => [b.id, b.startSec, b.endSec])).toEqual([
      ["a", 0, 10],
      ["n", 12, 30],
      ["b", 30, 40],
    ]);
  });

  test("after the last block it runs to the clip end", () => {
    const blocks = [block({ id: "a", startSec: 0, endSec: 10 })];
    const result = addMusicTrack(blocks, track, 20, CLIP, "n");
    if (result.kind !== "added") throw new Error("expected insert");
    expect(result.blocks[1]).toMatchObject({ startSec: 20, endSec: null });
  });

  test("reports no room when the gap is under the minimum", () => {
    const blocks = [
      block({ id: "a", startSec: 0, endSec: 10 }),
      block({ id: "b", startSec: 10.2, endSec: 40 }),
    ];
    expect(addMusicTrack(blocks, track, 10.05, CLIP, "n")).toEqual({ kind: "no-room" });
    const tail = [block({ id: "a", startSec: 0, endSec: 10 })];
    expect(addMusicTrack(tail, track, 59.9, CLIP, "n")).toEqual({ kind: "no-room" });
  });

  test("reports the limit only when it would add a block", () => {
    const full = Array.from({ length: 12 }, (_, i) =>
      block({ id: `x${i}`, startSec: i * 5, endSec: i * 5 + 4 }),
    );
    expect(addMusicTrack(full, track, 4.5, CLIP, "n")).toEqual({ kind: "limit" });
    expect(addMusicTrack(full, track, 1, CLIP, "n").kind).toBe("replaced");
  });
});

describe("helpers", () => {
  test("blockAtTime is half-open", () => {
    const blocks = [block({ id: "a", startSec: 0, endSec: 10 }), block({ id: "b", startSec: 10, endSec: 20 })];
    expect(blockAtTime(blocks, 10, CLIP)?.id).toBe("b");
    expect(blockAtTime(blocks, 20, CLIP)).toBeNull();
  });

  test("selectedOrOnlyBlock falls back to the only block", () => {
    const one = [block({ id: "a" })];
    expect(selectedOrOnlyBlock(one, null)?.id).toBe("a");
    expect(selectedOrOnlyBlock(one, "gone")?.id).toBe("a");
    const two = [block({ id: "a", endSec: 5 }), block({ id: "b", startSec: 6 })];
    expect(selectedOrOnlyBlock(two, null)).toBeNull();
    expect(selectedOrOnlyBlock(two, "b")?.id).toBe("b");
  });

  test("nearestSnap picks the closest target inside the threshold", () => {
    const snap = { targetsSec: [1, 1.2, 5], thresholdSec: 0.3 };
    expect(nearestSnap(1.15, snap)).toBe(1.2);
    expect(nearestSnap(3, snap)).toBeNull();
    expect(nearestSnap(1, null)).toBeNull();
  });

  test("loopPointsSec lists where a short track restarts", () => {
    expect(loopPointsSec(0, 25, 10)).toEqual([10, 20]);
    expect(loopPointsSec(4, 25, 10)).toEqual([6, 16]);
    expect(loopPointsSec(0, 5, 10)).toEqual([]);
    expect(loopPointsSec(0, 25, null)).toEqual([]);
  });

  test("blockWaveformColumns offsets by the in-point and wraps the track", () => {
    const peaks = Float32Array.from([0, 0.25, 0.5, 0.75]);
    expect(blockWaveformColumns(peaks, 4, 0, 4, 4)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(blockWaveformColumns(peaks, 4, 2, 4, 4)).toEqual([0.5, 0.75, 0, 0.25]);
    expect(blockWaveformColumns([], 4, 0, 4, 4)).toEqual([]);
  });

  test("computePeaks normalises to the loudest bucket", () => {
    const samples = new Float32Array(1000);
    samples.fill(0.1, 0, 500);
    samples.fill(-0.4, 500);
    const peaks = computePeaks([samples], 2);
    expect(peaks[0]).toBeCloseTo(0.25, 5);
    expect(peaks[1]).toBeCloseTo(1, 5);
  });
});
