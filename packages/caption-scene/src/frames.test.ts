import { describe, expect, test } from "bun:test";
import { EASES, kf, prog } from "./ease";
import { sampleFrames } from "./frames";

describe("sampleFrames", () => {
  const rise = (t: number) => EASES.outExpo(prog(t, 100, 400)) * 10 - EASES.out(prog(t, 250, 300)) * 4;

  test("the keyframes follow the function within the tolerance, and fewer frames mean a looser tolerance", () => {
    const edges = [100, 250, 500, 550];
    const tight = sampleFrames(rise, edges, 0.02);
    for (let t = 100; t <= 550; t += 7) expect(Math.abs(kf(t, tight) - rise(t))).toBeLessThan(0.1);
    expect(sampleFrames(rise, edges, 1).length).toBeLessThan(tight.length);
  });

  test("a straight function is one segment between its edges", () => {
    expect(sampleFrames((t) => t / 10, [0, 300, 900], 0.01)).toEqual([[0, 0], [300, 30], [900, 90]]);
  });

  test("a range keeps its own ends and drops edges outside; simplify drops collinear frames and collapses a constant", () => {
    const frames = sampleFrames((t) => t / 10, [0, 300, 900, 2000], 0.01, { range: [100, 1000], simplify: true });
    expect(frames).toEqual([[100, 10], [1000, 100]]);
    expect(sampleFrames(() => 3, [0, 500, 1000], 0.01, { simplify: true })).toEqual([[0, 3]]);
  });

  test("whole milliseconds: edges round and a one-ms step is a jump", () => {
    const step = (t: number) => (t < 200.5 ? 0 : 1);
    const frames = sampleFrames(step, [0.4, 400.2], 0.01, { wholeMs: true });
    expect(frames.every(([at]) => Number.isInteger(at))).toBe(true);
    expect(frames[0]![0]).toBe(0);
  });

  test("the curve is asked for each end of a segment once, not once per check (a 3-minute build samples thousands of tracks)", () => {
    let calls = 0;
    const frames = sampleFrames((t) => {
      calls++;
      return t / 10;
    }, [0, 300, 900], 0.01);
    expect(frames).toEqual([[0, 0], [300, 30], [900, 90]]);
    // Three edges, and the three quarter points of each of the two segments.
    expect(calls).toBe(3 + 2 * 3);
  });
});
