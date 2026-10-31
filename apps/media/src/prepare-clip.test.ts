import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { clipPreparationEngineHash } from "@narriflow/services/clip-preparation-policy";
import { clipPreparationBinding } from "@narriflow/services/clip-preparation-input";
import { clipPreparationInputSchema, clipPreparationResultSchema } from "@narriflow/validators/clip-preparation";
import { isClipPreviewPeaks } from "@narriflow/validators/clip-preview-peaks";
import documents from "./__fixtures__/render-golden/documents.json";
import { prepareClip } from "./prepare-clip";
import { parseRenderConfig } from "./render-config";
import { productionWorkerProcessModule as worker } from "./worker-process";

test("native preparation produces a validated preview, peaks and all source observations through the existing media engine", async () => {
  await worker.withScratchDirectory("preparation-native-", async work => {
    const signal = new AbortController().signal, sourcePath = join(work, "original.mp4");
    await worker.execute({ command: "ffmpeg", args: ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=4", "-f", "lavfi", "-i", "sine=f=330:sample_rate=48000:d=4", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-shortest", sourcePath], signal, deadlineMs: 20000 });
    const probe = await worker.inspectMedia({ sourcePath, signal, deadlineMs: 20000 });
    const raw = { version: 1 as const, kind: "prepare_clip" as const, preparationId: "02fd9a96-e78d-455f-a676-3b3909a1589a", projectId: "36b818df-487f-4429-ab59-53be156ab532", clipId: "0e282bd8-a3b4-4422-bafb-ae4f68d59ac6", sourceRevision: 1, editorRevision: 3,
      toolchainFingerprint: "a".repeat(64), engineHash: await clipPreparationEngineHash("a".repeat(64)), source: { storageKey: "execution/1/original", etag: '"source"', byteLength: (await stat(sourcePath)).size, sha256: createHash("sha256").update(await readFile(sourcePath)).digest("hex") },
      sourceProbe: probe.sourceProbe, document: documents.cases["solo-auto-vertical"].document, wholeSource: true, llmModel: "fixture" };
    const decoded = clipPreparationInputSchema.omit({ bindingHash: true }).parse(raw);
    const input = clipPreparationInputSchema.parse({ ...decoded, bindingHash: await clipPreparationBinding(decoded) });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") ?? "");
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : raw.source.byteLength-1;
      return new Response(Bun.file(sourcePath).slice(start,end+1), { status: range ? 206 : 200,
        headers: { "Content-Length": String(end-start+1), "Accept-Ranges": "bytes", ETag: '"source"', ...(range ? { "Content-Range": `bytes ${start}-${end}/${raw.source.byteLength}` } : {}) } });
    } });
    try {
    const overrides = { WORKER_CLIP_PREVIEW_MAX_HEIGHT: "64", WORKER_CLIP_PREVIEW_PEAKS_PER_SEC: "1" };
    const previous = Object.fromEntries(Object.keys(overrides).map(name => [name, process.env[name]]));
    Object.assign(process.env, overrides);
    try {
    const calls = { multi: 0, face: 0, pip: 0, cuts: 0 };
    const output = await prepareClip({ input, sourcePath: `http://127.0.0.1:${server.port}/original`, work, previewArtifactId: "1926d146-807b-4e55-8ef6-0ac87f95bea2", peaksArtifactId: "2cb10336-094a-424e-81ce-e967550d8b99", workerProcess: worker, config: parseRenderConfig({}), signal,
      detectors: { detectMultiFacePath: async () => { calls.multi++; return { samples: [] }; }, detectFacePath: async () => { calls.face++; return { samples: [] }; }, detectPipPath: async () => { calls.pip++; return { movingPxFrac: 0, insufficientSamples: false, candidates: [] }; }, detectSceneCuts: async () => { calls.cuts++; return []; } } });
    expect((await stat(output.previewPath)).size).toBeGreaterThan(1000);
    expect(output.peaksPath).not.toBeNull();
    expect(isClipPreviewPeaks(JSON.parse(await readFile(output.peaksPath!, "utf8")))).toBe(true);
    const result = clipPreparationResultSchema.parse(JSON.parse(await readFile(output.layoutPath, "utf8")));
    expect(result).toMatchObject({ preparationId: input.preparationId, bindingHash: input.bindingHash, peaks: { state: "ready" } });
    expect(result.layout.automatic).toMatchObject({ engine: "shot-layout-v1", analysisPath: "proxy" });
    expect(result.layout.screen).not.toBeNull(); expect(result.layout.split).not.toBeNull();
    expect((await worker.inspectMedia({ sourcePath: output.previewPath, signal, deadlineMs: 10000 })).height).toBe(540);
    expect(JSON.parse(await readFile(output.peaksPath!, "utf8")).peaksPerSec).toBe(20);
    const foreign = { ...input, engineHash: "f".repeat(64) };
    foreign.bindingHash = await clipPreparationBinding(foreign);
    await expect(prepareClip({ input: foreign, sourcePath: "/missing-source", work, previewArtifactId: result.preview.artifactId,
      peaksArtifactId: "2cb10336-094a-424e-81ce-e967550d8b99", workerProcess: worker, config: parseRenderConfig({}), signal })).rejects.toThrow("clip_preparation_engine_invalid");
    expect(calls).toEqual({ multi: 1, face: 1, pip: 1, cuts: 1 });
    } finally { for (const [name,value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
    } finally { server.stop(true); }
  });
}, 30000);

