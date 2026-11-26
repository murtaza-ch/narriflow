import { describe, expect, test } from "bun:test";
import { joinTranscriptWords, type TranscriptUtterance } from "@narriflow/validators";
import {
  labelForTimelineSegment,
  PARAGRAPH_MAX_WORDS,
  PARAGRAPH_PAUSE_SEC,
  replaceSubtitleParagraphText,
  subtitleParagraphGroups,
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
  test("rewrites a paragraph atomically while keeping each line timing", () => {
    const next = replaceSubtitleParagraphText(lines, [0, 1], "One polished paragraph here");
    expect(next.map((line) => line.text).join(" ")).toBe("One polished paragraph here");
    expect(next[0]!.startSec).toBe(10);
    expect(next[1]!.endSec).toBe(12);
  });

  test("splits and rejoins a Chinese paragraph edit without whitespace", () => {
    const zh = lines.map((line, index) => ({
      ...line,
      text: index === 0 ? "你好世界" : "今天天气",
      words: line.words.map((word) => ({ ...word, word: "字" })),
    }));
    const next = replaceSubtitleParagraphText(zh, [0, 1], "我们今天去公园玩");
    expect(next).toHaveLength(2);
    expect(next.map((line) => line.text).join("")).toBe("我们今天去公园玩");
    expect(next.every((line) => !/\s/.test(line.text))).toBe(true);
    expect(next[0]!.startSec).toBe(10);
    expect(next[1]!.endSec).toBe(12);
    expect(replaceSubtitleParagraphText(zh, [0, 1], "好")).toBe(zh);
  });

  test("keeps Japanese runs together with an embedded Latin word and spaces", () => {
    const next = replaceSubtitleParagraphText(lines, [0, 1], "今日は AI を使う");
    const joined = joinTranscriptWords(next.flatMap((line) => line.words.map(({ word, spaceBefore }) => ({ word, spaceBefore }))));
    expect(next.map((line) => line.text).join(" ")).toContain("AI");
    expect(joined.replace(/\s/g, "")).toBe("今日はAIを使う");
  });

  test("rejects paragraph rewrites that cannot leave one word per timed line", () => {
    expect(replaceSubtitleParagraphText(lines, [0, 1], "Too-short")).toBe(lines);
  });
});

describe("subtitleParagraphGroups", () => {
  const line = (index: number, startSec: number, words: number, speaker = 0): TranscriptUtterance => ({
    index, speaker, speakerLabel: `Speaker ${speaker + 1}`, startSec, endSec: startSec + words * 0.3, text: "word ".repeat(words).trim(), confidence: 1,
    words: Array.from({ length: words }, (_, at) => ({ word: "word", startSec: startSec + at * 0.3, endSec: startSec + at * 0.3 + 0.25, confidence: 1 })),
  });

  test("breaks at a speaker change and at a pause that reads as a new thought", () => {
    const at = (lines: TranscriptUtterance[]) => subtitleParagraphGroups(lines);
    expect(at([line(0, 0, 5), line(1, 1.6, 5), line(2, 3.2, 5, 1)])).toEqual([[0, 1], [2]]);
    expect(at([line(0, 0, 5), line(1, 1.5 + PARAGRAPH_PAUSE_SEC, 5)])).toEqual([[0], [1]]);
  });

  test("a single speaker who never pauses does not become one giant paragraph", () => {
    const lines = Array.from({ length: 12 }, (_, index) => line(index, index * 6.05, 20));
    const groups = subtitleParagraphGroups(lines);
    expect(groups.length).toBeGreaterThan(4);
    for (const group of groups) expect(group.length * 20).toBeLessThanOrEqual(PARAGRAPH_MAX_WORDS);
    expect(groups.flat()).toEqual(lines.map((_, index) => index));
  });

  test("an utterance longer than the cap is a paragraph of its own", () => {
    expect(subtitleParagraphGroups([line(0, 0, 80), line(1, 24.1, 5)])).toEqual([[0], [1]]);
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
