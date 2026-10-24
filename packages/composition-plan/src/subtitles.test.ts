import { describe, expect, test } from "bun:test";
import { autoCensorWordId, captionPresetSchema, editorDocumentSchema, parseSuppliedCaptions, studioEditsSchema } from "@narriflow/validators";
import { captionCueText, captionCueVisibleRange, deriveCaptionCues, planClipComposition } from "./clip-composition-plan";
import { formatSubtitles } from "./subtitles";

type Word = [word: string, startSec: number, endSec: number];
function utterance(index: number, words: Word[]) {
  return {
    index, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9,
    startSec: words[0]![1], endSec: words.at(-1)![2], text: words.map(([word]) => word).join(" "),
    words: words.map(([word, startSec, endSec]) => ({ word, startSec, endSec, confidence: 0.9 })),
  };
}
const spoken: Word[] = [["Hello", 0.5, 0.9], ["there,", 1, 1.4], ["friends.", 1.5, 2], ["Today", 3, 3.4], ["we", 3.5, 3.7], ["build.", 3.8, 4.4]];
function document(patch: Record<string, unknown> = {}, preset: Record<string, unknown> = {}) {
  return editorDocumentSchema.parse({
    version: 1, clipStartSec: 0, clipEndSec: 6,
    captionPreset: captionPresetSchema.parse({ textTransform: "none", wordsPerCue: 3, ...preset }),
    transcriptSlice: [utterance(0, spoken)],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null, deletedRanges: [], ...patch,
  });
}

