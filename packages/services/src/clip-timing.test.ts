import { describe, expect, test } from "bun:test";
import {
  expandClipToCompleteSpeech,
  getEffectiveClipTiming,
  normalizeTranscriptSliceForClip,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { sliceTranscriptForClip } from "./clip.service";

const warningUtterance: TranscriptUtterance = {
  index: 0,
  speaker: 0,
  speakerLabel: "Speaker 1",
  startSec: 22.4,
  endSec: 28.2,
  text: "give The United States critical warning if a missile launches anywhere on the planet.",
  confidence: 0.96,
  words: [
    { word: "give", startSec: 22.4, endSec: 22.7, confidence: 0.98 },
    { word: "The", startSec: 22.72, endSec: 22.86, confidence: 0.98 },
    { word: "United", startSec: 22.9, endSec: 23.2, confidence: 0.98 },
    { word: "States", startSec: 23.24, endSec: 23.55, confidence: 0.98 },
    { word: "critical", startSec: 24.85, endSec: 25.18, confidence: 0.97 },
    { word: "warning", startSec: 25.2, endSec: 25.58, confidence: 0.97 },
    { word: "if", startSec: 25.66, endSec: 25.78, confidence: 0.96 },
    { word: "a", startSec: 25.8, endSec: 25.9, confidence: 0.96 },
    { word: "missile", startSec: 25.94, endSec: 26.28, confidence: 0.96 },
    { word: "launches", startSec: 26.3, endSec: 26.74, confidence: 0.95 },
    { word: "anywhere", startSec: 26.78, endSec: 27.18, confidence: 0.95 },
    { word: "on", startSec: 27.2, endSec: 27.34, confidence: 0.95 },
    { word: "the", startSec: 27.36, endSec: 27.5, confidence: 0.95 },
    { word: "planet.", startSec: 27.52, endSec: 28.2, confidence: 0.94 },
  ],
};

function makeMarketWindowUtterances(durationSec: number): TranscriptUtterance[] {
  const utterances: TranscriptUtterance[] = [];

  for (let start = 0; start < durationSec; start += 2) {
    const words = [0, 1]
      .map((offset) => start + offset)
      .filter((second) => second < durationSec)
      .map((second) => {
        const isSentenceEnd = second % 10 === 9;
        return {
          word: `word${second}${isSentenceEnd ? "." : ""}`,
          startSec: second,
          endSec: second + 0.5,
          confidence: 0.98,
        };
      });

    utterances.push({
      index: utterances.length,
      speaker: 0,
      speakerLabel: "Speaker 1",
      startSec: words[0]!.startSec,
      endSec: words[words.length - 1]!.endSec,
      text: words.map((word) => word.word).join(" "),
      confidence: 0.98,
      words,
    });
  }

  return utterances;
}

describe("clip timing normalization", () => {
  test("extends a clipped ending to complete the active sentence", () => {
    const timing = expandClipToCompleteSpeech({
      utterances: [warningUtterance],
      startSec: 24.8,
      endSec: 25.6,
      sourceDurationSec: 60,
    });

    expect(timing.startSec).toBe(24.8);
    expect(timing.endSec).toBe(28.45);
    expect(timing.durationSec).toBe(3.65);
  });

  test("normalizes words and rebuilds utterance text inside the clip range", () => {
    const slice = normalizeTranscriptSliceForClip(
      [warningUtterance],
      24.8,
      25.6,
    );

    expect(slice).toHaveLength(1);
    expect(slice[0]!.text).toBe("critical warning");
    expect(slice[0]!.words.map((word) => word.word)).toEqual([
      "critical",
      "warning",
    ]);
    expect(slice[0]!.words[1]!.endSec).toBe(25.58);
  });

  test("effective clip timing returns a repaired transcript slice", () => {
    const effective = getEffectiveClipTiming({
      utterances: [warningUtterance],
      startSec: 24.8,
      endSec: 25.6,
      sourceDurationSec: 60,
    });

    expect(effective.transcriptSlice[0]!.text).toContain("warning if a missile");
    expect(effective.transcriptSlice[0]!.words.at(-1)?.word).toBe("planet.");
    expect(effective.endSec).toBe(28.45);
  });

  test("market-window timing repairs tiny AssemblyAI-style ranges into a usable clip", () => {
    const effective = getEffectiveClipTiming({
      utterances: makeMarketWindowUtterances(70),
      startSec: 8.2,
      endSec: 9.4,
      sourceDurationSec: 70,
      minDurationSec: 15,
      preferredMinDurationSec: 30,
      preferredMaxDurationSec: 75,
      maxDurationSec: 90,
    });

    expect(effective.startSec).toBe(0);
    expect(effective.durationSec).toBeGreaterThanOrEqual(30);
    expect(effective.durationSec).toBeLessThanOrEqual(75);
    expect(effective.transcriptSlice.length).toBeGreaterThan(10);
    expect(effective.transcriptSlice.at(-1)?.text).toContain("word39.");
  });

  test("service sliceTranscriptForClip uses clamped word-level slicing", () => {
    const slice = sliceTranscriptForClip([warningUtterance], 25.19, 25.79);

    expect(slice[0]!.text).toBe("warning if");
    expect(slice[0]!.startSec).toBe(25.2);
    expect(slice[0]!.endSec).toBe(25.78);
  });
});
