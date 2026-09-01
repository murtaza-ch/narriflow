import { describe, expect, test } from "bun:test";
import { planClipComposition } from "@narriflow/composition-plan";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  adoptCompositionPreview,
  adoptCompositionPreviewResult,
  compositionNoticeText,
  compositionNoticeEntries,
  compositionNoticeTexts,
  compositionInvalidText,
  manualBrollAvailabilityForPlan,
  plannedCompositionSourceDimensions,
  plannedCompositionAudioState,
  plannedCompositionUsesStackedStage,
  plannedCompositionFrameStyle,
  plannedCompositionVideoStyle,
} from "./composition-preview-adapter";

function centerPlan() {
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
    version: 2,
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
  test("keeps every active scoped fallback accessible", () => {
    const context = {
      requestedMode: "fit" as const,
      effectiveMode: "fit" as const,
    };
    expect(
      compositionNoticeTexts(
        [
          {
            code: "background_image_unavailable",
            fidelity: "degraded",
            targetId: "9:16",
            sceneId: null,
            effectiveFallback: "fit",
            userActionPossible: true,
          },
          {
            code: "music_asset_unavailable",
            fidelity: "degraded",
            targetId: "9:16",
            sceneId: null,
            effectiveFallback: "fit",
            userActionPossible: true,
          },
        ],
        context,
      ),
    ).toHaveLength(2);
  });

  test("keeps duplicate notice copy keyed by stable placement identity", () => {
    const entries = compositionNoticeEntries(
      ["first", "second"].map((assetId) => ({
        code: "sound_effect_asset_unavailable",
        fidelity: "degraded" as const,
        targetId: "9:16",
        sceneId: null,
        effectiveFallback: "center" as const,
        userActionPossible: true,
        assetId,
      })),
      { requestedMode: "center", effectiveMode: "center" },
    );
    expect(entries.map((entry) => entry.key)).toEqual([
      "sound_effect_asset_unavailable:9:16:target:first",
      "sound_effect_asset_unavailable:9:16:target:second",
    ]);
    expect(new Set(entries.map((entry) => entry.text))).toHaveLength(1);
  });

  test("translates the planned audio schedule without recomputing audio policy", () => {
    const schedule = {
      fingerprint: "audio:fingerprint",
      outputFades: {
        fadeIn: { startSec: 0, endSec: 0.04 },
        fadeOut: { startSec: 7.88, endSec: 8 },
      },
      source: {
        sourceRef: "source:one",
        available: true,
        activeRange: { startSec: 0, endSec: 8 },
        gain: 0.65,
        muted: false,
      },
      music: {
        sourceRef: "music:one",
        activeRange: { startSec: 0, endSec: 8 },
        gain: 0.4,
        startOffsetSec: 3,
        sourceDurationSec: 4,
        loop: true as const,
        fades: {
          fadeIn: { startSec: 0, endSec: 4 },
          fadeOut: { startSec: 6, endSec: 8 },
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
          sourceRef: "sfx:one",
          activeRange: { startSec: 1, endSec: 8 },
          gain: 0.8,
        },
      ],
      censors: [],
    };

    const state = plannedCompositionAudioState(schedule, 1.5);
    expect({
      ...state,
      music: state.music ? { ...state.music, volume: undefined } : null,
    }).toEqual({
      scheduleFingerprint: "audio:fingerprint",
      source: { muted: false, volume: 0.65, outputGain: 1, envelopeGain: 1 },
      beep: null,
      music: {
        sourceRef: "music:one",
        timelineTimeSec: 0.5,
        loop: true,
        volume: undefined,
      },
      soundEffects: [
        {
          id: "sting",
          sourceRef: "sfx:one",
          localTimeSec: 0.5,
          volume: 0.8,
        },
      ],
    });
    expect(state.music?.volume).toBeCloseTo(0.045, 8);
    expect(plannedCompositionAudioState(schedule, 0.02).source.volume).toBeCloseTo(
      0.325,
      8,
    );
  });

  test("matches sequential export fades for a sub-160ms planned schedule", () => {
    const schedule = {
      fingerprint: "audio:short",
      outputFades: {
        fadeIn: { startSec: 0, endSec: 0.025 },
        fadeOut: { startSec: 0.025, endSec: 0.1 },
      },
      source: {
        sourceRef: "source:short",
        available: true,
        activeRange: { startSec: 0, endSec: 0.1 },
        gain: 1,
        muted: false,
      },
      music: null,
      soundEffects: [],
      censors: [],
    };

    expect(plannedCompositionAudioState(schedule, 0.02).source.outputGain).toBeCloseTo(
      0.8,
      8,
    );
    expect(plannedCompositionAudioState(schedule, 0.05).source.outputGain).toBeCloseTo(
      2 / 3,
      8,
    );
  });

  test("replaces dialogue with a faded beep while preserving the rest of the mix", () => {
    const schedule = {
      fingerprint: "audio:censor",
      outputFades: {
        fadeIn: { startSec: 0, endSec: 0 },
        fadeOut: { startSec: 5, endSec: 5 },
      },
      source: {
        sourceRef: "source:one",
        available: true,
        activeRange: { startSec: 0, endSec: 5 },
        gain: 0.8,
        muted: false,
      },
      music: null,
      soundEffects: [],
      censors: [
        {
          startSec: 1,
          endSec: 1.5,
          treatment: "beep" as const,
          frequencyHz: 1_000,
          gain: 0.5,
          fadeInSec: 0.05,
          fadeOutSec: 0.05,
        },
        { startSec: 2, endSec: 2.5, treatment: "mute" as const },
      ],
    };

    expect(plannedCompositionAudioState(schedule, 0.9)).toMatchObject({
      source: { volume: 0.8, envelopeGain: 1 },
      beep: null,
    });
    const fadeInState = plannedCompositionAudioState(schedule, 1.025);
    expect(fadeInState).toMatchObject({
      source: { volume: 0, envelopeGain: 0 },
      beep: { frequencyHz: 1_000 },
    });
    expect(fadeInState.beep?.volume).toBeCloseTo(0.25, 8);
    expect(plannedCompositionAudioState(schedule, 1.25)).toMatchObject({
      source: { volume: 0, envelopeGain: 0 },
      beep: { frequencyHz: 1_000, volume: 0.5 },
    });
    expect(plannedCompositionAudioState(schedule, 2.25)).toMatchObject({
      source: { volume: 0, envelopeGain: 0 },
      beep: null,
    });
    expect(plannedCompositionAudioState(schedule, 2.5)).toMatchObject({
      source: { volume: 0.8, envelopeGain: 1 },
      beep: null,
    });
  });

  test("adopts an audio-only audiogram without pretending its background will render", () => {
    const result = planClipComposition({
      document: editorDocumentSchema.parse({
    version: 2,
        clipStartSec: 0,
        clipEndSec: 6,
        captionPreset: captionPresetSchema.parse({}),
        transcriptSlice: [],
        studioEdits: studioEditsSchema.parse({
          background: { mode: "color", color: "#123456" },
        }),
        brollUrl: null,
        deletedRanges: [],
      }),
      source: { identity: "audio:one", kind: "audio", width: 0, height: 0 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [{ id: "9:16", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);

    expect(adoptCompositionPreview(result.plan, "9:16", 1)).toMatchObject({
      mainMediaKey: "audio:one",
      requestedMode: "fit",
      effectiveMode: "audiogram",
      layers: [{ kind: "audiogram", backgroundColor: "#0F172A" }],
      notices: [{ code: "audio_only_background_unsupported" }],
    });
    expect(compositionNoticeText("audio_only_background_unsupported")).toBe(
      "Audiograms use the standard waveform background. Remove the background choice to clear this notice.",
    );
  });

  test("maps deterministic invalid plans to one stable creator-facing error", () => {
    expect(compositionInvalidText("invalid_target")).toBe(
      "This composition is invalid for the selected format. Choose another format or adjust the layout before exporting.",
    );
    expect(compositionInvalidText("plan_size_exceeded")).toBe(
      "This composition is too complex to export. Remove some timed elements and try again.",
    );
  });

  test("names scoped pending and degraded fallbacks in accessible text", () => {
    expect(
      compositionNoticeText("automatic_layout_analyzing", {
        notice: {
          code: "automatic_layout_analyzing",
          fidelity: "pending",
          targetId: "9:16",
          sceneId: null,
          effectiveFallback: "center",
          userActionPossible: false,
        },
        requestedMode: "auto",
        effectiveMode: "center",
      }),
    ).toBe(
      "9:16 · Auto requested; previewing Center while this composition update completes. Analyzing speakers… Center framing is shown for now.",
    );
    expect(
      compositionNoticeText("screen_no_face_detected", {
        notice: {
          code: "screen_no_face_detected",
          fidelity: "degraded",
          targetId: "1:1",
          sceneId: "scene:screen:2",
          effectiveFallback: "center",
          userActionPossible: true,
        },
        requestedMode: "screen",
        effectiveMode: "center",
      }),
    ).toBe(
      "1:1, scene scene:screen:2 · Screen requested; preview and export use Center. No speaker face was detected. Using a centered speaker tile. Choose another framing mode to clear this notice.",
    );
  });

  test("replans a requested manual B-roll asset only after browser media validation", () => {
    const base = {
      url: "https://example.com/cutaway.mp4",
      ref: "broll:cutaway",
      window: { startSec: 2, endSec: 4 },
    };
    expect(
      manualBrollAvailabilityForPlan({ ...base, mediaState: "pending" }),
    ).toEqual({ state: "pending" });
    expect(
      manualBrollAvailabilityForPlan({ ...base, mediaState: "failed" }),
    ).toEqual({ state: "failed" });
    expect(
      manualBrollAvailabilityForPlan({ ...base, mediaState: "available" }),
    ).toEqual({
      state: "available",
      placements: [
        {
          id: "manual",
          ref: "broll:cutaway",
          startSec: 2,
          endSec: 4,
        },
      ],
    });
  });

  test("maps every durable Split and Screen failure notice to accessible copy", () => {
    const durableFailureCodes = [
      "split_detection_unavailable",
      "split_insufficient_clusters",
      "split_empty_plan",
      "split_no_two_up_segments",
      "split_tiles_not_distinct",
      "screen_analysis_unavailable",
      "screen_detection_unavailable",
      "screen_no_face_detected",
      "screen_no_trustworthy_faces",
    ];

    for (const code of durableFailureCodes) {
      expect(compositionNoticeText(code), code).toBeTruthy();
    }
  });

  test("explains pending B-roll media validation", () => {
    expect(compositionNoticeText("broll_asset_pending")).toBe(
      "Checking B-roll media… Showing the base composition for now.",
    );
  });

  test("always adopts a valid Clip Composition Plan result", () => {
    const plan = centerPlan();

    expect(
      adoptCompositionPreviewResult(
        { status: "ready", plan },
        "9:16",
        0,
      )?.planFingerprint,
    ).toBe(plan.fingerprint);
    expect(() =>
      adoptCompositionPreviewResult(
        { status: "invalid", error: { code: "invalid_source_facts" } },
        "9:16",
        0,
      ),
    ).toThrow("invalid_clip_composition_plan:invalid_source_facts");
  });

  test("uses durable source dimensions instead of proxy dimensions for planning", () => {
    expect(
      plannedCompositionSourceDimensions(
        { width: 960, height: 540 },
        { sourceWidth: 1920, sourceHeight: 1080 },
      ),
    ).toEqual({ width: 1920, height: 1080 });
    expect(
      plannedCompositionSourceDimensions({ width: 960, height: 540 }, null),
    ).toEqual({ width: 960, height: 540 });
  });

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

  test("translates Screen contain and crop layers without re-deciding fit policy", () => {
    const layer = centerPlan().targets[0]!.scenes[0]!.layers[0]!;
    if (layer.kind !== "source-video") throw new Error("expected source layer");

    expect(
      plannedCompositionVideoStyle(
        {
          ...layer,
          fit: "contain",
          sourceCrop: { x: 0, y: 0, width: 1920, height: 1080 },
          destination: { x: 0, y: 0, width: 1080, height: 676 },
        },
        { width: 1920, height: 1080 },
        { width: 540, height: 338 },
        true,
      ),
    ).toEqual({
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "contain",
      display: "block",
    });

    expect(
      plannedCompositionVideoStyle(
        {
          ...layer,
          fit: "cover",
          sourceCrop: { x: 480, y: 0, width: 960, height: 1080 },
          destination: { x: 0, y: 676, width: 1080, height: 674 },
        },
        { width: 1920, height: 1080 },
        { width: 540, height: 337 },
        true,
      ),
    ).toEqual({
      position: "absolute",
      left: "-270px",
      top: "0px",
      width: "1080px",
      height: "337px",
      maxWidth: "none",
      display: "block",
    });
  });

  test("mounts the secondary tile only for a two-layer planned scene", () => {
    const single = adoptCompositionPreview(centerPlan(), "9:16", 0);
    const splitSingle = {
      ...single,
      requestedMode: "split" as const,
      effectiveMode: "split" as const,
    };
    const splitTwoUp = {
      ...splitSingle,
      layers: [single.layers[0]!, { ...single.layers[0]!, id: "bottom" }],
    };

    expect(plannedCompositionUsesStackedStage(splitSingle)).toBe(false);
    expect(plannedCompositionUsesStackedStage(splitTwoUp)).toBe(true);
  });

  test("adopts B-roll only inside the planner's active edited-time scene", () => {
    const base = centerPlan();
    const result = planClipComposition({
      document: editorDocumentSchema.parse({
    version: 2,
        clipStartSec: 0,
        clipEndSec: 6,
        captionPreset: captionPresetSchema.parse({}),
        transcriptSlice: [],
        studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
        brollUrl: "https://example.com/cutaway.mp4",
        deletedRanges: [],
      }),
      source: {
        identity: base.source.ref,
        kind: "video",
        width: base.source.width,
        height: base.source.height,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        broll: {
          state: "available",
          placements: [
            { id: "manual", ref: "broll:manual", startSec: 2, endSec: 4 },
          ],
        },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [{ id: "9:16", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);

    expect(
      adoptCompositionPreview(result.plan, "9:16", 1).layers.some(
        (layer) => layer.kind === "broll-video",
      ),
    ).toBe(false);
    expect(
      adoptCompositionPreview(result.plan, "9:16", 2).layers.find(
        (layer) => layer.kind === "broll-video",
      ),
    ).toMatchObject({
      sourceRef: "broll:manual",
      activeRange: { startSec: 2, endSec: 4 },
      audio: "source",
    });
    expect(
      adoptCompositionPreview(result.plan, "9:16", 4).layers.some(
        (layer) => layer.kind === "broll-video",
      ),
    ).toBe(false);
  });

  test("adopts only active planned visual layers in stable z-order at boundaries", () => {
    const result = planClipComposition({
      document: editorDocumentSchema.parse({
    version: 2,
        clipStartSec: 0,
        clipEndSec: 6,
        captionPreset: captionPresetSchema.parse({ visible: false }),
        transcriptSlice: [],
        studioEdits: studioEditsSchema.parse({
          framing: { mode: "center" },
          textLayers: [
            { id: "early", text: "Early", startSec: 0, endSec: 2 },
            { id: "late", text: "Late", startSec: 2, endSec: 6 },
          ],
          transition: { type: "fade-black", durationSec: 0.5 },
        }),
        brollUrl: null,
        deletedRanges: [],
      }),
      source: { identity: "preview:visual", kind: "video", width: 1920, height: 1080 },
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
      targets: [
        {
          id: "9:16",
          aspectRatio: "9:16",
          width: 1080,
          height: 1920,
          outputTreatment: { resolution: "720p", watermark: true },
        },
      ],
    });
    if (result.status === "invalid") throw new Error(result.error.code);

    expect(adoptCompositionPreview(result.plan, "9:16", 1).layers.map((layer) => layer.kind)).toEqual([
      "source-video",
      "text",
      "logo",
      "transition",
      "output-treatment",
    ]);
    expect(adoptCompositionPreview(result.plan, "9:16", 2).layers.filter(
      (layer) => layer.kind === "text",
    ).map((layer) => layer.id)).toEqual(["layer:text:late:9:16"]);
    expect(adoptCompositionPreview(result.plan, "9:16", 6).layers.filter(
      (layer) => layer.kind === "text",
    ).map((layer) => layer.id)).toEqual(["layer:text:late:9:16"]);
  });

  test("adopts an inserted scene that intentionally has no source-video layer", () => {
    const base = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 6,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const result = planClipComposition({
      document: {
        ...base,
        sceneBlocks: [{
          id: "11111111-1111-4111-8111-111111111111",
          schemaVersion: 1,
          anchorSec: 0,
          durationSec: 2,
          content: { kind: "text", text: "Opening", fontFamily: "Archivo", fontAsset: null, color: "#FFFFFF", backgroundColor: "#111827" },
          motion: { entrance: "fade", exit: "fade" },
          templateSnapshot: null,
        }],
      },
      source: { identity: "preview:inserted", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "9:16", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });
    if (result.status === "invalid") throw new Error(result.error.code);

    expect(adoptCompositionPreview(result.plan, "9:16", 1)).toMatchObject({
      mainMediaKey: "preview:inserted",
      sceneStartSec: 0,
      sceneEndSec: 2,
      layers: [expect.objectContaining({ kind: "inserted-scene" })],
    });
  });
});
