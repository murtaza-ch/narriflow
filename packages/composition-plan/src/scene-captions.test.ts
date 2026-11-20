import { describe, expect, test } from "bun:test";
import { captionPresetSchema, captionSceneDefaultPositionY, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { type CompositionCaptionVisualLayer, planClipComposition } from "./clip-composition-plan";

/** Scene Style captions through the real plan (ADR 0021): roles, speaker and the default anchor ride on the layers. */

const WORDS = ["so", "I", "quit", "my", "job", "today", "honestly", "best", "decision", "ever"].map((word, index) => ({
  word,
  startSec: index * 0.4,
  endSec: index * 0.4 + 0.35,
  confidence: 1,
}));

function utterance(index: number, speaker: number | null, words: typeof WORDS) {
  return { index, speaker, speakerLabel: `Speaker ${index}`, startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, text: words.map((w) => w.word).join(" "), confidence: 1, words };
}

function layersFor(preset: Record<string, unknown>, utterances: ReturnType<typeof utterance>[]) {
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 20,
    captionPreset: captionPresetSchema.parse(preset),
    transcriptSlice: utterances,
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null,
    deletedRanges: [],
  });
  const result = planClipComposition({
    document,
    captionLanguage: "en",
    source: { identity: "source:scene", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, music: {} },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan.targets[0]!.visualLayers.flatMap((layer): CompositionCaptionVisualLayer[] => (layer.kind === "caption" ? [layer] : []));
}

describe("Scene Style caption layers", () => {
  const reveal = getCaptionPresetById("reveal")!.preset;
  const layers = layersFor(reveal, [utterance(0, 0, WORDS.slice(0, 5)), utterance(1, 1, WORDS.slice(5))]);

  test("every timed cue carries scene facts parallel to its words, and no Caption Block", () => {
    expect(layers.length).toBeGreaterThan(1);
    for (const layer of layers) {
      expect(layer.block).toBeUndefined();
      expect(layer.scene).toBeDefined();
      expect(layer.scene!.roles).toHaveLength(layer.words.length);
      expect(layer.scene!.keys).toHaveLength(layer.words.length);
      expect(layer.scene!.roles.filter((role) => role === "hero").length).toBeLessThanOrEqual(1);
    }
  });

  test("cues group by the preset's own words per cue", () => {
    expect(Math.max(...layers.map((layer) => layer.words.length))).toBeLessThanOrEqual(reveal.wordsPerCue);
  });

  test("the diarized speaker of the utterance rides on its cues", () => {
    expect(layers.filter((layer) => layer.cueIndex < 2).every((layer) => layer.scene!.speaker === 0)).toBe(true);
    expect(layers.at(-1)!.scene!.speaker).toBe(1);
  });

  test("without a position the anchor is the sample's anchor line, and a stored position wins", () => {
    expect(layers[0]!.anchor.yPct).toBeCloseTo(captionSceneDefaultPositionY("reveal"), 6);
    expect(layers[0]!.anchor.xPct).toBe(50);
    const moved = layersFor({ ...reveal, positionX: 30, positionY: 41 }, [utterance(0, 0, WORDS.slice(0, 3))]);
    expect(moved[0]!.anchor).toEqual({ xPct: 30, yPct: 41 });
  });

  test("Dialogue's emphasis is automatic: the scorer picks at most one hero a cue, and a six-word-plus utterance gets one", () => {
    const dialogue = layersFor(getCaptionPresetById("dialogue")!.preset, [utterance(0, 0, WORDS)]);
    const heroes = dialogue.map((layer) => layer.scene!.roles.filter((role) => role === "hero").length);
    expect(heroes.every((count) => count <= 1)).toBe(true);
    expect(heroes.some((count) => count === 1)).toBe(true);
  });

  test("a classic or Dynamic preset carries no scene facts", () => {
    expect(layersFor(getCaptionPresetById("bold-pop")!.preset, [utterance(0, 0, WORDS.slice(0, 3))]).every((layer) => layer.scene === undefined)).toBe(true);
    expect(layersFor(getCaptionPresetById("headline")!.preset, [utterance(0, 0, WORDS.slice(0, 4))]).every((layer) => layer.scene === undefined)).toBe(true);
  });
});
