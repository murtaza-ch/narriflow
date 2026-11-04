import { describe, expect, test } from "bun:test";
import type { SourceAudioBinding, SourceVideoBinding } from "@narriflow/validators/execution";
import { sourceAudioMatchesVideo } from "./source-readiness";

const audio: SourceAudioBinding = {
  sourceAudioId: "ce4d7e7e-caae-4d85-80f8-17f55e2eaf79", projectId: "05bfd4bb-8ce2-455c-a598-1328f676a288", sourceRevision: 1,
  mediaIdentity: { provider: "youtube", mediaId: "dQw4w9WgXcQ" },
  audioTrack: { id: "251", language: "en", codec: "opus", sampleRate: 48000, channels: 2 },
  object: { key: "execution/audio.webm", etag: '"etag"', byteLength: 20000000, sha256: "e".repeat(64) },
  durationSeconds: 60.01, wholeSource: true, audioStartTimeSec: 0,
  probeVersion: "normalized-probe-1", toolchainFingerprint: "f".repeat(64),
};
const stream = { index: 0, codec: "opus", profile: null, timeBase: null, startPts: null, startTimeSec: 0,
  durationTs: null, durationSec: 60.02, endTimeSec: 60.02, frameCount: null, bitRate: null };
const measuredAudio = { ...stream, index: 1, sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "fltp", initialPadding: null, trailingPadding: null };
const measuredVideo = { ...stream, codec: "vp9", width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1080,
  displayWidth: 1920, displayHeight: 1080, sampleAspectRatio: null, displayMatrix: null, rotationDeg: 0, reflected: false,
  avgFrameRate: { numerator: 30, denominator: 1 }, rFrameRate: { numerator: 30, denominator: 1 }, pixelFormat: "yuv420p",
  colorRange: null, colorSpace: null, colorTransfer: null, colorPrimaries: null, chromaLocation: null, fieldOrder: null,
  masteringDisplay: null, contentLight: null, dolbyVision: null };
const video: SourceVideoBinding = {
  projectId: audio.projectId, sourceRevision: 1, mediaIdentity: audio.mediaIdentity, audioTrack: audio.audioTrack,
  wholeSource: true, audioStartTimeSec: 0, videoStartTimeSec: 0,
  probeVersion: audio.probeVersion, toolchainFingerprint: audio.toolchainFingerprint,
  probe: { durationSec: 60.02, audio: { sampleRate: 48000, channels: 2 },
    video: { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, startTimecode: null },
    facts: { format: { name: "matroska", startTimeSec: 0, durationSec: 60.02, sizeBytes: null, bitRate: null }, attachedPictureCount: 0, videos: [measuredVideo], audios: [measuredAudio] },
  },
};

describe("Whole-source audio and video agreement", () => {
  test("accepts the same source within probe tolerance", () => {
    expect(sourceAudioMatchesVideo(audio, video, 3600)).toBe(true);
    expect(sourceAudioMatchesVideo(audio, { ...video, probe: { ...video.probe, durationSec: 61.02 } }, 3600)).toBe(false);
  });
  test("audio extracted just past a minute boundary still matches its video", () => {
    // The real extraction of a 60.000s MP4 measures 60.011s, and of 3600.000s, 3600.022s.
    const atMinute = { ...video, probe: { ...video.probe, durationSec: 60 } };
    expect(sourceAudioMatchesVideo({ ...audio, durationSeconds: 60.011 }, atMinute, 3600)).toBe(true);
    const atLimit = { ...video, probe: { ...video.probe, durationSec: 3600 } };
    expect(sourceAudioMatchesVideo({ ...audio, durationSeconds: 3600.022 }, atLimit, 3600)).toBe(true);
  });
  test("a source past the plan limit by more than extraction drift is refused", () => {
    const over = { ...video, probe: { ...video.probe, durationSec: 3601 } };
    expect(sourceAudioMatchesVideo({ ...audio, durationSeconds: 3600.5 }, over, 3600)).toBe(false);
    expect(sourceAudioMatchesVideo({ ...audio, durationSeconds: 3601 }, { ...video, probe: { ...video.probe, durationSec: 3600.5 } }, 3600)).toBe(false);
  });
  test("preserves a measured nonzero A/V offset while rejecting fabricated timing", () => {
    const shifted = { ...video, audioStartTimeSec: 1.5, probe: { ...video.probe, facts: { ...video.probe.facts,
      audios: [{ ...measuredAudio, startTimeSec: 1.5 }] } } };
    expect(sourceAudioMatchesVideo({ ...audio, audioStartTimeSec: 1.5 }, shifted, 3600)).toBe(true);
    expect(sourceAudioMatchesVideo(audio, { ...video, audioStartTimeSec: 0.5 }, 3600)).toBe(false);
  });
  test("rejects different source, revision, track, timing and toolchain evidence", () => {
    for (const changed of [
      { ...video, mediaIdentity: { ...video.mediaIdentity, mediaId: "abcdefghijk" } },
      { ...video, sourceRevision: 2 },
      { ...video, audioTrack: { ...audio.audioTrack, id: "140" } },
      { ...video, audioStartTimeSec: 1.01 },
      { ...video, videoStartTimeSec: 1.01 },
      { ...video, audioTrack: null },
      { ...video, toolchainFingerprint: "d".repeat(64) },
    ]) expect(sourceAudioMatchesVideo(audio, changed, 3600)).toBe(false);
  });
});
