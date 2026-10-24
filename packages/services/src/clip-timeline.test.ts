import { describe, expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema, type SourceProbe } from "@narriflow/validators";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";
import { clipExportSubtitleFiles } from "./clip-export-subtitles";
import { clipTimelineFiles, clipTimelineSource } from "./clip-timeline";

const PROBE: SourceProbe = {
  durationSec: 600,
  video: { width: 1920, height: 1080, frameRate: { numerator: 25, denominator: 1 }, startTimecode: null },
  audio: { sampleRate: 48_000, channels: 2 },
};
const SCENE = {
  id: "8ab9d330-688f-4574-932c-27ac661245c1", schemaVersion: 1, anchorSec: 0, durationSec: 2,
  content: { kind: "text", text: "Opening", fontFamily: "Arial", fontAsset: null, color: "#FFFFFF", backgroundColor: "#111827" },
  motion: { entrance: "fade", exit: "fade" }, templateSnapshot: null,
};
const project = { title: "Quarterly Talk", sourceStorageKey: "projects/p/upload/source.MOV", sourceProbe: PROBE, sourceDurationSeconds: 600 };

const FROZEN_WORDS: Array<[string, number, number]> = [["Frozen", 10.5, 11], ["words", 11.1, 11.6], ["only", 12, 12.5]];

function storedClip(edits: { deletedRanges?: Array<{ startSec: number; endSec: number }>; sceneBlocks?: unknown[]; words?: Array<[string, number, number]>; wordsPerCue?: number } = {}) {
  const words = edits.words ?? FROZEN_WORDS;
  const document = editorDocumentSchema.parse({
    version: 1, clipStartSec: 10, clipEndSec: 22,
    captionPreset: captionPresetSchema.parse({ textTransform: "none", wordsPerCue: edits.wordsPerCue ?? 2 }),
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9, startSec: words[0]![1], endSec: words.at(-1)![2], text: words.map(([word]) => word).join(" "),
      words: words.map(([word, startSec, endSec]) => ({ word, startSec, endSec, confidence: 0.9 })) }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null, deletedRanges: edits.deletedRanges ?? [], sceneBlocks: edits.sceneBlocks ?? [],
  });
  return { ...encodeClipEditorDocumentForStorage(document, { durationSec: 600, wholeSource: false }), llmModel: "gpt-test", title: "Big Idea", hookText: "Hook", editorRevision: 4 };
}

describe("clip timeline files", () => {
  test("an uncut clip is one cut of the source at the clip's bounds, named for its revision", () => {
    const files = clipTimelineFiles({ clip: storedClip(), project, format: "edl" });
    expect(files.timeline.fileName).toBe("Big-Idea-v4.edl");
    expect(files.timeline.content).toContain("001  AX       AA/V  C        00:00:10:00 00:00:22:00 01:00:00:00 01:00:12:00");
    expect(files.timeline.content).toContain("* FROM CLIP NAME: Quarterly-Talk-source.mov");
    expect(files.subtitles.fileName).toBe("Big-Idea-v4.srt");
  });

  test("deleted ranges become cuts, in order, on the same source file", () => {
    const files = clipTimelineFiles({ clip: storedClip({ deletedRanges: [{ startSec: 13, endSec: 16 }, { startSec: 19, endSec: 20 }] }), project, format: "xmeml" });
    const { xmeml } = new XMLParser({ isArray: (name) => name === "clipitem" || name === "track" }).parse(files.timeline.content);
    const video = xmeml.sequence.media.video.track[0].clipitem as Array<Record<string, number>>;
    expect(video.map((item) => [item.in, item.out, item.start, item.end])).toEqual([
      [250, 325, 0, 75],
      [400, 475, 75, 150],
      [500, 550, 150, 200],
    ]);
    expect(xmeml.sequence.duration).toBe(200);
  });

  test("a kept range shorter than the render keeps is dropped, as the render drops it", () => {
    const files = clipTimelineFiles({ clip: storedClip({ deletedRanges: [{ startSec: 10, endSec: 15 }, { startSec: 15.05, endSec: 18 }] }), project, format: "edl" });
    expect(files.timeline.content.match(/^\d{3} /gm)).toHaveLength(1);
    expect(files.timeline.content).toContain("00:00:18:00 00:00:22:00 01:00:00:00 01:00:04:00");
  });

  test("captions are timed on the timeline's own cuts, so a dropped sliver does not shift them", () => {
    // 11.00 to 11.05 is kept between two deletions, too short to render, so the
    // timeline drops it. The first kept word must start at the timeline's start.
    const clip = storedClip({ words: [["one", 12.2, 12.6], ["two", 14, 14.4]], deletedRanges: [{ startSec: 10, endSec: 11 }, { startSec: 11.05, endSec: 12 }], wordsPerCue: 1 });
    const files = clipTimelineFiles({ clip, project, format: "edl" });
    expect(files.timeline.content).toContain("00:00:12:00 00:00:22:00 01:00:00:00 01:00:10:00");
    expect(files.subtitles.content).toBe("1\n00:00:00,200 --> 00:00:00,600\none\n\n2\n00:00:02,000 --> 00:00:02,400\ntwo\n\n");
  });

  test("every cue lands on the frame the timeline plays its word, across many cuts", () => {
    const words: Array<[string, number, number]> = [["alpha", 10.2, 10.5], ["beta", 13.2, 13.6], ["gamma", 17.3, 17.7], ["delta", 20.4, 20.8]];
    const clip = storedClip({ words, wordsPerCue: 1, deletedRanges: [{ startSec: 10.8, endSec: 13 }, { startSec: 15, endSec: 17 }, { startSec: 19.5, endSec: 20 }] });
    const files = clipTimelineFiles({ clip, project, format: "xmeml" });
    const { xmeml } = new XMLParser({ isArray: (name) => name === "clipitem" || name === "track" }).parse(files.timeline.content);
    const cuts = xmeml.sequence.media.video.track[0].clipitem as Array<Record<string, number>>;
    expect(cuts).toHaveLength(4);
    const cues = [...files.subtitles.content.matchAll(/(\d\d):(\d\d):(\d\d),(\d{3}) -->/g)].map(([, h, m, s, ms]) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000);
    expect(cues).toHaveLength(4);
    words.forEach(([, wordStart], index) => {
      const cut = cuts.find((item) => item.in! <= wordStart * 25 && wordStart * 25 < item.out!)!;
      const playedAtFrame = cut.start! + (wordStart * 25 - cut.in!);
      expect(Math.abs(cues[index]! - playedAtFrame / 25)).toBeLessThanOrEqual(1 / 25);
    });
  });

  test("a start timecode in the source moves source timecode in the timeline, not the cuts", () => {
    const probe = { ...PROBE, video: { ...PROBE.video!, startTimecode: "01:00:00:00" } };
    const files = clipTimelineFiles({ clip: storedClip(), project: { ...project, sourceProbe: probe }, format: "edl" });
    expect(files.timeline.content).toContain("01:00:10:00 01:00:22:00 01:00:00:00 01:00:12:00");
  });

  test("the SRT is the export's caption cues, cut along with the footage and without inserted scenes", () => {
    const cut = storedClip({ deletedRanges: [{ startSec: 11.05, endSec: 11.95 }] });
    const files = clipTimelineFiles({ clip: cut, project, format: "edl" });
    const [exportSrt] = clipExportSubtitleFiles(cut, 600, "x");
    expect(files.subtitles.content).toBe(exportSrt!.content);

    const withScene = storedClip({ deletedRanges: [{ startSec: 11.05, endSec: 11.95 }], sceneBlocks: [SCENE] });
    const [sceneSrt] = clipExportSubtitleFiles(withScene, 600, "x");
    expect(sceneSrt!.content).not.toBe(exportSrt!.content);
    expect(clipTimelineFiles({ clip: withScene, project, format: "edl" }).subtitles.content).toBe(exportSrt!.content);
  });

  test("captions come out even when they are hidden in the burned-in render", () => {
    const clip = storedClip();
    const hidden = { ...clip, captionPreset: { ...(clip.captionPreset as object), visible: false } };
    expect(clipTimelineFiles({ clip: hidden, project, format: "edl" }).subtitles.content).toBe(clipTimelineFiles({ clip, project, format: "edl" }).subtitles.content);
    expect(clipTimelineFiles({ clip, project, format: "edl" }).subtitles.content).toContain("Frozen words");
  });
});

