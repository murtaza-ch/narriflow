import { describe, expect, test } from "bun:test";
import { CAPTION_SCENE_NAMES, getCaptionPresetById } from "@narriflow/validators";
import { SCENE_CUE_MIN_LAST_WORD_MS, SCENE_CUE_TAIL_MS, type SceneLayerLike, sceneCuesFromLayers } from "./cues";
import type { SceneCue } from "./input";
import { memoMeasure } from "./measure-memo";
import { livePieceIndexes, pieceIndexesBetween } from "./piece-index";
import { buildCaptionScene, drawableCues, sceneBuildKey, sceneInputFromPreset } from "./registry";
import { type Box, type Piece, evaluatePiece, pieceBounds, sceneBoundsAt, visiblePieces } from "./scene";
import { fakeMeasure } from "./test-support";

const CANVAS = { width: 1080, height: 1920 };

function layer(cueIndex: number, startSec: number, wordCount: number, opts: { wordSec?: number; speaker?: number | null; endSec?: number } = {}): SceneLayerLike {
  const wordSec = opts.wordSec ?? 0.4;
  const words = Array.from({ length: wordCount }, (_, at) => ({ text: `word${cueIndex}${at}`, startSec: startSec + at * wordSec, endSec: startSec + (at + 1) * wordSec }));
  return {
    activeRange: { startSec, endSec: opts.endSec ?? words[wordCount - 1]!.endSec },
    cueIndex,
    language: "en",
    words,
    scene: { roles: words.map((_, at) => (at === wordCount - 1 ? "hero" : "body")), keys: words.map((_, at) => `k${cueIndex}${at}`), speaker: opts.speaker ?? cueIndex % 2 },
  };
}

describe("overlapping cues leave when the next one starts (fix 4)", () => {
  test("a cue whose next one starts before its last word ends leaves at that start", () => {
    // Cue 0: three words 1.0-2.2 s (last word 1.8-2.2); cue 1 starts at 1.9 s.
    const cues = sceneCuesFromLayers([layer(0, 1, 3), layer(1, 1.9, 3)]);
    expect(cues[0]!.endMs).toBe(1900);
    expect(cues[1]!.startMs).toBe(1900);
  });

  test("it never leaves before its own last word has started and read for a moment", () => {
    // Cue 1 starts at 1.2 s, before cue 0's last word (1.8 s) starts.
    const cues = sceneCuesFromLayers([layer(0, 1, 3), layer(1, 1.2, 3)]);
    expect(cues[0]!.endMs).toBe(1800 + SCENE_CUE_MIN_LAST_WORD_MS);
  });

  test("cues that do not overlap keep their ends: the next start, or the tail after a long pause", () => {
    const touching = sceneCuesFromLayers([layer(0, 1, 3), layer(1, 2.2, 3)]);
    expect(touching[0]!.endMs).toBe(2200);
    const gap = sceneCuesFromLayers([layer(0, 1, 3), layer(1, 5, 3)]);
    expect(gap[0]!.endMs).toBe(2200 + SCENE_CUE_TAIL_MS);
    const near = sceneCuesFromLayers([layer(0, 1, 3), layer(1, 2.5, 3)]);
    expect(near[0]!.endMs).toBe(2500);
    expect(sceneCuesFromLayers([layer(0, 1, 3)])[0]!.endMs).toBe(2200 + SCENE_CUE_TAIL_MS);
  });

  const area = (box: Box) => Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
  const intersection = (a: Box, b: Box) => area({ x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) });
  const union = (boxes: Box[]): Box | null =>
    boxes.length === 0 ? null : boxes.reduce((a, b) => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) }));

  test.each([...CAPTION_SCENE_NAMES])("%s: with two overlapping cues, the first is not drawn over the second once the second is in", (name) => {
    const preset = getCaptionPresetById(name)!.preset;
    const wordsPerCue = Math.min(preset.wordsPerCue, 3);
    // Cue 1 starts 400 ms before cue 0's last word ends, 100 ms after that word started.
    const first = layer(0, 1, wordsPerCue, { wordSec: 0.5 });
    const second = layer(1, first.activeRange.endSec - 0.4, wordsPerCue, { wordSec: 0.5 });
    const cues = sceneCuesFromLayers([first, second]);
    const scene = buildCaptionScene(name, sceneInputFromPreset(preset, { cues, canvas: CANVAS, measure: fakeMeasure }));
    const cueOf = (piece: Piece) => piece.id.split(":")[1]!;
    const enters = cues[1]!.startMs;
    // From just after the second cue starts (its entrance is under way) and for a while after: the first cue's pieces are gone or apart.
    for (let t = enters + 60; t < enters + 1500; t += 20) {
      const bounds = new Map<string, Box[]>();
      for (const piece of scene.pieces) {
        // Index's card is one object for a whole run of cues (it morphs from cue to cue), named after the run's first cue.
        if (piece.bleed || !/^\d+$/.test(cueOf(piece)) || piece.id.includes(":card:")) continue;
        const box = pieceBounds(piece, t, fakeMeasure);
        if (box) bounds.set(cueOf(piece), [...(bounds.get(cueOf(piece)) ?? []), box]);
      }
      const a = union(bounds.get("0") ?? []);
      const b = union(bounds.get("1") ?? []);
      if (!a || !b) continue;
      expect(intersection(a, b) / Math.min(area(a), area(b))).toBeLessThan(0.05);
    }
  });
});

