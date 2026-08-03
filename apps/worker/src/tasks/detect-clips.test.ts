import { describe, expect, test } from "bun:test";
import {
  planBrollCutaways,
  type ClipPlatformTarget,
  type TranscriptUtterance,
} from "@narriflow/validators";
import {
  buildMarketCompliantClipCandidates,
  buildCaptionOnlyTranscriptSlice,
  resolveCandidateCountTarget,
  formatTimestamp,
  formatTranscriptForLlm,
  normalizeLlmClip,
  resolveDefaultClipCountTarget,
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
    expect(resolveDefaultClipCountTarget(60 * 60)).toBe(10);
    expect(resolveClipCountTarget(null, 60 * 60)).toBe(10);
    expect(resolveClipCountTarget(5, 60 * 60)).toBe(5);
    expect(resolveClipCountTarget(12, 60 * 60)).toBe(12);
    expect(resolveClipCountTarget(3, 20 * 60)).toBe(3);
    expect(resolveClipCountTarget(1, 5 * 60)).toBe(3);
  });

  test("resolves larger candidate pools for long-form content", () => {
    expect(resolveCandidateCountTarget(10, 60 * 60)).toBeGreaterThanOrEqual(36);
    expect(resolveCandidateCountTarget(30, 60 * 60)).toBe(90);
  });

  test("repairs tiny LLM ranges before candidate selection", () => {
    const { candidates, dropped } = buildMarketCompliantClipCandidates({
      rawClips: [
        {
          startSec: 8.2,
          endSec: 9.4,
          title: "The real hook",
          hookText: "The real hook",
          payoffText: "The payoff",
          reasoning: "Strong insight",
          category: "insight",
          platformFit: ["tiktok", "youtube_shorts", "instagram_reels"],
          hookStrength: 85,
          emotionalIntensity: 70,
          storyCompleteness: 82,
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
          title: "Too short",
          hookText: "Too short",
          payoffText: "No payoff",
          reasoning: "Not enough source material",
          category: "insight",
          platformFit: ["tiktok"],
          hookStrength: 85,
          emotionalIntensity: 70,
          storyCompleteness: 40,
        },
      ],
      utterances: makeUtterances(10),
      sourceDurationSec: 10,
    });

    expect(candidates).toHaveLength(0);
    expect(dropped[0]?.reason).toBe("duration_outside_market_window");
    expect(dropped[0]?.repairedDurationSec).toBeLessThan(15);
  });

  test("never lets a clip through below the absolute minimum duration, even if the content pack's policy allows it", () => {
    // Production observed 1.43s and 2.79s clips slipping through from a
    // 24-minute source when the effective policy was too lenient. Simulate
    // that here with an explicit durationPolicy far below the normal 15s
    // default (as if a buggy/over-permissive content pack requested it) and
    // confirm the absolute floor still applies.
    const { candidates, dropped } = buildMarketCompliantClipCandidates({
      rawClips: [
        {
          startSec: 20,
          endSec: 21.43,
          title: "Too short even for a lenient policy",
          hookText: "Too short",
          payoffText: "No payoff",
          reasoning: "Sub-3-second raw range",
          category: "insight",
          platformFit: ["tiktok"],
          hookStrength: 85,
          emotionalIntensity: 70,
          storyCompleteness: 40,
        },
      ],
      utterances: makeUtterances(70),
      sourceDurationSec: 70,
      durationPolicy: {
        minDurationSec: 1,
        preferredMinDurationSec: 1,
        preferredMaxDurationSec: 60,
        maxDurationSec: 90,
      },
    });

    if (candidates.length > 0) {
      // Expanded rather than shipped as-is.
      expect(candidates[0]!.durationSec).toBeGreaterThanOrEqual(5);
    } else {
      // Correctly dropped rather than shipped unusably short.
      expect(dropped[0]?.reason).toBe("duration_outside_market_window");
      expect(dropped[0]!.repairedDurationSec!).toBeLessThan(5);
    }
  });

  test("caption-only transcript slice clamps boundary utterances", () => {
    const slice = buildCaptionOnlyTranscriptSlice(
      [
        {
          index: 0,
          speaker: 0,
          speakerLabel: "Speaker 1",
          startSec: 4,
          endSec: 8,
          text: "alpha beta",
          confidence: 0.98,
          words: [
            { word: "alpha", startSec: 4, endSec: 5.5, confidence: 0.98 },
            { word: "beta", startSec: 5.5, endSec: 8, confidence: 0.98 },
          ],
        },
      ],
      5,
      7,
    );

    expect(slice).toHaveLength(1);
    expect(slice[0]!.startSec).toBe(5);
    expect(slice[0]!.endSec).toBe(7);
    expect(slice[0]!.words[0]!.startSec).toBe(5);
    expect(slice[0]!.words.at(-1)!.endSec).toBe(7);
  });

  test("normalizes broll cues from the LLM's snake_case fields, including the empty-array case", () => {
    const baseLlmClip = {
      title: "The real hook",
      start_time: 10,
      end_time: 40,
      hook_text: "Hook",
      payoff_text: "Payoff",
      reasoning: "Reasoning",
      category: "insight" as const,
      platform_fit: ["tiktok" as const],
      hook_strength: 80,
      emotional_intensity: 70,
      story_completeness_score: 75,
    };

    const withCues = normalizeLlmClip({
      ...baseLlmClip,
      broll_cues: [
        { at_sec: 5, query: "city skyline at night", reason: "Establishes the setting" },
        { at_sec: 20, query: "hands typing on laptop", reason: "Illustrates the point" },
      ],
    });

    expect(withCues?.brollCues).toEqual([
      { atSec: 5, query: "city skyline at night", reason: "Establishes the setting" },
      { atSec: 20, query: "hands typing on laptop", reason: "Illustrates the point" },
    ]);

    const withoutCues = normalizeLlmClip({ ...baseLlmClip, broll_cues: [] });
    expect(withoutCues?.brollCues).toEqual([]);
  });

  test("a hallucinated out-of-range broll cue at_sec is dropped rather than placing a cutaway outside the clip", () => {
    const clipDurationSec = 30;

    const normalized = normalizeLlmClip({
      title: "Short clip",
      start_time: 100,
      end_time: 100 + clipDurationSec,
      hook_text: "Hook",
      payoff_text: "Payoff",
      reasoning: "Reasoning",
      category: "insight",
      platform_fit: ["tiktok"],
      hook_strength: 80,
      emotional_intensity: 70,
      story_completeness_score: 75,
      broll_cues: [
        { at_sec: 15, query: "city skyline at night", reason: "Valid mid-clip cue" },
        {
          at_sec: 9999,
          query: "hallucinated far-future moment",
          reason: "Model hallucinated an out-of-range timestamp",
        },
        {
          at_sec: -50,
          query: "hallucinated negative moment",
          reason: "Model hallucinated a negative timestamp",
        },
      ],
    });

    // normalizeLlmClip itself does not clamp/filter at_sec — that untrusted
    // validation is planBrollCutaways's job (packages/validators/src/broll.ts),
    // so all three cues pass through the mapping unchanged here.
    expect(normalized?.brollCues).toHaveLength(3);

    const planned = planBrollCutaways(clipDurationSec, normalized?.brollCues ?? null, null);

    // planBrollCutaways must filter the out-of-range cues before planning
    // cutaways, so a hallucinated at_sec can never place a cutaway outside
    // the clip's own duration.
    expect(planned).toHaveLength(1);
    expect(planned[0]?.query).toBe("city skyline at night");
    for (const cutaway of planned) {
      expect(cutaway.startSec).toBeGreaterThanOrEqual(0);
      expect(cutaway.endSec).toBeLessThanOrEqual(clipDurationSec);
    }
  });

  test("threads broll cues from raw clips through to market-compliant candidates", () => {
    const { candidates, dropped } = buildMarketCompliantClipCandidates({
      rawClips: [
        {
          startSec: 8.2,
          endSec: 9.4,
          title: "The real hook",
          hookText: "The real hook",
          payoffText: "The payoff",
          reasoning: "Strong insight",
          category: "insight",
          platformFit: ["tiktok", "youtube_shorts", "instagram_reels"],
          hookStrength: 85,
          emotionalIntensity: 70,
          storyCompleteness: 82,
          brollCues: [
            { atSec: 12, query: "city skyline at night", reason: "Sets the scene" },
          ],
        },
      ],
      utterances: makeUtterances(70),
      sourceDurationSec: 70,
    });

    expect(dropped).toHaveLength(0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.brollCues).toEqual([
      { atSec: 12, query: "city skyline at night", reason: "Sets the scene" },
    ]);
  });
});

