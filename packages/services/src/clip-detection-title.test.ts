import { describe, expect, test } from "bun:test";
import { DEFAULT_BRAND_TITLE, DEFAULT_CAPTION_PRESET, DEFAULT_TITLE_STYLE, TITLE_TEXT_MAX_CHARS, brandTemplateSnapshotSchema, buildClipCutPlan, buildGenerationContentPack, clipSelectionInputSchema,
  encodeQuietRanges, type TranscriptUtterance, type TranscriptWord } from "@narriflow/validators";
import { decodeClipEditorDocumentFromStorage } from "./clip-editor-document-codec";
import { buildDetectedClipRows, prepareDetectedClipSeed, type DetectedClip } from "./clip-detection-persistence";

function word(startSec: number, endSec: number, text: string): TranscriptWord {
  return { word: text, startSec, endSec, confidence: null };
}

// A 2.5 s pause the audio confirms quiet, then a filler.
const slice: TranscriptUtterance[] = [{
  index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 10, endSec: 30, text: "So um we go", confidence: null,
  words: [word(10, 11, "So"), word(13.5, 13.8, "um"), word(13.9, 15, "we"), word(15.1, 30, "go")],
}];

function clip(overrides: Partial<DetectedClip> = {}): DetectedClip {
  return {
    startSec: 10, endSec: 30, title: "Why the rocket failed", hookText: "Nobody saw it coming", payoffText: null, reasoning: "r", category: "story", platformFit: ["tiktok"],
    hookStrengthScore: 50, emotionalIntensityScore: 50, storyCompletenessScore: 50, pacingScore: 50, durationOptimalityScore: 50,
    viralityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, transcriptSlice: slice, ...overrides,
  };
}

const MUSIC = "b2f1b0c4-7a33-4c25-9d54-1ef3a8c1a001";
const profileWithMusic = {
  version: 1, profileId: "4d119c8d-acde-4d95-82a4-0e61210e61db", profileRevision: 2, name: "Northstar", identity: {}, voice: {}, approvalRule: "none", style: null,
  audio: { music: [{ assetId: MUSIC, title: "Theme", durationSec: 90 }], sfx: [] },
};

function templateSnapshot(title: unknown) {
  return brandTemplateSnapshotSchema.parse({
    templateId: "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5", captionPreset: DEFAULT_CAPTION_PRESET, logoStorageKey: null, logoPosition: "bot-right",
    logoOpacity: 80, logoScalePct: 15, primaryColor: "#FFFFFF", secondaryColor: "#00FF88", accentColor: null, title,
  });
}

type Project = { brandSnapshot: unknown; brandProfileSnapshot: unknown; sourceDurationSeconds: number };
const project = (brandSnapshot: unknown = null, brandProfileSnapshot: unknown = null): Project => ({ brandSnapshot, brandProfileSnapshot, sourceDurationSeconds: 60 });

function layers(options: { project?: Project; clip?: DetectedClip; mode?: "clip" | "caption_only"; removeSilences?: boolean } = {}) {
  const pack = buildGenerationContentPack({ mode: options.mode ?? "clip", removeSilences: options.removeSilences ?? false });
  const seed = prepareDetectedClipSeed(options.project ?? project(), pack, { quietRanges: encodeQuietRanges([{ startSec: 10.9, endSec: 13.6 }]), languageCode: "en" });
  const [row] = buildDetectedClipRows({ projectId: "p", workflowRunId: "w", clips: [options.clip ?? clip()], seed, utterances: slice,
    llmMeta: { provider: "openai", model: "m", totalTokensUsed: 1 } });
  const document = decodeClipEditorDocumentFromStorage(row!, { durationSec: 60, wholeSource: seed.wholeSource });
  return { textLayers: document.studioEdits.textLayers, document };
}