describe("the piece index answers 'what is live now' without walking every piece (fix 2)", () => {
  const pieces = Array.from({ length: 3000 }, (_, at): Piece => ({
    kind: "shape",
    id: `t:${at}:p`,
    z: at % 5,
    fromMs: at * 60,
    toMs: at * 60 + 900,
    track: { x: [[0, at]], y: [[0, 0]] },
    path: [["M", 0, 0], ["L", 10, 0], ["L", 10, 10], ["Z"]],
    fill: { colour: "#FFFFFF" },
  }));
  // One persistent piece, as Index's dial: it outlives every bucket.
  pieces.push({ ...pieces[0]!, id: "t:dial:p", fromMs: 0, toMs: 400_000 });

  test("the live pieces equal a full scan at every probe, including the window edges", () => {
    for (const ms of [-5, 0, 59, 60, 899, 900, 901, 123_456, 179_999, 180_000, 180_899, 180_900, 400_000, 500_000]) {
      const scan = pieces.flatMap((piece, at) => (ms >= piece.fromMs && ms < piece.toMs ? [at] : []));
      expect(livePieceIndexes(pieces, ms).sort((a, b) => a - b)).toEqual(scan);
    }
  });

  test("a probe touches only the pieces near it, not all of them", () => {
    // 3 seconds around a time in the middle: a few dozen of 3001.
    const near = pieceIndexesBetween(pieces, 90_000, 93_000);
    expect(near.length).toBeLessThan(100);
    const scan = pieces.flatMap((piece, at) => (piece.fromMs < 93_000 && piece.toMs > 90_000 ? [at] : []));
    expect(near).toEqual(scan);
  });

  test("an array that grows is indexed again", () => {
    const grown = pieces.slice(0, 10);
    expect(livePieceIndexes(grown, 100)).toHaveLength(2);
    grown.push({ ...pieces[0]!, id: "t:new:p", fromMs: 50, toMs: 200 });
    expect(livePieceIndexes(grown, 100)).toHaveLength(3);
  });

  test("scene bounds and visible pieces agree with a scan on a built 3-minute scene", () => {
    const preset = getCaptionPresetById("wordform")!.preset;
    const cues: SceneCue[] = Array.from({ length: 40 }, (_, at) => ({
      index: at,
      startMs: 500 + at * 1700,
      endMs: 500 + at * 1700 + 1600,
      speaker: null,
      language: "en",
      words: Array.from({ length: 4 }, (_, w) => ({ text: `word${at}${w}`, startMs: 500 + at * 1700 + w * 400, endMs: 500 + at * 1700 + w * 400 + 380, role: w === 3 ? "hero" : "body", key: null })),
    }));
    const scene = buildCaptionScene("wordform", sceneInputFromPreset(preset, { cues, canvas: CANVAS, measure: fakeMeasure }));
    for (const ms of [0, 800, 1500, 20_000, 33_333, 60_000]) {
      const scan = scene.pieces.filter((piece) => ms >= piece.fromMs && ms < piece.toMs);
      expect(visiblePieces(scene, ms).sort((a, b) => scene.pieces.indexOf(a) - scene.pieces.indexOf(b))).toEqual(scan);
      let box: Box | null = null;
      for (const piece of scan) {
        if (piece.bleed) continue;
        const own = pieceBounds(piece, ms, fakeMeasure);
        if (own) box = box ? { x1: Math.min(box.x1, own.x1), y1: Math.min(box.y1, own.y1), x2: Math.max(box.x2, own.x2), y2: Math.max(box.y2, own.y2) } : own;
      }
      expect(sceneBoundsAt(scene.pieces, ms, fakeMeasure)).toEqual(box);
    }
  });
});

