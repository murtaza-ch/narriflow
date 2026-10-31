import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planClipComposition } from "@narriflow/composition-plan";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
  type MediaFacts,
} from "@narriflow/validators";
import {
  bindCompositionPlanAudioInputs,
  compileClipCompositionCommand,
  compileCompositionPlanAudioSchedule,
} from "./composition-ffmpeg-adapter";
import { compositionSourceFor } from "./tasks/clip-render-attempt";
import { buildClipPreviewArgs } from "./tasks/clip-preview";
import { productionWorkerProcessModule, resolveDisplayGeometry, type WorkerMediaInspection } from "./worker-process";

const ONE = 65536;
type Matrix = number[];
const IDENTITY: Matrix = [ONE, 0, 0, 0, ONE, 0, 0, 0, 1 << 30];
const ROT90: Matrix = [0, -ONE, 0, ONE, 0, 0, 0, 0, 1 << 30];
const ROT90_MIRROR: Matrix = [0, ONE, 0, ONE, 0, 0, 0, 0, 1 << 30];
const ROT180: Matrix = [-ONE, 0, 0, 0, -ONE, 0, 0, 0, 1 << 30];
const MIRROR_H: Matrix = [-ONE, 0, 0, 0, ONE, 0, 0, 0, 1 << 30];
const OBLIQUE: Matrix = [46341, -46341, 0, 46341, 46341, 0, 0, 0, 1 << 30];

function inspection(
  width: number,
  height: number,
  options: { matrix?: Matrix | null; sar?: [number, number] | null; noFacts?: boolean } = {},
): WorkerMediaInspection {
  const video = {
    width,
    height,
    displayMatrix: options.matrix ?? null,
    sampleAspectRatio: options.sar ? { numerator: options.sar[0], denominator: options.sar[1] } : null,
  } as unknown as MediaFacts["videos"][number];
  return {
    durationSec: 10,
    width,
    height,
    hasVideo: true,
    hasAudio: false,
    hasVisualStream: true,
    fps: 30,
    ...(options.noFacts ? {} : { facts: { videos: [video], audios: [] } as unknown as MediaFacts }),
  };
}

describe("resolveDisplayGeometry", () => {
  test("a square-pixel source without a matrix keeps its coded geometry", () => {
    expect(resolveDisplayGeometry(inspection(1280, 720))).toEqual({ width: 1280, height: 720, oriented: false, anamorphic: false });
    expect(resolveDisplayGeometry(inspection(1280, 720, { matrix: IDENTITY, sar: [1, 1] }))).toEqual({
      width: 1280, height: 720, oriented: false, anamorphic: false,
    });
    expect(resolveDisplayGeometry(inspection(321, 181))).toMatchObject({ width: 321, height: 181 });
  });

  test("a source without facts keeps its coded geometry", () => {
    expect(resolveDisplayGeometry(inspection(1280, 720, { noFacts: true }))).toMatchObject({ width: 1280, height: 720, oriented: false });
  });

  test("quarter turns swap the axes; half turns and reflections keep them", () => {
    expect(resolveDisplayGeometry(inspection(1280, 720, { matrix: ROT90 }))).toEqual({ width: 720, height: 1280, oriented: true, anamorphic: false });
    expect(resolveDisplayGeometry(inspection(1280, 720, { matrix: ROT90_MIRROR }))).toMatchObject({ width: 720, height: 1280, oriented: true });
    expect(resolveDisplayGeometry(inspection(1280, 720, { matrix: ROT180 }))).toEqual({ width: 1280, height: 720, oriented: true, anamorphic: false });
    expect(resolveDisplayGeometry(inspection(1280, 720, { matrix: MIRROR_H }))).toMatchObject({ width: 1280, height: 720, oriented: true });
  });

  test("a pixel aspect widens the displayed axis before or after rotation", () => {
    expect(resolveDisplayGeometry(inspection(640, 360, { sar: [2, 1] }))).toEqual({ width: 1280, height: 360, oriented: false, anamorphic: true });
    expect(resolveDisplayGeometry(inspection(640, 360, { sar: [1, 2] }))).toMatchObject({ width: 320, height: 360, anamorphic: true });
    expect(resolveDisplayGeometry(inspection(640, 360, { matrix: ROT90, sar: [2, 1] }))).toEqual({ width: 360, height: 1280, oriented: true, anamorphic: true });
    expect(resolveDisplayGeometry(inspection(321, 181, { sar: [404, 405] }))).toMatchObject({ width: 320, height: 181, anamorphic: true });
  });

  test("an oblique matrix is not guessed at", () => {
    expect(resolveDisplayGeometry(inspection(1280, 720, { matrix: OBLIQUE, sar: [2, 1] }))).toEqual({
      width: 1280, height: 720, oriented: false, anamorphic: false,
    });
  });
});

