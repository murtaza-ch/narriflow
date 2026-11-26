import { describe, expect, test } from "bun:test";
import { captionFontFace } from "./caption-font";
import { brandTemplateSnapshotSchema } from "./brand-template";
import { applyStudioEditsToAllSchema, studioEditsEqual, studioEditsSchema } from "./studio-edits";
import {
  DEFAULT_BRAND_TITLE,
  DEFAULT_TITLE_STYLE,
  TEXT_LAYER_FONTS,
  TEXT_LAYER_STYLE_PRESETS,
  brandTitleSchema,
  cutTitleText,
  findTitleLayer,
  resolveTextLayerFace,
  studioTextLayerSchema,
  textLayerStyleSchema,
  titleTextLayer,
  type TextLayerFontFamilyFaces,
} from "./text-layer";

const BODY_STYLE = {
  font: "Inter",
  fontAsset: null,
  fontSize: 48,
  bold: true,
  italic: false,
  underline: false,
  textCase: "none",
  align: "center",
  lineHeight: 1.2,
  color: "#FFFFFF",
  stroke: { color: "#000000", width: 3 },
  shadow: null,
  background: null,
};

/**
 * A real old stored layer, verbatim: the render golden document `text-layers-transition`
 * (apps/media/src/__fixtures__/render-golden/documents.json) held it before ticket 02 rewrote that
 * document to the new shape.
 */
const OLD_LAYER = {
  id: "title",
  text: "Don't miss: 50% off",
  startSec: 0.3,
  endSec: 3.2,
  positionX: 50,
  positionY: 22,
  fontName: "Montserrat",
  fontSize: 64,
  color: "#FFFFFF",
  backgroundColor: "#000000",
  backgroundOpacity: 0.5,
  bold: true,
  outlineColor: "#000000",
  outlineWidth: 3,
};

describe("Text Layer schema", () => {
  test("{ id, text } parses to a body layer in the full default style", () => {
    expect(studioTextLayerSchema.parse({ id: "a", text: "Hello" })).toEqual({
      id: "a",
      role: "body",
      text: "Hello",
      startSec: 0,
      positionX: 50,
      positionY: 12,
      widthPct: 86,
      style: BODY_STYLE,
    } as never);
  });

  test("an old stored layer keeps its words, timing and place and loads in the default style", () => {
    for (const old of [OLD_LAYER]) {
      const parsed = studioTextLayerSchema.parse(old);
      expect(parsed).toEqual({
        id: old.id as string,
        role: "body",
        text: old.text as string,
        startSec: old.startSec as number,
        endSec: old.endSec as number,
        positionX: old.positionX as number,
        positionY: old.positionY as number,
        widthPct: 86,
        style: BODY_STYLE,
      } as never);
      expect("fontName" in parsed).toBe(false);
    }
  });

  test("an old layer inside a whole studioEdits parses", () => {
    const edits = studioEditsSchema.parse({ textLayers: [OLD_LAYER] });
    expect(edits.textLayers[0]!.style).toEqual(BODY_STYLE as never);
  });

  test("text of only whitespace or newlines is refused; inner newlines are kept", () => {
    for (const text of ["", "   ", "\n\n", " \n \t\n "]) {
      expect(studioTextLayerSchema.safeParse({ id: "a", text }).success).toBe(false);
    }
    expect(studioTextLayerSchema.parse({ id: "a", text: "\n one\n\ntwo \n" }).text).toBe("one\n\ntwo");
  });

  test("endSec stays optional and must follow startSec", () => {
    expect(studioTextLayerSchema.parse({ id: "a", text: "x" }).endSec).toBeUndefined();
    expect(studioTextLayerSchema.parse({ id: "a", text: "x", endSec: null }).endSec).toBeNull();
    expect(studioTextLayerSchema.safeParse({ id: "a", text: "x", startSec: 2, endSec: 2 }).success).toBe(false);
  });

  test("nested defaults are fresh objects per parse (prefault, not a shared default value)", () => {
    const one = studioTextLayerSchema.parse({ id: "a", text: "x" });
    const two = studioTextLayerSchema.parse({ id: "b", text: "y" });
    expect(one.style).not.toBe(two.style);
    expect(one.style.stroke).not.toBe(two.style.stroke);
    (one.style.stroke as { width: number }).width = 9;
    expect(two.style.stroke!.width).toBe(3);
    expect(textLayerStyleSchema.parse({}).stroke!.width).toBe(3);
  });

  test("a partial style fills the rest from the defaults; unknown keys are stripped", () => {
    const layer = studioTextLayerSchema.parse({ id: "a", text: "x", style: { italic: true, legacy: 1 }, extra: true });
    expect(layer.style).toEqual({ ...BODY_STYLE, italic: true } as never);
    expect("extra" in layer).toBe(false);
  });

  test("findTitleLayer takes the first title", () => {
    const layers = [
      studioTextLayerSchema.parse({ id: "b", text: "body" }),
      studioTextLayerSchema.parse({ id: "t1", role: "title", text: "one" }),
      studioTextLayerSchema.parse({ id: "t2", role: "title", text: "two" }),
    ];
    expect(findTitleLayer(layers)?.id).toBe("t1");
    expect(findTitleLayer(layers.slice(0, 1))).toBeUndefined();
  });
});

