import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { captionFallbackFontPath, CAPTION_FALLBACK_FONTS } from "@narriflow/caption-fonts";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { brandFontRenderer } from "@narriflow/services";
import { captionPresetSchema, getCaptionPresetById } from "@narriflow/validators";
import { renderCaptionTrack } from "./caption-ass";
import { type RenderBrandFonts, brandFontKey } from "./brand-font-resolution";

/**
 * An uploaded brand font that covers a joining or complex script is treated by that script, not by the
 * face: no per-letter reveal, no letter spacing (spec D12). A WOFF2 upload is measured like any other font.
 */
const reference = { kind: "brand_font" as const, id: "10000000-0000-4000-8000-0000000000a1", fingerprint: "b".repeat(64) };
const fallback = (file: string) => captionFallbackFontPath(CAPTION_FALLBACK_FONTS.find((font) => font.file === file)!);
const geistWoff2 = join(
  join(createRequire(import.meta.url).resolve("next/package.json", { paths: [join(import.meta.dir, "../../web")] }), ".."),
  "dist/next-devtools/server/font/geist-latin.woff2",
);

function brandFonts(path: string): RenderBrandFonts {
  return new Map([[brandFontKey(reference), { ...brandFontRenderer(readFileSync(path)), path }]]);
}

function track(fonts: RenderBrandFonts, preset: ReturnType<typeof captionPresetSchema.parse>, words: readonly string[], language: string | null = null) {
  const cue: CompositionCaptionVisualLayer = {
    id: "caption:0", kind: "caption", cueIndex: 0, activeRange: { startSec: 0, endSec: words.length * 0.5 },
    anchor: { xPct: 50, yPct: 72 }, destination: { x: 0, y: 0, width: 1080, height: 1920 },
    rotationDeg: 0, opacity: 1, zIndex: 40, preset: { ...preset, fontAsset: reference },
    words: words.map((text, index) => ({ text, emoji: null, startSec: index * 0.5, endSec: (index + 1) * 0.5 })),
    ...(language ? { language } : {}),
  };
  return renderCaptionTrack({ layers: [cue], canvas: { width: 1080, height: 1920 }, fonts });
}

const typewriter = captionPresetSchema.parse({ ...getCaptionPresetById("typewriter")!.preset, letterSpacing: 0.04 });
const textEvents = (ass: string) => ass.split("\n").filter((line) => line.startsWith("Dialogue:") && line.includes("Caption,"));

describe("uploaded complex-script brand fonts", () => {
  for (const [name, file, words] of [
    ["Noto Sans Arabic", "NotoSansArabic-Regular.ttf", ["مرحبا", "بالعالم"]],
    ["Noto Sans Devanagari", "NotoSansDevanagari-Regular.ttf", ["नमस्ते", "क्षत्रिय"]],
  ] as const) {
    test(`${name} as a brand font: typewriter reveals whole words, no letter spacing on the run`, () => {
      const { ass, geometryUnavailable, omitted, notices } = track(brandFonts(fallback(file)), typewriter, words);
      expect(geometryUnavailable).toEqual([]);
      expect(omitted).toEqual([]);
      expect(notices).toEqual([]);
      // The brand face covers the script itself: no fallback face is switched in.
      expect(ass).not.toMatch(/\\fn(?!Noto Sans (Arabic|Devanagari) Regular)/);
      // No per-letter `\ko` tag anywhere: libass would split the joining/conjunct shaping run at each.
      expect(ass).not.toContain("\\ko");
      const events = textEvents(ass);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        // The event's letter spacing is non-zero for the caption, so every run of the script switches it off first.
        const [, header = "", body = ""] = /^[^{]*\{([^}]*)\}(.*)$/.exec(event.split(",,").slice(1).join(",,")) ?? [];
        expect(header).toMatch(/\\fsp-?[\d.]+/);
        // Each word of the script is drawn right after `\fsp0` (and the spacing comes back after it).
        for (const word of words) expect(body).toContain(`\\fsp0}${word}{\\fsp`);
      }
    });
  }

  test("a Latin brand font keeps both the letter spacing and the per-letter typewriter reveal", () => {
    const { ass } = track(brandFonts(fallback("NotoSans-Regular.ttf")), typewriter, ["READY", "GO"]);
    expect(ass).toContain("\\ko");
    expect(ass).not.toMatch(/\\fsp0[^\d]/);
  });
});

describe("uploaded WOFF2 brand font parity", () => {
  const pillAndPlate = captionPresetSchema.parse({
    ...getCaptionPresetById("electric")!.preset,
    highlightBoxColor: "#3B82F6",
    highlightBoxOpacity: 1,
    backgroundColor: "#0B0D12",
    backgroundOpacity: 0.62,
  });

  test("HarfBuzz measures the decompressed font: pill and plate events exist and the cue is not degraded", () => {
    const { ass, geometryUnavailable } = track(brandFonts(geistWoff2), pillAndPlate, ["READY", "TO", "GO"]);
    expect(geometryUnavailable).toEqual([]);
    const shapes = ass.split("\n").filter((line) => line.startsWith("Dialogue:") && line.includes(",Shape,"));
    // One plate for the cue and a pill per active word.
    expect(shapes.length).toBeGreaterThanOrEqual(1 + 3);
    expect(ass).not.toMatch(/NaN|undefined|Infinity/);
  });

  test("the same face as TTF and WOFF2 yields the same number of shape events", () => {
    const ttf = join(import.meta.dir, "../../web/assets/fonts/geist/Geist-Regular.ttf");
    const count = (path: string) => track(brandFonts(path), pillAndPlate, ["READY", "TO", "GO"]).ass.split(",Shape,").length;
    expect(count(geistWoff2)).toBe(count(ttf));
  });
});
