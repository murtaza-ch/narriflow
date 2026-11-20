import { describe, expect, test } from "bun:test";
import { arcPath, centredRect, ellipsePath, pathBounds, pathToAss, pathToSvg, polylinePath, retracePath, roundedRectPath, sparklePath, starPath } from "./shapes";

describe("shapes", () => {
  test("bounds of the helpers", () => {
    expect(pathBounds(centredRect(100, 40))).toEqual({ x1: -50, y1: -20, x2: 50, y2: 20 });
    expect(pathBounds(roundedRectPath(0, 0, 200, 60, 20))).toEqual({ x1: 0, y1: 0, x2: 200, y2: 60 });
    const star = pathBounds(starPath(5, 50, 20));
    expect(star.y1).toBeCloseTo(-50, 6);
    expect(pathBounds(sparklePath(30))).toEqual({ x1: -30, y1: -30, x2: 30, y2: 30 });
    const ellipse = pathBounds(ellipsePath(0, 0, 80, 30));
    expect(ellipse.x2).toBeCloseTo(80, 6);
  });

  test("an arc ends where it says", () => {
    const arc = arcPath(0, 0, 100, 0, 180);
    const last = arc[arc.length - 1]!;
    expect(last[0]).toBe("C");
    expect(last[5]).toBeCloseTo(-100, 6);
    expect(last[6]).toBeCloseTo(0, 6);
  });

  test("SVG and ASS drawings of the same path", () => {
    const path = polylinePath([[0, 0], [10, 0], [10, 5]]);
    expect(pathToSvg(path)).toBe("M0 0 L10 0 L10 5");
    expect(pathToAss(path)).toBe("m 0 0 l 10 0 l 10 5");
    expect(pathToAss(path, 3)).toBe("m 0 0 l 40 0 l 40 20");
  });

  test("retracing an open path goes there and back, a curve with its control points swapped", () => {
    expect(pathToAss(retracePath(polylinePath([[0, 0], [10, 0], [10, 5]])))).toBe("m 0 0 l 10 0 l 10 5 l 10 0 l 0 0");
    const curve = retracePath([["M", 0, 0], ["C", 1, 2, 3, 4, 5, 6]]);
    expect(curve).toEqual([["M", 0, 0], ["C", 1, 2, 3, 4, 5, 6], ["C", 3, 4, 1, 2, 0, 0]]);
    // A closed outline retraces to the start as well, so its border is one centred band.
    const closed = retracePath(centredRect(10, 4));
    expect(closed.filter((command) => command[0] === "L").length).toBeGreaterThanOrEqual(8);
  });
});