describe("subtitle cues share burn-in's derivation", () => {
  test("renders exact SRT and WebVTT text for the preset's cue grouping", () => {
    const cues = deriveCaptionCues(document());
    expect(formatSubtitles(cues, "srt")).toBe(
      "1\n00:00:00,500 --> 00:00:02,000\nHello there, friends.\n\n" +
      "2\n00:00:03,000 --> 00:00:04,400\nToday we build.\n\n",
    );
    expect(formatSubtitles(cues, "vtt")).toBe(
      "WEBVTT\n\n" +
      "00:00:00.500 --> 00:00:02.000\nHello there, friends.\n\n" +
      "00:00:03.000 --> 00:00:04.400\nToday we build.\n\n",
    );
  });

  test("supplied captions flow through the same cue derivation as spoken words, on every surface", () => {
    const supplied = parseSuppliedCaptions("1\n00:00:00,000 --> 00:00:03,000\nOne two three four five six\n\n2\n00:00:04,000 --> 00:00:05,000\nSeven eight");
    const captioned = document({ transcriptSlice: supplied }, { wordsPerCue: 3 });
    const cues = deriveCaptionCues(captioned);
    expect(cues.map((cue) => cue.text)).toEqual(["One two three", "four five six", "Seven eight"]);
    expect(cues.map((cue) => [cue.startSec, cue.endSec])).toEqual([[0, 1.5], [1.5, 3], [4, 5]]);
    const planned = planClipComposition({
      document: captioned, source: { identity: "source:test", kind: "video", width: 1080, height: 1920 },
      evidence: { automaticLayout: { state: "missing" } }, assets: { backgroundImage: { state: "missing" } },
      capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "t", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (planned.status === "invalid") throw new Error(planned.error.code);
    const burnedIn = planned.plan.targets[0]!.visualLayers.flatMap((layer) => layer.kind === "caption" ? [captionCueText(layer.words)] : []);
    expect(burnedIn).toEqual(cues.map((cue) => cue.text));
  });

  test("follows each preset's wordsPerCue and text treatment", () => {
    expect(deriveCaptionCues(document({}, { wordsPerCue: 1 })).map((cue) => cue.text)).toEqual(["Hello", "there,", "friends.", "Today", "we", "build."]);
    expect(deriveCaptionCues(document({}, { wordsPerCue: 2, textTransform: "uppercase", punctuation: false })).map((cue) => cue.text))
      .toEqual(["HELLO THERE", "FRIENDS TODAY", "WE BUILD"]);
  });

  test("captions turned off still produce subtitles when visibility is ignored", () => {
    const hidden = document({}, { visible: false });
    expect(deriveCaptionCues(hidden)).toEqual([]);
    expect(deriveCaptionCues(hidden, { ignoreVisibility: true })).toEqual(deriveCaptionCues(document()));
  });

  test("cuts remove spoken words and shift later cues into edited time", () => {
    const cues = deriveCaptionCues(document({ deletedRanges: [{ startSec: 0.95, endSec: 2.5 }] }));
    expect(cues.map((cue) => cue.text)).toEqual(["Hello Today we", "build."]);
    expect(cues[0]).toMatchObject({ startSec: 0.5 });
    expect(cues[1]!.startSec).toBeCloseTo(2.25, 6);
    expect(cues[1]!.endSec).toBeCloseTo(2.85, 6);
  });

  test("inserted scenes shift later cues and split a cue that spans the scene", () => {
    const sceneBlocks = [{ schemaVersion: 1, id: "10000000-0000-4000-8000-000000000001", anchorSec: 1.2, durationSec: 2,
      content: { kind: "color", color: "#112233" }, motion: { entrance: "fade", exit: "fade", durationSec: 0.5 }, templateSnapshot: null }];
    const cues = deriveCaptionCues(document({ sceneBlocks }));
    expect(cues.map((cue) => cue.text)).toEqual(["Hello there,", "there, friends.", "Today we build."]);
    // Neither slice shows the spanning word across the scene.
    expect(cues[0]!.endSec).toBeCloseTo(1.2, 6);
    expect(cues[1]!.startSec).toBeCloseTo(3.2, 6);
    expect(cues[2]).toMatchObject({ startSec: 5, endSec: 6.4 });
  });

  test("censored words keep the burn-in mask", () => {
    const word = { word: "Damn,", startSec: 0.5, endSec: 0.9, confidence: 0.9 };
    const sourceWordId = autoCensorWordId({ utteranceIndex: 0, wordIndex: 0, word });
    const censored = document({
      transcriptSlice: [utterance(0, [["Damn,", 0.5, 0.9], ["friends.", 1, 1.5]])],
      censorSegments: [{ schemaVersion: 1, id: "10000000-0000-4000-8000-000000000002", sourceWordIds: [sourceWordId], sourceStartSec: 0.5, sourceEndSec: 0.9,
        treatment: "caption_mask", paddingSec: 0, beepSettings: null, captionMaskPolicy: { replacement: "first_character", preservePunctuation: true },
        suggestionFingerprint: "a".repeat(64), policyVersion: "auto-censor-v1", enabled: true }],
    });
    const [cue] = deriveCaptionCues(censored);
    expect(cue!.text).not.toContain("Damn");
    expect(cue!.text.startsWith("D")).toBe(true);
    expect(cue!.text.endsWith(", friends.")).toBe(true);
  });

  test("cues are bounded by the clip window at its start and end", () => {
    const cues = deriveCaptionCues(document({ clipStartSec: 0.7, clipEndSec: 3.6 }));
    expect(cues[0]!.startSec).toBe(0);
    expect(cues.at(-1)!.endSec).toBeLessThanOrEqual(2.9 + 1e-9);
    expect(cues.map((cue) => cue.text)).toEqual(["Hello there, friends.", "Today we"]);
  });

  test("a short final word never extends a cue past the export's end", () => {
    // A 10 ms final word would otherwise keep its 50 ms minimum segment.
    const short = document({ clipStartSec: 0, clipEndSec: 4.41, transcriptSlice: [utterance(0, [["Ship", 3.8, 4.2], ["it.", 4.39, 4.4]])] });
    expect(deriveCaptionCues(short).at(-1)).toMatchObject({ text: "Ship it.", endSec: 4.41 });
  });

  test("non-ASCII text survives grouping, casing, and both formats", () => {
    const cues = deriveCaptionCues(document({ transcriptSlice: [utterance(0, [["Café", 0.5, 0.9], ["日本語", 1, 1.4], ["🎬", 1.5, 2]])] }, { textTransform: "uppercase" }));
    expect(cues.map((cue) => cue.text)).toEqual(["CAFÉ 日本語 🎬"]);
    expect(formatSubtitles(cues, "srt")).toContain("CAFÉ 日本語 🎬");
    expect(formatSubtitles(cues, "vtt")).toContain("CAFÉ 日本語 🎬");
  });

  test("cue text cannot break the subtitle file structure", () => {
    expect(formatSubtitles([{ startSec: 0, endSec: 1, text: "a\n\nb --> c" }], "vtt")).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\na b → c\n\n");
    expect(formatSubtitles([{ startSec: 3_725.5, endSec: 3_726, text: "late" }], "srt")).toBe("1\n01:02:05,500 --> 01:02:06,000\nlate\n\n");
  });

  test("burn-in and subtitles produce the same cue text and timing for one snapshot", () => {
    const sceneBlocks = [{ schemaVersion: 1, id: "10000000-0000-4000-8000-000000000003", anchorSec: 2.5, durationSec: 1,
      content: { kind: "color", color: "#112233" }, motion: { entrance: "fade", exit: "fade", durationSec: 0.5 }, templateSnapshot: null }];
    const snapshot = document({ deletedRanges: [{ startSec: 1.45, endSec: 2.2 }], sceneBlocks });
    const result = planClipComposition({
      document: snapshot,
      source: { identity: "source:parity", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }, { id: "square", aspectRatio: "1:1", width: 1080, height: 1080 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);
    const subtitles = deriveCaptionCues(snapshot);
    expect(subtitles.length).toBeGreaterThan(0);
    for (const target of result.plan.targets) {
      const burned = target.visualLayers.flatMap((layer) => layer.kind === "caption"
        ? [{ ...captionCueVisibleRange(layer, result.plan.editedDurationSec), text: captionCueText(layer.words) }] : []);
      expect(burned).toEqual(subtitles);
    }
  });
});
