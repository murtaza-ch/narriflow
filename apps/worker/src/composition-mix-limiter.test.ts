import { describe, expect, test } from "bun:test";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { compositionAssetRef, planClipComposition } from "@narriflow/composition-plan";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  bindCompositionPlanAudioInputs,
  compileClipCompositionCommand,
  compileCompositionPlanAudioSchedule,
  type BoundCompositionAudioRenderRequest,
} from "./composition-ffmpeg-adapter";
import { guardMixPeak, parseMixPeakMetadata } from "./render-mix-peak";
import { productionWorkerProcessModule } from "./worker-process";

const RATE = 48_000;
const FPS = 10;
const signal = new AbortController().signal;
const run = (command: "ffmpeg" | "ffprobe", args: string[]) =>
  productionWorkerProcessModule.execute({ command, args, signal, deadlineMs: 60_000, captureStdout: true });
const ffmpeg = (args: string[]) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** A stereo tone: sine's own amplitude is 1/8, so `volume` scales it to `peak`. */
const tone = (frequency: number, durationSec: number, peak: number) =>
  `sine=frequency=${frequency}:sample_rate=${RATE}:duration=${durationSec},volume=${(peak * 8).toFixed(3)},aformat=channel_layouts=stereo`;

/** Full-scale music or effect: two tones summing to 1.85, stored as 16-bit so they clip at 1.0. */
const hotTrack = (low: number, high: number, durationSec: number) =>
  `aevalsrc=exprs='0.95*sin(2*PI*${low}*t)+0.9*sin(2*PI*${high}*t)|0.95*sin(2*PI*${low}*t)+0.9*sin(2*PI*${high}*t)':s=${RATE}:d=${durationSec}`;

const sceneAssetId = "9e2af81d-8a41-4404-af89-b560f9c4eb98";
const sceneFingerprint = "a".repeat(64);
const sceneRef = compositionAssetRef("visual_asset", `${sceneAssetId}:${sceneFingerprint}`);

type Mix = {
  musicGain: number | null;
  sfx?: Array<{ startSec: number; gain: number }>;
  scene?: boolean;
};

async function fixture(directory: string, options: { dialoguePeak: number; withScene: boolean }) {
  const source = join(directory, "source.mp4");
  // Silence, then a dialogue burst, so the onset is unambiguous in the source.
  await ffmpeg([
    "-f", "lavfi", "-i", `color=blue:s=90x160:r=${FPS}:d=3`,
    "-f", "lavfi", "-i", `${tone(440, 2.5, options.dialoguePeak)},adelay=500:all=1,apad=whole_dur=3`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-t", "3", source,
  ]);
  const music = join(directory, "music.wav");
  await ffmpeg(["-f", "lavfi", "-i", hotTrack(220, 330, 4), "-c:a", "pcm_s16le", music]);
  const sfx: string[] = [];
  for (const [index, frequency] of [550, 660, 770].entries()) {
    const path = join(directory, `sfx-${index}.wav`);
    await ffmpeg(["-f", "lavfi", "-i", hotTrack(frequency, frequency * 1.5, 1.5), "-c:a", "pcm_s16le", path]);
    sfx.push(path);
  }
  const scene = join(directory, "scene.mp4");
  if (options.withScene) {
    await ffmpeg([
      "-f", "lavfi", "-i", `color=red:s=90x160:r=${FPS}:d=1`, "-f", "lavfi", "-i", tone(880, 1, 0.9),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", scene,
    ]);
  }
  return { source, music, sfx, scene };
}

async function plan(source: string, mix: Mix) {
  const inspection = await productionWorkerProcessModule.inspectMedia({ sourcePath: source, signal, deadlineMs: 10_000 });
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      version: 1, clipStartSec: 0, clipEndSec: 3, captionPreset: captionPresetSchema.parse({ visible: false }), transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "center" },
        ...(mix.musicGain === null ? {} : { music: { url: "https://example.com/music.wav", volume: 20, ducking: false, fadeInSec: 0, fadeOutSec: 0 } }),
      }),
      brollUrl: null,
      sceneBlocks: mix.scene
        ? [{
          schemaVersion: 1, id: "8ab9d330-688f-4574-932c-27ac661245c1", anchorSec: 1.5, durationSec: 1,
          content: { kind: "video", asset: { kind: "visual_asset", id: sceneAssetId, fingerprint: sceneFingerprint }, sourceStartSec: 0, sourceEndSec: 1, muted: false, volume: 100, fit: "cover", backgroundColor: "#000000" },
          motion: { entrance: "none", exit: "none" }, templateSnapshot: null,
        }]
        : [],
    }),
    source: { identity: "source:mix", kind: "video", width: inspection.width, height: inspection.height, hasAudio: true },
    evidence: { automaticLayout: { state: "missing" } },
    assets: {
      backgroundImage: { state: "missing" },
      ...(mix.musicGain === null ? {} : { music: { state: "available", ref: "music:bed", durationSec: 4 } } as const),
    },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return { inspection, plan: result.plan };
}

