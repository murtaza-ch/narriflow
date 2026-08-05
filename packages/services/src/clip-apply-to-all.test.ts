import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPTION_PRESET,
  captionPresetSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  captionPresetBulkApplyIsNoop,
  groupClipsByMergedStudioEdits,
} from "./clip.service";

describe("captionPresetBulkApplyIsNoop (HIGH: applyCaptionPresetToAllClips no-op guard)", () => {
  test("identical presets (both DEFAULT_CAPTION_PRESET) are a no-op", () => {
    expect(
      captionPresetBulkApplyIsNoop(DEFAULT_CAPTION_PRESET, DEFAULT_CAPTION_PRESET),
    ).toBe(true);
  });

  test("re-applying the same non-default preset is a no-op", () => {
    const preset = captionPresetSchema.parse({ fontName: "Bebas Neue" });
    const sameShape = captionPresetSchema.parse({ fontName: "Bebas Neue" });
    expect(captionPresetBulkApplyIsNoop(preset, sameShape)).toBe(true);
  });

  test("a genuinely different preset is NOT a no-op", () => {
    const existing = DEFAULT_CAPTION_PRESET;
    const incoming = captionPresetSchema.parse({ fontName: "Impact" });
    expect(captionPresetBulkApplyIsNoop(existing, incoming)).toBe(false);
  });
});

describe("groupClipsByMergedStudioEdits (MEDIUM: batched apply-to-all writes)", () => {
  const defaults = studioEditsSchema.parse({});
  const withRedBackground = studioEditsSchema.parse({
    background: { mode: "color", color: "#ff0000", imageUrl: null },
  });
  const withBlueBackground = studioEditsSchema.parse({
    background: { mode: "color", color: "#0000ff", imageUrl: null },
  });

  test("collapses rows with an identical merged document into one group", () => {
    const groups = groupClipsByMergedStudioEdits([
      { id: "clip-1", merged: defaults },
      { id: "clip-2", merged: defaults },
      { id: "clip-3", merged: defaults },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ids.sort()).toEqual(["clip-1", "clip-2", "clip-3"]);
    expect(groups[0]!.merged).toEqual(defaults);
  });

  test("keeps rows with distinct merged documents in separate groups", () => {
    const groups = groupClipsByMergedStudioEdits([
      { id: "clip-1", merged: withRedBackground },
      { id: "clip-2", merged: withBlueBackground },
      { id: "clip-3", merged: withRedBackground },
    ]);
    expect(groups).toHaveLength(2);
    const redGroup = groups.find((g) => g.merged === withRedBackground);
    const blueGroup = groups.find((g) => g.merged === withBlueBackground);
    expect(redGroup?.ids.sort()).toEqual(["clip-1", "clip-3"]);
    expect(blueGroup?.ids).toEqual(["clip-2"]);
  });

  test("empty input produces no groups", () => {
    expect(groupClipsByMergedStudioEdits([])).toEqual([]);
  });

  test("every input row's id is accounted for across all groups exactly once", () => {
    const rows = [
      { id: "a", merged: defaults },
      { id: "b", merged: withRedBackground },
      { id: "c", merged: defaults },
      { id: "d", merged: withBlueBackground },
      { id: "e", merged: withRedBackground },
    ];
    const groups = groupClipsByMergedStudioEdits(rows);
    const allIds = groups.flatMap((g) => g.ids).sort();
    expect(allIds).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("a framing-only patch (vizard-parity Phase C-2 stage 1) also groups correctly", () => {
    const withCenterFraming = studioEditsSchema.parse({
      framing: { mode: "center" },
    });
    const groups = groupClipsByMergedStudioEdits([
      { id: "clip-1", merged: defaults },
      { id: "clip-2", merged: withCenterFraming },
      { id: "clip-3", merged: withCenterFraming },
    ]);
    expect(groups).toHaveLength(2);
    const centerGroup = groups.find((g) => g.merged === withCenterFraming);
    expect(centerGroup?.ids.sort()).toEqual(["clip-2", "clip-3"]);
  });
});
