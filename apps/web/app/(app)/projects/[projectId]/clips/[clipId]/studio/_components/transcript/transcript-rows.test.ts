import { describe, expect, test } from "bun:test";
import { deriveCaptionLines } from "@narriflow/composition-plan";
import { captionWordKey } from "@narriflow/validators";
import { replaceCaptionRowText, resolveCaptionRow } from "../subtitle-lines";
import { transcriptFixtureDocument } from "./transcript-fixture";
import { captionRows, formatCaptionTime, formatParagraphTime, paragraphRows } from "./transcript-rows";
import { filterRows, normalizeSearchQuery, searchMatches } from "./transcript-search";
import { activeRowAt } from "./use-active-row";

describe("activeRowAt", () => {
  const rows = [
    { startSec: 0.2, endSec: 0.9 },
    { startSec: 1.3, endSec: 1.6 },
    { startSec: 1.7, endSec: 2.9 },
    { startSec: 5, endSec: 6 },
  ];

  test("the row under the playhead, -1 before the first and in a gap", () => {
    expect([0, 0.2, 0.5, 0.9, 1.3, 1.65, 1.7, 2.95, 4, 5.5, 7].map((sec) => activeRowAt(rows, sec))).toEqual([-1, 0, 0, -1, 1, -1, 2, -1, -1, 3, -1]);
    expect(activeRowAt([], 1)).toBe(-1);
  });

  test("a short gap keeps the row before it, never past the next row's start", () => {
    expect([0.95, 1.65, 3.5, 4.5].map((sec) => activeRowAt(rows, sec, 1))).toEqual([0, 1, 2, -1]);
  });

  test("agrees with a linear scan over a 180 s clip", () => {
    const captions = captionRows(transcriptFixtureDocument({ seconds: 180 }), "en");
    for (let sec = 0; sec < 186; sec += 0.137) {
      const linear = captions.findIndex((row) => sec >= row.startSec && sec < row.endSec);
      expect(activeRowAt(captions, sec)).toBe(linear);
    }
  });
});

describe("search", () => {
  test("case-insensitive, with every match marked in the original text", () => {
    const query = normalizeSearchQuery("  YouTube ");
    expect(searchMatches("youtube, then YOUTUBE again", query)).toEqual([[0, 7], [14, 21]]);
  });

  test("Urdu typed with Arabic letter forms finds Urdu text", () => {
    const urdu = "پوری ٹیم کو یہ بہت پسند آیا";
    // Arabic yeh, heh and kaf in the queries; Farsi yeh, heh goal and keheh in the text.
    expect(searchMatches(urdu, normalizeSearchQuery("يه"))).toEqual([[12, 14]]);
    expect(filterRows([{ text: urdu }, { text: "سچ کہوں" }], normalizeSearchQuery("كہوں"))).toEqual([{ text: "سچ کہوں" }]);
  });

  test("Arabic diacritics and tatweel do not stop a match, and the mark covers them", () => {
    const text = "قَالَ الْمُعَلِّمُ";
    const ranges = searchMatches(text, normalizeSearchQuery("المعلم"));
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0]![0], ranges[0]![1])).toBe("الْمُعَلِّمُ");
    expect(searchMatches("كـتـاب", normalizeSearchQuery("كتاب"))).toEqual([[0, 6]]);
  });

  test("Hindi matches across composed and decomposed forms", () => {
    // क़ as one code point (U+0958) in the text, as क + nukta in the query.
    expect(searchMatches("यह क़िला है", normalizeSearchQuery("क़िला"))).toEqual([[3, 7]]);
  });

  test("an empty query keeps every row", () => {
    const rows = [{ text: "a" }, { text: "b" }];
    expect(filterRows(rows, "")).toBe(rows);
  });
});

