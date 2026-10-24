import { describe, expect, test } from "bun:test";
import {
  buildCaptionedVideoSettings,
  captionedVideoExportOptionsSchema,
  captionedVideoFramingEdits,
  captionedVideoFramingNotices,
  captionedVideoOptionsSchema,
  captionedVideoSettingsSchema,
  planTranscript,
} from "./captioned-video";
import {
  clipAspectRatioSchema,
  clipDurationBounds,
  clipRenderResolutionSchema,
  updateClipBoundariesSchema,
  clipDurationWithinBounds,
  clipSourceEdgeSec,
  wholeSourceWindow,
  wholeSourceWindowFault,
} from "./clip";
import { contentPackSchema, parseStoredContentPack } from "./content-pack";
import { buildCaptionedVideoContentPack } from "./integration";
import type { SourceProbe } from "./source-probe";
import { studioEditsSchema } from "./studio-edits";
import { openUploadSessionSchema } from "./upload";
import { SuppliedCaptionsError } from "./supplied-captions";

const probe = (width: number, height: number, audio: SourceProbe["audio"] = { sampleRate: 48_000, channels: 2 }): SourceProbe => ({
  durationSec: 8,
  video: { width, height, frameRate: { numerator: 24, denominator: 1 }, startTimecode: null },
  audio,
});
const srt = "1\n00:00:00,000 --> 00:00:02,000\nHello there";

