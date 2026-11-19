import { describe, expect, test } from "bun:test";
import { captionBlockDirection, layoutCaptionBlock, type MeasuredWord } from "@narriflow/caption-fonts/caption-block";
import type { CompositionCaptionBlock, CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { captionBlockAnimation, captionDynamicStyle, captionFontFace } from "@narriflow/validators";
import { CAPTION_FACE_OWN_SCRIPTS, captionWordBoxMiddleEm } from "../../web/app/caption-script-fonts";
import { CANVAS, dynamicCaptionFixtures, dynamicCaptionLayers } from "../scripts/dynamic-caption-fixtures";
import { captionBlockGeometry } from "./caption-ass";
import { CaptionGlyphPlanner, catalogCaptionFace } from "./caption-glyphs";

/**
 * Both painters scale an entrance about one point, `PlacedWord.scaleOriginY`: the middle of the
 * line box libass anchors the word's `\an5` event by (spec 5.6). The worker reads the box off its
 * glyph plan; the Studio, which cannot ask a browser which face drew a glyph, feeds the shared
 * layout `captionWordBoxMiddleEm` (apps/web/app/caption-script-fonts.ts). For a word a fallback
 * face draws (Noto Nastaliq Urdu, Noto Sans JP) the two must name the fallback face's box; the
 * requested face's box put the Studio's pivot 3.5 to 35.8 px away (ticket 05b, ticket 10).
 */
type BlockLayer = CompositionCaptionVisualLayer & { readonly block: CompositionCaptionBlock };

/** Fixture cases whose words a fallback face draws, entering with `slam`, which scales every word. */
const FALLBACK_CASES = ["headline-urdu", "headline-urdu-punctuation", "marker-urdu", "headline-japanese"] as const;

function slamLayers(id: string): BlockLayer[] {
  const fixture = dynamicCaptionFixtures().find((candidate) => candidate.id === id)!;
  return dynamicCaptionLayers({ ...fixture, preset: { ...fixture.preset, animation: "slam" } }).map((layer) => {
    expect(layer.block, `${id}: a block cue`).toBeDefined();
    return layer as BlockLayer;
  });
}

/** The Studio's layout of `layer`: the worker's measurements, with the box middle the browser computes. */
function studioLayout(layer: BlockLayer, boxMiddle: (word: ReturnType<typeof captionBlockGeometry>["words"][number]) => number | undefined) {
  const geometry = captionBlockGeometry({ cue: layer, canvas: CANVAS });
  const measured = geometry.words.map((word): MeasuredWord => {
    const { boxMiddleEm: _worker, ...rest } = word.measured;
    const middle = boxMiddle(word);
    return middle === undefined ? rest : { ...rest, boxMiddleEm: middle };
  });
  const style = captionDynamicStyle(layer.block.style);
  const layout = layoutCaptionBlock({
    block: layer.block,
    preset: layer.preset,
    style,
    words: layer.words,
    measured,
    canvas: CANVAS,
    anchor: layer.anchor,
    direction: captionBlockDirection(layer.block.texts, layer.language),
    cueEndSec: layer.activeRange.endSec,
    language: layer.language,
  });
  return { geometry, layout };
}

const browserBoxMiddle = (layer: BlockLayer) => (word: ReturnType<typeof captionBlockGeometry>["words"][number]) =>
  captionWordBoxMiddleEm(
    word.text,
    { ascent: word.slot.face.ascent, descent: word.slot.face.descent, ownScripts: CAPTION_FACE_OWN_SCRIPTS[word.look.fontName] ?? [] },
    layer.language,
  );
const requestedBoxMiddle = (word: ReturnType<typeof captionBlockGeometry>["words"][number]) => (word.slot.face.ascent - word.slot.face.descent) / 2;

describe("scale origin of words a fallback face draws", () => {
  for (const id of FALLBACK_CASES) {
    test(`${id}: the Studio's pivot is the burn-in's, under slam`, () => {
      for (const layer of slamLayers(id)) {
        expect(captionBlockAnimation(layer.preset, captionDynamicStyle(layer.block.style))).toBe("slam");
        const { geometry, layout } = studioLayout(layer, browserBoxMiddle(layer));
        geometry.layout.words.forEach((worker, index) => {
          const studio = layout.words[index]!;
          const label = `${id} "${geometry.words[index]!.text}"`;
          expect(studio.scaleOriginX, `${label}: x`).toBeCloseTo(worker.scaleOriginX, 6);
          expect(studio.scaleOriginY, `${label}: y`).toBeCloseTo(worker.scaleOriginY, 6);
          expect(studio.centerY, `${label}: the rest centre`).toBeCloseTo(worker.centerY, 6);
        });
      }
    });
  }

  test("the requested face's box, which the Studio used before, put the pivot 3.5 to 35.8 px off", () => {
    // Where each painter scales a word about, relative to the word's own centre (the layout's other
    // numbers shift a little with the pivots through the reserved bounds).
    const gaps: { text: string; gap: number }[] = [];
    for (const id of FALLBACK_CASES) {
      for (const layer of slamLayers(id)) {
        const { geometry, layout } = studioLayout(layer, requestedBoxMiddle);
        geometry.layout.words.forEach((worker, index) => {
          const studio = layout.words[index]!;
          gaps.push({ text: geometry.words[index]!.text, gap: Math.abs(studio.scaleOriginY - studio.centerY - (worker.scaleOriginY - worker.centerY)) });
        });
      }
    }
    expect(Math.max(...gaps.map((entry) => entry.gap))).toBeGreaterThan(3.5);
    // The Latin digits the requested face draws agree; every word with fallback text does not.
    expect(gaps.filter((entry) => entry.gap < 0.01).map((entry) => entry.text)).toEqual(["50"]);
  });

  test("a word the requested face draws keeps the requested face's box", () => {
    for (const layer of slamLayers("headline-en")) {
      const { geometry, layout } = studioLayout(layer, browserBoxMiddle(layer));
      geometry.layout.words.forEach((worker, index) => {
        expect(layout.words[index]!.scaleOriginY).toBeCloseTo(worker.scaleOriginY, 6);
      });
    }
  });
});

// Symbols and dingbats (★ ✓ ♥) are left out: the Studio counts them as drawn by the requested face, as its
// pill and plate ink does (`captionFaceDraws`), while a face without them (Montserrat, Anton, Oswald) sends them
// to Noto Sans SC or Symbols 2 in the burn-in. Emoji are planned apart and are covered.
describe("the Studio's face choice matches the glyph planner's", () => {
  const WORDS = [
    "hello", "Привет", "αβγ", "قیمت", "50،", "اب.", "اردو!", "今日は。", "3回", "日本語", "你好!", "한국어", "שלום", "สวัสดี1", "नमस्ते,", "ሰላم", "ሰላም", "ქართული",
    "“سلام”", "(日本)", "a،b", "❤️", "👍🏽", "x→y", "10%", "ひらがなカタカナ", "ﷺ",
  ];
  for (const font of ["Inter", "Montserrat"] as const) {
    for (const language of ["en", "ur", "ja", "yue", "ar", "zh", null] as const) {
      test(`${font}, language ${language}: every word's line box`, () => {
        const face = captionFontFace(font);
        const report = { notices: new Map(), omitted: new Map() };
        const planner = new CaptionGlyphPlanner(catalogCaptionFace(face, "requested"), null, report, 0, new Set(), language);
        for (const text of WORDS) {
          const faces = planner.plan(text).flatMap((cluster) => cluster.parts.map((part) => part.face));
          const ascent = faces.length > 0 ? Math.max(...faces.map((drawn) => drawn.ascentEm)) : face.ascent;
          const descent = faces.length > 0 ? Math.max(...faces.map((drawn) => drawn.descentEm)) : face.descent;
          const studio = captionWordBoxMiddleEm(text, { ascent: face.ascent, descent: face.descent, ownScripts: CAPTION_FACE_OWN_SCRIPTS[font] ?? [] }, language);
          expect(studio, `"${text}"`).toBeCloseTo((ascent - descent) / 2, 9);
        }
      });
    }
  }
});
