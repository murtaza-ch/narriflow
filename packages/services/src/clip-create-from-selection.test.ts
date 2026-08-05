import { describe, expect, test } from "bun:test";
import {
  CLIP_MAX_DURATION_SEC,
  CLIP_MIN_DURATION_SEC,
  type TranscriptUtterance,
} from "@narriflow/validators";
import {
  ClipActionError,
  planCreateClipFromSelection,
  planStudioEditsForClipFromSelection,
} from "./clip.service";

/** A single-utterance transcript of `wordCount` words, each exactly
 *  `wordDurationSec` long and back-to-back (no gaps) starting at `startAt` —
 *  simple, deterministic word boundaries to snap/expand/clamp against. None
 *  of the synthetic words end in terminal punctuation, so
 *  `splitUtterancesIntoSentences` (called inside the planner) may re-split
 *  this into several sentence-sized utterances by duration/word-count, but
 *  the underlying word set — and therefore every token boundary this test
 *  asserts on — is unaffected either way. */
function makeTranscript(
  wordCount: number,
  wordDurationSec = 0.4,
  startAt = 0,
): TranscriptUtterance[] {
  const words = Array.from({ length: wordCount }, (_, i) => ({
    word: `word${i}`,
    startSec: startAt + i * wordDurationSec,
    endSec: startAt + (i + 1) * wordDurationSec,
    confidence: null,
  }));
  return [
    {
      index: 0,
      speaker: 0,
      speakerLabel: "Speaker A",
      startSec: words[0]!.startSec,
      endSec: words[words.length - 1]!.endSec,
      text: words.map((w) => w.word).join(" "),
      confidence: null,
      words,
    },
  ];
}