describe("captioned video settings", () => {
  test("default to Fit, one 9:16 1080p export, and speech captions", () => {
    expect(buildCaptionedVideoSettings({})).toEqual({ framing: "fit", aspectRatios: ["9:16"], resolution: "1080p", captions: { source: "auto" } });
  });

  test("supplied captions are normalized into utterances at acceptance; the request carries text only", () => {
    const settings = buildCaptionedVideoSettings({ framing: "center", aspectRatios: ["1:1", "16:9"], resolution: "720p", captions: { source: "supplied", text: srt } });
    expect(settings.captions).toMatchObject({ source: "supplied", utterances: [{ text: "Hello there", words: [{ word: "Hello" }, { word: "there" }] }] });
    expect(captionedVideoSettingsSchema.parse(settings)).toEqual(settings);
    expect(() => buildCaptionedVideoSettings({ captions: { source: "supplied", text: "nope" } })).toThrow(SuppliedCaptionsError);
  });

  test("reject unknown fields, unknown framing, and repeated or missing formats", () => {
    for (const input of [{ framing: "stretch" }, { aspectRatios: [] }, { aspectRatios: ["9:16", "9:16"] }, { aspectRatios: ["2:1"] }, { resolution: "4k" }, { extra: true }, { captions: { source: "supplied" } }]) {
      expect(captionedVideoOptionsSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
    expect(captionedVideoExportOptionsSchema.parse({})).toEqual({ aspectRatios: ["9:16"], resolution: "1080p" });
  });

  test("the formats and resolutions mirror the clip schemas", () => {
    expect(captionedVideoExportOptionsSchema.shape.aspectRatios.unwrap().element.options).toEqual(clipAspectRatioSchema.options);
    expect(captionedVideoExportOptionsSchema.shape.resolution.unwrap().options).toEqual(clipRenderResolutionSchema.options);
  });

  test("freeze into a caption-only Content Pack that survives storage, and require caption_only", () => {
    const settings = buildCaptionedVideoSettings({ framing: "center", aspectRatios: ["4:5"], captions: { source: "none" } });
    const pack = buildCaptionedVideoContentPack(settings);
    expect(pack).toMatchObject({ mode: "caption_only", defaultAspectRatio: "4:5", processingStartSec: null, captionedVideo: settings });
    expect(parseStoredContentPack(JSON.parse(JSON.stringify(pack)))).toEqual(pack);
    expect(parseStoredContentPack({ ...pack, captionedVideo: null }).captionedVideo).toBeUndefined();
    expect(contentPackSchema.safeParse({ ...pack, mode: "clip" }).success).toBe(false);
  });

  test("an Upload Session carries the frozen settings, with supplied utterances, to the project it creates", () => {
    const settings = buildCaptionedVideoSettings({ aspectRatios: ["16:9"], captions: { source: "supplied", text: srt } });
    const opened = openUploadSessionSchema.parse({
      clientIdempotencyKey: "6d27d010-f52c-4e5c-9ea3-012c0bf7d921", title: "AI short",
      source: { fileName: "short.mp4", sizeBytes: 4_000_000, contentType: "video/mp4", browserFingerprint: "rest" },
      generationContext: { contentPack: buildCaptionedVideoContentPack(settings), languageCode: null },
    });
    expect(opened.generationContext.contentPack.captionedVideo).toEqual(settings);
    expect(JSON.parse(JSON.stringify(opened)).generationContext.contentPack.captionedVideo).toEqual(settings);
  });

  test("each framing is expressed as Studio edits the composition plan already renders", () => {
    expect(studioEditsSchema.parse(captionedVideoFramingEdits("fit")).background).toEqual({ mode: "color", color: null, imageUrl: null });
    expect(studioEditsSchema.parse(captionedVideoFramingEdits("fit")).framing.mode).toBe("auto");
    expect(studioEditsSchema.parse(captionedVideoFramingEdits("center")).framing.mode).toBe("center");
    expect(studioEditsSchema.parse(captionedVideoFramingEdits("center")).background.mode).toBe("off");
  });
});

describe("planTranscript", () => {
  const auto = { framing: "fit", aspectRatios: ["9:16"], resolution: "1080p", captions: { source: "auto" } } as const;
  const supplied = buildCaptionedVideoSettings({ captions: { source: "supplied", text: srt } });

  test("speech-to-text runs only for auto captions on a source that may have speech", () => {
    expect(planTranscript({ captionedVideo: auto, sourceProbe: probe(1080, 1920) })).toEqual({ kind: "speech_to_text" });
    expect(planTranscript({ captionedVideo: auto, sourceProbe: null })).toEqual({ kind: "speech_to_text" });
    expect(planTranscript({ sourceProbe: probe(1920, 1080) })).toEqual({ kind: "speech_to_text" });
  });

  test("is skipped when captions are supplied or declined, whatever the audio", () => {
    expect(planTranscript({ captionedVideo: supplied, sourceProbe: probe(1080, 1920) })).toEqual({ kind: "supplied", utterances: supplied.captions.source === "supplied" ? supplied.captions.utterances : [] });
    expect(planTranscript({ captionedVideo: { ...auto, captions: { source: "none" } }, sourceProbe: probe(1080, 1920) })).toEqual({ kind: "empty", reason: "captions_none" });
    expect(planTranscript({ captionedVideo: supplied, sourceProbe: probe(1080, 1920, null) }).kind).toBe("supplied");
  });

  test("is skipped for any source with no audio stream, captioned video or not", () => {
    expect(planTranscript({ captionedVideo: auto, sourceProbe: probe(1080, 1920, null) })).toEqual({ kind: "empty", reason: "no_audio_stream" });
    expect(planTranscript({ sourceProbe: probe(1080, 1920, null) })).toEqual({ kind: "empty", reason: "no_audio_stream" });
  });
});

describe("framing notices", () => {
  const center = (aspectRatios: Array<"9:16" | "1:1" | "16:9" | "4:5">) => ({ framing: "center" as const, aspectRatios });

  test("Center reports how much of the frame each requested format discards", () => {
    expect(captionedVideoFramingNotices(center(["9:16", "1:1", "16:9", "4:5"]), probe(1920, 1080))).toEqual([
      { code: "framing_degraded", aspectRatio: "9:16", croppedPercent: 68 },
      { code: "framing_degraded", aspectRatio: "1:1", croppedPercent: 44 },
      { code: "framing_degraded", aspectRatio: "4:5", croppedPercent: 55 },
    ]);
    expect(captionedVideoFramingNotices(center(["9:16", "16:9"]), probe(1080, 1920))).toEqual([{ code: "framing_degraded", aspectRatio: "16:9", croppedPercent: 68 }]);
  });

  test("a crop that discards nothing, Fit, and an unprobed or audio-only source report nothing", () => {
    expect(captionedVideoFramingNotices(center(["9:16"]), probe(1080, 1920))).toEqual([]);
    expect(captionedVideoFramingNotices({ framing: "fit", aspectRatios: ["9:16"] }, probe(1920, 1080))).toEqual([]);
    expect(captionedVideoFramingNotices(center(["9:16"]), null)).toEqual([]);
    expect(captionedVideoFramingNotices(center(["9:16"]), { ...probe(1, 1), video: null })).toEqual([]);
  });
});

describe("the clip boundary policy", () => {
  test("detected clips keep 10 to 120 seconds; whole-source clips are 1 to 180", () => {
    expect(clipDurationBounds(false)).toEqual({ minSec: 10, maxSec: 120 });
    expect(clipDurationBounds(true)).toEqual({ minSec: 1, maxSec: 180 });
  });

  test("a whole-source window is the processing window or the source, never past what persistence accepts", () => {
    const none = { processingStartSec: null, processingEndSec: null };
    expect(wholeSourceWindow(none, { durationSec: 8, probeDurationSec: 7.6 })).toEqual({ startSec: 0, endSec: 7.6 });
    // The rounded duration can fall short of the media: the probe is the edge, so no tail is lost.
    expect(wholeSourceWindow(none, { durationSec: 8, probeDurationSec: 8.4 })).toEqual({ startSec: 0, endSec: 8.4 });
    expect(wholeSourceWindow(none, { durationSec: 180, probeDurationSec: 180.4 })).toEqual({ startSec: 0, endSec: 180.4 });
    expect(wholeSourceWindow(none, { durationSec: 180, probeDurationSec: null })).toEqual({ startSec: 0, endSec: 180 });
    expect(wholeSourceWindow({ processingStartSec: 5, processingEndSec: 35 }, { durationSec: 50, probeDurationSec: 50.2 })).toEqual({ startSec: 5, endSec: 35 });
    expect(wholeSourceWindow({ processingStartSec: 5, processingEndSec: 90 }, { durationSec: 50, probeDurationSec: null })).toEqual({ startSec: 5, endSec: 50 });
  });

  test("windows of 1 to 180 seconds are clips; others have a typed fault", () => {
    expect(wholeSourceWindowFault({ startSec: 0, endSec: 1 })).toBeNull();
    expect(wholeSourceWindowFault({ startSec: 0, endSec: 8 })).toBeNull();
    expect(wholeSourceWindowFault({ startSec: 0, endSec: 180 })).toBeNull();
    expect(wholeSourceWindowFault({ startSec: 0, endSec: 0.9 })).toBe("whole_source_too_short");
    // A source that rounds to 180 seconds is a 3 minute source; one that rounds to 181 is not.
    expect(wholeSourceWindowFault({ startSec: 0, endSec: 180.4 })).toBeNull();
    expect(wholeSourceWindowFault({ startSec: 0, endSec: 180.5 })).toBe("whole_source_too_long");
    expect(wholeSourceWindowFault({ startSec: 5, endSec: 185.4 })).toBeNull();
  });

  test("whole-source clips may run to the rounding slack; detected clips get none", () => {
    expect(clipDurationWithinBounds(8.4, true)).toBe(true);
    expect(clipDurationWithinBounds(180.4, true)).toBe(true);
    expect(clipDurationWithinBounds(180.5, true)).toBe(false);
    expect(clipDurationWithinBounds(0.9, true)).toBe(false);
    expect(clipDurationWithinBounds(120, false)).toBe(true);
    expect(clipDurationWithinBounds(120.4, false)).toBe(false);
  });

  test("a clip's source edge is the probed duration when known, else the rounded one", () => {
    expect(clipSourceEdgeSec({ sourceDurationSeconds: 8, sourceProbe: { durationSec: 8.4 } })).toBe(8.4);
    expect(clipSourceEdgeSec({ sourceDurationSeconds: 180, sourceProbe: { durationSec: 180.4 } })).toBe(180.4);
    expect(clipSourceEdgeSec({ sourceDurationSeconds: 8, sourceProbe: null })).toBe(8);
    expect(clipSourceEdgeSec({ sourceDurationSeconds: 8 })).toBe(8);
    expect(clipSourceEdgeSec({ sourceDurationSeconds: 8, sourceProbe: { durationSec: 0 } })).toBe(8);
    expect(clipSourceEdgeSec({ sourceDurationSeconds: 8, sourceProbe: { durationSec: "8.4" } })).toBe(8);
    expect(clipSourceEdgeSec({ sourceDurationSeconds: null, sourceProbe: null })).toBeNull();
  });

  test("the boundaries request has a shape only; the clip's policy decides its length", () => {
    expect(updateClipBoundariesSchema.safeParse({ startSec: 0, endSec: 3 }).success).toBe(true);
    expect(updateClipBoundariesSchema.safeParse({ startSec: 3, endSec: 3 }).success).toBe(false);
  });
});
