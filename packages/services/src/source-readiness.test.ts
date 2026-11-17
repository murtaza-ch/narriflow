import { describe, expect, test } from "bun:test";
import type { SourceAudioBinding, SourceVideoBinding } from "@narriflow/validators/execution";
import { createSourceVideoValidator, sourceAudioMatchesVideo } from "./source-readiness";

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

describe("Video-only sources and the plan's length limit", () => {
  // A silent source: no audio track, so the video is the only measured duration.
  const silent = (durationSec: number): SourceVideoBinding => ({ ...video, audioTrack: null, audioStartTimeSec: null,
    probe: { ...video.probe, durationSec, audio: null, facts: { ...video.probe.facts, audios: [], format: { ...video.probe.facts.format, durationSec } } } });
  const run = async (durationSec: number, pricingTier = "free") => {
    const released: Array<{ projectId: string; reason: string }> = [];
    const tx = {
      project: { findUniqueOrThrow: async () => ({ sourceRevision: 1, workspace: { pricingTier } }) },
      executionArtifact: { findUniqueOrThrow: async () => ({ attemptToken: "attempt", owner: "owner" }), findFirst: async () => null },
    } as unknown as Parameters<ReturnType<typeof createSourceVideoValidator>>[0];
    const validate = createSourceVideoValidator({ release: async (_tx, input) => { released.push(input); return null as never; } });
    const decision = await validate(tx, { ref: { projectId: video.projectId, sourceRevision: 1, attemptToken: "attempt" },
      artifact: { artifactId: "artifact", binding: silent(durationSec) }, sourceAudio: null });
    return { decision, released };
  };
  test("a silent video over the plan limit is refused at acceptance and its reservation released", async () => {
    // Free allows 60 minutes; this one is 90.
    const { decision, released } = await run(90 * 60);
    expect(decision).toEqual({ kind: "rejected", failureCode: "ingest_max_duration_exceeded" });
    expect(released).toEqual([{ projectId: video.projectId, reason: "ingest_max_duration_exceeded" }]);
  });
  test("a silent video within the limit, or on a plan that allows it, is accepted as before", async () => {
    expect(await run(59 * 60)).toEqual({ decision: { kind: "accepted" }, released: [] });
    expect(await run(90 * 60, "pro")).toEqual({ decision: { kind: "accepted" }, released: [] });
  });
});
