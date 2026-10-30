import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { captionFallbackFontPath, CAPTION_FALLBACK_FONTS, shapeCaptionRun } from "@narriflow/caption-fonts";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { brandFontRenderer } from "@narriflow/services";
import { CAPTION_PILL, CAPTION_PLATE, captionPresetSchema } from "@narriflow/validators";
import { captionDecorationExtentEm, measureCaptionFallbackInkEm } from "../../web/app/caption-script-fonts";
import { type RenderBrandFonts, brandFontKey } from "./brand-font-resolution";
import { renderCaptionTrack } from "./caption-ass";

/**
 * One ink policy for pills and plates, in the Studio and in the burn-in: they grow to the shaped ink of text a
 * fallback face draws and of shaping-sensitive scripts in any face, an uploaded font covering them included.
 * The Studio side runs its real measurement over a Canvas that reports the HarfBuzz ink of the font it is given.
 */
const reference = { kind: "brand_font" as const, id: "10000000-0000-4000-8000-0000000000b1", fingerprint: "c".repeat(64) };
const fallbackPath = (file: string) => captionFallbackFontPath(CAPTION_FALLBACK_FONTS.find((font) => font.file === file)!);
const FONT_PX = 84;
const MEASURE_PX = 100;

const globals = globalThis as { document?: unknown };
const originalDocument = globals.document;
let uploadedPath = "";

beforeAll(() => {
  const context = {
    font: "",
    measureText: (run: string) => {
      const ink = shapeCaptionRun(uploadedPath, run);
      return { actualBoundingBoxAscent: ink.inkTopEm * MEASURE_PX, actualBoundingBoxDescent: ink.inkBottomEm * MEASURE_PX };
    },
  };
  globals.document = { createElement: () => ({ getContext: () => context }), fonts: { check: () => true } };
});
afterAll(() => {
  globals.document = originalDocument;
});

/** Height in em of the one rounded-rectangle path the burn-in draws for `decoration`, and the Studio's extent for it. */
function heights(file: string, word: string, language: string, decoration: "pill" | "plate") {
  uploadedPath = fallbackPath(file);
  const font = { ...brandFontRenderer(readFileSync(uploadedPath)), path: uploadedPath };
  const fonts: RenderBrandFonts = new Map([[brandFontKey(reference), font]]);
  const preset = captionPresetSchema.parse({
    fontAsset: reference,
    animation: "pop",
    fontSize: FONT_PX,
    ...(decoration === "pill" ? { highlightBoxColor: "#ffffff" } : { backgroundColor: "#000000" }),
  });
  const layer: CompositionCaptionVisualLayer = {
    id: "caption:0", kind: "caption", cueIndex: 0, activeRange: { startSec: 0, endSec: 1 },
    anchor: { xPct: 50, yPct: 70 }, destination: { x: 0, y: 0, width: 1080, height: 1920 },
    rotationDeg: 0, opacity: 1, zIndex: 40, preset, language,
    words: [{ text: word, emoji: null, startSec: 0, endSec: 1 }],
  };
  const { ass, geometryUnavailable } = renderCaptionTrack({ layers: [layer], canvas: { width: 1080, height: 1920 }, fonts });
  expect(geometryUnavailable).toEqual([]);
  const shape = ass.split("\n").find((line) => line.startsWith("Dialogue:") && line.includes(",Shape,"));
  expect(shape, "a pill or plate event").toBeDefined();
  const path = /\\p1\}(.*)\{\\p0\}/.exec(shape!)![1]!;
  const ys = path.match(/-?[\d.]+ -?[\d.]+/g)!.map((pair) => Number(pair.split(" ")[1]));
  const exportEm = Math.max(...ys) / FONT_PX;

  const ink = measureCaptionFallbackInkEm(word, { requestedFamily: '"Uploaded"', weight: 400, style: "normal", language, ownScripts: [] });
  const extent = captionDecorationExtentEm(font.face.capHeight, decoration === "pill" ? CAPTION_PILL : CAPTION_PLATE, ink);
  return { exportEm, studioEm: extent.aboveBaselineEm + extent.belowBaselineEm, inkTopEm: ink.topEm, capHeight: font.face.capHeight };
}

describe("Studio and export agree on pill and plate height for uploaded complex-script fonts", () => {
  for (const [name, file, word, language] of [
    ["Noto Nastaliq Urdu", "NotoNastaliqUrdu-Regular.ttf", "مُحَبَّتُوں", "ur"],
    ["Noto Sans Devanagari", "NotoSansDevanagari-Regular.ttf", "क्षत्रिय", "hi"],
  ] as const) {
    for (const decoration of ["pill", "plate"] as const) {
      test(`${name} upload, ${decoration}`, () => {
        const { exportEm, studioEm, inkTopEm, capHeight } = heights(file, word, language, decoration);
        // The shaped ink is what grows the decoration, past the catalog cap height.
        expect(inkTopEm).toBeGreaterThan(capHeight);
        expect(Math.abs(exportEm - studioEm)).toBeLessThan(0.01);
      });
    }
  }
});
