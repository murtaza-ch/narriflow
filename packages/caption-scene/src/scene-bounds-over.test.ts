import { describe, expect, test } from "bun:test";
import { kf } from "./ease";
import { CAPTION_SCENE_PROGRAMS, buildCaptionScene, captionSceneDemo } from "./registry";
import { type Box, sceneBoundsAt, sceneBoundsOver } from "./scene";
import { sceneInput } from "./test-support";

/** The per-sample union `sceneBoundsOver` stands in for. */
function unionAt(pieces: Parameters<typeof sceneBoundsAt>[0], times: readonly number[], measure: Parameters<typeof sceneBoundsAt>[2]): Box | null {
  let union: Box | null = null;
  for (const t of times) {
    const box = sceneBoundsAt(pieces, t, measure);
    if (!box) continue;
    union = union ? { x1: Math.min(union.x1, box.x1), y1: Math.min(union.y1, box.y1), x2: Math.max(union.x2, box.x2), y2: Math.max(union.y2, box.y2) } : box;
  }
  return union;
}

describe("sceneBoundsOver", () => {
  test("is exactly the union of sceneBoundsAt over the same times, for every template's sample", () => {
    for (const name of Object.keys(CAPTION_SCENE_PROGRAMS) as (keyof typeof CAPTION_SCENE_PROGRAMS)[]) {
      const input = sceneInput(captionSceneDemo(name).cues);
      const { pieces } = buildCaptionScene(name, input);
      const end = Math.max(0, ...pieces.map((piece) => piece.toMs));
      // A 16 ms grid, an odd 7 ms grid (off the keyframes), and the pieces' own edges and keyframe times.
      const times = new Set<number>();
      for (let t = 0; t < end; t += 16) times.add(t);
      for (let t = 3; t < end; t += 7) times.add(t);
      for (const piece of pieces) {
        times.add(piece.fromMs);
        times.add(piece.toMs - 0.001);
        for (const frames of Object.values(piece.track)) for (const frame of frames ?? []) if (typeof frame[0] === "number") times.add(frame[0]);
      }
      expect(sceneBoundsOver(pieces, times, input.measure), name).toEqual(unionAt(pieces, [...times], input.measure));
    }
  });

  test("a hold is read at its first sample: values before the first keyframe and after the last are the track's ends", () => {
    const frames = [[100, 2], [200, 8, "out"]] as const;
    expect(kf(50, frames)).toBe(2);
    expect(kf(100, frames)).toBe(2);
    expect(kf(250, frames)).toBe(8);
  });
});
