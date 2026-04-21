import { describe, expect, test } from "bun:test";
import type { TranscriptUtterance } from "@narriflow/validators";
import {
  buildMarketCompliantClipCandidates,
  formatTimestamp,
  formatTranscriptForLlm,
  resolveClipCountTarget,
} from "./detect-clips";

function makeUtterances(durationSec: number): TranscriptUtterance[] {
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

describe("clip detection helpers", () => {
  test("formats one-hour-plus timestamps with absolute seconds and HH:MM:SS", () => {
    const utterances = [
      {
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker 1",
        startSec: 3723.42,
        endSec: 3728.1,
        text: "This is the actual hook.",
        confidence: 0.98,
        words: [],
      },
    ] satisfies TranscriptUtterance[];

    expect(formatTimestamp(3723.42)).toBe("01:02:03.420");
    expect(formatTranscriptForLlm(utterances)).toContain(
      "[start_sec=3723.420 end_sec=3728.100 time=01:02:03.420-01:02:08.100]",
    );
  });

  test("resolves duration-based clip counts for long-form content", () => {
    expect(resolveClipCountTarget(3, 60 * 60)).toBe(5);
    expect(resolveClipCountTarget(12, 60 * 60)).toBe(8);
    expect(resolveClipCountTarget(3, 20 * 60)).toBe(4);
    expect(resolveClipCountTarget(1, 5 * 60)).toBe(2);
  });

  test("repairs tiny LLM ranges before candidate selection", () => {
    const { candidates, dropped } = buildMarketCompliantClipCandidates({
      rawClips: [
        {
          startSec: 8.2,
          endSec: 9.4,
          hookText: "The real hook",
          reasoning: "Strong insight",
          category: "insight",
          hookStrength: 85,
          emotionalIntensity: 70,
        },
      ],
      utterances: makeUtterances(70),
      sourceDurationSec: 70,
    });

    expect(dropped).toHaveLength(0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.durationSec).toBeGreaterThanOrEqual(30);
    expect(candidates[0]!.durationSec).toBeLessThanOrEqual(75);
  });

  test("drops candidates that cannot be repaired to the hard minimum", () => {
    const { candidates, dropped } = buildMarketCompliantClipCandidates({
      rawClips: [
        {
          startSec: 1,
          endSec: 2,
          hookText: "Too short",
          reasoning: "Not enough source material",
          category: "insight",
          hookStrength: 85,
          emotionalIntensity: 70,
        },
      ],
      utterances: makeUtterances(10),
      sourceDurationSec: 10,
    });

    expect(candidates).toHaveLength(0);
    expect(dropped[0]?.reason).toBe("duration_outside_market_window");
    expect(dropped[0]?.repairedDurationSec).toBeLessThan(15);
  });
});
