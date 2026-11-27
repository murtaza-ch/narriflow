import { describe, expect, spyOn, test } from "bun:test";
import { loadCaptionEmojiArt } from "@narriflow/caption-emoji/art";
import type { CaptionBlockLayout } from "@narriflow/caption-fonts/caption-block";
import * as captionScene from "@narriflow/caption-scene";
import {
  type Measure,
  buildCaptionScene,
  captionEmojiLayerEmojis,
  captionEmojiLayerStyle,
  sceneCuesFromLayers,
  sceneInputFromPreset,
} from "@narriflow/caption-scene";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { CAPTION_CUE_TILTS_DEG, CAPTION_FIT_WIDTH_FRACTION, CAPTION_MOTIONS, type CaptionAnimationName, captionFontFace, captionSceneMeta } from "@narriflow/validators";
import { type CaptionSceneBuildInput, type MeasuredScene, captionSceneInputKey } from "../caption-scene-painter";
import { buildCaptionEmojiLayer, captionEmojiPlanKey, type CaptionEmojiCueSource, type CaptionEmojiLayerPlan } from "./caption-emoji-layer";
import { emojiFixtureLayers } from "./caption-emoji-fixture";
import { classicLineBoxEm, classicLineEmojiCueBox, oneCueSourceKey } from "./cue-emoji-boxes";
import { sceneEmojiCueSource, sceneEmojiGeometry } from "./scene-caption-emojis";
import { createCaptionEmojiArtCache, loadCaptionEmojiArtWithRetry } from "./use-caption-emoji-art";

const fakeMeasure: Measure = (text, _face, sizePx, letterSpacingEm) => ({
  advance: text.length * sizePx * (0.55 + letterSpacingEm),
  inkTop: -sizePx * 0.72,
  inkBottom: sizePx * 0.2,
  ascent: sizePx * 0.95,
  descent: sizePx * 0.25,
});

const sceneInput = (layers: readonly CompositionCaptionVisualLayer[]): CaptionSceneBuildInput => ({
  preset: layers[0]!.preset,
  cues: sceneCuesFromLayers(layers),
  canvas: { width: layers[0]!.destination.width, height: layers[0]!.destination.height },
  anchor: layers[0]!.anchor,
  language: layers[0]!.language,
});

function planOf(layers: readonly CompositionCaptionVisualLayer[], source: CaptionEmojiCueSource): CaptionEmojiLayerPlan {
  const input = sceneInput(layers);
  return {
    source,
    input: { emojis: captionEmojiLayerEmojis(layers), art: new Map(), style: captionEmojiLayerStyle(input.preset), canvas: input.canvas, anchorYPct: input.anchor!.yPct },
  };
}

