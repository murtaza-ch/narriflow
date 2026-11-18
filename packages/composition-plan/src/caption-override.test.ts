import { describe, expect, test } from "bun:test";
import {
  autoCensorWordId,
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  captionCueText,
  deriveCaptionCues,
  planClipComposition,
  type CaptionOverride,
} from "./clip-composition-plan";

const SCENE = {
  schemaVersion: 1,
  id: "8ab9d330-688f-4574-932c-27ac661245c1",
  anchorSec: 1,
  durationSec: 1,
  content: { kind: "color", color: "#000000" },
  motion: { entrance: "none", exit: "none" },
  templateSnapshot: null,
};

function document(overrides: Record<string, unknown> = {}, preset: Record<string, unknown> = {}) {
  return editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 10,
    captionPreset: captionPresetSchema.parse({ textTransform: "none", wordsPerCue: 2, ...preset }),
    transcriptSlice: [{
      index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 0, endSec: 1, text: "Source words", confidence: 1,
      words: [
        { word: "Source", startSec: 0, endSec: 0.5, confidence: 1 },
        { word: "words", startSec: 0.5, endSec: 1, confidence: 1 },
      ],
    }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null,
    deletedRanges: [],
    ...overrides,
  });
}

const OVERRIDE: CaptionOverride = {
  language: "ur",
  segments: [
    [
      { text: "one", startSec: 0, endSec: 0.5 },
      { text: "two", startSec: 0.5, endSec: 1 },
      { text: "three", startSec: 1, endSec: 1.5 },
    ],
    [
      { text: "four", spaceBefore: true, startSec: 3, endSec: 3.5 },
    ],
  ],
};

