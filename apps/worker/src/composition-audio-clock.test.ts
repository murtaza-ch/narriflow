import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compositionAssetRef, planClipComposition } from "@narriflow/composition-plan";
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
import { buildClipCutPlan } from "./tasks/cut-plan";
import { findAudioTimestampGaps, inspectAudioTimestampGaps, productionWorkerProcessModule, withAudioTimestampGaps, type WorkerMediaInspection, WorkerProcessFailure, type WorkerProcessRequest } from "./worker-process";

const ALIGN = "aresample=async=1:first_pts=0";
const RATE = 48_000;
const FPS = 10;

type AudioTiming = { start: number | null; end: number | null; duration?: number | null };

function plannedCommand(options: {
  startSec: number;
  endSec: number;
  source: WorkerMediaInspection;
  deletedRanges?: Array<{ startSec: number; endSec: number }>;
  music?: { path: string; durationSec: number };
  scene?: { path: string; anchorSec: number; durationSec: number };
  outputPath?: string;
  sourcePath?: string;
}) {
  const assetId = "9e2af81d-8a41-4404-af89-b560f9c4eb98";
  const fingerprint = "a".repeat(64);
  const sceneRef = compositionAssetRef("visual_asset", `${assetId}:${fingerprint}`);
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      version: 1, clipStartSec: options.startSec, clipEndSec: options.endSec,
      captionPreset: captionPresetSchema.parse({ visible: false }), transcriptSlice: [],
      deletedRanges: options.deletedRanges ?? [],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "center" },
        ...(options.music ? { music: { url: "https://example.com/music.wav", volume: 20, ducking: false, fadeInSec: 0, fadeOutSec: 0 } } : {}),
      }),
      brollUrl: null,
      sceneBlocks: options.scene
        ? [{
          schemaVersion: 1, id: "8ab9d330-688f-4574-932c-27ac661245c1", anchorSec: options.scene.anchorSec, durationSec: options.scene.durationSec,
          content: { kind: "video", asset: { kind: "visual_asset", id: assetId, fingerprint }, sourceStartSec: 0, sourceEndSec: options.scene.durationSec, muted: false, volume: 50, fit: "cover", backgroundColor: "#000000" },
          motion: { entrance: "none", exit: "none" }, templateSnapshot: null,
        }]
        : [],
    }),
    source: { identity: "source:audio-clock", kind: "video", width: options.source.width, height: options.source.height, hasAudio: options.source.hasAudio },
    evidence: { automaticLayout: { state: "missing" } },
    assets: {
      backgroundImage: { state: "missing" },
      ...(options.music ? { music: { state: "available", ref: "music:bed", durationSec: options.music.durationSec } } as const : {}),
    },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  const cutPlan = options.deletedRanges?.length
    ? buildClipCutPlan(options.deletedRanges, { startSec: options.startSec, endSec: options.endSec })
    : null;
  return {
    plan: result.plan,
    args: compileClipCompositionCommand({
      sourcePath: options.sourcePath ?? "/source.mp4", outputPath: options.outputPath ?? "/out.mp4",
      startSec: options.startSec, endSec: options.endSec, source: options.source, plan: result.plan, targetId: "vertical",
      cutPlan,
      audio: bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(result.plan), options.music ? { music: { sourceRef: "music:bed", path: options.music.path } } : {}),
      encoder: { preset: "ultrafast", crf: "24" },
      assets: { subtitlePath: null, ...(options.scene ? { scenes: { [sceneRef]: { path: options.scene.path, kind: "video" as const, hasAudio: true } } } : {}) },
    }),
  };
}

function graphOf(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1]!;
}