async function renderMix(directory: string, name: string, files: Awaited<ReturnType<typeof fixture>>, mix: Mix) {
  const { inspection, plan: composition } = await plan(files.source, mix);
  const schedule = compileCompositionPlanAudioSchedule(composition);
  const base = bindCompositionPlanAudioInputs(schedule, mix.musicGain === null ? {} : { music: { sourceRef: "music:bed", path: files.music } });
  const audio: BoundCompositionAudioRenderRequest = {
    ...base,
    source: { ...base.source, gain: 1 },
    music: base.music ? { ...base.music, gain: mix.musicGain ?? 0 } : null,
    soundEffects: (mix.sfx ?? []).map((placement, index) => ({
      id: `sfx-${index}`, sourceRef: `sfx:${index}`, activeRange: { startSec: placement.startSec, endSec: 3 }, gain: placement.gain, path: files.sfx[index]!,
    })),
  };
  const outputPath = join(directory, `out-${name}.mp4`);
  const compile = (mixPeakCeiling: number | null) => compileClipCompositionCommand({
    sourcePath: files.source, outputPath, startSec: 0, endSec: 3, source: inspection, plan: composition, targetId: "vertical", audio,
    encoder: { preset: "ultrafast", crf: "24" },
    ...(mixPeakCeiling === null ? {} : { mixPeakCeiling }),
    assets: { subtitlePath: null, ...(mix.scene ? { scenes: { [sceneRef]: { path: files.scene, kind: "video" as const, hasAudio: true } } } : {}) },
  });
  const encodedArgs = compile(null);
  await ffmpeg(encodedArgs);
  const firstPass = join(directory, `first-${name}.mp4`);
  await copyFile(outputPath, firstPass);
  let corrective = 0;
  let compiledLimited = 0;
  const result = await guardMixPeak({
    audio, outputPath,
    limitedArgs: (ceiling) => { compiledLimited += 1; return compile(ceiling); },
    measureStdout: async (args) => (await run("ffmpeg", args)).stdout.toString("utf8"),
    execute: async (args) => { corrective += 1; await ffmpeg(args); },
  });
  return { result, outputPath, firstPass, corrective, compiledLimited, encodedArgs, limitedArgs: compile(0.95) };
}

async function decode(path: string) {
  const decoded = await run("ffmpeg", ["-v", "error", "-i", path, "-map", "0:a:0", "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1"]);
  const view = new DataView(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength);
  const samples = new Float32Array(view.byteLength / 4);
  for (let index = 0; index < samples.length; index++) samples[index] = view.getFloat32(index * 4, true);
  return samples;
}

/** Left channel of decoded stereo (every output here is stereo). */
const left = (interleaved: Float32Array) => interleaved.filter((_, index) => index % 2 === 0);

const peakOf = (samples: Float32Array) => samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);

/** Lag in samples that best aligns `b` onto `a` over a mid-clip window. */
function lagSamples(a: Float32Array, b: Float32Array): number {
  const from = Math.round(0.4 * RATE);
  const length = Math.round(0.5 * RATE);
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let lag = -200; lag <= 200; lag++) {
    let score = 0;
    for (let index = from; index < from + length; index++) score += a[index]! * (b[index + lag] ?? 0);
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  return best;
}

async function frameCount(path: string) {
  const probe = JSON.parse(new TextDecoder().decode((await run("ffprobe", [
    "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "json", path,
  ])).stdout));
  return Number(probe.streams[0].nb_read_frames);
}

