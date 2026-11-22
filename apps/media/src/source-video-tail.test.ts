import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planClipComposition } from "@narriflow/composition-plan";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { bindCompositionPlanAudioInputs, compileClipCompositionCommand, compileCompositionPlanAudioSchedule } from "./composition-ffmpeg-adapter";
import { buildClipCutPlan } from "./tasks/cut-plan";
import { compositionOutputExpectation, validateRenderOutput } from "./render-output-validation";
import { productionWorkerProcessModule as worker } from "./worker-process";

const signal = new AbortController().signal;
let directory: string;
let sourcePath: string;
const execute = (args: string[]) => worker.execute({ command: "ffmpeg", args: ["-v", "error", "-y", ...args], signal, deadlineMs: 10_000 });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "narriflow-video-tail-"));
  sourcePath = join(directory, "source.mp4");
  await execute([
    "-f", "lavfi", "-i", "testsrc2=s=160x90:r=30000/1001:d=1.001",
    "-f", "lavfi", "-i", "sine=r=44100:d=1.07",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sourcePath,
  ]);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function render(options: { broll?: boolean; cut?: boolean; endSec?: number; truncated?: boolean } = {}) {
  const source = await worker.inspectMedia({ sourcePath, signal, deadlineMs: 5000 });
  const endSec = options.endSec ?? source.durationSec;
  const deletedRanges = options.cut ? [{ startSec: 0.2, endSec: 0.4 }] : [];
  const document = editorDocumentSchema.parse({
    version: 1, clipStartSec: 0, clipEndSec: endSec,
    captionPreset: captionPresetSchema.parse({ visible: false }), transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }), brollUrl: null, deletedRanges,
  });
  const result = planClipComposition({
    document, source: { identity: "video-tail", kind: "video", width: 160, height: 90 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, ...(options.broll ? { broll: { state: "available" as const, placements: [{ id: "cutaway", ref: "broll:cutaway", startSec: 0.1, endSec: 0.2 }] } } : {}) },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  const { plan } = result;
  const audio = bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(plan), {});
  const outputPath = join(directory, `${crypto.randomUUID()}.mp4`);
  let actualSourcePath = sourcePath;
  if (options.truncated) {
    actualSourcePath = join(directory, "truncated.mp4");
    await execute(["-i", sourcePath, "-t", "0.5", "-c", "copy", actualSourcePath]);
  }
  const args = compileClipCompositionCommand({
    sourcePath: actualSourcePath, outputPath, startSec: 0, endSec, source, plan, targetId: "vertical", audio,
    cutPlan: buildClipCutPlan(deletedRanges, { startSec: 0, endSec }),
    encoder: { preset: "veryfast", crf: "23" },
    assets: { subtitlePath: null, ...(options.broll ? { broll: { "broll:cutaway": sourcePath } } : {}) },
  });
  await execute(args);
  return validateRenderOutput({ path: outputPath, expected: compositionOutputExpectation({ plan, targetId: "vertical", source, audio }), workerProcess: worker, signal });
}

for (const broll of [false, true]) {
  for (const cut of [false, true]) {
    test(`source video covers the audio tail with broll=${broll}, cut=${cut}`, async () => {
      const result = await render({ broll, cut });
      expect(result.decoded.video.endSec).toBeGreaterThan(1.04 - (cut ? 0.2 : 0));
    });
  }
}

test("a window beyond the source still fails duration validation", async () => {
  await expect(render({ endSec: 2 })).rejects.toMatchObject({ diagnosticCodes: expect.arrayContaining(["output_video_duration_mismatch"]) });
});

test("known stream padding cannot hide an interrupted source read", async () => {
  await expect(render({ truncated: true })).rejects.toMatchObject({ diagnosticCodes: expect.arrayContaining(["output_video_duration_mismatch"]) });
});
