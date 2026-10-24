import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planClipComposition } from "@narriflow/composition-plan";
import {
  buildCaptionedVideoSettings,
  captionedVideoFramingEdits,
  captionPresetSchema,
  clipAspectRatioOptions,
  editorDocumentSchema,
  fitSuppliedUtterances,
  planTranscript,
  studioEditsSchema,
  type ClipAspectRatio,
  type SourceProbe,
  type TranscriptUtterance,
} from "@narriflow/validators";
import {
  bindCompositionPlanAudioInputs,
  compileClipCompositionCommand,
  compileCompositionPlanAudioSchedule,
  compileCompositionPlanCaptions,
} from "../composition-ffmpeg-adapter";

/** Captioned videos through the production render command and real FFmpeg:
 * silent, speech, and supplied-caption sources at each requested format. */

const DURATION_SEC = 3;
const SUPPLIED_SRT = "1\n00:00:00,300 --> 00:00:01,600\nAn AI short\n\n2\n00:00:01,700 --> 00:00:02,900\nneeds captions too";
const SPOKEN: TranscriptUtterance[] = [{
  index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 0.3, endSec: 2.9, text: "Spoken words become captions", confidence: 0.9,
  words: [["Spoken", 0.3, 0.8], ["words", 0.9, 1.4], ["become", 1.5, 2.1], ["captions", 2.2, 2.9]].map(([word, startSec, endSec]) => ({ word: word as string, startSec: startSec as number, endSec: endSec as number, confidence: 0.9 })),
}];

let directory = "";
const sources = { silent: "", speech: "", portraitSilent: "" };

async function run(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, stdout, stderr };
}

async function generate(name: string, inputs: string[]) {
  const path = join(directory, `${name}.mp4`);
  const result = await run("ffmpeg", ["-v", "error", "-y", ...inputs, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...(inputs.includes("sine=frequency=440:duration=3") ? ["-c:a", "aac"] : []), "-t", String(DURATION_SEC), path]);
  expect(result.code, result.stderr).toBe(0);
  return path;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "narriflow-captioned-video-"));
  // Landscape and portrait sources made from lavfi: a silent one, and one with a tone for speech.
  sources.silent = await generate("silent", ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=3"]);
  sources.speech = await generate("speech", ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3"]);
  sources.portraitSilent = await generate("portrait", ["-f", "lavfi", "-i", "testsrc2=size=180x320:rate=24:duration=3"]);
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

interface Stream { codec_type: string; width?: number; height?: number }
async function inspect(path: string) {
  const result = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
  expect(result.code, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout) as { streams: Stream[]; format: { duration: string } };
  return { video: parsed.streams.find((stream) => stream.codec_type === "video"), audio: parsed.streams.find((stream) => stream.codec_type === "audio"), durationSec: Number(parsed.format.duration) };
}

/** A raw RGB frame at `atSec`, to compare what a render drew. */
async function frame(path: string, atSec: number, filter = "null") {
  const child = Bun.spawn(["ffmpeg", "-v", "error", "-ss", String(atSec), "-i", path, "-frames:v", "1", "-vf", filter, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { stdout: "pipe", stderr: "pipe" });
  const [bytes, stderr] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
  expect(await child.exited, stderr).toBe(0);
  return new Uint8Array(bytes);
}

interface RenderInput {
  source: string; probe: { width: number; height: number; hasAudio: boolean };
  framing: "fit" | "center"; ratio: ClipAspectRatio; transcript: TranscriptUtterance[]; label: string;
}

/** The production path: plan, bind audio, write the shared ASS cues, compile the one command, run it. */
async function render(input: RenderInput) {
  const option = clipAspectRatioOptions.find((candidate) => candidate.value === input.ratio)!;
  // The 720p treatment keeps the real encodes small.
  const canvas = { width: option.width, height: option.height };
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      version: 1, clipStartSec: 0, clipEndSec: DURATION_SEC,
      captionPreset: captionPresetSchema.parse({ visible: input.transcript.length > 0 }),
      transcriptSlice: input.transcript,
      studioEdits: studioEditsSchema.parse(captionedVideoFramingEdits(input.framing)),
      brollUrl: null, deletedRanges: [],
    }),
    source: { identity: `source:${input.label}`, kind: "video", width: input.probe.width, height: input.probe.height, hasAudio: input.probe.hasAudio },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "target", aspectRatio: input.ratio, ...canvas, outputTreatment: { resolution: "720p", watermark: false } }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  const subtitlePath = input.transcript.length > 0 ? join(directory, `${input.label}.ass`) : null;
  if (subtitlePath) await writeFile(subtitlePath, compileCompositionPlanCaptions(result.plan, "target"));
  const outputPath = join(directory, `${input.label}.out.mp4`);
  const args = compileClipCompositionCommand({
    sourcePath: input.source, outputPath, startSec: 0, endSec: DURATION_SEC,
    source: { hasVideo: true, hasAudio: input.probe.hasAudio, hasVisualStream: true, width: input.probe.width, height: input.probe.height, durationSec: DURATION_SEC, fps: 24 },
    plan: result.plan, targetId: "target",
    audio: bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(result.plan), { music: null, soundEffects: [] }),
    encoder: { preset: "ultrafast", crf: "30" },
    assets: { subtitlePath },
  });
  const ffmpeg = await run("ffmpeg", ["-v", "warning", "-y", ...args.filter((arg) => arg !== "-y")]);
  expect(ffmpeg.code, ffmpeg.stderr).toBe(0);
  // A render that silently drops text still exits 0, so the diagnostics are part of the contract.
  expect(ffmpeg.stderr).not.toMatch(/drawtext/i);
  expect(ffmpeg.stderr).not.toMatch(/error/i);
  // The 720p treatment scales the 1080-short-side canvas by two thirds at encode.
  const planned = result.plan.targets[0]!.canvas;
  return { path: outputPath, args, canvas: { width: Math.round(planned.width * 2 / 3), height: Math.round(planned.height * 2 / 3) } };
}

