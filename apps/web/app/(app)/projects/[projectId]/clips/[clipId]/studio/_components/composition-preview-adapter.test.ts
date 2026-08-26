import { describe, expect, test } from "bun:test";
import { planClipComposition } from "@narriflow/composition-plan";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  adoptCompositionPreview,
  plannedCompositionFrameStyle,
} from "./composition-preview-adapter";

function centerPlan() {
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 6,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null,
      deletedRanges: [],
    }),
    source: { identity: "preview:key-1", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
    },
    targets: [{ id: "9:16", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

describe("composition preview adapter", () => {
  test("adopts exact planned geometry at the final edited frame without changing media identity", () => {
    const adopted = adoptCompositionPreview(centerPlan(), "9:16", 6);

    expect(adopted).toEqual({
      planVersion: 1,
      planFingerprint: expect.any(String),
      mainMediaKey: "preview:key-1",
      canvas: { width: 1080, height: 1920, divisibleBy: 2 },
      sceneId: "scene:center:9:16:0",
      sceneStartSec: 0,
      sceneEndSec: 6,
      requestedMode: "center",
      effectiveMode: "center",
      layers: [
        {
          id: "layer:source:9:16:0",
          kind: "source-video",
          sourceRef: "preview:key-1",
          sourceCrop: { x: 656, y: 0, width: 608, height: 1080 },
          destination: { x: 0, y: 0, width: 1080, height: 1920 },
          fit: "cover",
          rotationDeg: 0,
          opacity: 1,
          zIndex: 0,
        },
      ],
      notices: [],
    });
  });

  test("rejects unknown plan versions before adoption", () => {
    expect(() =>
      adoptCompositionPreview({ ...centerPlan(), version: 99 } as never, "9:16", 0),
    ).toThrow("unsupported_clip_composition_plan_version");
  });

  test("rejects invalid source geometry before browser adoption", () => {
    const plan = centerPlan();
    const target = plan.targets[0]!;
    const scene = target.scenes[0]!;
    const layer = scene.layers[0]!;
    const invalid = {
      ...plan,
      targets: [
        {
          ...target,
          scenes: [
            {
              ...scene,
              layers: [
                {
                  ...layer,
                  sourceCrop: { ...layer.sourceCrop, x: plan.source.width },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => adoptCompositionPreview(invalid, "9:16", 0)).toThrow(
      "invalid_clip_composition_source_crop",
    );
  });

  test("keeps the final Automatic speaker scene active at the exact clip end", () => {
    const plan = centerPlan();
    const target = plan.targets[0]!;
    const layer = target.scenes[0]!.layers[0]!;
    const automatic = {
      ...plan,
      targets: [
        {
          ...target,
          requestedMode: "auto" as const,
          effectiveMode: "auto" as const,
          scenes: [
            {
              id: "scene:auto:first",
              startSec: 0,
              endSec: 3,
              layers: [layer],
            },
            {
              id: "scene:auto:last",
              startSec: 3,
              endSec: 6,
              layers: [{ ...layer, id: "layer:auto:last" }],
            },
          ],
        },
      ],
    };

    expect(adoptCompositionPreview(automatic, "9:16", 6).sceneId).toBe(
      "scene:auto:last",
    );
  });

  test("translates planned main and secondary rotation without choosing geometry", () => {
    const layer = centerPlan().targets[0]!.scenes[0]!.layers[0]!;
    if (layer.kind !== "source-video") throw new Error("expected source layer");
    const canvas = { width: 1080, height: 1920 };

    expect(
      plannedCompositionFrameStyle(
        {
          ...layer,
          destination: { x: 108, y: 240, width: 864, height: 720 },
          rotationDeg: 12.5,
        },
        canvas,
      ),
    ).toEqual({
      position: "absolute",
      left: "10%",
      top: "12.5%",
      width: "80%",
      height: "37.5%",
      transform: "rotate(12.5deg)",
      transformOrigin: "center",
    });
  });
});
