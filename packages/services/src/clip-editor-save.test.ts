import { describe, expect, test } from "bun:test";
import {
  CLIP_MAX_DURATION_SEC,
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
  type TranscriptUtterance,
} from "@narriflow/validators";
import {
  ClipActionError,
  assertBoundaryChangeHasAvailableSource,
  assertEditorDocumentHasRenderableContent,
  clampEditorDocumentToStoredWindow,
  editorDocumentsEqual,
  planEditorDocumentSave,
} from "./clip.service";

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

function makeUtterance(startSec: number, words: string[]): TranscriptUtterance {
  const wordDur = 0.5;
  return {
    index: 0,
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

describe("assertEditorDocumentHasRenderableContent (fix #5: server-side isEmpty guard)", () => {
  const window = { startSec: 10, endSec: 20 };

  test("does not throw when nothing is deleted", () => {
    expect(() =>
      assertEditorDocumentHasRenderableContent([], window),
    ).not.toThrow();
  });

  test("does not throw when a real kept segment remains", () => {
    expect(() =>
      assertEditorDocumentHasRenderableContent(
        [{ startSec: 12, endSec: 14 }],
        window,
      ),
    ).not.toThrow();
  });

  test("throws editor_document_empty_timeline when deletions cover the whole window", () => {
    expect(() =>
      assertEditorDocumentHasRenderableContent(
        [{ startSec: 10, endSec: 20 }],
        window,
      ),
    ).toThrow("nothing in the clip to render");
    try {
      assertEditorDocumentHasRenderableContent(
        [{ startSec: 10, endSec: 20 }],
        window,
      );
      throw new Error("expected assertEditorDocumentHasRenderableContent to throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe(
        "editor_document_empty_timeline",
      );
    }
  });

  test("throws when only a sub-MIN_KEPT_SEGMENT_SEC sliver would survive (same policy buildClipCutPlan enforces at render time)", () => {
    // Two deletions leave a 30ms sliver — under the shared 0.1s frame-safe
    // floor, so the worker's render-time guard would also reject this.
    expect(() =>
      assertEditorDocumentHasRenderableContent(
        [
          { startSec: 10, endSec: 15 },
          { startSec: 15.03, endSec: 20 },
        ],
        window,
      ),
    ).toThrow();
  });

  test("multiple deletions that jointly (not individually) cover the whole window still throw", () => {
    expect(() =>
      assertEditorDocumentHasRenderableContent(
        [
          { startSec: 10, endSec: 15 },
          { startSec: 15, endSec: 20 },
        ],
        window,
      ),
    ).toThrow();
  });
});

describe("assertBoundaryChangeHasAvailableSource (fix: boundary change with a purged source bricks the preview)", () => {
  test("throws editor_boundaries_invalid when the project's source has been purged", () => {
    try {
      assertBoundaryChangeHasAvailableSource(null);
      throw new Error("expected assertBoundaryChangeHasAvailableSource to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ClipActionError);
      expect((error as ClipActionError).code).toBe("editor_boundaries_invalid");
    }
  });

  test("does not throw when the project's source is still available", () => {
    expect(() =>
      assertBoundaryChangeHasAvailableSource("projects/p1/source.mp4"),
    ).not.toThrow();
  });
});

describe("planEditorDocumentSave (vizard-parity.md Phase B step 13, in-studio trim)", () => {
  const storedWindow = { startSec: 10, endSec: 20 };

  test("unchanged bounds: a transcript-only edit does NOT invalidate the preview proxy or touch scores", () => {
    const current = makeDocument([makeUtterance(10, ["so", "as", "you"])]);
    const document = makeDocument([makeUtterance(10, ["so", "as", "you", "can"])]);

    const plan = planEditorDocumentSave({
      document,
      current,
      storedWindow,
      sourceDurationSec: 600,
      viralityScore: 70,
    });

    expect(plan.noop).toBe(false);
    if (plan.noop) return;
    expect(plan.boundariesChanged).toBe(false);
    expect(plan.transcriptChanged).toBe(true);
    expect(plan.next.clipStartSec).toBe(storedWindow.startSec);
    expect(plan.next.clipEndSec).toBe(storedWindow.endSec);
    // No score recompute and no proxy invalidation signal on an
    // unchanged-bounds save — the caller only spreads these fields when set.
    expect(plan.durationDependentScores).toEqual({});
  });

  test("unchanged bounds AND unchanged document is a true no-op", () => {
    const doc = makeDocument([makeUtterance(10, ["so", "as"])]);
    const plan = planEditorDocumentSave({
      document: doc,
      current: doc,
      storedWindow,
      sourceDurationSec: 600,
      viralityScore: 70,
    });
    expect(plan.noop).toBe(true);
  });

  test("boundary-change save plans proxy invalidation and recomputed duration-dependent scores", () => {
    const current = makeDocument([makeUtterance(10, ["so", "as"])]);
    const document = makeDocument([makeUtterance(12, ["this", "smaller"])], {
      clipStartSec: 12,
      clipEndSec: 22,
    });

    const plan = planEditorDocumentSave({
      document,
      current,
      storedWindow,
      sourceDurationSec: 600,
      viralityScore: 70,
    });

    expect(plan.noop).toBe(false);
    if (plan.noop) return;
    expect(plan.boundariesChanged).toBe(true);
    expect(plan.next.clipStartSec).toBe(12);
    expect(plan.next.clipEndSec).toBe(22);
    // The caller (saveClipEditorDocument) reads this to decide whether to
    // null previewStorageKey/previewStartSec/previewDurationSec — a real
    // boundary change must always plan for that.
    expect(plan.durationDependentScores).toHaveProperty("durationOptimalityScore");
    expect(plan.durationDependentScores).toHaveProperty("tiktokScore");
    expect(plan.durationDependentScores).toHaveProperty("youtubeScore");
    expect(plan.durationDependentScores).toHaveProperty("instagramScore");
  });

  test("rejects a boundary change shorter than CLIP_MIN_DURATION_SEC with editor_boundaries_invalid", () => {
    const current = makeDocument([makeUtterance(10, ["so"])]);
    const document = makeDocument([makeUtterance(10, ["so"])], {
      clipStartSec: 10,
      clipEndSec: 15, // 5s — under the 10s floor
    });

    expect(() =>
      planEditorDocumentSave({
        document,
        current,
        storedWindow,
        sourceDurationSec: 600,
        viralityScore: 70,
      }),
    ).toThrow(ClipActionError);

    try {
      planEditorDocumentSave({
        document,
        current,
        storedWindow,
        sourceDurationSec: 600,
        viralityScore: 70,
      });
      throw new Error("expected planEditorDocumentSave to throw");
    } catch (error) {
      expect((error as ClipActionError).code).toBe("editor_boundaries_invalid");
    }
  });

  test("rejects a boundary change longer than CLIP_MAX_DURATION_SEC (fix: trim exceeding the 120s ceiling)", () => {
    // Every getEffectiveClipTiming consumer (toClipSnapshot, render timing,
    // getClipsNeedingPreview) silently re-clamps to CLIP_MAX_DURATION_SEC —
    // a stored window past it would permanently disagree with the effective
    // one everywhere else, so this must be rejected up front, not clamped.
    const current = makeDocument([makeUtterance(10, ["so"])]);
    const document = makeDocument([makeUtterance(0, ["so"])], {
      clipStartSec: 0,
      clipEndSec: CLIP_MAX_DURATION_SEC + 1, // 121s — one second over
    });

    try {
      planEditorDocumentSave({
        document,
        current,
        storedWindow,
        sourceDurationSec: 600,
        viralityScore: 70,
      });
      throw new Error("expected planEditorDocumentSave to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ClipActionError);
      expect((error as ClipActionError).code).toBe("editor_boundaries_invalid");
    }
  });

  test("accepts a boundary change exactly at CLIP_MAX_DURATION_SEC (mind FLOAT_SLACK)", () => {
    const current = makeDocument([makeUtterance(10, ["so"])]);
    const document = makeDocument([makeUtterance(0, ["so"])], {
      clipStartSec: 0,
      clipEndSec: CLIP_MAX_DURATION_SEC, // exactly 120s — must not be rejected
    });

    const plan = planEditorDocumentSave({
      document,
      current,
      storedWindow,
      sourceDurationSec: 600,
      viralityScore: 70,
    });

    expect(plan.noop).toBe(false);
    if (plan.noop) return;
    expect(plan.next.clipEndSec - plan.next.clipStartSec).toBe(
      CLIP_MAX_DURATION_SEC,
    );
  });

  test("rejects a boundary change whose end lands past a known source duration", () => {
    const current = makeDocument([makeUtterance(10, ["so"])]);
    const document = makeDocument([makeUtterance(590, ["so"])], {
      clipStartSec: 590,
      clipEndSec: 610, // source is only 600s long
    });

    try {
      planEditorDocumentSave({
        document,
        current,
        storedWindow,
        sourceDurationSec: 600,
        viralityScore: 70,
      });
      throw new Error("expected planEditorDocumentSave to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ClipActionError);
      expect((error as ClipActionError).code).toBe("editor_boundaries_invalid");
    }
  });

  test("a null sourceDurationSec never blocks an otherwise-valid boundary change", () => {
    const current = makeDocument([makeUtterance(10, ["so"])]);
    const document = makeDocument([makeUtterance(1000, ["so", "as"])], {
      clipStartSec: 1000,
      clipEndSec: 1015,
    });

    const plan = planEditorDocumentSave({
      document,
      current,
      storedWindow,
      sourceDurationSec: null,
      viralityScore: 70,
    });
    expect(plan.noop).toBe(false);
  });

  test("clamps deletedRanges and transcriptSlice to the new window on a boundary change", () => {
    const current = makeDocument([makeUtterance(10, ["so"])]);
    const document = makeDocument(
      [makeUtterance(12, ["this", "clip", "extends", "past"])],
      {
        clipStartSec: 12,
        clipEndSec: 22,
        deletedRanges: [{ startSec: 8, endSec: 13 }],
      },
    );

    const plan = planEditorDocumentSave({
      document,
      current,
      storedWindow,
      sourceDurationSec: 600,
      viralityScore: 70,
    });
    expect(plan.noop).toBe(false);
    if (plan.noop) return;
    expect(plan.next.deletedRanges).toEqual([{ startSec: 12, endSec: 13 }]);
    for (const utterance of plan.next.transcriptSlice) {
      expect(utterance.startSec).toBeGreaterThanOrEqual(12);
      expect(utterance.endSec).toBeLessThanOrEqual(22);
    }
  });

  test("a boundary change that leaves nothing renderable throws editor_document_empty_timeline", () => {
    const current = makeDocument([makeUtterance(10, ["so"])]);
    const document = makeDocument([makeUtterance(12, ["so"])], {
      clipStartSec: 12,
      clipEndSec: 22,
      deletedRanges: [{ startSec: 12, endSec: 22 }],
    });

    try {
      planEditorDocumentSave({
        document,
        current,
        storedWindow,
        sourceDurationSec: 600,
        viralityScore: 70,
      });
      throw new Error("expected planEditorDocumentSave to throw");
    } catch (error) {
      expect((error as ClipActionError).code).toBe("editor_document_empty_timeline");
    }
  });
});

describe("editorDocumentsEqual (lost autosave response retry)", () => {
  test("acknowledges an exact document that already reached canonical storage", () => {
    const document = makeDocument([makeUtterance(10, ["already", "saved"])]);
    expect(editorDocumentsEqual(document, structuredClone(document))).toBe(true);
  });

  test("does not hide a real stale-revision edit", () => {
    const current = makeDocument([makeUtterance(10, ["cloud"])]);
    const attempted = { ...current, brollUrl: "https://cdn.example.com/local.mp4" };
    expect(editorDocumentsEqual(current, attempted)).toBe(false);
  });
});
