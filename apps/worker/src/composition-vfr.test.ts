import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { planClipComposition } from "@narriflow/composition-plan";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import {
  bindCompositionPlanAudioInputs,
  compileClipCompositionCommand,
  compileCompositionPlanAudioSchedule,
  renderOutputFrameRate,
} from "./composition-ffmpeg-adapter";
import { passthroughColor, validateRenderOutput } from "./render-output-validation";
import { buildClipCutPlan } from "./tasks/cut-plan";
import {
  chooseConstantFrameRate,
  createWorkerProcessModule,
  decideVideoClock,
  hasVariableTimestamps,
  productionWorkerProcessModule,
  type WorkerMediaInspection,
  type WorkerProcessRequest,
} from "./worker-process";

const regular = (count: number, step: number) => Array.from({ length: count }, (_, index) => index * step);
/** Frame pairs 11 ms apart followed by 0.17 s gaps, like the golden fixture. */
const irregular = Array.from({ length: 60 }, (_, index) => Math.floor(index / 2) * 0.2 + (index % 2) * 0.011);

describe("variable timestamp evidence", () => {
  test("constant intervals, a few drops and small jitter are not variable", () => {
    expect(hasVariableTimestamps(regular(120, 1 / 30))).toBe(false);
    expect(hasVariableTimestamps(regular(120, 1001 / 30000))).toBe(false);
    const dropped = regular(120, 1 / 30).filter((_, index) => index !== 40);
    expect(hasVariableTimestamps(dropped)).toBe(false);
    expect(hasVariableTimestamps(regular(120, 1 / 30).map((time, index) => time + (index % 2) * 0.002))).toBe(false);
  });

  test("alternating or irregular intervals are variable, in any packet order", () => {
    expect(hasVariableTimestamps(irregular)).toBe(true);
    expect(hasVariableTimestamps([...irregular].reverse())).toBe(true);
    const alternating = [...regular(30, 1 / 30), ...regular(4, 0.5).map((time) => time + 1)];
    expect(hasVariableTimestamps(alternating)).toBe(true);
  });

  test("too little evidence says nothing", () => {
    expect(hasVariableTimestamps([])).toBeNull();
    expect(hasVariableTimestamps(regular(5, 1 / 30))).toBeNull();
  });
});

describe("constant rate choice", () => {
  test.each([
    [{ numerator: 15, denominator: 1 }, { numerator: 15, denominator: 1 }],
    [{ numerator: 3150, denominator: 179 }, { numerator: 24000, denominator: 1001 }],
    [{ numerator: 1920, denominator: 113 }, { numerator: 24000, denominator: 1001 }],
    [{ numerator: 2997, denominator: 100 }, { numerator: 30000, denominator: 1001 }],
    [{ numerator: 30, denominator: 1 }, { numerator: 30, denominator: 1 }],
    [{ numerator: 24, denominator: 1 }, { numerator: 24, denominator: 1 }],
    [{ numerator: 26, denominator: 1 }, { numerator: 30000, denominator: 1001 }],
    [{ numerator: 40, denominator: 1 }, { numerator: 50, denominator: 1 }],
    [{ numerator: 60, denominator: 1 }, { numerator: 60, denominator: 1 }],
    [{ numerator: 120, denominator: 1 }, { numerator: 60, denominator: 1 }],
    [{ numerator: 1000, denominator: 1 }, { numerator: 60, denominator: 1 }],
    [{ numerator: 1, denominator: 2 }, { numerator: 15, denominator: 1 }],
    [null, { numerator: 30, denominator: 1 }],
  ])("average %j becomes %j", (average, expected) => {
    expect(chooseConstantFrameRate(average)).toEqual(expected);
  });
});

