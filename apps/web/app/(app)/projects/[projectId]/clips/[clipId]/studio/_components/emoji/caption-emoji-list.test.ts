import { describe, expect, test } from "bun:test";
import { buildEditedTimeMap, captionWordKey, type EditorDocument } from "@narriflow/validators";
import { emojiFixtureDocument } from "./caption-emoji-fixture";
import { captionEmojiListRows, currentCaptionEmojiRow } from "./caption-emoji-list";
import { captionEmojiWords, placeCaptionEmojis, type CaptionEmojiWords } from "./caption-emoji-words";

function modelOf(document: EditorDocument) {
  return captionEmojiWords(document, buildEditedTimeMap(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec }));
}

function rowsOf(document: EditorDocument, model: CaptionEmojiWords = modelOf(document)) {
  return captionEmojiListRows(model, placeCaptionEmojis(document.studioEdits.captionEmojis, model));
}

/** The fixture with its emojis stored in reverse time order (insertion order must not matter). */
function reversed(document: EditorDocument): EditorDocument {
  const entries = Object.entries(document.studioEdits.captionEmojis ?? {}).reverse();
  return { ...document, studioEdits: { ...document.studioEdits, captionEmojis: Object.fromEntries(entries) } };
}

describe("In this clip rows", () => {
  test("every shown emoji, earliest word first, with its word and time", () => {
    const document = reversed(emojiFixtureDocument({ presetId: "bold-pop" }));
    const rows = rowsOf(document);
    expect(rows.map((row) => [row.target.text, row.target.current.id])).toEqual([
      ["idea", "bulb"],
      ["money", "money-bag"],
      ["team", "busts-in-silhouette"],
      ["magic.", "sparkles"],
    ]);
    const starts = rows.map((row) => row.startSec);
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
    const idea = document.transcriptSlice[0]!.words[2]!;
    expect(rows[0]!.startSec).toBeCloseTo(idea.startSec - document.clipStartSec, 6);
    expect(rows[0]!.target.key).toBe(captionWordKey(idea.startSec));
  });

  test("an emoji on a cut word is left out, and later times shift", () => {
    const base = emojiFixtureDocument({ presetId: "bold-pop" });
    const idea = base.transcriptSlice[0]!.words[2]!;
    const document = { ...base, deletedRanges: [{ startSec: idea.startSec, endSec: idea.endSec }] };
    const rows = rowsOf(document);
    expect(rows.map((row) => row.target.text)).toEqual(["money", "team", "magic."]);
    expect(rows[0]!.startSec).toBeLessThan(rowsOf(base)[1]!.startSec);
  });

  test("an emoji on a censored word is left out", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const model = modelOf(document);
    const masked = { ...model, words: model.words.map((word) => (word.text === "money" ? { ...word, masked: true } : word)) };
    expect(rowsOf(document, masked).map((row) => row.target.text)).toEqual(["idea", "team", "magic."]);
  });

  test("right-to-left words keep their own text", () => {
    const rows = rowsOf(emojiFixtureDocument({ presetId: "bold-pop", rtl: true }));
    expect(rows.map((row) => row.target.text)).toEqual(["خیال", "پیسے", "ٹیم", "جادو"]);
  });

  test("no emojis, no rows", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    expect(rowsOf({ ...document, studioEdits: { ...document.studioEdits, captionEmojis: undefined } })).toEqual([]);
  });
});

describe("the current row", () => {
  const rows = rowsOf(emojiFixtureDocument({ presetId: "bold-pop" }));
  const [first, second] = rows;

  test("is the row whose word the playhead is on", () => {
    expect(currentCaptionEmojiRow(rows, first!.startSec)).toBe(0);
    expect(currentCaptionEmojiRow(rows, (first!.startSec + first!.endSec) / 2)).toBe(0);
    expect(currentCaptionEmojiRow(rows, second!.startSec + 0.01)).toBe(1);
  });

  test("a seek that comes back a hair early still marks the row", () => {
    expect(currentCaptionEmojiRow(rows, second!.startSec - 0.0004)).toBe(1);
  });

  test("none before the first word, between words or after the last", () => {
    expect(currentCaptionEmojiRow(rows, 0)).toBe(-1);
    expect(currentCaptionEmojiRow(rows, first!.endSec + 0.01)).toBe(-1);
    expect(currentCaptionEmojiRow(rows, rows.at(-1)!.endSec + 1)).toBe(-1);
    expect(currentCaptionEmojiRow([], 1)).toBe(-1);
  });
});