describe("corrective mix limiter on real renders", () => {
  async function expectCorrected(name: string, mix: Mix, dialoguePeak = 0.9) {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-mix-limiter-", async (directory) => {
      const files = await fixture(directory, { dialoguePeak, withScene: Boolean(mix.scene) });
      const rendered = await renderMix(directory, name, files, mix);

      // The first pass really clipped, so the guard had to act.
      const before = await decode(rendered.firstPass);
      expect(peakOf(before)).toBeGreaterThan(1);
      expect(rendered.result?.outcome).toBe("limited");
      expect(rendered.corrective).toBe(1);

      // Decoded sample and true peak of what would be uploaded are at or under full scale.
      const after = await decode(rendered.outputPath);
      expect(peakOf(after)).toBeLessThanOrEqual(1);
      const independent = parseMixPeakMetadata((await run("ffmpeg", [
        "-v", "error", "-i", rendered.outputPath, "-map", "0:a:0", "-af",
        "astats=metadata=1:reset=0:measure_perchannel=none:measure_overall=Max_level+Min_level,ebur128=metadata=1:peak=true,ametadata=mode=print:file=-",
        "-f", "null", "-",
      ])).stdout.toString("utf8"));
      expect(independent.samplePeak).toBeLessThanOrEqual(1);
      expect(independent.truePeak).toBeLessThanOrEqual(1);
      expect(rendered.result?.measured).toEqual(independent);

      // Nothing else moved: same length, same picture, dialogue on the same sample.
      expect(after.length).toBe(before.length);
      expect(lagSamples(left(before), left(after))).toBe(0);
      expect(await frameCount(rendered.outputPath)).toBe(await frameCount(rendered.firstPass));
      return rendered;
    });
  }

  test("hot dialogue plus hot music", async () => {
    await expectCorrected("music", { musicGain: 1 });
  }, 60_000);

  test("hot dialogue plus several overlapping sound effects, no music", async () => {
    await expectCorrected("sfx", { musicGain: null, sfx: [{ startSec: 0.6, gain: 1 }, { startSec: 0.8, gain: 1 }, { startSec: 1, gain: 1 }] });
  }, 60_000);

  test("dialogue, music and sound effects together", async () => {
    await expectCorrected("everything", { musicGain: 1, sfx: [{ startSec: 0.7, gain: 1 }, { startSec: 1.1, gain: 1 }] });
  }, 60_000);

  test("hot inserted-scene audio over music", async () => {
    await expectCorrected("scene", { musicGain: 1, scene: true, sfx: [{ startSec: 0.9, gain: 1 }] });
  }, 60_000);

  test("the limiter touches only the loud passages", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-mix-limiter-", async (directory) => {
      const files = await fixture(directory, { dialoguePeak: 0.8, withScene: false });
      // Late effects: before they start, dialogue + music alone stay under full scale.
      const rendered = await renderMix(directory, "late-sfx", files, { musicGain: 0.05, sfx: [{ startSec: 2, gain: 1 }, { startSec: 2.1, gain: 1 }] });
      const before = await decode(rendered.firstPass);
      const after = await decode(rendered.outputPath);
      const quiet = (samples: Float32Array) => samples.subarray(Math.round(0.6 * RATE) * 2, Math.round(1.8 * RATE) * 2);
      expect(peakOf(quiet(before))).toBeLessThan(0.95);
      expect(quiet(after)).toEqual(quiet(before));
    });
  }, 60_000);

  test("a mix that fits keeps its exact command and PCM", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-mix-limiter-", async (directory) => {
      const files = await fixture(directory, { dialoguePeak: 0.3, withScene: false });
      const rendered = await renderMix(directory, "normal", files, { musicGain: 0.2, sfx: [{ startSec: 0.8, gain: 0.3 }] });
      expect(rendered.result?.outcome).toBe("within_full_scale");
      expect(rendered.corrective).toBe(0);
      expect(rendered.compiledLimited).toBe(0);
      expect(rendered.encodedArgs.join(" ")).not.toContain("alimiter");
      expect(await decode(rendered.outputPath)).toEqual(await decode(rendered.firstPass));
      // The corrective graph differs from the original only by the limiter stage.
      expect(rendered.limitedArgs.join(" ").replace("apad=pad_dur=0.005,alimiter=limit=0.950:level=disabled,atrim=start=0.004972,asetpts=PTS-STARTPTS,", "")).toBe(rendered.encodedArgs.join(" "));
    });
  }, 60_000);
});
