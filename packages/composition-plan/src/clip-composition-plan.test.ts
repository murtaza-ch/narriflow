import { describe, expect, test } from "bun:test";
import {
  captionPresetSchema,
  clipAutoLayoutAnalysisSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  automaticLayoutInputFingerprint,
  CLIP_COMPOSITION_MAX_SERIALIZED_BYTES,
  planClipComposition,
  screenLayoutInputFingerprint,
  splitLayoutInputFingerprint,
} from "./clip-composition-plan";

function centerDocument() {
  return editorDocumentSchema.parse({
    clipStartSec: 10,
    clipEndSec: 20,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({
      framing: { mode: "center" },
    }),
    brollUrl: null,
    deletedRanges: [{ startSec: 12, endSec: 14 }],
  });
}

function fitDocument() {
  return editorDocumentSchema.parse({
    clipStartSec: 0,
    clipEndSec: 12,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({
      framing: { mode: "screen" },
      background: {
        mode: "image",
        color: "#123456",
        imageUrl: "https://example.com/background.jpg",
      },
    }),
    brollUrl: null,
    deletedRanges: [],
  });
}

describe("Clip Composition Plan", () => {
  test("plans Center once for mixed targets with exact bounded geometry", () => {
    const input = {
      document: centerDocument(),
      source: {
        identity: "source:project-1",
        kind: "video" as const,
        width: 1920,
        height: 1080,
      },
      evidence: { automaticLayout: { state: "missing" as const } },
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
        { id: "landscape", aspectRatio: "16:9" as const, width: 1920, height: 1080 },
      ],
    };

    const first = planClipComposition(input);
    const second = planClipComposition(input);

    expect(first.status).toBe("ready");
    if (first.status === "invalid" || second.status === "invalid") {
      throw new Error("expected a valid Center plan");
    }
    expect(first.plan.version).toBe(1);
    expect(first.plan.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(second.plan.fingerprint).toBe(first.plan.fingerprint);
    expect(first.plan.editedDurationSec).toBe(8);
    expect(first.plan.source).toEqual({
      ref: "source:project-1",
      width: 1920,
      height: 1080,
    });
    expect(first.plan.evidenceRequests).toEqual([]);
    expect(first.plan.notices).toEqual([]);
    expect(first.plan.targets).toEqual([
      {
        id: "vertical",
        aspectRatio: "9:16",
        requestedMode: "center",
        effectiveMode: "center",
        canvas: { width: 1080, height: 1920, divisibleBy: 2 },
        scenes: [
          {
            id: "scene:center:vertical:0",
            startSec: 0,
            endSec: 8,
            layers: [
              {
                id: "layer:source:vertical:0",
                kind: "source-video",
                sourceRef: "source:project-1",
                sourceCrop: { x: 656, y: 0, width: 608, height: 1080 },
                destination: { x: 0, y: 0, width: 1080, height: 1920 },
                fit: "cover",
                rotationDeg: 0,
                opacity: 1,
                zIndex: 0,
              },
            ],
          },
        ],
      },
      {
        id: "landscape",
        aspectRatio: "16:9",
        requestedMode: "center",
        effectiveMode: "center",
        canvas: { width: 1920, height: 1080, divisibleBy: 2 },
        scenes: [
          {
            id: "scene:center:landscape:0",
            startSec: 0,
            endSec: 8,
            layers: [
              {
                id: "layer:source:landscape:0",
                kind: "source-video",
                sourceRef: "source:project-1",
                sourceCrop: { x: 0, y: 0, width: 1920, height: 1080 },
                destination: { x: 0, y: 0, width: 1920, height: 1080 },
                fit: "cover",
                rotationDeg: 0,
                opacity: 1,
                zIndex: 0,
              },
            ],
          },
        ],
      },
    ]);
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(Object.isFrozen(first.plan.targets[0]?.scenes[0]?.layers[0])).toBe(true);
    expect(JSON.stringify(first.plan).length).toBeLessThan(16_000);
  });

  test("plans Fit precedence and degrades an unavailable image to the selected color", () => {
    const base = {
      document: fitDocument(),
      source: {
        identity: "source:landscape",
        kind: "video" as const,
        width: 1920,
        height: 1080,
      },
      evidence: { automaticLayout: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      ],
    };
    const available = planClipComposition({
      ...base,
      assets: {
        backgroundImage: { state: "available" as const, ref: "asset:bg-1" },
      },
    });
    const failed = planClipComposition({
      ...base,
      assets: { backgroundImage: { state: "failed" as const } },
    });

    expect(available.status).toBe("ready");
    expect(failed.status).toBe("ready");
    if (available.status === "invalid" || failed.status === "invalid") {
      throw new Error("expected valid Fit plans");
    }
    expect(available.plan.evidenceRequests).toEqual([]);
    expect(available.plan.targets[0]).toMatchObject({
      requestedMode: "fit",
      effectiveMode: "fit",
      scenes: [
        {
          startSec: 0,
          endSec: 12,
          layers: [
            {
              id: "layer:background:vertical:0",
              kind: "background",
              color: "#123456",
              imageRef: "asset:bg-1",
              destination: { x: 0, y: 0, width: 1080, height: 1920 },
              zIndex: 0,
            },
            {
              id: "layer:source:vertical:0",
              kind: "source-video",
              sourceCrop: { x: 0, y: 0, width: 1920, height: 1080 },
              destination: { x: 0, y: 656, width: 1080, height: 608 },
              fit: "contain",
              zIndex: 1,
            },
          ],
        },
      ],
    });
    expect(failed.plan.targets[0]?.scenes[0]?.layers[0]).toMatchObject({
      kind: "background",
      color: "#123456",
      imageRef: null,
    });
    expect(failed.plan.notices).toEqual([
      {
        code: "background_image_unavailable",
        fidelity: "degraded",
        targetId: "vertical",
        sceneId: null,
        effectiveFallback: "fit",
        userActionPossible: true,
      },
    ]);
  });

  test("requests missing Auto evidence once and plans target-specific speaker scenes when it arrives", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 10,
      clipEndSec: 20,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:auto-1",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const capabilities = {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
    };
    const targets = [
      { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
    ];
    const missing = planClipComposition({
      document,
      source,
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities,
      targets,
    });
    const fingerprint = automaticLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 10,
      clipEndSec: 20,
      deletedRanges: [],
      engineVersion: "shot-layout-v1",
    });
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: "shot-layout-v1",
      sourceIdentity: source.identity,
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      clipStartSec: 10,
      clipEndSec: 20,
      deletedRanges: [],
      editedDurationSec: 10,
      // Evidence may be measured on a same-source preview proxy. Speaker
      // coordinates are normalized, so the planner scales them to the
      // authoritative source facts instead of rejecting proxy dimensions.
      sourceWidth: 960,
      sourceHeight: 540,
      segments: [
        {
          startSec: 0,
          endSec: 10,
          layout: "two-up",
          topCxNorm: 0.25,
          bottomCxNorm: 0.75,
        },
      ],
      noSplitSegments: [
        {
          startSec: 0,
          endSec: 10,
          layout: "single",
          cxNorm: 0.5,
        },
      ],
      shotCount: 1,
      soloShotCount: 0,
      multiShotCount: 1,
      twoUpSegmentCount: 1,
      speakerCount: 2,
      mappedSpeakerCount: 2,
    });
    const ready = planClipComposition({
      document,
      source,
      evidence: {
        automaticLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: fingerprint,
            engineVersion: "shot-layout-v1",
            analysis,
          },
        },
      },
      assets: { backgroundImage: { state: "missing" } },
      capabilities,
      targets,
    });

    expect(missing.status).toBe("provisional");
    if (missing.status === "invalid" || ready.status === "invalid") {
      throw new Error("expected valid Auto plans");
    }
    expect(missing.plan.evidenceRequests).toEqual([
      {
        key: `automatic-speaker-layout:${fingerprint}`,
        kind: "automatic-speaker-layout",
        engineVersion: "shot-layout-v1",
      },
    ]);
    expect(missing.plan.targets.map((target) => target.effectiveMode)).toEqual([
      "center",
      "center",
    ]);
    expect(ready.status).toBe("ready");
    expect(ready.plan.evidenceRequests).toEqual([]);
    expect(ready.plan.targets[0]).toMatchObject({
      effectiveMode: "auto",
      scenes: [
        {
          startSec: 0,
          endSec: 10,
          layers: [
            {
              speaker: { role: "top" },
              destination: { x: 0, y: 0, width: 1080, height: 960 },
              sourceCrop: { x: 0, y: 0, width: 1215, height: 1080 },
            },
            {
              speaker: { role: "bottom" },
              destination: { x: 0, y: 960, width: 1080, height: 960 },
              sourceCrop: { x: 705, y: 0, width: 1215, height: 1080 },
            },
          ],
        },
      ],
    });
    expect(ready.plan.targets[1]).toMatchObject({
      effectiveMode: "auto",
      scenes: [
        {
          layers: [
            {
              speaker: { role: "single" },
              destination: { x: 0, y: 0, width: 1080, height: 1080 },
              sourceCrop: { x: 420, y: 0, width: 1080, height: 1080 },
            },
          ],
        },
      ],
    });
  });

  test("invalidates Auto evidence when its source identity or relevant window fingerprint is stale", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: "shot-layout-v1",
      sourceIdentity: "source:old",
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      clipStartSec: 0,
      clipEndSec: 5,
      deletedRanges: [],
      editedDurationSec: 5,
      sourceWidth: 1920,
      sourceHeight: 1080,
      segments: [{ startSec: 0, endSec: 5, layout: "single", cxNorm: 0.5 }],
      noSplitSegments: [{ startSec: 0, endSec: 5, layout: "single", cxNorm: 0.5 }],
      shotCount: 1,
      soloShotCount: 1,
      multiShotCount: 0,
      twoUpSegmentCount: 0,
      speakerCount: 1,
      mappedSpeakerCount: 1,
    });
    const result = planClipComposition({
      document,
      source: { identity: "source:new", kind: "video", width: 1920, height: 1080 },
      evidence: {
        automaticLayout: {
          state: "available",
          value: {
            sourceIdentity: "source:old",
            inputFingerprint: "stale",
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
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });

    expect(result.status).toBe("provisional");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.targets[0]?.effectiveMode).toBe("center");
    expect(result.plan.evidenceRequests).toHaveLength(1);

    const source = {
      identity: "source:new",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const common = {
      document,
      source,
      assets: { backgroundImage: { state: "missing" as const } },
      targets: [
        {
          id: "vertical",
          aspectRatio: "9:16" as const,
          width: 1080,
          height: 1920,
        },
      ],
    };
    const failed = planClipComposition({
      ...common,
      evidence: { automaticLayout: { state: "failed" } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
    });
    const disabled = planClipComposition({
      ...common,
      evidence: { automaticLayout: { state: "disabled" } },
      capabilities: {
        automaticSpeakerLayout: false,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
    });
    const versionMismatch = planClipComposition({
      ...common,
      evidence: {
        automaticLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: automaticLayoutInputFingerprint({
              sourceIdentity: source.identity,
              clipStartSec: 0,
              clipEndSec: 5,
              deletedRanges: [],
              engineVersion: "shot-layout-v1",
            }),
            engineVersion: "shot-layout-v1",
            analysis: { ...analysis, version: 2 } as never,
          },
        },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
    });
    expect(failed).toMatchObject({
      status: "ready",
      plan: {
        evidenceRequests: [],
        notices: [{ code: "automatic_layout_unavailable", fidelity: "degraded" }],
      },
    });
    expect(disabled).toMatchObject({
      status: "ready",
      plan: {
        evidenceRequests: [],
        notices: [{ code: "automatic_layout_disabled", fidelity: "degraded" }],
      },
    });
    expect(versionMismatch).toMatchObject({
      status: "provisional",
      plan: {
        evidenceRequests: [{ kind: "automatic-speaker-layout" }],
        notices: [{ code: "automatic_layout_analyzing", fidelity: "provisional" }],
      },
    });
  });

  test("applies aspect-specific manual overrides after analysis without freezing caller state", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({
        framing: { mode: "auto" },
        speakerLayoutOverrides: [
          {
            id: "manual-scene",
            aspectRatio: "9:16",
            startSec: 0,
            endSec: 5,
            layout: "two-up",
            layers: [
              {
                role: "top",
                frameX: 0.1,
                frameY: 0,
                frameWidth: 0.8,
                frameHeight: 0.5,
                rotationDeg: 0,
                cropCxNorm: 0.25,
                cropCyNorm: 0.5,
                cropZoom: 2,
              },
              {
                role: "bottom",
                frameX: 0,
                frameY: 0.5,
                frameWidth: 1,
                frameHeight: 0.5,
                rotationDeg: 0,
                cropCxNorm: 0.75,
                cropCyNorm: 0.5,
                cropZoom: 1,
              },
            ],
          },
        ],
      }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:override",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: "shot-layout-v1",
      sourceIdentity: source.identity,
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      clipStartSec: 0,
      clipEndSec: 5,
      deletedRanges: [],
      editedDurationSec: 5,
      sourceWidth: 1920,
      sourceHeight: 1080,
      segments: [
        { startSec: 0, endSec: 5, layout: "two-up", topCxNorm: 0.25, bottomCxNorm: 0.75 },
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
    const inputFingerprint = automaticLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 0,
      clipEndSec: 5,
      deletedRanges: [],
      engineVersion: "shot-layout-v1",
    });
    const result = planClipComposition({
      document,
      source,
      evidence: {
        automaticLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint,
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
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.targets[0]?.scenes[0]?.layers[0]).toMatchObject({
      destination: { x: 108, y: 0, width: 864, height: 960 },
      speaker: {
        overrideId: "manual-scene",
        transform: { frameX: 0.1, frameWidth: 0.8, cropZoom: 2 },
        defaultTransform: { frameX: 0, frameWidth: 1, cropZoom: 1 },
      },
    });
    expect(Object.isFrozen(document.studioEdits.speakerLayoutOverrides[0])).toBe(false);
    expect(Object.isFrozen(document.studioEdits.speakerLayoutOverrides[0]?.layers[0])).toBe(false);
  });

  test("rejects empty, duplicate, odd, or excessive target sets", () => {
    const base = {
      document: centerDocument(),
      source: { identity: "source", kind: "video" as const, width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" as const } },
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
    };
    const target = { id: "one", aspectRatio: "9:16" as const, width: 1080, height: 1920 };
    expect(planClipComposition({ ...base, targets: [] })).toMatchObject({ status: "invalid", error: { code: "invalid_target" } });
    expect(planClipComposition({ ...base, targets: [target, target] })).toMatchObject({ status: "invalid", error: { code: "invalid_target" } });
    expect(planClipComposition({ ...base, targets: [{ ...target, height: 1919 }] })).toMatchObject({ status: "invalid", error: { code: "invalid_target" } });
    expect(planClipComposition({ ...base, targets: Array.from({ length: 5 }, (_, index) => ({ ...target, id: `${index}` })) })).toMatchObject({ status: "invalid", error: { code: "too_many_targets" } });
  });

  test("keeps every Center target contiguous, complete, finite, bounded, and divisible", () => {
    const targets = [
      { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
      { id: "landscape", aspectRatio: "16:9" as const, width: 1920, height: 1080 },
      { id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
    ];
    const documents = [
      centerDocument(),
      editorDocumentSchema.parse({ ...centerDocument(), deletedRanges: [] }),
    ];
    for (const [source, document] of [
      [
        { identity: "landscape", kind: "video" as const, width: 1920, height: 1080 },
        documents[0]!,
      ],
      [
        { identity: "portrait", kind: "video" as const, width: 1080, height: 1920 },
        documents[1]!,
      ],
    ] as const) {
      const result = planClipComposition({
        document,
        source,
        evidence: { automaticLayout: { state: "missing" } },
        assets: { backgroundImage: { state: "missing" } },
        capabilities: {
          automaticSpeakerLayout: true,
          automaticSpeakerEngineVersion: "shot-layout-v1",
        },
        targets,
      });
      expect(result.status).toBe("ready");
      if (result.status === "invalid") throw new Error(result.error.code);
      for (const target of result.plan.targets) {
        expect(target.canvas.width % target.canvas.divisibleBy).toBe(0);
        expect(target.canvas.height % target.canvas.divisibleBy).toBe(0);
        expect(target.scenes).toHaveLength(1);
        expect(target.scenes[0]?.startSec).toBe(0);
        expect(target.scenes[0]?.endSec).toBe(result.plan.editedDurationSec);
        for (const layer of target.scenes[0]!.layers) {
          expect(Object.values(layer.destination).every(Number.isFinite)).toBe(true);
          expect(layer.destination.x + layer.destination.width).toBeLessThanOrEqual(target.canvas.width);
          expect(layer.destination.y + layer.destination.height).toBeLessThanOrEqual(target.canvas.height);
          if (layer.kind === "source-video") {
            expect(layer.sourceCrop.x + layer.sourceCrop.width).toBeLessThanOrEqual(source.width);
            expect(layer.sourceCrop.y + layer.sourceCrop.height).toBeLessThanOrEqual(source.height);
          }
        }
      }
    }
  });

  test("plans bounded Fit layers for every target and source orientation", () => {
    const targets = [
      { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
      { id: "landscape", aspectRatio: "16:9" as const, width: 1920, height: 1080 },
      { id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
    ];
    for (const source of [
      { identity: "fit:landscape", kind: "video" as const, width: 1920, height: 1080 },
      { identity: "fit:portrait", kind: "video" as const, width: 1080, height: 1920 },
    ]) {
      const result = planClipComposition({
        document: fitDocument(),
        source,
        evidence: { automaticLayout: { state: "missing" } },
        assets: { backgroundImage: { state: "failed" } },
        capabilities: {
          automaticSpeakerLayout: true,
          automaticSpeakerEngineVersion: "shot-layout-v1",
        },
        targets,
      });
      expect(result.status).toBe("ready");
      if (result.status === "invalid") throw new Error(result.error.code);
      for (const target of result.plan.targets) {
        const layers = target.scenes[0]!.layers;
        expect(layers.map((layer) => layer.kind)).toEqual([
          "background",
          "source-video",
        ]);
        const sourceLayer = layers[1]!;
        expect(sourceLayer.destination.x + sourceLayer.destination.width).toBeLessThanOrEqual(
          target.canvas.width,
        );
        expect(sourceLayer.destination.y + sourceLayer.destination.height).toBeLessThanOrEqual(
          target.canvas.height,
        );
      }
    }
  });

  test("deduplicates missing Auto evidence across targets and unrelated edits", () => {
    const document = editorDocumentSchema.parse({
      ...centerDocument(),
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
    });
    const input = {
      document,
      source: { identity: "source:stable", kind: "video" as const, width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" as const } },
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
        { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
      ],
    };
    const first = planClipComposition(input);
    const unrelated = planClipComposition({
      ...input,
      document: editorDocumentSchema.parse({
        ...document,
        studioEdits: {
          ...document.studioEdits,
          sourceAudio: { muted: true, volume: 37 },
        },
      }),
    });
    if (first.status === "invalid" || unrelated.status === "invalid") {
      throw new Error("expected provisional Auto plans");
    }
    expect(first.plan.evidenceRequests).toHaveLength(1);
    expect(unrelated.plan.evidenceRequests).toEqual(first.plan.evidenceRequests);
  });

  test("keeps the validated 64-scene, four-target Automatic boundary bounded", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 64,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:max-scenes",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const segments = Array.from({ length: 64 }, (_, index) => ({
      startSec: index,
      endSec: index + 1,
      layout: "two-up" as const,
      topCxNorm: 0.25,
      bottomCxNorm: 0.75,
    }));
    const noSplitSegments = Array.from({ length: 64 }, (_, index) => ({
      startSec: index,
      endSec: index + 1,
      layout: "single" as const,
      cxNorm: 0.5,
    }));
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: "shot-layout-v1",
      sourceIdentity: source.identity,
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      clipStartSec: 0,
      clipEndSec: 64,
      deletedRanges: [],
      editedDurationSec: 64,
      sourceWidth: 960,
      sourceHeight: 540,
      segments,
      noSplitSegments,
      shotCount: 64,
      soloShotCount: 0,
      multiShotCount: 64,
      twoUpSegmentCount: 64,
      speakerCount: 2,
      mappedSpeakerCount: 2,
    });
    const inputFingerprint = automaticLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 0,
      clipEndSec: 64,
      deletedRanges: [],
      engineVersion: "shot-layout-v1",
    });
    const result = planClipComposition({
      document,
      source,
      evidence: {
        automaticLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint,
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
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
        { id: "square", aspectRatio: "1:1", width: 1080, height: 1080 },
        { id: "landscape", aspectRatio: "16:9", width: 1920, height: 1080 },
        { id: "portrait", aspectRatio: "4:5", width: 1080, height: 1350 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.targets.map((target) => target.scenes.length)).toEqual([
      64, 64, 64, 64,
    ]);
    expect(new TextEncoder().encode(JSON.stringify(result.plan)).byteLength).toBeLessThanOrEqual(
      CLIP_COMPOSITION_MAX_SERIALIZED_BYTES,
    );
  });

  test("plans explicit Split scenes per target with distinct crops and encodable 4:5 tiles", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 8,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "split" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:split",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const engineVersion = "explicit-split-v1";
    const result = planClipComposition({
      document,
      source,
      evidence: {
        automaticLayout: { state: "missing" },
        splitLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: splitLayoutInputFingerprint({
              sourceIdentity: source.identity,
              clipStartSec: 0,
              clipEndSec: 8,
              deletedRanges: [],
              engineVersion,
            }),
            engineVersion,
            source: "explicit-detector",
            segments: [
              {
                startSec: 0,
                endSec: 4,
                layout: "two-up",
                topCxNorm: 0.2,
                bottomCxNorm: 0.8,
              },
              {
                startSec: 4,
                endSec: 8,
                layout: "single",
                cxNorm: 0.72,
              },
            ],
            fallbackSegments: [
              { startSec: 0, endSec: 4, layout: "single", cxNorm: 0.2 },
              { startSec: 4, endSec: 8, layout: "single", cxNorm: 0.72 },
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
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
        { id: "portrait", aspectRatio: "4:5", width: 1080, height: 1350 },
        { id: "square", aspectRatio: "1:1", width: 1080, height: 1080 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.evidenceRequests).toEqual([]);
    expect(result.plan.targets[0]).toMatchObject({
      requestedMode: "split",
      effectiveMode: "split",
      scenes: [
        {
          startSec: 0,
          endSec: 4,
          layers: [
            {
              speaker: { role: "top" },
              destination: { x: 0, y: 0, width: 1080, height: 960 },
            },
            {
              speaker: { role: "bottom" },
              destination: { x: 0, y: 960, width: 1080, height: 960 },
            },
          ],
        },
        { startSec: 4, endSec: 8, layers: [{ speaker: { role: "single" } }] },
      ],
    });
    expect(result.plan.targets[1]?.scenes[0]?.layers).toMatchObject([
      { destination: { x: 0, y: 0, width: 1080, height: 676 } },
      { destination: { x: 0, y: 676, width: 1080, height: 674 } },
    ]);
    const verticalLayers = result.plan.targets[0]!.scenes[0]!.layers;
    expect(verticalLayers[0]).not.toMatchObject({
      sourceCrop: verticalLayers[1]?.kind === "source-video"
        ? verticalLayers[1].sourceCrop
        : null,
    });
    expect(result.plan.targets[2]).toMatchObject({
      requestedMode: "split",
      effectiveMode: "auto",
      scenes: [
        { layers: [{ speaker: { role: "single" } }] },
        { layers: [{ speaker: { role: "single" } }] },
      ],
    });
    expect(result.plan.notices).toContainEqual({
      code: "split_target_ineligible",
      fidelity: "degraded",
      targetId: "square",
      sceneId: null,
      effectiveFallback: "auto",
      userActionPossible: false,
    });
  });

  test("plans Screen PiP, face-band, and static fallbacks from one evidence contract", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 2,
      clipEndSec: 10,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "screen" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:screen",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const engineVersion = "screen-layout-v1";
    const common = {
      document,
      source,
      evidence: { automaticLayout: { state: "missing" as const } },
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        screenLayout: true,
        screenEngineVersion: engineVersion,
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
        { id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
      ],
    };
    const fingerprint = screenLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 2,
      clipEndSec: 10,
      deletedRanges: [],
      engineVersion,
    });
    const pip = planClipComposition({
      ...common,
      evidence: {
        ...common.evidence,
        screenLayout: {
          state: "available" as const,
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: fingerprint,
            engineVersion,
            source: "durable-pip" as const,
            pictureInPicture: {
              state: "confirmed" as const,
              rect: { x: 0.72, y: 0.68, width: 0.2, height: 0.22 },
            },
            faceBand: { state: "unavailable" as const },
          },
        },
      },
    });
    const faceBand = planClipComposition({
      ...common,
      evidence: {
        ...common.evidence,
        screenLayout: {
          state: "available" as const,
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: fingerprint,
            engineVersion,
            source: "analysis" as const,
            pictureInPicture: { state: "unavailable" as const },
            faceBand: {
              state: "available" as const,
              segments: [
                { startSec: 0, endSec: 8, layout: "single" as const, cxNorm: 0.75 },
              ],
            },
          },
        },
      },
    });
    const pending = planClipComposition({
      ...common,
      evidence: {
        ...common.evidence,
        screenLayout: { state: "missing" as const },
      },
    });

    expect(pip.status).toBe("ready");
    expect(faceBand.status).toBe("ready");
    expect(pending.status).toBe("provisional");
    if (
      pip.status === "invalid" ||
      faceBand.status === "invalid" ||
      pending.status === "invalid"
    ) {
      throw new Error("expected valid Screen plans");
    }
    expect(pip.plan.targets[0]).toMatchObject({
      requestedMode: "screen",
      effectiveMode: "screen",
      scenes: [
        {
          layers: [
            {
              kind: "source-video",
              fit: "contain",
              sourceCrop: { x: 0, y: 0, width: 1920, height: 1080 },
              destination: { x: 0, y: 0, width: 1080, height: 960 },
            },
            {
              kind: "source-video",
              fit: "cover",
              destination: { x: 0, y: 960, width: 1080, height: 960 },
            },
          ],
        },
      ],
    });
    expect(pip.plan.targets[1]?.scenes[0]?.layers).toMatchObject([
      { destination: { x: 0, y: 0, width: 1080, height: 676 } },
      { destination: { x: 0, y: 676, width: 1080, height: 674 } },
    ]);
    expect(faceBand.plan.targets[0]?.scenes[0]?.layers[1]).toMatchObject({
      sourceCrop: { x: 705, y: 0, width: 1215, height: 1080 },
    });
    expect(pending.plan.evidenceRequests).toEqual([
      {
        key: `screen-layout:${fingerprint}`,
        kind: "screen-layout",
        engineVersion,
      },
    ]);
    expect(pending.plan.notices).toEqual([
      {
        code: "screen_layout_analyzing",
        fidelity: "provisional",
        targetId: "vertical",
        sceneId: null,
        effectiveFallback: "screen",
        userActionPossible: false,
      },
      {
        code: "screen_layout_analyzing",
        fidelity: "provisional",
        targetId: "portrait",
        sceneId: null,
        effectiveFallback: "screen",
        userActionPossible: false,
      },
    ]);
  });

  test("rejects Split when exact 4:5 tile geometry or clamped crops duplicate tiles", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 8,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "split" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const engineVersion = "explicit-split-v1";
    const planFor = (source: { identity: string; width: number; height: number }) =>
      planClipComposition({
        document,
        source: { ...source, kind: "video" as const },
        evidence: {
          automaticLayout: { state: "missing" as const },
          splitLayout: {
            state: "available" as const,
            value: {
              sourceIdentity: source.identity,
              inputFingerprint: splitLayoutInputFingerprint({
                sourceIdentity: source.identity,
                clipStartSec: 0,
                clipEndSec: 8,
                deletedRanges: [],
                engineVersion,
              }),
              engineVersion,
              source: "explicit-detector" as const,
              segments: [
                {
                  startSec: 0,
                  endSec: 8,
                  layout: "two-up" as const,
                  topCxNorm: 0.01,
                  bottomCxNorm: 0.02,
                },
              ],
              fallbackSegments: [
                { startSec: 0, endSec: 8, layout: "single" as const, cxNorm: 0.5 },
              ],
            },
          },
        },
        assets: { backgroundImage: { state: "missing" as const } },
        capabilities: {
          automaticSpeakerLayout: true,
          automaticSpeakerEngineVersion: "shot-layout-v1",
          explicitSplitLayout: true,
          splitEngineVersion: engineVersion,
        },
        targets: [
          { id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
        ],
      });

    const boundary = planFor({ identity: "source:boundary", width: 1600, height: 1000 });
    expect(boundary.status).toBe("ready");
    if (boundary.status === "invalid") throw new Error(boundary.error.code);
    expect(boundary.plan.notices[0]?.code).toBe("split_target_ineligible");

    const duplicated = planFor({ identity: "source:duplicate", width: 1920, height: 1080 });
    expect(duplicated.status).toBe("ready");
    if (duplicated.status === "invalid") throw new Error(duplicated.error.code);
    expect(duplicated.plan.targets[0]?.effectiveMode).toBe("auto");
    expect(duplicated.plan.targets[0]?.scenes[0]?.layers).toHaveLength(1);
    expect(duplicated.plan.notices[0]?.code).toBe("split_tiles_not_distinct");
    expect(duplicated.plan.notices[0]?.sceneId).not.toBeNull();
  });

  test("uses a static Screen speaker tile when the face band has no lateral crop room", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 8,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "screen" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:portrait-screen",
      kind: "video" as const,
      width: 1080,
      height: 1920,
    };
    const engineVersion = "screen-layout-v1";
    const result = planClipComposition({
      document,
      source,
      evidence: {
        automaticLayout: { state: "missing" },
        screenLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: screenLayoutInputFingerprint({
              sourceIdentity: source.identity,
              clipStartSec: 0,
              clipEndSec: 8,
              deletedRanges: [],
              engineVersion,
            }),
            engineVersion,
            source: "analysis",
            pictureInPicture: { state: "unavailable" },
            faceBand: {
              state: "available",
              segments: [
                { startSec: 0, endSec: 8, layout: "single", cxNorm: 0.9 },
              ],
            },
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
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });
    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.notices[0]?.code).toBe("screen_static_center_fallback");
  });

  test("keeps Split failure, stale-evidence, and edited-timeline fallbacks typed", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 10,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "split" } }),
      brollUrl: null,
      deletedRanges: [{ startSec: 4, endSec: 6 }],
    });
    const source = {
      identity: "source:split-failures",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const engineVersion = "explicit-split-v1";
    const common = {
      document,
      source,
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        explicitSplitLayout: true,
        splitEngineVersion: engineVersion,
      },
      targets: [
        {
          id: "vertical",
          aspectRatio: "9:16" as const,
          width: 1080,
          height: 1920,
        },
      ],
    };

    for (const reason of [
      "detection_unavailable",
      "insufficient_clusters",
      "empty_plan",
      "no_two_up_segments",
    ] as const) {
      const result = planClipComposition({
        ...common,
        evidence: {
          automaticLayout: { state: "missing" },
          splitLayout: { state: "failed", reason },
        },
      });
      expect(result.status).toBe("ready");
      if (result.status === "invalid") throw new Error(result.error.code);
      expect(result.plan.evidenceRequests).toEqual([]);
      expect(result.plan.targets[0]?.effectiveMode).toBe("center");
      expect(result.plan.targets[0]?.scenes[0]).toMatchObject({
        startSec: 0,
        endSec: 8,
      });
      expect(result.plan.notices[0]?.code).toBe(`split_${reason}`);
    }

    const stale = planClipComposition({
      ...common,
      evidence: {
        automaticLayout: { state: "missing" },
        splitLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: "stale",
            engineVersion,
            source: "explicit-detector",
            segments: [
              {
                startSec: 0,
                endSec: 8,
                layout: "two-up",
                topCxNorm: 0.25,
                bottomCxNorm: 0.75,
              },
            ],
            fallbackSegments: [
              { startSec: 0, endSec: 8, layout: "single", cxNorm: 0.5 },
            ],
          },
        },
      },
    });
    expect(stale.status).toBe("provisional");
    if (stale.status === "invalid") throw new Error(stale.error.code);
    expect(stale.plan.notices[0]?.code).toBe("split_layout_analyzing");
    expect(stale.plan.evidenceRequests).toHaveLength(1);
  });

  test("keeps Screen PiP gating and unavailable-analysis fallbacks explicit", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 8,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "screen" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:screen-failures",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const engineVersion = "screen-layout-v1";
    const fingerprint = screenLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 0,
      clipEndSec: 8,
      deletedRanges: [],
      engineVersion,
    });
    const common = {
      document,
      source,
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        screenLayout: true,
        screenEngineVersion: engineVersion,
      },
      targets: [
        {
          id: "vertical",
          aspectRatio: "9:16" as const,
          width: 1080,
          height: 1920,
        },
      ],
    };
    const tinyPip = planClipComposition({
      ...common,
      evidence: {
        automaticLayout: { state: "missing" },
        screenLayout: {
          state: "available",
          value: {
            sourceIdentity: source.identity,
            inputFingerprint: fingerprint,
            engineVersion,
            source: "analysis",
            pictureInPicture: {
              state: "confirmed",
              rect: { x: 0.7, y: 0.7, width: 0.05, height: 0.05 },
            },
            faceBand: { state: "unavailable" },
          },
        },
      },
    });
    expect(tinyPip.status).toBe("ready");
    if (tinyPip.status === "invalid") throw new Error(tinyPip.error.code);
    expect(tinyPip.plan.targets[0]?.effectiveMode).toBe("screen");
    expect(tinyPip.plan.notices[0]?.code).toBe("screen_pip_too_small");

    for (const reason of [
      "analysis_unavailable",
      "detection_unavailable",
      "no_face_detected",
      "no_trustworthy_faces",
    ] as const) {
      const failed = planClipComposition({
        ...common,
        evidence: {
          automaticLayout: { state: "missing" },
          screenLayout: { state: "failed", reason },
        },
      });
      expect(failed.status).toBe("ready");
      if (failed.status === "invalid") throw new Error(failed.error.code);
      expect(failed.plan.evidenceRequests).toEqual([]);
      expect(failed.plan.targets[0]?.effectiveMode).toBe("screen");
      expect(failed.plan.notices[0]?.code).toBe(`screen_${reason}`);
    }

    const disabled = planClipComposition({
      ...common,
      capabilities: { ...common.capabilities, screenLayout: false },
      evidence: {
        automaticLayout: { state: "missing" },
        screenLayout: { state: "disabled" },
      },
    });
    expect(disabled.status).toBe("ready");
    if (disabled.status === "invalid") throw new Error(disabled.error.code);
    expect(disabled.plan.targets[0]?.effectiveMode).toBe("center");
    expect(disabled.plan.notices[0]?.code).toBe("screen_layout_disabled");
  });

  test("plans resolved B-roll windows as edited-time layers over the existing base composition", () => {
    const document = editorDocumentSchema.parse({
      clipStartSec: 10,
      clipEndSec: 20,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
      brollUrl: "https://example.com/cutaway.mp4",
      deletedRanges: [{ startSec: 13, endSec: 15 }],
    });
    const result = planClipComposition({
      document,
      source: {
        identity: "source:broll",
        kind: "video",
        width: 1920,
        height: 1080,
      },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        broll: {
          state: "available",
          placements: [
            {
              id: "manual-1",
              ref: "broll:manual-1",
              startSec: 2,
              endSec: 5.5,
            },
          ],
        },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.editedDurationSec).toBe(8);
    expect(result.plan.targets[0]?.scenes.map((scene) => [
      scene.startSec,
      scene.endSec,
      scene.layers.map((layer) => layer.kind),
    ])).toEqual([
      [0, 2, ["source-video"]],
      [2, 5.5, ["source-video", "broll-video"]],
      [5.5, 8, ["source-video"]],
    ]);
    expect(result.plan.targets[0]?.scenes[1]?.layers[1]).toEqual({
      id: "layer:broll:manual-1:vertical",
      kind: "broll-video",
      sourceRef: "broll:manual-1",
      activeRange: { startSec: 2, endSec: 5.5 },
      destination: { x: 0, y: 0, width: 1080, height: 1920 },
      fit: "cover",
      rotationDeg: 0,
      opacity: 1,
      zIndex: 20,
      audio: "source",
    });
  });

  test("keeps automatic speaker scenes below B-roll and makes Split fallback truthful for the whole target", () => {
    const automaticDocument = editorDocumentSchema.parse({
      clipStartSec: 0,
      clipEndSec: 8,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
      brollUrl: "https://example.com/cutaway.mp4",
      deletedRanges: [],
    });
    const source = {
      identity: "source:broll-auto",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 1,
      engine: "shot-layout-v1",
      sourceIdentity: source.identity,
      clipStartSec: 0,
      clipEndSec: 8,
      deletedRanges: [],
      editedDurationSec: 8,
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      sourceWidth: 1920,
      sourceHeight: 1080,
      segments: [
        { startSec: 0, endSec: 4, layout: "single", cxNorm: 0.25 },
        { startSec: 4, endSec: 8, layout: "single", cxNorm: 0.75 },
      ],
      noSplitSegments: [
        { startSec: 0, endSec: 4, layout: "single", cxNorm: 0.25 },
        { startSec: 4, endSec: 8, layout: "single", cxNorm: 0.75 },
      ],
      shotCount: 2,
      soloShotCount: 2,
      multiShotCount: 0,
      twoUpSegmentCount: 0,
      speakerCount: 1,
      mappedSpeakerCount: 1,
    });
    const automaticLayout = {
      state: "available" as const,
      value: {
        sourceIdentity: source.identity,
        inputFingerprint: automaticLayoutInputFingerprint({
          sourceIdentity: source.identity,
          clipStartSec: 0,
          clipEndSec: 8,
          deletedRanges: [],
          engineVersion: "shot-layout-v1",
        }),
        engineVersion: "shot-layout-v1",
        analysis,
      },
    };
    const common = {
      source,
      assets: {
        backgroundImage: { state: "missing" as const },
        broll: {
          state: "available" as const,
          placements: [
            { id: "cutaway", ref: "broll:cutaway", startSec: 2, endSec: 6 },
          ],
        },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
        explicitSplitLayout: true,
        splitEngineVersion: "explicit-split-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      ],
    };
    const automatic = planClipComposition({
      ...common,
      document: automaticDocument,
      evidence: { automaticLayout },
    });
    const split = planClipComposition({
      ...common,
      document: { ...automaticDocument, studioEdits: studioEditsSchema.parse({ framing: { mode: "split" } }) },
      evidence: { automaticLayout, splitLayout: { state: "missing" } },
    });

    expect(automatic.status).toBe("ready");
    expect(split.status).toBe("ready");
    if (automatic.status === "invalid" || split.status === "invalid") {
      throw new Error("expected ready B-roll plans");
    }
    expect(automatic.plan.targets[0]?.scenes).toHaveLength(4);
    expect(automatic.plan.targets[0]?.scenes[1]?.layers).toMatchObject([
      { kind: "source-video", speaker: { role: "single" } },
      { kind: "broll-video", sourceRef: "broll:cutaway" },
    ]);
    expect(split.plan.evidenceRequests).toEqual([]);
    expect(split.plan.targets[0]?.effectiveMode).toBe("auto");
    expect(split.plan.notices).toContainEqual({
      code: "split_broll_conflict",
      fidelity: "degraded",
      targetId: "vertical",
      sceneId: null,
      effectiveFallback: "auto",
      userActionPossible: false,
    });
    expect(split.plan.targets[0]?.scenes.every((scene) =>
      scene.layers.some((layer) => layer.kind === "source-video"),
    )).toBe(true);
  });

  test("omits failed optional B-roll without degrading the requested base mode", () => {
    const document = editorDocumentSchema.parse({
      ...centerDocument(),
      brollUrl: "https://example.com/missing.mp4",
    });
    const result = planClipComposition({
      document,
      source: { identity: "source:broll-missing", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: {
        backgroundImage: { state: "missing" },
        broll: { state: "failed" },
      },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v1",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    expect(result.plan.targets[0]?.effectiveMode).toBe("center");
    expect(result.plan.targets[0]?.scenes).toHaveLength(1);
    expect(result.plan.notices).toContainEqual({
      code: "broll_asset_unavailable",
      fidelity: "degraded",
      targetId: "vertical",
      sceneId: null,
      effectiveFallback: "center",
      userActionPossible: true,
    });
  });
});