function plan(source: WorkerMediaInspection, mode: "center" | "fit" = "center") {
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 4,
    captionPreset: captionPresetSchema.parse({ visible: false }),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, ...(mode === "fit" ? { background: { mode: "color", color: "#112233" } } : {}) }),
    brollUrl: null,
    deletedRanges: [],
  });
  const result = planClipComposition({
    document,
    source: compositionSourceFor(source, "source:geometry"),
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

function graphOf(source: WorkerMediaInspection, composition: ReturnType<typeof plan>): string {
  const args = compileClipCompositionCommand({
    sourcePath: "/tmp/source.mp4",
    outputPath: "/tmp/output.mp4",
    startSec: 0,
    endSec: 4,
    audio: bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(composition), {}),
    source,
    plan: composition,
    targetId: "vertical",
    encoder: { preset: "veryfast", crf: "21" },
    assets: { subtitlePath: null },
  });
  return args[args.indexOf("-filter_complex") + 1]!;
}

function centerCrop(composition: ReturnType<typeof plan>) {
  const layer = composition.targets[0]!.scenes[0]!.layers.find((candidate) => candidate.kind === "source-video")!;
  return layer.kind === "source-video" ? layer.sourceCrop : null;
}

describe("display geometry in the plan and graph", () => {
  test("a normal source plans from coded dimensions and its graph only declares square pixels", () => {
    const source = inspection(1280, 720, { matrix: IDENTITY, sar: [1, 1] });
    const composition = plan(source);
    expect(composition.source).toMatchObject({ width: 1280, height: 720 });
    expect(centerCrop(composition)).toEqual({ x: 438, y: 0, width: 405, height: 720 });
    const graph = graphOf(source, composition);
    expect(graph).toContain("[0:v]crop=405:720:438:0,scale=1080:1920,setsar=1,format=yuv420p");
    expect(graph).not.toContain("composition_display_source");
  });

  test("a rotated source crops its displayed frame, not the coded one", () => {
    const source = inspection(1280, 720, { matrix: ROT90 });
    const composition = plan(source);
    expect(composition.source).toMatchObject({ width: 720, height: 1280 });
    // 9:16 of a 720x1280 display is the whole frame.
    expect(centerCrop(composition)).toEqual({ x: 0, y: 0, width: 720, height: 1280 });
    expect(graphOf(source, composition)).toContain("[0:v]crop=720:1280:0:0,scale=1080:1920");
  });

  test("reflections and half turns keep coded dimensions and crops", () => {
    for (const matrix of [ROT180, MIRROR_H]) {
      const source = inspection(1280, 720, { matrix });
      const composition = plan(source);
      expect(centerCrop(composition)).toEqual({ x: 438, y: 0, width: 405, height: 720 });
      expect(graphOf(source, composition)).toContain("[0:v]crop=405:720:438:0,scale=1080:1920,setsar=1,format=yuv420p");
      expect(graphOf(source, composition)).not.toContain("composition_display_source");
    }
  });

  test("an anamorphic source is scaled to square pixels before it is cropped", () => {
    const source = inspection(640, 360, { sar: [2, 1] });
    const composition = plan(source);
    expect(composition.source).toMatchObject({ width: 1280, height: 360 });
    const graph = graphOf(source, composition);
    expect(graph).toContain("[0:v]scale=1280:360,setsar=1[composition_display_source]");
    expect(graph).toContain("[composition_display_source]crop=");
  });

  test("an anamorphic fit source normalizes before its fit scale", () => {
    const source = inspection(640, 360, { matrix: ROT90, sar: [2, 1] });
    const composition = plan(source, "fit");
    expect(composition.source).toMatchObject({ width: 360, height: 1280 });
    expect(graphOf(source, composition)).toContain("[0:v]scale=360:1280,setsar=1[composition_display_source]");
  });

  test("an inexact center scale declares square pixels", () => {
    const source = inspection(321, 181);
    const composition = plan(source);
    expect(centerCrop(composition)).toEqual({ x: 110, y: 0, width: 102, height: 181 });
    expect(graphOf(source, composition)).toContain("crop=102:181:110:0,scale=1080:1920,setsar=1,format=yuv420p");
  });

  test("a plan made for other dimensions than the displayed source is refused", () => {
    const rotated = inspection(1280, 720, { matrix: ROT90 });
    const codedPlan = plan(inspection(1280, 720));
    expect(() => graphOf(rotated, codedPlan)).toThrow("The plan was made for 1280x720 but the displayed source is 720x1280");
  });
});

describe("anamorphic preview proxy", () => {
  const base = { sourcePath: "/tmp/in.mp4", outputPath: "/tmp/out.mp4", windowStartSec: 0, windowDurationSec: 4, hasAudio: false, maxHeight: 540 };
  test("ordinary sources keep the existing scale filter", () => {
    expect(buildClipPreviewArgs(base)[buildClipPreviewArgs(base).indexOf("-vf") + 1]).toBe("scale=-2:540");
  });
  test("an anamorphic source is scaled to its displayed size with square pixels", () => {
    const args = buildClipPreviewArgs({ ...base, squarePixelAspect: 1280 / 360 });
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=1920:540,setsar=1");
  });
});

describe("rendered geometry", () => {
  const signal = new AbortController().signal;
  const run = (command: "ffmpeg" | "ffprobe", args: string[]) =>
    productionWorkerProcessModule.execute({ command, args, signal, deadlineMs: 30_000, captureStdout: true });

  test("an odd-sized source renders at the canvas size with square pixels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "narriflow-odd-geometry-"));
    try {
      const sourcePath = join(directory, "odd.mkv");
      const outputPath = join(directory, "out.mp4");
      await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=321x181:r=30:d=1,format=yuv444p", "-c:v", "ffv1", sourcePath]);
      const source = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 30_000 });
      expect(resolveDisplayGeometry(source)).toMatchObject({ width: 321, height: 181 });
      const composition = plan(source);
      const args = compileClipCompositionCommand({
        sourcePath, outputPath, startSec: 0, endSec: 1,
        audio: bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(composition), {}),
        source, plan: composition, targetId: "vertical", encoder: { preset: "ultrafast", crf: "30" }, assets: { subtitlePath: null },
      });
      await run("ffmpeg", args);
      const probe = JSON.parse(
        (await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "json", outputPath])).stdout.toString("utf8"),
      );
      expect(probe.streams[0]).toMatchObject({ width: 1080, height: 1920, sample_aspect_ratio: "1:1" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
