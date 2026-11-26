import { describe, expect, test } from "bun:test";
import { buildEditedTimeMap, captionWordKey, type CaptionEmojiRef, type EditorDocument } from "@narriflow/validators";
import { emojiFixtureDocument, emojiFixtureManyLines } from "./caption-emoji-fixture";
import { captionEmojiLineView, createCaptionEmojiLines, selectCaptionEmojiLine, type CaptionEmojiLinesState } from "./caption-emoji-lines";
import { captionEmojiWords, placeCaptionEmojis } from "./caption-emoji-words";
import type { CaptionEmojiEditor } from "./use-caption-emojis";

const modelOf = (document: EditorDocument) =>
  captionEmojiWords(document, buildEditedTimeMap(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec }));

/** The parts of an editor the line chips read. */
function stateOf(document: EditorDocument, entries: Record<string, CaptionEmojiRef> | undefined, model = modelOf(document), typedEmojiCues: CaptionEmojiLinesState["typedEmojiCues"] = []): CaptionEmojiLinesState {
  const editor = { enabled: true, readOnly: false, palette: PALETTE, model, placement: placeCaptionEmojis(entries, model) } as unknown as CaptionEmojiEditor;
  return { editor, addContext: () => ({ playheadSec: Number.NaN, heroKeys: new Set() }), seek: null, typedEmojiCues };
}
const PALETTE = { primary: "#fff" } as unknown as CaptionEmojiEditor["palette"];

describe("line chips", () => {
  test("a line's chips: each emoji's word, why it does not draw, and whether Add can place one", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const cut = document.transcriptSlice[1]!.words[3]!;
    const withCut = { ...document, deletedRanges: [{ startSec: cut.startSec - 0.01, endSec: cut.endSec + 0.01 }] };
    const view = captionEmojiLineView(stateOf(withCut, withCut.studioEdits.captionEmojis), [1], "ltr");
    expect(view.chips.map((chip) => [chip.target.text, chip.hidden])).toEqual([["money", "cut"]]);
    expect(view.canAdd).toBe(true);
  });

  test("an emoji edit changes the view of only the line it touches (1,000 lines of 15 words)", () => {
    const document = emojiFixtureManyLines({ presetId: "bold-pop", lines: 1000, wordsPerLine: 15 });
    const model = modelOf(document);
    const entries = Object.fromEntries(document.transcriptSlice.filter((_, at) => at % 5 === 0).map((line) => [captionWordKey(line.words[3]!.startSec), { id: "flame" }]));
    const store = createCaptionEmojiLines();
    const caches = document.transcriptSlice.map((): Parameters<typeof selectCaptionEmojiLine>[1] => ({ current: null }));
    const lines = document.transcriptSlice.map((_, at) => [at]);
    store.set(stateOf(document, entries, model));
    let previous = lines.map((line, at) => selectCaptionEmojiLine(store, caches[at]!, line, "ltr"));

    const timings: number[] = [];
    let edited = entries;
    for (let round = 1; round <= 5; round++) {
      edited = { ...edited, [captionWordKey(document.transcriptSlice[round]!.words[2]!.startSec)]: { id: "party" } };
      const t = performance.now();
      store.set(stateOf(document, edited, model));
      const views = lines.map((line, at) => selectCaptionEmojiLine(store, caches[at]!, line, "ltr"));
      timings.push(performance.now() - t);
      // Each edit adds one emoji on line `round`: only that row gets a new view (and re-renders).
      expect(views.flatMap((view, at) => (view === previous[at] ? [] : [at]))).toEqual([round]);
      previous = views;
    }
    console.log(`1,000-line emoji edit, placement once + every row's selector: ${timings.map((ms) => ms.toFixed(1)).join(", ")} ms`);
  });
});
