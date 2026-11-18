import { describe, expect, test } from "bun:test";
import {
  DUB_MAX_SEGMENTS,
  DUB_MERGE_GAP_SEC,
  DUB_MIN_SEGMENT_SEC,
  planDubSegments,
} from "./dub-plan";
import { buildClipCutPlan, sourceWordToEdited } from "./edit-ranges";
import type { TranscriptUtterance } from "./transcript";

type W = [text: string, startSec: number, endSec: number, spaceBefore?: boolean];

function sentence(words: W[], index = 0, speaker = 0): TranscriptUtterance {
  return {
    index, speaker, speakerLabel: `Speaker ${speaker + 1}`, confidence: 1,
    startSec: words[0]![1], endSec: words.at(-1)![2],
    text: words.map((word) => word[0]).join(" "),
    words: words.map(([word, startSec, endSec, spaceBefore]) => ({
      word, startSec, endSec, confidence: 1,
      ...(spaceBefore === undefined ? {} : { spaceBefore }),
    })),
  };
}

function untimed(text: string, startSec: number, endSec: number, index = 0): TranscriptUtterance {
  return { index, speaker: 0, speakerLabel: "Speaker 1", confidence: 1, startSec, endSec, text, words: [] };
}

function plan(
  transcriptSlice: TranscriptUtterance[],
  deletedRanges: { startSec: number; endSec: number }[] = [],
  clip = { clipStartSec: 0, clipEndSec: 30 },
) {
  return planDubSegments({ ...clip, deletedRanges, transcriptSlice });
}

function planned(result: ReturnType<typeof plan>) {
  if (result.kind !== "planned") throw new Error(result.code);
  return result;
}

