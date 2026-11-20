import { describe, expect, test } from "bun:test";
import { balancedRows, clampToSafeArea, cueDirection, fitScale, greedyRows, rowVisualOrder, rowsFromRoles, rowWidth, sceneSpace, shiftPiece } from "./layout";
import type { TextPiece } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";

const cue = { index: 0, startMs: 0, endMs: 1000, speaker: null, language: "en", words: [{ text: "hi", startMs: 0, endMs: 100, role: "body" as const, key: null }] };

describe("layout helpers", () => {
  test("sceneSpace maps the sample's frame onto the canvas about the anchor", () => {
    const space = sceneSpace(sceneInput([cue], { canvas: { width: 1920, height: 1080 }, anchor: { xPct: 25, yPct: 50 }, scale: 1.5 }), 1300);
    expect(space.u).toBeCloseTo(1.5, 9);
    expect(space.x(540)).toBeCloseTo(480, 9);
    expect(space.y(1300)).toBeCloseTo(540, 9);
    expect(space.px(100)).toBeCloseTo(150, 9);
    expect(space.x(640)).toBeCloseTo(630, 9);
    expect(space.safe).toEqual({ x1: 96, y1: 54, x2: 1824, y2: 1026 });
  });

  test("rowsFromRoles splits around the hero span", () => {
    expect(rowsFromRoles(["minor", "body", "hero", "body"])).toEqual({ lead: [0, 1], hero: [2], tail: [3] });
    expect(rowsFromRoles(["body", "hero", "hero"])).toEqual({ lead: [0], hero: [1, 2], tail: [] });
    expect(rowsFromRoles(["body", "body"])).toEqual({ lead: [0, 1], hero: [], tail: [] });
  });

  test("greedy and balanced wrap", () => {
    const widths = [100, 100, 100, 100, 100, 100, 100];
    expect(greedyRows(widths, 10, 350)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    const balanced = balancedRows(widths, 10, 350);
    expect(balanced.map((row) => row.length).sort()).toEqual([2, 2, 3]);
    expect(balanced.flat()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(greedyRows([500], 10, 300)).toEqual([[0]]);
    expect(rowWidth(widths, [0, 1, 2], 10)).toBe(320);
    expect(balancedRows([100, 100], 10, 500)).toEqual([[0, 1]]);
  });

  test("fitScale never grows", () => {
    expect(fitScale(1000, 500)).toBe(0.5);
    expect(fitScale(400, 500)).toBe(1);
  });

  test("a right-to-left row reads from its right edge; a left-to-right row keeps its order", () => {
    expect(rowVisualOrder(["a", "b", "c"], "ltr")).toEqual([0, 1, 2]);
    expect(rowVisualOrder(["یہ", "بہت", "اچھا"], "rtl")).toEqual([2, 1, 0]);
    expect(cueDirection({ language: "ur", words: [{ text: "یہ", startMs: 0, endMs: 1, role: "body", key: null }] })).toBe("rtl");
    expect(cueDirection({ language: "en", words: [{ text: "hi", startMs: 0, endMs: 1, role: "body", key: null }] })).toBe("ltr");
  });

  const piece = (x: number): TextPiece => ({
    id: "t",
    kind: "text",
    z: 1,
    fromMs: 0,
    toMs: 200,
    text: "hello",
    face: "Inter Tight Bold",
    sizePx: 100,
    letterSpacingEm: 0,
    fill: "#FFF",
    anchor: "baseline-left",
    track: { x: [[0, x]], y: [[0, 500]] },
    clip: { x1: [[0, x]], y1: [[0, 400]], x2: [[0, x + 300]], y2: [[0, 600]] },
  });

  test("clampToSafeArea shifts a group, clip included, and never scales", () => {
    const safe = { x1: 54, y1: 96, x2: 1026, y2: 1824 };
    const [moved] = clampToSafeArea([piece(-100)], safe, fakeMeasure);
    expect(moved!.sizePx).toBe(100);
    const shifted = shiftPiece(piece(-100), 154, 0);
    expect(moved!.track.x).toEqual(shifted.track.x);
    expect(moved!.track.x![0]![1]).toBeGreaterThanOrEqual(54);
    expect(moved!.clip!.x1[0]![1]).toBe(moved!.track.x![0]![1]);
    const [fine] = clampToSafeArea([piece(200)], safe, fakeMeasure);
    expect(fine!.track.x![0]![1]).toBe(200);
  });
});
