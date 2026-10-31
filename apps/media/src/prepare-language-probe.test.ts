import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerProcessModule } from "./worker-process";
import { selectProbeWindows } from "./language-probe";
import { prepareLanguageProbeFile } from "./prepare-language-probe";

const sourceAudio = { sourceAudioId: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002", sourceRevision: 1,
  mediaIdentity: { provider: "youtube" as const, mediaId: "_123456789-" }, audioTrack: { id: "140", language: null, codec: "pcm_s16le", sampleRate: 16000, channels: 1 },
  object: { key: "execution/sealed/audio.wav", etag: '"source-etag"', byteLength: 2240044, sha256: "a".repeat(64) }, durationSeconds: 70,
  wholeSource: true as const, audioStartTimeSec: 0, probeVersion: "probe-v1", toolchainFingerprint: "b".repeat(64) };

test("sealed SourceAudio produces a bounded 60-second mono probe with If-Match on every source request", async () => {
  const pcm = Buffer.alloc(70 * 16000 * 2 + 44);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(16000, 24); pcm.writeUInt32LE(32000, 28);
  pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(pcm.length - 44, 40);
  const conditions: Array<string | null> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    conditions.push(request.headers.get("if-match"));
    if (request.headers.get("if-match") !== sourceAudio.object.etag) return new Response(null, { status: 412 });
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
    const start = Number(range?.[1] ?? 0), end = Math.min(Number(range?.[2] || pcm.length - 1), pcm.length - 1);
    return new Response(pcm.subarray(start, end + 1), { status: range ? 206 : 200, headers: {
      "content-type": "audio/wav", "content-length": String(end - start + 1), "accept-ranges": "bytes", etag: sourceAudio.object.etag,
      ...(range ? { "content-range": `bytes ${start}-${end}/${pcm.length}` } : {}),
    } });
  } });
  const directory = await mkdtemp(join(tmpdir(), "native-language-probe-"));
  const processOwner = createWorkerProcessModule();
  try {
    const result = await prepareLanguageProbeFile({ sourceAudio, source: { url: "https://source.invalid/audio.wav", expiresAt: new Date(Date.now() + 120_000).toISOString() },
      windows: selectProbeWindows(70)!.map(({ startSec, durationSec }) => ({ durationSec, startSec })), outputPath: join(directory, "probe.wav"), artifactId: "00000000-0000-4000-8000-000000000003", bindingHash: "c".repeat(64) }, {
      signal: AbortSignal.timeout(10_000), workerProcess: { ...processOwner,
        execute: request => processOwner.execute({ ...request, args: request.args.map(value => value === "https://source.invalid/audio.wav" ? `http://127.0.0.1:${server.port}/audio.wav` : value) }),
        inspectMedia: request => processOwner.inspectMedia(request),
      } as never,
    });
    const wav = await readFile(result.path);
    expect(result.contentType).toBe("audio/wav");
    expect(result.byteLength).toBeLessThanOrEqual(2_000_000);
    expect(result.sourceAudioId).toBe(sourceAudio.sourceAudioId);
    expect(conditions.length).toBeGreaterThanOrEqual(3);
    expect(conditions.every(value => value === sourceAudio.object.etag)).toBe(true);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    let dataBytes = 0;
    for (let offset = 12; offset + 8 <= wav.length;) { const size = wav.readUInt32LE(offset + 4); if (wav.toString("ascii", offset, offset + 4) === "data") dataBytes = size; offset += 8 + size + (size % 2); }
    expect(dataBytes).toBe(1_920_000);
  } finally { await server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 15_000);

test("unplanned windows and a non-HTTPS source are refused before any native process starts", async () => {
  const base = { sourceAudio, source: { url: "https://source.invalid/audio.wav", expiresAt: new Date(Date.now() + 120_000).toISOString() },
    windows: selectProbeWindows(70)!, outputPath: "/tmp/unreached-language-probe.wav", artifactId: "00000000-0000-4000-8000-000000000003", bindingHash: "c".repeat(64) };
  let starts = 0;
  const ports = { signal: new AbortController().signal, workerProcess: { async execute() { starts++; throw new Error("unreachable"); }, async inspectMedia() { throw new Error("unreachable"); } } };
  await expect(prepareLanguageProbeFile({ ...base, windows: [{ startSec: 0, durationSec: 60 }] }, ports)).rejects.toMatchObject({ code: "language_probe_input_invalid" });
  await expect(prepareLanguageProbeFile({ ...base, source: { ...base.source, url: "file:///private/source.wav" } }, ports)).rejects.toMatchObject({ code: "language_probe_input_invalid" });
  expect(starts).toBe(0);
});
