import { describe, expect, test } from "bun:test";
import { detectAutoCensorSuggestions } from "./auto-censor";
import { groupCaptionTokens } from "./caption-cues";
import { applyCaptionTextTransform } from "./caption-preset";
import { normalizeTranscriptSliceForClip } from "./clip-timing";
import { parseSuppliedCaptions } from "./supplied-captions";
import { hasSpaceBefore, splitSpacedTokens } from "./text-script";
import type { TranscriptUtterance } from "./transcript";

function utterance(
  words: { word: string; startSec: number; endSec: number; spaceBefore?: boolean }[],
  text = words.map((w) => w.word).join(""),
): TranscriptUtterance {
  return {
    index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9,
    startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, text,
    words: words.map((w) => ({ confidence: 0.9, ...w })),
  };
}

describe("normalizeTranscriptSliceForClip keeps provider tokens", () => {
  test("a zero-duration interior word survives; the half-open window excludes one at the end", () => {
    const slice = normalizeTranscriptSliceForClip([utterance([
      { word: "今", startSec: 1, endSec: 1.2 },
      { word: "天", startSec: 1.2, endSec: 1.2 },
      { word: "好", startSec: 1.2, endSec: 1.4 },
      { word: "。", startSec: 2, endSec: 2 },
    ])], 1, 2);
    expect(slice).toHaveLength(1);
    expect(slice[0]!.words.map((w) => w.word)).toEqual(["今", "天", "好"]);
    expect(slice[0]!.text).toBe("今天好");
  });

  test("a zero-duration word at the window start is kept", () => {
    const slice = normalizeTranscriptSliceForClip([utterance([
      { word: "は", startSec: 1, endSec: 1 },
      { word: "い", startSec: 1, endSec: 1.3 },
    ])], 1, 2);
    expect(slice[0]!.words.map((w) => w.word)).toEqual(["は", "い"]);
  });

  test("a window holding only a zero-duration word still yields the utterance", () => {
    const slice = normalizeTranscriptSliceForClip([utterance([{ word: "ก", startSec: 3, endSec: 3 }])], 3, 4);
    expect(slice.map((u) => u.text)).toEqual(["ก"]);
  });

  test("an edge sliver created by clamping is dropped, a word that merely ends inside is kept", () => {
    const slice = normalizeTranscriptSliceForClip([utterance([
      { word: "a", startSec: 0.5, endSec: 1.005 },
      { word: "b", startSec: 1.2, endSec: 1.4 },
      { word: "c", startSec: 1.995, endSec: 2.5 },
    ], "a b c")], 1, 2);
    expect(slice[0]!.words.map((w) => w.word)).toEqual(["b"]);
  });

  test("rebuilt text follows provider spacing", () => {
    const slice = normalizeTranscriptSliceForClip([utterance([
      { word: "私", startSec: 0, endSec: 0.2 },
      { word: "は", startSec: 0.2, endSec: 0.4 },
      { word: "Google", startSec: 0.4, endSec: 0.8, spaceBefore: false },
      { word: "を", startSec: 0.8, endSec: 1, spaceBefore: false },
    ])], 0, 2);
    expect(slice[0]!.text).toBe("私はGoogleを");
  });
});

describe("groupCaptionTokens", () => {
  test("spaced words keep wordsPerCue words per cue", () => {
    const groups = groupCaptionTokens(["a", "b", "c", "d", "e", "f", "g"], 3);
    expect(groups).toEqual([{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 7 }]);
  });

  test("per-character Chinese fills a cue by character budget", () => {
    const tokens = Array.from("今天天气很好我们去公园");
    expect(groupCaptionTokens(tokens, 3).map((g) => g.end - g.start)).toEqual([6, 5]);
  });

  test("CJK punctuation stays with the character before it", () => {
    const tokens = [..."今天天气很好", "。", ..."我们"];
    const groups = groupCaptionTokens(tokens, 3);
    expect(groups[0]).toEqual({ start: 0, end: 7 });
  });

  test("a mixed run charges Latin words as words and kana as characters", () => {
    const tokens = ["私", "は", "Google", "を", "使", "う"];
    expect(groupCaptionTokens(tokens, 3)).toEqual([{ start: 0, end: 5 }, { start: 5, end: 6 }]);
  });

  test("a multi-character Thai word costs one word, so wordsPerCue Thai words share a cue", () => {
    expect(groupCaptionTokens(["สวัสดี", "ครับ", "วันนี้", "อากาศ"], 3)).toEqual([
      { start: 0, end: 3 }, { start: 3, end: 4 },
    ]);
  });

  test("single CJK characters cost half a word", () => {
    expect(groupCaptionTokens(["今", "天", "天", "气", "很", "好", "啊"], 3)).toEqual([
      { start: 0, end: 6 }, { start: 6, end: 7 },
    ]);
  });

  test("always makes progress and covers every token", () => {
    expect(groupCaptionTokens(["日本語日本語日本語日本語"], 1)).toEqual([{ start: 0, end: 1 }]);
    expect(groupCaptionTokens([], 3)).toEqual([]);
  });
});

