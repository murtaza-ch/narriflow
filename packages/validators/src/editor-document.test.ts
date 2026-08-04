import { describe, expect, test } from "bun:test";

import { DEFAULT_CAPTION_PRESET } from "./caption-preset";
import {
  EDITOR_HISTORY_LIMIT,
  applyEditorAction,
  applyWithHistory,
  canRedo,
  canUndo,
  createEditorHistory,
  editorDocumentSchema,
  redoEditor,
  undoEditor,
  type EditorDocument,
} from "./editor-document";
import { studioEditsSchema } from "./studio-edits";
import type { TranscriptUtterance } from "./transcript";

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

function makeDocument(): EditorDocument {
  return editorDocumentSchema.parse({
    clipStartSec: 10,
    clipEndSec: 40,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [
      makeUtterance(0, 10, ["so", "as", "you", "can"]),
      makeUtterance(1, 14, ["this", "smaller", "again"]),
    ],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges: [],
  });
}

describe("applyEditorAction", () => {
  test("updateWordText changes one word and rebuilds utterance text only", () => {
    const doc = makeDocument();
    const next = applyEditorAction(doc, {
      type: "updateWordText",
      utteranceIndex: 1,
      wordIndex: 1,
      text: "bigger",
    });
    const utterance = next.transcriptSlice[1]!;
    expect(utterance.text).toBe("this bigger again");
    expect(utterance.words[1]!.word).toBe("bigger");
    // Timings are untouched — no proportional redistribution.
    expect(utterance.words.map((w) => w.startSec)).toEqual(
      doc.transcriptSlice[1]!.words.map((w) => w.startSec),
    );
    // Untouched utterance is referentially identical.
    expect(next.transcriptSlice[0]).toBe(doc.transcriptSlice[0]!);
  });

  test("updateWordText out of bounds is a no-op returning the same reference", () => {
    const doc = makeDocument();
    expect(
      applyEditorAction(doc, {
        type: "updateWordText",
        utteranceIndex: 9,
        wordIndex: 0,
        text: "x",
      }),
    ).toBe(doc);
  });

  test("deleteRange normalizes and merges into the deleted set", () => {
    const doc = makeDocument();
    const once = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 14, endSec: 15.5 },
    });
    const twice = applyEditorAction(once, {
      type: "deleteRange",
      range: { startSec: 15.5, endSec: 17 },
    });
    expect(twice.deletedRanges).toEqual([{ startSec: 14, endSec: 17 }]);
  });

  test("revertRange splits a deletion", () => {
    const doc = applyEditorAction(makeDocument(), {
      type: "deleteRange",
      range: { startSec: 14, endSec: 20 },
    });
    const next = applyEditorAction(doc, {
      type: "revertRange",
      range: { startSec: 16, endSec: 17 },
    });
    expect(next.deletedRanges).toEqual([
      { startSec: 14, endSec: 16 },
      { startSec: 17, endSec: 20 },
    ]);
  });

  test("setClipBoundaries rebases deletions into the new window", () => {
    const doc = applyEditorAction(makeDocument(), {
      type: "deleteRange",
      range: { startSec: 12, endSec: 35 },
    });
    const next = applyEditorAction(doc, {
      type: "setClipBoundaries",
      startSec: 15,
      endSec: 30,
    });
    expect(next.deletedRanges).toEqual([{ startSec: 15, endSec: 30 }]);
  });

  test("reset returns the original document", () => {
    const original = makeDocument();
    const mutated = applyEditorAction(original, {
      type: "setBrollUrl",
      brollUrl: "https://example.com/broll.mp4",
    });
    expect(applyEditorAction(mutated, { type: "reset", original })).toBe(original);
  });

  test("setBrollUrl with the same URL is a semantic no-op (same reference)", () => {
    const doc = applyEditorAction(makeDocument(), {
      type: "setBrollUrl",
      brollUrl: "https://example.com/a.mp4",
    });
    expect(
      applyEditorAction(doc, { type: "setBrollUrl", brollUrl: "https://example.com/a.mp4" }),
    ).toBe(doc);
  });

  test("setCaptionPreset with a deep-equal (but new) object is a no-op", () => {
    const doc = makeDocument();
    const next = applyEditorAction(doc, {
      type: "setCaptionPreset",
      // Structurally identical to doc.captionPreset but a fresh object.
      captionPreset: { ...doc.captionPreset },
    });
    expect(next).toBe(doc);
  });

  test("setStudioEdits with a deep-equal (but new) object is a no-op", () => {
    const doc = makeDocument();
    const next = applyEditorAction(doc, {
      type: "setStudioEdits",
      studioEdits: JSON.parse(JSON.stringify(doc.studioEdits)),
    });
    expect(next).toBe(doc);
  });

  test("setTranscriptSlice with a deep-equal (but new) array is a no-op", () => {
    const doc = makeDocument();
    const next = applyEditorAction(doc, {
      type: "setTranscriptSlice",
      transcriptSlice: JSON.parse(JSON.stringify(doc.transcriptSlice)),
    });
    expect(next).toBe(doc);
  });

  test("setClipBoundaries with unchanged bounds is a no-op", () => {
    const doc = makeDocument();
    const next = applyEditorAction(doc, {
      type: "setClipBoundaries",
      startSec: doc.clipStartSec,
      endSec: doc.clipEndSec,
    });
    expect(next).toBe(doc);
  });

  test("setDeletedRanges with an equivalent (differently-ordered) set is a no-op", () => {
    const doc = applyEditorAction(makeDocument(), {
      type: "setDeletedRanges",
      ranges: [{ startSec: 14, endSec: 15 }],
    });
    const next = applyEditorAction(doc, {
      type: "setDeletedRanges",
      ranges: [{ startSec: 14, endSec: 15 }],
    });
    expect(next).toBe(doc);
  });
});