describe("classic line box (the browser's advance, the faces' line box)", () => {
  const layer = emojiFixtureLayers({ presetId: "bold-pop" }).find((candidate) => candidate.emojis.length > 0)!;
  const face = captionFontFace(layer.preset.fontName);
  const stroke = layer.preset.outlineWidth + (layer.preset.outerOutlineWidth ?? 0);
  const lineHeight = (face.ascent + face.descent) * layer.preset.fontSize;
  const centerX = (layer.anchor.xPct / 100) * 1080;
  const centerY = (layer.anchor.yPct / 100) * 1920;

  test("a line that fits: its advance over the display scale and its face's line box, grown by the outline, centred on the anchor", () => {
    const box = classicLineEmojiCueBox(layer, { width: 150, scale: 0.5 }, face)!;
    expect(box.box.x1).toBeCloseTo(centerX - 150 - stroke, 9);
    expect(box.box.x2).toBeCloseTo(centerX + 150 + stroke, 9);
    expect(box.box.y1).toBeCloseTo(centerY - lineHeight / 2 - stroke, 9);
    expect(box.box.y2).toBeCloseTo(centerY + lineHeight / 2 + stroke, 9);
    expect(box.bodyPx).toBe(layer.preset.fontSize);
    expect(box).toMatchObject({ cueIndex: layer.cueIndex, fromMs: layer.activeRange.startSec * 1000, toMs: layer.activeRange.endSec * 1000, direction: "ltr", tiltDeg: 0 });
  });

  test("the canvas box does not depend on the preview size", () => {
    const small = classicLineEmojiCueBox(layer, { width: 105, scale: 0.35 }, face)!;
    const large = classicLineEmojiCueBox(layer, { width: 300, scale: 1 }, face)!;
    for (const edge of ["x1", "y1", "x2", "y2"] as const) expect(small.box[edge]).toBeCloseTo(large.box[edge], 9);
  });

  test("a line wider than the frame shrinks by the export's fit (`fontSize × fit`), its drawn outline with it", () => {
    const box = classicLineEmojiCueBox(layer, { width: 1400, scale: 1 }, face)!;
    const fit = (CAPTION_FIT_WIDTH_FRACTION * 1080) / (1400 + 2 * stroke);
    expect(fit).toBeLessThan(1);
    expect(box.box.x2 - box.box.x1).toBeCloseTo((1400 + 2 * stroke) * fit, 6);
    expect(box.box.y2 - box.box.y1).toBeCloseTo((lineHeight + 2 * stroke) * fit, 6);
    expect(box.bodyPx).toBeCloseTo(layer.preset.fontSize * fit, 9);
  });

  test("an Urdu line takes Noto Nastaliq Urdu's Win box, as libass lays the line out", () => {
    const rtl = emojiFixtureLayers({ presetId: "bold-pop", rtl: true }).find((candidate) => candidate.emojis.length > 0)!;
    // NotoNastaliqUrdu-Regular.ttf: Win ascent and descent per em (the pinned fallback line boxes).
    const nastaliq = { ascentEm: 1.904, descentEm: 1.382 };
    expect(classicLineBoxEm(rtl.words, face, rtl.language)).toBeCloseTo(nastaliq.ascentEm + nastaliq.descentEm, 9);
    expect(classicLineBoxEm(layer.words, face, layer.language)).toBeCloseTo(face.ascent + face.descent, 9);
    const box = classicLineEmojiCueBox(rtl, { width: 150, scale: 0.5 }, face)!;
    expect(box.direction).toBe("rtl");
    expect(box.box.y2 - box.box.y1).toBeCloseTo((nastaliq.ascentEm + nastaliq.descentEm) * rtl.preset.fontSize + 2 * stroke, 6);
  });

  test("a tilting motion turns the box with the cue's tilt", () => {
    const tilting = Object.entries(CAPTION_MOTIONS).find(([, motion]) => motion.tilt)![0] as CaptionAnimationName;
    const tilted = classicLineEmojiCueBox({ ...layer, preset: { ...layer.preset, animation: tilting } }, { width: 150, scale: 0.5 }, face)!;
    expect(tilted.tiltDeg).toBe(CAPTION_CUE_TILTS_DEG[layer.cueIndex % CAPTION_CUE_TILTS_DEG.length]!);
    expect(tilted.box.x2 - tilted.box.x1).toBeGreaterThan(300 + 2 * stroke);
  });

  test("an unmeasured line has no box, and the source key changes only with the box", () => {
    expect(classicLineEmojiCueBox(layer, { width: 0, scale: 0.5 }, face)).toBeNull();
    const a = classicLineEmojiCueBox(layer, { width: 150, scale: 0.5 }, face)!;
    expect(oneCueSourceKey(a)).toBe(oneCueSourceKey(classicLineEmojiCueBox(layer, { width: 300, scale: 1 }, face)!));
    expect(oneCueSourceKey(a)).not.toBe(oneCueSourceKey(classicLineEmojiCueBox(layer, { width: 151, scale: 0.5 }, face)!));
  });
});

describe("a Dynamic block's source key", () => {
  // Two words of a block and a decoration; the box is the same whatever their onsets, but what reads at a time is not.
  const word = (baselineX: number) => ({
    px: 80, baselineX, baselineY: 1300, centerX: baselineX + 80, centerY: 1280, scaleOriginX: baselineX + 80, scaleOriginY: 1280,
    rotationDeg: 0, motionSign: 1 as const, entranceTimeScale: 1, tile: null, keyframes: [], clusters: null,
  });
  const decoration = (startSec: number) => ({ bounds: { x: 300, y: 1340, width: 400, height: 20 }, startSec }) as unknown as CaptionBlockLayout["decorations"][number];
  const layout = (startSec: number): CaptionBlockLayout =>
    ({ scale: 1, words: [word(300), word(500)], bounds: { x: 200, y: 1100, width: 700, height: 400 }, decorations: [decoration(startSec)], gradient: null, curve: 0, shift: { x: 0, y: 0 } }) as unknown as CaptionBlockLayout;
  const measured = [{ advanceEm: 2, inkTopEm: 0.7, inkBottomEm: 0.2 }, { advanceEm: 2, inkTopEm: 0.7, inkBottomEm: 0.2 }];
  const timing = { cueIndex: 0, fromMs: 1000, toMs: 3000, bodyPx: 80, direction: "ltr" as const };
  const key = (starts: readonly number[], decorationSec = 1) => oneCueSourceKey(captionScene.blockCueBox(layout(decorationSec), measured, timing, starts)!);

  test("changes with a word's onset or a decoration's start, which decide what reads when an emoji pops", () => {
    expect(key([1000, 1080])).toBe(key([1000, 1080]));
    // The second word's onset moves from 80 to 250 ms after the first: the export may place the emoji elsewhere.
    expect(key([1000, 1250])).not.toBe(key([1000, 1080]));
    expect(key([1000, 1080], 1.5)).not.toBe(key([1000, 1080]));
  });
});

