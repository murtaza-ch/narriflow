import { describe, expect, test } from "bun:test";
import { CAPTION_SCENE_NAMES, captionSceneMeta } from "@narriflow/validators";
import { SCENE_EDGE_DEMOS, sceneEdgeDemo } from "./demo";
import { buildCaptionScene, captionSceneDemo, sceneInputFromPreset } from "./registry";
import { SCENE_PIECE_BUDGET, evaluatePiece, sceneBoundsAt, sceneRange } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { getCaptionPresetById } from "@narriflow/validators";

/** What every template owes (spec 5.4): it builds its demo and the edge demos within the piece budget and the safe area. */

const SAFE = 0.05;

function check(name: (typeof CAPTION_SCENE_NAMES)[number], cues: ReturnType<typeof captionSceneDemo>["cues"], canvas = { width: 1080, height: 1920 }) {
  const meta = captionSceneMeta(name);
  const input = sceneInput(cues, { canvas, anchor: { xPct: 50, yPct: (meta.anchorLineY / 1920) * 100 } });
  const scene = buildCaptionScene(name, input);
  expect(scene.pieces.length).toBeGreaterThan(0);
  // Pieces of one cue never exceed the budget: pieces are named `<scene>:<cue>:...`.
  const perCue = new Map<string, number>();
  for (const piece of scene.pieces) {
    const cue = piece.id.split(":")[1]!;
    perCue.set(cue, (perCue.get(cue) ?? 0) + 1 + (piece.shadows?.length ?? 0));
  }
  for (const count of perCue.values()) expect(count).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
  // Every piece draws something at some time, and none leaves the safe area while it is visible.
  const { fromMs, toMs } = sceneRange(scene);
  for (let t = fromMs; t < toMs; t += 50) {
    const box = sceneBoundsAt(scene.pieces, t, fakeMeasure);
    if (!box) continue;
    expect(box.x1).toBeGreaterThanOrEqual(SAFE * canvas.width - 1);
    expect(box.x2).toBeLessThanOrEqual((1 - SAFE) * canvas.width + 1);
    expect(box.y1).toBeGreaterThanOrEqual(SAFE * canvas.height - 1);
    expect(box.y2).toBeLessThanOrEqual((1 - SAFE) * canvas.height + 1);
  }
  for (const piece of scene.pieces) {
    expect(piece.toMs).toBeGreaterThan(piece.fromMs);
    const pose = evaluatePiece(piece, piece.fromMs);
    expect(Number.isFinite(pose.x) && Number.isFinite(pose.y)).toBe(true);
  }
  return scene;
}

describe("every Scene Style builds", () => {
  test.each([...CAPTION_SCENE_NAMES])("%s: its demo", (name) => {
    check(name, captionSceneDemo(name).cues);
  });

  test.each([...CAPTION_SCENE_NAMES])("%s: the edge demos", (name) => {
    for (const kind of SCENE_EDGE_DEMOS) check(name, sceneEdgeDemo(kind).cues);
  });

  test.each([...CAPTION_SCENE_NAMES])("%s: a 16:9 canvas", (name) => {
    check(name, captionSceneDemo(name).cues, { width: 1920, height: 1080 });
  });

  test("the preset implies the input: colours, size over the sample's, anchor", () => {
    const preset = { ...getCaptionPresetById("reveal")!.preset, fontSize: 144, primaryColor: "#112233", positionX: 20 };
    const input = sceneInputFromPreset(preset, { cues: [], canvas: { width: 1080, height: 1920 }, measure: fakeMeasure });
    expect(input.scale).toBe(2);
    expect(input.colours).toMatchObject({ primary: "#112233", highlight: "#FFE9A8", shadow: "#000000" });
    expect(input.anchor.xPct).toBe(20);
    expect(input.anchor.yPct).toBeCloseTo((1300 / 1920) * 100, 1);
    expect(() => sceneInputFromPreset(getCaptionPresetById("bold-pop")!.preset, { cues: [], canvas: { width: 1, height: 1 }, measure: fakeMeasure })).toThrow();
  });
});
