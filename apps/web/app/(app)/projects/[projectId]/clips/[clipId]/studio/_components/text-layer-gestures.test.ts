import { describe, expect, test } from "bun:test";
import { cornerResizeTextLayer, dragTextLayer, nudgeTextLayer, sideResizeTextLayer, textToolbarPlacement } from "./text-layer-gestures";

describe("Text Layer canvas gestures", () => {
  test("a drag moves the centre, snaps to the guides and keeps the centre on the canvas", () => {
    expect(dragTextLayer({ positionX: 50, positionY: 12 }, 10, 5)).toMatchObject({ positionX: 60, positionY: 17 });
    const snapped = dragTextLayer({ positionX: 40, positionY: 12 }, 9.2, 0);
    expect(snapped.positionX).toBe(50);
    expect(snapped.guides).toContainEqual({ axis: "x", position: 50 });
    expect(dragTextLayer({ positionX: 90, positionY: 95 }, 40, 40)).toMatchObject({ positionX: 100, positionY: 100 });
    expect(dragTextLayer({ positionX: 10, positionY: 10 }, -40, -40)).toMatchObject({ positionX: 0, positionY: 0 });
  });

  test("a drag to an edge keeps part of the frame, and so one side's grips, on the canvas", () => {
    // A 40% x 10% frame: its centre stays on the canvas (the schema range), which keeps 20% of it inside.
    const reach = { widthPct: 40, heightPct: 10, overlapXPct: 5, overlapYPct: 2 };
    expect(dragTextLayer({ positionX: 30, positionY: 50 }, -80, 0, reach).positionX).toBe(0);
    expect(dragTextLayer({ positionX: 30, positionY: 50 }, 0, 80, reach).positionY).toBe(100);
    // A small frame: the overlap rule is the tighter one.
    const small = { widthPct: 4, heightPct: 4, overlapXPct: 5, overlapYPct: 5 };
    expect(dragTextLayer({ positionX: 30, positionY: 50 }, -80, -80, small)).toMatchObject({ positionX: 2, positionY: 2 });
    expect(dragTextLayer({ positionX: 30, positionY: 50 }, 80, 80, small)).toMatchObject({ positionX: 98, positionY: 98 });
    // Wider than the canvas: the centre stays inside.
    const wide = { widthPct: 120, heightPct: 10, overlapXPct: 5, overlapYPct: 2 };
    expect(dragTextLayer({ positionX: 50, positionY: 50 }, 90, 0, wide).positionX).toBe(100);
  });

  test("an arrow nudge moves by the step and keeps the same reach", () => {
    const reach = { widthPct: 4, heightPct: 4, overlapXPct: 5, overlapYPct: 5 };
    expect(nudgeTextLayer({ positionX: 50, positionY: 50 }, 1, -5, reach)).toEqual({ positionX: 51, positionY: 45 });
    expect(nudgeTextLayer({ positionX: 2.5, positionY: 50 }, -1, 0, reach)).toEqual({ positionX: 2, positionY: 50 });
  });

  test("a corner scales font size and width together", () => {
    expect(cornerResizeTextLayer({ fontSize: 48, widthPct: 80 }, 1.25)).toEqual({ fontSize: 60, widthPct: 100 });
    expect(cornerResizeTextLayer({ fontSize: 48, widthPct: 60 }, 0.5)).toEqual({ fontSize: 24, widthPct: 30 });
  });

  test("a corner stops both at once when either reaches its range", () => {
    // Width 80 reaches 100 at 1.25; the size stops there too instead of growing alone.
    expect(cornerResizeTextLayer({ fontSize: 48, widthPct: 80 }, 3)).toEqual({ fontSize: 60, widthPct: 100 });
    // Size 16 reaches 8 at 0.5; width stops at half.
    expect(cornerResizeTextLayer({ fontSize: 16, widthPct: 80 }, 0.1)).toEqual({ fontSize: 8, widthPct: 40 });
    expect(cornerResizeTextLayer({ fontSize: 48, widthPct: 80 }, Number.NaN)).toEqual({ fontSize: 48, widthPct: 80 });
  });

  test("a side grip changes the width and keeps the opposite edge", () => {
    // Left edge at 10: the right grip dragged to 70 gives width 60 centred at 40.
    expect(sideResizeTextLayer({ positionX: 50, widthPct: 80 }, "right", 70)).toEqual({ positionX: 40, widthPct: 60 });
    // Right edge at 90: the left grip dragged to 30 gives width 60 centred at 60.
    expect(sideResizeTextLayer({ positionX: 50, widthPct: 80 }, "left", 30)).toEqual({ positionX: 60, widthPct: 60 });
    expect(sideResizeTextLayer({ positionX: 50, widthPct: 80 }, "right", 12)).toEqual({ positionX: 15, widthPct: 10 });
    expect(sideResizeTextLayer({ positionX: 50, widthPct: 80 }, "right", 400).widthPct).toBe(100);
  });

  test("the toolbar sits under the frame, flips above without room and stays inside", () => {
    const bounds = { left: 0, top: 0, right: 400, bottom: 700 };
    const toolbar = { width: 300, height: 40 };
    expect(textToolbarPlacement({ left: 100, top: 100, right: 300, bottom: 150 }, toolbar, bounds)).toEqual({ left: 50, top: 160, placement: "below" });
    expect(textToolbarPlacement({ left: 100, top: 600, right: 300, bottom: 680 }, toolbar, bounds)).toEqual({ left: 50, top: 550, placement: "above" });
    expect(textToolbarPlacement({ left: 0, top: 100, right: 40, bottom: 150 }, toolbar, bounds).left).toBe(0);
    expect(textToolbarPlacement({ left: 380, top: 100, right: 400, bottom: 150 }, toolbar, bounds).left).toBe(100);
  });
});
