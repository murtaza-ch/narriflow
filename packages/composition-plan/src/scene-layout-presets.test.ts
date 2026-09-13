import { describe, expect, test } from "bun:test";
import {
  CLIP_AUTO_LAYOUT_ENGINE,
  CLIP_AUTO_LAYOUT_VERSION,
  SCENE_LAYOUT_PRESETS,
  captionPresetSchema,
  clipAutoLayoutAnalysisSchema,
  editorDocumentSchema,
  studioEditsSchema,
  type SceneLayoutPreset,
} from "@narriflow/validators";
import {
  automaticLayoutInputFingerprint,
  planClipComposition,
} from "./clip-composition-plan";
import {
  SCENE_LAYOUT_PRESET_CATALOG,
  resolveSceneLayoutPresetTemplate,
  sceneLayoutPresetShowsBackground,
} from "./scene-layout-presets";

const source = {
  identity: "source:extended-layouts",
  kind: "video" as const,
  width: 1920,
  height: 1080,
};

const subjects = [
  { id: "speaker-a", cxNorm: 0.15, cyNorm: 0.48, zoom: 1.1 },
  { id: "speaker-b", cxNorm: 0.38, cyNorm: 0.48, zoom: 1.1 },
  { id: "speaker-c", cxNorm: 0.62, cyNorm: 0.48, zoom: 1.1 },
  { id: "speaker-d", cxNorm: 0.85, cyNorm: 0.48, zoom: 1.1 },
] as const;

function planPreset(
  preset: SceneLayoutPreset,
  availableSubjects: number,
  speakerLayoutOverrides: unknown[] = [],
  automaticFocus: "single" | "last-two" = "single",
  target = {
    id: "vertical",
    aspectRatio: "9:16" as const,
    width: 1080,
    height: 1920,
  },
) {
  const document = editorDocumentSchema.parse({
    version: 2,
    clipStartSec: 0,
    clipEndSec: 4,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({
      framing: { mode: "center" },
      sceneLayouts: [
        {
          id: "selected-layout",
          aspectRatio: target.aspectRatio,
          startSec: 0,
          endSec: 4,
          preset,
        },
      ],
      speakerLayoutOverrides,
      background: { mode: "color", color: "#123456" },
    }),
    brollUrl: null,
    deletedRanges: [],
  });
  const selectedSubjects = subjects.slice(0, availableSubjects);
  const automaticSegment =
    automaticFocus === "last-two" && selectedSubjects.length >= 2
      ? {
          startSec: 0,
          endSec: 4,
          layout: "two-up" as const,
          topCxNorm: selectedSubjects.at(-2)!.cxNorm,
          bottomCxNorm: selectedSubjects.at(-1)!.cxNorm,
          topCyNorm: selectedSubjects.at(-2)!.cyNorm,
          bottomCyNorm: selectedSubjects.at(-1)!.cyNorm,
          topZoom: selectedSubjects.at(-2)!.zoom,
          bottomZoom: selectedSubjects.at(-1)!.zoom,
          subjects: selectedSubjects,
        }
      : {
          startSec: 0,
          endSec: 4,
          layout: "single" as const,
          cxNorm: selectedSubjects[0]?.cxNorm ?? 0.5,
          cyNorm: selectedSubjects[0]?.cyNorm ?? 0.5,
          zoom: selectedSubjects[0]?.zoom ?? 1,
          subjects: selectedSubjects,
        };
  const analysis = clipAutoLayoutAnalysisSchema.parse({
    version: CLIP_AUTO_LAYOUT_VERSION,
    engine: CLIP_AUTO_LAYOUT_ENGINE,
    sourceIdentity: source.identity,
    analyzedAtISO: "2026-09-13T00:00:00.000Z",
    clipStartSec: 0,
    clipEndSec: 4,
    deletedRanges: [],
    editedDurationSec: 4,
    sourceWidth: source.width,
    sourceHeight: source.height,
    segments: [automaticSegment],
    noSplitSegments: [
      {
        startSec: 0,
        endSec: 4,
        layout: "single",
        cxNorm: selectedSubjects[0]?.cxNorm ?? 0.5,
        cyNorm: selectedSubjects[0]?.cyNorm ?? 0.5,
        zoom: selectedSubjects[0]?.zoom ?? 1,
        subjects: selectedSubjects,
      },
    ],
    shotCount: 1,
    soloShotCount: 1,
    multiShotCount: availableSubjects >= 2 ? 1 : 0,
    twoUpSegmentCount: automaticFocus === "last-two" ? 1 : 0,
    speakerCount: availableSubjects,
    mappedSpeakerCount: availableSubjects,
  });
  return planClipComposition({
    document,
    source,
    evidence: {
      automaticLayout: {
        state: "available",
        value: {
          sourceIdentity: source.identity,
          inputFingerprint: automaticLayoutInputFingerprint({
            sourceIdentity: source.identity,
            clipStartSec: 0,
            clipEndSec: 4,
            deletedRanges: [],
            engineVersion: CLIP_AUTO_LAYOUT_ENGINE,
          }),
          engineVersion: CLIP_AUTO_LAYOUT_ENGINE,
          analysis,
        },
      },
    },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: CLIP_AUTO_LAYOUT_ENGINE,
    },
    targets: [target],
  });
}