describe("video clock decision", () => {
  const neverRead = async () => { throw new Error("timestamps must not be read"); };

  test("constant-rate sources, including exact NTSC, are left alone without reading packets", async () => {
    for (const [base, average] of [["30/1", "30/1"], ["30000/1001", "30000/1001"], ["24000/1001", "24000/1001"], ["30/1", "2998/100"], ["30000/1001", "30/1"]]) {
      expect(await decideVideoClock({ r_frame_rate: base, avg_frame_rate: average }, neverRead)).toBeNull();
    }
    expect(await decideVideoClock({ r_frame_rate: "0/0", avg_frame_rate: "25/1" }, neverRead)).toBeNull();
    expect(await decideVideoClock({ r_frame_rate: "30/1", avg_frame_rate: "0/0" }, neverRead)).toBeNull();
  });

  test("a 90000/1 base with a 15/1 average and irregular timestamps becomes 15/1", async () => {
    const decision = await decideVideoClock({ r_frame_rate: "90000/1", avg_frame_rate: "15/1" }, async () => irregular);
    expect(decision).toEqual({
      baseRate: { numerator: 90000, denominator: 1 }, averageRate: { numerator: 15, denominator: 1 },
      variable: true, packetsSampled: irregular.length, constantRate: { numerator: 15, denominator: 1 }, reason: "variable-timestamps",
    });
  });

  test("a disagreeing rate over regular timestamps keeps the raw clock", async () => {
    const decision = await decideVideoClock({ r_frame_rate: "50/1", avg_frame_rate: "25/1" }, async () => regular(100, 1 / 25));
    expect(decision).toMatchObject({ variable: false, constantRate: null, reason: null });
  });

  test("an absurd base rate never drives video, with or without timestamp evidence", async () => {
    for (const read of [async () => null, async () => regular(3, 0.1), async () => regular(100, 1 / 30)]) {
      expect(await decideVideoClock({ r_frame_rate: "90000/1", avg_frame_rate: "15/1" }, read))
        .toMatchObject({ constantRate: { numerator: 15, denominator: 1 }, reason: expect.any(String) });
    }
    expect(await decideVideoClock({ r_frame_rate: "90000/1", avg_frame_rate: "0/0" }, neverRead))
      .toMatchObject({ constantRate: { numerator: 30, denominator: 1 }, reason: "unrealistic-base-rate" });
    expect(await decideVideoClock({ r_frame_rate: "90000/1", avg_frame_rate: "1000/1" }, async () => null))
      .toMatchObject({ constantRate: { numerator: 60, denominator: 1 } });
  });

  test("a measured NTSC average is kept as the exact fraction", async () => {
    const decision = await decideVideoClock({ r_frame_rate: "90000/1", avg_frame_rate: "2997/100" }, async () => irregular);
    expect(decision?.constantRate).toEqual({ numerator: 30000, denominator: 1001 });
  });
});

