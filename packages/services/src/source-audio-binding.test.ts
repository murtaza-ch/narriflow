import { expect, test } from "bun:test";
import { sourceAudioBindingHash } from "./source-audio-binding";

const evidence = {
  sourceAudioId: "ce4d7e7e-caae-4d85-80f8-17f55e2eaf79", projectId: "05bfd4bb-8ce2-455c-a598-1328f676a288", sourceRevision: 1,
  mediaIdentity: { provider: "youtube" as const, mediaId: "dQw4w9WgXcQ" },
  audioTrack: { id: "251", language: "en", codec: "opus", sampleRate: 48000, channels: 2 },
  object: { key: "execution/audio.webm", etag: '"etag"', byteLength: 20000000, sha256: "e".repeat(64) },
  durationSeconds: 3600.125, wholeSource: true as const, audioStartTimeSec: 0,
  probeVersion: "normalized-probe-1", toolchainFingerprint: "f".repeat(64),
};

test("whole-source audio binding hashes normalized measured evidence rather than input object order", async () => {
  const first = await sourceAudioBindingHash(evidence);
  // Independently computed from the declared-order binding with CPython SHA-256.
  expect(first).toBe("0cdc6595a7bf93cf100ed21eb785047d1625d4bcda18eef964801da7900b1ba6");
  const reordered = Object.fromEntries(Object.entries(evidence).reverse());
  expect(await sourceAudioBindingHash(reordered)).toBe(first);
  expect(await sourceAudioBindingHash({ ...evidence, durationSeconds: 3600.25 })).not.toBe(first);
  expect(await sourceAudioBindingHash({ ...evidence, object: { ...evidence.object, sha256: "d".repeat(64) } })).not.toBe(first);
  await expect(sourceAudioBindingHash({ ...evidence, wholeSource: false })).rejects.toThrow();
});
