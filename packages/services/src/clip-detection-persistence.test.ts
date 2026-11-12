import { describe, expect, test } from "bun:test";
import { buildGenerationContentPack, encodeQuietRanges, type TranscriptUtterance, type TranscriptWord } from "@narriflow/validators";
import { buildDetectedClipRows, prepareDetectedClipSeed, type DetectedClip } from "./clip-detection-persistence";

function word(startSec: number, endSec: number, text: string): TranscriptWord {
  return { word: text, startSec, endSec, confidence: null };
}

// "So [2.5 s pause] um we go": a pause the audio confirms quiet, then a filler.
const slice: TranscriptUtterance[] = [{
  index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 10, endSec: 30, text: "So um we go", confidence: null,
  words: [word(10, 11, "So"), word(13.5, 13.8, "um"), word(13.9, 15, "we"), word(15.1, 30, "go")],
}];

function clip(): DetectedClip {
  return {
    startSec: 10, endSec: 30, title: "t", hookText: "h", payoffText: null, reasoning: "r", category: "story", platformFit: ["tiktok"],
    hookStrengthScore: 50, emotionalIntensityScore: 50, storyCompletenessScore: 50, pacingScore: 50, durationOptimalityScore: 50,
    viralityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, transcriptSlice: slice,
  };
}

const project = { brandSnapshot: null, brandProfileSnapshot: null, sourceDurationSeconds: 60 };
const quietRanges = encodeQuietRanges([{ startSec: 10.9, endSec: 13.6 }]);

function rows(settings: { removeSilences?: boolean; removeFillerWords?: boolean }, source = { quietRanges, languageCode: "en" as string | null }) {
  const seed = prepareDetectedClipSeed(project, buildGenerationContentPack(settings), source);
  return buildDetectedClipRows({ projectId: "p", workflowRunId: "w", clips: [clip()], seed, llmMeta: { provider: "openai", model: "m", totalTokensUsed: 1 } });
}

describe("clip cleanup at generation", () => {
  test("no cleanup asked: clips start uncut", () => {
    expect(rows({})[0]!.deletedRanges).toEqual([]);
  });

  test("seeds silence and filler cuts into the clip's editable cuts", () => {
    expect(rows({ removeSilences: true, removeFillerWords: true })[0]!.deletedRanges).toEqual([
      { startSec: 11.15, endSec: 13.8 },
    ]);
  });

  test("unmeasured or invalid quiet audio turns silence removal off, not filler removal", () => {
    for (const stored of [null, [1, 2, 3], "garbage"]) {
      expect(rows({ removeSilences: true, removeFillerWords: true }, { quietRanges: stored as never, languageCode: "en" })[0]!.deletedRanges).toEqual([
        { startSec: 13.5, endSec: 13.8 },
      ]);
    }
  });

  test("filler removal follows the transcript language", () => {
    expect(rows({ removeFillerWords: true }, { quietRanges, languageCode: "pt" })[0]!.deletedRanges).toEqual([]);
  });
});
