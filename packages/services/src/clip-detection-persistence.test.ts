import { describe, expect, test } from "bun:test";
import { buildGenerationContentPack, encodeQuietRanges, fillerWordKey, type FillerTaggingOutcome, type TranscriptUtterance, type TranscriptWord } from "@narriflow/validators";
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

  test("frozen AI tags remove a German filler; no tags or another speaker's key cut nothing", () => {
    const de: TranscriptUtterance[] = [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 10, endSec: 30, text: "Also äh wir", confidence: null,
      words: [word(10, 11, "Also,"), word(11.1, 11.4, "äh,"), word(11.5, 30, "wir")] }];
    const aiFillers = (keys: string[]): FillerTaggingOutcome => ({ contract: { models: [{ model: "gpt-6-luna", reasoningEffort: "none" }], promptSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64), maxOutputTokens: 4000 }, chunks: 1, tagged: 1, failed: 0, skipped: 0, unsafe: 0, tokensUsed: 10, overflow: false, keys });
    const run = (keys: string[] | null) => {
      const seed = prepareDetectedClipSeed(project, buildGenerationContentPack({ removeFillerWords: true }), { quietRanges: null, languageCode: "de", aiFillers: keys ? aiFillers(keys) : null });
      return buildDetectedClipRows({ projectId: "p", workflowRunId: "w", clips: [{ ...clip(), transcriptSlice: de }], seed, llmMeta: { provider: "openai", model: "m", totalTokensUsed: 1 } })[0]!.deletedRanges;
    };
    expect(run([fillerWordKey(0, de[0]!.words[1]!)])).toEqual([{ startSec: 11.1, endSec: 11.4 }]);
    expect(run(null)).toEqual([]);
    expect(run([fillerWordKey(1, de[0]!.words[1]!)])).toEqual([]);
  });
});
