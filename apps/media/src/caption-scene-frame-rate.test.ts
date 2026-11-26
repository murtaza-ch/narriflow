import { describe, expect, test } from "bun:test";
import { loadCaptionEmojiArt } from "@narriflow/caption-emoji/art";
import {
  buildCaptionScene,
  captionEmojiLayerEmojis,
  captionEmojiLayerStyle,
  captionSceneEmojiCueBoxes,
  placeCaptionEmojis,
  sceneBuildKey,
  sceneCuesFromLayers,
  sceneInputFromPreset,
} from "@narriflow/caption-scene";
import { type CompositionCaptionVisualLayer, planClipComposition } from "@narriflow/composition-plan";
import { captionPresetSchema, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { compileCompositionPlanCaptions } from "./composition-ffmpeg-adapter";
import { SceneMeasurer, sceneInputForLayers } from "./caption-scene-ass";

/**
 * Scene Styles plan by painted frames (`frame-grid.ts`), so a scene's layout depends on the render's rate. The Studio builds
 * with the clip's `renderFrameRate` as the worker builds with the render's: the same input, the same scene and the same emoji
 * places at every rate. The Studio's side is written as its painter (`buildScene`, `captionSceneInputKey`) and emoji layer
 * (`sceneEmojiCueSource`, `CaptionEmojiLayer`) call the shared code; the web tests pin those calls.
 */

const CANVAS = { width: 540, height: 960 };
const RATES = [24, 25, 30, 50, 60] as const;
const WORDS = ["you", "won't", "believe", "what", "happened", "one", "short", "sentence", "here", "to", "test", "next", "line"];

/** The reviewer's reproduction: words from 0.31 s every `stepSec`, four per cue, a flame on "believe" (or on word `flameOn`). */
function planFor(presetId: string, stepSec: number, flameOn = 2) {
  const words = WORDS.map((word, index) => ({ word, startSec: 0.31 + index * stepSec, endSec: 0.31 + index * stepSec + stepSec * 0.89, confidence: 1 }));
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 6,
    captionPreset: captionPresetSchema.parse({ ...getCaptionPresetById(presetId)!.preset, wordsPerCue: 4, emojis: true }),
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "A", startSec: 0.31, endSec: words.at(-1)!.endSec, text: WORDS.join(" "), confidence: 1, words }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis: { [String(Math.round(words[flameOn]!.startSec * 1000))]: { id: "flame" } } }),
    brollUrl: null,
    deletedRanges: [],
  });
  const result = planClipComposition({
    document,
    captionLanguage: "en",
    source: { identity: "frame-rate", kind: "video", width: 1280, height: 720 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: CANVAS.width, height: CANVAS.height }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

function sceneLayers(presetId: string, stepSec: number): CompositionCaptionVisualLayer[] {
  return planFor(presetId, stepSec).targets[0]!.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption");
}

const measurer = () => new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), "en");

/** What the Studio's painter hands `sceneInputFromPreset` for these layers at the clip's rate. */
function studioInput(layers: readonly CompositionCaptionVisualLayer[], fps: number, measure = measurer().measure) {
  const first = layers[0]!;
  return sceneInputFromPreset(first.preset, { cues: sceneCuesFromLayers(layers), canvas: CANVAS, measure, anchor: first.anchor, fps });
}

