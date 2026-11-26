import { describe, expect, test } from "bun:test";
import { planClipComposition } from "@narriflow/composition-plan";
import { BRAND_DEFAULT_CAPTION_PRESET_ID, buildCaptionedVideoContentPack, buildCaptionedVideoSettings, buildGenerationContentPack, DEFAULT_CAPTION_PRESET, encodeQuietRanges, fillerWordKey, normalizeTranscriptSliceForClip, type CaptionEmojiPick, type FillerTaggingOutcome,
  type TranscriptUtterance, type TranscriptWord } from "@narriflow/validators";
import { decodeClipEditorDocumentFromStorage } from "./clip-editor-document-codec";
import { buildDetectedClipRows, prepareDetectedClipSeed, runDefaultCaptionPreset, type DetectedClip } from "./clip-detection-persistence";

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

describe("generation framing", () => {
  test.each([
    { name: "caption-only upload", pack: buildGenerationContentPack({ mode: "caption_only" }), mode: "fit" },
    { name: "captioned video Fit", pack: buildCaptionedVideoContentPack(buildCaptionedVideoSettings({ framing: "fit" })), mode: "fit" },
    { name: "captioned video Center", pack: buildCaptionedVideoContentPack(buildCaptionedVideoSettings({ framing: "center" })), mode: "center" },
    { name: "AI clipping", pack: buildGenerationContentPack({ mode: "clip" }), mode: "auto" },
  ])("$name starts with $mode framing", ({ pack, mode }) => {
    const seed = prepareDetectedClipSeed(project, pack, { quietRanges: null, languageCode: "en" });
    const [row] = buildDetectedClipRows({ projectId: "p", workflowRunId: "w", clips: [clip()], seed, utterances: slice,
      llmMeta: { provider: "openai", model: pack.mode === "caption_only" ? "caption-only" : "m", totalTokensUsed: 0 } });
    const result = planClipComposition({
      document: decodeClipEditorDocumentFromStorage(row!, { durationSec: 60, wholeSource: seed.wholeSource }),
      source: { identity: "source:p", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "9:16", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.targets[0]!.requestedMode).toBe(mode);
    expect(result.plan.evidenceRequests.map(request => request.kind)).toEqual(mode === "auto" ? ["automatic-speaker-layout"] : []);
    expect(result.plan.notices.map(notice => notice.code)).toEqual(mode === "auto" ? ["automatic_layout_analyzing"] : []);
    expect(result.status).toBe(mode === "auto" ? "pending" : "ready");
  });
});

function rows(settings: { removeSilences?: boolean; removeFillerWords?: boolean }, source = { quietRanges, languageCode: "en" as string | null }) {
  const seed = prepareDetectedClipSeed(project, buildGenerationContentPack(settings), source);
  return buildDetectedClipRows({ projectId: "p", workflowRunId: "w", clips: [clip()], seed, utterances: slice, llmMeta: { provider: "openai", model: "m", totalTokensUsed: 1 } });
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
      return buildDetectedClipRows({ projectId: "p", workflowRunId: "w", clips: [{ ...clip(), transcriptSlice: de }], seed, utterances: de, llmMeta: { provider: "openai", model: "m", totalTokensUsed: 1 } })[0]!.deletedRanges;
    };
    expect(run([fillerWordKey(0, de[0]!.words[1]!)])).toEqual([{ startSec: 11.1, endSec: 11.4 }]);
    expect(run(null)).toEqual([]);
    expect(run([fillerWordKey(1, de[0]!.words[1]!)])).toEqual([]);
  });
});

describe("Clip Emphasis Words at generation", () => {
  const build = (emphasisWords: string[] | undefined) => {
    const seed = prepareDetectedClipSeed(project, buildGenerationContentPack({}), { quietRanges, languageCode: "en" });
    return buildDetectedClipRows({ projectId: "p", workflowRunId: "w", clips: [{ ...clip(), ...(emphasisWords ? { emphasisWords } : {}) }], seed, utterances: slice,
      llmMeta: { provider: "openai", model: "m", totalTokensUsed: 1 } })[0]!;
  };

  test("keeps the words found in the clip's transcript and drops the rest", () => {
    expect(build(["GO", "we go", "rocket", "so we go"]).emphasisWords).toEqual(["GO", "we go"]);
  });

  test("no words, or only invented ones, leave the column empty", () => {
    expect("emphasisWords" in build(undefined)).toBe(false);
    expect("emphasisWords" in build(["rocket"])).toBe(false);
  });
});