const silentProbe = { width: 320, height: 180, hasAudio: false };
const speechProbe = { width: 320, height: 180, hasAudio: true };
const ALL_RATIOS: ClipAspectRatio[] = ["9:16", "1:1", "16:9", "4:5"];

describe("captioned video render through real FFmpeg", () => {
  test("a silent video exports uncaptioned at every requested ratio with no audio track", async () => {
    for (const ratio of ALL_RATIOS) {
      const out = await render({ source: sources.silent, probe: silentProbe, framing: "fit", ratio, transcript: [], label: `silent-${ratio.replace(":", "x")}` });
      const media = await inspect(out.path);
      expect(`${ratio} ${media.video?.width}x${media.video?.height}`).toBe(`${ratio} ${out.canvas.width}x${out.canvas.height}`);
      expect(media.audio, `${ratio}: silent output must carry no audio stream`).toBeUndefined();
      expect(media.durationSec).toBeGreaterThan(DURATION_SEC - 0.3);
      expect(media.durationSec).toBeLessThan(DURATION_SEC + 0.3);
      expect(out.args).toContain("-an");
    }
  }, 120_000);

  test("a speech video keeps its audio and burns the spoken words in at every ratio", async () => {
    for (const ratio of ALL_RATIOS) {
      const label = `speech-${ratio.replace(":", "x")}`;
      const captioned = await render({ source: sources.speech, probe: speechProbe, framing: "fit", ratio, transcript: SPOKEN, label });
      const plain = await render({ source: sources.speech, probe: speechProbe, framing: "fit", ratio, transcript: [], label: `${label}-plain` });
      const media = await inspect(captioned.path);
      expect(media.audio?.codec_type).toBe("audio");
      expect(`${media.video?.width}x${media.video?.height}`).toBe(`${captioned.canvas.width}x${captioned.canvas.height}`);
      expect(plain.args).not.toContain("-an");
      expect(await frame(captioned.path, 1), `${ratio}: captions must change the frame`).not.toEqual(await frame(plain.path, 1));
      // Before the first word there is nothing to draw: the two renders agree.
      expect(await frame(captioned.path, 0.1)).toEqual(await frame(plain.path, 0.1));
    }
  }, 180_000);

  test("supplied captions are normalized once and burn in at every ratio, on a silent video", async () => {
    const settings = buildCaptionedVideoSettings({ aspectRatios: ALL_RATIOS, captions: { source: "supplied", text: SUPPLIED_SRT } });
    const plan = planTranscript({ captionedVideo: settings, sourceProbe: null });
    if (plan.kind !== "supplied") throw new Error("expected supplied captions");
    const transcript = fitSuppliedUtterances(plan.utterances, DURATION_SEC);
    expect(transcript.map((utterance) => utterance.text)).toEqual(["An AI short", "needs captions too"]);
    for (const ratio of ALL_RATIOS) {
      const label = `supplied-${ratio.replace(":", "x")}`;
      const captioned = await render({ source: sources.silent, probe: silentProbe, framing: "fit", ratio, transcript, label });
      const plain = await render({ source: sources.silent, probe: silentProbe, framing: "fit", ratio, transcript: [], label: `${label}-plain` });
      const media = await inspect(captioned.path);
      expect(media.audio).toBeUndefined();
      expect(await frame(captioned.path, 1), `${ratio}: supplied captions must change the frame`).not.toEqual(await frame(plain.path, 1));
      expect(await frame(captioned.path, 0.1)).toEqual(await frame(plain.path, 0.1));
    }
  }, 180_000);

  test("Fit keeps the whole frame; Center fills the frame with a cover crop", async () => {
    const edge = async (framing: "fit" | "center", source: string, probe: { width: number; height: number; hasAudio: boolean }) => {
      const out = await render({ source, probe, framing, ratio: "9:16", transcript: [], label: `framing-${framing}-${probe.width}` });
      const pixels = await frame(out.path, 1);
      // Mean brightness of the first rows: black bars when padded, source content when cropped.
      const row = out.canvas.width * 3 * 8;
      return pixels.slice(0, row).reduce((sum, value) => sum + value, 0) / row;
    };
    expect(await edge("fit", sources.silent, silentProbe), "Fit pads a landscape source into 9:16").toBeLessThan(2);
    expect(await edge("center", sources.silent, silentProbe), "Center crops it to fill").toBeGreaterThan(20);
    // A source that already has the target shape is unchanged by either framing.
    const portrait = { width: 180, height: 320, hasAudio: false };
    expect(await edge("fit", sources.portraitSilent, portrait)).toBeGreaterThan(20);
    expect(await edge("center", sources.portraitSilent, portrait)).toBeGreaterThan(20);
  }, 120_000);

  test("an 8-second source and a 3-minute source both plan a renderable whole-source command", () => {
    for (const durationSec of [8, 180]) {
      const probe: SourceProbe = { durationSec, video: { width: 1080, height: 1920, frameRate: { numerator: 24, denominator: 1 }, startTimecode: null }, audio: null };
      const result = planClipComposition({
        document: editorDocumentSchema.parse({ version: 1, clipStartSec: 0, clipEndSec: durationSec, captionPreset: captionPresetSchema.parse({ visible: false }),
          transcriptSlice: [], studioEdits: studioEditsSchema.parse(captionedVideoFramingEdits("fit")), brollUrl: null, deletedRanges: [] }),
        source: { identity: "source:long", kind: "video", width: probe.video!.width, height: probe.video!.height, hasAudio: false },
        evidence: { automaticLayout: { state: "missing" } }, assets: { backgroundImage: { state: "missing" } },
        capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
        targets: [{ id: "target", aspectRatio: "9:16", width: 1080, height: 1920 }],
      });
      expect(result.status).toBe("ready");
      if (result.status === "invalid") continue;
      expect(result.plan.editedDurationSec).toBe(durationSec);
    }
  });
});
