import { describe, expect, test } from "bun:test";
import { type Measure, type SceneCue, SCENE_PERSPECTIVE_PX, buildCaptionScene, sceneInputFromPreset } from "@narriflow/caption-scene";
import { getCaptionPresetById } from "@narriflow/validators";
import { captionSceneInputKey, mountWindowStart, mountedPieceIndexes, sceneClipPath, sceneTransform, stableByKey } from "./caption-scene-painter";

const rest = { x: 100, y: 200, sx: 1, sy: 1, rz: 0, rx: 0, ry: 0, skx: 0 };

describe("scene transform (the sample player's pose() order about the pivot)", () => {
  test("a resting piece only translates", () => {
    expect(sceneTransform(rest, 0.5)).toBe("translate(50px, 100px)");
  });

  test("scale, shear, turn, tilt in the order the player applies them: scale first, then shear, Z, Y, X with perspective", () => {
    const transform = sceneTransform({ ...rest, sx: 1.5, sy: 0.7, rz: 20, rx: 30, ry: 10, skx: 12 }, 1);
    expect(transform).toBe(`translate(100px, 200px) perspective(${SCENE_PERSPECTIVE_PX}px) rotateX(30deg) rotateY(10deg) rotate(20deg) skewX(12deg) scale(1.5, 0.7)`);
  });

  test("perspective scales with the display, and only appears when a piece tilts", () => {
    expect(sceneTransform({ ...rest, rx: 40 }, 0.5)).toContain(`perspective(${SCENE_PERSPECTIVE_PX * 0.5}px)`);
    expect(sceneTransform({ ...rest, rz: 5 }, 1)).not.toContain("perspective");
  });

  test("the camera is the one measured against libass", () => {
    expect(SCENE_PERSPECTIVE_PX).toBe(326);
  });
});

describe("scene clip (canvas px, not carried by the piece)", () => {
  const canvas = { width: 1080, height: 1920 };
  test("a rectangle becomes an inset of the full-canvas wrapper", () => {
    expect(sceneClipPath({ x1: 100, y1: 200, x2: 400, y2: 300, inverse: false }, canvas, 0.5)).toBe("inset(100px 340px 810px 50px)");
  });

  test("a reversed rectangle is normalised, an inverse clip keeps the outside", () => {
    expect(sceneClipPath({ x1: 400, y1: 300, x2: 100, y2: 200, inverse: false }, canvas, 1)).toBe("inset(200px 680px 1620px 100px)");
    expect(sceneClipPath({ x1: 100, y1: 200, x2: 400, y2: 300, inverse: true }, canvas, 1)).toContain("polygon(evenodd");
  });
});

const fakeMeasure: Measure = (text, _face, sizePx, letterSpacingEm) => ({
  advance: [...text].length * (0.55 + letterSpacingEm) * sizePx,
  inkTop: -0.72 * sizePx,
  inkBottom: 0.2 * sizePx,
  ascent: 1.1 * sizePx,
  descent: 0.3 * sizePx,
});

function cues(count: number, wordsPerCue: number): SceneCue[] {
  let t = 500;
  return Array.from({ length: count }, (_, index) => {
    const startMs = t;
    const words = Array.from({ length: wordsPerCue }, (_, at) => {
      const word = { text: `word${index}${at}`, startMs: t, endMs: t + 350, role: at === wordsPerCue - 1 ? ("hero" as const) : ("body" as const), key: `k${index}${at}` };
      t += 350;
      return word;
    });
    t += 100;
    return { index, startMs, endMs: t, speaker: index % 2, language: "en", words };
  });
}

describe("the scene is rebuilt when what it is built from changes, not when the editor hands over equal objects (fix 1)", () => {
  const preset = getCaptionPresetById("lyrics")!.preset;
  const input = () => ({ preset: { ...preset }, cues: cues(6, 5).map((cue) => ({ ...cue, words: cue.words.map((word) => ({ ...word })) })), canvas: { width: 1080, height: 1920 }, anchor: { xPct: 50, yPct: 64 }, language: "en" });

  test("the same content in new objects has the same key, and the stabiliser keeps the first input", () => {
    const first = input();
    const key = captionSceneInputKey(first);
    expect(key).not.toBeNull();
    const kept = stableByKey(null, key, first)!;
    // The editor derives fresh layer objects after a volume change or a logo drag: same cues, new identities.
    const again = input();
    expect(again).not.toBe(first);
    expect(stableByKey(kept, captionSceneInputKey(again), again)).toBe(kept);
    expect(kept.value).toBe(first);
  });

  test("fields the template does not read leave the key alone, the ones it reads change it", () => {
    const base = input();
    const key = captionSceneInputKey(base);
    expect(captionSceneInputKey({ ...base, preset: { ...base.preset, punctuation: false, outlineWidth: 4, emojis: true, animation: "none" } })).toBe(key);
    expect(captionSceneInputKey({ ...base, preset: { ...base.preset, primaryColor: "#123456" } })).not.toBe(key);
    expect(captionSceneInputKey({ ...base, preset: { ...base.preset, fontSize: base.preset.fontSize + 8 } })).not.toBe(key);
    expect(captionSceneInputKey({ ...base, anchor: { xPct: 50, yPct: 40 } })).not.toBe(key);
    expect(captionSceneInputKey({ ...base, canvas: { width: 1920, height: 1080 } })).not.toBe(key);
    const edited = { ...base, cues: base.cues.map((cue, at) => (at === 2 ? { ...cue, words: cue.words.map((word, w) => (w === 1 ? { ...word, text: "changed" } : word)) } : cue)) };
    const next = captionSceneInputKey(edited);
    expect(next).not.toBe(key);
    expect(stableByKey(stableByKey(null, key, base), next, edited)!.value).toBe(edited);
  });

  test("a preset that is not a Scene Style has no key", () => {
    expect(captionSceneInputKey({ ...input(), preset: getCaptionPresetById("headline")!.preset })).toBeNull();
    expect(stableByKey(null, null, input())).toBeNull();
  });
});

describe("only the pieces near the playhead are mounted, and the frame at the playhead is always among them (fix 2)", () => {
  const preset = getCaptionPresetById("wordform")!.preset;
  const scene = buildCaptionScene("wordform", sceneInputFromPreset(preset, { cues: cues(113, 4), canvas: { width: 1080, height: 1920 }, measure: fakeMeasure }));

  test("the window moves in steps of two seconds", () => {
    expect(mountWindowStart(0)).toBe(0);
    expect(mountWindowStart(1999)).toBe(0);
    expect(mountWindowStart(2000)).toBe(2000);
    expect(mountWindowStart(-1)).toBe(-2000);
  });

  test("every piece live at any time of a window is mounted for it, and a window holds a small part of a 3-minute scene", () => {
    expect(scene.pieces.length).toBeGreaterThan(3000);
    let mostMounted = 0;
    for (const ms of [0, 1234, 1999, 2000, 17_500, 59_999, 90_001, 150_000, 179_000, 400_000]) {
      const mounted = new Set(mountedPieceIndexes(scene.pieces, mountWindowStart(ms)));
      mostMounted = Math.max(mostMounted, mounted.size);
      scene.pieces.forEach((piece, at) => {
        if (ms >= piece.fromMs && ms < piece.toMs) expect(mounted.has(at)).toBe(true);
      });
    }
    // A seek lands in a window that holds the frame: nothing is missing, and almost nothing else is mounted.
    expect(mostMounted).toBeLessThan(scene.pieces.length * 0.12);
  });
});