describe("inspection of a variable-rate stream", () => {
  const probe = (r_frame_rate: string, avg_frame_rate: string) => JSON.stringify({
    format: { duration: "8" },
    streams: [{ index: 0, codec_type: "video", width: 640, height: 360, r_frame_rate, avg_frame_rate }],
  });

  async function inspect(stdout: string, packets: (() => string) | Error) {
    const calls: WorkerProcessRequest[] = [];
    const module = createWorkerProcessModule({
      execute: async (request) => {
        calls.push(request);
        if (calls.length === 1) return { exitCode: 0, stdout: Buffer.from(stdout) };
        if (packets instanceof Error) throw packets;
        return { exitCode: 0, stdout: Buffer.from(packets()) };
      },
    });
    const inspection = await module.inspectMedia({ sourcePath: "https://x.test/a.mp4?token=secret", signal: new AbortController().signal, deadlineMs: 5_000 });
    return { inspection, calls };
  }

  const packetJson = (times: number[]) => JSON.stringify({ packets: times.map((time) => ({ pts_time: time.toFixed(6) })) });

  test("synthetic 90000/1 base and 15/1 average render at 15, with the facts recorded", async () => {
    const { inspection, calls } = await inspect(probe("90000/1", "15/1"), () => packetJson(irregular));
    expect(inspection.fps).toBe(15);
    expect(inspection.videoClock).toMatchObject({
      baseRate: { numerator: 90000, denominator: 1 }, averageRate: { numerator: 15, denominator: 1 },
      variable: true, constantRate: { numerator: 15, denominator: 1 }, reason: "variable-timestamps",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toContain("%+#300");
    expect(calls[1]!.args).toContain("-show_packets");
    expect(calls[1]!.args).toContain("-rw_timeout");
    expect(calls[1]!.maxStdoutBytes).toBe(1024 * 1024);
  });

  test("a constant-rate file costs no second probe and keeps its raw rate", async () => {
    const { inspection, calls } = await inspect(probe("30000/1001", "30000/1001"), () => { throw new Error("unused"); });
    expect(calls).toHaveLength(1);
    expect(inspection.fps).toBe(30000 / 1001);
    expect(inspection.videoClock).toBeUndefined();
  });

  test("unreadable packets never fail the inspection, and an absurd base still cannot drive video", async () => {
    for (const packets of [new Error("ffprobe failed"), () => "{}", () => "not json"] as const) {
      const { inspection } = await inspect(probe("90000/1", "15/1"), packets);
      expect(inspection.fps).toBe(15);
      expect(inspection.videoClock).toMatchObject({ variable: null, packetsSampled: 0, reason: "unrealistic-base-rate" });
    }
    const { inspection } = await inspect(probe("50/1", "25/1"), new Error("ffprobe failed"));
    expect(inspection.fps).toBe(50);
    expect(inspection.videoClock).toMatchObject({ variable: null, constantRate: null });
  });

  test("cancellation is not swallowed", async () => {
    const controller = new AbortController();
    const module = createWorkerProcessModule({
      execute: async () => {
        if (!controller.signal.aborted) return { exitCode: 0, stdout: Buffer.from(probe("90000/1", "15/1")) };
        throw new Error("aborted");
      },
    });
    const pending = module.inspectMedia({ sourcePath: "/tmp/a.mp4", signal: controller.signal, deadlineMs: 5_000 });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });
});

function command(options: { source: WorkerMediaInspection; startSec?: number; endSec?: number; deletedRanges?: Array<{ startSec: number; endSec: number }>; insertScene?: boolean; sourcePath?: string; outputPath?: string; preset?: string }) {
  const startSec = options.startSec ?? 0;
  const endSec = options.endSec ?? 4;
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      version: 1, clipStartSec: startSec, clipEndSec: endSec,
      captionPreset: captionPresetSchema.parse({ visible: false }), transcriptSlice: [],
      deletedRanges: options.deletedRanges ?? [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null,
      sceneBlocks: options.insertScene
        ? [{
          schemaVersion: 1, id: "8ab9d330-688f-4574-932c-27ac661245c1", anchorSec: 1, durationSec: 1,
          content: { kind: "color", color: "#112233" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null,
        }]
        : [],
    }),
    source: { identity: "source:vfr", kind: "video", width: options.source.width, height: options.source.height, hasAudio: options.source.hasAudio },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  const cutPlan = options.deletedRanges?.length ? buildClipCutPlan(options.deletedRanges, { startSec, endSec }) : null;
  return compileClipCompositionCommand({
    sourcePath: options.sourcePath ?? "/source.mp4", outputPath: options.outputPath ?? "/out.mp4",
    startSec, endSec, source: options.source, plan: result.plan, targetId: "vertical", cutPlan,
    audio: bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(result.plan), {}),
    encoder: { preset: options.preset ?? "ultrafast", crf: "24" },
    assets: { subtitlePath: null },
  });
}

const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1]!;

function fakeInspection(extra: Partial<WorkerMediaInspection> = {}): WorkerMediaInspection {
  return { durationSec: 10, width: 640, height: 360, hasVideo: true, hasAudio: true, hasVisualStream: true, fps: 30, ...extra };
}

const clockOf = (base: number, constant: { numerator: number; denominator: number } | null) => ({
  baseRate: { numerator: base, denominator: 1 }, averageRate: constant, variable: true as const, packetsSampled: 120, constantRate: constant,
  reason: "variable-timestamps" as const,
});

