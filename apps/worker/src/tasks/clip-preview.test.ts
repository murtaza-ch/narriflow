import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import {
  audiogramPreviewDimensions,
  buildAudiogramPreviewArgs,
  buildClipPreviewArgs,
  buildPeaksExtractionArgs,
  classifyMediaStreams,
  clipPreviewAttemptStorageKey,
  computeAmplitudePeaks,
  computeClipPreviewWindow,
  isAttachedPictureStream,
  type ProbeStreamLite,
  previewTimeToSourceTime,
  quantizePeaks,
  sourceTimeToPreviewTime,
} from "./clip-preview";

describe("computeClipPreviewWindow (padding + clamping)", () => {
  test("pads a mid-source clip symmetrically on both sides", () => {
    const window = computeClipPreviewWindow(100, 130, 600, 4);
    expect(window.startSec).toBe(96);
    expect(window.endSec).toBe(134);
    expect(window.durationSec).toBe(38);
  });

  test("clamps the lower bound to 0 near the start of the source", () => {
    const window = computeClipPreviewWindow(2, 20, 600, 4);
    expect(window.startSec).toBe(0);
    expect(window.endSec).toBe(24);
    expect(window.durationSec).toBe(24);
  });

  test("clamps the upper bound to sourceDurationSec near the end of the source", () => {
    const window = computeClipPreviewWindow(580, 598, 600, 4);
    expect(window.startSec).toBe(576);
    expect(window.endSec).toBe(600);
    expect(window.durationSec).toBe(24);
  });

  test("clamps both bounds when the whole source is shorter than the padded window", () => {
    const window = computeClipPreviewWindow(1, 9, 10, 4);
    expect(window.startSec).toBe(0);
    expect(window.endSec).toBe(10);
    expect(window.durationSec).toBe(10);
  });

  test("only clamps the lower bound when sourceDurationSec is unknown", () => {
    const window = computeClipPreviewWindow(1, 30, null, 4);
    expect(window.startSec).toBe(0);
    expect(window.endSec).toBe(34);
    expect(window.durationSec).toBe(34);
  });

  test("never inverts into a negative duration for a degenerate clip", () => {
    const window = computeClipPreviewWindow(5, 5, 10, 4);
    expect(window.durationSec).toBeGreaterThanOrEqual(0);
    expect(window.endSec).toBeGreaterThanOrEqual(window.startSec);
  });

  test("defaults padding from the module's own default when omitted", () => {
    const withDefault = computeClipPreviewWindow(100, 130, 600);
    const withExplicit4 = computeClipPreviewWindow(100, 130, 600, 4);
    expect(withDefault).toEqual(withExplicit4);
  });
});

describe("source-time <-> preview-time mapping", () => {
  test("sourceTimeToPreviewTime subtracts previewStartSec", () => {
    expect(sourceTimeToPreviewTime(100, 96)).toBe(4);
    expect(sourceTimeToPreviewTime(96, 96)).toBe(0);
  });

  test("previewTimeToSourceTime is the exact inverse", () => {
    expect(previewTimeToSourceTime(4, 96)).toBe(100);
    expect(previewTimeToSourceTime(0, 96)).toBe(96);
  });

  test("round-trips for arbitrary values", () => {
    const previewStartSec = 217.35;
    const sourceTimeSec = 260.1;
    const previewTimeSec = sourceTimeToPreviewTime(sourceTimeSec, previewStartSec);
    expect(previewTimeToSourceTime(previewTimeSec, previewStartSec)).toBeCloseTo(
      sourceTimeSec,
      9,
    );
  });

  test("an off-by-previewStartSec bug would desync by exactly previewStartSec", () => {
    // Guards the exact failure mode called out in the task: forgetting the
    // offset entirely (i.e. treating proxy time as source time) is off by
    // precisely previewStartSec, never by some other amount.
    const previewStartSec = 96;
    const sourceTimeSec = 100;
    const correct = sourceTimeToPreviewTime(sourceTimeSec, previewStartSec);
    const buggy = sourceTimeSec; // the bug: forgetting to subtract the offset
    expect(buggy - correct).toBe(previewStartSec);
  });
});

