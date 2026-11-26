import { describe, expect, test } from "bun:test";
import { deriveCaptionCues, deriveCaptionLines } from "@narriflow/composition-plan";
import {
  applyEditorAction,
  applyWithHistory,
  captionPresetSchema,
  captionWordKey,
  createEditorHistory,
  editorDocumentSchema,
  joinTranscriptWords,
  studioEditsSchema,
  undoEditor,
  type EditorDocument,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { captionRowAddress, mergeSubtitleLineWithNext } from "./subtitle-lines";
import { captionRowCommandActions, mergeCrossesSceneSplit, type CaptionRowCommand } from "./subtitle-row-commands";
import { transcriptFixtureDocument } from "./transcript/transcript-fixture";
import { captionRows } from "./transcript/transcript-rows";

type Word = [word: string, startSec: number, endSec: number];

function utterance(index: number, words: Word[], speaker = 0): TranscriptUtterance {
  return {
    index, speaker, speakerLabel: `Speaker ${speaker + 1}`, startSec: words[0]![1], endSec: words.at(-1)![2],
    text: joinTranscriptWords(words.map(([word]) => ({ word }))), confidence: 1,
    words: words.map(([word, startSec, endSec]) => ({ word, startSec, endSec, confidence: 1 })),
  };
}

// At 3 words per cue: "We threw" / "a huge party" / "for the whole team." / "Everyone came."
const LINE: Word[] = [
  ["We", 1.0, 1.2], ["threw", 1.25, 1.5], ["a", 1.55, 1.6], ["huge", 1.65, 1.9], ["party", 2.0, 2.4],
  ["for", 2.45, 2.6], ["the", 2.65, 2.75], ["whole", 2.8, 3.1], ["team.", 3.15, 3.6],
];
const NEXT: Word[] = [["Everyone", 4.0, 4.5], ["came.", 4.55, 5.0]];
const key = (sec: number) => captionWordKey(sec);

function base(extra: Partial<EditorDocument["studioEdits"]> = {}): EditorDocument {
  return editorDocumentSchema.parse({
    version: 1, clipStartSec: 0, clipEndSec: 6, captionPreset: captionPresetSchema.parse({ wordsPerCue: 3, textTransform: "none" }),
    transcriptSlice: [utterance(0, LINE), utterance(1, NEXT, 1)],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, ...extra }),
    brollUrl: null, deletedRanges: [],
  });
}

const run = (document: EditorDocument, command: CaptionRowCommand) => captionRowCommandActions(document, command).reduce(applyEditorAction, document);
const texts = (document: EditorDocument) => captionRows(document, "en").map((row) => row.text);
const mergeAt = (document: EditorDocument, at: number): CaptionRowCommand => {
  const rows = captionRows(document, "en");
  return { type: "merge-next", row: rows[at]!.address, next: rows[at]!.next! };
};

