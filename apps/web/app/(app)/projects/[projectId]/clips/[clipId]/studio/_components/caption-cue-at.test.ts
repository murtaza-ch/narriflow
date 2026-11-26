import { describe, expect, test } from "bun:test";
import { planClipComposition, type CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { captionPresetSchema, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { captionActiveWordIndex, captionBlockDragPoint, captionBlockDroppedPosition, captionCueWordsAt, captionLayerAt, classicCaptionLayerOf } from "./caption-cue-at";

function planLayers(presetId: string, deletedRanges: { startSec: number; endSec: number }[] = []): CompositionCaptionVisualLayer[] {
  const words = [
    ["Nobody", 1, 1.4],
    ["feels", 1.45, 1.8],
    ["ready.", 1.85, 2.3],
    ["You", 2.9, 3.1],
    ["start", 3.15, 3.5],
    ["anyway", 3.55, 4],
  ] as const;
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 10,
    captionPreset: captionPresetSchema.parse(getCaptionPresetById(presetId)!.preset),
    transcriptSlice: [{
      index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 1, endSec: 4, confidence: 1,
      text: words.map(([word]) => word).join(" "),
      words: words.map(([word, startSec, endSec]) => ({ word, startSec, endSec, confidence: 1 })),
    }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null,
    deletedRanges,
  });
  const result = planClipComposition({
    document,
    captionLanguage: "en",
    source: { identity: "source:cue-at", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, music: {} },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "9:16", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan.targets[0]!.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption");
}

describe("caption cues read from the plan (the one cue derivation)", () => {
  test("the layer under the playhead, and none between cues", () => {
    const layers = planLayers("bold-pop");
    expect(layers.length).toBeGreaterThan(1);
    const first = layers[0]!;
    expect(captionLayerAt(layers, first.activeRange.startSec)).toBe(first);
    expect(captionLayerAt(layers, first.activeRange.endSec - 0.001)).toBe(first);
    expect(captionLayerAt(layers, 0.2)).toBeNull();
  });

  test("a cut moves the cue words with the plan: no deleted word is shown", () => {
    const layers = planLayers("bold-pop", [{ startSec: 1.44, endSec: 1.82 }]);
    const text = layers.flatMap((layer) => layer.words.map((word) => word.text.toLowerCase()));
    expect(text).not.toContain("feels");
  });

  test("classic words carry the active word and its duration", () => {
    const layer = planLayers("bold-pop")[0]!;
    const second = layer.words[1]!;
    const words = captionCueWordsAt(layer, second.startSec + 0.01);
    expect(words.map((word) => word.isActive)).toEqual(layer.words.map((_, index) => index === 1));
    expect(words[1]!.durationMs).toBe(Math.max(50, Math.round(((layer.words[2]?.startSec ?? layer.activeRange.endSec) - second.startSec) * 1000)));
    expect(captionActiveWordIndex(layer, layer.activeRange.endSec)).toBe(-1);
  });

  test("highlight and duration stop at the cue boundary and follow the same segment clock", () => {
    const layer = {
      activeRange: { startSec: 0, endSec: 0.6 },
      words: [
        { text: "یہ", startSec: 0, endSec: 0.2 },
        { text: "ہے", startSec: 0.3, endSec: 0.8 },
      ],
    };
    expect(captionActiveWordIndex(layer, 0.25)).toBe(0);
    expect(captionActiveWordIndex(layer, 0.4)).toBe(1);
    expect(captionActiveWordIndex(layer, 0.6)).toBe(-1);
    expect(captionCueWordsAt(layer, 0.4)[1]).toMatchObject({ durationMs: 300 });
  });

  test("a Dynamic Style layer carries its block for the block painter", () => {
    const layers = planLayers("headline");
    expect(layers.every((layer) => layer.block !== undefined)).toBe(true);
    expect(captionLayerAt(layers, layers[0]!.activeRange.startSec)?.block?.style).toBe("headline");
  });
});

describe("dragging a Caption Block", () => {
  const canvas = { width: 1080, height: 1920 };

  test("a centre style drags its centre; an unshifted block stores exactly the dropped point", () => {
    const point = captionBlockDragPoint({ anchor: { xPct: 50, yPct: 40 }, shift: { x: 0, y: 0 }, canvas, mirrored: false });
    expect(point).toEqual({ xPct: 50, yPct: 40 });
    expect(captionBlockDroppedPosition({ xPct: point.xPct + 5, yPct: point.yPct - 10 }, false)).toEqual({ positionX: 55, positionY: 30 });
  });

  test("a left style drags its left edge, stored as positionX", () => {
    const point = captionBlockDragPoint({ anchor: { xPct: 8, yPct: 50 }, shift: { x: 0, y: 0 }, canvas, mirrored: false });
    expect(captionBlockDroppedPosition({ xPct: point.xPct + 4, yPct: point.yPct }, false)).toEqual({ positionX: 12, positionY: 50 });
  });

  test("an RTL cue in a left style drags its right edge: moving right lowers positionX", () => {
    const point = captionBlockDragPoint({ anchor: { xPct: 8, yPct: 50 }, shift: { x: 0, y: 0 }, canvas, mirrored: true });
    expect(point.xPct).toBe(92);
    expect(captionBlockDroppedPosition({ xPct: point.xPct + 2, yPct: point.yPct }, true)).toEqual({ positionX: 6, positionY: 50 });
  });

  test("the drag starts where the block is drawn: a block the safe area pushed up lands where it is dropped", () => {
    // Stored at 90%, drawn 192 px (10%) higher by the safe-area shift.
    const point = captionBlockDragPoint({ anchor: { xPct: 50, yPct: 90 }, shift: { x: 0, y: -192 }, canvas, mirrored: false });
    expect(point.yPct).toBeCloseTo(80, 9);
    const dropped = captionBlockDroppedPosition({ xPct: point.xPct, yPct: point.yPct - 20 }, false);
    expect(dropped.positionY).toBeCloseTo(60, 9);
  });

  test("dropped positions stay inside the frame", () => {
    expect(captionBlockDroppedPosition({ xPct: -4, yPct: 130 }, false)).toEqual({ positionX: 0, positionY: 100 });
  });
});

describe("the classic line of a Scene Style target (fix 7)", () => {
  /** A timed utterance, then one without word times: the scene draws the first, the worker burns the second as the classic line. */
  function sceneWithUntimed() {
    const document = editorDocumentSchema.parse({
      version: 1,
      clipStartSec: 0,
      clipEndSec: 12,
      captionPreset: captionPresetSchema.parse(getCaptionPresetById("reveal")!.preset),
      transcriptSlice: [
        { index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 1, endSec: 3, confidence: 1, text: "Nobody feels ready", words: [["Nobody", 1, 1.6], ["feels", 1.7, 2.2], ["ready", 2.3, 3]].map(([word, startSec, endSec]) => ({ word, startSec, endSec, confidence: 1 })) },
        { index: 1, speaker: 0, speakerLabel: "Speaker 1", startSec: 6, endSec: 8, confidence: 1, text: "Start anyway today", words: [] },
      ],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const result = planClipComposition({
      document,
      captionLanguage: "en",
      source: { identity: "source:untimed", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" }, music: {} },
      capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "9:16", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);
    return result.plan.targets[0]!.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption");
  }

  test("the untimed utterance is the classic line; the timed cues are scene cues", () => {
    const layers = sceneWithUntimed();
    const timed = layers.filter((layer) => layer.scene !== undefined);
    const untimed = layers.filter((layer) => layer.scene === undefined);
    expect(timed.length).toBeGreaterThan(0);
    expect(untimed).toHaveLength(1);
    // At a time inside the untimed utterance, the layers live then hold it, and the Studio finds it.
    const live = layers.filter((layer) => 7 >= layer.activeRange.startSec && 7 < layer.activeRange.endSec);
    expect(classicCaptionLayerOf(live)).toBe(untimed[0]);
    // At a time inside a timed cue there is no classic line to draw.
    const inCue = layers.filter((layer) => 2 >= layer.activeRange.startSec && 2 < layer.activeRange.endSec);
    expect(inCue.length).toBeGreaterThan(0);
    expect(classicCaptionLayerOf(inCue)).toBeUndefined();
  });

  test("a classic preset's own cue is its classic line", () => {
    const layers = planLayers("bold-pop");
    expect(classicCaptionLayerOf([layers[0]!])).toBe(layers[0]);
  });
});
