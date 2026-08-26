import { describe, expect, test } from "bun:test";
import {
  automaticLayoutInputFingerprint,
  planClipComposition,
  screenLayoutInputFingerprint,
  splitLayoutInputFingerprint,
} from "@narriflow/composition-plan";
import {
  captionPresetSchema,
  clipAutoLayoutAnalysisSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import { compileCompositionPlanVideo } from "./composition-ffmpeg-adapter";
import { buildSingleVideoArgs } from "./tasks/render-clips";

function planCenter() {
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null,
      deletedRanges: [],
    }),
    source: { identity: "source:key", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
    },
    targets: [{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

function planFit(imageAvailable: boolean) {
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({
        background: {
          mode: "image",
          color: "#123456",
          imageUrl: "https://example.com/background.jpg",
        },
      }),
      brollUrl: null,
      deletedRanges: [],
    }),
    source: { identity: "source:key", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: {
      backgroundImage: imageAvailable
        ? { state: "available", ref: "background:image" }
        : { state: "failed" },
    },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
    },
    targets: [{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

function planAuto() {
  const document = editorDocumentSchema.parse({
    clipStartSec: 0,
    clipEndSec: 5,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
    brollUrl: null,
    deletedRanges: [],
  });
  const sourceIdentity = "source:key";
  const analysis = clipAutoLayoutAnalysisSchema.parse({
    version: 1,
    engine: "shot-layout-v1",
    sourceIdentity,
    analyzedAtISO: "2026-08-26T00:00:00.000Z",
    clipStartSec: 0,
    clipEndSec: 5,
    deletedRanges: [],
    editedDurationSec: 5,
    sourceWidth: 1920,
    sourceHeight: 1080,
    segments: [
      {
        startSec: 0,
        endSec: 5,
        layout: "two-up",
        topCxNorm: 0.25,
        bottomCxNorm: 0.75,
      },
    ],
    noSplitSegments: [
      { startSec: 0, endSec: 5, layout: "single", cxNorm: 0.5 },
    ],
    shotCount: 1,
    soloShotCount: 0,
    multiShotCount: 1,
    twoUpSegmentCount: 1,
    speakerCount: 2,
    mappedSpeakerCount: 2,
  });
  const result = planClipComposition({
    document,
    source: { identity: sourceIdentity, kind: "video", width: 1920, height: 1080 },
    evidence: {
      automaticLayout: {
        state: "available",
        value: {
          sourceIdentity,
          inputFingerprint: automaticLayoutInputFingerprint({
            sourceIdentity,
            clipStartSec: 0,
            clipEndSec: 5,
            deletedRanges: [],
            engineVersion: "shot-layout-v1",
          }),
          engineVersion: "shot-layout-v1",
          analysis,
        },
      },
    },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
    },
    targets: [{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

function planSplit() {
  const sourceIdentity = "source:key";
  const engineVersion = "explicit-split-v1";
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "split" } }),
      brollUrl: null,
      deletedRanges: [],
    }),
    source: { identity: sourceIdentity, kind: "video", width: 1920, height: 1080 },
    evidence: {
      automaticLayout: { state: "missing" },
      splitLayout: {
        state: "available",
        value: {
          sourceIdentity,
          inputFingerprint: splitLayoutInputFingerprint({
            sourceIdentity,
            clipStartSec: 0,
            clipEndSec: 5,
            deletedRanges: [],
            engineVersion,
          }),
          engineVersion,
          source: "explicit-detector",
          segments: [
            {
              startSec: 0,
              endSec: 5,
              layout: "two-up",
              topCxNorm: 0.25,
              bottomCxNorm: 0.75,
            },
          ],
          fallbackSegments: [
            { startSec: 0, endSec: 5, layout: "single", cxNorm: 0.5 },
          ],
        },
      },
    },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
      explicitSplitLayout: true,
      splitEngineVersion: engineVersion,
    },
    targets: [{ id: "variant-1", aspectRatio: "4:5", width: 1080, height: 1350 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

function planScreen() {
  const sourceIdentity = "source:key";
  const engineVersion = "screen-layout-v1";
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "screen" } }),
      brollUrl: null,
      deletedRanges: [],
    }),
    source: { identity: sourceIdentity, kind: "video", width: 1920, height: 1080 },
    evidence: {
      automaticLayout: { state: "missing" },
      screenLayout: {
        state: "available",
        value: {
          sourceIdentity,
          inputFingerprint: screenLayoutInputFingerprint({
            sourceIdentity,
            clipStartSec: 0,
            clipEndSec: 5,
            deletedRanges: [],
            engineVersion,
          }),
          engineVersion,
          source: "durable-pip",
          pictureInPicture: {
            state: "confirmed",
            rect: { x: 0.72, y: 0.68, width: 0.2, height: 0.22 },
          },
          faceBand: { state: "unavailable" },
        },
      },
    },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
      screenLayout: true,
      screenEngineVersion: engineVersion,
    },
    targets: [{ id: "variant-1", aspectRatio: "4:5", width: 1080, height: 1350 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

function planBroll() {
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: "https://example.com/cutaway.mp4",
      deletedRanges: [],
    }),
    source: { identity: "source:key", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: {
      backgroundImage: { state: "missing" },
      broll: {
        state: "available",
        placements: [
          { id: "cutaway", ref: "broll:cutaway", startSec: 1.5, endSec: 4 },
        ],
      },
    },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
    },
    targets: [{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

describe("composition FFmpeg adapter", () => {
  test("compiles the Center plan's exact crop without choosing geometry", () => {
    expect(
      compileCompositionPlanVideo({
        plan: planCenter(),
        targetId: "variant-1",
        videoInputLabel: "[0:v]",
        outputLabel: "[outv]",
      }),
    ).toEqual({
      filterParts: [
        "[0:v]crop=608:1080:656:0,scale=1080:1920,format=yuv420p[outv]",
      ],
      backgroundImageInputRequired: false,
      brollInputs: [],
    });
  });

  test("rejects an unknown plan version before command construction", () => {
    expect(() =>
      compileCompositionPlanVideo({
        plan: { ...planCenter(), version: 2 } as never,
        targetId: "variant-1",
        videoInputLabel: "[0:v]",
        outputLabel: "[outv]",
      }),
    ).toThrow("unsupported_clip_composition_plan_version");
  });

  test("rejects invalid source geometry before command construction", () => {
    const plan = planCenter();
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
    expect(() =>
      compileCompositionPlanVideo({
        plan: invalid,
        targetId: "variant-1",
        videoInputLabel: "[0:v]",
        outputLabel: "[outv]",
      }),
    ).toThrow("invalid_clip_composition_source_crop");
  });

  test("rejects a non-centered Center crop instead of letting FFmpeg choose", () => {
    const plan = planCenter();
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
                  sourceCrop: { ...layer.sourceCrop, x: layer.sourceCrop.x - 1 },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() =>
      compileCompositionPlanVideo({
        plan: invalid,
        targetId: "variant-1",
        videoInputLabel: "[0:v]",
        outputLabel: "[outv]",
      }),
    ).toThrow("unsupported_clip_composition_center_crop");
  });

  test("the production single-output builder rejects an unknown plan before FFmpeg starts", () => {
    expect(() =>
      buildSingleVideoArgs({
        sourcePath: "/tmp/source.mp4",
        outputPath: "/tmp/output.mp4",
        startSec: 0,
        endSec: 5,
        aspectRatio: "9:16",
        probe: {
          hasVideo: true,
          hasAudio: true,
          width: 1920,
          height: 1080,
          durationSec: 5,
          fps: 30,
        },
        srtPath: null,
        composition: {
          plan: { ...planCenter(), version: 2 } as never,
          targetId: "variant-1",
        },
      }),
    ).toThrow("unsupported_clip_composition_plan_version");
  });


  test("compiles exact Fit image and color-fallback geometry from plan layers", () => {
    const image = compileCompositionPlanVideo({
      plan: planFit(true),
      targetId: "variant-1",
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      backgroundImageInputIndex: 1,
      fps: 30,
    });
    const fallback = compileCompositionPlanVideo({
      plan: planFit(false),
      targetId: "variant-1",
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      fps: 30,
    });

    expect(image).toEqual({
      backgroundImageInputRequired: true,
      brollInputs: [],
      filterParts: [
        "[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[composition_bg]",
        "[0:v]crop=1920:1080:0:0,scale=1080:608[composition_source]",
        "[composition_bg][composition_source]overlay=0:656,format=yuv420p[outv]",
      ],
    });
    expect(fallback).toEqual({
      backgroundImageInputRequired: false,
      brollInputs: [],
      filterParts: [
        "[0:v]crop=1920:1080:0:0,scale=1080:608,pad=1080:1920:0:656:color=0x123456,format=yuv420p[outv]",
      ],
    });
  });

  test("compiles Auto scenes from exact planned crops and destinations", () => {
    expect(
      compileCompositionPlanVideo({
        plan: planAuto(),
        targetId: "variant-1",
        videoInputLabel: "[0:v]",
        outputLabel: "[outv]",
      }),
    ).toEqual({
      backgroundImageInputRequired: false,
      brollInputs: [],
      filterParts: [
        "[0:v]trim=start=0.000:end=5.000,setpts=PTS-STARTPTS[composition_scene_0_trim]",
        "[composition_scene_0_trim]split=2[composition_scene_0_layer_0_src][composition_scene_0_layer_1_src]",
        "[composition_scene_0_layer_0_src]crop=1215:1080:0:0,scale=1080:960[composition_scene_0_layer_0]",
        "[composition_scene_0_layer_1_src]crop=1215:1080:705:0,scale=1080:960[composition_scene_0_layer_1]",
        "[composition_scene_0_layer_0][composition_scene_0_layer_1]vstack=inputs=2,setsar=1,format=yuv420p[composition_scene_0]",
        "[composition_scene_0]format=yuv420p[outv]",
      ],
    });
  });

  test("compiles explicit Split with the planner's encodable 4:5 partition", () => {
    const compiled = compileCompositionPlanVideo({
      plan: planSplit(),
      targetId: "variant-1",
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
    });

    expect(compiled.filterParts).toContain(
      "[composition_scene_0_layer_0_src]crop=1725:1080:0:0,scale=1080:676[composition_scene_0_layer_0]",
    );
    expect(compiled.filterParts).toContain(
      "[composition_scene_0_layer_1_src]crop=1731:1080:189:0,scale=1080:674[composition_scene_0_layer_1]",
    );
    expect(compiled.filterParts).toContain(
      "[composition_scene_0_layer_0][composition_scene_0_layer_1]vstack=inputs=2,setsar=1,format=yuv420p[composition_scene_0]",
    );
  });

  test("compiles Screen from planned contain and PiP geometry", () => {
    expect(
      compileCompositionPlanVideo({
        plan: planScreen(),
        targetId: "variant-1",
        videoInputLabel: "[0:v]",
        outputLabel: "[outv]",
      }).filterParts,
    ).toEqual([
      "[0:v]trim=start=0.000:end=5.000,setpts=PTS-STARTPTS[composition_scene_0_trim]",
      "[composition_scene_0_trim]split=2[composition_scene_0_layer_0_src][composition_scene_0_layer_1_src]",
      "[composition_scene_0_layer_0_src]scale=1080:676:force_original_aspect_ratio=decrease,pad=1080:676:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[composition_scene_0_layer_0]",
      "[composition_scene_0_layer_1_src]crop=445:278:1352:714,scale=1080:674[composition_scene_0_layer_1]",
      "[composition_scene_0_layer_0][composition_scene_0_layer_1]vstack=inputs=2,setsar=1,format=yuv420p[composition_scene_0]",
      "[composition_scene_0]format=yuv420p[outv]",
    ]);
  });

  test("keeps a rotated manual layer centered on its planned destination", () => {
    const plan = planAuto();
    const target = plan.targets[0]!;
    const scene = target.scenes[0]!;
    const layer = scene.layers[0]!;
    const rotated = {
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
                  destination: { x: 108, y: 200, width: 864, height: 720 },
                  rotationDeg: 15,
                },
              ],
            },
          ],
        },
      ],
    };

    const compiled = compileCompositionPlanVideo({
      plan: rotated,
      targetId: "variant-1",
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
    }).filterParts.join(";");
    expect(compiled).toContain(
      "rotate=15.000*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0",
    );
    expect(compiled).toContain(
      "overlay=108+(864-overlay_w)/2:200+(720-overlay_h)/2",
    );
  });

  test("maps B-roll inputs from planned windows while compiling the unchanged base geometry", () => {
    const plan = planBroll();
    const compiled = compileCompositionPlanVideo({
      plan,
      targetId: "variant-1",
      videoInputLabel: "[0:v]",
      outputLabel: "[stage0]",
      resolvedBrollAssets: { "broll:cutaway": "/tmp/cutaway.mp4" },
      brollInputStartIndex: 1,
    });
    expect(compiled.brollInputs).toEqual([
      {
        sourceRef: "broll:cutaway",
        path: "/tmp/cutaway.mp4",
        inputIndex: 1,
        startSec: 1.5,
        endSec: 4,
      },
    ]);
    expect(compiled.filterParts.join(";")).toContain(
      "[1:v]scale=1080:1920:force_original_aspect_ratio=increase",
    );
    expect(compiled.filterParts.join(";")).toContain(
      "overlay=0:0:enable='between(t,1.5,4)'[stage0]",
    );
  });
});
