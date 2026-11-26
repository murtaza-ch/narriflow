import { describe, expect, test } from "bun:test";
import { DEFAULT_BRAND_TITLE, DEFAULT_TITLE_STYLE, TEXT_LAYER_STYLE_PRESETS, studioTextLayerSchema } from "@narriflow/validators";
import {
  applyTitleResultMessage,
  duplicateTextLayer,
  newBodyLayer,
  newTextLayerTiming,
  newTitleLayer,
  presetStyleFor,
  presetTarget,
  titlePatchOf,
} from "./text-layer-commands";

const layer = (id: string, role: "title" | "body") => studioTextLayerSchema.parse({ id, role, text: id });

describe("Text Layer commands", () => {
  test("a new layer starts at the playhead and lasts 5 s, clamped to the clip", () => {
    expect(newTextLayerTiming(2, 30)).toEqual({ startSec: 2, endSec: 7 });
    expect(newTextLayerTiming(28, 30)).toEqual({ startSec: 28, endSec: 30 });
    expect(newTextLayerTiming(30, 30)).toEqual({ startSec: 29.5, endSec: 30 });
    // Shorter than the minimum: the footage wins.
    expect(newTextLayerTiming(0.2, 0.4)).toEqual({ startSec: 0, endSec: null });
  });

  test("a new title takes the clip's title, else the hook text, in the brand title settings", () => {
    const title = newTitleLayer({ id: "t", clipTitle: "My clip title", hookText: "hook", clipDurationSec: 30 });
    expect(title).toMatchObject({ role: "title", text: "My clip title", startSec: 0, endSec: 5, positionY: DEFAULT_BRAND_TITLE.positionY });
    expect(title.style).toEqual(DEFAULT_TITLE_STYLE);
    expect(newTitleLayer({ id: "t", clipTitle: "  ", hookText: "The hook", clipDurationSec: 3 })).toMatchObject({ text: "The hook", endSec: 3 });
    expect(newTitleLayer({ id: "t", clipTitle: null, hookText: null, clipDurationSec: 3 }).text).toBe("Your title");
    expect(() => studioTextLayerSchema.parse(newTitleLayer({ id: "t", clipTitle: "x".repeat(400), hookText: null, clipDurationSec: 30 }))).not.toThrow();
  });

  test("a new body layer parses and sits at the playhead", () => {
    const body = newBodyLayer({ id: "b", playheadSec: 4, clipDurationSec: 30 });
    expect(studioTextLayerSchema.parse(body)).toMatchObject({ role: "body", startSec: 4, endSec: 9 });
  });

  test("a duplicated title is body text", () => {
    expect(duplicateTextLayer(layer("a", "title"), "b")).toMatchObject({ id: "b", role: "body" });
  });

  test("a preset card restyles the selection, else the title, else adds a title", () => {
    const layers = [layer("body", "body"), layer("title", "title")];
    expect(presetTarget(layers, "body")).toEqual({ kind: "restyle", id: "body" });
    expect(presetTarget(layers, null)).toEqual({ kind: "restyle", id: "title" });
    expect(presetTarget([layer("body", "body")], null)).toEqual({ kind: "add" });
  });

  test("a preset keeps the layer's size", () => {
    const sized = { ...layer("a", "title"), style: { ...DEFAULT_TITLE_STYLE, fontSize: 90 } };
    expect(presetStyleFor(sized, TEXT_LAYER_STYLE_PRESETS[2]!.style)).toMatchObject({ fontSize: 90, font: TEXT_LAYER_STYLE_PRESETS[2]!.style.font });
  });

  test("the Apply-to-all patch carries everything but the words", () => {
    const title = { ...layer("t", "title"), startSec: 1, endSec: undefined };
    expect(titlePatchOf(title)).toEqual({ style: title.style, positionX: 50, positionY: 12, widthPct: 86, startSec: 1, endSec: null });
  });

  test("the result reads as counts", () => {
    expect(applyTitleResultMessage({ updated: 5, field: "title", title: { restyled: 3, created: 2, skipped: 1 } })).toEqual({
      title: "Updated the title on 3 clips and added a title to 2 clips",
      description: "1 clip skipped: no title text, or no room for another text layer.",
    });
    expect(applyTitleResultMessage({ updated: 0, field: "title", title: { restyled: 0, created: 0, skipped: 0 } }).title).toBe("Every other clip already matches");
  });
});