describe("memo keys: the emoji layer and the template's scene are built apart", () => {
  const source: CaptionEmojiCueSource = { key: "scene:1", cueBoxes: () => [] };
  const layers = emojiFixtureLayers({ presetId: "lyrics" });

  test("an emoji edit keeps the scene build key and changes the emoji layer's", () => {
    const edited = emojiFixtureLayers({ presetId: "lyrics", emojiIds: ["flame", "crown"] });
    expect(captionSceneInputKey(sceneInput(edited))).toBe(captionSceneInputKey(sceneInput(layers)));
    expect(captionEmojiPlanKey(planOf(edited, source))).not.toBe(captionEmojiPlanKey(planOf(layers, source)));
  });

  test("a palette, size or position change rebuilds only the emoji layer", () => {
    for (const preset of [{ emojiPalette: { a: "#ff0000", b: "#00ff00", c: "#0000ff" } }, { emojiSize: 1.25 as const }, { emojiPosition: "below" as const }, { emojiSticker: false }]) {
      const restyled = emojiFixtureLayers({ presetId: "lyrics", preset });
      expect(captionSceneInputKey(sceneInput(restyled))).toBe(captionSceneInputKey(sceneInput(layers)));
      expect(captionEmojiPlanKey(planOf(restyled, source))).not.toBe(captionEmojiPlanKey(planOf(layers, source)));
    }
  });

  test("a template colour change rebuilds both; equal plans in new objects keep both keys", () => {
    const recoloured = emojiFixtureLayers({ presetId: "lyrics", preset: { highlightColor: "#FF5500" } });
    expect(captionSceneInputKey(sceneInput(recoloured))).not.toBe(captionSceneInputKey(sceneInput(layers)));
    expect(captionEmojiPlanKey(planOf(recoloured, source))).not.toBe(captionEmojiPlanKey(planOf(layers, source)));
    const again = emojiFixtureLayers({ presetId: "lyrics" });
    expect(captionEmojiPlanKey(planOf(again, source))).toBe(captionEmojiPlanKey(planOf(layers, source)));
  });
});

