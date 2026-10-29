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
import { productionWorkerProcessModule, type WorkerMediaInspection } from "./worker-process";

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
