import { describe, expect, test } from "bun:test";
import {
  activeSceneLayoutChoice,
  applySceneLayoutChoice,
  sceneLayoutEvidenceHint,
} from "./layout-panel-model";

const scene = {
  startSec: 4,
  endSec: 8,
  speakerLayerCount: 2,
};

describe("scene layout panel model", () => {
  test("replaces only the source scene at the playhead", () => {
    const selections = applySceneLayoutChoice({
      selections: [],
      aspectRatio: "9:16",
      scene,
      applyToAllScenes: false,
      editedDurationSec: 20,
      choice: "side-by-side",
      id: "layout-1",
    });
    expect(selections).toEqual([
      {
        id: "layout-1",
        aspectRatio: "9:16",
        startSec: 4,
        endSec: 8,
        preset: "side-by-side",
      },
    ]);
    expect(activeSceneLayoutChoice(selections, "9:16", scene)).toBe(
      "side-by-side",
    );
  });

  test("apply to all scenes stays inside the current clip", () => {
    expect(
      applySceneLayoutChoice({
        selections: [],
        aspectRatio: "1:1",
        scene,
        applyToAllScenes: true,
        editedDurationSec: 18,
        choice: "fit",
        id: "layout-all",
      }),
    ).toEqual([
      {
        id: "layout-all",
        aspectRatio: "1:1",
        startSec: 0,
        endSec: 18,
        preset: "fit",
      },
    ]);
  });

  test("Auto is an explicit scene choice separate from clip default", () => {
    expect(
      applySceneLayoutChoice({
        selections: [],
        aspectRatio: "16:9",
        scene,
        applyToAllScenes: false,
        editedDurationSec: 20,
        choice: "auto",
        id: "layout-auto",
      }),
    ).toEqual([
      {
        id: "layout-auto",
        aspectRatio: "16:9",
        startSec: 4,
        endSec: 8,
        preset: "auto",
      },
    ]);
  });

  test("clip default removes the target interval and leaves other aspect ratios", () => {
    const selections = [
      {
        id: "vertical",
        aspectRatio: "9:16" as const,
        startSec: 0,
        endSec: 12,
        preset: "stacked" as const,
      },
      {
        id: "square",
        aspectRatio: "1:1" as const,
        startSec: 0,
        endSec: 12,
        preset: "center" as const,
      },
    ];
    const next = applySceneLayoutChoice({
      selections,
      aspectRatio: "9:16",
      scene,
      applyToAllScenes: false,
      editedDurationSec: 12,
      choice: "clip-default",
      id: "unused",
    });
    expect(next.map(({ aspectRatio, startSec, endSec, preset }) => ({
      aspectRatio,
      startSec,
      endSec,
      preset,
    }))).toEqual([
      { aspectRatio: "1:1", startSec: 0, endSec: 12, preset: "center" },
      { aspectRatio: "9:16", startSec: 0, endSec: 4, preset: "stacked" },
      { aspectRatio: "9:16", startSec: 8, endSec: 12, preset: "stacked" },
    ]);
  });

  test("keeps evidence-dependent choices selectable while explaining analysis", () => {
    expect(sceneLayoutEvidenceHint("stacked", { ...scene, speakerLayerCount: 0 })).toBe(
      "speaker-analysis",
    );
    expect(sceneLayoutEvidenceHint("screen-top", scene)).toBe("ready");
    expect(
      sceneLayoutEvidenceHint("side-by-side", {
        ...scene,
        speakerLayerCount: 1,
        speakerAnalysisStatus: "available",
      }),
    ).toBe("speaker-count");
    expect(sceneLayoutEvidenceHint("inset", { ...scene, speakerLayerCount: 0 })).toBe(
      "speaker-analysis",
    );
    expect(sceneLayoutEvidenceHint("center", null)).toBe("ready");
  });

  test("uses the catalog's exact three and four-speaker requirements", () => {
    expect(
      sceneLayoutEvidenceHint("three-top", {
        ...scene,
        speakerLayerCount: 3,
        speakerAnalysisStatus: "available",
      }),
    ).toBe("ready");
    expect(
      sceneLayoutEvidenceHint("four-grid", {
        ...scene,
        speakerLayerCount: 3,
        speakerAnalysisStatus: "available",
      }),
    ).toBe("speaker-count");
    expect(
      sceneLayoutEvidenceHint("four-grid", {
        ...scene,
        speakerLayerCount: 4,
        speakerAnalysisStatus: "available",
      }),
    ).toBe("ready");
  });

  test("does not create schema-invalid selections for scenes under 75ms", () => {
    const selections = [
      {
        id: "existing",
        aspectRatio: "9:16" as const,
        startSec: 1,
        endSec: 2,
        preset: "fit" as const,
      },
    ];
    expect(
      applySceneLayoutChoice({
        selections,
        aspectRatio: "9:16",
        scene: { ...scene, startSec: 4, endSec: 4.05 },
        applyToAllScenes: false,
        editedDurationSec: 20,
        choice: "center",
        id: "too-short",
      }),
    ).toEqual(selections);
  });
});
