import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automaticLayoutInputFingerprint,
  interpolateCompositionCropTrack,
  planClipComposition,
  type CompositionSourceVideoLayer,
} from "@narriflow/composition-plan";
import {
  CLIP_AUTO_LAYOUT_ENGINE,
  CLIP_AUTO_LAYOUT_VERSION,
  captionPresetSchema,
  clipAutoLayoutAnalysisSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import { compileCompositionPlanVideo } from "./composition-ffmpeg-adapter";
import { productionWorkerProcessModule } from "./worker-process";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("tracked two-up uses the final scene clock across an inserted block in actual FFmpeg output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "narriflow-tracked-insert-"));
  directories.push(directory);
  const sourcePath = join(directory, "source.mp4");
  const outputPath = join(directory, "output.mp4");
  const graphPath = join(directory, "graph.ffgraph");
  const signal = new AbortController().signal;
  const execute = (args: string[]) => productionWorkerProcessModule.execute({ command: "ffmpeg", args, signal, deadlineMs: 10_000, captureStdout: true });
  await execute([
    "-y", "-f", "lavfi", "-i",
    "color=black:s=320x180:r=24,drawbox=x=0:y=0:w=107:h=180:c=red:t=fill,drawbox=x=107:y=0:w=106:h=180:c=green:t=fill,drawbox=x=213:y=0:w=107:h=180:c=blue:t=fill",
    "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourcePath,
  ]);
  const sourceIdentity = "source:tracked-insert";
  const analysis = clipAutoLayoutAnalysisSchema.parse({
    version: CLIP_AUTO_LAYOUT_VERSION, engine: CLIP_AUTO_LAYOUT_ENGINE, sourceIdentity,
    analyzedAtISO: "2026-10-04T00:00:00.000Z", clipStartSec: 0, clipEndSec: 5,
    deletedRanges: [], editedDurationSec: 5, sourceWidth: 320, sourceHeight: 180,
    segments: [{
      startSec: 0, endSec: 5, layout: "two-up", topCxNorm: 0.25, bottomCxNorm: 0.75,
      topCyNorm: 0.5, bottomCyNorm: 0.5, topZoom: 1.1, bottomZoom: 1.1,
      topCropTrack: [{ timeSec: 0, cxNorm: 0.25, cyNorm: 0.5 }, { timeSec: 2, cxNorm: 0.75, cyNorm: 0.5 }, { timeSec: 5, cxNorm: 0.75, cyNorm: 0.5 }],
      bottomCropTrack: [{ timeSec: 0, cxNorm: 0.75, cyNorm: 0.5 }, { timeSec: 2, cxNorm: 0.25, cyNorm: 0.5 }, { timeSec: 5, cxNorm: 0.25, cyNorm: 0.5 }],
      subjects: [{ id: "left", cxNorm: 0.25, cyNorm: 0.5, zoom: 1.1 }, { id: "right", cxNorm: 0.75, cyNorm: 0.5, zoom: 1.1 }],
    }],
    noSplitSegments: [{ startSec: 0, endSec: 5, layout: "single", intent: "fit", cxNorm: 0.5, cyNorm: 0.5, zoom: 1, subjects: [] }],
    shotCount: 1, soloShotCount: 0, multiShotCount: 1, twoUpSegmentCount: 1, speakerCount: 0, mappedSpeakerCount: 0,
  });
  const document = editorDocumentSchema.parse({
    version: 2, clipStartSec: 0, clipEndSec: 5,
    captionPreset: captionPresetSchema.parse({ visible: false }), transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }), brollUrl: null, deletedRanges: [],
    sceneBlocks: [{ id: "38784fe0-1640-4079-ad09-7f88ab9da720", schemaVersion: 1, anchorSec: 1, durationSec: 1, content: { kind: "color", color: "#000000" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null }],
  });
  const result = planClipComposition({
    document, source: { identity: sourceIdentity, kind: "video", width: 320, height: 180 },
    evidence: { automaticLayout: { state: "available", value: {
      sourceIdentity, inputFingerprint: automaticLayoutInputFingerprint({ sourceIdentity, clipStartSec: 0, clipEndSec: 5, deletedRanges: [], engineVersion: CLIP_AUTO_LAYOUT_ENGINE }),
      engineVersion: CLIP_AUTO_LAYOUT_ENGINE, analysis,
    } } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: CLIP_AUTO_LAYOUT_ENGINE },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  const plan = result.plan;
  const target = plan.targets[0]!;
  expect(plan.editedDurationSec).toBe(6);
  const compiled = compileCompositionPlanVideo({ plan, targetId: target.id, videoInputLabel: "[0:v]", outputLabel: "[outv]", fps: 24 });
  await writeFile(graphPath, compiled.filterParts.join(";"));
  await execute(["-y", "-i", sourcePath, "-filter_complex_script", graphPath, "-map", "[outv]", "-c:v", "libx264", "-pix_fmt", "yuv420p", outputPath]);
  const pixelAt = async (timeSec: number, y: number) => {
    const output = await execute(["-v", "error", "-i", outputPath, "-ss", timeSec.toFixed(3), "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "pipe:1"]);
    const offset = (y * 90 + 45) * 3;
    return [...output.stdout.subarray(offset, offset + 3)];
  };
  for (const [timeSec, expectedTop, expectedBottom] of [[0.1, "red", "blue"], [0.9, "green", "green"], [2.1, "green", "green"], [2.9, "blue", "red"], [5.7, "blue", "red"]] as const) {
    const scene = target.scenes.find((candidate) => timeSec >= candidate.startSec && timeSec < candidate.endSec)!;
    const layers = scene.layers.filter((layer): layer is CompositionSourceVideoLayer => layer.kind === "source-video");
    expect(layers).toHaveLength(2);
    for (const [index, expected] of [expectedTop, expectedBottom].entries()) {
      const layer = layers[index]!;
      const crop = interpolateCompositionCropTrack(layer.sourceCrop, layer.sourceCropTrack, timeSec);
      const center = crop.x + crop.width / 2;
      expect(center < 107 ? "red" : center < 213 ? "green" : "blue").toBe(expected);
      const color = await pixelAt(timeSec, index === 0 ? 40 : 120);
      const channel = expected === "red" ? 0 : expected === "green" ? 1 : 2;
      expect(color[channel]!).toBeGreaterThan(Math.max(...color.filter((_, item) => item !== channel)) + 40);
    }
  }
  expect(await pixelAt(1.5, 40)).toEqual([0, 0, 0]);
}, 30_000);