describe("scene layout preset catalog", () => {
  test("covers every persisted preset and exactly 43 inspected references", () => {
    expect(SCENE_LAYOUT_PRESET_CATALOG.map(({ id }) => id).sort()).toEqual(
      [...SCENE_LAYOUT_PRESETS].sort(),
    );
    const references = SCENE_LAYOUT_PRESET_CATALOG.flatMap(({ referenceId }) =>
      referenceId === null ? [] : [referenceId],
    );
    expect(references).toHaveLength(43);
    expect(new Set(references).size).toBe(43);
    expect([...references].sort((left, right) => left - right)).toEqual([
      ...Array.from({ length: 40 }, (_, index) => 153 + index),
      274,
      277,
      279,
    ]);
    expect(
      SCENE_LAYOUT_PRESET_CATALOG.find(({ referenceId }) => referenceId === 153)
        ?.id,
    ).toBe("screen-bottom");
    expect(
      SCENE_LAYOUT_PRESET_CATALOG.find(({ referenceId }) => referenceId === 161)
        ?.id,
    ).toBe("screen-bottom-circle");
    expect(
      SCENE_LAYOUT_PRESET_CATALOG.find(({ referenceId }) => referenceId === 176)
        ?.id,
    ).toBe("speakers-bottom-cards");
  });

  test("resolves every circle tile to a square on portrait and landscape canvases", () => {
    for (const definition of SCENE_LAYOUT_PRESET_CATALOG) {
      if (!definition.template.layers.some((layer) => layer.mask?.kind === "circle")) {
        continue;
      }
      for (const canvas of [
        { width: 1080, height: 1920 },
        { width: 1920, height: 1080 },
      ]) {
        const circles = resolveSceneLayoutPresetTemplate(definition.id, canvas).filter(
          (layer) => layer.mask?.kind === "circle",
        );
        expect(circles.length).toBeGreaterThan(0);
        expect(circles.every((layer) => layer.frame.width === layer.frame.height)).toBe(
          true,
        );
      }
    }
  });

  test("marks all transparent and gapped templates as background-visible", () => {
    expect(sceneLayoutPresetShowsBackground("screen-bottom-circle")).toBe(true);
    expect(sceneLayoutPresetShowsBackground("four-grid-padded")).toBe(true);
    expect(sceneLayoutPresetShowsBackground("fit")).toBe(true);
    expect(sceneLayoutPresetShowsBackground("full")).toBe(false);
    expect(sceneLayoutPresetShowsBackground("auto")).toBe(false);
  });
});