describe("title constants", () => {
  test("the default title is bold black Inter on white rounded line boxes", () => {
    expect(DEFAULT_TITLE_STYLE).toEqual({
      ...BODY_STYLE,
      color: "#000000",
      stroke: null,
      background: { color: "#FFFFFF", opacity: 1, corners: "rounded", display: "line" },
    } as never);
  });

  test("six presets, each a complete style, the second the default title", () => {
    expect(TEXT_LAYER_STYLE_PRESETS).toHaveLength(6);
    expect(new Set(TEXT_LAYER_STYLE_PRESETS.map((preset) => preset.id)).size).toBe(6);
    for (const preset of TEXT_LAYER_STYLE_PRESETS) expect(textLayerStyleSchema.parse(preset.style)).toEqual(preset.style);
    expect(TEXT_LAYER_STYLE_PRESETS[1]!.style).toEqual(DEFAULT_TITLE_STYLE);
  });

  test("brand title: {} is the built-in default; the style default is a fresh parsed copy", () => {
    expect(DEFAULT_BRAND_TITLE).toEqual({ enabled: true, durationSec: 5, positionX: 50, positionY: 12, widthPct: 86, style: DEFAULT_TITLE_STYLE });
    const parsed = brandTitleSchema.parse({});
    expect(parsed.style).not.toBe(DEFAULT_TITLE_STYLE);
    expect(brandTitleSchema.parse({ style: { color: "#FF0000" } }).style).toEqual({ ...DEFAULT_TITLE_STYLE, color: "#FF0000" });
    expect(brandTitleSchema.parse({ durationSec: null }).durationSec).toBeNull();
  });

  test("a brand snapshot stored before titles parses with title null", () => {
    const snapshot = brandTemplateSnapshotSchema.parse({
      templateId: null,
      captionPreset: {},
      logoStorageKey: null,
      logoPosition: "bot-right",
      logoOpacity: 80,
      logoScalePct: 15,
      primaryColor: "#FFFFFF",
      secondaryColor: "#00FF88",
      accentColor: null,
    });
    expect(snapshot.title).toBeNull();
  });
});

describe("fonts and face resolution", () => {
  test("every family's faces exist; heavier, italic and bold italic faces sit at the weights the family claims", () => {
    for (const [name, family] of Object.entries(TEXT_LAYER_FONTS) as [string, TextLayerFontFamilyFaces][]) {
      const regular = captionFontFace(family.regular);
      if (family.bold) expect({ name, heavier: captionFontFace(family.bold).weight > regular.weight }).toEqual({ name, heavier: true });
      if (family.italic) {
        expect(captionFontFace(family.italic).style).toBe("italic");
        expect(captionFontFace(family.italic).weight).toBe(regular.weight);
      }
      if (family.boldItalic) {
        expect(family.bold).toBeDefined();
        expect(captionFontFace(family.boldItalic).style).toBe("italic");
        expect(captionFontFace(family.boldItalic).weight).toBe(captionFontFace(family.bold!).weight);
      }
      expect(regular.style).toBe("normal");
    }
  });

  test("bold takes the heavier face, else faux bold; italic takes the real face at that weight, else a shear", () => {
    expect(resolveTextLayerFace({ font: "Inter", bold: true, italic: false })).toEqual({ face: "Inter", fauxBold: false, shearDeg: 0 });
    expect(resolveTextLayerFace({ font: "Inter", bold: false, italic: false })).toEqual({ face: "Inter Regular", fauxBold: false, shearDeg: 0 });
    expect(resolveTextLayerFace({ font: "Inter", bold: true, italic: true })).toMatchObject({ face: "Inter", fauxBold: false });
    expect(resolveTextLayerFace({ font: "Inter", bold: true, italic: true }).shearDeg).toBeGreaterThan(0);
    expect(resolveTextLayerFace({ font: "Anton", bold: true, italic: false })).toEqual({ face: "Anton", fauxBold: true, shearDeg: 0 });
    expect(resolveTextLayerFace({ font: "Inter Tight", bold: true, italic: true })).toEqual({ face: "Inter Tight ExtraBold Italic", fauxBold: false, shearDeg: 0 });
    expect(resolveTextLayerFace({ font: "Inter Tight", bold: false, italic: true })).toEqual({ face: "Inter Tight Medium Italic", fauxBold: false, shearDeg: 0 });
    // A real italic only at the resolved weight: Newsreader has an italic at its bold weight only.
    expect(resolveTextLayerFace({ font: "Newsreader", bold: true, italic: true })).toEqual({ face: "Newsreader SemiBold Italic", fauxBold: false, shearDeg: 0 });
    expect(resolveTextLayerFace({ font: "Newsreader", bold: false, italic: true })).toMatchObject({ face: "Newsreader Medium", fauxBold: false });
    // A family with no heavier face keeps its italic under faux bold.
    expect(resolveTextLayerFace({ font: "Playfair Display", bold: true, italic: true })).toEqual({ face: "Playfair Display Bold Italic", fauxBold: true, shearDeg: 0 });
  });
});

