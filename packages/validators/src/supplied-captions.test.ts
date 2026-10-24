import { describe, expect, test } from "bun:test";
import { transcriptUtteranceSchema } from "./transcript";
import {
  fitSuppliedUtterances,
  parseSuppliedCaptions,
  SUPPLIED_CAPTIONS_MAX_BYTES,
  SUPPLIED_CAPTIONS_MAX_CUES,
  SuppliedCaptionsError,
} from "./supplied-captions";

const failure = (text: string) => {
  try {
    parseSuppliedCaptions(text);
  } catch (error) {
    if (error instanceof SuppliedCaptionsError) return error;
    throw error;
  }
  throw new Error("expected supplied captions to be refused");
};

describe("supplied captions", () => {
  test("SRT becomes utterances whose words fill each cue and parse as the transcript model", () => {
    const utterances = parseSuppliedCaptions("1\n00:00:01,000 --> 00:00:03,500\nHello there, world\n\n2\n00:00:04,000 --> 00:00:05,000\nBye");
    expect(utterances.map((utterance) => transcriptUtteranceSchema.parse(utterance))).toEqual(utterances);
    expect(utterances).toHaveLength(2);
    const [first, second] = utterances;
    expect(first).toMatchObject({ index: 0, speaker: null, speakerLabel: "Speaker", startSec: 1, endSec: 3.5, text: "Hello there, world", confidence: null });
    expect(first!.words.map((word) => word.word)).toEqual(["Hello", "there,", "world"]);
    expect(first!.words[0]!.startSec).toBe(1);
    expect(first!.words.at(-1)!.endSec).toBe(3.5);
    for (const [index, word] of first!.words.entries()) {
      expect(word.endSec).toBeGreaterThan(word.startSec);
      if (index > 0) expect(word.startSec).toBe(first!.words[index - 1]!.endSec);
    }
    expect(second).toMatchObject({ index: 1, startSec: 4, endSec: 5, words: [{ word: "Bye", startSec: 4, endSec: 5 }] });
  });

  test("WebVTT with a header, notes, cue identifiers, short timestamps, settings, tags, and entities", () => {
    const utterances = parseSuppliedCaptions([
      "﻿WEBVTT - a film",
      "",
      "NOTE this block is ignored",
      "",
      "intro",
      "00:01.000 --> 00:02.000 align:start position:0%",
      "<v Narrator>Fish &amp; <i>chips</i> &lt;now&gt;</v>",
      "",
      "00:00:02.000 --> 00:00:03.000",
      "second {\\an8}line",
      "continues",
    ].join("\r\n"));
    expect(utterances.map((utterance) => utterance.text)).toEqual(["Fish & chips <now>", "second line continues"]);
    expect(utterances.map((utterance) => [utterance.startSec, utterance.endSec])).toEqual([[1, 2], [2, 3]]);
  });

  test("cues are sorted, merged when they start together, and trimmed so captions never overlap", () => {
    const utterances = parseSuppliedCaptions([
      "1\n00:00:05,000 --> 00:00:08,000\nlater",
      "2\n00:00:00,000 --> 00:00:04,000\nfirst",
      "3\n00:00:03,000 --> 00:00:04,500\noverlapping",
      "4\n00:00:03,100 --> 00:00:04,000\nsame moment",
    ].join("\n\n"));
    expect(utterances.map((utterance) => [utterance.startSec, utterance.endSec, utterance.text])).toEqual([
      [0, 3, "first"],
      [3, 4.5, "overlapping same moment"],
      [5, 8, "later"],
    ]);
  });

  test("only WebVTT's own tags are stripped; other angle brackets are the speaker's words", () => {
    const [utterance] = parseSuppliedCaptions([
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:04.000",
      "<c.yellow.bg_blue>Hey</c> <v Ann>I <3 you</v> <b>and</b> a < b > c <00:00:02.000>then <lang en>ok</lang> <ruby>x<rt>y</rt></ruby> <font color=red>z</font> <blink>kept</blink>",
    ].join("\n"));
    expect(utterance!.text).toBe("Hey I <3 you and a < b > c then ok xy z <blink>kept</blink>");
  });

  test("cues that start together keep the order they have in the file", () => {
    const utterances = parseSuppliedCaptions([
      "1\n00:00:01,000 --> 00:00:05,000\nsecond speaker long",
      "2\n00:00:01,000 --> 00:00:02,000\nfirst speaker short",
    ].join("\n\n"));
    // Same start: one caption in two pieces, joined in file order (not ordered by end time).
    expect(utterances).toHaveLength(1);
    expect(utterances[0]!.text).toBe("second speaker long first speaker short");
  });

  test("minutes or seconds of 60 or more are refused, not read as a long cue", () => {
    expect(failure("1\n00:75:00,000 --> 00:76:00,000\nminutes")).toMatchObject({ code: "supplied_captions_malformed", cue: 1 });
    expect(failure("1\n00:00:75,000 --> 00:00:76,000\nseconds")).toMatchObject({ code: "supplied_captions_malformed", cue: 1 });
    expect(failure("WEBVTT\n\n00:61.000 --> 00:62.000\nshort form")).toMatchObject({ code: "supplied_captions_malformed", cue: 1 });
    expect(failure("1\n00:00:01,000 --> 00:00:60,000\nend second")).toMatchObject({ code: "supplied_captions_malformed" });
    expect(parseSuppliedCaptions("1\n01:59:59,000 --> 02:00:00,000\nlast second of the hour")[0]).toMatchObject({ startSec: 7_199, endSec: 7_200 });
  });

  test("no word ends after its cue, even when the cue is shorter than its words' minimum lengths", () => {
    const [utterance] = parseSuppliedCaptions("1\n00:00:01,000 --> 00:00:01,002\none two three four five six seven eight nine ten");
    expect(utterance!.words).toHaveLength(10);
    for (const word of utterance!.words) {
      expect(word.endSec).toBeLessThanOrEqual(utterance!.endSec);
      expect(word.startSec).toBeGreaterThanOrEqual(utterance!.startSec);
      expect(word.endSec).toBeGreaterThanOrEqual(word.startSec);
    }
    // An ordinary cue still tiles its span exactly.
    const [ordinary] = parseSuppliedCaptions("1\n00:00:00,000 --> 00:00:03,000\nthree little words");
    expect(ordinary!.words.at(-1)!.endSec).toBe(3);
    expect(ordinary!.words.every((word) => word.endSec <= 3)).toBe(true);
  });

  test("cues without text are skipped", () => {
    const utterances = parseSuppliedCaptions("1\n00:00:00,000 --> 00:00:01,000\n\n\n2\n00:00:01,000 --> 00:00:03,000\none two three four five six");
    expect(utterances).toHaveLength(1);
    expect(utterances[0]!.words).toHaveLength(6);
  });

  test("typed refusals: empty, no timing, backwards, unreadable, too many cues, too large, binary", () => {
    expect(failure("   \n  ").code).toBe("supplied_captions_empty");
    expect(failure("WEBVTT\n\nNOTE only a note").code).toBe("supplied_captions_empty");
    expect(failure("1\n00:00:00,000 --> 00:00:01,000\n").code).toBe("supplied_captions_empty");
    expect(failure("just some prose").code).toBe("supplied_captions_malformed");
    expect(failure("1\n00:00:00,000 --> 00:00:01,000\nok\n\nstray block")).toMatchObject({ code: "supplied_captions_malformed", cue: 2 });
    expect(failure("1\n00:00:02,000 --> 00:00:01,000\nbackwards")).toMatchObject({ code: "supplied_captions_malformed", cue: 1 });
    expect(failure("1\n00:00:02 --> 00:00:03\nno fraction").code).toBe("supplied_captions_malformed");
    expect(failure("a\nb\n00:00:00,000 --> 00:00:01,000\ntoo many lines before timing").code).toBe("supplied_captions_malformed");
    expect(failure("1\n00:00:00,000 --> 00:00:01,000\nbin\u0000ary").code).toBe("supplied_captions_malformed");
    const many = Array.from({ length: SUPPLIED_CAPTIONS_MAX_CUES + 1 }, (_, index) => `${index + 1}\n00:00:${String(Math.floor(index / 100)).padStart(2, "0")},${String((index % 100) * 10).padStart(3, "0")} --> 00:00:${String(Math.floor(index / 100)).padStart(2, "0")},${String((index % 100) * 10 + 5).padStart(3, "0")}\ncue ${index}`).join("\n\n");
    expect(failure(many).code).toBe("supplied_captions_too_many_cues");
    expect(failure(`1\n00:00:00,000 --> 00:00:01,000\n${"x".repeat(SUPPLIED_CAPTIONS_MAX_BYTES)}`).code).toBe("supplied_captions_too_large");
    // The limit is bytes, not characters.
    expect(failure(`1\n00:00:00,000 --> 00:00:01,000\n${"é".repeat(SUPPLIED_CAPTIONS_MAX_BYTES / 2)}`).code).toBe("supplied_captions_too_large");
  });

  test("fitting to a source drops cues past its end and ends the last cue with it", () => {
    const utterances = parseSuppliedCaptions("1\n00:00:00,000 --> 00:00:02,000\nkeep this\n\n2\n00:00:02,000 --> 00:00:06,000\ncut off here\n\n3\n00:00:07,000 --> 00:00:08,000\ngone");
    const fitted = fitSuppliedUtterances(utterances, 3);
    expect(fitted.map((utterance) => [utterance.index, utterance.startSec, utterance.endSec])).toEqual([[0, 0, 2], [1, 2, 3]]);
    expect(fitted[1]!.words.every((word) => word.endSec <= 3)).toBe(true);
    expect(fitted[1]!.text).toBe(fitted[1]!.words.map((word) => word.word).join(" "));
    expect(fitSuppliedUtterances(utterances, 100)).toEqual(utterances);
    expect(fitSuppliedUtterances(utterances, 0)).toEqual([]);
  });
});
