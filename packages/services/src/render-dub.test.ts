import { describe, expect, test } from "bun:test";
import { dubbingArtifactBindingHash } from "./dubbing-policy";
import { renderDubSegments, renderDubTimingArtifact, verifyRenderDub, type RenderDubSource } from "./render-dub";

const id = () => crypto.randomUUID();
const requestHash = "a".repeat(64);
const expected = { projectId: id(), clipId: id(), editorRevision: 7 };

async function source(overrides: { dub?: Partial<RenderDubSource["dub"]>; audio?: Partial<RenderDubSource["audio"]>; timing?: Partial<RenderDubSource["timing"]> } = {}): Promise<RenderDubSource> {
  const audioId = id(), timingId = id();
  return {
    dub: { id: id(), projectId: expected.projectId, clipId: expected.clipId, status: "completed", targetLanguageCode: "ur", requestHash, editorRevision: 7,
      audioStorageKey: "execution/1/attempt/owner/audio", audioArtifactId: audioId, timingArtifactId: timingId, ...overrides.dub },
    audio: { id: audioId, role: "dub_mix", bindingHash: await dubbingArtifactBindingHash(requestHash, "audio"), storageKey: "execution/1/attempt/owner/audio",
      contentType: "audio/mpeg", byteLength: 90_000n, checksumSha256: "b".repeat(64), etag: '"audio"', committedAt: new Date(), ...overrides.audio },
    timing: { id: timingId, role: "probe", bindingHash: await dubbingArtifactBindingHash(requestHash, "timing"), storageKey: "execution/1/attempt/owner/timing",
      contentType: "application/json", byteLength: 2_000n, checksumSha256: "c".repeat(64), etag: '"timing"', committedAt: new Date(), ...overrides.timing },
  };
}

describe("a dub's sealed artifacts feed its render", () => {
  test("a completed dub of this clip's revision names its audio and timing objects", async () => {
    const found = await source();
    expect(await verifyRenderDub(found, expected)).toEqual({
      audio: { storageKey: "execution/1/attempt/owner/audio", etag: '"audio"', byteLength: 90_000, sha256: "b".repeat(64) },
      timing: { storageKey: "execution/1/attempt/owner/timing", etag: '"timing"', byteLength: 2_000, sha256: "c".repeat(64) },
    });
  });

  test.each([
    ["a dub that did not complete", { dub: { status: "failed" as const } }],
    ["another revision of the clip", { dub: { editorRevision: 8 } }],
    ["another clip", { dub: { clipId: id() } }],
    ["another project", { dub: { projectId: id() } }],
    ["audio stored under another key", { dub: { audioStorageKey: "execution/1/attempt/owner/other" } }],
    ["an uncommitted audio artifact", { audio: { committedAt: null } }],
    ["audio of another request", { audio: { bindingHash: "d".repeat(64) } }],
    ["audio that is not MP3", { audio: { contentType: "video/mp4" } }],
    ["an audio artifact that is not the dub's", { audio: { id: id() } }],
    ["a timing artifact without an etag", { timing: { etag: null } }],
  ])("%s is refused", async (_name, overrides) => {
    await expect(verifyRenderDub(await source(overrides), expected)).rejects.toThrow("render_input_invalid");
  });

  test("the timing artifact is read by its exact identity", async () => {
    const found = await source();
    expect(renderDubTimingArtifact(found.timing)).toEqual({ artifactId: found.timing.id, role: "probe", storageKey: found.timing.storageKey, contentType: "application/json",
      byteLength: 2_000n, sha256: "c".repeat(64), etag: '"timing"', bindingHash: found.timing.bindingHash });
  });

  test("timing words become the caption words of each sentence", async () => {
    const found = await source();
    const evidence = { version: 1, kind: "dubbing_checkpoint", dubId: found.dub.id, requestHash, stage: "timing", segments: [
      { startSec: 0.1, endSec: 1, tempo: 1, words: [{ text: "ہیلو", spaceBefore: false, startSec: 0.1, endSec: 0.5 }, { text: "دنیا۔", spaceBefore: true, startSec: 0.5, endSec: 1 }] },
      { startSec: 2, endSec: 3, tempo: 1.1, words: [{ text: "خدا", spaceBefore: false, startSec: 2, endSec: 3 }] },
    ] };
    expect(renderDubSegments(evidence, found.dub)).toEqual([
      [{ text: "ہیلو", spaceBefore: false, startSec: 0.1, endSec: 0.5 }, { text: "دنیا۔", spaceBefore: true, startSec: 0.5, endSec: 1 }],
      [{ text: "خدا", spaceBefore: false, startSec: 2, endSec: 3 }],
    ]);
  });

  test("evidence of another dub, request or stage is refused", async () => {
    const found = await source();
    const evidence = { version: 1, kind: "dubbing_checkpoint", dubId: found.dub.id, requestHash, stage: "timing", segments: [
      { startSec: 0, endSec: 1, tempo: 1, words: [{ text: "a", spaceBefore: false, startSec: 0, endSec: 1 }] }] };
    expect(() => renderDubSegments({ ...evidence, dubId: id() }, found.dub)).toThrow("render_input_invalid");
    expect(() => renderDubSegments({ ...evidence, requestHash: "e".repeat(64) }, found.dub)).toThrow("render_input_invalid");
    expect(() => renderDubSegments({ version: 1, kind: "dubbing_checkpoint", dubId: found.dub.id, requestHash, stage: "speech_intent", bodySha256: "f".repeat(64) }, found.dub)).toThrow("render_input_invalid");
    expect(() => renderDubSegments({ nonsense: true }, found.dub)).toThrow();
  });
});