describe("title text and the title layer builder", () => {
  test("cutTitleText keeps short text, collapses whitespace, cuts long text at a word boundary", () => {
    expect(cutTitleText("  Hello \n world  ")).toBe("Hello world");
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const cut = cutTitleText(words);
    expect(cut.length).toBeLessThanOrEqual(120);
    expect(words.startsWith(cut)).toBe(true);
    expect(words[cut.length]).toBe(" ");
    expect(cutTitleText("abc def", 3)).toBe("abc");
    expect(cutTitleText("   ")).toBe("");
  });

  test("cutTitleText backs off to a word boundary on grapheme boundaries", () => {
    // U+0600 (a prepended mark) joins the space after it into one grapheme: the cut goes before that grapheme.
    expect(cutTitleText("ab\u0600 cde", 5)).toBe("ab");
    expect(cutTitleText("ab\u0600 cde", 4)).toBe("ab");
    expect(cutTitleText("abc defgh", 6)).toBe("abc");
    expect(cutTitleText("abc defgh", 3)).toBe("abc");
    expect(cutTitleText("abc defgh", 4)).toBe("abc");
  });

  test("cutTitleText never splits a grapheme, and a single long word is cut at a grapheme", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `${"a".repeat(115)}${family}${family}`;
    const cut = cutTitleText(text);
    expect(cut).toBe("a".repeat(115));
    const emojis = family.repeat(20);
    const hard = cutTitleText(emojis);
    expect(hard.length).toBeLessThanOrEqual(120);
    expect(hard.length % family.length).toBe(0);
  });

  test("titleTextLayer builds the title from the settings and clamps its duration", () => {
    const layer = titleTextLayer({ text: "My clip", settings: DEFAULT_BRAND_TITLE, editedDurationSec: 30 })!;
    expect(layer).toEqual({ id: "title", role: "title", text: "My clip", startSec: 0, endSec: 5, positionX: 50, positionY: 12, widthPct: 86, style: DEFAULT_TITLE_STYLE });
    expect(studioTextLayerSchema.parse(layer)).toEqual(layer);
    expect(titleTextLayer({ text: "My clip", settings: DEFAULT_BRAND_TITLE, editedDurationSec: 3 })!.endSec).toBe(3);
    expect(titleTextLayer({ text: "My clip", settings: { ...DEFAULT_BRAND_TITLE, durationSec: null }, editedDurationSec: 3 })!.endSec).toBeNull();
    expect(titleTextLayer({ text: "  ", settings: DEFAULT_BRAND_TITLE, editedDurationSec: 3 })).toBeNull();
    expect(titleTextLayer({ text: null, settings: DEFAULT_BRAND_TITLE, editedDurationSec: 3 })).toBeNull();
    expect(titleTextLayer({ text: "x", settings: DEFAULT_BRAND_TITLE, editedDurationSec: 0 })).toBeNull();
  });
});

describe("Studio edits", () => {
  test("equality sees any style change, nested ones included", () => {
    const base = studioEditsSchema.parse({ textLayers: [{ id: "a", text: "x" }] });
    const copy = studioEditsSchema.parse(JSON.parse(JSON.stringify(base)));
    expect(studioEditsEqual(base, copy)).toBe(true);
    const restyled = (style: object) => ({ ...base, textLayers: [{ ...base.textLayers[0]!, style: { ...base.textLayers[0]!.style, ...style } }] });
    expect(studioEditsEqual(base, restyled({ stroke: { color: "#000000", width: 4 } }))).toBe(false);
    expect(studioEditsEqual(base, restyled({ underline: true }))).toBe(false);
    expect(studioEditsEqual(base, { ...base, textLayers: [{ ...base.textLayers[0]!, widthPct: 50 }] })).toBe(false);
    expect(studioEditsEqual(base, { ...base, textLayers: [{ ...base.textLayers[0]!, role: "title" }] })).toBe(false);
  });

  test("Apply to all takes a title patch, alone or grouped with the other three", () => {
    const title = { style: DEFAULT_TITLE_STYLE, positionX: 50, positionY: 12, widthPct: 86, startSec: 0, endSec: 5 };
    expect(applyStudioEditsToAllSchema.parse({ patch: { title } }).patches).toEqual([{ title }]);
    const grouped = applyStudioEditsToAllSchema.parse({
      patches: [{ title }, { transition: { type: "fade", durationSec: 0.4 } }, { background: { mode: "off" } }, { framing: { mode: "center" } }],
    });
    expect(grouped.patches).toHaveLength(4);
    expect(applyStudioEditsToAllSchema.safeParse({ patch: { title, framing: { mode: "center" } } }).success).toBe(false);
    expect(applyStudioEditsToAllSchema.safeParse({ patch: { title: { ...title, text: "words" } } }).success).toBe(false);
    expect(applyStudioEditsToAllSchema.safeParse({ patch: { title: { ...title, startSec: 5, endSec: 5 } } }).success).toBe(false);
  });
});