describe("clipPreviewAttemptStorageKey", () => {
  test("mirrors the projects/<id>/<namespace>/<clipId>/... convention", () => {
    expect(clipPreviewAttemptStorageKey("proj-1", "clip-1", "attempt-1")).toBe(
      "projects/proj-1/previews/clip-1/attempt-1.mp4",
    );
  });

  // The whole point of the per-attempt key: two workers racing the same clip
  // must never write to, or delete, each other's object.
  test("gives concurrent attempts on one clip distinct keys", () => {
    expect(clipPreviewAttemptStorageKey("p", "c", "a1")).not.toBe(
      clipPreviewAttemptStorageKey("p", "c", "a2"),
    );
  });
});

describe("buildClipPreviewArgs", () => {
  const base = {
    sourcePath: "/tmp/source.mp4",
    outputPath: "/tmp/out.mp4",
    windowStartSec: 96,
    windowDurationSec: 38,
    hasAudio: true,
  };

  test("seeks with -ss before -i (fast input seek, never reorder)", () => {
    const args = buildClipPreviewArgs(base);
    const ssIndex = args.indexOf("-ss");
    const iIndex = args.indexOf("-i");
    expect(ssIndex).toBeGreaterThanOrEqual(0);
    expect(iIndex).toBeGreaterThan(ssIndex);
    expect(args[ssIndex + 1]).toBe("96");
    expect(args[iIndex + 1]).toBe(base.sourcePath);
  });

  test("scales to the configured max height preserving aspect via -2 width", () => {
    const args = buildClipPreviewArgs({ ...base, maxHeight: 540 });
    const vfIndex = args.indexOf("-vf");
    expect(args[vfIndex + 1]).toBe("scale=-2:540");
  });

  test("encodes H.264 with faststart for immediate playback", () => {
    const args = buildClipPreviewArgs(base);
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
  });

  test("includes mono AAC audio at the configured bitrate when the source has audio", () => {
    const args = buildClipPreviewArgs({ ...base, hasAudio: true, audioBitrate: "64k" });
    expect(args).toContain("aac");
    const acIndex = args.indexOf("-ac");
    expect(args[acIndex + 1]).toBe("1");
    const bitrateIndex = args.indexOf("-b:a");
    expect(args[bitrateIndex + 1]).toBe("64k");
  });

  test("drops audio entirely with -an when the source has none", () => {
    const args = buildClipPreviewArgs({ ...base, hasAudio: false });
    expect(args).toContain("-an");
    expect(args).not.toContain("aac");
  });

  test("bounds the output duration explicitly at the end of the args", () => {
    const args = buildClipPreviewArgs(base);
    const outputPathIndex = args.indexOf(base.outputPath);
    const lastTIndex = args.lastIndexOf("-t");
    expect(args[lastTIndex + 1]).toBe("38.000");
    expect(outputPathIndex).toBe(args.length - 1);
  });

  test("honors explicit preset/CRF overrides over the env-driven defaults", () => {
    const args = buildClipPreviewArgs({
      ...base,
      x264Preset: "ultrafast",
      x264Crf: "32",
    });
    const presetIndex = args.indexOf("-preset");
    const crfIndex = args.indexOf("-crf");
    expect(args[presetIndex + 1]).toBe("ultrafast");
    expect(args[crfIndex + 1]).toBe("32");
  });
});