describe("auto title at generation", () => {
  test("a project without a brand snapshot gets the built-in title: the AI title, first 5 seconds, default style", () => {
    expect(layers().textLayers).toEqual([{ id: "title", role: "title", text: "Why the rocket failed", startSec: 0, endSec: 5,
      positionX: 50, positionY: 12, widthPct: 86, style: DEFAULT_TITLE_STYLE }]);
  });

  test("an unreadable snapshot, or a template without title settings, is the built-in default too", () => {
    expect(layers({ project: project({ captionPreset: DEFAULT_CAPTION_PRESET }) }).textLayers[0]).toMatchObject({ endSec: 5, style: DEFAULT_TITLE_STYLE });
    expect(layers({ project: project(templateSnapshot(null)) }).textLayers[0]).toMatchObject({ endSec: 5, style: DEFAULT_TITLE_STYLE });
  });

  test("the brand template's title settings place and style it", () => {
    const style = { ...DEFAULT_TITLE_STYLE, color: "#FF0000", fontSize: 60 };
    const [layer] = layers({ project: project(templateSnapshot({ durationSec: 8, positionX: 40, positionY: 20, widthPct: 70, style })) }).textLayers;
    expect(layer).toEqual({ id: "title", role: "title", text: "Why the rocket failed", startSec: 0, endSec: 8, positionX: 40, positionY: 20, widthPct: 70, style });
  });

  test("the off switch leaves the clip without a title", () => {
    expect(layers({ project: project(templateSnapshot({ ...DEFAULT_BRAND_TITLE, enabled: false })) }).textLayers).toEqual([]);
  });

  test("caption-only generation gets no title", () => {
    expect(layers({ mode: "caption_only" }).textLayers).toEqual([]);
  });

  test("a blank AI title falls back to the hook text; neither gives no title", () => {
    expect(layers({ clip: clip({ title: "   " }) }).textLayers[0]!.text).toBe("Nobody saw it coming");
    expect(layers({ clip: clip({ title: null }) }).textLayers[0]!.text).toBe("Nobody saw it coming");
    expect(layers({ clip: clip({ title: null, hookText: " \n " }) }).textLayers).toEqual([]);
  });

  test("a long title is cut at a word boundary", () => {
    const title = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const { text } = layers({ clip: clip({ title }) }).textLayers[0]!;
    expect(text.length).toBeLessThanOrEqual(TITLE_TEXT_MAX_CHARS);
    expect(title.startsWith(text)).toBe(true);
    expect(title[text.length]).toBe(" ");
  });

  test("a duration longer than the clip ends with the clip; null lasts the whole clip", () => {
    expect(layers({ project: project(templateSnapshot({ durationSec: 30 })) }).textLayers[0]!.endSec).toBe(20);
    expect(layers({ project: project(templateSnapshot({ durationSec: null })) }).textLayers[0]!.endSec).toBeNull();
  });

  test("silence cleanup shortens the clip the title is clamped to", () => {
    const { textLayers, document } = layers({ project: project(templateSnapshot({ durationSec: 600 })), removeSilences: true });
    const edited = buildClipCutPlan(document.deletedRanges, { startSec: 10, endSec: 30 }).editedDurationSec;
    expect(document.deletedRanges.length).toBeGreaterThan(0);
    expect(edited).toBeLessThan(20);
    expect(textLayers[0]!.endSec).toBe(edited);
  });

  test("two runs on the same input give equal seeds, brand music included (the seed is hashed)", () => {
    const input = project(templateSnapshot({ durationSec: 7 }), profileWithMusic);
    const run = () => prepareDetectedClipSeed(input, buildGenerationContentPack({ mode: "clip" }), { quietRanges: null, languageCode: "en" });
    const first = run();
    expect(run()).toEqual(first);
    expect(JSON.stringify(run())).toBe(JSON.stringify(first));
    expect(first.title).toMatchObject({ durationSec: 7 });
    expect(first.studioEdits.music.blocks.map((block) => block.id)).toEqual(["brand-music"]);
    // The seed fits the selection capsule's strict editor object as is.
    expect(clipSelectionInputSchema.shape.editor.parse(first)).toEqual(first);
  });
});

describe("an unreadable brand snapshot", () => {
  test("a caption preset that does not parse falls back as if the template had none, and generation goes on", () => {
    const broken = project({ captionPreset: { fontSize: "huge", position: 42 } });
    const pack = buildGenerationContentPack({ mode: "clip" });
    const seed = prepareDetectedClipSeed(broken, pack, { quietRanges: null, languageCode: "en" });
    expect(seed.captionPreset).toEqual(prepareDetectedClipSeed(project(), pack, { quietRanges: null, languageCode: "en" }).captionPreset);
    expect(layers({ project: broken }).textLayers[0]).toMatchObject({ id: "title", style: DEFAULT_TITLE_STYLE });
  });
});
