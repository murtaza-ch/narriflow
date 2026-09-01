import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automaticLayoutInputFingerprint,
  compositionAssetRef,
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
  compileCompositionPlanSceneAudio,
  compileCompositionPlanVideo,
  compileCompositionPlanVisualLayers,
  bindCompositionPlanAudioInputs,
} from "./composition-ffmpeg-adapter";
import { buildAudiogramArgs, buildSingleVideoArgs } from "./tasks/render-clips";

function planCenter() {
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
    version: 2,
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

const realMediaDirectories: string[] = [];
afterEach(async () => Promise.all(realMediaDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function planInsertedScenes(targets = [
  { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
  { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
  { id: "landscape", aspectRatio: "16:9" as const, width: 1920, height: 1080 },
  { id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
], source = { width: 1920, height: 1080 }) {
  const imageId = "141b738e-f106-4da1-b670-8b71ff7f0a58";
  const videoId = "9e2af81d-8a41-4404-af89-b560f9c4eb98";
  const fontId = "2eb2cc4f-1d68-44d7-acbc-447388066562";
  const fingerprint = "a".repeat(64);
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null,
      deletedRanges: [],
      censorSegments: [],
      mediaMotions: [],
      sceneBlocks: [
        { id: "8ab9d330-688f-4574-932c-27ac661245c1", schemaVersion: 1, anchorSec: 0, durationSec: 1, content: { kind: "color", color: "#112233" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null },
        { id: "d8ab95f8-fc16-4e60-814e-69762a59a99b", schemaVersion: 1, anchorSec: 1, durationSec: 1, content: { kind: "text", text: "Opening: 100%", fontFamily: "Missing Brand Font", fontAsset: { kind: "brand_font", id: fontId, fingerprint: "a".repeat(64) }, color: "#FFFFFF", backgroundColor: "#111827" }, motion: { entrance: "fade", exit: "fade" }, templateSnapshot: null },
        { id: "a3196d76-b71d-4b93-8812-7435b9e17faf", schemaVersion: 1, anchorSec: 2, durationSec: 1, content: { kind: "image", asset: { kind: "visual_asset", id: imageId, fingerprint }, fit: "contain", backgroundColor: "#223344" }, motion: { entrance: "zoom-in", exit: "zoom-out" }, templateSnapshot: null },
        { id: "31ddc1dd-838c-4fed-a940-4cbed7a3974b", schemaVersion: 1, anchorSec: 3, durationSec: 1, content: { kind: "video", asset: { kind: "visual_asset", id: videoId, fingerprint }, sourceStartSec: 0, sourceEndSec: 1, fit: "cover", backgroundColor: "#000000", muted: false, volume: 65 }, motion: { entrance: "slide-up", exit: "slide-down" }, templateSnapshot: null },
      ],
    }),
    source: { identity: "source:key", kind: "video", ...source },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets,
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return {
    plan: result.plan,
    imageRef: compositionAssetRef("visual_asset", `${imageId}:${fingerprint}`),
    videoRef: compositionAssetRef("visual_asset", `${videoId}:${fingerprint}`),
    fontRef: compositionAssetRef("brand_font", `${fontId}:${fingerprint}`),
  };
}

function planFit(imageAvailable: boolean) {
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
    version: 2,
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
    version: 2,
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
    version: 2,
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
  const engineVersion = "screen-layout-v2";
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
    version: 2,
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
    version: 2,
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
    version: 2,
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
    version: 2,
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

  test("splices inserted scenes into an audio-only audiogram and pauses source audio", () => {
    const result = planClipComposition({
      document: editorDocumentSchema.parse({
        version: 2,
        clipStartSec: 0,
        clipEndSec: 5,
        captionPreset: captionPresetSchema.parse({}),
        transcriptSlice: [],
        studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
        brollUrl: null,
        deletedRanges: [],
        censorSegments: [],
        mediaMotions: [],
        sceneBlocks: [{
          id: "2fc72899-b6f5-4a8e-a708-8c8c6ffc4bba",
          schemaVersion: 1,
          anchorSec: 2,
          durationSec: 1,
          content: { kind: "color", color: "#112233" },
          motion: { entrance: "fade", exit: "fade" },
          templateSnapshot: null,
        }],
      }),
      source: { identity: "audio:key", kind: "audio", width: 0, height: 0 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);
    const audio = bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(result.plan), {});
    const args = buildAudiogramArgs({
      sourcePath: "/tmp/source.mp3",
      outputPath: "/tmp/output.mp4",
      startSec: 0,
      endSec: 5,
      aspectRatio: "9:16",
      composition: { plan: result.plan, targetId: "variant-1" },
      clipDurationSec: 5,
      srtPath: null,
      audio,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[audiogram_source]");
    expect(graph).toContain("concat=n=3:v=1:a=0");
    expect(graph).toContain("anullsrc=channel_layout=stereo");
    expect(args.slice(-20)).toContain("6.000");
  });

  test("translates the shared audio schedule into normalized render requests", () => {
    const plan = planCenter();
    const translated = compileCompositionPlanAudioSchedule({
      ...plan,
      audioSchedule: {
        fingerprint: "audio:one",
        outputFades: {
          fadeIn: { startSec: 0, endSec: 0.04 },
          fadeOut: { startSec: 4.88, endSec: 5 },
        },
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
          sourceDurationSec: 10,
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
      outputFades: {
        fadeIn: { startSec: 0, endSec: 0.04 },
        fadeOut: { startSec: 4.88, endSec: 5 },
      },
      source: {
        activeRange: { startSec: 0, endSec: 5 },
        available: true,
        gain: 0.65,
        muted: false,
      },
      music: {
        sourceRef: "music:bed",
        activeRange: { startSec: 0, endSec: 5 },
        gain: 0.4,
        startOffsetSec: 3,
        sourceDurationSec: 10,
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
      sceneInputs: [],
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
      sceneInputs: [],
      filterParts: [
        "[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[composition_bg]",
        "[0:v]crop=1920:1080:0:0,scale=1080:608[composition_source]",
        "[composition_bg][composition_source]overlay=0:656,format=yuv420p[outv]",
      ],
    });
    expect(fallback).toEqual({
      backgroundImageInputRequired: false,
      brollInputs: [],
      sceneInputs: [],
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
      sceneInputs: [],
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

  test("compiles every inserted scene kind, fit treatment, own audio, frozen font, and target from one plan", () => {
    const { plan, imageRef, videoRef, fontRef } = planInsertedScenes();
    for (const target of plan.targets) {
      const compiled = compileCompositionPlanVideo({
        plan,
        targetId: target.id,
        videoInputLabel: "[0:v]",
        outputLabel: "[outv]",
        resolvedSceneAssets: {
          [imageRef]: { path: "/tmp/card.png", kind: "image" },
          [videoRef]: { path: "/tmp/insert.mp4", kind: "video" },
        },
        resolvedSceneFonts: { [fontRef]: "/tmp/brand.ttf" },
        sceneInputStartIndex: 1,
      });
      const graph = compiled.filterParts.join(";");
      expect(compiled.sceneInputs.map((input) => input.sourceRef)).toEqual([imageRef, videoRef]);
      expect(graph).toContain(`s=${target.canvas.width}x${target.canvas.height}`);
      expect(graph).toContain("drawtext=fontfile='/tmp/brand.ttf':text='Opening\\: 100\\%' ".trim());
      expect(graph).toContain("force_original_aspect_ratio=decrease,pad=");
      expect(graph).toContain("force_original_aspect_ratio=increase,crop=");
		expect(graph).toContain("0.920000+0.080000");
		expect(graph).toContain(`pad=${target.canvas.width}:${target.canvas.height * 3}:0:${target.canvas.height}`);
		expect(graph).toContain(`crop=${target.canvas.width}:${target.canvas.height}:0:`);
      expect(graph).toContain("concat=n=5:v=1:a=0");

      const audio = compileCompositionPlanSceneAudio({
        plan,
        targetId: target.id,
        sourceAudioLabel: "[0:a]",
        sceneInputs: [
          { sourceRef: imageRef, inputIndex: 1, hasAudio: false },
          { sourceRef: videoRef, inputIndex: 2, hasAudio: true },
        ],
      });
      expect(audio.outputLabel).toBe("[composition_scene_audio]");
      expect(audio.filterParts.join(";")).toContain("[2:a]atrim=start=0.000:end=1.000");
      expect(audio.filterParts.join(";")).toContain("volume=0.650");
      expect(audio.filterParts.join(";")).toContain("concat=n=5:v=0:a=1");
    }
  });

  test("fails closed when a required inserted-scene asset is missing", () => {
    const { plan } = planInsertedScenes();
    expect(() => compileCompositionPlanVideo({
      plan,
      targetId: "vertical",
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      resolvedSceneAssets: {},
      sceneInputStartIndex: 1,
    })).toThrow("clip_composition_scene_input_missing");
  });

  test("fails closed when a frozen Brand font file is missing", () => {
    const { plan, imageRef, videoRef } = planInsertedScenes();
    expect(() => compileCompositionPlanVideo({
      plan,
      targetId: "vertical",
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      resolvedSceneAssets: {
        [imageRef]: { path: "/tmp/card.png", kind: "image" },
        [videoRef]: { path: "/tmp/insert.mp4", kind: "video" },
      },
      sceneInputStartIndex: 1,
    })).toThrow("clip_composition_scene_font_missing");
  });

  test("renders all inserted scene kinds and motion with real media", async () => {
    const directory = await mkdtemp(join(tmpdir(), "narriflow-scene-render-"));
    realMediaDirectories.push(directory);
    const sourcePath = join(directory, "source.mp4");
    const imagePath = join(directory, "image.png");
    const sceneVideoPath = join(directory, "scene.mp4");
    const outputPath = join(directory, "output.mp4");
    const run = async (args: string[]) => {
      const process = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(process.stderr).text();
      expect(await process.exited, stderr).toBe(0);
    };
    await run(["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sourcePath]);
    await run(["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=0x88aaff:s=80x80", "-frames:v", "1", imagePath]);
    await run(["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=size=100x100:rate=24", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sceneVideoPath]);

    const { plan, imageRef, videoRef, fontRef } = planInsertedScenes([
      { id: "real", aspectRatio: "9:16", width: 180, height: 320 },
    ], { width: 320, height: 180 });
    const audio = bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(plan), {});
    const fontMatch = Bun.spawn(["fc-match", "-f", "%{file}", "Archivo"], { stdout: "pipe" });
    const fontPath = (await new Response(fontMatch.stdout).text()).trim();
    expect(await fontMatch.exited).toBe(0);
    expect(fontPath.length).toBeGreaterThan(0);
    const args = buildSingleVideoArgs({
      sourcePath,
      outputPath,
      startSec: 0,
      endSec: 5,
      aspectRatio: "9:16",
      probe: { hasVideo: true, hasAudio: true, width: 320, height: 180, durationSec: 5, fps: 24 },
      srtPath: null,
      composition: { plan, targetId: "real" },
      audio,
      resolvedSceneAssets: {
        [imageRef]: { path: imagePath, kind: "image", hasAudio: false },
        [videoRef]: { path: sceneVideoPath, kind: "video", hasAudio: true },
      },
      resolvedSceneFonts: { [fontRef]: fontPath },
    });
    await run(["ffmpeg", ...args]);
    const probe = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", outputPath], { stdout: "pipe" });
    const result = await new Response(probe.stdout).json() as { format: { duration: string }; streams: Array<{ codec_type: string; width?: number; height?: number }> };
    expect(await probe.exited).toBe(0);
    expect(Number(result.format.duration)).toBeCloseTo(plan.editedDurationSec, 1);
    expect(result.streams).toContainEqual(expect.objectContaining({ codec_type: "video", width: 180, height: 320 }));
    expect(result.streams).toContainEqual(expect.objectContaining({ codec_type: "audio" }));
  }, 30_000);
});