describe("isAttachedPictureStream (podcast cover-art detection)", () => {
  test("is false for a non-video stream regardless of disposition", () => {
    const stream: ProbeStreamLite = {
      codec_type: "audio",
      disposition: { attached_pic: 1 },
    };
    expect(isAttachedPictureStream(stream)).toBe(false);
  });

  test("is true when ffprobe sets disposition.attached_pic (the standard signal)", () => {
    const stream: ProbeStreamLite = {
      codec_type: "video",
      nb_frames: "1",
      disposition: { attached_pic: 1 },
    };
    expect(isAttachedPictureStream(stream)).toBe(true);
  });

  test("falls back to a tiny frame count when disposition is absent", () => {
    // Some muxers/tagging tools embed cover art without ever setting the
    // attached_pic flag -- the tiny-frame-count fallback must still catch it.
    const stream: ProbeStreamLite = { codec_type: "video", nb_frames: "1" };
    expect(isAttachedPictureStream(stream)).toBe(true);
  });

  test("is true for a zero-frame video stream too", () => {
    const stream: ProbeStreamLite = { codec_type: "video", nb_frames: "0" };
    expect(isAttachedPictureStream(stream)).toBe(true);
  });

  test("is false for a real video stream with a large frame count", () => {
    const stream: ProbeStreamLite = { codec_type: "video", nb_frames: "900" };
    expect(isAttachedPictureStream(stream)).toBe(false);
  });

  test("is false when nb_frames is missing/unparseable and disposition is absent", () => {
    // A real video stream can legitimately lack nb_frames metadata (e.g.
    // some streamed/piped sources) -- absence of the signal must never
    // itself imply cover art.
    const withoutFrames: ProbeStreamLite = { codec_type: "video" };
    const withNA: ProbeStreamLite = { codec_type: "video", nb_frames: "N/A" };
    expect(isAttachedPictureStream(withoutFrames)).toBe(false);
    expect(isAttachedPictureStream(withNA)).toBe(false);
  });

  test("is false when disposition.attached_pic is explicitly 0", () => {
    const stream: ProbeStreamLite = {
      codec_type: "video",
      nb_frames: "900",
      disposition: { attached_pic: 0 },
    };
    expect(isAttachedPictureStream(stream)).toBe(false);
  });
});

describe("classifyMediaStreams (video vs audio-only vs cover-art source)", () => {
  test("a true audio-only file (no video stream at all) is audio-only", () => {
    const result = classifyMediaStreams([{ codec_type: "audio" }]);
    expect(result).toEqual({ hasVideo: false, hasAudio: true });
  });

  test("a normal video-with-audio source has both", () => {
    const result = classifyMediaStreams([
      { codec_type: "video", nb_frames: "1800" },
      { codec_type: "audio" },
    ]);
    expect(result).toEqual({ hasVideo: true, hasAudio: true });
  });

  test("a silent video (no audio stream) still counts as video", () => {
    const result = classifyMediaStreams([{ codec_type: "video", nb_frames: "1800" }]);
    expect(result).toEqual({ hasVideo: true, hasAudio: false });
  });

  test("a podcast MP3 with embedded cover art is classified as audio-only, not video", () => {
    // The exact shape ffprobe reports for an MP3's ID3 APIC cover image: its
    // own video stream, disposition.attached_pic = 1, nb_frames = "1".
    const result = classifyMediaStreams([
      { codec_type: "audio" },
      { codec_type: "video", nb_frames: "1", disposition: { attached_pic: 1 } },
    ]);
    expect(result).toEqual({ hasVideo: false, hasAudio: true });
  });

  test("cover art without an explicit disposition flag still falls back to audio-only", () => {
    const result = classifyMediaStreams([
      { codec_type: "audio" },
      { codec_type: "video", nb_frames: "1" },
    ]);
    expect(result).toEqual({ hasVideo: false, hasAudio: true });
  });

  test("a real video stream alongside a separate attached-picture stream still counts as video", () => {
    // e.g. a video file that also carries an embedded thumbnail -- the real
    // video stream must win, not get masked by the cover-art stream.
    const result = classifyMediaStreams([
      { codec_type: "video", nb_frames: "1800" },
      { codec_type: "video", nb_frames: "1", disposition: { attached_pic: 1 } },
      { codec_type: "audio" },
    ]);
    expect(result).toEqual({ hasVideo: true, hasAudio: true });
  });

  test("no streams at all classifies as neither video nor audio", () => {
    expect(classifyMediaStreams([])).toEqual({ hasVideo: false, hasAudio: false });
  });
});

describe("audiogramPreviewDimensions", () => {
  test("960x540 at a 540 max height -- exactly half of 1080p, genuine 16:9 '540p'", () => {
    expect(audiogramPreviewDimensions(540)).toEqual({ width: 960, height: 540 });
  });

  test("scales proportionally for a smaller configured max height", () => {
    expect(audiogramPreviewDimensions(360)).toEqual({ width: 640, height: 360 });
  });

  test("rounds an odd max height down to the nearest even number", () => {
    const dims = audiogramPreviewDimensions(541);
    expect(dims.height).toBe(540);
    expect(dims.height % 2).toBe(0);
    expect(dims.width % 2).toBe(0);
  });

  test("defaults from the module's own previewMaxHeight() when omitted", () => {
    expect(audiogramPreviewDimensions()).toEqual(audiogramPreviewDimensions(540));
  });
});

