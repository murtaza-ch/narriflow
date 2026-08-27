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
import {
  compileCompositionPlanAudiogram,
  compileCompositionPlanAudioSchedule,
  compileCompositionPlanVideo,
  compileCompositionPlanVisualLayers,
} from "./composition-ffmpeg-adapter";
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

function planVisualStack(input: { captions?: boolean } = {}) {
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({ visible: input.captions ?? false }),
      transcriptSlice: input.captions
        ? [
            {
              index: 0,
              speaker: 0,
              speakerLabel: "Speaker 1",
              startSec: 0.5,
              endSec: 1.5,
              text: "Plan first",
              confidence: 0.99,
              words: [
                { word: "Plan", startSec: 0.5, endSec: 1, confidence: 0.99 },
                { word: "first", startSec: 1, endSec: 1.5, confidence: 0.99 },
              ],
            },
          ]
        : [],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "center" },
        textLayers: [{ id: "hook", text: "It's 50%", startSec: 1, endSec: 4 }],
        transition: { type: "dip-white", durationSec: 0.5 },
      }),
      brollUrl: null,
      deletedRanges: [],
    }),
    source: { identity: "source:key", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: {
      backgroundImage: { state: "missing" },
      logo: {
        state: "available",
        ref: "logo:brand",
        settings: {
          enabled: true,
          position: "top-right",
          opacity: 80,
          scalePct: 12,
        },
      },
    },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
    },
    targets: [{
      id: "variant-1",
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      outputTreatment: { resolution: "720p", watermark: true },
    }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

describe("composition FFmpeg adapter", () => {
  test("translates the planned audio-only audiogram without choosing its visual policy", () => {
    const result = planClipComposition({
      document: editorDocumentSchema.parse({
        clipStartSec: 0,
        clipEndSec: 5,
        captionPreset: captionPresetSchema.parse({ highlightColor: "#12AB34" }),
        transcriptSlice: [],
        studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
        brollUrl: null,
        deletedRanges: [],
      }),
      source: { identity: "audio:key", kind: "audio", width: 0, height: 0 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);

    expect(compileCompositionPlanAudiogram(result.plan, "variant-1")).toEqual({
      sourceRef: "audio:key",
      canvas: { width: 1080, height: 1920, divisibleBy: 2 },
      backgroundColor: "#0F172A",
      waveformColor: "#12AB34",
      waveformHeight: 806,
    });
  });

  test("translates the shared audio schedule into normalized render requests", () => {
    const plan = planCenter();
    const translated = compileCompositionPlanAudioSchedule({
      ...plan,
      audioSchedule: {
        fingerprint: "audio:one",
        source: {
          sourceRef: "source:key",
          available: true,
          activeRange: { startSec: 0, endSec: 5 },
          gain: 0.65,
          muted: false,
        },
        music: {
          sourceRef: "music:bed",
          activeRange: { startSec: 0, endSec: 5 },
          gain: 0.4,
          startOffsetSec: 3,
          loop: true,
          fades: {
            fadeIn: { startSec: 0, endSec: 2 },
            fadeOut: { startSec: 4, endSec: 5 },
          },
          ducking: {
            enabled: true,
            windows: [{ startSec: 1, endSec: 2 }],
            duckedGainFraction: 0.3,
            attackSec: 0.25,
            releaseSec: 0.4,
          },
        },
        soundEffects: [
          {
            id: "sting",
            sourceRef: "sfx:sting",
            activeRange: { startSec: 2, endSec: 5 },
            gain: 0.8,
          },
        ],
      },
    });

    expect(translated).toEqual({
      scheduleFingerprint: "audio:one",
      source: { available: true, gain: 0.65, muted: false },
      music: {
        sourceRef: "music:bed",
        gain: 0.4,
        startOffsetSec: 3,
        loop: true,
        fadeInSec: 2,
        fadeOutSec: 1,
        duckingWindows: [{ startSec: 1, endSec: 2 }],
      },
      soundEffects: [
        {
          id: "sting",
          sourceRef: "sfx:sting",
          startSec: 2,
          endSec: 5,
          gain: 0.8,
        },
      ],
    });
  });

  test("compiles the planner's complete visual order without re-reading editor policy", () => {
    expect(
      compileCompositionPlanVisualLayers({
        plan: planVisualStack(),
        targetId: "variant-1",
        inputLabel: "[composition_base]",
        outputLabel: "[outv]",
        logoInputIndex: 1,
      }),
    ).toEqual({
      filterParts: [
        "[composition_base]drawtext=font='Arial':text='It\\'s 50\\%':fontsize=44:fontcolor=0xFFFFFF:x=w*0.5000-text_w/2:y=h*0.1800-text_h/2:enable='between(t\\,1.000\\,4.000)':shadowcolor=black@0.45:shadowx=0:shadowy=2:borderw=2:bordercolor=0x000000[composition_visual_0]",
        "[1:v]scale=130:-1,format=rgba,colorchannelmixer=aa=0.800[composition_logo_1]",
        "[composition_visual_0][composition_logo_1]overlay=W-w-24:24[composition_visual_1]",
        "[composition_visual_1]fade=t=in:st=0.000:d=0.500:color=white,fade=t=out:st=4.500:d=0.500:color=white[composition_visual_2]",
        "[composition_visual_2]scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2,drawtext=text=Made with Narriflow:font='Arial Bold':fontcolor=0xFFFFFF@0.85:borderw=2:bordercolor=0x000000@0.60:fontsize=46:x=w-tw-32:y=32[outv]",
      ],
      logoInput: { sourceRef: "logo:brand", inputIndex: 1 },
    });
  });

  test("rejects missing resolved inputs for planned optional visual assets", () => {
    expect(() =>
      compileCompositionPlanVisualLayers({
        plan: planVisualStack(),
        targetId: "variant-1",
        inputLabel: "[composition_base]",
        outputLabel: "[outv]",
      }),
    ).toThrow("clip_composition_logo_input_missing");

    expect(() =>
      compileCompositionPlanVisualLayers({
        plan: planVisualStack({ captions: true }),
        targetId: "variant-1",
        inputLabel: "[composition_base]",
        outputLabel: "[outv]",
        logoInputIndex: 1,
      }),
    ).toThrow("clip_composition_caption_asset_missing");
  });

  test("rejects visual geometry outside the planned target canvas", () => {
    const plan = planVisualStack();
    const target = plan.targets[0]!;
    const layer = target.visualLayers[0]!;
    const invalid = {
      ...plan,
      targets: [
        {
          ...target,
          visualLayers: [
            {
              ...layer,
              destination: { ...layer.destination, x: target.canvas.width },
            },
            ...target.visualLayers.slice(1),
          ],
        },
      ],
    };

    expect(() =>
      compileCompositionPlanVisualLayers({
        plan: invalid,
        targetId: "variant-1",
        inputLabel: "[composition_base]",
        outputLabel: "[outv]",
        logoInputIndex: 1,
      }),
    ).toThrow("invalid_clip_composition_visual_destination");
  });

  test("rejects transition windows that overlap or cross the exact plan end", () => {
    const plan = planVisualStack();
    const target = plan.targets[0]!;
    const transition = target.visualLayers.find(
      (layer) => layer.kind === "transition",
    )!;
    const invalid = {
      ...plan,
      targets: [{
        ...target,
        visualLayers: target.visualLayers.map((layer) =>
          layer.id === transition.id
            ? {
                ...transition,
                windows: {
                  fadeIn: { startSec: 0, endSec: 0.5 },
                  fadeOut: { startSec: plan.editedDurationSec - 0.25, endSec: plan.editedDurationSec + 0.001 },
                },
              }
            : layer,
        ),
      }],
    };
    expect(() =>
      compileCompositionPlanVisualLayers({
        plan: invalid,
        targetId: "variant-1",
        inputLabel: "[composition_base]",
        outputLabel: "[outv]",
        logoInputIndex: 1,
      }),
    ).toThrow("invalid_clip_composition_transition_windows");
  });
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