describe("a build asks the renderer to measure each text once (fix 1)", () => {
  test("memoMeasure calls the measure once per (text, face, size, spacing)", () => {
    let calls = 0;
    const measure = memoMeasure((text, face, sizePx, spacing) => {
      calls++;
      return fakeMeasure(text, face, sizePx, spacing);
    });
    for (let round = 0; round < 50; round++) {
      measure("hello", "Anton", 100, 0);
      measure("hello", "Anton", 101, 0);
      measure("hello", "Inter-ExtraBold" as never, 100, 0);
      measure("hello", "Anton", 100, 0.02);
      measure("world", "Anton", 100, 0);
    }
    expect(calls).toBe(5);
    expect(measure("hello", "Anton", 100, 0)).toEqual(fakeMeasure("hello", "Anton", 100, 0));
  });

  test("a 3-minute Lyrics build measures each distinct text once, not 190 000 times", () => {
    const preset = getCaptionPresetById("lyrics")!.preset;
    const wordsPerCue = preset.wordsPerCue;
    let t = 500;
    const cues: SceneCue[] = Array.from({ length: Math.ceil(450 / wordsPerCue) }, (_, index) => {
      const startMs = t;
      const words = Array.from({ length: wordsPerCue }, (_, w) => {
        const word = { text: `word${index}${w}`, startMs: t, endMs: t + 350, role: w === wordsPerCue - 1 ? ("hero" as const) : ("body" as const), key: null };
        t += 350;
        return word;
      });
      t += 100;
      return { index, startMs, endMs: t, speaker: null, language: "en", words };
    });
    const calls = new Map<string, number>();
    const measure: typeof fakeMeasure = (text, face, sizePx, spacing) => {
      const key = `${face}|${sizePx}|${spacing}|${text}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return fakeMeasure(text, face, sizePx, spacing);
    };
    buildCaptionScene("lyrics", sceneInputFromPreset(preset, { cues, canvas: CANVAS, measure }));
    expect(Math.max(...calls.values())).toBe(1);
    expect(calls.size).toBeGreaterThan(400);
  });
});

describe("a scene is rebuilt when what it reads changes, and only then (fix 1)", () => {
  const preset = getCaptionPresetById("reveal")!.preset;
  const cues = sceneCuesFromLayers([layer(0, 1, 3), layer(1, 2.4, 3)]);
  const key = (overrides: { cues?: readonly SceneCue[]; preset?: typeof preset; language?: string | null; canvas?: { width: number; height: number } } = {}) => {
    const p = overrides.preset ?? preset;
    return sceneBuildKey("reveal", sceneInputFromPreset(p, { cues: overrides.cues ?? cues, canvas: overrides.canvas ?? CANVAS, measure: fakeMeasure }), overrides.language ?? "en");
  };

  test("equal content is one key, whatever the object identities", () => {
    const again = sceneCuesFromLayers([layer(0, 1, 3), layer(1, 2.4, 3)]);
    expect(again).not.toBe(cues);
    expect(key({ cues: again, preset: { ...preset } })).toBe(key());
  });

  test("a preset field the template does not read leaves the key alone", () => {
    expect(key({ preset: { ...preset, volume: 0.2 } as typeof preset, canvas: { ...CANVAS } })).toBe(key());
    expect(key({ preset: { ...preset, animation: "none" } as typeof preset })).toBe(key());
  });

  test("each thing it reads changes the key", () => {
    const base = key();
    expect(key({ preset: { ...preset, primaryColor: "#123456" } })).not.toBe(base);
    expect(key({ preset: { ...preset, highlightColor: "#123456" } })).not.toBe(base);
    expect(key({ preset: { ...preset, shadowColor: "#123456" } })).not.toBe(base);
    expect(key({ preset: { ...preset, fontSize: preset.fontSize + 10 } })).not.toBe(base);
    expect(key({ preset: { ...preset, positionY: 40 } })).not.toBe(base);
    expect(key({ preset: { ...preset, positionX: 30 } })).not.toBe(base);
    expect(key({ canvas: { width: 1920, height: 1080 } })).not.toBe(base);
    expect(key({ language: "ur" })).not.toBe(base);
    const edited = cues.map((cue, at) => (at === 1 ? { ...cue, words: cue.words.map((word, w) => (w === 0 ? { ...word, text: "edited" } : word)) } : cue));
    expect(key({ cues: edited })).not.toBe(base);
    const retimed = cues.map((cue, at) => (at === 1 ? { ...cue, startMs: cue.startMs + 10 } : cue));
    expect(key({ cues: retimed })).not.toBe(base);
    const reroled = cues.map((cue, at) => (at === 0 ? { ...cue, words: cue.words.map((word, w) => (w === 0 ? { ...word, role: "hero" as const } : word)) } : cue));
    expect(key({ cues: reroled })).not.toBe(base);
    const respoken = cues.map((cue, at) => (at === 0 ? { ...cue, speaker: 5 } : cue));
    expect(key({ cues: respoken })).not.toBe(base);
  });
});

describe("a program never sees an empty cue or word (fix 7)", () => {
  const cue = (index: number, texts: string[]): SceneCue => ({
    index,
    startMs: 1000 + index * 2000,
    endMs: 2800 + index * 2000,
    speaker: null,
    language: "en",
    words: texts.map((text, at) => ({ text, startMs: 1000 + index * 2000 + at * 400, endMs: 1000 + index * 2000 + at * 400 + 380, role: at === texts.length - 1 ? ("hero" as const) : ("body" as const), key: null })),
  });

  test("drawableCues drops empty words and cues without words, and keeps the rest as they were", () => {
    const whole = cue(1, ["one", "two"]);
    const result = drawableCues([cue(0, []), whole, cue(2, ["", "  "]), cue(3, ["a", "", "b"])]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(whole);
    expect(result[1]!.words.map((word) => word.text)).toEqual(["a", "b"]);
  });

  test.each([...CAPTION_SCENE_NAMES])("%s: empty words and cues build without throwing or writing NaN", (name) => {
    const preset = getCaptionPresetById(name)!.preset;
    const cues = [cue(0, ["", "hello", "", "there"]), cue(1, []), cue(2, ["", ""]), cue(3, ["fine", "words", "here"]), cue(4, [""])];
    const scene = buildCaptionScene(name, sceneInputFromPreset(preset, { cues, canvas: CANVAS, measure: fakeMeasure }));
    expect(scene.pieces.length).toBeGreaterThan(0);
    for (const piece of scene.pieces) {
      for (const ms of [piece.fromMs, (piece.fromMs + piece.toMs) / 2, piece.toMs - 1]) {
        const pose = evaluatePiece(piece, ms);
        for (const value of [pose.x, pose.y, pose.sx, pose.sy, pose.rz, pose.o, pose.blur]) expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  test.each([...CAPTION_SCENE_NAMES])("%s: a scene with only empty cues is an empty scene", (name) => {
    const preset = getCaptionPresetById(name)!.preset;
    const scene = buildCaptionScene(name, sceneInputFromPreset(preset, { cues: [cue(0, []), cue(1, ["", " "])], canvas: CANVAS, measure: fakeMeasure }));
    expect(scene.pieces).toHaveLength(0);
  });
});