describe("clip timeline refusals", () => {
  const refusal = (input: Parameters<typeof clipTimelineFiles>[0]) => {
    try {
      clipTimelineFiles(input);
    } catch (error) {
      return error;
    }
    throw new Error("expected a refusal");
  };

  test("a source that is no longer stored has nothing to cut", () => {
    expect(refusal({ clip: storedClip(), project: { ...project, sourceStorageKey: null }, format: "edl" })).toMatchObject({ code: "timeline_source_unavailable", kind: "conflict" });
  });

  test("a source imported before probing, or an unreadable probe, asks for a re-import", () => {
    expect(refusal({ clip: storedClip(), project: { ...project, sourceProbe: null }, format: "edl" })).toMatchObject({ code: "timeline_source_unmeasured", kind: "unprocessable" });
    expect(refusal({ clip: storedClip(), project: { ...project, sourceProbe: { durationSec: -1 } }, format: "edl" })).toMatchObject({ code: "timeline_source_unmeasured" });
  });

  test.each([
    [{ numerator: 25, denominator: 2 }, 12.5],
    [{ numerator: 90_000, denominator: 1 }, 90_000],
    [{ numerator: 2997, denominator: 100 }, 29.97],
  ])("a frame rate of %j is not one editors share", (frameRate, fps) => {
    const probe = { ...PROBE, video: { ...PROBE.video!, frameRate } };
    expect(refusal({ clip: storedClip(), project: { ...project, sourceProbe: probe }, format: "edl" }))
      .toMatchObject({ code: "timeline_source_rate_unsupported", kind: "unprocessable", details: { fps } });
  });

  test("an audio-only source cannot be a video timeline", () => {
    expect(refusal({ clip: storedClip(), project: { ...project, sourceProbe: { ...PROBE, video: null } }, format: "edl" })).toMatchObject({ code: "timeline_video_required" });
  });
});

describe("clip timeline source", () => {
  test("names the source after the project, with the stored extension", () => {
    expect(clipTimelineSource({ title: "Quarterly Talk", sourceStorageKey: "projects/p/link/1700-talk.mp4" })).toEqual({ storageKey: "projects/p/link/1700-talk.mp4", fileName: "Quarterly-Talk-source.mp4" });
    expect(clipTimelineSource({ title: "Café, 2026!", sourceStorageKey: "projects/p/upload/x.WebM" }).fileName).toBe("Cafe-2026-source.webm");
  });

  test("an odd extension falls back to mp4", () => {
    expect(clipTimelineSource({ title: "Talk", sourceStorageKey: "projects/p/upload/blob" }).fileName).toBe("Talk-source.mp4");
    expect(clipTimelineSource({ title: "Talk", sourceStorageKey: "projects/p/upload/x.toolongext" }).fileName).toBe("Talk-source.mp4");
  });
});
