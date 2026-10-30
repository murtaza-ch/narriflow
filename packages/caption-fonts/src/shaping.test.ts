import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "fontkit";
import { CAPTION_FONT_FACES } from "@narriflow/validators";
import { CAPTION_FALLBACK_FONTS, captionFallbackFontPath } from "./fallback-fonts";
import { type CaptionLineWord, CaptionShapingError, layoutCaptionLine, shapeCaptionRun } from "./shaping";
import { captionFontFilePath } from "./paths";

describe("vendored caption faces", () => {
  for (const face of CAPTION_FONT_FACES) {
    test(`${face.name} has the libass name and metrics used by preview`, () => {
      const bytes = readFileSync(captionFontFilePath(face.file));
      const font = create(bytes);
      if (!("layout" in font)) throw new Error("Expected a static font face");
      expect(font.fullName).toBe(face.assName);
      // Read OS/2 directly: fontkit's public ascent uses hhea, while libass
      // and the browser overrides deliberately use the Windows metrics.
      let os2 = -1;
      for (let index = 0; index < bytes.readUInt16BE(4); index++) {
        const record = 12 + index * 16;
        if (bytes.toString("ascii", record, record + 4) === "OS/2") {
          os2 = bytes.readUInt32BE(record + 8);
          break;
        }
      }
      expect(os2).toBeGreaterThan(0);
      expect(bytes.readUInt16BE(os2 + 74) / font.unitsPerEm).toBeCloseTo(face.ascent, 4);
      expect(bytes.readUInt16BE(os2 + 76) / font.unitsPerEm).toBeCloseTo(face.descent, 4);
      expect(font.glyphForCodePoint(72).bbox.maxY / font.unitsPerEm).toBeCloseTo(face.capHeight, 4);
      expect(shapeCaptionRun(captionFontFilePath(face.file), "READY").advanceEm).toBeGreaterThan(0);
    });
  }

  test("HarfBuzz keeps kerning: the advance equals fontkit's shaped advance for Latin", () => {
    const font = create(readFileSync(captionFontFilePath("Montserrat-Black.ttf")));
    if (!("layout" in font)) throw new Error("Expected a static font face");
    expect(shapeCaptionRun(captionFontFilePath("Montserrat-Black.ttf"), "AV").advanceEm)
      .toBeCloseTo(font.layout("AV").advanceWidth / font.unitsPerEm, 8);
    expect(shapeCaptionRun(captionFontFilePath("Montserrat-Black.ttf"), "").advanceEm).toBe(0);
  });
});