function fakeInspection(options: { audio?: AudioTiming | null; origin?: number | null; noFacts?: boolean; sampleRate?: number; videoEnd?: number } = {}): WorkerMediaInspection {
  const audio = options.audio === undefined ? { start: 0, end: 10 } : options.audio;
  const facts = {
    format: { startTimeSec: options.origin === undefined ? 0 : options.origin },
    videos: [{ startTimeSec: options.origin ?? 0, endTimeSec: options.videoEnd ?? (options.origin ?? 0) + 10, width: 1280, height: 720, displayMatrix: null, sampleAspectRatio: null }],
    audios: audio
      ? [{
        startTimeSec: audio.start, endTimeSec: audio.end, durationSec: audio.duration ?? (audio.start != null && audio.end != null ? audio.end - audio.start : null),
        sampleRate: options.sampleRate ?? RATE,
      }]
      : [],
  } as unknown as MediaFacts;
  return {
    durationSec: 10, width: 1280, height: 720, hasVideo: true, hasAudio: audio !== null, hasVisualStream: true, fps: 30,
    ...(options.noFacts ? {} : { facts }),
  };
}

describe("source audio clock predicate", () => {
  const baseline = graphOf(plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ noFacts: true }) }).args);

  test("a track covering the window keeps the exact args", () => {
    const covering = plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ audio: { start: 0, end: 10 } }) }).args;
    expect(covering).toEqual(plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ noFacts: true }) }).args);
    expect(graphOf(covering)).toBe(baseline);
  });

  test("offsets inside one video frame, early starts and a track ending past the clip are not defects", () => {
    for (const audio of [
      { start: 0.03, end: 10 },
      { start: -0.021, end: 10 },
      { start: 0, end: 3.99 },
      { start: 0, end: 3.96 },
    ]) {
      expect(graphOf(plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ audio }) }).args)).toBe(baseline);
    }
  });

  test("a clip that starts after the late audio begins is already covered", () => {
    const covered = plannedCommand({ startSec: 2, endSec: 4, source: fakeInspection({ audio: { start: 0.9, end: 10 } }) }).args;
    expect(graphOf(covered)).not.toContain(ALIGN);
  });

  test("late audio and audio that ends early are laid on the clip window", () => {
    const late = graphOf(plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ audio: { start: 0.976, end: 10 } }) }).args);
    expect(late).toContain(`[0:a:0]${ALIGN},apad=whole_dur=4.000[composition_source_audio_clock]`);
    expect(late).toContain("[composition_source_audio_clock]afade=t=in");
    const short = graphOf(plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ audio: { start: 0, end: 0.5 } }) }).args);
    expect(short).toContain(`${ALIGN},apad=whole_dur=4.000`);
    const fromDuration = graphOf(plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ audio: { start: 0, end: null, duration: 2 } }) }).args);
    expect(fromDuration).toContain(ALIGN);
  });

  test("a non-zero container start is the origin of both the window and the stream", () => {
    const aligned = plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ origin: 100, audio: { start: 100, end: 110 } }) }).args;
    expect(graphOf(aligned)).toBe(baseline);
    const late = plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ origin: 100, audio: { start: 100.8, end: 110 } }) }).args;
    expect(graphOf(late)).toContain(ALIGN);
  });

  test("a window past the end of the picture is not an audio defect", () => {
    const pastEnd = plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ audio: { start: 0, end: 10 }, videoEnd: 2 }) }).args;
    expect(graphOf(pastEnd)).not.toContain(ALIGN);
  });

  test("without header facts or an audio stream nothing is claimed", () => {
    expect(graphOf(plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ noFacts: true }) }).args)).not.toContain(ALIGN);
    const silent = plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ audio: null }) }).args;
    expect(silent).toContain("-an");
    expect(graphOf(silent)).not.toContain("0:a");
  });

  test("a hole in the audio timestamps takes the aligned branch with a lower hard-compensation threshold", () => {
    const gapped = { ...fakeInspection({ audio: { start: 0, end: 10 } }), audioGaps: { frameSec: 0.021333, gaps: [{ atSec: 1, missingSec: 0.4 }] } };
    const graph = graphOf(plannedCommand({ startSec: 0, endSec: 4, source: gapped }).args);
    expect(graph).toContain("[0:a:0]aresample=async=1:min_hard_comp=0.021333:first_pts=0,apad=whole_dur=4.000[composition_source_audio_clock]");
    expect(graph).toContain("[composition_source_audio_clock]afade=t=in");
    // A continuous track (no gaps field) keeps the exact args.
    expect(graphOf(plannedCommand({ startSec: 0, endSec: 4, source: fakeInspection({ audio: { start: 0, end: 10 } }) }).args)).toBe(baseline);
  });

  test("cuts, mixes and scenes read the aligned track", () => {
    const late = fakeInspection({ audio: { start: 0.976, end: 10 } });
    const cut = graphOf(plannedCommand({ startSec: 0, endSec: 4, source: late, deletedRanges: [{ startSec: 1.4, endSec: 1.8 }] }).args);
    expect(cut).toContain("[composition_source_audio_clock]atrim=start=0.000:end=1.400");
    expect(cut).toContain("[composition_source_audio_clock]atrim=start=1.800:end=4.000");
    expect(cut).not.toContain("[0:a:0]atrim");
    const mixed = graphOf(plannedCommand({ startSec: 0, endSec: 4, source: late, music: { path: "/music.wav", durationSec: 4 } }).args);
    expect(mixed).toContain("[composition_source_audio_clock]atrim=duration=4.000");
    const scene = graphOf(plannedCommand({ startSec: 0, endSec: 4, source: late, scene: { path: "/scene.mp4", anchorSec: 1, durationSec: 1 } }).args);
    expect(scene).toContain("[composition_source_audio_clock]asplit=2");
  });
});

