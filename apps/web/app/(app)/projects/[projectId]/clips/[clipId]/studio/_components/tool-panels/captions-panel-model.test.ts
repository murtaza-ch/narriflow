import { describe, expect, test } from "bun:test";
import { CAPTION_DYNAMIC_STYLES, applyEditorAction, editorDocumentSchema, DEFAULT_CAPTION_PRESET, studioEditsSchema, EDITOR_DOCUMENT_VERSION } from "@narriflow/validators";
import type { CaptionBlock, CaptionWordRole } from "@narriflow/validators";
import {
  captionPanelColors,
  captionEmphasisChanges,
  captionEmphasisFits,
  captionEmphasisRow,
  captionPanelAnimations,
} from "./captions-panel-model";

const TEXTS = ["we", "grew", "revenue", "fast"];
const KEYS = ["1000", "1200", "1500", "1900"];

function layer(roles: readonly CaptionWordRole[], keys: readonly (string | null)[] = KEYS) {
  const block: CaptionBlock = { style: "headline", roles, texts: TEXTS, keys, rows: [[0, 1, 2, 3]], seed: 7 };
  return { block, words: TEXTS.map((text, index) => ({ text, startSec: index, endSec: index + 0.5 })) };
}

/** Applies a gesture's changes the way the Studio dispatches them. */
function apply(overrides: Record<string, "hero" | "pair" | "plain">, changes: ReturnType<typeof captionEmphasisChanges>) {
  let doc = editorDocumentSchema.parse({
    version: EDITOR_DOCUMENT_VERSION,
    clipStartSec: 0,
    clipEndSec: 10,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({ captionEmphasis: overrides }),
    brollUrl: null,
    deletedRanges: [],
    sceneBlocks: [],
    censorSegments: [],
    mediaMotions: [],
  });
  for (const change of changes) {
    doc = applyEditorAction(doc, { type: "setCaptionEmphasis", keys: [...change.keys], value: change.value });
  }
  return doc.studioEdits.captionEmphasis ?? {};
}

describe("captionPanelColors", () => {
  test("a style without a hero (Cutout) has no Hero colour; Accent shows only where the style draws it", () => {
    expect(captionPanelColors(CAPTION_DYNAMIC_STYLES.headline)).toEqual(["text", "hero"]);
    expect(captionPanelColors(CAPTION_DYNAMIC_STYLES.marker)).toEqual(["text", "hero", "accent"]);
    expect(captionPanelColors(CAPTION_DYNAMIC_STYLES.cutout)).toEqual(["text", "accent"]);
  });
});

describe("captionPanelAnimations", () => {
  test("classic presets never list dynamic-only motions", () => {
    const classic = captionPanelAnimations(null);
    expect(classic).toContain("pop");
    expect(classic).toContain("jelly");
    expect(classic).not.toContain("slide");
  });

  test("dynamic presets list word-reveal motions without an effect, including slide", () => {
    const dynamic = captionPanelAnimations(CAPTION_DYNAMIC_STYLES.headline);
    expect(dynamic).toContain("slide");
    expect(dynamic).toContain("rise");
    expect(dynamic).not.toContain("jelly");
    expect(dynamic).not.toContain("focus");
  });
});

describe("captionEmphasisRow", () => {
  test("one chip per word, the hero filled, auto when nothing is overridden", () => {
    const row = captionEmphasisRow(layer(["minor", "body", "hero", "body"]), {});
    expect(row?.chips.map((chip) => [chip.text, chip.hero])).toEqual([
      ["we", false],
      ["grew", false],
      ["revenue", true],
      ["fast", false],
    ]);
    expect(row).toMatchObject({ editable: true, mode: "auto", canJoin: true, joined: false });
  });

  test("a 2-word hero is one joined chip", () => {
    const row = captionEmphasisRow(layer(["minor", "body", "hero", "hero"]), { "1500": "pair" });
    expect(row?.chips.map((chip) => chip.text)).toEqual(["we", "grew", "revenue fast"]);
    expect(row?.chips[2]?.indices).toEqual([2, 3]);
    expect(row).toMatchObject({ mode: "custom", joined: true, canJoin: false });
  });

  test("no emphasis when every word of the cue is plain; a last-word hero cannot join", () => {
    expect(captionEmphasisRow(layer(["minor", "body", "body", "body"]), Object.fromEntries(KEYS.map((key) => [key, "plain"])))?.mode).toBe("none");
    expect(captionEmphasisRow(layer(["minor", "body", "body", "hero"]), {})?.canJoin).toBe(false);
  });

  test("dub cues (no Word Keys) are read-only; classic layers have no row", () => {
    const dub = captionEmphasisRow(layer(["minor", "body", "hero", "body"], [null, null, null, null]), {});
    expect(dub).toMatchObject({ editable: false, canJoin: false });
    expect(captionEmphasisRow({ words: [] }, {})).toBeNull();
  });
});

describe("captionEmphasisChanges", () => {
  const heroThird = layer(["minor", "body", "hero", "body"]);

  test("a tap makes that word the hero and clears the cue's other overrides", () => {
    const next = apply({ "1500": "hero", "1900": "plain", "9000": "hero" }, captionEmphasisChanges(heroThird, { kind: "hero", index: 1 }));
    expect(next).toEqual({ "1200": "hero", "9000": "hero" });
  });

  test("join pairs the hero with the next word; unjoin makes it single again", () => {
    expect(apply({}, captionEmphasisChanges(heroThird, { kind: "join" }))).toEqual({ "1500": "pair" });
    const joined = layer(["minor", "body", "hero", "hero"]);
    expect(apply({ "1500": "pair" }, captionEmphasisChanges(joined, { kind: "unjoin" }))).toEqual({ "1500": "hero" });
  });

  test("no emphasis writes plain for every word; auto clears only this cue", () => {
    expect(apply({ "9000": "hero" }, captionEmphasisChanges(heroThird, { kind: "none" }))).toEqual({
      "1000": "plain",
      "1200": "plain",
      "1500": "plain",
      "1900": "plain",
      "9000": "hero",
    });
    expect(apply({ "1200": "hero", "9000": "hero" }, captionEmphasisChanges(heroThird, { kind: "auto" }))).toEqual({ "9000": "hero" });
  });

  test("dub cues produce no changes", () => {
    expect(captionEmphasisChanges(layer(["minor", "body", "hero", "body"], [null, null, null, null]), { kind: "hero", index: 0 })).toEqual([]);
  });

  test("captionEmphasisFits refuses changes past the 2,000 cap", () => {
    const full = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [String(10_000 + index), "plain" as const]));
    expect(captionEmphasisFits(full, captionEmphasisChanges(heroThird, { kind: "hero", index: 0 }))).toBe(false);
    expect(captionEmphasisFits(full, captionEmphasisChanges(heroThird, { kind: "auto" }))).toBe(true);
    expect(captionEmphasisFits({}, captionEmphasisChanges(heroThird, { kind: "none" }))).toBe(true);
  });
});