describe("Merge with next", () => {
  test("two captions of one utterance become one caption on the video and in the list; every word keeps its time", () => {
    const document = base();
    expect(texts(document)).toEqual(["We threw", "a huge party", "for the whole team.", "Everyone came."]);
    const merged = run(document, mergeAt(document, 1));
    expect(texts(merged)).toEqual(["We threw", "a huge party for the whole team.", "Everyone came."]);
    expect(deriveCaptionLines(merged).map((line) => line.text)).toEqual(deriveCaptionCues(merged).map((cue) => cue.text));
    expect(merged.transcriptSlice).toBe(document.transcriptSlice);
    expect(merged.studioEdits.captionMerges).toEqual({ [key(1.55)]: key(3.15) });
  });

  test("captions in two utterances join them, keeping every word object and time, and show as one caption", () => {
    const document = base();
    const merged = run(document, mergeAt(document, 2));
    expect(texts(merged)).toEqual(["We threw", "a huge party", "for the whole team. Everyone came."]);
    expect(deriveCaptionCues(merged).map((cue) => cue.text)).toEqual(texts(merged));
    expect(merged.transcriptSlice).toHaveLength(1);
    expect(merged.transcriptSlice[0]!.words).toEqual([...document.transcriptSlice[0]!.words, ...document.transcriptSlice[1]!.words]);
    merged.transcriptSlice[0]!.words.forEach((word, at) => {
      expect(word).toBe([...document.transcriptSlice[0]!.words, ...document.transcriptSlice[1]!.words][at]!);
    });
  });

  test("every merge holds on the video and in the list; one inside an utterance leaves every other caption as it was (180 s fixture)", () => {
    for (const presetId of ["bold-pop", "headline"]) {
      const document = transcriptFixtureDocument({ seconds: 180, presetId });
      const rows = captionRows(document, "en");
      const before = rows.map((row) => row.text);
      rows.slice(0, -1).forEach((row, at) => {
        const merged = run(document, { type: "merge-next", row: row.address, next: row.next! });
        const after = texts(merged);
        expect(after[at]).toBe(`${before[at]} ${before[at + 1]}`);
        expect(after.slice(0, at)).toEqual(before.slice(0, at));
        expect(deriveCaptionLines(merged).map((line) => line.startSec)).toEqual(deriveCaptionCues(merged).map((cue) => cue.startSec));
        if (row.next!.utterance === row.address.utterance) expect(after.slice(at + 1)).toEqual(before.slice(at + 2));
      });
    }
  });

  test("merging a merged caption again extends it; words around it keep their captions", () => {
    const once = run(base(), mergeAt(base(), 1));
    const twice = run(once, mergeAt(once, 1));
    expect(texts(twice)).toEqual(["We threw", "a huge party for the whole team. Everyone came."]);
    expect(Object.keys(twice.studioEdits.captionMerges!)).toEqual([key(1.55)]);
  });

  test("a merged caption stays merged when its text is edited with more words, and its neighbours are untouched", () => {
    const merged = run(base(), mergeAt(base(), 1));
    const row = captionRows(merged, "en")[1]!;
    const edited = run(merged, { type: "edit", row: row.address, text: "a really huge party for the whole team." });
    expect(texts(edited)).toEqual(["We threw", "a really huge party for the whole team.", "Everyone came."]);
    // Emptied, the merge has no words left and the list regroups on its own.
    const emptied = run(edited, { type: "delete", row: captionRows(edited, "en")[1]!.address });
    expect(texts(emptied)).toEqual(["We threw", "Everyone came."]);
  });

  test("emojis and emphasis on the merged words survive", () => {
    const document = base({ captionEmojis: { [key(2.0)]: { id: "party", word: "party" } }, captionEmphasis: { [key(2.8)]: "hero" } });
    const merged = run(document, mergeAt(document, 1));
    expect(merged.studioEdits.captionEmojis).toEqual(document.studioEdits.captionEmojis);
    expect(merged.studioEdits.captionEmphasis).toEqual(document.studioEdits.captionEmphasis);
    const across = run(document, mergeAt(document, 2));
    expect(across.studioEdits.captionEmojis).toEqual(document.studioEdits.captionEmojis);
    expect(across.studioEdits.captionEmphasis).toEqual(document.studioEdits.captionEmphasis);
  });

  test("one merge is one undo step", () => {
    const document = base();
    const actions = captionRowCommandActions(document, mergeAt(document, 2));
    expect(actions.map((action) => action.type)).toEqual(["setTranscriptSlice", "setStudioEdits"]);
    let history = createEditorHistory(document);
    for (const action of actions) history = applyWithHistory(history, action, { coalesceKey: "caption-row:1" });
    expect(history.past).toHaveLength(1);
    expect(undoEditor(history).present).toBe(document);
  });

  test("the last row has nothing to merge with; a timed and an untimed caption cannot merge", () => {
    const rows = captionRows(base(), "en");
    expect(rows.at(-1)!.next).toBeNull();
    expect(rows.at(-1)!.mergeable).toBe(false);
    const untimed = { ...base(), transcriptSlice: [utterance(0, LINE), { ...utterance(1, NEXT, 1), words: [] }] };
    const mixed = captionRows(untimed, "en");
    expect(mixed.at(-2)!.mergeable).toBe(false);
    expect(captionRowCommandActions(untimed, { type: "merge-next", row: mixed.at(-2)!.address, next: mixed.at(-1)!.next ?? mixed.at(-1)!.address })).toEqual([]);
  });

  test("a merge across a manual scene split is refused", () => {
    const document = base();
    const slice = document.transcriptSlice;
    const last = captionRowAddress(slice, { utterance: 0, words: [6, 7, 8] });
    const next = captionRowAddress(slice, { utterance: 1, words: [0, 1] });
    expect(mergeCrossesSceneSplit(slice, last, next, [{ id: "seg-1-b", startSec: 3.8 }], 0)).toBe(true);
    expect(mergeCrossesSceneSplit(slice, last, next, [{ id: "seg-1", startSec: 3.8 }], 0)).toBe(false);
    expect(mergeCrossesSceneSplit(slice, last, next, [{ id: "seg-2-b", startSec: 1.0 }], 0)).toBe(false);
  });

  test("joining utterances keeps word objects (censor marks follow them)", () => {
    const slice = base().transcriptSlice;
    const joined = mergeSubtitleLineWithNext(slice, 0);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.words[9]).toBe(slice[1]!.words[0]!);
    expect(joined[0]!.text).toBe("We threw a huge party for the whole team. Everyone came.");
  });
});