describe("planDubSegments", () => {
  test("one sentence per segment on an uncut clip", () => {
    const result = planned(plan([
      sentence([["Hello", 1, 1.5], ["there", 1.5, 2], ["friend.", 2, 2.6]], 0),
      sentence([["Second", 5, 5.5], ["one", 5.5, 6.4]], 1),
    ]));
    expect(result.editedDurationSec).toBe(30);
    expect(result.segments).toEqual([
      { startSec: 1, endSec: 2.6, text: "Hello there friend." },
      { startSec: 5, endSec: 6.4, text: "Second one" },
    ]);
  });

  test("a silence cut between sentences shifts later sentences onto the edited timeline", () => {
    const result = planned(plan([
      sentence([["Alpha", 1, 2], ["beta.", 2, 2.5]], 0),
      sentence([["Gamma", 8, 9], ["delta.", 9, 9.5]], 1),
    ], [{ startSec: 3, endSec: 7 }]));
    expect(result.editedDurationSec).toBe(26);
    expect(result.segments).toEqual([
      { startSec: 1, endSec: 2.5, text: "Alpha beta." },
      { startSec: 4, endSec: 5.5, text: "Gamma delta." },
    ]);
  });

  test("filler cuts inside a sentence drop exactly the words captions drop", () => {
    const sentenceWords: W[] = [
      ["So", 1, 1.4], ["um", 1.4, 1.9], ["this", 1.9, 2.3], ["is", 2.3, 2.6], ["uh", 2.6, 3], ["great.", 3, 3.8],
    ];
    const deleted = [{ startSec: 1.4, endSec: 1.9 }, { startSec: 2.6, endSec: 3 }];
    const result = planned(plan([sentence(sentenceWords)], deleted));
    expect(result.segments).toEqual([{ startSec: 1, endSec: 2.9, text: "So this is great." }]);
    // The cut plan, not the dub, decides which words are shown.
    const { map } = buildClipCutPlan(deleted, { startSec: 0, endSec: 30 });
    const shown = sentenceWords
      .filter(([, startSec, endSec]) => sourceWordToEdited(map, { startSec, endSec }))
      .map(([text]) => text);
    expect(result.segments[0]!.text).toBe(shown.join(" "));
  });

  test("edited segment times equal sourceWordToEdited of the first and last kept words", () => {
    const words: W[] = [["One", 10, 10.6], ["two", 10.6, 11.4], ["three.", 12, 12.9]];
    const deleted = [{ startSec: 11.4, endSec: 11.8 }, { startSec: 2, endSec: 4 }];
    const { map } = buildClipCutPlan(deleted, { startSec: 0, endSec: 30 });
    const first = sourceWordToEdited(map, { startSec: 10, endSec: 10.6 })!;
    const last = sourceWordToEdited(map, { startSec: 12, endSec: 12.9 })!;
    const [segment] = planned(plan([sentence(words)], deleted)).segments;
    expect(segment).toEqual({ startSec: first.startSec, endSec: last.endSec, text: "One two three." });
  });

  test("a partially cut word that captions show is kept", () => {
    const result = planned(plan([sentence([["Cut", 1, 2], ["edge", 2, 3], ["word.", 3, 4]])], [{ startSec: 2.7, endSec: 3.4 }]));
    expect(result.segments[0]!.text).toBe("Cut edge word.");
    expect(result.segments[0]!.endSec).toBeCloseTo(3.3, 8);
  });

  test("a sentence entirely inside a cut is skipped", () => {
    const result = planned(plan([
      sentence([["Gone", 2, 3], ["away.", 3, 4]], 0),
      sentence([["Stays", 8, 9], ["here.", 9, 10]], 1),
    ], [{ startSec: 1.5, endSec: 6 }]));
    expect(result.segments.map((segment) => segment.text)).toEqual(["Stays here."]);
  });

  test("zero-duration tokens are kept exactly when their instant is kept", () => {
    const words: W[] = [["Hello", 1, 2], ["world", 2, 3], ["。", 3, 3, false]];
    const kept = planned(plan([sentence(words)]));
    expect(kept.segments).toEqual([{ startSec: 1, endSec: 3, text: "Hello world。" }]);
    // The instant 3 is where the cut begins, so the token is cut with it.
    const cut = planned(plan([sentence(words)], [{ startSec: 3, endSec: 4 }]));
    expect(cut.segments).toEqual([{ startSec: 1, endSec: 3, text: "Hello world" }]);
  });

  test("punctuation that would start a segment is dropped; interior punctuation stays attached", () => {
    const result = planned(plan([
      sentence([["—", 1, 1.1], ["Hello", 1.1, 1.8], [",", 1.8, 1.8, false], ["world.", 1.8, 2.4]]),
    ]));
    expect(result.segments).toEqual([{ startSec: 1.1, endSec: 2.4, text: "Hello, world." }]);
  });

  test("a leading word cut away exposes punctuation that is then dropped", () => {
    const result = planned(plan([
      sentence([["Uh", 1, 1.5], ["...", 1.5, 1.6], ["Right", 1.6, 2.6], ["then.", 2.6, 3.2]]),
    ], [{ startSec: 1, endSec: 1.5 }]));
    expect(result.segments[0]!.text).toBe("Right then.");
  });

  test("a punctuation-only sentence yields no segment", () => {
    expect(plan([sentence([["...", 1, 2]])])).toEqual({ kind: "refused", code: "dub_transcript_empty" });
  });

  describe("untimed utterances", () => {
    test("fully kept becomes one segment on the edited timeline", () => {
      const result = planned(plan([untimed("No timing here", 10, 12.5)], [{ startSec: 2, endSec: 4 }]));
      expect(result.segments).toEqual([{ startSec: 8, endSec: 10.5, text: "No timing here" }]);
    });

    test("fully cut is skipped", () => {
      const result = planned(plan([
        untimed("Cut entirely", 10, 12),
        sentence([["Kept", 20, 21], ["words.", 21, 22]], 1),
      ], [{ startSec: 9, endSec: 13 }]));
      expect(result.segments.map((segment) => segment.text)).toEqual(["Kept words."]);
    });

    test("partially cut refuses", () => {
      expect(plan([untimed("Half gone", 10, 14)], [{ startSec: 12, endSec: 13 }]))
        .toEqual({ kind: "refused", code: "dub_transcript_untimed_cut" });
      expect(plan([untimed("Edge nibbled", 10, 14)], [{ startSec: 13.5, endSec: 20 }]))
        .toEqual({ kind: "refused", code: "dub_transcript_untimed_cut" });
    });

    test("overhang past the clip window is not a cut", () => {
      const result = planned(plan([untimed("Spans the end", 25, 33)], [], { clipStartSec: 0, clipEndSec: 30 }));
      expect(result.segments).toEqual([{ startSec: 25, endSec: 30, text: "Spans the end" }]);
    });
  });

  test("overlapping speakers merge into one segment in start order", () => {
    const result = planned(plan([
      sentence([["Hi", 1, 2], ["there,", 2, 3], ["everyone.", 3, 4]], 0, 0),
      sentence([["Yes", 2.5, 3.2], ["indeed.", 3.2, 4.6]], 1, 1),
    ]));
    expect(result.segments).toEqual([{ startSec: 1, endSec: 4.6, text: "Hi there, everyone. Yes indeed." }]);
  });

  describe("short segments", () => {
    test("merge into the next when the gap is under the limit", () => {
      const result = planned(plan([
        sentence([["Wow.", 1, 1.4]], 0),
        sentence([["That", 1.6, 2.2], ["was", 2.2, 2.8], ["good.", 2.8, 3.4]], 1),
      ]));
      expect(result.segments).toEqual([{ startSec: 1, endSec: 3.4, text: "Wow. That was good." }]);
    });

    test("merge into the previous when only that gap is under the limit", () => {
      const result = planned(plan([
        sentence([["A", 1, 1.6], ["long", 1.6, 2.2], ["line.", 2.2, 3]], 0),
        sentence([["Yes.", 3.2, 3.6]], 1),
        sentence([["Much", 9, 9.6], ["later", 9.6, 10.4], ["now.", 10.4, 11]], 2),
      ]));
      expect(result.segments).toEqual([
        { startSec: 1, endSec: 3.6, text: "A long line. Yes." },
        { startSec: 9, endSec: 11, text: "Much later now." },
      ]);
    });

    test("prefer the next neighbour when both gaps qualify", () => {
      const result = planned(plan([
        sentence([["Before", 1, 1.6], ["it", 1.6, 2.2], ["all.", 2.2, 3]], 0),
        sentence([["Mid.", 3.1, 3.5]], 1),
        sentence([["After", 3.6, 4.2], ["it", 4.2, 4.8], ["all.", 4.8, 5.4]], 2),
      ]));
      expect(result.segments.map((segment) => segment.text)).toEqual(["Before it all.", "Mid. After it all."]);
    });

    test("stay separate when every neighbour is too far", () => {
      const farGap = DUB_MERGE_GAP_SEC + 0.05;
      const result = planned(plan([
        sentence([["Short.", 1, 1.5]], 0),
        sentence([["Also", 1.5 + farGap, 2.3], ["short.", 2.3, 2.6]], 1),
      ]));
      expect(result.segments.map((segment) => segment.text)).toEqual(["Short.", "Also short."]);
    });

    test("a chain of short segments folds forward into one", () => {
      const result = planned(plan([
        sentence([["One.", 1, 1.3]], 0),
        sentence([["Two.", 1.4, 1.7]], 1),
        sentence([["Three.", 1.8, 2.1]], 2),
        sentence([["Four.", 2.2, 2.5]], 3),
      ]));
      expect(result.segments).toEqual([{ startSec: 1, endSec: 2.5, text: "One. Two. Three. Four." }]);
    });

    test("a segment at the minimum length is left alone", () => {
      const result = planned(plan([
        sentence([["Exactly", 1, 1 + DUB_MIN_SEGMENT_SEC]], 0),
        sentence([["Next", 2.1, 2.8], ["one.", 2.8, 3.4]], 1),
      ]));
      expect(result.segments.map((segment) => segment.text)).toEqual(["Exactly", "Next one."]);
    });
  });

  test("refuses an empty transcript, an empty slice and a fully cut clip", () => {
    expect(plan([])).toEqual({ kind: "refused", code: "dub_transcript_empty" });
    expect(plan([sentence([["Hello", 1, 2], ["world.", 2, 3]])], [{ startSec: 0, endSec: 30 }]))
      .toEqual({ kind: "refused", code: "dub_transcript_empty" });
  });

  test("refuses more than the segment limit", () => {
    const manyAt = (count: number) => Array.from({ length: count }, (_, index) =>
      sentence([[`Word${index}`, index * 3, index * 3 + 1.5]], index));
    const clip = { clipStartSec: 0, clipEndSec: 1000 };
    expect(planned(plan(manyAt(DUB_MAX_SEGMENTS), [], clip)).segments).toHaveLength(DUB_MAX_SEGMENTS);
    expect(plan(manyAt(DUB_MAX_SEGMENTS + 1), [], clip)).toEqual({ kind: "refused", code: "dub_transcript_too_long" });
  });

  test("is deterministic", () => {
    const slice = [
      sentence([["Wow.", 1, 1.4]], 0),
      sentence([["That", 1.6, 2.2], ["was.", 2.2, 3]], 1),
    ];
    expect(plan(slice)).toEqual(plan(slice));
  });
});