describe("buildAudiogramPreviewArgs", () => {
  const base = {
    sourcePath: "/tmp/podcast.mp3",
    outputPath: "/tmp/out.mp4",
    windowStartSec: 96,
    windowDurationSec: 38,
  };

  test("seeks with -ss before -i (fast input seek, same convention as the video path)", () => {
    const args = buildAudiogramPreviewArgs(base);
    const ssIndex = args.indexOf("-ss");
    const iIndex = args.indexOf("-i");
    expect(ssIndex).toBeGreaterThanOrEqual(0);
    expect(iIndex).toBeGreaterThan(ssIndex);
    expect(args[ssIndex + 1]).toBe("96");
    expect(args[iIndex + 1]).toBe(base.sourcePath);
  });

  test("builds a solid-color background sized to the computed canvas", () => {
    const args = buildAudiogramPreviewArgs({ ...base, maxHeight: 540 });
    const filterIndex = args.indexOf("-filter_complex");
    const chain = args[filterIndex + 1];
    expect(chain).toContain("color=c=0x0F172A:s=960x540");
  });

  test("draws an animated showwaves waveform off the source's audio (never a frozen frame)", () => {
    const args = buildAudiogramPreviewArgs(base);
    const chain = args[args.indexOf("-filter_complex") + 1];
    expect(chain).toContain("[0:a]showwaves=");
    expect(chain).toContain("mode=cline");
    expect(chain).toContain("rate=25");
  });

  test("colors the waveform from the caption preset's highlight color when provided", () => {
    const args = buildAudiogramPreviewArgs({
      ...base,
      captionPreset: { ...DEFAULT_CAPTION_PRESET, highlightColor: "#FF00FF" },
    });
    const chain = args[args.indexOf("-filter_complex") + 1];
    expect(chain).toContain("colors=0xFF00FF");
  });

  test("falls back to the schema-derived default highlight color when no preset is given", () => {
    const args = buildAudiogramPreviewArgs(base);
    const chain = args[args.indexOf("-filter_complex") + 1];
    expect(chain).toContain(
      `colors=0x${DEFAULT_CAPTION_PRESET.highlightColor.slice(1)}`,
    );
  });

  test("never burns in captions/subtitles/text -- the studio overlays those in HTML", () => {
    const args = buildAudiogramPreviewArgs(base);
    const chain = args[args.indexOf("-filter_complex") + 1];
    expect(chain).not.toContain("subtitles=");
    expect(chain).not.toContain("ass=");
    expect(chain).not.toContain("drawtext=");
  });

  test("maps the synthesized video and the source's first audio stream, nothing else", () => {
    const args = buildAudiogramPreviewArgs(base);
    expect(args).toContain("[outv]");
    const mapIndices = args.reduce<number[]>((acc, value, index) => {
      if (value === "-map") acc.push(index);
      return acc;
    }, []);
    const mappedValues = mapIndices.map((index) => args[index + 1]);
    expect(mappedValues).toEqual(["[outv]", "0:a:0"]);
  });

  test("encodes H.264 with faststart for immediate playback", () => {
    const args = buildAudiogramPreviewArgs(base);
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
  });

  test("encodes mono AAC audio at the configured bitrate", () => {
    const args = buildAudiogramPreviewArgs({ ...base, audioBitrate: "64k" });
    expect(args).toContain("aac");
    const acIndex = args.indexOf("-ac");
    expect(args[acIndex + 1]).toBe("1");
    const bitrateIndex = args.indexOf("-b:a");
    expect(args[bitrateIndex + 1]).toBe("64k");
  });

  test("bounds the output duration explicitly, belt-and-suspenders alongside -shortest", () => {
    const args = buildAudiogramPreviewArgs(base);
    expect(args).toContain("-shortest");
    const outputPathIndex = args.indexOf(base.outputPath);
    const lastTIndex = args.lastIndexOf("-t");
    expect(args[lastTIndex + 1]).toBe("38.000");
    expect(outputPathIndex).toBe(args.length - 1);
  });

  test("honors explicit preset/CRF overrides over the env-driven defaults", () => {
    const args = buildAudiogramPreviewArgs({
      ...base,
      x264Preset: "ultrafast",
      x264Crf: "32",
    });
    const presetIndex = args.indexOf("-preset");
    const crfIndex = args.indexOf("-crf");
    expect(args[presetIndex + 1]).toBe("ultrafast");
    expect(args[crfIndex + 1]).toBe("32");
  });

  test("honors an explicit maxHeight override for the synthesized canvas", () => {
    const args = buildAudiogramPreviewArgs({ ...base, maxHeight: 360 });
    const chain = args[args.indexOf("-filter_complex") + 1];
    expect(chain).toContain("s=640x360");
  });
});