describe("extended scene layout planning", () => {
  test("keeps every preset bounded and truthful across every supported aspect", () => {
    const targets = [
      { id: "portrait", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
      { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
      { id: "landscape", aspectRatio: "16:9" as const, width: 1920, height: 1080 },
      { id: "social", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
    ];
    for (const definition of SCENE_LAYOUT_PRESET_CATALOG) {
      for (const target of targets) {
        const result = planPreset(definition.id, 4, [], "last-two", target);
        expect(result.status).toBe("ready");
        if (result.status === "invalid") throw new Error(result.error.code);
        const scene = result.plan.targets[0]!.scenes[0]!;
        const sourceLayers = scene.layers.filter(
          (layer) => layer.kind === "source-video",
        );
        expect(sourceLayers.length).toBeLessThanOrEqual(4);
        const subjectIds = sourceLayers.flatMap((layer) =>
          layer.speaker?.subjectId ? [layer.speaker.subjectId] : [],
        );
        expect(new Set(subjectIds).size).toBe(subjectIds.length);
        for (const layer of sourceLayers) {
          expect(layer.destination.x).toBeGreaterThanOrEqual(0);
          expect(layer.destination.y).toBeGreaterThanOrEqual(0);
          expect(layer.destination.x + layer.destination.width).toBeLessThanOrEqual(
            target.width,
          );
          expect(layer.destination.y + layer.destination.height).toBeLessThanOrEqual(
            target.height,
          );
          if (layer.mask?.kind === "circle") {
            expect(layer.destination.width).toBe(layer.destination.height);
          }
        }
      }
    }
  });

  test("uses four distinct observed subjects for the four-person grid", () => {
    const result = planPreset("four-grid", 4, [], "last-two");
    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    const speakers = result.plan.targets[0]!.scenes[0]!.layers.filter(
      (layer) => layer.kind === "source-video" && layer.speaker,
    );
    expect(speakers).toHaveLength(4);
    expect(new Set(speakers.map((layer) => layer.speaker?.subjectId)).size).toBe(4);
    expect(new Set(speakers.map((layer) => layer.sourceCrop.x)).size).toBe(4);
  });

  test("falls back without duplicating faces when a four-person grid has three subjects", () => {
    const result = planPreset("four-grid", 3);
    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    const fallbackLayers = result.plan.targets[0]!.scenes[0]!.layers;
    expect(
      fallbackLayers.filter(
        (layer) => layer.kind === "source-video" && layer.speaker,
      ),
    ).toHaveLength(0);
    expect(
      fallbackLayers.filter((layer) => layer.kind === "source-video"),
    ).toHaveLength(1);
    expect(result.plan.notices).toContainEqual(expect.objectContaining({
      code: "scene_layout_subjects_unavailable",
      fidelity: "degraded",
      targetId: "vertical",
      userActionPossible: true,
    }));
  });

  test("inscribes a circle in an existing non-square manual frame", () => {
    const result = planPreset("screen-bottom-circle", 1, [
      {
        id: "manual-speaker",
        aspectRatio: "9:16",
        startSec: 0,
        endSec: 4,
        layout: "single",
        layers: [
          {
            role: "single",
            frameX: 0.1,
            frameY: 0.2,
            frameWidth: 0.8,
            frameHeight: 0.4,
            rotationDeg: 3,
            cropCxNorm: 0.15,
            cropCyNorm: 0.48,
            cropZoom: 1.2,
          },
        ],
      },
    ]);
    expect(result.status).toBe("ready");
    if (result.status === "invalid") throw new Error(result.error.code);
    const speaker = result.plan.targets[0]!.scenes[0]!.layers.find(
      (layer) => layer.kind === "source-video" && layer.speaker,
    );
    expect(speaker).toMatchObject({
      kind: "source-video",
      mask: { kind: "circle" },
      rotationDeg: 3,
      speaker: { overrideId: "manual-speaker", subjectId: "speaker-a" },
    });
    expect(speaker?.destination.width).toBe(speaker?.destination.height);
  });
});
