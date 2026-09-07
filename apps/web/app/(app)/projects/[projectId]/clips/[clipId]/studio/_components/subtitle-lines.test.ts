import { describe, expect, test } from "bun:test";
import type { TranscriptUtterance } from "@narriflow/validators";
import {
  addSubtitleLineAfter,
  deleteSubtitleLine,
  labelForTimelineSegment,
  mergeSubtitleLineWithNext,
  replaceSubtitleLineText,
  replaceSubtitleParagraphText,
} from "./subtitle-lines";

const lines: TranscriptUtterance[] = [
  {
    index: 0,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec: 10,
    endSec: 11,
    text: "The first",
    confidence: 0.9,
    words: [
      { word: "The", startSec: 10, endSec: 10.4, confidence: 0.9 },
      { word: "first", startSec: 10.4, endSec: 11, confidence: 0.9 },
    ],
  },
  {
    index: 1,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec: 11,
    endSec: 12,
    text: "real sentence",
    confidence: 0.9,
    words: [
      { word: "real", startSec: 11, endSec: 11.5, confidence: 0.9 },
      { word: "sentence", startSec: 11.5, endSec: 12, confidence: 0.9 },
    ],
  },
];

describe("subtitle line operations", () => {
  test("rewrites one line while preserving its timing", () => {
    const next = replaceSubtitleLineText(lines, 0, "A replacement line");
    expect(next[0]!.text).toBe("A replacement line");
    expect(next[0]!.words[0]!.startSec).toBe(10);
    expect(next[0]!.words.at(-1)!.endSec).toBe(11);
  });

  test("deletes only subtitle metadata and reindexes", () => {
    const next = deleteSubtitleLine(lines, 0);
    expect(next).toHaveLength(1);
    expect(next[0]!.text).toBe("real sentence");
    expect(next[0]!.index).toBe(0);
  });

  test("adds a short visible placeholder at the following boundary", () => {
    const next = addSubtitleLineAfter(lines, 0);
    expect(next[1]!.text).toBe("Subtitle here");
    expect(next[1]!.startSec).toBe(11);
    expect(next[1]!.endSec).toBe(11.25);
  });

  test("merges adjacent lines using the outer timing bounds", () => {
    const next = mergeSubtitleLineWithNext(lines, 0);
    expect(next).toHaveLength(1);
    expect(next[0]!.text).toBe("The first real sentence");
    expect(next[0]!.startSec).toBe(10);
    expect(next[0]!.endSec).toBe(12);
  });

  test("rewrites a paragraph atomically while keeping each line timing", () => {
    const next = replaceSubtitleParagraphText(lines, [0, 1], "One polished paragraph here");
    expect(next.map((line) => line.text).join(" ")).toBe("One polished paragraph here");
    expect(next[0]!.startSec).toBe(10);
    expect(next[1]!.endSec).toBe(12);
  });

  test("rejects paragraph rewrites that cannot leave one word per timed line", () => {
    expect(replaceSubtitleParagraphText(lines, [0, 1], "Too-short")).toBe(lines);
  });
});

describe("labelForTimelineSegment", () => {
  test("uses the words whose midpoints belong to each split half", () => {
    expect(labelForTimelineSegment(lines, 10, 0, 1, "stale")).toBe("The first");
    expect(labelForTimelineSegment(lines, 10, 1, 2, "stale")).toBe("real sentence");
  });

  test("uses a time range for a tiny split fragment instead of duplicating stale text", () => {
    expect(labelForTimelineSegment(lines, 10, 0, 0.1, "The first")).toBe("0.00–0.10s");
  });
});