describe("caption line layout in visual order", () => {
  const arabic = captionFallbackFontPath(CAPTION_FALLBACK_FONTS.find((font) => font.file === "NotoSansArabic-Regular.ttf")!);
  const nastaliq = captionFallbackFontPath(CAPTION_FALLBACK_FONTS.find((font) => font.file === "NotoNastaliqUrdu-Regular.ttf")!);
  const latin = captionFontFilePath("Anton-Regular.ttf");
  const word = (text: string, fontPath: string, spaced = false, gap = true): CaptionLineWord => ({
    parts: [{ text, fontPath, spaced, inked: false }],
    gap: gap ? { text: " ", fontPath: latin, spaced: false, inked: false } : null,
    gapExtraEm: 0,
  });
  const left = (layout: ReturnType<typeof layoutCaptionLine>) => layout.words.map((box) => box.leftEm);

  test("an LTR line places words left to right", () => {
    const layout = layoutCaptionLine([word("READY", latin), word("TO", latin), word("GO", latin)], 0, "ltr");
    const lefts = left(layout);
    expect(lefts[0]).toBe(0);
    expect(lefts[0]!).toBeLessThan(lefts[1]!);
    expect(lefts[1]!).toBeLessThan(lefts[2]!);
    const space = shapeCaptionRun(latin, " ").advanceEm;
    expect(lefts[1]!).toBeCloseTo(layout.words[0]!.widthEm + space, 6);
    expect(layout.widthEm).toBeCloseTo(layout.words.reduce((sum, box) => sum + box.widthEm, 0) + 2 * space, 6);
  });

  test("an RTL line puts the first word rightmost and keeps every box inside the line", () => {
    const layout = layoutCaptionLine([word("مرحبا", arabic), word("بالعالم", arabic), word("في", arabic)], 0, "rtl");
    const lefts = left(layout);
    expect(lefts[0]!).toBeGreaterThan(lefts[1]!);
    expect(lefts[1]!).toBeGreaterThan(lefts[2]!);
    expect(lefts[2]).toBe(0);
    const first = layout.words[0]!;
    expect(first.leftEm + first.widthEm).toBeCloseTo(layout.widthEm, 6);
  });

  test("numbers and Latin inside an Arabic line read left to right in their own run", () => {
    // مرحبا بالعالم 2026 Narriflow رائع: the same visual order libass drew (evidence/10/ar-numbers-latin.png).
    const latinRun = (text: string): CaptionLineWord => word(text, latin);
    const layout = layoutCaptionLine(
      [word("مرحبا", arabic), word("بالعالم", arabic), latinRun("2026"), latinRun("Narriflow"), word("رائع", arabic)],
      0,
      "rtl",
    );
    const visual = layout.words.map((box, index) => ({ index, left: box.leftEm })).sort((a, b) => a.left - b.left).map((entry) => entry.index);
    expect(visual).toEqual([4, 3, 2, 1, 0]);
  });

  test("an Arabic word inside an English line sits in logical order, drawn right to left within its box", () => {
    const layout = layoutCaptionLine([word("Hello", latin), word("مرحبا", arabic), word("World", latin)], 0, "ltr");
    const lefts = left(layout);
    expect(lefts[0]!).toBeLessThan(lefts[1]!);
    expect(lefts[1]!).toBeLessThan(lefts[2]!);
    expect(layout.words[1]!.widthEm).toBeCloseTo(shapeCaptionRun(arabic, "مرحبا", true).advanceEm, 6);
  });

  test("libass anchors a \\pos event by the bbox of its cluster roots, so an offset mark moves it off the advance middle", () => {
    // Measured on libass 0.17.4 (compute_string_bbox): the Nastaliq word's last cluster starts with a mark at x_offset 351 units.
    const marked = layoutCaptionLine([word("مُحَبَّتُوں", nastaliq)], 0, "rtl");
    expect(marked.bboxCenterEm - marked.widthEm / 2).toBeCloseTo(0.351 / 2, 2);
    // No offset on any cluster root: the bbox is the advance box.
    for (const plain of [layoutCaptionLine([word("READY", latin, true)], 0.05, "ltr"), layoutCaptionLine([word("مرحبا", arabic), word("بالعالم", arabic)], 0, "rtl")]) {
      expect(plain.bboxCenterEm).toBeCloseTo(plain.widthEm / 2, 6);
    }
  });

  test("letter spacing applies after each character of spaced parts only", () => {
    const plain = layoutCaptionLine([word("READY", latin)], 0, "ltr");
    const spaced = layoutCaptionLine([word("READY", latin, true)], 0.05, "ltr");
    expect(spaced.widthEm - plain.widthEm).toBeCloseTo(0.25, 6);
    const arabicPlain = layoutCaptionLine([word("مرحبا", arabic)], 0, "rtl");
    const arabicSpacing = layoutCaptionLine([word("مرحبا", arabic, false)], 0.05, "rtl");
    expect(arabicSpacing.widthEm).toBeCloseTo(arabicPlain.widthEm, 6);
  });

  test("the pill's extra advance widens the gap, not the words", () => {
    const base = layoutCaptionLine([word("READY", latin), word("GO", latin)], 0, "ltr");
    const widened = layoutCaptionLine([word("READY", latin), { ...word("GO", latin), gapExtraEm: 0.14 }], 0, "ltr");
    expect(widened.widthEm - base.widthEm).toBeCloseTo(0.14, 6);
    expect(widened.words.map((box) => box.widthEm)).toEqual(base.words.map((box) => box.widthEm));
  });

  test("abutting words (no-space scripts) leave no gap", () => {
    const layout = layoutCaptionLine([word("今日", latin, false, false), word("は", latin, false, false)], 0, "ltr");
    expect(layout.words[1]!.leftEm).toBeCloseTo(layout.words[0]!.widthEm, 6);
  });

  test("Nastaliq measures with ink that hangs below the baseline and stands above the cap height", () => {
    const layout = layoutCaptionLine(
      [{ parts: [{ text: "مُحَبَّتُوں", fontPath: nastaliq, spaced: false, inked: true }], gap: null, gapExtraEm: 0 }],
      0,
      "rtl",
    );
    expect(Number.isFinite(layout.widthEm)).toBe(true);
    expect(layout.words[0]!.widthEm).toBeGreaterThan(2);
    expect(layout.words[0]!.inkBottomEm).toBeGreaterThan(0.3);
    expect(layout.words[0]!.inkTopEm).toBeGreaterThan(0.8);
    expect(layout.inkTopEm).toBe(layout.words[0]!.inkTopEm);
  });

  test("HarfBuzz shapes the words fontkit throws on (Gurmukhi, Telugu)", () => {
    for (const [file, text] of [["NotoSansGurmukhi-Regular.ttf", "ਪੰਜਾਬੀ ਭਾਸ਼ਾ"], ["NotoSansTelugu-Regular.ttf", "తెలుగు క్షత్రియ"]] as const) {
      const path = captionFallbackFontPath(CAPTION_FALLBACK_FONTS.find((font) => font.file === file)!);
      const run = shapeCaptionRun(path, text);
      expect(run.notdef).toBe(false);
      expect(run.advanceEm).toBeGreaterThan(1);
    }
  });

  test("a font HarfBuzz cannot open raises the typed error the cue degrades on", () => {
    const woff2 = join(tmpdir(), `caption-shaping-${process.pid}.woff2`);
    writeFileSync(woff2, Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(64)]));
    try {
      expect(() => shapeCaptionRun(woff2, "Hello")).toThrow(CaptionShapingError);
    } finally {
      rmSync(woff2);
    }
  });

  test("a WOFF2 upload is decompressed for HarfBuzz and measures like the same face as sfnt", () => {
    const nextRoot = join(createRequire(import.meta.url).resolve("next/package.json", { paths: [join(import.meta.dir, "../../../apps/web")] }), "..");
    const woff2 = join(nextRoot, "dist/next-devtools/server/font/geist-latin.woff2");
    const run = shapeCaptionRun(woff2, "Hello world");
    expect(run.notdef).toBe(false);
    expect(run.glyphCount).toBe(11);
    expect(run.advanceEm).toBeGreaterThan(4);
    expect(run.inkTopEm).toBeGreaterThan(0.5);
    // Geist as TTF is a different file with the same design: its advance for the same text is within a hair.
    const ttf = shapeCaptionRun(join(import.meta.dir, "../../../apps/web/assets/fonts/geist/Geist-Regular.ttf"), "Hello world");
    expect(Math.abs(run.advanceEm - ttf.advanceEm)).toBeLessThan(0.15);
  });
});
