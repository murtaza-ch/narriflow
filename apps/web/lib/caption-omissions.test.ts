import { describe, expect, test } from "bun:test";
import { deriveCaptionCues } from "@narriflow/composition-plan";
import { autoCensorWordId, captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { captionOmissionNote, studioCaptionOmissionNote, editingOmissionSummary, renderedOmissionSummary } from "./caption-omissions";

type Word = readonly [word: string, startSec: number, endSec: number];
function studioDocument(words: readonly Word[], patch: Record<string, unknown> & { captionPreset?: Record<string, unknown> } = {}) {
  const { captionPreset, ...rest } = patch;
  return editorDocumentSchema.parse({
    version: 1, clipStartSec: 0, clipEndSec: 10,
    captionPreset: captionPresetSchema.parse({ textTransform: "none", wordsPerCue: 3, ...captionPreset }),
    transcriptSlice: [{
      index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9,
      startSec: words[0]![1], endSec: words.at(-1)![2], text: words.map(([word]) => word).join(" "),
      words: words.map(([word, startSec, endSec]) => ({ word, startSec, endSec, confidence: 0.9 })),
    }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null, deletedRanges: [], ...rest,
  });
}

describe("caption omission note", () => {
  test("is absent for a normal render", () => {
    expect(captionOmissionNote(null)).toBeNull();
    expect(captionOmissionNote(undefined)).toBeNull();
    expect(captionOmissionNote({ omittedCodePoints: [], skippedEmoji: [] })).toBeNull();
  });

  test("counts omitted code points and skipped emoji, naming every code point", () => {
    const note = captionOmissionNote({ omittedCodePoints: ["U+13000"], skippedEmoji: ["\u{1F1FA}\u{1F1F8}"] });
    expect(note?.count).toBe(2);
    expect(note?.omissions.map((omission) => omission.label)).toEqual(["U+13000", "U+1F1FA U+1F1F8"]);
  });

  test("copy is plain and singular-aware", () => {
    expect(renderedOmissionSummary(1)).toBe("1 character couldn't be shown");
    expect(renderedOmissionSummary(2)).toBe("2 characters couldn't be shown");
    expect(editingOmissionSummary(1)).toContain("1 character can't be shown");
  });

  test("the Studio names undrawable characters in the cues the export will burn in", () => {
    const words = [["fine", 0, 1], ["\u{13000}", 1, 2], ["\u{13001}", 2, 3]] as const;
    expect(studioCaptionOmissionNote(studioDocument(words))?.omissions.map((omission) => omission.label)).toEqual(["U+13000", "U+13001"]);
    expect(studioCaptionOmissionNote(studioDocument(words, { captionPreset: { visible: false } }))).toBeNull();
    expect(studioCaptionOmissionNote(studioDocument([["Plain", 0, 1], ["\u4f60\u597d", 1, 2], ["\u2605", 2, 3], ["\u{1F4B0}", 3, 4]]))).toBeNull();
  });

  test("text removed by cuts is not warned about, and the labels are the export's", () => {
    const words = [["fine", 0, 1], ["\u{13000}", 4, 5], ["\u13A0", 7, 8]] as const;
    const cut = studioDocument(words, { deletedRanges: [{ startSec: 3, endSec: 6 }] });
    expect(deriveCaptionCues(cut).map((cue) => cue.text).join(" ")).not.toContain("\u{13000}");
    expect(studioCaptionOmissionNote(cut)?.omissions.map((omission) => omission.label)).toEqual(["U+13A0"]);
    expect(studioCaptionOmissionNote(studioDocument(words, { deletedRanges: [{ startSec: 3, endSec: 9 }] }))).toBeNull();
  });

  test("a censor mask hides the word, so its characters are not warned about", () => {
    const word = { word: "\u{13000}ab", startSec: 0, endSec: 1, confidence: 0.9 };
    const sourceWordIds = [autoCensorWordId({ utteranceIndex: 0, wordIndex: 0, word })];
    const censorSegments = [{ schemaVersion: 1, id: "10000000-0000-4000-8000-000000000002", sourceWordIds, sourceStartSec: 0, sourceEndSec: 1,
      treatment: "caption_mask", paddingSec: 0, beepSettings: null, captionMaskPolicy: { replacement: "full_block", preservePunctuation: true },
      suggestionFingerprint: "a".repeat(64), policyVersion: "auto-censor-v2", enabled: true }];
    const masked = studioDocument([["\u{13000}ab", 0, 1]], { censorSegments });
    expect(deriveCaptionCues(masked).map((cue) => cue.text).join(" ")).not.toContain("\u{13000}");
    expect(studioCaptionOmissionNote(masked)).toBeNull();
    expect(studioCaptionOmissionNote(studioDocument([["\u{13000}ab", 0, 1]]))).not.toBeNull();
  });

  test("an uploaded caption font may draw more than the fallback chain, so the Studio makes no claim", () => {
    const font = { kind: "brand_font", id: "10000000-0000-4000-8000-000000000001", fingerprint: "a".repeat(32) };
    expect(studioCaptionOmissionNote(studioDocument([["\u{13000}", 0, 1]], { captionPreset: { fontAsset: font } }))).toBeNull();
  });
});
