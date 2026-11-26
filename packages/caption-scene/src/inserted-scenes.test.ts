import { describe, expect, test } from "bun:test";
import { type CaptionSceneName, captionSceneMeta, getCaptionPresetById } from "@narriflow/validators";
import { type SceneLayerLike, sceneCuesFromLayers } from "./cues";
import { sceneCueBoxes } from "./emoji/scene-cue-boxes";
import { cutAtInsertedScenes } from "./inserted-scenes";
import { buildCaptionScene, sceneBuildKey, sceneInputFromPreset } from "./registry";
import { type Piece, type ShapePiece, evaluatePiece } from "./scene";
import { fakeMeasure } from "./test-support";

const CANVAS = { width: 1080, height: 1920 };
const WORDS = ["the", "biggest", "mistake", "people", "make", "is", "waiting", "until", "they", "feel", "ready", "today"];
const SCENE_SEC = 2;

/**
 * The target's caption layers as the plan makes them around a Scene Block inserted at `anchorSec` (edited time): 4 words a
 * cue, every 0.4 s from 0.2 s; a cue the scene falls inside becomes two cues, a word it splits keeps its own part on each
 * side, and everything after the anchor moves later by the scene's length (`captionCueSlice`).
 */
function layersAround(anchorSec: number): SceneLayerLike[] {
  const words = WORDS.map((text, index) => ({ text, startSec: 0.2 + index * 0.4, endSec: 0.55 + index * 0.4 }));
  const layers: SceneLayerLike[] = [];
  for (let at = 0; at < words.length; at += 4) {
    const cue = words.slice(at, at + 4);
    for (const [from, to, shift] of [[0, anchorSec, 0], [anchorSec, Number.POSITIVE_INFINITY, SCENE_SEC]] as const) {
      const side = cue
        .filter((word) => word.endSec > from && word.startSec < to)
        .map((word) => ({ text: word.text, startSec: Math.max(word.startSec, from) + shift, endSec: Math.min(word.endSec, to) + shift }));
      if (side.length === 0) continue;
      layers.push({
        activeRange: { startSec: side[0]!.startSec, endSec: side[side.length - 1]!.endSec },
        cueIndex: layers.length,
        language: "en",
        words: side,
        scene: { roles: side.map((_, index) => (index === 1 ? "hero" : "body")), keys: side.map((word) => String(Math.round(word.startSec * 1000))), speaker: 0 },
      });
    }
  }
  return layers;
}

function build(name: CaptionSceneName, anchorSec: number, cut: boolean) {
  const insertedScenes = cut ? [{ startSec: anchorSec, endSec: anchorSec + SCENE_SEC }] : [];
  const input = sceneInputFromPreset(getCaptionPresetById(name)!.preset, { cues: sceneCuesFromLayers(layersAround(anchorSec)), canvas: CANVAS, measure: fakeMeasure, insertedScenes });
  return { input, scene: buildCaptionScene(name, input) };
}

