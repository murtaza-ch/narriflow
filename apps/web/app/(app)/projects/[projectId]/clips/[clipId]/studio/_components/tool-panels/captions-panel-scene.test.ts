import { describe, expect, test } from "bun:test";
import { CAPTION_POSITION_Y_DEFAULTS, captionSceneDefaultPositionY, getCaptionPresetById } from "@narriflow/validators";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { captionEmphasisChanges, captionEmphasisRow, captionPanelScene, captionPanelStyle, captionPositionReset } from "./captions-panel-model";

/** A Scene Style cue is edited in the Emphasis row exactly like a Caption Block cue (spec 3.3, panel). */

const layer = {
  words: ["it's", "all", "about", "talent"].map((text, index) => ({ text, startSec: index, endSec: index + 1 })),
  scene: { roles: ["minor", "minor", "minor", "hero"] as const, keys: ["k0", "k1", "k2", "k3"], speaker: null },
} as unknown as Pick<CompositionCaptionVisualLayer, "block" | "words" | "scene">;

describe("Captions panel for a Scene Style", () => {
  test("the preset is a scene, not a Dynamic Style", () => {
    const reveal = getCaptionPresetById("reveal")!.preset;
    expect(captionPanelScene(reveal)?.name).toBe("Reveal");
    expect(captionPanelStyle(reveal)).toBeNull();
    expect(captionPanelScene(getCaptionPresetById("headline")!.preset)).toBeNull();
  });

  test("the Emphasis row reads the scene's roles and keys", () => {
    const row = captionEmphasisRow(layer, undefined)!;
    expect(row.chips.map((chip) => [chip.text, chip.hero])).toEqual([["it's", false], ["all", false], ["about", false], ["talent", true]]);
    expect(row.editable).toBe(true);
  });

  test("picking a hero changes the cue's overrides by Word Key", () => {
    expect(captionEmphasisChanges(layer, { kind: "hero", index: 1 })).toEqual([{ keys: ["k0", "k1", "k2", "k3"], value: null }, { keys: ["k1"], value: "hero" }]);
  });
});

describe("Reset of a moved caption (fix 7)", () => {
  const reveal = getCaptionPresetById("reveal")!.preset;
  const defaultY = captionSceneDefaultPositionY("reveal");

  test("a Scene Style at its template's anchor line has nothing to reset", () => {
    expect(captionPositionReset(reveal)).toBeNull();
    expect(captionPositionReset({ ...reveal, positionY: defaultY })).toBeNull();
  });

  test("Top, Center and Bottom store only a Y, and that is a move to reset", () => {
    for (const position of ["top", "center", "bottom"] as const) {
      const chosen = { ...reveal, position, positionX: undefined, positionY: CAPTION_POSITION_Y_DEFAULTS[position] };
      expect(Math.abs(CAPTION_POSITION_Y_DEFAULTS[position] - defaultY)).toBeGreaterThan(0.05);
      const patch = captionPositionReset(chosen);
      expect(patch).not.toBeNull();
      // Reset puts the template's own anchor line and the preset's own position chip back.
      const reset = { ...chosen, ...patch };
      expect(reset.positionX).toBeUndefined();
      expect(reset.positionY).toBeUndefined();
      expect(reset.position).toBe(reveal.position);
    }
  });

  test("a drag stores both coordinates; an X alone off centre counts too", () => {
    expect(captionPositionReset({ ...reveal, positionX: 30, positionY: 40 })).not.toBeNull();
    expect(captionPositionReset({ ...reveal, positionX: 30 })).not.toBeNull();
    expect(captionPositionReset({ ...reveal, positionX: 50, positionY: defaultY })).toBeNull();
  });

  test("a classic caption keeps its rule: moved when a drag stored a position", () => {
    const headline = getCaptionPresetById("headline")!.preset;
    expect(captionPositionReset(headline)).toBeNull();
    expect(captionPositionReset({ ...headline, positionY: 20 })).toBeNull();
    expect(captionPositionReset({ ...headline, positionX: 20, positionY: 20 })).toEqual({ positionX: undefined, positionY: undefined });
  });
});
