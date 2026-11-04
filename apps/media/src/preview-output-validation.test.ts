import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planClipComposition } from "@narriflow/composition-plan";
import { CLIP_PREPARATION_POLICY as policy } from "@narriflow/services/clip-preparation-policy";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { bindCompositionPlanAudioInputs, compileClipCompositionCommand, compileCompositionPlanAudioSchedule } from "./composition-ffmpeg-adapter";
import { compositionOutputExpectation, RenderOutputInvalid, validateRenderOutput, type RenderOutputExpectation } from "./render-output-validation";
import { buildClipPreviewArgs, clipPreviewOutputExpectation, encodeAndValidateClipPreview } from "./tasks/clip-preview";
import { productionWorkerProcessModule as worker, WorkerProcessFailure, type WorkerMediaInspection } from "./worker-process";

const signal = new AbortController().signal;
const maxHeight = 90;
let directory: string;
let server: ReturnType<typeof Bun.serve>;

const video = (seconds: number, rate = 30) => ["-f", "lavfi", "-i", `testsrc2=s=320x180:r=${rate}:d=${seconds}`];
const audio = (seconds: number) => ["-f", "lavfi", "-i", `sine=f=330:sample_rate=48000:d=${seconds}`];
const encode = ["-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac"];

async function source(name: string, args: string[]) {
  const path = join(directory, name);
  await worker.execute({ command: "ffmpeg", args: ["-nostdin", "-v", "error", "-y", ...args, ...encode, path], signal, deadlineMs: 30_000 });
  return { path, probe: await worker.inspectMedia({ sourcePath: path, signal, deadlineMs: 30_000 }) };
}

/** The exact preparation command, read over HTTP as the executor reads it. */
function previewCommand(name: string, probe: WorkerMediaInspection, window: { startSec: number; durationSec: number }) {
  const expected = clipPreviewOutputExpectation(probe, window, maxHeight);
  const outputPath = join(directory, `${name}.preview.mp4`);
  const args = buildClipPreviewArgs({ ...policy.preview, sourcePath: `http://127.0.0.1:${server.port}/${name}`, outputPath, windowStartSec: window.startSec,
    windowDurationSec: window.durationSec, hasAudio: probe.hasAudio, frameRate: expected.frameRate, maxHeight });
  return { args, expected, outputPath };
}

async function encodePreview(name: string, probe: WorkerMediaInspection, window: { startSec: number; durationSec: number }) {
  const command = previewCommand(name, probe, window);
  const result = await encodeAndValidateClipPreview({ ...command, workerProcess: worker, signal, deadlineMs: 30_000 });
  return { ...command, result };
}

/** A real render of the same source through the frozen composition command. */
async function render(name: string, path: string, probe: WorkerMediaInspection) {
  const result = planClipComposition({
    document: editorDocumentSchema.parse({ version: 1, clipStartSec: 0, clipEndSec: 6, captionPreset: captionPresetSchema.parse({ visible: false }), transcriptSlice: [],
      deletedRanges: [], studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }), brollUrl: null, sceneBlocks: [] }),
    source: { identity: `source:${name}`, kind: "video", width: probe.width, height: probe.height, hasAudio: probe.hasAudio },
    evidence: { automaticLayout: { state: "missing" } }, assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  const outputPath = join(directory, `${name}.render.mp4`);
  const bound = bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(result.plan), {});
  const args = compileClipCompositionCommand({ sourcePath: path, outputPath, startSec: 0, endSec: 6, source: probe, plan: result.plan, targetId: "vertical", cutPlan: null,
    audio: bound, encoder: { preset: "veryfast", crf: "24" }, assets: { subtitlePath: null } });
  await worker.execute({ command: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", ...args], signal, deadlineMs: 60_000 });
  return validateRenderOutput({ path: outputPath, expected: compositionOutputExpectation({ plan: result.plan, targetId: "vertical", source: probe, audio: bound }), workerProcess: worker, signal });
}

async function rejection(work: () => Promise<unknown>) {
  const error = await work().then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(RenderOutputInvalid);
  return (error as RenderOutputInvalid).diagnosticCodes;
}

const strict = ({ previewStreamEnds: _ends, ...expected }: RenderOutputExpectation): RenderOutputExpectation => expected;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "preview-validation-"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    const file = Bun.file(join(directory, new URL(request.url).pathname.slice(1))), range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") ?? "");
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : file.size-1;
    return new Response(file.slice(start, end+1), { status: range ? 206 : 200,
      headers: { "Content-Length": String(end-start+1), "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.size}` } : {}) } });
  } });
});
afterAll(async () => { server.stop(true); await rm(directory, { recursive: true, force: true }); });