describe("the layer over a built scene", () => {
  test("places the plan's emojis on the scene's cue boxes, with the template's body size and anchor", async () => {
    const layers = emojiFixtureLayers({ presetId: "lyrics" });
    const input = sceneInput(layers);
    const scene = buildCaptionScene(input.preset.scene!, sceneInputFromPreset(input.preset, { cues: input.cues, canvas: input.canvas, measure: fakeMeasure, anchor: input.anchor! }));
    const built: MeasuredScene = { scene, measure: fakeMeasure, language: input.language, input };
    expect(sceneEmojiGeometry(input).scale * captionSceneMeta(input.preset.scene!).bodyPx).toBeCloseTo(input.preset.fontSize, 9);
    expect(sceneEmojiGeometry(input).anchorYPct).toBe(input.anchor!.yPct);
    let boxed = 0;
    const source = sceneEmojiCueSource(built)!;
    const counted: CaptionEmojiCueSource = {
      key: source.key,
      cueBoxes: () => {
        boxed++;
        return source.cueBoxes();
      },
    };
    const emojis = captionEmojiLayerEmojis(layers);
    const art = await loadCaptionEmojiArt(emojis.map((emoji) => emoji.id));
    const plan: CaptionEmojiLayerPlan = { source: counted, input: { emojis, art, style: captionEmojiLayerStyle(input.preset), canvas: input.canvas, anchorYPct: input.anchor!.yPct } };
    expect(boxed).toBe(0);
    const layer = buildCaptionEmojiLayer(plan)!;
    expect(boxed).toBe(1);
    const placed = new Set(layer.scene.pieces.map((piece) => piece.id.split(":").slice(0, 3).join(":")));
    expect(placed.size).toBe(emojis.length);
    expect(layer.scene.pieces.every((piece) => piece.id.startsWith("emoji:") && piece.kind === "shape")).toBe(true);
    // Each emoji shows from its anchor word.
    for (const emoji of emojis) {
      const first = layer.scene.pieces.find((piece) => piece.id.startsWith(`emoji:${emoji.cueIndex}:`))!;
      expect(first.fromMs).toBeGreaterThanOrEqual(emoji.atMs - 1);
    }
  });

  test("an emoji or palette edit places again over the scene's cue boxes without computing them again", async () => {
    const layers = emojiFixtureLayers({ presetId: "lyrics" });
    const input = sceneInput(layers);
    const scene = buildCaptionScene(input.preset.scene!, sceneInputFromPreset(input.preset, { cues: input.cues, canvas: input.canvas, measure: fakeMeasure, anchor: input.anchor! }));
    const built: MeasuredScene = { scene, measure: fakeMeasure, language: input.language, input };
    const emojis = captionEmojiLayerEmojis(layers);
    const art = await loadCaptionEmojiArt(emojis.map((emoji) => emoji.id));
    const style = captionEmojiLayerStyle(input.preset);
    const boxes = spyOn(captionScene, "captionSceneEmojiCueBoxes");
    try {
      const plan = (edit: Partial<CaptionEmojiLayerPlan["input"]>): CaptionEmojiLayerPlan => ({
        source: sceneEmojiCueSource(built)!,
        input: { emojis, art, style, canvas: input.canvas, anchorYPct: input.anchor!.yPct, ...edit },
      });
      const first = buildCaptionEmojiLayer(plan({}))!;
      const fewer = buildCaptionEmojiLayer(plan({ emojis: emojis.slice(1) }))!;
      const recoloured = buildCaptionEmojiLayer(plan({ style: { ...style, palette: { a: "#000000", b: "#ff0000", c: "#ffffff" } } }))!;
      expect(boxes).toHaveBeenCalledTimes(1);
      expect(fewer.scene.pieces.length).toBeLessThan(first.scene.pieces.length);
      expect(recoloured.scene.pieces.length).toBe(first.scene.pieces.length);
      // A rebuilt scene is new: its boxes are computed for it.
      buildCaptionEmojiLayer({ ...plan({}), source: sceneEmojiCueSource({ ...built, scene: buildCaptionScene(input.preset.scene!, sceneInputFromPreset(input.preset, { cues: input.cues, canvas: input.canvas, measure: fakeMeasure, anchor: input.anchor! })) })! });
      expect(boxes).toHaveBeenCalledTimes(2);
    } finally {
      boxes.mockRestore();
    }
  });

  test("the cue source follows the scene object, not the input: a rebuilt scene is a new source", () => {
    const layers = emojiFixtureLayers({ presetId: "lyrics" });
    const input = sceneInput(layers);
    const build = () => buildCaptionScene(input.preset.scene!, sceneInputFromPreset(input.preset, { cues: input.cues, canvas: input.canvas, measure: fakeMeasure }));
    const first: MeasuredScene = { scene: build(), measure: fakeMeasure, language: null, input };
    const second: MeasuredScene = { ...first, scene: build() };
    expect(sceneEmojiCueSource(first)!.key).toBe(sceneEmojiCueSource(first)!.key);
    expect(sceneEmojiCueSource(second)!.key).not.toBe(sceneEmojiCueSource(first)!.key);
    expect(sceneEmojiCueSource({ ...first, input: undefined })).toBeNull();
  });
});

