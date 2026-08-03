import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
  type TranscriptUtterance,
} from "@narriflow/validators";
import {
  ClipEditorRevisionConflictError,
  assertEditorRevisionMatches,
  planEditorReset,
} from "./clip.service";

function makeUtterance(
  index: number,
  startSec: number,
  words: string[],
): TranscriptUtterance {
  const wordDur = 0.5;
  return {
    index,
    speaker: 0,
    speakerLabel: "Speaker A",
    startSec,
    endSec: startSec + words.length * wordDur,
    text: words.join(" "),
    confidence: null,
    words: words.map((word, i) => ({
      word,
      startSec: startSec + i * wordDur,
      endSec: startSec + (i + 1) * wordDur,
      confidence: null,
    })),
  };
}

function makeOriginal(overrides: Partial<EditorDocument> = {}): EditorDocument {
  return editorDocumentSchema.parse({
    clipStartSec: 10,
    clipEndSec: 20,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [makeUtterance(0, 10, ["so", "as", "you", "can", "see"])],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges: [],
    ...overrides,
  });
}

describe("assertEditorRevisionMatches", () => {
  test("does not throw when revisions match", () => {
    expect(() => assertEditorRevisionMatches(3, 3)).not.toThrow();
  });

  test("throws ClipEditorRevisionConflictError carrying the current revision on mismatch", () => {
    expect(() => assertEditorRevisionMatches(5, 3)).toThrow(
      ClipEditorRevisionConflictError,
    );
    try {
      assertEditorRevisionMatches(5, 3);
      throw new Error("expected assertEditorRevisionMatches to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ClipEditorRevisionConflictError);
      expect((error as ClipEditorRevisionConflictError).currentRevision).toBe(5);
    }
  });
});

describe("planEditorReset", () => {
  test("is a no-op when editorOriginal is null (never saved through the editor)", () => {
    const plan = planEditorReset({
      editorOriginal: null,
      currentStartSec: 10,
      currentEndSec: 20,
      viralityScore: 70,
      sourceDurationSec: 600,
    });
    expect(plan.noop).toBe(true);
  });

  test("boundariesChanged is false when the restored window matches the current one", () => {
    const original = makeOriginal();
    const plan = planEditorReset({
      editorOriginal: original,
      currentStartSec: original.clipStartSec,
      currentEndSec: original.clipEndSec,
      viralityScore: 70,
      sourceDurationSec: 600,
    });
    expect(plan.noop).toBe(false);
    if (plan.noop) return;
    expect(plan.boundariesChanged).toBe(false);
    expect(plan.effective.startSec).toBeCloseTo(original.clipStartSec, 2);
    expect(plan.effective.endSec).toBeCloseTo(original.clipEndSec, 2);
  });

  test("boundariesChanged is true when the current clip window has since moved", () => {
    const original = makeOriginal({ clipStartSec: 10, clipEndSec: 20 });
    const plan = planEditorReset({
      editorOriginal: original,
      // Simulates an in-studio trim (Phase B) having moved the live clip
      // window away from the revision-zero snapshot.
      currentStartSec: 15,
      currentEndSec: 45,
      viralityScore: 70,
      sourceDurationSec: 600,
    });
    expect(plan.noop).toBe(false);
    if (plan.noop) return;
    expect(plan.boundariesChanged).toBe(true);
  });

  test("recomputes duration-dependent scores from the restored window", () => {
    const original = makeOriginal();
    const plan = planEditorReset({
      editorOriginal: original,
      currentStartSec: original.clipStartSec,
      currentEndSec: original.clipEndSec,
      viralityScore: 80,
      sourceDurationSec: 600,
    });
    expect(plan.noop).toBe(false);
    if (plan.noop) return;
    expect(plan.durationOptimalityScore).toBeGreaterThan(0);
    expect(plan.tiktokScore).toBeGreaterThan(0);
    expect(plan.youtubeScore).toBeGreaterThan(0);
    expect(plan.instagramScore).toBeGreaterThan(0);
  });

  test("restores deletedRanges and brollUrl from the original document", () => {
    const original = makeOriginal({
      brollUrl: "https://example.com/broll.mp4",
      deletedRanges: [{ startSec: 12, endSec: 14 }],
    });
    const plan = planEditorReset({
      editorOriginal: original,
      currentStartSec: original.clipStartSec,
      currentEndSec: original.clipEndSec,
      viralityScore: 70,
      sourceDurationSec: 600,
    });
    expect(plan.noop).toBe(false);
    if (plan.noop) return;
    expect(plan.original.brollUrl).toBe("https://example.com/broll.mp4");
    expect(plan.original.deletedRanges).toEqual([{ startSec: 12, endSec: 14 }]);
  });
});
