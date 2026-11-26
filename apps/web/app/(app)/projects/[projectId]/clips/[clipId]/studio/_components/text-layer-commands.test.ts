import { describe, expect, test } from "bun:test";
import { DEFAULT_BRAND_TITLE, DEFAULT_TITLE_STYLE, TEXT_LAYER_STYLE_PRESETS, studioTextLayerSchema } from "@narriflow/validators";
import {
  applyFailureKind,
  applyTitleResultMessage,
  duplicateTextLayer,
  newBodyLayer,
  newTextLayerTiming,
  newTitleLayer,
  presetStyleFor,
  presetTarget,
  textChipRows,
  textLayerSeekTarget,
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

  test("the result reads as counts, zeros included", () => {
    expect(applyTitleResultMessage({ updated: 5, field: "title", title: { restyled: 3, created: 2, skipped: 1 } })).toEqual({
      title: "Title applied to the other clips",
      description: "Updated 3 · Added 2 · Skipped 1. Skipped clips have no title text or no room for another text layer.",
    });
    expect(applyTitleResultMessage({ updated: 0, field: "title", title: { restyled: 0, created: 0, skipped: 0 } })).toEqual({ title: "Every other clip already matches", description: "Updated 0 · Added 0 · Skipped 0" });
    // Nothing changed but a clip was skipped: it does not "already match".
    expect(applyTitleResultMessage({ updated: 0, field: "title", title: { restyled: 0, created: 0, skipped: 2 } }).title).toBe("No other clip changed");
  });

  test("a refusal is definite; a lost or unreadable answer is unknown", () => {
    const apiError = (status: number, code = "editor_document_invalid") => Object.assign(new Error("x"), { name: "ApiError", status, code });
    expect(applyFailureKind(apiError(400))).toBe("refused");
    expect(applyFailureKind(apiError(409))).toBe("refused");
    expect(applyFailureKind(apiError(0, "network_error"))).toBe("unknown");
    expect(applyFailureKind(apiError(503))).toBe("unknown");
    expect(applyFailureKind(apiError(409, "scope_changed"))).toBe("unknown");
    expect(applyFailureKind(new TypeError("Failed to fetch"))).toBe("unknown");
  });

  test("a layer is shown from its first visible frame, skipping inserted scenes", () => {
    // A layer from 2 s to 8 s with a 3 s scene inserted at 5 s: visible 2–5 and 8–11 (composite).
    const visible = [{ startSec: 2, endSec: 5 }, { startSec: 8, endSec: 11 }];
    expect(textLayerSeekTarget(visible, 3)).toBeNull();
    expect(textLayerSeekTarget(visible, 9)).toBeNull();
    // In the scene's gap, or outside the layer: its first visible frame.
    expect(textLayerSeekTarget(visible, 6)).toBe(2);
    expect(textLayerSeekTarget(visible, 0)).toBe(2);
    expect(textLayerSeekTarget(visible, 11)).toBe(2);
    expect(textLayerSeekTarget([], 4)).toBeNull();
  });

  test("overlapping chips stack into rows; a chip takes the first row it fits", () => {
    const at = (id: string, startSec: number, endSec: number | null) => ({ id, startSec, endSec });
    // A duplicate over its original goes to row 1; a later chip that fits after the first returns to row 0.
    const { rows, count } = textChipRows([at("a", 0, 5), at("b", 0, 5), at("c", 5, 8), at("d", 4, null)], 30);
    expect(Object.fromEntries(rows)).toEqual({ a: 0, b: 1, c: 0, d: 2 });
    expect(count).toBe(3);
    // Touching chips share a row; no layers still has one row.
    expect(textChipRows([at("a", 0, 2), at("b", 2, 4)], 10).count).toBe(1);
    expect(textChipRows([], 10).count).toBe(1);
  });
});