function makeUnpunctuatedUtterances(durationSec: number): TranscriptUtterance[] {
  const words = [];
  for (let second = 0; second < durationSec; second += 1) {
    words.push({
      word: `word${second}`,
      startSec: second,
      endSec: second + 0.5,
      confidence: 0.9,
    });
  }
  return [
    {
      index: 0,
      speaker: 0,
      speakerLabel: "Speaker 1",
      startSec: 0,
      endSec: durationSec,
      text: words.map((w) => w.word).join(" "),
      confidence: 0.9,
      words,
    },
  ];
}

function makeRawClip(startSec: number, endSec: number) {
  return {
    startSec,
    endSec,
    title: "t",
    hookText: "h",
    payoffText: "p",
    reasoning: "r",
    category: "insight" as const,
    platformFit: ["tiktok"] as ClipPlatformTarget[],
    hookStrength: 70,
    emotionalIntensity: 70,
    storyCompleteness: 70,
  };
}

describe("containment guard (timing_repair_divergent)", () => {
  test("keeps raw spans longer than 2x maxDurationSec — trimming to max is not divergence", () => {
    const { candidates, dropped } = buildMarketCompliantClipCandidates({
      rawClips: [makeRawClip(10.2, 300)],
      utterances: makeUtterances(400),
      sourceDurationSec: 400,
    });

    expect(dropped).toHaveLength(0);
    expect(candidates).toHaveLength(1);
  });

  test("drops a divergent candidate only while better-anchored ones survive", () => {
    const { candidates, dropped } = buildMarketCompliantClipCandidates({
      rawClips: [makeRawClip(10.2, 50), makeRawClip(500, 560)],
      utterances: makeUtterances(100),
      sourceDurationSec: 600,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.rawStartSec).toBe(10.2);
    expect(dropped.map((d) => d.reason)).toEqual(["timing_repair_divergent"]);
  });

  test("fails open when every candidate is divergent — a run must never empty itself", () => {
    const { candidates, dropped } = buildMarketCompliantClipCandidates({
      rawClips: [makeRawClip(500, 560)],
      utterances: makeUtterances(100),
      sourceDurationSec: 600,
    });

    expect(candidates).toHaveLength(1);
    expect(dropped.map((d) => d.reason)).toEqual(["timing_repair_divergent_kept"]);
  });

  test("an unpunctuated transcript still yields clips (bounded sentence walk-back)", () => {
    const { candidates } = buildMarketCompliantClipCandidates({
      rawClips: [
        makeRawClip(120, 155),
        makeRawClip(300, 340),
        makeRawClip(500, 545),
        makeRawClip(700, 738),
      ],
      utterances: makeUnpunctuatedUtterances(900),
      sourceDurationSec: 900,
    });

    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });
});
