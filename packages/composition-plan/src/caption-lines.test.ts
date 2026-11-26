import { describe, expect, test } from "bun:test";
import {
  autoCensorWordId,
  CAPTION_PRESETS,
  captionWordKey,
  captionPresetSchema,
  editorDocumentSchema,
  joinTranscriptWords,
  studioEditsSchema,
  type EditorDocument,
} from "@narriflow/validators";
import { deriveCaptionCues, deriveCaptionLines, planClipComposition } from "./clip-composition-plan";

type Word = [word: string, startSec: number, endSec: number];

const FIRST: Word[] = [
  ["So", 0.2, 0.4], ["the", 0.45, 0.6], ["biggest", 0.65, 1.0], ["mistake,", 1.05, 1.4], ["um,", 1.5, 1.8],
  ["people", 1.85, 2.2], ["make", 2.25, 2.5], ["is", 2.55, 2.7], ["waiting", 2.75, 3.1], ["for", 3.15, 3.3],
  ["damn", 3.35, 3.7], ["permission.", 3.75, 4.3],
];
const SECOND: Word[] = [
  ["Nobody", 4.8, 5.2], ["is", 5.25, 5.4], ["coming", 5.45, 5.8], ["to", 5.85, 5.95], ["save", 6.0, 6.3],
  ["you,", 6.35, 6.6], ["so", 6.8, 7.0], ["start", 7.05, 7.4], ["today.", 7.45, 7.9],
];

const utterance = (index: number, words: Word[]) => ({
  index, speaker: index, speakerLabel: `Speaker ${index + 1}`, startSec: words[0]![1], endSec: words.at(-1)![2],
  text: joinTranscriptWords(words.map(([word]) => ({ word }))), confidence: 1,
  words: words.map(([word, startSec, endSec]) => ({ word, startSec, endSec, confidence: 1 })),
});