describe("the Studio and the worker build one scene at every frame rate", () => {
  test.each(["trail", "lyrics", "horizon", "flap", "vibes", "glint", "cascade"])("%s: equal inputs, keys and scenes at 24, 25, 30, 50 and 60 fps", (presetId) => {
    for (const stepSec of [0.12, 0.4]) {
      const layers = sceneLayers(presetId, stepSec);
      for (const fps of RATES) {
        const measure = measurer().measure;
        const worker = sceneInputForLayers(layers, CANVAS, measure, fps);
        const studio = studioInput(layers, fps, measure);
        const { measure: _w, ...workerInput } = worker.input;
        const { measure: _s, ...studioRest } = studio;
        expect(studioRest).toEqual(workerInput);
        expect(studio.fps).toBe(fps);
        expect(sceneBuildKey(worker.name, studio, "en")).toBe(sceneBuildKey(worker.name, worker.input, "en"));
        expect(JSON.stringify(buildCaptionScene(worker.name, studio))).toBe(JSON.stringify(buildCaptionScene(worker.name, worker.input)));
      }
    }
  });

  test("the rate is in the build key, and 30 fps builds what an input without a rate builds", () => {
    const layers = sceneLayers("trail", 0.12);
    const keys = RATES.map((fps) => sceneBuildKey("trail", studioInput(layers, fps), "en"));
    expect(new Set(keys).size).toBe(RATES.length);
    const first = layers[0]!;
    const unset = sceneInputFromPreset(first.preset, { cues: sceneCuesFromLayers(layers), canvas: CANVAS, measure: measurer().measure, anchor: first.anchor });
    expect(JSON.stringify(buildCaptionScene("trail", unset))).toBe(JSON.stringify(buildCaptionScene("trail", studioInput(layers, 30))));
  });

  test("Trail's flame lands where the export draws it at every rate (it moved 402 px between 30 and 50 fps before)", async () => {
    const art = await loadCaptionEmojiArt(["flame"]);
    // On "you", the cue's first word: "believe" leaves under CAPTION_EMOJI_MIN_HOLD_MS of the cue at 120 ms a word, so it
    // draws nothing on either side (below); it used to show from the cue's start, before its word was spoken.
    const plan = planFor("trail", 0.12, 0);
    const layers = plan.targets[0]!.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption");
    for (const fps of RATES) {
      // The Studio: the painter's scene, the scene's cue boxes, the shared builder at the clip's rate.
      const { measure } = measurer();
      const input = studioInput(layers, fps, measure);
      const scene = buildCaptionScene("trail", input);
      const cueBoxes = captionSceneEmojiCueBoxes(scene, { preset: layers[0]!.preset, cues: input.cues, canvas: CANVAS, scale: input.scale }, measure);
      const [studio] = placeCaptionEmojis({ cueBoxes, emojis: captionEmojiLayerEmojis(layers), art, style: captionEmojiLayerStyle(layers[0]!.preset), canvas: CANVAS, anchorYPct: input.anchor.yPct, fps });
      if (!studio?.placed) throw new Error(`no Studio placement at ${fps} fps`);
      // The export.
      const track = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, fps, art);
      const event = track.ass.split("\n").find((line) => line.startsWith("Dialogue: 10000"));
      const [, x, y] = /\\pos\(([\d.]+),([\d.]+)\)/.exec(event ?? "") ?? [];
      expect(Number(x)).toBeCloseTo(studio.pieces[0]!.track.x![0]![1], 1);
      expect(Number(y)).toBeCloseTo(studio.pieces[0]!.track.y![0]![1], 1);
    }
  });

  test("an emoji whose word leaves too little of its cue draws nothing in the Studio or the export, at every rate", async () => {
    const art = await loadCaptionEmojiArt(["flame"]);
    const plan = planFor("trail", 0.12);
    const layers = sceneLayers("trail", 0.12);
    for (const fps of RATES) {
      const { measure } = measurer();
      const input = studioInput(layers, fps, measure);
      const cueBoxes = captionSceneEmojiCueBoxes(buildCaptionScene("trail", input), { preset: layers[0]!.preset, cues: input.cues, canvas: CANVAS, scale: input.scale }, measure);
      const [studio] = placeCaptionEmojis({ cueBoxes, emojis: captionEmojiLayerEmojis(layers), art, style: captionEmojiLayerStyle(layers[0]!.preset), canvas: CANVAS, anchorYPct: input.anchor.yPct, fps });
      expect(studio?.placed === false && studio.reason).toBe("no-time");
      const track = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, fps, art);
      expect(track.ass.split("\n").some((line) => line.startsWith("Dialogue: 10000"))).toBe(false);
    }
  });
});
