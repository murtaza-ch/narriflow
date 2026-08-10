import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPTION_PRESET } from "./caption-preset";
import { applyEditorAction, editorDocumentSchema } from "./editor-document";
import {
  defaultSpeakerLayersForSegment,
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
});