describe("caption rows", () => {
  const document = transcriptFixtureDocument({ seconds: 60 });

  test("one row per caption on the video, with the transcript's own text", () => {
    const rows = captionRows(document, "en");
    const lines = deriveCaptionLines(document, { language: "en" });
    expect(rows).toHaveLength(lines.length);
    expect(rows.map((row) => [row.startSec, row.endSec])).toEqual(lines.map((line) => [line.startSec, line.endSec]));
    // The preset upper-cases its captions; a row keeps the words as typed, punctuation included.
    expect(rows[0]!.text).toBe("Of course.");
    expect(lines[0]!.text).not.toBe(rows[0]!.text);
  });

  test("each row owns its words' emojis, from its first word to the next caption's", () => {
    const rows = captionRows(document, "en");
    const byLine = new Map<number, [number, number][]>();
    for (const row of rows) {
      const span = row.spans[0]!;
      if (typeof span === "number") continue;
      byLine.set(span.line, [...(byLine.get(span.line) ?? []), [span.from, span.to]]);
    }
    for (const [line, spans] of byLine) {
      expect(spans[0]![0]).toBe(0);
      expect(spans.at(-1)![1]).toBe(document.transcriptSlice[line]!.words.length);
      for (const [at, [from]] of spans.slice(1).entries()) expect(from).toBe(spans[at]![1]);
    }
  });

  test("an edit gives new objects only to the rows it changed", () => {
    const before = captionRows(document, "en");
    const target = before[5]!;
    const row = resolveCaptionRow(document.transcriptSlice, target.address)!;
    const edited = replaceCaptionRowText(document.transcriptSlice, row, target.text.replace(/\w+/, "Totally")).lines;
    const after = captionRows({ ...document, transcriptSlice: edited }, "en", before);
    const changed = after.flatMap((next, at) => (next === before[at] ? [] : [at]));
    expect(changed).toEqual([5]);
  });

  test("an edit that adds a caption leaves the rows of other utterances as they were", () => {
    const before = captionRows(document, "en");
    const target = before[5]!;
    const row = resolveCaptionRow(document.transcriptSlice, target.address)!;
    const edited = replaceCaptionRowText(document.transcriptSlice, row, `${target.text} and then some more words here`).lines;
    const after = captionRows({ ...document, transcriptSlice: edited }, "en", before);
    expect(after.length).toBeGreaterThan(before.length);
    const changed = after.filter((next) => !before.includes(next));
    expect(changed.length).toBeGreaterThan(0);
    // Only the edited utterance's rows and the row before them (its "next" changed) are new.
    expect(changed.every((next) => next.address.utterance === target.address.utterance || next.next?.utterance === target.address.utterance)).toBe(true);
    expect(after.filter((next) => before.includes(next)).length).toBeGreaterThan(before.length - 10);
  });

  test("a row addresses its words by Word Key", () => {
    const [first] = captionRows(document, "en");
    expect(first!.address).toEqual({ utterance: 0, keys: document.transcriptSlice[0]!.words.map((word) => captionWordKey(word.startSec)) });
  });

  test("paragraphs start at their first caption and end where the next begins", () => {
    const captions = captionRows(document, "en");
    const paragraphs = paragraphRows(document, captions, 60);
    expect(paragraphs[0]!.startSec).toBe(captions[0]!.startSec);
    for (const [at, paragraph] of paragraphs.slice(1).entries()) expect(paragraphs[at]!.endSec).toBe(paragraph.startSec);
    expect(paragraphs.flatMap((paragraph) => paragraph.lines)).toEqual(document.transcriptSlice.map((_, at) => at));
    expect(paragraphRows(document, captions, 60, paragraphs)).toEqual(paragraphs);
    expect(paragraphRows(document, captions, 60, paragraphs)[0]).toBe(paragraphs[0]);
  });

  test("times read as on the video", () => {
    expect(formatCaptionTime(0)).toBe("00:00.00");
    expect(formatCaptionTime(72.346)).toBe("01:12.35");
    expect(formatParagraphTime(72.9)).toBe("01:12");
  });
});
