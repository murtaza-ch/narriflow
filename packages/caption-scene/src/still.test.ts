import { expect, test } from "bun:test";
import { CAPTION_SCENE_NAMES, getCaptionPresetById } from "@narriflow/validators";
import { buildCaptionScene, captionSceneDemo, captionSceneStillMs, sceneInputFromPreset } from "./registry";
import { evaluatePiece, pieceBounds } from "./scene";
import { fakeMeasure } from "./test-support";

test.each([...CAPTION_SCENE_NAMES])("%s: the shared demo still shows readable caption text", (name) => {
  const preset = getCaptionPresetById(name)!.preset;
  const { cues, duration } = captionSceneDemo(name);
  const at = captionSceneStillMs(name);
  expect(at).toBeGreaterThan(0);
  expect(at).toBeLessThan(duration);
  for (const canvas of [{ width: 1080, height: 1350 }, { width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
    const scene = buildCaptionScene(name, sceneInputFromPreset(preset, { cues, canvas, measure: fakeMeasure }));
    const readable = scene.pieces.filter((piece) => {
      if (piece.kind !== "text" || !piece.text.trim()) return false;
      const pose = evaluatePiece(piece, at);
      const bounds = pieceBounds(piece, at, fakeMeasure);
      return pose.visible && pose.o >= 0.9 && Math.abs(pose.sx) >= 0.5 && Math.abs(pose.sy) >= 0.5 && pose.blur <= 2 &&
        bounds !== null && bounds.x2 > 0 && bounds.x1 < canvas.width && bounds.y2 > 0 && bounds.y1 < canvas.height;
    });
    expect(readable.length, `${name} at ${at}ms on ${canvas.width}x${canvas.height}`).toBeGreaterThan(0);
  }
});