describe("audio timestamp gap detection", () => {
  const steady = (count: number, step = 0.021333, from = 0) => Array.from({ length: count }, (_, index) => from + index * step);

  test("a continuous track, rounding jitter and too few packets report nothing", () => {
    expect(findAudioTimestampGaps(steady(200))?.gaps).toEqual([]);
    // Millisecond timestamps alternate 21 and 22 ms.
    expect(findAudioTimestampGaps(Array.from({ length: 200 }, (_, index) => Math.round(index * 21.333) / 1000))?.gaps).toEqual([]);
    expect(findAudioTimestampGaps(steady(3))).toBeNull();
    expect(findAudioTimestampGaps([])).toBeNull();
  });

  test("a hole of more than one frame is reported where packets resume, and a hole of less is not", () => {
    const withHole = (missingSec: number) => [...steady(50), ...steady(50, 0.021333, 49 * 0.021333 + 0.021333 + missingSec)];
    const found = findAudioTimestampGaps(withHole(0.4))!;
    expect(found.frameSec).toBeCloseTo(0.021333, 5);
    expect(found.gaps).toHaveLength(1);
    expect(found.gaps[0]!.missingSec).toBeCloseTo(0.4, 4);
    expect(found.gaps[0]!.atSec).toBeCloseTo(50 * 0.021333 + 0.4, 4);
    expect(findAudioTimestampGaps(withHole(0.05))!.gaps).toHaveLength(1);
    expect(findAudioTimestampGaps(withHole(0.015))!.gaps).toEqual([]);
  });

  test("packets arrive in any order", () => {
    expect(findAudioTimestampGaps([...steady(30), ...steady(30, 0.021333, 1.2)].reverse())!.gaps).toHaveLength(1);
  });

  test("only a source with an audio stream and a valid window is scanned", async () => {
    const calls: string[][] = [];
    const processModule = { execute: async (request: { args: readonly string[] }) => { calls.push([...request.args]); throw new Error("must not be called"); } };
    const signal = new AbortController().signal;
    const base = { sourcePath: "/s.mp4", startSec: 0, endSec: 4, signal, deadlineMs: 1000 };
    expect(await inspectAudioTimestampGaps(processModule as never, { ...base, inspection: fakeInspection({ audio: null }) })).toBeNull();
    expect(await inspectAudioTimestampGaps(processModule as never, { ...base, inspection: fakeInspection({ noFacts: true }) })).toBeNull();
    expect(await inspectAudioTimestampGaps(processModule as never, { ...base, endSec: 0, inspection: fakeInspection() })).toBeNull();
    expect(calls).toEqual([]);
    // A scan that cannot run is not a render failure.
    const inspection = fakeInspection();
    expect(await withAudioTimestampGaps(processModule as never, inspection, base)).toBe(inspection);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("-read_intervals");
  });
});

