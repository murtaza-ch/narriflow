import { describe, expect, test } from "bun:test";
import { type CaptionSceneName, captionSceneMeta, getCaptionPresetById } from "@narriflow/validators";
import { fastRun } from "../conformance-support";
import type { SceneCue } from "../input";
import { buildCaptionScene, captionSceneDemo, sceneInputFromPreset } from "../registry";
import { pieceBounds, sceneBoundsAt } from "../scene";
import { fakeMeasure } from "../test-support";
import { captionSceneEmojiCueBoxes, sceneCueBoxes } from "./scene-cue-boxes";

const CANVAS = { width: 1080, height: 1920 };

function boxes(name: CaptionSceneName, cues: readonly SceneCue[]) {
  const input = sceneInputFromPreset(getCaptionPresetById(name)!.preset, { cues, canvas: CANVAS, measure: fakeMeasure });
  const scene = buildCaptionScene(name, input);
  return { scene, boxes: sceneCueBoxes(scene, cues, { measure: fakeMeasure, canvas: CANVAS, bodyPx: captionSceneMeta(name).bodyPx * input.scale, direction: () => "ltr" }) };
}

describe("sceneCueBoxes", () => {
  test("from a preset (both renderers): the style's body size times the size scale, each cue's own direction", () => {
    const preset = { ...getCaptionPresetById("lyrics")!.preset, fontSize: getCaptionPresetById("lyrics")!.preset.fontSize * 1.5 };
    const cues = captionSceneDemo("lyrics").cues.map((cue, at) => (at === 1 ? { ...cue, language: "ur", words: cue.words.map((word) => ({ ...word, text: "خیال" })) } : cue));
    const input = sceneInputFromPreset(preset, { cues, canvas: CANVAS, measure: fakeMeasure });
    const found = captionSceneEmojiCueBoxes(buildCaptionScene("lyrics", input), { ...input, preset }, fakeMeasure);
    expect(found[0]!.bodyPx).toBeCloseTo(captionSceneMeta("lyrics").bodyPx * input.scale, 9);
    expect(found.map((box) => box.direction).slice(0, 3)).toEqual(["ltr", "rtl", "ltr"]);
    expect(captionSceneEmojiCueBoxes({ pieces: [] }, { ...input, preset: { scene: undefined } }, fakeMeasure)).toEqual([]);
  });

  test("every cue of the sample and of fast speech gets a box on every style that draws it", () => {
    for (const name of ["lyrics", "flap", "ticker", "index", "receipt", "horizon"] as const) {
      for (const cues of [captionSceneDemo(name).cues, fastRun(0)]) expect(boxes(name, cues).boxes.map((box) => box.cueIndex), name).toEqual(cues.map((cue) => cue.index));
    }
  });

  test("a stack's emoji window is the cue's turn: from just before its first word to the next cue's first paint", () => {
    const { cues } = captionSceneDemo("lyrics");
    const found = boxes("lyrics", cues).boxes;
    for (const [at, box] of found.entries()) {
      expect(box.fromMs).toBeGreaterThanOrEqual(cues[at]!.startMs - 100);
      const next = cues[at + 1];
      if (next) expect(box.toMs).toBeLessThanOrEqual(Math.max(next.startMs, cues[at]!.words.at(-1)!.startMs + 100));
    }
  });

  test("a cue written on another cue's plate (Index's card) takes the plate into its box", () => {
    const { cues } = captionSceneDemo("index");
    const { scene, boxes: found } = boxes("index", cues);
    const card = scene.pieces.find((piece) => piece.id === "index:0:card:a")!;
    const second = found.find((box) => box.cueIndex === 1)!;
    const plate = pieceBounds(card, second.fromMs + 300, fakeMeasure)!;
    expect(second.box.x1).toBeLessThanOrEqual(plate.x1 + 0.5);
    expect(second.box.x2).toBeGreaterThanOrEqual(plate.x2 - 0.5);
    const words = sceneBoundsAt(scene.pieces.filter((piece) => /^index:1:w\d+$/.test(piece.id)), second.fromMs + 300, fakeMeasure)!;
    expect(second.box.y2 - second.box.y1).toBeGreaterThan(words.y2 - words.y1);
  });

  test("pieces of no cue (Chronicle's timeline) are obstacles of every cue", () => {
    const { cues } = captionSceneDemo("chronicle");
    const { scene, boxes: found } = boxes("chronicle", cues);
    const line = scene.pieces.find((piece) => piece.id === "chronicle:tl:line")!;
    const box = found[1]!;
    const t = box.fromMs + 200;
    const drawn = pieceBounds(line, t, fakeMeasure)!;
    expect(box.obstacles!(t)).toContainEqual(expect.objectContaining({ x1: drawn.x1, y1: drawn.y1, x2: drawn.x2, y2: drawn.y2 }));
  });

  test("a cue drawn only by bleed pieces (Ticker's hero) takes the stretch of canvas they cross", () => {
    const { cues } = captionSceneDemo("ticker");
    const { scene, boxes: found } = boxes("ticker", cues);
    const heroOnly = cues.filter((cue) => scene.pieces.filter((piece) => piece.id.split(":")[1] === String(cue.index)).every((piece) => piece.bleed));
    expect(heroOnly.length).toBeGreaterThan(0);
    for (const cue of heroOnly) {
      const box = found.find((each) => each.cueIndex === cue.index)!;
      expect(box.box.x1).toBeGreaterThanOrEqual(0);
      expect(box.box.x2).toBeLessThanOrEqual(CANVAS.width);
      expect(box.box.x2 - box.box.x1).toBeGreaterThan(CANVAS.width / 2);
    }
  });
});
