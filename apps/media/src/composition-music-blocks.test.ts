import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { planClipComposition } from "@narriflow/composition-plan";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import {
  bindCompositionPlanAudioInputs,
  compileClipCompositionCommand,
  compileCompositionPlanAudioSchedule,
} from "./composition-ffmpeg-adapter";
import { scenarioProbe } from "./composition-dub-fixture";
import { productionWorkerProcessModule } from "./worker-process";

const CLIP_SEC = 10;

/** Block A: an intro with fades and an in-point, starting mid-clip. Block B: a
 *  null-end bed that runs to the clip end. Speech at 7.0s drives ducking. */
function planTwoBlocks(ducking: boolean) {
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      version: 1, clipStartSec: 0, clipEndSec: CLIP_SEC,
      captionPreset: captionPresetSchema.parse({ visible: false }),
      transcriptSlice: [{
        index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 7, endSec: 7.5,
        text: "Speech", confidence: 1,
        words: [{ word: "Speech", startSec: 7, endSec: 7.5, confidence: 1 }],
      }],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "center" },
        sourceAudio: { muted: true },
        music: {
          ducking,
          blocks: [
            { id: "intro", url: "https://example.com/a.wav", startSec: 2, endSec: 6, sourceStartSec: 1.5, volume: 50, fadeInSec: 1, fadeOutSec: 0.5 },
            { id: "bed", url: "https://example.com/b.wav", startSec: 6, endSec: null, volume: 20 },
          ],
        },
      }),
      brollUrl: null, deletedRanges: [],
    }),
    source: { identity: "source:music-blocks", kind: "video", width: 90, height: 160, hasAudio: true },
    evidence: { automaticLayout: { state: "missing" } },
    assets: {
      backgroundImage: { state: "missing" },
      music: {
        intro: { state: "available", ref: "music:intro", durationSec: 3 },
        bed: { state: "available", ref: "music:bed", durationSec: 5 },
      },
    },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

const bind = (plan: ReturnType<typeof planTwoBlocks>, introPath: string, bedPath: string) =>
  bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(plan), {
    music: [
      { id: "intro", sourceRef: "music:intro", path: introPath },
      { id: "bed", sourceRef: "music:bed", path: bedPath },
    ],
  });

describe("music block audio filter", () => {
  const plan = planTwoBlocks(true);
  const probe = scenarioProbe({ builder: "single" });
  const args = compileClipCompositionCommand({
    sourcePath: "/tmp/source.mp4", outputPath: "/tmp/output.mp4", startSec: 0, endSec: CLIP_SEC, source: probe, plan, targetId: "vertical",
    audio: bind(plan, "/tmp/intro.wav", "/tmp/bed.wav"),
    encoder: { preset: "veryfast", crf: "21" }, assets: { subtitlePath: null },
  });
  const graph = args[args.indexOf("-filter_complex") + 1]!;
  const branch = (label: string) => graph.split(";").find((part) => part.endsWith(label))!;

  test("every block gets its own looped input, in timeline order", () => {
    const pairs = args.flatMap((value, index) => (value === "-stream_loop" ? [args.slice(index, index + 4).join(" ")] : []));
    expect(pairs).toEqual(["-stream_loop -1 -i /tmp/intro.wav", "-stream_loop -1 -i /tmp/bed.wav"]);
  });

  test("a faded block fades block-relative before adelay, then pads and trims to the clip", () => {
    const intro = branch("[music0a]");
    const head =
      "[1:a]atrim=start=1.500:duration=4.000,asetpts=PTS-STARTPTS,volume=0.500,afade=t=in:st=0:d=1.000,afade=t=out:st=3.500:d=0.500,adelay=2000:all=1,asetpts=N/SR/TB,apad,atrim=duration=10.000";
    expect(intro.startsWith(`${head},volume='`)).toBe(true);
    // Without ducking the same branch ends at the clip trim.
    expect(branch("[music0a]")).not.toBe(`${head}[music0a]`);
    const quiet = planTwoBlocks(false);
    const quietArgs = compileClipCompositionCommand({
      sourcePath: "/tmp/source.mp4", outputPath: "/tmp/output.mp4", startSec: 0, endSec: CLIP_SEC, source: probe, plan: quiet, targetId: "vertical",
      audio: bind(quiet, "/tmp/intro.wav", "/tmp/bed.wav"),
      encoder: { preset: "veryfast", crf: "21" }, assets: { subtitlePath: null },
    });
    const quietGraph = quietArgs[quietArgs.indexOf("-filter_complex") + 1]!;
    expect(quietGraph.split(";")).toContain(`${head}[music0a]`);
    expect(quietGraph).not.toContain("eval=frame");
  });

  test("a null-end bed runs to the clip end and ducks in clip time after adelay", () => {
    const bed = branch("[music1a]");
    expect(bed.startsWith("[2:a]atrim=start=0.000:duration=4.000,asetpts=PTS-STARTPTS,volume=0.200,adelay=6000:all=1,asetpts=N/SR/TB,apad,atrim=duration=10.000,volume='")).toBe(true);
    expect(bed.endsWith("':eval=frame[music1a]")).toBe(true);
    // Ducking is the last stage: after the delay, pad and clip trim.
    expect(bed.indexOf("adelay=")).toBeLessThan(bed.indexOf("apad"));
    expect(bed.indexOf("apad")).toBeLessThan(bed.indexOf("atrim=duration=10.000"));
    expect(bed.indexOf("atrim=duration=10.000")).toBeLessThan(bed.indexOf("volume='"));
    // Fades (none on this block) and gain stay ahead of the delay.
    expect(bed.indexOf("volume=0.200")).toBeLessThan(bed.indexOf("adelay="));
    // The speech at 7.0s ducks around clip time 7, not around 7 - 6 (block time).
    expect(bed).toMatch(/between\(t,6\.\d+,/);
  });

  test("both blocks join the mix unnormalized", () => {
    // Muted source dialogue is still the first mix input.
    expect(graph).toContain("[maina][music0a][music1a]amix=inputs=3:duration=first:dropout_transition=0:normalize=0");
  });

  test("every block carries the same clip-wide ducking expression", () => {
    const expression = (label: string) => /volume='([^']*)':eval=frame/.exec(branch(label))![1];
    expect(expression("[music0a]")).toBe(expression("[music1a]"));
  });
});

