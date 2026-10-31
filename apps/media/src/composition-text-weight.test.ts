import { expect, test } from "bun:test";
import { planClipComposition } from "@narriflow/composition-plan";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { compileCompositionPlanVisualLayers } from "./composition-ffmpeg-adapter";
import { productionWorkerProcessModule } from "./worker-process";

test("text layer bold control changes the rendered font weight", async () => {
  const render = async (bold: boolean) => {
    const result = planClipComposition({
      document: editorDocumentSchema.parse({
        version: 1, clipStartSec: 0, clipEndSec: 1,
        captionPreset: captionPresetSchema.parse({ visible: false }), transcriptSlice: [], brollUrl: null, deletedRanges: [],
        studioEdits: studioEditsSchema.parse({
          framing: { mode: "center" },
          textLayers: [{ id: "title", text: "Bold sample", fontName: "Arial", fontSize: 40, positionY: 50, outlineWidth: 0, bold }],
        }),
      }),
      source: { identity: "source:text", kind: "video", width: 480, height: 270 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "landscape", aspectRatio: "16:9", width: 480, height: 270 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);
    const visual = compileCompositionPlanVisualLayers({ plan: result.plan, targetId: "landscape", inputLabel: "[0:v]", outputLabel: "[outv]" });
    const output = await productionWorkerProcessModule.execute({
      command: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=480x270:d=1", "-filter_complex", visual.filterParts.join(";"), "-map", "[outv]", "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"],
      signal: new AbortController().signal, deadlineMs: 5_000, captureStdout: true,
    });
    return output.stdout.reduce((sum, luma) => sum + luma, 0);
  };
  const normalInk = await render(false);
  const boldInk = await render(true);
  expect(normalInk).toBeGreaterThan(0);
  expect(boldInk).toBeGreaterThan(normalInk * 1.1);
});