describe("history", () => {
  test("undo/redo walk the document states", () => {
    let history = createEditorHistory(makeDocument());
    history = applyWithHistory(history, {
      type: "setBrollUrl",
      brollUrl: "https://example.com/a.mp4",
    });
    history = applyWithHistory(history, {
      type: "deleteRange",
      range: { startSec: 14, endSec: 15 },
    });

    expect(canUndo(history)).toBe(true);
    expect(canRedo(history)).toBe(false);

    history = undoEditor(history);
    expect(history.present.deletedRanges).toEqual([]);
    expect(history.present.brollUrl).toBe("https://example.com/a.mp4");
    expect(canRedo(history)).toBe(true);

    history = undoEditor(history);
    expect(history.present.brollUrl).toBeNull();
    expect(canUndo(history)).toBe(false);

    history = redoEditor(history);
    history = redoEditor(history);
    expect(history.present.deletedRanges).toEqual([{ startSec: 14, endSec: 15 }]);
    expect(redoEditor(history)).toBe(history);
  });

  test("a new edit clears the redo branch", () => {
    let history = createEditorHistory(makeDocument());
    history = applyWithHistory(history, {
      type: "setBrollUrl",
      brollUrl: "https://example.com/a.mp4",
    });
    history = undoEditor(history);
    history = applyWithHistory(history, {
      type: "setBrollUrl",
      brollUrl: "https://example.com/b.mp4",
    });
    expect(canRedo(history)).toBe(false);
    expect(history.present.brollUrl).toBe("https://example.com/b.mp4");
  });

  test("same coalesceKey collapses a gesture into one undo step", () => {
    let history = createEditorHistory(makeDocument());
    for (let size = 37; size <= 44; size += 1) {
      history = applyWithHistory(
        history,
        {
          type: "setCaptionPreset",
          captionPreset: { ...history.present.captionPreset, fontSize: size },
        },
        { coalesceKey: "caption.fontSize" },
      );
    }
    expect(history.present.captionPreset.fontSize).toBe(44);
    expect(history.past).toHaveLength(1);

    history = undoEditor(history);
    expect(history.present.captionPreset.fontSize).toBe(36);
  });

  test("a different key after a gesture starts a new step", () => {
    let history = createEditorHistory(makeDocument());
    history = applyWithHistory(
      history,
      {
        type: "setCaptionPreset",
        captionPreset: { ...history.present.captionPreset, fontSize: 44 },
      },
      { coalesceKey: "caption.fontSize" },
    );
    history = applyWithHistory(history, {
      type: "setBrollUrl",
      brollUrl: "https://example.com/a.mp4",
    });
    expect(history.past).toHaveLength(2);
  });

  test("history is capped", () => {
    let history = createEditorHistory(makeDocument());
    for (let i = 0; i < EDITOR_HISTORY_LIMIT + 20; i += 1) {
      history = applyWithHistory(history, {
        type: "setBrollUrl",
        brollUrl: `https://example.com/${i}.mp4`,
      });
    }
    expect(history.past).toHaveLength(EDITOR_HISTORY_LIMIT);
  });

  test("no-op actions do not grow history", () => {
    let history = createEditorHistory(makeDocument());
    history = applyWithHistory(history, {
      type: "updateWordText",
      utteranceIndex: 9,
      wordIndex: 0,
      text: "x",
    });
    expect(history.past).toHaveLength(0);
  });

  // Fix 9 (unified-editor-history.ts's meta-undo stack): callers detect "did
  // this apply push a new past frame" via `past` reference INEQUALITY rather
  // than length growth, because length stops growing once the cap is hit.
  // These two tests pin down the two halves of that contract so a future
  // change to applyWithHistory can't silently break it.
  test("every non-coalesced apply produces a new `past` array reference, even at the cap", () => {
    let history = createEditorHistory(makeDocument());
    for (let i = 0; i < EDITOR_HISTORY_LIMIT + 5; i += 1) {
      const prevPast = history.past;
      history = applyWithHistory(history, {
        type: "setBrollUrl",
        brollUrl: `https://example.com/${i}.mp4`,
      });
      expect(history.past).not.toBe(prevPast);
    }
    expect(history.past).toHaveLength(EDITOR_HISTORY_LIMIT);
  });

  test("a coalesced apply at the cap keeps the exact same `past` reference", () => {
    let history = createEditorHistory(makeDocument());
    for (let i = 0; i < EDITOR_HISTORY_LIMIT + 5; i += 1) {
      history = applyWithHistory(history, {
        type: "setBrollUrl",
        brollUrl: `https://example.com/${i}.mp4`,
      });
    }
    // First apply of a NEW coalesceKey still pushes a frame (its predecessor
    // had no/a different key) — past length stays capped, but the reference
    // changes (asserted by the previous test). Only the SECOND apply with
    // the SAME key actually coalesces, which is what this test pins down.
    history = applyWithHistory(
      history,
      { type: "setCaptionPreset", captionPreset: { ...history.present.captionPreset, fontSize: 50 } },
      { coalesceKey: "caption.fontSize" },
    );
    const pastAfterFirstGestureTick = history.past;
    history = applyWithHistory(
      history,
      { type: "setCaptionPreset", captionPreset: { ...history.present.captionPreset, fontSize: 51 } },
      { coalesceKey: "caption.fontSize" },
    );
    expect(history.past).toBe(pastAfterFirstGestureTick);
    expect(history.past).toHaveLength(EDITOR_HISTORY_LIMIT);
  });
});