describe("music blocks through real ffmpeg", () => {
  test("two blocks mix to exactly the clip duration with silence outside them", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-music-blocks-", async (directory) => {
      const signal = new AbortController().signal;
      const execute = (extra: string[]) => productionWorkerProcessModule.execute({
        command: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-y", ...extra],
        signal, deadlineMs: 20_000, captureStdout: true,
      });
      const sourcePath = join(directory, "source.mp4");
      const introPath = join(directory, "intro.wav");
      const bedPath = join(directory, "bed.wav");
      const outputPath = join(directory, "output.mp4");
      await execute([
        "-f", "lavfi", "-i", `color=blue:s=90x160:r=30:d=${CLIP_SEC}`,
        "-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono:d=${CLIP_SEC}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", sourcePath,
      ]);
      // Tracks shorter than their blocks, so the loop and the in-point both matter.
      await execute(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", introPath]);
      await execute(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=5", bedPath]);
      const plan = planTwoBlocks(true);
      const source = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 5_000 });
      await execute(compileClipCompositionCommand({
        sourcePath, outputPath, startSec: 0, endSec: CLIP_SEC, source, plan, targetId: "vertical",
        audio: bind(plan, introPath, bedPath),
        encoder: { preset: "ultrafast", crf: "24" }, assets: { subtitlePath: null },
      }));

      const decoded = await execute(["-i", outputPath, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
      const samples = new DataView(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength);
      const durationSec = samples.byteLength / 4 / 48000;
      // Output duration is the clip duration (AAC priming adds at most a frame).
      expect(Math.abs(durationSec - CLIP_SEC)).toBeLessThan(0.1);
      const rms = (startSec: number, endSec: number) => {
        const start = Math.floor(startSec * 48000);
        const end = Math.floor(endSec * 48000);
        let squareSum = 0;
        for (let sample = start; sample < end; sample++) squareSum += samples.getFloat32(sample * 4, true) ** 2;
        return Math.sqrt(squareSum / (end - start));
      };
      expect(rms(0.2, 1.8)).toBeLessThan(0.005); // before the intro block
      expect(rms(3.5, 5.0)).toBeGreaterThan(0.035); // intro at block gain 0.5 (lavfi sine is 1/8 full scale: rms 0.044)
      expect(rms(6.2, 6.6)).toBeGreaterThan(0.012); // bed (gain 0.2: rms 0.018) starts where the intro ends
      expect(rms(8.5, 9.8)).toBeGreaterThan(0.012); // bed runs to the clip end
      expect(rms(8.5, 9.8)).toBeLessThan(rms(3.5, 5.0)); // bed 0.2 vs intro 0.5
      // Ducking sits on the speech at 7.0s in clip time, not in block time.
      expect(rms(7.1, 7.4)).toBeLessThan(rms(8.5, 9.8) * 0.6);
    });
  }, 60_000);
});

describe("music schedule float tolerance", () => {
  test("overlapping fades scaled to a short block compile despite ulp drift", () => {
    // The reviewer's measured case: start + fadeIn' and start + (D - fadeOut')
    // are equal on paper but differ by one ulp.
    const result = planClipComposition({
      document: editorDocumentSchema.parse({
        version: 1, clipStartSec: 0, clipEndSec: CLIP_SEC,
        captionPreset: captionPresetSchema.parse({ visible: false }),
        transcriptSlice: [],
        studioEdits: studioEditsSchema.parse({
          framing: { mode: "center" },
          music: {
            blocks: [{
              id: "short",
              url: "https://example.com/a.wav",
              startSec: 0.27155882206349347,
              endSec: 2.079967477176548,
              fadeInSec: 0.9,
              fadeOutSec: 1.6,
            }],
          },
        }),
        brollUrl: null, deletedRanges: [],
      }),
      source: { identity: "source:music-short", kind: "video", width: 90, height: 160, hasAudio: true },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" }, music: { short: { state: "available", ref: "music:short", durationSec: 3 } } },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(() => compileCompositionPlanAudioSchedule(result.plan)).not.toThrow();
  });
});