describe("render graph clock", () => {
  test("a variable-rate source is made constant before any branch and generated scenes use its exact rate", () => {
    const source = fakeInspection({ fps: 15, videoClock: clockOf(90000, { numerator: 15, denominator: 1 }) });
    const graph = graphOf(command({ source, insertScene: true }));
    expect(graph).toContain("[0:v]setpts=PTS-STARTPTS,fps=15[composition_constant_rate_source]");
    expect(graph).toContain("[composition_constant_rate_source]setpts=PTS-STARTPTS,settb=AVTB[composition_source_clock]");
    expect(graph).toContain(":r=15:d=1.000");
    expect(graph).not.toContain("90000");
    expect(graph).not.toContain(":r=30:");
  });

  test("an exact NTSC average keeps its fraction in the source and generated scenes", () => {
    const source = fakeInspection({ fps: 30000 / 1001, videoClock: clockOf(90000, { numerator: 30000, denominator: 1001 }) });
    const graph = graphOf(command({ source, insertScene: true }));
    expect(graph).toContain("fps=30000/1001[composition_constant_rate_source]");
    expect(graph).toContain(":r=30000/1001:d=1.000");
  });

  test("a cut runs the constant rate on the edited clock, padded to zero", () => {
    const source = fakeInspection({ fps: 15, videoClock: clockOf(90000, { numerator: 15, denominator: 1 }) });
    const graph = graphOf(command({ source, deletedRanges: [{ startSec: 1.5, endSec: 2 }] }));
    expect(graph).toMatch(/\[vcat\]fps=15:start_time=0\[composition_constant_rate_source\]/);
  });

  test("ordinary sources keep their exact args, whether or not a clock was examined", () => {
    const plain = command({ source: fakeInspection({ fps: 30000 / 1001 }), insertScene: true });
    const examined = command({
      source: fakeInspection({ fps: 30000 / 1001, videoClock: { ...clockOf(50, null), variable: false, reason: null } }),
      insertScene: true,
    });
    expect(examined).toEqual(plain);
    expect(graphOf(plain)).not.toContain("composition_constant_rate_source");
    expect(graphOf(plain)).toContain(":r=29.97002997002997:d=1.000");
  });
});

describe("real variable-rate media", () => {
  const signal = new AbortController().signal;
  const execute = (command: "ffmpeg" | "ffprobe", args: string[]) => productionWorkerProcessModule.execute({
    command, args: command === "ffmpeg" ? ["-hide_banner", "-loglevel", "error", "-y", ...args] : args,
    signal, deadlineMs: 60_000, captureStdout: true,
  });

  /** 30 fps in the even seconds and 2 fps in the odd ones, with sound. */
  async function alternatingSource(directory: string) {
    const path = join(directory, "alternating.mp4");
    await execute("ffmpeg", [
      "-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=8", "-f", "lavfi", "-i", "sine=f=330:sample_rate=48000:d=8",
      "-vf", "select='lt(mod(floor(t),2),1)+not(mod(n,15))'", "-fps_mode", "passthrough", "-video_track_timescale", "90000",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", path,
    ]);
    return path;
  }

  async function facts(path: string) {
    const probe = JSON.parse(new TextDecoder().decode((await execute("ffprobe", [
      "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,r_frame_rate,avg_frame_rate,start_time,nb_read_frames,duration", "-of", "json", path,
    ])).stdout));
    const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    const audio = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
    return { video, audio };
  }

  for (const cut of [false, true]) {
    test(`alternating 2 and 30 fps media renders at one constant rate with full duration and sound${cut ? " across a cut" : ""}`, async () => {
      await productionWorkerProcessModule.withScratchDirectory("narriflow-vfr-", async (directory) => {
        const path = await alternatingSource(directory);
        const inspection = await productionWorkerProcessModule.inspectMedia({ sourcePath: path, signal, deadlineMs: 30_000 });
        expect(inspection.videoClock).toMatchObject({ variable: true, reason: "variable-timestamps" });
        const rate = inspection.videoClock!.constantRate!;
        // The source averages about 17 fps, so the next standard rate up.
        expect(rate).toEqual({ numerator: 24000, denominator: 1001 });
        expect(inspection.fps).toBe(rate.numerator / rate.denominator);

        const output = join(directory, "out.mp4");
        const startSec = 0;
        const endSec = 6;
        const deletedRanges = cut ? [{ startSec: 2, endSec: 3 }] : [];
        const args = command({ source: inspection, startSec, endSec, deletedRanges, sourcePath: path, outputPath: output });
        await execute("ffmpeg", args);

        const editedSec = endSec - startSec - deletedRanges.reduce((sum, range) => sum + range.endSec - range.startSec, 0);
        const { video, audio } = await facts(output);
        const fps = rate.numerator / rate.denominator;
        const expectedRate = `${rate.numerator}/${rate.denominator}`;
        expect(video.r_frame_rate).toBe(expectedRate);
        expect(video.avg_frame_rate).toBe(expectedRate);
        expect(Math.abs(Number(video.nb_read_frames) - editedSec * fps)).toBeLessThanOrEqual(1);
        expect(Math.abs(Number(video.duration) - editedSec)).toBeLessThanOrEqual(1 / fps);
        expect(Math.abs(Number(audio.duration) - editedSec)).toBeLessThanOrEqual(0.05);
        expect(Math.abs(Number(video.start_time) - Number(audio.start_time))).toBeLessThanOrEqual(1 / fps);
      });
    }, 60_000);
  }
});