describe("planCreateClipFromSelection", () => {
  test("throws clip_selection_invalid when the transcript has no words", () => {
    expect(() =>
      planCreateClipFromSelection({
        rawUtterances: [],
        sourceDurationSec: 600,
        startSec: 10,
        endSec: 20,
      }),
    ).toThrow(ClipActionError);

    try {
      planCreateClipFromSelection({
        rawUtterances: [],
        sourceDurationSec: 600,
        startSec: 10,
        endSec: 20,
      });
      throw new Error("expected planCreateClipFromSelection to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ClipActionError);
      expect((error as ClipActionError).code).toBe("clip_selection_invalid");
    }
  });

  test("a selection already at/above the minimum duration is snapped to its own word boundaries, unchanged", () => {
    // 60 words * 0.4s = 24s total; words 25..49 span exactly [10, 20).
    const transcript = makeTranscript(60, 0.4);
    const plan = planCreateClipFromSelection({
      rawUtterances: transcript,
      sourceDurationSec: 24,
      startSec: 10,
      endSec: 20,
    });

    expect(plan.startSec).toBeCloseTo(10, 2);
    expect(plan.endSec).toBeCloseTo(20, 2);
    expect(plan.durationSec).toBeCloseTo(10, 2);
    expect(plan.transcriptSlice.length).toBeGreaterThan(0);
  });

  test("a selection shorter than the minimum is expanded symmetrically, word-snapped, to clear the floor", () => {
    // 60 words * 0.4s = 24s total; a 2s selection in the middle has plenty of
    // room to grow on both sides.
    const transcript = makeTranscript(60, 0.4);
    const selectionStart = 10;
    const selectionEnd = 12;
    const plan = planCreateClipFromSelection({
      rawUtterances: transcript,
      sourceDurationSec: 24,
      startSec: selectionStart,
      endSec: selectionEnd,
    });

    expect(plan.durationSec).toBeGreaterThanOrEqual(CLIP_MIN_DURATION_SEC);
    // Word-snapped: both bounds land on a 0.4s word boundary (within
    // floating-point rounding tolerance).
    expect(Math.abs(plan.startSec / 0.4 - Math.round(plan.startSec / 0.4))).toBeLessThan(
      1e-6,
    );
    expect(Math.abs(plan.endSec / 0.4 - Math.round(plan.endSec / 0.4))).toBeLessThan(
      1e-6,
    );
    // Expanded roughly symmetrically around the original selection, not
    // eaten entirely from one side.
    const grewLeft = selectionStart - plan.startSec;
    const grewRight = plan.endSec - selectionEnd;
    expect(grewLeft).toBeGreaterThan(0);
    expect(grewRight).toBeGreaterThan(0);
  });

  test("expansion pulled entirely rightward when the selection sits at the very start of the transcript", () => {
    const transcript = makeTranscript(60, 0.4);
    const plan = planCreateClipFromSelection({
      rawUtterances: transcript,
      sourceDurationSec: 24,
      startSec: 0,
      endSec: 0.8, // first two words only
    });

    expect(plan.startSec).toBeCloseTo(0, 2);
    expect(plan.durationSec).toBeGreaterThanOrEqual(CLIP_MIN_DURATION_SEC);
  });

  test("rejects a selection too close to the edge of a short transcript to reach the minimum duration", () => {
    // Only 3 words spanning 1.2s total — nowhere near enough to expand to
    // CLIP_MIN_DURATION_SEC (10s) even by consuming every word.
    const transcript = makeTranscript(3, 0.4);

    expect(() =>
      planCreateClipFromSelection({
        rawUtterances: transcript,
        sourceDurationSec: 1.2,
        startSec: 0,
        endSec: 0.4,
      }),
    ).toThrow(ClipActionError);

    try {
      planCreateClipFromSelection({
        rawUtterances: transcript,
        sourceDurationSec: 1.2,
        startSec: 0,
        endSec: 0.4,
      });
      throw new Error("expected planCreateClipFromSelection to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ClipActionError);
      expect((error as ClipActionError).code).toBe("clip_selection_invalid");
    }
  });

  test("a selection longer than the maximum is trimmed back from the end, word-snapped, to the ceiling", () => {
    // 400 words * 0.4s = 160s total; select the first 150s (> 120s max).
    const transcript = makeTranscript(400, 0.4);
    const plan = planCreateClipFromSelection({
      rawUtterances: transcript,
      sourceDurationSec: 160,
      startSec: 0,
      endSec: 150,
    });

    expect(plan.durationSec).toBeLessThanOrEqual(CLIP_MAX_DURATION_SEC);
    expect(plan.durationSec).toBeGreaterThan(CLIP_MAX_DURATION_SEC - 1);
    expect(plan.startSec).toBeCloseTo(0, 2);
  });

  test("clamps the selection into [0, sourceDurationSec]", () => {
    const transcript = makeTranscript(60, 0.4);
    const plan = planCreateClipFromSelection({
      rawUtterances: transcript,
      sourceDurationSec: 24,
      startSec: -5,
      endSec: 500,
    });

    expect(plan.startSec).toBeGreaterThanOrEqual(0);
    expect(plan.endSec).toBeLessThanOrEqual(24);
  });

  test("derives the title from the first ~8 words of the resulting slice, with an ellipsis when truncated", () => {
    const transcript = makeTranscript(60, 0.4);
    const plan = planCreateClipFromSelection({
      rawUtterances: transcript,
      sourceDurationSec: 24,
      startSec: 10,
      endSec: 20,
    });

    const words = plan.hookText.split(/\s+/);
    expect(plan.title.endsWith("…")).toBe(words.length > 8);
    expect(plan.title.startsWith(words[0]!)).toBe(true);
    expect(plan.hookText.length).toBeGreaterThan(0);
  });

  test("computes duration-dependent scores without an LLM call, seeded at the neutral midpoint", () => {
    const transcript = makeTranscript(60, 0.4);
    const plan = planCreateClipFromSelection({
      rawUtterances: transcript,
      sourceDurationSec: 24,
      startSec: 10,
      endSec: 20,
    });

    expect(plan.hookStrengthScore).toBe(50);
    expect(plan.emotionalIntensityScore).toBe(50);
    expect(plan.storyCompletenessScore).toBe(50);
    expect(plan.pacingScore).toBeGreaterThan(0);
    expect(plan.durationOptimalityScore).toBeGreaterThan(0);
    expect(plan.viralityScore).toBeGreaterThan(0);
    expect(plan.tiktokScore).toBeGreaterThan(0);
    expect(plan.youtubeScore).toBeGreaterThan(0);
    expect(plan.instagramScore).toBeGreaterThan(0);
  });

  test("a selection landing entirely inside a silent gap anchors to the nearest word and expands from there — duration is wall-clock span, so spanning the gap to clear the floor is valid", () => {
    // Two words far apart with a big silent gap between them; select inside
    // the gap, closer to the second word (no word actually overlaps [15,15)).
    const transcript: TranscriptUtterance[] = [
      {
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker A",
        startSec: 0,
        endSec: 0.4,
        text: "word0",
        confidence: null,
        words: [{ word: "word0", startSec: 0, endSec: 0.4, confidence: null }],
      },
      {
        index: 1,
        speaker: 0,
        speakerLabel: "Speaker A",
        startSec: 30,
        endSec: 30.4,
        text: "word1",
        confidence: null,
        words: [{ word: "word1", startSec: 30, endSec: 30.4, confidence: null }],
      },
    ];

    const plan = planCreateClipFromSelection({
      rawUtterances: transcript,
      sourceDurationSec: 40,
      startSec: 15,
      endSec: 15,
    });

    // Anchored to word1 (nearest to the gap), then expanded left to word0
    // (the only other token) to clear the 10s floor — spanning the gap in
    // the middle is fine, the clip's duration is the wall-clock window.
    expect(plan.startSec).toBeCloseTo(0, 2);
    expect(plan.endSec).toBeCloseTo(30.4, 2);
    expect(plan.durationSec).toBeGreaterThanOrEqual(CLIP_MIN_DURATION_SEC);
  });

  test("still rejects a gap-anchored selection when the whole transcript is too short to clear the floor even by spanning it", () => {
    const transcript: TranscriptUtterance[] = [
      {
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker A",
        startSec: 0,
        endSec: 0.4,
        text: "word0",
        confidence: null,
        words: [{ word: "word0", startSec: 0, endSec: 0.4, confidence: null }],
      },
      {
        index: 1,
        speaker: 0,
        speakerLabel: "Speaker A",
        startSec: 0.5,
        endSec: 0.9,
        text: "word1",
        confidence: null,
        words: [{ word: "word1", startSec: 0.5, endSec: 0.9, confidence: null }],
      },
    ];

    expect(() =>
      planCreateClipFromSelection({
        rawUtterances: transcript,
        sourceDurationSec: 1,
        startSec: 0.45,
        endSec: 0.45,
      }),
    ).toThrow(ClipActionError);
  });
});

describe("planStudioEditsForClipFromSelection (fix: createClipFromSelection copies timeline-relative textLayers)", () => {
  test("returns null when the source clip has no studioEdits", () => {
    expect(planStudioEditsForClipFromSelection(null)).toBeNull();
    expect(planStudioEditsForClipFromSelection(undefined)).toBeNull();
  });

  test("drops textLayers and sfx (source-clip-window-relative seconds) but keeps every other field", () => {
    const sourceStudioEdits = {
      textLayers: [
        {
          id: "t1",
          text: "hello",
          startSec: 2,
          endSec: 4,
          positionX: 50,
          positionY: 50,
        },
      ],
      sfx: [
        {
          id: "sfx-1",
          assetId: "11111111-1111-4111-8111-111111111111",
          startSec: 3,
          volume: 80,
        },
      ],
      transition: { type: "fade", durationSec: 0.6 },
      music: {
        url: "https://example.com/song.mp3",
        title: "Song",
        volume: 40,
        startOffsetSec: 1,
        fadeInSec: 0.5,
        fadeOutSec: 0.5,
      },
      sourceAudio: { volume: 80, muted: false },
      logo: { enabled: true, position: null, opacity: null, scalePct: null },
    };

    const result = planStudioEditsForClipFromSelection(sourceStudioEdits);

    expect(result).not.toBeNull();
    expect(result!.textLayers).toEqual([]);
    // H3: sfx[] carries edited-timeline seconds relative to the SOURCE
    // clip's window, exactly like textLayers — meaningless once re-anchored
    // to the new clip's independently-computed window, so it must be
    // cleared the same way.
    expect(result!.sfx).toEqual([]);
    expect(result!.transition).toEqual(sourceStudioEdits.transition);
    // Packet A (AudioAsset foundation) added assetId/ducking to the music
    // schema — schema defaults fill both in even though the source fixture
    // predates those fields, same as any other legacy-shaped studioEdits.
    expect(result!.music).toEqual({
      ...sourceStudioEdits.music,
      assetId: null,
      ducking: false,
    });
    expect(result!.sourceAudio).toEqual(sourceStudioEdits.sourceAudio);
    expect(result!.logo).toEqual(sourceStudioEdits.logo);
  });

  test("still returns non-null (schema defaults) for a source clip with no textLayers/sfx to begin with", () => {
    const result = planStudioEditsForClipFromSelection({});
    expect(result).not.toBeNull();
    expect(result!.textLayers).toEqual([]);
    expect(result!.sfx).toEqual([]);
  });
});
