import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPTION_PRESET } from "./caption-preset";
import { applyEditorAction, editorDocumentSchema } from "./editor-document";
import {
  defaultSpeakerLayersForSegment,
  removeSpeakerLayoutOverrideRange,
  resolveSpeakerLayoutScene,
  speakerLayoutOverrideFromScene,
  studioSpeakerLayoutOverrideSchema,
} from "./speaker-layout-overrides";
import { studioEditsSchema } from "./studio-edits";

const twoUp = {
  startSec: 2,
  endSec: 8,
  layout: "two-up" as const,
  topCxNorm: 0.28,
  bottomCxNorm: 0.72,
  topCyNorm: 0.42,
  bottomCyNorm: 0.44,
  topZoom: 1.2,
  bottomZoom: 1.1,
};

describe("speaker layout overrides", () => {
  test("removes a range while preserving other aspects and valid remainders", () => {
    const base = speakerLayoutOverrideFromScene(
      resolveSpeakerLayoutScene({ ...twoUp, startSec: 0, endSec: 10 }, [], "9:16"),
      "9:16",
      "portrait",
    );
    const landscape = { ...base, id: "landscape", aspectRatio: "16:9" as const };

    const next = removeSpeakerLayoutOverrideRange([base, landscape], {
      aspectRatio: "9:16",
      startSec: 3,
      endSec: 7,
    });

    expect(next).toHaveLength(3);
    expect(next.find((override) => override.id === "landscape")).toBe(landscape);
    const portrait = next.filter((override) => override.aspectRatio === "9:16");
    expect(portrait.map(({ startSec, endSec }) => [startSec, endSec])).toEqual([
      [0, 3],
      [7, 10],
    ]);
    expect(new Set(portrait.map((override) => override.id)).size).toBe(2);
    expect(portrait.every((override) => override.layers === base.layers)).toBe(true);
  });

  test("drops manual-transform remainders shorter than a renderable scene", () => {
    const base = speakerLayoutOverrideFromScene(
      resolveSpeakerLayoutScene({ ...twoUp, startSec: 0, endSec: 10 }, [], "9:16"),
      "9:16",
      "portrait",
    );

    expect(
      removeSpeakerLayoutOverrideRange([base], {
        aspectRatio: "9:16",
        startSec: 0.05,
        endSec: 9.95,
      }),
    ).toEqual([]);
  });

  test("derives independently editable default layers from a two-up scene", () => {
    const layers = defaultSpeakerLayersForSegment(twoUp);
    expect(layers.map((layer) => layer.role)).toEqual(["top", "bottom"]);
    expect(layers[0]).toMatchObject({
      frameY: 0,
      frameHeight: 0.5,
      cropCxNorm: 0.28,
      cropZoom: 1.2,
    });
    expect(layers[1]).toMatchObject({ frameY: 0.5, cropCxNorm: 0.72 });
  });

  test("resolves only the matching aspect and tolerates a small boundary shift", () => {
    const base = resolveSpeakerLayoutScene(twoUp, [], "9:16");
    base.layers[0] = { ...base.layers[0]!, frameX: 0.1, frameWidth: 0.8 };
    const override = speakerLayoutOverrideFromScene(base, "9:16", "scene-1");
    override.startSec += 0.08;
    override.endSec -= 0.08;

    expect(resolveSpeakerLayoutScene(twoUp, [override], "9:16").layers[0]!.frameX).toBe(0.1);
    expect(resolveSpeakerLayoutScene(twoUp, [override], "1:1").overrideId).toBeNull();
  });

  test("rejects malformed role sets", () => {
    const malformed = {
      ...speakerLayoutOverrideFromScene(
        resolveSpeakerLayoutScene(twoUp, [], "9:16"),
        "9:16",
        "scene-1",
      ),
      layers: [defaultSpeakerLayersForSegment(twoUp)[0]],
    };
    expect(studioSpeakerLayoutOverrideSchema.safeParse(malformed).success).toBe(false);
  });

  test("rejects layer frames that extend outside the output canvas", () => {
    const malformed = speakerLayoutOverrideFromScene(
      resolveSpeakerLayoutScene(twoUp, [], "9:16"),
      "9:16",
      "scene-1",
    );
    malformed.layers[0] = {
      ...malformed.layers[0]!,
      frameX: 0.25,
      frameWidth: 0.9,
    };
    expect(studioSpeakerLayoutOverrideSchema.safeParse(malformed).success).toBe(false);
  });

  test("ripple delete rebases an override and drops one whose scene is removed", () => {
    const scene = resolveSpeakerLayoutScene(twoUp, [], "9:16");
    const keep = speakerLayoutOverrideFromScene(scene, "9:16", "keep");
    const removed = studioSpeakerLayoutOverrideSchema.parse({
      ...keep,
      id: "removed",
      startSec: 10,
      endSec: 12,
    });
    const doc = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 20,
      captionPreset: DEFAULT_CAPTION_PRESET,
      transcriptSlice: [],
      studioEdits: {
        ...studioEditsSchema.parse(undefined),
        speakerLayoutOverrides: [keep, removed],
      },
      brollUrl: null,
      deletedRanges: [],
    });
    const next = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 10, endSec: 12 },
    });
    expect(next.studioEdits.speakerLayoutOverrides.map((item) => item.id)).toEqual(["keep"]);
    expect(next.studioEdits.speakerLayoutOverrides[0]).toMatchObject({
      startSec: 2,
      endSec: 8,
    });
  });

  test("ripple delete before a scene shifts its timing without changing either speaker", () => {
    const scene = resolveSpeakerLayoutScene(
      { ...twoUp, startSec: 10, endSec: 16 },
      [],
      "9:16",
    );
    scene.layers[0] = {
      ...scene.layers[0]!,
      cropZoom: 1.6,
      rotationDeg: -7,
    };
    scene.layers[1] = {
      ...scene.layers[1]!,
      cropZoom: 1.8,
      frameX: 0.08,
      frameWidth: 0.92,
    };
    const override = speakerLayoutOverrideFromScene(scene, "9:16", "shifted");
    const doc = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 20,
      captionPreset: DEFAULT_CAPTION_PRESET,
      transcriptSlice: [],
      studioEdits: {
        ...studioEditsSchema.parse(undefined),
        speakerLayoutOverrides: [override],
      },
      brollUrl: null,
      deletedRanges: [],
    });

    const next = applyEditorAction(doc, {
      type: "deleteRange",
      range: { startSec: 2, endSec: 4 },
    });
    expect(next.studioEdits.speakerLayoutOverrides).toHaveLength(1);
    expect(next.studioEdits.speakerLayoutOverrides[0]).toMatchObject({
      id: "shifted",
      startSec: 8,
      endSec: 14,
      layers: override.layers,
    });
  });
});