describe("delivered frame rate", () => {
  const rate = (numerator: number, denominator: number) => ({ numerator, denominator });
  const factsWith = (rFrameRate: ReturnType<typeof rate>) => ({ videos: [{ rFrameRate }], audios: [] }) as unknown as WorkerMediaInspection["facts"];
  const encodedRate = (args: string[]) => args[args.indexOf("-r") + 1];

  test("the rate is the normalized constant rate, then the stream's own, then a standard rate, then 30", () => {
    expect(renderOutputFrameRate(fakeInspection({ fps: 15, videoClock: clockOf(90000, rate(15, 1)), facts: factsWith(rate(90000, 1)) }))).toEqual(rate(15, 1));
    expect(renderOutputFrameRate(fakeInspection({ facts: factsWith(rate(30000, 1001)) }))).toEqual(rate(30000, 1001));
    expect(renderOutputFrameRate(fakeInspection({ fps: 30000 / 1001 }))).toEqual(rate(30000, 1001));
    expect(renderOutputFrameRate(fakeInspection({ fps: 0 }))).toEqual(rate(30, 1));
  });

  test("a video encode declares it, so every frame leaves the encoder with a duration", () => {
    expect(encodedRate(command({ source: fakeInspection() }))).toBe("30");
    expect(encodedRate(command({ source: fakeInspection({ facts: factsWith(rate(30000, 1001)) }) }))).toBe("30000/1001");
    expect(encodedRate(command({ source: fakeInspection({ fps: 15, videoClock: clockOf(90000, rate(15, 1)) }), insertScene: true }))).toBe("15");
  });
});

describe("a window that ends inside a frame", () => {
  const signal = new AbortController().signal;

  // FFmpeg 7 clears frame durations in setpts (the source clock stage of a scene
  // render); the mp4 muxer then wrote the last sample with duration 0, the edit
  // list hid that frame from every decoder, and the header counted one frame more
  // than was playable (781 vs 780 at 26.02 s). FFmpeg 8 and later keep them.
  test("keeps its last frame playable: header and decoded frame counts agree", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-last-frame-", async (directory) => {
      const input = join(directory, "source.mp4");
      await productionWorkerProcessModule.execute({
        command: "ffmpeg", signal, deadlineMs: 60_000,
        args: ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=32", "-f", "lavfi", "-i", "sine=r=44100:d=32",
          "-c:v", "libx264", "-preset", "veryfast", "-video_track_timescale", "15360", "-pix_fmt", "yuv420p", "-c:a", "aac", input],
      });
      const source = await productionWorkerProcessModule.inspectMedia({ sourcePath: input, signal, deadlineMs: 30_000 });
      const output = join(directory, "out.mp4");
      const args = command({ source, startSec: 3, endSec: 28.02, insertScene: true, sourcePath: input, outputPath: output, preset: "veryfast" });
      await productionWorkerProcessModule.execute({ command: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", ...args], signal, deadlineMs: 60_000 });
      const result = await validateRenderOutput({
        path: output, workerProcess: productionWorkerProcessModule, signal,
        expected: {
          durationSec: 26.02, width: 90, height: 160, frameRate: rate30, sampleAspectRatio: { numerator: 1, denominator: 1 },
          audio: {}, color: passthroughColor(undefined),
        },
      });
      expect(result.decoded.video.frames).toBe(781);
    });
  }, 90_000);
});

const rate30 = { numerator: 30, denominator: 1 };