describe("optional audio scan cost", () => {
  const base = { sourcePath: "/s.mp4", startSec: 0, endSec: 900, signal: new AbortController().signal, deadlineMs: 120_000 };

  test("Opus and Vorbis packet sizes cannot be mistaken for missing audio", async () => {
    for (const codec of ["opus", "vorbis"]) {
      const inspection = fakeInspection();
      inspection.facts!.audios[0]!.codec = codec;
      let scans = 0;
      expect(await withAudioTimestampGaps({ execute: async () => { scans++; throw new Error("must not scan"); } }, inspection, base)).toBe(inspection);
      expect(scans).toBe(0);
    }
  });

  test("compact audio-only output fits a full 15 minute window at 400 packets/sec", async () => {
    const csv = Buffer.from(Array.from({ length: 360_000 }, (_, i) => (i * 0.0025).toFixed(6)).join("\n"));
    expect(csv.length).toBeGreaterThan(2 * 1024 * 1024);
    const inspection = fakeInspection();
    const execute = async (request: WorkerProcessRequest) => {
      expect(request.deadlineMs).toBe(15_000);
      expect(request.maxStdoutBytes!).toBeGreaterThan(csv.length);
      expect(request.args).toContain("csv=p=0");
      expect(request.args).toContain("-select_streams");
      expect(request.args).toContain("packet=pts_time");
      return { exitCode: 0, stdout: csv };
    };
    expect(await withAudioTimestampGaps({ execute }, inspection, base)).toBe(inspection);
  });

  test("timeout, output-limit and executor failures degrade to no scan", async () => {
    for (const code of ["process_timeout", "process_output_limit", "process_spawn_failed"]) {
      const inspection = fakeInspection();
      const execute = async () => { throw new WorkerProcessFailure(code, "retryable", "optional probe failed", "probe failure", null, { failureScope: "executor" }); };
      expect(await withAudioTimestampGaps({ execute }, inspection, base)).toBe(inspection);
    }
  });

  test("render cancellation still interrupts the scan", async () => {
    const controller = new AbortController();
    controller.abort(new Error("render aborted"));
    await expect(withAudioTimestampGaps({ execute: async () => { throw new Error("aborted probe"); } }, fakeInspection(), { ...base, signal: controller.signal })).rejects.toThrow("render aborted");
  });
});

describe("audio gap scan clamps to the clip window", () => {
  const step = 0.021333;
  const run = (count: number, start: number) => Array.from({ length: count }, (_, index) => start + index * step);
  /** Packets with one hole: continuous to `holeFromSec`, silent for `holeSec`, continuous again until `untilSec`. */
  const packetsWithHole = (startSec: number, holeFromSec: number, holeSec: number, untilSec: number) => {
    const before = run(Math.floor((holeFromSec - startSec) / step), startSec);
    const resume = before.at(-1)! + step + holeSec;
    return [...before, ...run(Math.floor((untilSec - resume) / step) + 1, resume)];
  };
  const probeReturning = (times: number[]) => ({
    execute: async () => ({ stdout: Buffer.from(times.map((time) => time.toFixed(6)).join("\n")) }),
  });
  const base = { sourcePath: "/s.mp4", signal: new AbortController().signal, deadlineMs: 1000 };

  test("a hole in the preroll before the clip leaves the inspection, and so the render args, untouched", async () => {
    // The probe seeks to a keyframe before 2 s: packets from 0 s, a 0.4 s hole ending at 0.6 s, then continuous.
    const inspection = fakeInspection();
    const processModule = probeReturning(packetsWithHole(0, 0.2, 0.4, 3.2));
    expect(await withAudioTimestampGaps(processModule as never, inspection, { ...base, startSec: 2, endSec: 3 })).toBe(inspection);
  });

  test("a hole that spans the clip start is still found, and one after the clip end is not", async () => {
    const inspection = fakeInspection();
    const spanning = await withAudioTimestampGaps(probeReturning(packetsWithHole(1, 1.8, 0.4, 3.2)) as never, inspection, { ...base, startSec: 2, endSec: 3 });
    expect(spanning.audioGaps?.gaps).toHaveLength(1);
    expect(spanning.audioGaps!.gaps[0]!.atSec).toBeGreaterThan(0);
    expect(spanning.audioGaps!.gaps[0]!.atSec).toBeLessThan(0.7);
    const after = await withAudioTimestampGaps(probeReturning(packetsWithHole(1, 3.1, 0.4, 3.9)) as never, inspection, { ...base, startSec: 2, endSec: 3 });
    expect(after).toBe(inspection);
    const inside = await withAudioTimestampGaps(probeReturning(packetsWithHole(1.5, 2.4, 0.4, 3.2)) as never, inspection, { ...base, startSec: 2, endSec: 3 });
    expect(inside.audioGaps?.gaps).toHaveLength(1);
  });
});