const damn = { word: "damn", startSec: 3.35, endSec: 3.7, confidence: 1 };
const censor = {
  schemaVersion: 1, id: "10000000-0000-4000-8000-000000000001",
  sourceWordIds: [autoCensorWordId({ utteranceIndex: 0, wordIndex: 10, word: damn })],
  sourceStartSec: 3.35, sourceEndSec: 3.7, treatment: "caption_mask", paddingSec: 0, beepSettings: null,
  captionMaskPolicy: { replacement: "first_character", preservePunctuation: true },
  suggestionFingerprint: "a".repeat(64), policyVersion: "auto-censor-v1", enabled: true,
};
// Inside the cue holding "people make": a Scene Block splits it into two cues.
const scene = {
  schemaVersion: 1, id: "8ab9d330-688f-4574-932c-27ac661245c2", anchorSec: 1.6, durationSec: 2,
  content: { kind: "color", color: "#000000" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null,
};

function document(preset: Record<string, unknown>, extra: Record<string, unknown> = {}): EditorDocument {
  return editorDocumentSchema.parse({
    version: 1, clipStartSec: 0, clipEndSec: 8,
    captionPreset: captionPresetSchema.parse(preset),
    transcriptSlice: [utterance(0, FIRST), utterance(1, SECOND)],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null,
    // "um," is cut.
    deletedRanges: [{ startSec: 1.45, endSec: 1.82 }],
    censorSegments: [censor],
    sceneBlocks: [scene],
    ...extra,
  });
}

function plannedCues(doc: EditorDocument) {
  const result = planClipComposition({
    document: doc, source: { identity: "source:caption-lines", kind: "video", width: 1920, height: 1080, hasAudio: true },
    evidence: { automaticLayout: { state: "missing" } }, assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan.targets[0]!.visualLayers.flatMap((layer) => (layer.kind === "caption" ? [layer] : []));
}

const round = (sec: number) => Number(sec.toFixed(4));
const window = (cue: { startSec: number; endSec: number }) => [round(cue.startSec), round(cue.endSec)];

describe("deriveCaptionLines", () => {
  test.each(CAPTION_PRESETS.map((named) => [named.id, named.preset] as const))(
    "%s: one line per cue on the video, with its text and window",
    (_, preset) => {
      const doc = document(preset);
      const lines = deriveCaptionLines(doc);
      const cues = deriveCaptionCues(doc);
      expect(lines.map((line) => line.text)).toEqual(cues.map((cue) => cue.text));
      expect(lines.map(window)).toEqual(cues.map(window));
      const planned = plannedCues(doc);
      expect(planned).toHaveLength(lines.length);
      planned.forEach((layer, at) => {
        expect(round(layer.words[0]!.startSec)).toBe(round(lines[at]!.startSec));
        expect(layer.activeRange.endSec).toBeGreaterThanOrEqual(lines[at]!.endSec - 1e-9);
      });
      // Every shown word belongs to exactly one line, except the word the scene cuts in two.
      const shown = lines.flatMap((line) => line.words.map((word) => `${line.utterance}:${word}`));
      expect(shown.filter((key) => key !== "0:5")).toEqual([...new Set(shown.filter((key) => key !== "0:5"))]);
      expect(shown).not.toContain("0:4");
    },
  );

  test("lines name their transcript words: cut words are not shown, censored words are, scenes split cues", () => {
    const lines = deriveCaptionLines(document({ textTransform: "none", wordsPerCue: 3 }));
    const raw = (line: (typeof lines)[number]) =>
      line.words.map((at) => [FIRST, SECOND][line.utterance]![at]![0]).join(" ");
    expect(lines.map(raw)).toEqual([
      "So the biggest",
      "mistake, people",
      "people make",
      "is waiting for",
      "damn permission.",
      "Nobody is coming",
      "to save you,",
      "so start today.",
    ]);
    expect(lines[4]!.text).toBe("d*** permission.");
    // The scene starts at 1.6 s of edited time (inside "people") and plays for 2 s.
    expect(window(lines[1]!)).toEqual([1.05, 1.6]);
    expect(round(lines[2]!.startSec)).toBe(3.6);
  });

  test("lines regroup with the caption style's words per cue, as the video does", () => {
    const three = deriveCaptionLines(document({ textTransform: "none", wordsPerCue: 3 }, { sceneBlocks: [] }));
    const one = deriveCaptionLines(document({ textTransform: "none", wordsPerCue: 1 }, { sceneBlocks: [] }));
    expect(three).toHaveLength(7);
    expect(one).toHaveLength(FIRST.length - 1 + SECOND.length);
    expect(one.every((line) => line.words.length === 1)).toBe(true);
  });

  test("captions turned off still list their lines", () => {
    const lines = deriveCaptionLines(document({ visible: false, wordsPerCue: 3 }));
    expect(lines.length).toBeGreaterThan(0);
    expect(deriveCaptionCues(document({ visible: false, wordsPerCue: 3 }))).toEqual([]);
  });

  test("an utterance without word timings is one line with no words", () => {
    const doc = document({ wordsPerCue: 3 }, {
      sceneBlocks: [], deletedRanges: [], censorSegments: [],
      transcriptSlice: [{ ...utterance(0, FIRST), words: [] }],
    });
    expect(deriveCaptionLines(doc)).toEqual([{ utterance: 0, words: [], text: expect.any(String), startSec: 0.2, endSec: 4.3 }]);
  });

  describe("captions merged by hand", () => {
    // "is waiting for" + "damn permission." (3 words per cue) as one caption.
    const merges = { [captionWordKey(2.55)]: captionWordKey(3.75) };
    const merged = (preset: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      document(preset, { sceneBlocks: [], studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionMerges: merges }), ...extra });

    test.each(CAPTION_PRESETS.map((named) => [named.id, named.preset] as const))("%s: the video and the lines show the merged words as one caption", (_, preset) => {
      const doc = merged(preset);
      const lines = deriveCaptionLines(doc);
      const cues = deriveCaptionCues(doc);
      expect(lines.map((line) => line.text)).toEqual(cues.map((cue) => cue.text));
      expect(lines.map(window)).toEqual(cues.map(window));
      expect(plannedCues(doc)).toHaveLength(lines.length);
      expect(lines.filter((line) => line.utterance === 0 && line.words.includes(7))).toEqual([
        expect.objectContaining({ words: [7, 8, 9, 10, 11] }),
      ]);
    });

    test("words around a merge group as they did; a merge whose words are gone is ignored", () => {
      const raw = (doc: EditorDocument) => deriveCaptionLines(doc).map((line) => line.words.join(","));
      const plain = raw(document({ textTransform: "none", wordsPerCue: 3 }, { sceneBlocks: [] }));
      const withMerge = raw(merged({ textTransform: "none", wordsPerCue: 3 }));
      expect(withMerge).toEqual(plain.flatMap((line) => (line === "7,8,9" ? ["7,8,9,10,11"] : line === "10,11" ? [] : [line])));
      const gone = merged({ textTransform: "none", wordsPerCue: 3 }, {
        transcriptSlice: [utterance(0, FIRST.map(([word, start, end]) => [word, start === 3.75 ? 3.76 : start, end] as Word)), utterance(1, SECOND)],
      });
      expect(raw(gone)).toEqual(plain);
    });

    test("a merge over a cut word keeps the shown words together", () => {
      const doc = merged({ textTransform: "none", wordsPerCue: 3 }, { deletedRanges: [{ startSec: 3.32, endSec: 3.72 }] });
      expect(deriveCaptionLines(doc).find((line) => line.words.includes(7))!.words).toEqual([7, 8, 9, 11]);
    });
  });
});