describe("a preview of an imperfect source", () => {
  test("audio ending 60ms short plays; the same proxy still fails the render contract", async () => {
    const { probe } = await source("short-audio.mp4", [...video(6, 60), ...audio(5.94)]);
    const { expected, outputPath, result } = await encodePreview("short-audio.mp4", probe, { startSec: 0, durationSec: 6 });
    expect(result.decoded.audio!.endSec).toBeLessThan(5.96);
    expect(await rejection(() => validateRenderOutput({ path: outputPath, expected: strict(expected), workerProcess: worker, signal }))).toEqual(["output_audio_duration_mismatch"]);
  }, 30_000);

  test("video ending before audio plays; the same proxy still fails the render contract", async () => {
    const { probe } = await source("early-video.mp4", [...video(5), ...audio(6)]);
    const { expected, outputPath, result } = await encodePreview("early-video.mp4", probe, { startSec: 0, durationSec: 6 });
    expect(result.decoded.video.endSec).toBeCloseTo(5, 3);
    expect(result.decoded.audio!.endSec).toBeGreaterThan(5.9);
    expect(await rejection(() => validateRenderOutput({ path: outputPath, expected: strict(expected), workerProcess: worker, signal }))).toEqual(["output_video_duration_mismatch"]);
  }, 30_000);

  test("a 500ms audio timestamp hole plays; the same proxy still fails the render contract", async () => {
    const { probe } = await source("audio-hole.mp4", [...video(6), ...audio(6), "-af", "aselect='not(between(t,3,3.5))'"]);
    const { expected, outputPath, result } = await encodePreview("audio-hole.mp4", probe, { startSec: 0, durationSec: 6 });
    expect(result.decoded.audio!.maxGapSec).toBeGreaterThan(0.45);
    expect(await rejection(() => validateRenderOutput({ path: outputPath, expected: strict(expected), workerProcess: worker, signal }))).toEqual(["output_audio_timestamps_invalid"]);
  }, 30_000);

  test("audio that starts late or ends before the window is not a failed preview", async () => {
    const late = await source("late-audio.mp4", [...video(6), "-itsoffset", "1", ...audio(5)]);
    expect((await encodePreview("late-audio.mp4", late.probe, { startSec: 0, durationSec: 6 })).result.decoded.audio!.startSec).toBeGreaterThan(0.9);
    const ended = await source("ended-audio.mp4", [...video(10), ...audio(3)]);
    expect((await encodePreview("ended-audio.mp4", ended.probe, { startSec: 5, durationSec: 5 })).result.decoded.audio).toBeNull();
  }, 30_000);

  test("a source header without stream ends bounds the file as a whole", async () => {
    const { probe } = await source("no-stream-ends.mkv", [...video(5), ...audio(6)]);
    expect(probe.facts?.videos[0]?.endTimeSec).toBeNull();
    const window = { startSec: 0, durationSec: probe.durationSec! };
    const { expected, outputPath } = await encodePreview("no-stream-ends.mkv", probe, window);
    expect(await rejection(() => validateRenderOutput({ path: outputPath, expected: { ...expected, durationSec: 8 }, workerProcess: worker, signal }))).toEqual(["output_container_duration_mismatch"]);
  }, 30_000);
});