describe("emoji art cache", () => {
  const art = (id: string) => ({ id, layers: [], outline: "" });

  test("each id is requested once: concurrent loads share a request, answered ids are not asked again", async () => {
    const requests: string[][] = [];
    const cache = createCaptionEmojiArtCache(async (ids) => {
      requests.push([...ids]);
      return { art: new Map(ids.filter((id) => id !== "unknown").map((id) => [id, art(id)])), failed: new Set<string>() };
    });
    expect(cache.pending(["flame", "rocket"])).toBe(true);
    await Promise.all([cache.load(["flame", "rocket", "flame"]), cache.load(["rocket", "crown"]), cache.load(["unknown"])]);
    expect(requests).toEqual([["flame", "rocket"], ["crown"], ["unknown"]]);
    await cache.load(["flame", "crown", "unknown"]);
    expect(requests.length).toBe(3);
    expect(cache.pending(["flame", "crown", "unknown"])).toBe(false);
    expect([...cache.artFor(["crown", "unknown", "flame"]).keys()]).toEqual(["crown", "flame"]);
  });

  test("a failed request leaves its ids unanswered, and the next load asks again", async () => {
    let fail = true;
    let calls = 0;
    const cache = createCaptionEmojiArtCache(async (ids) => {
      calls++;
      if (fail) throw new Error("offline");
      return { art: new Map(ids.map((id) => [id, art(id)])), failed: new Set<string>() };
    });
    await cache.load(["flame"]);
    expect(cache.pending(["flame"])).toBe(true);
    fail = false;
    await cache.load(["flame"]);
    expect(calls).toBe(2);
    expect(cache.artFor(["flame"]).has("flame")).toBe(true);
  });

  test("ids whose shard failed stay unanswered and are asked again; the rest are answered", async () => {
    const requests: string[][] = [];
    let shardDown = true;
    const cache = createCaptionEmojiArtCache(async (ids) => {
      requests.push([...ids]);
      const failed = new Set(shardDown ? ids.filter((id) => id === "heart-eyes") : []);
      return { art: new Map(ids.filter((id) => id !== "unknown" && !failed.has(id)).map((id) => [id, art(id)])), failed };
    });
    await cache.load(["rocket", "heart-eyes", "unknown"]);
    expect(cache.pending(["rocket", "unknown"])).toBe(false);
    expect(cache.pending(["heart-eyes"])).toBe(true);
    shardDown = false;
    await cache.load(["rocket", "heart-eyes", "unknown"]);
    expect(requests).toEqual([["rocket", "heart-eyes", "unknown"], ["heart-eyes"]]);
    expect(cache.artFor(["heart-eyes"]).has("heart-eyes")).toBe(true);
  });

  describe("the Studio's load", () => {
    const fakeTimers = () => {
      const pending: { run: () => void; ms: number }[] = [];
      return { pending, timers: { set: (run: () => void, ms: number) => pending.push({ run, ms }), clear: () => pending.splice(0) } };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    test("a failed load is asked once more after a short wait, and then the art draws", async () => {
      let calls = 0;
      const cache = createCaptionEmojiArtCache(async (ids) => {
        calls++;
        if (calls === 1) throw new Error("shard failed");
        return { art: new Map(ids.map((id) => [id, art(id)])), failed: new Set<string>() };
      });
      const { pending, timers } = fakeTimers();
      let answers = 0;
      loadCaptionEmojiArtWithRetry(cache, ["flame"], () => answers++, 3000, timers);
      await settle();
      expect([calls, answers, pending.map((timer) => timer.ms)]).toEqual([1, 1, [3000]]);
      pending.shift()!.run();
      await settle();
      expect([calls, answers, pending.length]).toEqual([2, 2, 0]);
      expect(cache.artFor(["flame"]).has("flame")).toBe(true);
    });

    test("a shard that failed inside a request that settled is asked once more after the wait, and then the art draws", async () => {
      let calls = 0;
      const cache = createCaptionEmojiArtCache(async (ids) => {
        calls++;
        const failed = new Set(calls === 1 ? ids : []);
        return { art: new Map(ids.filter((id) => !failed.has(id)).map((id) => [id, art(id)])), failed };
      });
      const { pending, timers } = fakeTimers();
      loadCaptionEmojiArtWithRetry(cache, ["flame"], () => undefined, 3000, timers);
      await settle();
      expect([calls, pending.length, cache.artFor(["flame"]).size]).toEqual([1, 1, 0]);
      pending.shift()!.run();
      await settle();
      expect([calls, cache.artFor(["flame"]).has("flame")]).toEqual([2, true]);
    });

    test("no retry loop: a load that keeps failing is asked twice; a later mount asks again; a cancelled one never", async () => {
      let calls = 0;
      const cache = createCaptionEmojiArtCache(async () => {
        calls++;
        throw new Error("offline");
      });
      const { pending, timers } = fakeTimers();
      loadCaptionEmojiArtWithRetry(cache, ["flame"], () => undefined, 3000, timers);
      await settle();
      pending.shift()!.run();
      await settle();
      expect([calls, pending.length]).toEqual([2, 0]);
      const cancel = loadCaptionEmojiArtWithRetry(cache, ["flame"], () => undefined, 3000, timers);
      await settle();
      expect(calls).toBe(3);
      cancel();
      expect(pending.length).toBe(0);
    });
  });
});