const baseId = (piece: Piece) => piece.id.replace(/#\d+$/, "");
const posesAt = (pieces: readonly Piece[], ms: number) =>
  pieces.flatMap((piece) => {
    const pose = evaluatePiece(piece, ms);
    return pose.visible ? [[baseId(piece), pose] as const] : [];
  }).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

describe("cutAtInsertedScenes", () => {
  const piece = (id: string, fromMs: number, toMs: number): ShapePiece => ({ id, kind: "shape", z: 0, fromMs, toMs, track: { x: [[0, 0], [10_000, 1000]] }, path: [["M", 0, 0], ["L", 1, 1]] });
  const windows = [{ fromMs: 1000, toMs: 2000 }, { fromMs: 3000, toMs: 3500 }];

  test("a piece stops at a window and starts again after it; the later part takes `#n`, in the piece's place", () => {
    const pieces = [piece("lyrics:0:w0", 500, 4000), piece("lyrics:1:w0", 1200, 1800), piece("lyrics:1:w1", 1500, 2500), piece("dial", 0, 800)];
    expect(cutAtInsertedScenes(pieces, windows).map((cut) => [cut.id, cut.fromMs, cut.toMs])).toEqual([
      ["lyrics:0:w0", 500, 1000], ["lyrics:0:w0#1", 2000, 3000], ["lyrics:0:w0#2", 3500, 4000],
      ["lyrics:1:w1", 2000, 2500],
      ["dial", 0, 800],
    ]);
  });

  test("a piece no window touches is the same object, and no windows leaves the array as it is", () => {
    const pieces = [piece("a", 0, 1000), piece("b", 2000, 3000)];
    const cut = cutAtInsertedScenes(pieces, windows);
    expect(cut[0]).toBe(pieces[0]!);
    expect(cut[1]).toBe(pieces[1]!);
    expect(cutAtInsertedScenes(pieces, [])).toBe(pieces);
  });
});

describe("no Scene Style piece paints inside an inserted scene", () => {
  for (const name of ["reveal", "lyrics", "horizon", "dialogue"] as const) {
    // 1.7 s falls inside "people" (1.4-1.75 s), so the first cue splits; 1.8 s is between the first two cues.
    for (const [where, anchorSec] of [["inside a cue", 1.7], ["between cues", 1.8]] as const) {
      test(`${name}, a scene ${where}`, () => {
        const fromMs = anchorSec * 1000;
        const toMs = fromMs + SCENE_SEC * 1000;
        const whole = build(name, anchorSec, false).scene;
        const { input, scene } = build(name, anchorSec, true);
        expect(input.insertedScenes).toEqual([{ fromMs, toMs }]);
        expect(scene.insertedScenes).toEqual([{ fromMs, toMs }]);
        // The uncut program draws into the scene: that is what is cut.
        expect(whole.pieces.some((piece) => piece.fromMs < toMs && piece.toMs > fromMs)).toBe(true);
        expect(scene.pieces.filter((piece) => piece.fromMs < toMs && piece.toMs > fromMs)).toEqual([]);
        // Ids stay unique and keep their cue segment (the emoji layer's and the Studio mount's keys).
        expect(new Set(scene.pieces.map((piece) => piece.id)).size).toBe(scene.pieces.length);
        const wholeIds = new Set(whole.pieces.map((piece) => piece.id));
        expect(scene.pieces.every((piece) => wholeIds.has(baseId(piece)))).toBe(true);
        // At every instant outside the scene the cut scene draws exactly what the program drew.
        const endMs = Math.max(...whole.pieces.map((piece) => piece.toMs));
        for (let ms = 0; ms < endMs; ms += 20) {
          if (ms >= fromMs && ms < toMs) continue;
          expect(posesAt(scene.pieces, ms)).toEqual(posesAt(whole.pieces, ms));
        }
        // The emoji layer's cue windows come from the cut scene and stay on their side of it too.
        const boxes = sceneCueBoxes(scene, input.cues, { measure: fakeMeasure, canvas: CANVAS, bodyPx: captionSceneMeta(name).bodyPx * input.scale, direction: () => "ltr" });
        expect(boxes.length).toBeGreaterThan(0);
        expect(boxes.filter((box) => box.fromMs < toMs && box.toMs > fromMs).map((box) => [box.cueIndex, box.fromMs, box.toMs])).toEqual([]);
      });
    }
  }
});

describe("a clip without inserted scenes builds the scene it built before", () => {
  test("an empty list sets nothing on the input, so the build and its key are unchanged", () => {
    const preset = getCaptionPresetById("lyrics")!.preset;
    const cues = sceneCuesFromLayers(layersAround(1.8));
    const plain = sceneInputFromPreset(preset, { cues, canvas: CANVAS, measure: fakeMeasure });
    const empty = sceneInputFromPreset(preset, { cues, canvas: CANVAS, measure: fakeMeasure, insertedScenes: [] });
    expect(empty).toEqual(plain);
    expect("insertedScenes" in empty).toBe(false);
    expect(sceneBuildKey("lyrics", empty, "en")).toBe(sceneBuildKey("lyrics", plain, "en"));
    expect(buildCaptionScene("lyrics", empty)).toEqual(buildCaptionScene("lyrics", plain));
    expect("insertedScenes" in buildCaptionScene("lyrics", empty)).toBe(false);
  });

  test("the key changes with the inserted scenes, so a renderer rebuilds when one moves", () => {
    const preset = getCaptionPresetById("lyrics")!.preset;
    const cues = sceneCuesFromLayers(layersAround(1.8));
    const at = (startSec: number) => sceneBuildKey("lyrics", sceneInputFromPreset(preset, { cues, canvas: CANVAS, measure: fakeMeasure, insertedScenes: [{ startSec, endSec: startSec + 2 }] }), "en");
    expect(at(1.8)).toBe(at(1.8));
    expect(at(1.8)).not.toBe(at(1.9));
    expect(at(1.8)).not.toBe(sceneBuildKey("lyrics", sceneInputFromPreset(preset, { cues, canvas: CANVAS, measure: fakeMeasure }), "en"));
  });
});