describe("Caption Emojis at generation", () => {
  const pick = (key: string, id: string, strength: number): CaptionEmojiPick => ({ key, ref: { id }, strength });
  // So (10) um (13.5) we (13.9) go (15.1), plus a pick on a word outside the clip.
  const picks = [pick("10000", "waving-hand", 2), pick("13500", "thinking", 3), pick("13900", "people-hugging", 3), pick("15100", "rocket", 2), pick("50000", "flame", 3)];
  const build = (settings: { addEmojis?: boolean; removeFillerWords?: boolean }, emojiPicks: CaptionEmojiPick[] | null, brandEmojis = false) => {
    const brand = { ...project, brandSnapshot: { captionPreset: { ...DEFAULT_CAPTION_PRESET, emojis: brandEmojis } } };
    const seed = prepareDetectedClipSeed(brand, buildGenerationContentPack(settings), { quietRanges: null, languageCode: "en", emojiPicks });
    const [row] = buildDetectedClipRows({ projectId: "p", workflowRunId: "w", clips: [clip()], seed, utterances: slice, llmMeta: { provider: "openai", model: "m", totalTokensUsed: 1 } });
    return decodeClipEditorDocumentFromStorage(row!, { durationSec: 60, wholeSource: false });
  };

  test("keeps picks on the clip's kept words at balanced density", () => {
    // "um" is cut and the pick outside the clip has no word; "go" is 1.2 s after "we" in edited time.
    const document = build({ addEmojis: true, removeFillerWords: true }, picks);
    expect(document.studioEdits.captionEmojis).toEqual({ "10000": { id: "waving-hand" }, "13900": { id: "people-hugging" } });
    // Balanced keeps strength 2 and 3 only.
    expect(build({ addEmojis: true, removeFillerWords: true }, [pick("10000", "waving-hand", 1), ...picks.slice(1)]).studioEdits.captionEmojis)
      .toEqual({ "13900": { id: "people-hugging" } });
    expect(document.captionPreset.emojis).toBe(true);
  });

  test("a pick on the word that straddles the clip start is kept, though slicing moved that word's start", () => {
    // The source: "really" (9.4-9.7) ends before the clip; "So" (9.8-11) starts before it and is clamped to 10.
    const source: TranscriptUtterance[] = [{ ...slice[0]!, startSec: 9.4, text: "really So um we go", words: [word(9.4, 9.7, "really"), word(9.8, 11, "So"), ...slice[0]!.words.slice(1)] }];
    const sliced = normalizeTranscriptSliceForClip(source, 10, 30);
    expect(sliced[0]!.words[0]).toMatchObject({ word: "So", startSec: 10 });
    const seed = prepareDetectedClipSeed(project, buildGenerationContentPack({ addEmojis: true }), { quietRanges: null, languageCode: "en",
      emojiPicks: [pick("9400", "fire", 3), pick("9800", "waving-hand", 3)] });
    const [row] = buildDetectedClipRows({ projectId: "p", workflowRunId: "w", clips: [{ ...clip(), transcriptSlice: sliced }], seed, utterances: source,
      llmMeta: { provider: "openai", model: "m", totalTokensUsed: 1 } });
    expect(decodeClipEditorDocumentFromStorage(row!, { durationSec: 60, wholeSource: false }).studioEdits.captionEmojis).toEqual({ "10000": { id: "waving-hand" } });
  });

  test("Add emojis alone decides the preset switch, whatever the brand style says", () => {
    expect(build({ addEmojis: false }, null, true).captionPreset.emojis).toBe(false);
    expect(build({ addEmojis: true }, null, false).captionPreset.emojis).toBe(true);
  });

  test("a clip added later to the run (library search) follows the run's Add emojis, not the brand style", () => {
    const brand = { captionPreset: { ...DEFAULT_CAPTION_PRESET, emojis: true } };
    expect(runDefaultCaptionPreset(brand, { captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID, addEmojis: false }).emojis).toBe(false);
    expect(runDefaultCaptionPreset(null, { captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID, addEmojis: true }).emojis).toBe(true);
    expect(runDefaultCaptionPreset(brand, null).emojis).toBe(false);
  });

  test("no picks (tagging off, failed or dropped from the capsule) leave the clip without emojis", () => {
    expect("captionEmojis" in build({ addEmojis: true }, null).studioEdits).toBe(false);
    expect("captionEmojis" in build({ addEmojis: true }, []).studioEdits).toBe(false);
    expect("captionEmojis" in build({ addEmojis: true }, [pick("50000", "flame", 3)]).studioEdits).toBe(false);
  });
});