function plan(doc: ReturnType<typeof document>, captionOverride?: CaptionOverride, captionLanguage: string | null = "en") {
  const result = planClipComposition({
    document: doc,
    captionLanguage,
    ...(captionOverride ? { captionOverride } : {}),
    source: { identity: "source:override", kind: "video", width: 320, height: 180 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, music: { state: "available", ref: "music:bed" } },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

function captionLayers(planned: ReturnType<typeof plan>) {
  return planned.targets[0]!.visualLayers.flatMap((layer) => (layer.kind === "caption" ? [layer] : []));
}

describe("caption override", () => {
  test("groups per segment, so a cue never straddles two segments", () => {
    const layers = captionLayers(plan(document(), OVERRIDE));
    expect(layers.map((layer) => captionCueText(layer.words))).toEqual(["one two", "three", "four"]);
    expect(layers.map((layer) => layer.id)).toEqual([
      "layer:caption:dub:0:0:vertical",
      "layer:caption:dub:0:1:vertical",
      "layer:caption:dub:1:0:vertical",
    ]);
    expect(layers.map((layer) => layer.cueIndex)).toEqual([0, 1, 2]);
    expect(layers.every((layer) => layer.language === "ur")).toBe(true);
    expect(layers[0]!.activeRange).toEqual({ startSec: 0, endSec: 1 });
    expect(layers[2]!.words[0]!.spaceBefore).toBe(true);
  });

  test("replaces the transcript words and uses the override language for the text transform", () => {
    const upper = document({}, { textTransform: "uppercase" });
    const layers = captionLayers(plan(upper, { language: "tr", segments: [[{ text: "iyi", startSec: 0, endSec: 1 }]] }));
    expect(layers.map((layer) => layer.words.map((word) => word.text))).toEqual([["İYİ"]]);
    expect(layers[0]!.language).toBe("tr");
  });

  test("applies the preset punctuation rule and drops tokens that format to nothing", () => {
    const layers = captionLayers(plan(document({}, { punctuation: false }), {
      language: "en",
      segments: [[
        { text: "Hello,", startSec: 0, endSec: 0.4 },
        { text: "...", startSec: 0.4, endSec: 0.5 },
        { text: "world.", startSec: 0.5, endSec: 1 },
      ]],
    }));
    expect(layers.map((layer) => layer.words.map((word) => word.text))).toEqual([["Hello", "world"]]);
  });

  test("keeps emoji enrichment and ignores censor masks", () => {
    const sourceWord = { word: "Source", startSec: 0, endSec: 0.5, confidence: 1 };
    const doc = document({
      censorSegments: [{
        schemaVersion: 1, id: "10000000-0000-4000-8000-000000000001",
        sourceWordIds: [autoCensorWordId({ utteranceIndex: 0, wordIndex: 0, word: sourceWord })],
        sourceStartSec: 0, sourceEndSec: 0.5, treatment: "caption_mask", paddingSec: 0, beepSettings: null,
        captionMaskPolicy: { replacement: "first_last", preservePunctuation: true },
        suggestionFingerprint: "a".repeat(64), policyVersion: "auto-censor-v1", enabled: true,
      }],
    }, { emojis: true });
    const override = { language: "en", segments: [[{ text: "Source", startSec: 0, endSec: 0.5 }, { text: "love", startSec: 0.5, endSec: 1 }]] };
    const withMask = captionLayers(plan(doc, override));
    expect(withMask[0]!.words[0]!.text).toBe("Source");
    const withoutMask = captionLayers(plan(document({}, { emojis: true }), override));
    expect(withMask.map((layer) => layer.words)).toEqual(withoutMask.map((layer) => layer.words));
    expect(withMask[0]!.words[1]!.emoji).not.toBeNull();
  });

  test("renders nothing when the preset hides captions", () => {
    expect(captionLayers(plan(document({}, { visible: false }), OVERRIDE))).toEqual([]);
  });

  test("retimes override words around an inserted scene block", () => {
    const doc = document({ sceneBlocks: [SCENE] });
    const layers = captionLayers(plan(doc, {
      language: "ur",
      segments: [[{ text: "late", startSec: 2, endSec: 2.5 }]],
    }));
    expect(layers).toHaveLength(1);
    expect(layers[0]!.activeRange.startSec).toBeCloseTo(3, 8);
    expect(layers[0]!.activeRange.endSec).toBeCloseTo(3.5, 8);
    expect(layers[0]!.words[0]!.startSec).toBeCloseTo(3, 8);
  });

  test("changes the plan fingerprint", () => {
    const doc = document();
    const base = plan(doc);
    const dubbed = plan(doc, OVERRIDE);
    const moved = plan(doc, { ...OVERRIDE, segments: [[{ text: "one", startSec: 0.1, endSec: 0.5 }]] });
    expect(new Set([base.inputFingerprint, dubbed.inputFingerprint, moved.inputFingerprint]).size).toBe(3);
    expect(plan(doc, OVERRIDE).inputFingerprint).toBe(dubbed.inputFingerprint);
  });

  test("deriveCaptionCues uses the same path", () => {
    const doc = document({ sceneBlocks: [SCENE] });
    const cues = deriveCaptionCues(doc, { captionOverride: OVERRIDE });
    expect(cues.map((cue) => cue.text)).toEqual(["one two", "three", "four"]);
    expect(cues.every((cue) => cue.language === "ur")).toBe(true);
    const burned = captionLayers(plan(doc, OVERRIDE)).map((layer) => captionCueText(layer.words));
    expect(cues.map((cue) => cue.text)).toEqual(burned);
    expect(deriveCaptionCues(doc).map((cue) => cue.text)).toEqual(["Source words"]);
  });

  test("music ducking follows the override words, not the transcript", () => {
    const doc = document({
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "center" },
        music: { url: "https://example.com/music.mp3", ducking: true },
      }),
    });
    const transcriptWindows = plan(doc).audioSchedule.music!.ducking.windows;
    expect(transcriptWindows).toHaveLength(1);
    expect(transcriptWindows[0]!.endSec).toBeLessThan(2);
    const windows = plan(doc, {
      language: "ur",
      segments: [[{ text: "late", startSec: 6, endSec: 6.5 }]],
    }).audioSchedule.music!.ducking.windows;
    expect(windows).toHaveLength(1);
    expect(windows[0]!.startSec).toBeGreaterThan(5);
    expect(windows[0]!.endSec).toBeGreaterThan(6.5);
  });

  test("ducking windows move past an inserted scene block", () => {
    const doc = document({
      sceneBlocks: [SCENE],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "center" },
        music: { url: "https://example.com/music.mp3", ducking: true },
      }),
    });
    const windows = plan(doc, {
      language: "ur",
      segments: [[{ text: "late", startSec: 2, endSec: 2.5 }]],
    }).audioSchedule.music!.ducking.windows;
    expect(windows).toHaveLength(1);
    expect(windows[0]!.startSec).toBeCloseTo(2.88, 8);
    expect(windows[0]!.endSec).toBeCloseTo(3.62, 8);
  });
});
