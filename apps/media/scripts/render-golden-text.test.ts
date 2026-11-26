import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planClipComposition } from "@narriflow/composition-plan";
import { editorDocumentSchema } from "@narriflow/validators";
import { compileCompositionPlanVisualLayers } from "../src/composition-ffmpeg-adapter";
import type { WorkerMediaInspection } from "../src/worker-process";
import { loadInputs, writeGoldenTextScript } from "./render-golden";

/**
 * The golden runner writes a target's Text Layer script as the render attempt does. Fast: it plans the
 * committed `text-layers-transition` document on a synthetic 720p source and compiles its visual layers;
 * nothing is rendered (the golden suite itself renders and is not run here).
 */
describe("golden runner Text Layers", () => {
  test("text-layers-transition gets its text script, and its visual layers compile with it", async () => {
    const definition = loadInputs().cases["text-layers-transition"]!;
    const planned = planClipComposition({
      document: editorDocumentSchema.parse(structuredClone(definition.document)),
      source: { identity: "golden:talk-720p", kind: "video", width: 1280, height: 720, hasAudio: true },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: definition.targets.map((target) => ({ id: target.id, aspectRatio: target.aspectRatio, width: 1080, height: 1920 })),
    });
    if (planned.status === "invalid") throw new Error(planned.error.code);
    const plan = planned.plan;
    const targetId = definition.targets[0]!.id;
    expect(plan.targets[0]!.visualLayers.some((layer) => layer.kind === "text")).toBe(true);
    // Without the script the runner used to throw here.
    expect(() => compileCompositionPlanVisualLayers({ plan, targetId, inputLabel: "[in]", outputLabel: "[out]", subtitlePath: "/work/captions.ass" })).toThrow("clip_composition_text_asset_missing");
    const dir = await mkdtemp(join(tmpdir(), "golden-text-"));
    try {
      const inspection = { hasVideo: true, fps: 30 } as WorkerMediaInspection;
      const textAssPath = await writeGoldenTextScript(plan, targetId, inspection, dir);
      expect(textAssPath).toBe(join(dir, `text-${targetId}.ass`));
      expect(await readFile(textAssPath!, "utf8")).toContain("Don't miss: 50% off");
      const parts = compileCompositionPlanVisualLayers({ plan, targetId, inputLabel: "[in]", outputLabel: "[out]", textAssPath, subtitlePath: join(dir, "captions.ass") }).filterParts;
      expect(parts.some((part) => part.includes(`text-${targetId}.ass`))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