test("native preparation normalizes a valid VFR preview without moving its source window or audio clock", async () => {
  await worker.withScratchDirectory("preparation-vfr-", async work => {
    const signal = new AbortController().signal, piece = join(work, "piece.mp4"), sourcePath = join(work, "original.mp4");
    await worker.execute({ command: "ffmpeg", args: ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=4", "-f", "lavfi", "-i", "sine=f=330:sample_rate=48000:d=4", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-shortest", piece], signal, deadlineMs: 20000 });
    await worker.execute({ command: "ffmpeg", args: ["-nostdin", "-v", "error", "-y", "-stream_loop", "8", "-i", piece, "-t", "30", "-c", "copy", "-movflags", "+faststart", sourcePath], signal, deadlineMs: 20000 });
    const probe = await worker.inspectMedia({ sourcePath, signal, deadlineMs: 20000 });
    expect(probe.facts?.videos[0]?.avgFrameRate).not.toEqual({ numerator: 30, denominator: 1 });
    const document = structuredClone(documents.cases["solo-auto-vertical"].document);
    document.clipStartSec = 10; document.clipEndSec = 20;
    for (const utterance of document.transcriptSlice) {
      utterance.startSec += 10; utterance.endSec += 10;
      for (const word of utterance.words ?? []) { word.startSec += 10; word.endSec += 10; }
    }
    const raw = clipPreparationInputSchema.omit({ bindingHash: true }).parse({ version: 1, kind: "prepare_clip",
      preparationId: "02fd9a96-e78d-455f-a676-3b3909a1589a", projectId: "36b818df-487f-4429-ab59-53be156ab532", clipId: "0e282bd8-a3b4-4422-bafb-ae4f68d59ac6",
      sourceRevision: 1, editorRevision: 0, toolchainFingerprint: "a".repeat(64), engineHash: await clipPreparationEngineHash("a".repeat(64)),
      source: { storageKey: "execution/1/original", etag: '"source"', byteLength: (await stat(sourcePath)).size,
        sha256: createHash("sha256").update(await readFile(sourcePath)).digest("hex") }, sourceProbe: probe.sourceProbe,
      document, wholeSource: false, llmModel: "caption-only" });
    const input = clipPreparationInputSchema.parse({ ...raw, bindingHash: await clipPreparationBinding(raw) });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") ?? "");
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : raw.source.byteLength-1;
      return new Response(Bun.file(sourcePath).slice(start,end+1), { status: range ? 206 : 200,
        headers: { "Content-Length": String(end-start+1), "Accept-Ranges": "bytes", ETag: '"source"', ...(range ? { "Content-Range": `bytes ${start}-${end}/${raw.source.byteLength}` } : {}) } });
    } });
    try {
      const output = await prepareClip({ input, sourcePath: `http://127.0.0.1:${server.port}/original`, work,
        previewArtifactId: "1926d146-807b-4e55-8ef6-0ac87f95bea2", peaksArtifactId: "2cb10336-094a-424e-81ce-e967550d8b99",
        workerProcess: worker, config: parseRenderConfig({}), signal,
        detectors: { detectMultiFacePath: async () => ({ samples: [] }), detectFacePath: async () => ({ samples: [] }),
          detectPipPath: async () => ({ movingPxFrac: 0, insufficientSamples: false, candidates: [] }), detectSceneCuts: async () => [] } });
      const preview = await worker.inspectMedia({ sourcePath: output.previewPath, signal, analyzeVideoClock: false, deadlineMs: 10000 });
      expect(output.result.preview).toMatchObject({ startSec: 6, durationSec: 18 });
      expect(preview.facts?.videos[0]).toMatchObject({ frameCount: 540, startTimeSec: 0, durationSec: 18,
        avgFrameRate: { numerator: 30, denominator: 1 }, rFrameRate: { numerator: 30, denominator: 1 } });
      expect(preview.facts?.audios[0]).toMatchObject({ startTimeSec: 0, durationSec: 18, sampleRate: 48000, channels: 1 });
      expect(JSON.parse(await readFile(output.peaksPath!, "utf8"))).toMatchObject({ startSec: 6, durationSec: 18, peaksPerSec: 20 });
      // Policy v2 did not normalize previews. Its sealed evidence must not alias.
      expect(input.engineHash).not.toBe("05ad624c5ba46244452cae48a7aaf95b7ca53883c74a5ef4a9fa9779017c3bda");
    } finally { server.stop(true); }
  });
}, 30000);
