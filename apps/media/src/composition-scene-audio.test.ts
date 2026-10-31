import { expect, test } from "bun:test";
import { join } from "node:path";
import { compositionAssetRef, planClipComposition } from "@narriflow/composition-plan";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import {
  bindCompositionPlanAudioInputs,
  compileClipCompositionCommand,
  compileCompositionPlanAudioSchedule,
} from "./composition-ffmpeg-adapter";
import { productionWorkerProcessModule } from "./worker-process";

test.each([
  { mode: "video", muted: true, music: false },
  { mode: "video", muted: false, music: true },
  { mode: "broll", muted: true, music: true },
  { mode: "audiogram", muted: true, music: false },
  { mode: "silent-video", muted: true, music: true },
  { mode: "short-audio", muted: true, music: false },
])("$mode preserves inserted video audio independently of source mute and volume", async ({ mode, muted, music }) => {
  await productionWorkerProcessModule.withScratchDirectory("narriflow-scene-audio-", async (directory) => {
    const signal = new AbortController().signal;
    const execute = (args: string[]) => productionWorkerProcessModule.execute({
      command: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-y", ...args],
      signal, deadlineMs: 15_000, captureStdout: true,
    });
    const videoPath = join(directory, "source.mp4");
    const audioPath = join(directory, "source.wav");
    const scenePath = join(directory, "scene.mp4");
    const musicPath = join(directory, "music.wav");
    const outputPath = join(directory, "output.mp4");
    await execute([
      "-f", "lavfi", "-i", "color=blue:s=90x160:r=10:d=2",
      ...(mode === "silent-video" ? [] : ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${mode === "short-audio" ? 0.4 : 2}`]),
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", videoPath,
    ]);
    await execute(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", audioPath]);
    await execute([
      "-f", "lavfi", "-i", "color=red:s=90x160:r=10:d=1",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", scenePath,
    ]);
    if (music) await execute(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=3", musicPath]);
    const assetId = "9e2af81d-8a41-4404-af89-b560f9c4eb98";
    const fingerprint = "a".repeat(64);
    const sceneRef = compositionAssetRef("visual_asset", `${assetId}:${fingerprint}`);
    const sourcePath = mode === "audiogram" ? audioPath : videoPath;
    const inspection = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 5_000 });
    const result = planClipComposition({
      document: editorDocumentSchema.parse({
        version: 1, clipStartSec: 0, clipEndSec: 2,
        captionPreset: captionPresetSchema.parse({ visible: false }), transcriptSlice: [], deletedRanges: [],
        studioEdits: studioEditsSchema.parse({
          framing: { mode: "center" }, sourceAudio: { muted, volume: 25 },
          ...(music ? { music: { url: "https://example.com/music.wav", volume: 20, ducking: false, fadeInSec: 0, fadeOutSec: 0 } } : {}),
        }),
        brollUrl: mode === "broll" ? "https://example.com/cutaway.mp4" : null,
        sceneBlocks: [{
          schemaVersion: 1, id: "8ab9d330-688f-4574-932c-27ac661245c1", anchorSec: 1, durationSec: 1,
          content: { kind: "video", asset: { kind: "visual_asset", id: assetId, fingerprint }, sourceStartSec: 0, sourceEndSec: 1, muted: false, volume: 50, fit: "cover", backgroundColor: "#000000" },
          motion: { entrance: "none", exit: "none" }, templateSnapshot: null,
        }],
      }),
      source: { identity: "source:scene-audio", kind: mode === "audiogram" ? "audio" : "video", width: inspection.width, height: inspection.height, hasAudio: inspection.hasAudio },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        ...(music ? { music: { state: "available", ref: "music:bed", durationSec: 3 } } as const : {}),
        ...(mode === "broll" ? { broll: { state: "available", placements: [{ id: "cutaway", ref: "broll:clip", startSec: 0, endSec: 0.5 }] } } as const : {}),
      },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: mode === "audiogram" ? 1080 : 90, height: mode === "audiogram" ? 1920 : 160 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);
    await execute(compileClipCompositionCommand({
      sourcePath, outputPath, startSec: 0, endSec: 2, source: inspection, plan: result.plan, targetId: "vertical",
      audio: bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(result.plan), music ? { music: { sourceRef: "music:bed", path: musicPath } } : {}),
      encoder: { preset: "ultrafast", crf: "24" },
      assets: { subtitlePath: null, scenes: { [sceneRef]: { path: scenePath, kind: "video", hasAudio: true } }, ...(mode === "broll" ? { broll: { "broll:clip": videoPath } } : {}) },
    }));
    const decoded = await execute(["-i", outputPath, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
    const samples = new DataView(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength);
    expect(samples.byteLength / 4 / 48000).toBeGreaterThan(2.9);
    const amplitude = (frequency: number, startSec: number, endSec: number) => {
      const start = Math.round(startSec * 48000);
      const end = Math.min(Math.round(endSec * 48000), samples.byteLength / 4);
      let real = 0;
      let imaginary = 0;
      for (let index = start; index < end; index++) {
        const value = samples.getFloat32(index * 4, true);
        const angle = 2 * Math.PI * frequency * index / 48000;
        real += value * Math.cos(angle);
        imaginary += value * Math.sin(angle);
      }
      return 2 * Math.hypot(real, imaginary) / (end - start);
    };
    // FFmpeg's sine source has amplitude 1/8. Only the Scene's own 50% gain applies.
    expect(amplitude(880, 1.2, 1.8)).toBeCloseTo(0.0625, 2);
    expect(amplitude(440, 0.2, 0.8)).toBeCloseTo(muted ? 0 : 0.03125, 2);
    expect(amplitude(440, 2.2, 2.8)).toBeCloseTo(muted ? 0 : 0.03125, 2);
    if (music) expect(amplitude(220, 1.2, 1.8)).toBeCloseTo(0.025, 2);
  });
}, 30_000);
