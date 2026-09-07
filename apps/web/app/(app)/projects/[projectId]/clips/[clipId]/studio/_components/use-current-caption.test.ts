import { describe, expect, test } from "bun:test";
import { buildEditedTimeMap, sourceToEdited } from "@narriflow/validators";
import type { TranscriptUtterance } from "@narriflow/validators";
import { getCurrentCaptionState } from "./use-current-caption";

// Vizard-parity Phase B hardening, fix 1: getCurrentCaptionState used to
// chunk the RAW utterance.words, while the worker's own
// generateSrtFromSlice/generateAssFromSlice (apps/worker/src/tasks/
// render-clips.ts) drop fully-deleted words BEFORE chunking. These tests
// pin the preview's word filtering to the exact same predicate the worker
// uses (`sourceRangeToEdited(...) !== null`), so a mid-utterance deletion
// can't leave the preview showing a deleted word or a chunk boundary that
// disagrees with what actually gets burned into the export.

function makeUtterance(words: Array<[string, number, number]>): TranscriptUtterance {
  return {
    index: 0,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec: words[0]![1],
    endSec: words[words.length - 1]![2],
    text: words.map(([w]) => w).join(" "),
    confidence: 0.95,
    words: words.map(([word, startSec, endSec]) => ({
      word,
      startSec,
      endSec,
      confidence: 0.95,
    })),
  };
}

describe("getCurrentCaptionState — deleted-word filtering (worker fixture parity)", () => {
  // Mirrors the exact fixture in apps/worker/src/tasks/render-clips.test.ts
  // (~line 1424): window 0-30, a single cut [10,15), and an utterance whose
  // middle word falls fully inside that cut. The worker's own test asserts
  // generateSrtFromSlice emits "before after" (not "before gone after") with
  // "after" retimed onto the edited timeline at 16s — this test asserts the
  // STUDIO PREVIEW agrees.
  const map = buildEditedTimeMap([{ startSec: 10, endSec: 15 }], { startSec: 0, endSec: 30 });
  const utterance = makeUtterance([
    ["before", 4, 5],
    ["gone", 11, 12], // fully inside the deleted [10,15) range
    ["after", 20, 21],
  ]);

  test("the deleted word never appears in visibleWords, at any playback position", () => {
    for (const editedTime of [sourceToEdited(map, 4.5), sourceToEdited(map, 20.5)]) {
      const state = getCurrentCaptionState(editedTime, [utterance], 0, map);
      expect(state).not.toBeNull();
      expect(state!.visibleWords.map((w) => w.word)).not.toContain("gone");
    }
  });

  test("while 'after' is active, the visible chunk is exactly ['before','after'] — matching the worker's 'before after' SRT cue", () => {
    // toEdited(20) = editedStart(10) + (20 - 15) = 15 (see the worker test's
    // own comment) — land just after that so "after" is the active word.
    const editedTime = sourceToEdited(map, 20.2);
    const state = getCurrentCaptionState(editedTime, [utterance], 0, map);

    expect(state).not.toBeNull();
    expect(state!.visibleWords.map((w) => w.word)).toEqual(["before", "after"]);
    expect(state!.visibleWords.map((w) => w.isActive)).toEqual([false, true]);
  });

  test("without an editedTimeMap, behavior is unchanged (the deleted word still shows) — matching generateSrtFromSlice's own no-map fallback", () => {
    const state = getCurrentCaptionState(20.2, [utterance], 0, undefined);
    expect(state).not.toBeNull();
    expect(state!.visibleWords.map((w) => w.word)).toEqual(["before", "gone", "after"]);
  });
});

describe("getCurrentCaptionState — chunk-boundary drift across a mid-utterance deletion", () => {
  // 5 words, 1s apart, CAPTION_CHUNK_SIZE=3: "gone" (index 1) sits exactly on
  // a cut. Filtered survivors are [one, three, four, five] -> chunk 0 =
  // [one, three, four], chunk 1 = [five]. Unfiltered (the pre-fix bug), chunk
  // boundaries are computed over the raw 5-word list instead, so once "four"
  // becomes active (raw index 3) the old code emitted chunk [four, five] —
  // dropping "one"/"three" and never showing "gone" as gone, just silently
  // wrong. This is the "every later chunk boundary shifts" case.
  const window = { startSec: 0, endSec: 5 };
  const map = buildEditedTimeMap([{ startSec: 1, endSec: 2 }], window);
  const utterance = makeUtterance([
    ["one", 0, 1],
    ["gone", 1, 2],
    ["three", 2, 3],
    ["four", 3, 4],
    ["five", 4, 5],
  ]);

  test("the chunk containing the active word is computed over the FILTERED word list", () => {
    // source 3.5 ("four" is active) -> edited sourceToEdited(map, 3.5).
    const editedTime = sourceToEdited(map, 3.5);
    const state = getCurrentCaptionState(editedTime, [utterance], 0, map);

    expect(state).not.toBeNull();
    expect(state!.visibleWords.map((w) => w.word)).toEqual(["one", "three", "four"]);
    expect(state!.visibleWords.map((w) => w.isActive)).toEqual([false, false, true]);
  });

  test("the trailing chunk after the drift point is also correct", () => {
    const editedTime = sourceToEdited(map, 4.5); // "five" active
    const state = getCurrentCaptionState(editedTime, [utterance], 0, map);

    expect(state).not.toBeNull();
    expect(state!.visibleWords.map((w) => w.word)).toEqual(["five"]);
    expect(state!.visibleWords[0]!.isActive).toBe(true);
  });
});