describe("tokens and spacing helpers", () => {
  test("splitSpacedTokens marks real spaces the script rule would drop", () => {
    expect(splitSpacedTokens("สวัสดีครับ วันนี้")).toEqual([{ word: "สวัสดีครับ" }, { word: "วันนี้", spaceBefore: true }]);
    expect(splitSpacedTokens("hello world")).toEqual([{ word: "hello" }, { word: "world" }]);
    expect(splitSpacedTokens("今天天气")).toEqual([{ word: "今天天气" }]);
  });

  test("hasSpaceBefore agrees with joinTranscriptWords", () => {
    expect(hasSpaceBefore("今", { word: "天" })).toBe(false);
    expect(hasSpaceBefore("今", { word: "天", spaceBefore: true })).toBe(true);
    expect(hasSpaceBefore("hello", { word: "there" })).toBe(true);
  });
});

describe("supplied captions in no-space scripts", () => {
  test("lines of a Chinese cue join without a space and the cue is one timed span", () => {
    const [cue] = parseSuppliedCaptions("1\n00:00:00,000 --> 00:00:02,000\n今天天气\n很好。");
    expect(cue!.text).toBe("今天天气很好。");
    expect(cue!.words.map((w) => w.word)).toEqual(["今天天气很好。"]);
  });

  test("Thai phrases keep their spaces", () => {
    const [cue] = parseSuppliedCaptions("1\n00:00:00,000 --> 00:00:02,000\nสวัสดีครับ วันนี้อากาศดี");
    expect(cue!.words.map((w) => w.word)).toEqual(["สวัสดีครับ", "วันนี้อากาศดี"]);
    expect(cue!.words[1]!.spaceBefore).toBe(true);
  });
});

describe("caption casing follows the language", () => {
  test("Turkish dotted and dotless I", () => {
    expect(applyCaptionTextTransform("istanbul ılık", "uppercase", "tr")).toBe("İSTANBUL ILIK");
    expect(applyCaptionTextTransform("istanbul", "uppercase", "en")).toBe("ISTANBUL");
    expect(applyCaptionTextTransform("istanbul", "uppercase")).toBe("ISTANBUL");
  });

  test("German sharp s and caseless scripts", () => {
    expect(applyCaptionTextTransform("straße", "uppercase", "de")).toBe("STRASSE");
    expect(applyCaptionTextTransform("今天好", "uppercase", "zh")).toBe("今天好");
    expect(applyCaptionTextTransform("ქართული", "uppercase", "ka")).toBe("ქართული");
  });

  test("capitalize uses the language's rules for the first letter", () => {
    expect(applyCaptionTextTransform("istanbul iyi", "capitalize", "tr")).toBe("İstanbul İyi");
  });
});

describe("auto-censor keeps combining marks", () => {
  test("matches a Hindi term that ends in a vowel sign", () => {
    const word = "कुत्ता";
    const suggestions = detectAutoCensorSuggestions({
      documentRevision: 0, locale: "hi", clipWindow: { startSec: 0, endSec: 3 },
      transcript: [utterance([
        { word: "वह", startSec: 0, endSec: 0.5 },
        { word: `${word}।`, startSec: 0.5, endSec: 1 },
      ], `वह ${word}।`)],
      workspaceTerms: [word], brandTerms: [], projectTerms: [], paddingSec: 0,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.matchedText).toBe(`${word}।`);
  });

  test("context text joins without spurious spaces", () => {
    const suggestions = detectAutoCensorSuggestions({
      documentRevision: 0, locale: "und", clipWindow: { startSec: 0, endSec: 3 },
      transcript: [utterance([
        { word: "今", startSec: 0, endSec: 0.5 },
        { word: "天", startSec: 0.5, endSec: 1 },
        { word: "笨", startSec: 1, endSec: 1.5 },
        { word: "蛋", startSec: 1.5, endSec: 2 },
      ])],
      workspaceTerms: [], brandTerms: [], projectTerms: ["笨 蛋"], paddingSec: 0,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.matchedText).toBe("笨蛋");
    expect(suggestions[0]!.contextBefore).toBe("今天");
  });
});
