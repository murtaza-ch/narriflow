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
const video: SourceVideoBinding = {
  projectId: audio.projectId, sourceRevision: 1, mediaIdentity: audio.mediaIdentity, audioTrack: audio.audioTrack,
  wholeSource: true, audioStartTimeSec: 0, videoStartTimeSec: 0,
  probeVersion: audio.probeVersion, toolchainFingerprint: audio.toolchainFingerprint,
  probe: { durationSec: 60.02, audio: { sampleRate: 48000, channels: 2 },
    video: { width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, startTimecode: null },
    facts: { format: { name: "matroska", startTimeSec: 0, durationSec: 60.02, sizeBytes: null, bitRate: null }, attachedPictureCount: 0, videos: [], audios: [] },
  },
};

describe("Whole-source audio and video agreement", () => {
  test("accepts the same source within probe tolerance and one credit boundary", () => {
    expect(sourceAudioMatchesVideo(audio, video, 3600)).toBe(true);
    expect(sourceAudioMatchesVideo(audio, { ...video, probe: { ...video.probe, durationSec: 61.02 } }, 3600)).toBe(false);
  });
  test("a sub-second difference cannot hide a different whole-credit debit or source cap", () => {
    expect(sourceAudioMatchesVideo(audio, { ...video, probe: { ...video.probe, durationSec: 60 } }, 3600)).toBe(false);
    expect(sourceAudioMatchesVideo({ ...audio, durationSeconds: 3599.99 }, { ...video, probe: { ...video.probe, durationSec: 3600.01 } }, 3600)).toBe(false);
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