describe("buildPeaksExtractionArgs", () => {
  test("decodes to headerless mono PCM at the requested sample rate, no -y and no HTTP reconnect flags", () => {
    const args = buildPeaksExtractionArgs({
      inputPath: "/tmp/clip-preview-xyz/clip1-preview.mp4",
      sampleRateHz: 8000,
    });
    expect(args).toEqual([
      "-i",
      "/tmp/clip-preview-xyz/clip1-preview.mp4",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "s16le",
      "-",
    ]);
    expect(args).not.toContain("-y");
    expect(args).not.toContain("-reconnect");
  });
});

describe("computeAmplitudePeaks (pure PCM binning)", () => {
  test("returns one peak per second at 1 bin/sec, using max-abs amplitude", () => {
    // 1 second of audio at 4Hz (silly-low rate, just for arithmetic clarity):
    // samples [0, 100, -200, 50] -> max abs = 200 -> 200/32768.
    const samples = Int16Array.from([0, 100, -200, 50]);
    const peaks = computeAmplitudePeaks(samples, 4, 1);
    expect(peaks).toHaveLength(1);
    expect(peaks[0]).toBeCloseTo(200 / 32768, 6);
  });

  test("bins two seconds of audio into two peaks", () => {
    const samples = Int16Array.from([10, 20, 30, 40, 1000, -2000, 500, 100]);
    const peaks = computeAmplitudePeaks(samples, 4, 1);
    expect(peaks).toHaveLength(2);
    expect(peaks[0]).toBeCloseTo(40 / 32768, 6);
    expect(peaks[1]).toBeCloseTo(2000 / 32768, 6);
  });

  test("emits a shorter final bin instead of dropping leftover samples", () => {
    // 5 samples at 4Hz/1 bin-per-sec -> bin 0 has 4 samples, bin 1 has 1.
    const samples = Int16Array.from([1, 2, 3, 4, 5000]);
    const peaks = computeAmplitudePeaks(samples, 4, 1);
    expect(peaks).toHaveLength(2);
    expect(peaks[1]).toBeCloseTo(5000 / 32768, 6);
  });

  test("normalizes the max-magnitude negative sample to exactly 1.0", () => {
    const samples = Int16Array.from([-32768, 0, 100]);
    const peaks = computeAmplitudePeaks(samples, 3, 1);
    expect(peaks[0]).toBe(1);
  });

  test("returns an empty array for empty input", () => {
    expect(computeAmplitudePeaks(new Int16Array(0), 8000, 20)).toEqual([]);
  });

  test("returns an empty array for a non-positive sample rate or peaksPerSec", () => {
    const samples = Int16Array.from([100, 200]);
    expect(computeAmplitudePeaks(samples, 0, 20)).toEqual([]);
    expect(computeAmplitudePeaks(samples, 8000, 0)).toEqual([]);
  });

  test("produces roughly peaksPerSec * durationSec bins for a realistic window", () => {
    const sampleRateHz = 8000;
    const peaksPerSec = 20;
    const durationSec = 5;
    const samples = new Int16Array(sampleRateHz * durationSec);
    const peaks = computeAmplitudePeaks(samples, sampleRateHz, peaksPerSec);
    expect(peaks).toHaveLength(peaksPerSec * durationSec);
  });
});

describe("quantizePeaks", () => {
  test("rounds 0..1 floats to integers in [0, 100]", () => {
    expect(quantizePeaks([0, 0.5, 1, 0.004, 0.996])).toEqual([0, 50, 100, 0, 100]);
  });

  test("clamps defensively outside [0, 1]", () => {
    expect(quantizePeaks([-0.5, 1.5])).toEqual([0, 100]);
  });

  test("returns an empty array for empty input", () => {
    expect(quantizePeaks([])).toEqual([]);
  });
});