describe("source audio clock render", () => {
  const signal = new AbortController().signal;
  const execute = (command: "ffmpeg" | "ffprobe", args: string[]) => productionWorkerProcessModule.execute({
    command, args: command === "ffmpeg" ? ["-hide_banner", "-loglevel", "error", "-y", ...args] : args,
    signal, deadlineMs: 30_000, captureStdout: true,
  });

  async function source(directory: string, name: string, options: { videoSec: number; audioSec: number; audioDelaySec?: number }) {
    const path = join(directory, `${name}.mp4`);
    await execute("ffmpeg", [
      "-f", "lavfi", "-i", `color=blue:s=90x160:r=${FPS}:d=${options.videoSec}`,
      "-itsoffset", String(options.audioDelaySec ?? 0),
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${RATE}:duration=${options.audioSec}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", path,
    ]);
    return path;
  }

  async function measure(path: string) {
    const probe = JSON.parse(new TextDecoder().decode((await execute("ffprobe", [
      "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,start_time,nb_read_frames:format=duration", "-of", "json", path,
    ])).stdout));
    const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    const audio = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
    const decoded = await execute("ffmpeg", ["-i", path, "-map", "0:a:0", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "pipe:1"]);
    const samples = new DataView(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength);
    const count = samples.byteLength / 4;
    const audioStart = Number(audio.start_time);
    const level = (fromSec: number, toSec: number) => {
      const from = Math.max(0, Math.round((fromSec - audioStart) * RATE));
      const to = Math.min(count, Math.round((toSec - audioStart) * RATE));
      let sum = 0;
      for (let index = from; index < to; index++) sum += Math.abs(samples.getFloat32(index * 4, true));
      return to > from ? sum / (to - from) : 0;
    };
    let onset: number | null = null;
    for (let index = 0; index < count && onset === null; index++) {
      if (Math.abs(samples.getFloat32(index * 4, true)) > 0.02) onset = audioStart + index / RATE;
    }
    return {
      frames: Number(video.nb_read_frames),
      audioStart,
      audioSec: count / RATE,
      onset,
      level,
    };
  }

  async function render(directory: string, name: string, sourcePath: string, options: Omit<Parameters<typeof plannedCommand>[0], "source" | "outputPath" | "sourcePath">) {
    const inspection = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 10_000 });
    const outputPath = join(directory, `${name}-out.mp4`);
    const { args } = plannedCommand({ ...options, source: inspection, sourcePath, outputPath });
    await execute("ffmpeg", args);
    return { graph: graphOf(args), ...await measure(outputPath) };
  }

  test("late dialogue keeps its onset and the full video", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-audio-clock-", async (directory) => {
      const path = await source(directory, "late", { videoSec: 3, audioSec: 2.1, audioDelaySec: 0.976 });
      const result = await render(directory, "late", path, { startSec: 0, endSec: 3 });
      expect(result.graph).toContain(ALIGN);
      expect(result.frames).toBe(3 * FPS);
      expect(Math.abs((result.onset ?? 99) - 0.976)).toBeLessThanOrEqual(1 / FPS);
      expect(result.level(0.1, 0.9)).toBeLessThan(0.001);
      expect(result.level(1.2, 2.5)).toBeGreaterThan(0.02);
      expect(result.audioStart + result.audioSec).toBeGreaterThan(2.9);
    });
  }, 30_000);

  test("late dialogue stays synchronized across a cut", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-audio-clock-", async (directory) => {
      const path = await source(directory, "late-cut", { videoSec: 4, audioSec: 3.1, audioDelaySec: 0.9 });
      const result = await render(directory, "late-cut", path, { startSec: 0, endSec: 4, deletedRanges: [{ startSec: 2, endSec: 2.5 }] });
      expect(result.frames).toBe(Math.round(3.5 * FPS));
      expect(Math.abs((result.onset ?? 99) - 0.9)).toBeLessThanOrEqual(1 / FPS);
      expect(result.level(0.1, 0.8)).toBeLessThan(0.001);
      expect(result.level(2.2, 3.3)).toBeGreaterThan(0.02);
    });
  }, 30_000);

  test("short dialogue with music keeps the full video", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-audio-clock-", async (directory) => {
      const path = await source(directory, "short", { videoSec: 3, audioSec: 0.5 });
      const musicPath = join(directory, "music.wav");
      await execute("ffmpeg", ["-f", "lavfi", "-i", `sine=frequency=220:sample_rate=${RATE}:duration=4`, musicPath]);
      const result = await render(directory, "short", path, { startSec: 0, endSec: 3, music: { path: musicPath, durationSec: 4 } });
      expect(result.graph).toContain(ALIGN);
      expect(result.frames).toBe(3 * FPS);
      expect(result.audioStart + result.audioSec).toBeGreaterThan(2.9);
      expect(result.level(0.1, 0.4)).toBeGreaterThan(0.02);
      expect(result.level(1, 2.8)).toBeGreaterThan(0.005);
    });
  }, 30_000);

  test("late dialogue before an inserted scene and after it stays on the edited clock", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-audio-clock-", async (directory) => {
      const path = await source(directory, "late-scene", { videoSec: 2, audioSec: 1.5, audioDelaySec: 0.5 });
      const scenePath = join(directory, "scene.mp4");
      await execute("ffmpeg", [
        "-f", "lavfi", "-i", `color=red:s=90x160:r=${FPS}:d=1`, "-f", "lavfi", "-i", `sine=frequency=880:sample_rate=${RATE}:duration=1`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", scenePath,
      ]);
      const result = await render(directory, "late-scene", path, { startSec: 0, endSec: 2, scene: { path: scenePath, anchorSec: 1, durationSec: 1 } });
      expect(result.frames).toBe(3 * FPS);
      expect(result.level(0.1, 0.4)).toBeLessThan(0.001);
      expect(result.level(0.6, 0.95)).toBeGreaterThan(0.01);
      expect(result.level(1.2, 1.8)).toBeGreaterThan(0.01);
      expect(result.level(2.1, 2.9)).toBeGreaterThan(0.01);
    });
  }, 30_000);

  /** A video whose audio timestamps jump forward by `gapSec` after `gapAtSec` of sound: the camera dropped audio, not video. */
  async function gappedSource(directory: string, name: string, options: { videoSec: number; audioSec: number; gapAtSec: number; gapSec: number; ext?: string }) {
    const path = join(directory, `${name}.${options.ext ?? "mp4"}`);
    await execute("ffmpeg", [
      "-f", "lavfi", "-i", `color=blue:s=90x160:r=${FPS}:d=${options.videoSec}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${RATE}:duration=${options.audioSec}`,
      "-af", `asetpts='if(gte(N,${Math.round(options.gapAtSec * RATE)}),PTS+${options.gapSec}/TB,PTS)'`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", path,
    ]);
    return path;
  }

  async function renderGapped(directory: string, name: string, sourcePath: string, window: { startSec: number; endSec: number }, detect: boolean) {
    const probed = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 10_000 });
    const inspection = detect
      ? await withAudioTimestampGaps(productionWorkerProcessModule, probed, { sourcePath, ...window, signal, deadlineMs: 10_000 })
      : probed;
    const outputPath = join(directory, `${name}-out.mp4`);
    const { args } = plannedCommand({ ...window, source: inspection, sourcePath, outputPath });
    await execute("ffmpeg", args);
    return { inspection, graph: graphOf(args), ...await measure(outputPath) };
  }

  for (const [label, gapSec] of [["a long", 0.4], ["a short", 0.06]] as const) {
    test(`${label} hole in the audio timestamps is found by the packet scan and keeps later dialogue on its video`, async () => {
      await productionWorkerProcessModule.withScratchDirectory("narriflow-audio-clock-", async (directory) => {
        const path = await gappedSource(directory, "gap", { videoSec: 3 + gapSec, audioSec: 3, gapAtSec: 1, gapSec });
        const window = { startSec: 0, endSec: 3 + gapSec };
        // Without the scan the headers look whole: the picture and the sound drift apart after the hole.
        const blind = await renderGapped(directory, "blind", path, window, false);
        expect(blind.graph).not.toContain(ALIGN);
        const found = await renderGapped(directory, "found", path, window, true);
        expect(found.inspection.audioGaps?.gaps).toHaveLength(1);
        expect(found.inspection.audioGaps!.gaps[0]!.missingSec).toBeGreaterThan(gapSec - 0.03);
        expect(found.graph).toContain("aresample=async=1:min_hard_comp=");
        expect(found.frames).toBe(Math.round((3 + gapSec) * FPS));
        // Silence over the hole, then sound again on the video clock, and the full length.
        expect(found.level(0.2, 0.9)).toBeGreaterThan(0.02);
        expect(found.level(1.012, 1 + gapSec - 0.012)).toBeLessThan(0.002);
        expect(found.level(1 + gapSec + 0.05, 2.8)).toBeGreaterThan(0.02);
        expect(found.audioStart + found.audioSec).toBeGreaterThan(3 + gapSec - 0.1);
        // The unaligned render plays the same sound through the hole.
        expect(blind.level(1.012, 1 + gapSec - 0.012)).toBeGreaterThan(0.02);
      });
    }, 60_000);
  }

  test("the scan honours the clip window: a hole outside it changes nothing", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-audio-clock-", async (directory) => {
      const path = await gappedSource(directory, "outside", { videoSec: 6.4, audioSec: 6, gapAtSec: 5, gapSec: 0.4 });
      const window = { startSec: 0, endSec: 3 };
      const probed = await productionWorkerProcessModule.inspectMedia({ sourcePath: path, signal, deadlineMs: 10_000 });
      const scanned = await withAudioTimestampGaps(productionWorkerProcessModule, probed, { sourcePath: path, ...window, signal, deadlineMs: 10_000 });
      expect(scanned).toBe(probed);
      const clean = plannedCommand({ ...window, source: probed, sourcePath: path, outputPath: "/out.mp4" }).args;
      const later = await withAudioTimestampGaps(productionWorkerProcessModule, probed, { sourcePath: path, startSec: 4, endSec: 6.4, signal, deadlineMs: 10_000 });
      expect(later.audioGaps?.gaps).toHaveLength(1);
      expect(clean).toEqual(plannedCommand({ ...window, source: scanned, sourcePath: path, outputPath: "/out.mp4" }).args);
    });
  }, 60_000);

  test("a continuous source keeps bit-identical args and samples after the scan", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-audio-clock-", async (directory) => {
      const path = await source(directory, "clean", { videoSec: 3, audioSec: 3 });
      const window = { startSec: 0, endSec: 3 };
      const blind = await renderGapped(directory, "clean-blind", path, window, false);
      const scanned = await renderGapped(directory, "clean-scan", path, window, true);
      expect(scanned.inspection.audioGaps).toBeUndefined();
      expect(scanned.graph).toBe(blind.graph);
      expect(scanned.audioSec).toBe(blind.audioSec);
      expect(scanned.level(0, 3)).toBe(blind.level(0, 3));
    });
  }, 60_000);

  test("a source with no audio stays silent video", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-audio-clock-", async (directory) => {
      const path = join(directory, "silent.mp4");
      await execute("ffmpeg", ["-f", "lavfi", "-i", `color=blue:s=90x160:r=${FPS}:d=2`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path]);
      const inspection = await productionWorkerProcessModule.inspectMedia({ sourcePath: path, signal, deadlineMs: 10_000 });
      const { args } = plannedCommand({ startSec: 0, endSec: 2, source: inspection, sourcePath: path, outputPath: join(directory, "out.mp4") });
      expect(args).toContain("-an");
      expect(graphOf(args)).not.toContain(ALIGN);
    });
  }, 30_000);
});