describe("a preview is still validated", () => {
  const ends = (videoSec: number | null, audioSec: number | null) => ({ previewStreamEnds: { videoSec, audioSec } });
  let path: string; let expected: RenderOutputExpectation;
  beforeAll(async () => {
    const { probe } = await source("plain.mp4", [...video(4), ...audio(4)]);
    const preview = await encodePreview("plain.mp4", probe, { startSec: 0, durationSec: 4 });
    path = preview.outputPath; expected = preview.expected;
  }, 30_000);
  const validate = (contract: RenderOutputExpectation, workerProcess = worker) => validateRenderOutput({ path, expected: contract, workerProcess, signal });

  test("each stream must reach the end the source promised", async () => {
    await validate(expected);
    await validate({ ...expected, ...ends(4.4, 4.4) });
    expect(await rejection(() => validate({ ...expected, ...ends(4.6, 4) }))).toEqual(["output_video_duration_mismatch"]);
    expect(await rejection(() => validate({ ...expected, ...ends(4, 4.6) }))).toEqual(["output_audio_duration_mismatch"]);
  });

  test("a source shorter than the window with no audio end is not a failed preview", async () => {
    const window = { ...expected, durationSec: 6 };
    await validate({ ...window, ...ends(4, null) });
    await validate({ ...window, ...ends(null, 4) });
    expect(await rejection(() => validate({ ...window, ...ends(null, null) }))).toEqual(["output_container_duration_mismatch"]);
    expect(await rejection(() => validate({ ...expected, durationSec: 3, ...ends(2.9, null) }))).toContain("output_container_duration_mismatch");
  });

  test("a promised audio stream cannot go missing", async () => {
    expect(await rejection(() => validate({ ...expected, ...ends(4, 4) }, { ...worker, inspectMedia: async request => {
      const inspected = await worker.inspectMedia(request);
      return { ...inspected, facts: { ...inspected.facts!, audios: [] } };
    } }))).toEqual(["output_audio_stream_missing_or_extra"]);
  });

  test("the wrong codec or canvas is refused", async () => {
    expect(await rejection(() => validate({ ...expected, width: expected.width+2 }))).toEqual(["output_canvas_mismatch"]);
    expect(await rejection(() => validate(expected, { ...worker, inspectMedia: async request => {
      const inspected = await worker.inspectMedia(request);
      return { ...inspected, facts: { ...inspected.facts!, videos: [{ ...inspected.facts!.videos[0]!, codec: "hevc" }] } };
    } }))).toEqual(["output_video_codec_contract"]);
  });

  test("an undecodable file is refused", async () => {
    expect(await rejection(() => validate(expected, { ...worker, inspectMedia: worker.inspectMedia.bind(worker), execute: async () => { throw new WorkerProcessFailure("worker_command_failed", "retryable", "corrupt", "corrupt"); } }))).toEqual(["output_decode_failed"]);
  });
});

describe("real renders stay strict", () => {
  test("an ordinary source renders and passes", async () => {
    const { path, probe } = await source("render-plain.mp4", [...video(6), ...audio(6)]);
    expect((await render("render-plain", path, probe)).decoded.video.frames).toBe(180);
  }, 60_000);

  test("audio 60ms short is padded by the render and passes on its exact timeline", async () => {
    const { path, probe } = await source("render-short.mp4", [...video(6, 60), ...audio(5.94)]);
    expect((await render("render-short", path, probe)).decoded.audio!.endSec).toBeGreaterThanOrEqual(6);
  }, 60_000);

  test("video ending before the clip is rejected", async () => {
    const { path, probe } = await source("render-early.mp4", [...video(5), ...audio(6)]);
    expect(await rejection(() => render("render-early", path, probe))).toEqual(["output_video_duration_mismatch"]);
  }, 60_000);

  test("a 500ms audio hole is rejected", async () => {
    const { path, probe } = await source("render-hole.mp4", [...video(6), ...audio(6), "-af", "aselect='not(between(t,3,3.5))'"]);
    expect(await rejection(() => render("render-hole", path, probe))).toEqual(["output_audio_timestamps_invalid"]);
  }, 60_000);
});
