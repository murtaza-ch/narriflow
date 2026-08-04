import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { clampEditorDocumentToStoredWindow } from "./clip.service";

function makeDocument(
  transcriptSlice: TranscriptUtterance[],
  overrides: Partial<EditorDocument> = {},
): EditorDocument {
  return editorDocumentSchema.parse({
    clipStartSec: 10,
    clipEndSec: 20,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice,
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges: [],
    ...overrides,
  });
}

describe("clampEditorDocumentToStoredWindow", () => {
  test("clamps a transcriptSlice whose word overlaps past the stored start (the 5-12-word-on-a-10-20-clip scenario) instead of moving boundaries", () => {
    // A word timed 5-12s submitted against a stored 10-20s clip window.
    // getEffectiveClipTiming would recompute startSec down to 5 here (the
    // bug this guards against) — the clamp must keep the STORED window.
    const straddlingUtterance: TranscriptUtterance = {
      index: 0,
      speaker: 0,
      speakerLabel: "Speaker A",
      startSec: 5,
      endSec: 13,
      text: "so as you can see this works",
      confidence: null,
      words: [
        { word: "so", startSec: 5, endSec: 12, confidence: null },
        { word: "as", startSec: 12, endSec: 12.5, confidence: null },
        { word: "you", startSec: 12.5, endSec: 13, confidence: null },
      ],
    };

    const document = makeDocument([straddlingUtterance]);
    const result = clampEditorDocumentToStoredWindow(document, {
      startSec: 10,
      endSec: 20,
    });

    // The whole point of the fix: stored boundaries never move through this
    // path, even though the recomputed effective window would have widened
    // them.
    expect(result.document.clipStartSec).toBe(10);
    expect(result.document.clipEndSec).toBe(20);
    expect(result.boundaryDriftDetected).toBe(true);
    // Sanity: the recomputed value really would have moved the start,
    // proving the detection is grounded in the same primitive
    // getEffectiveClipTiming uses (otherwise this test would pass for the
    // wrong reason).
    expect(result.recomputedEffective.startSec).toBeLessThan(10);

    // The straddling word is clamped to the stored window, not dropped
    // wholesale — same behavior normalizeTranscriptSliceForClip applies
    // everywhere else.
    const [utterance] = result.document.transcriptSlice;
    expect(utterance).toBeDefined();
    expect(utterance!.startSec).toBeGreaterThanOrEqual(10);
    for (const word of utterance!.words) {
      expect(word.startSec).toBeGreaterThanOrEqual(10);
      expect(word.endSec).toBeLessThanOrEqual(20);
    }
  });

  test("is a pure pass-through clamp when the transcriptSlice already fits the stored window", () => {
    const utterance: TranscriptUtterance = {
      index: 0,
      speaker: 0,
      speakerLabel: "Speaker A",
      startSec: 10,
      endSec: 11,
      text: "so as",
      confidence: null,
      words: [
        { word: "so", startSec: 10, endSec: 10.5, confidence: null },
        { word: "as", startSec: 10.5, endSec: 11, confidence: null },
      ],
    };

    const document = makeDocument([utterance]);
    const result = clampEditorDocumentToStoredWindow(document, {
      startSec: 10,
      endSec: 20,
    });

    expect(result.boundaryDriftDetected).toBe(false);
    expect(result.document.clipStartSec).toBe(10);
    expect(result.document.clipEndSec).toBe(20);
    expect(result.document.transcriptSlice).toEqual(document.transcriptSlice);
  });

  test("clamps deletedRanges to the stored window alongside the transcript", () => {
    const utterance: TranscriptUtterance = {
      index: 0,
      speaker: 0,
      speakerLabel: "Speaker A",
      startSec: 10,
      endSec: 12,
      text: "so as you can see",
      confidence: null,
      words: [{ word: "so", startSec: 10, endSec: 11, confidence: null }],
    };

    const document = makeDocument([utterance], {
      deletedRanges: [{ startSec: 8, endSec: 11 }],
    });
    const result = clampEditorDocumentToStoredWindow(document, {
      startSec: 10,
      endSec: 20,
    });

    expect(result.document.deletedRanges).toEqual([{ startSec: 10, endSec: 11 }]);
  });
});
