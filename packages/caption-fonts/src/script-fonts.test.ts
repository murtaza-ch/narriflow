import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { create } from "fontkit";
import { SCRIBE_LANGUAGES } from "@narriflow/validators";
import { SCRIPT_SPECIMENS } from "../../../apps/worker/scripts/check-render-environment";
import { CAPTION_FALLBACK_FONTS, captionFallbackFontPath, fontFileCovers } from "./fallback-fonts";
import { shapeCaptionRun } from "./shaping";

interface ManifestFont {
  file: string;
  family: string;
  assName: string;
  version: string;
  sha256: string;
  bytes: number;
  languages?: string[];
  unicodeRanges: string[];
  source: { archive: string; archiveSha256: string; release: string };
  license: string;
}

const manifest = JSON.parse(readFileSync(new URL("../script-fonts.manifest.json", import.meta.url), "utf8")) as { fonts: ManifestFont[] };
const lock = JSON.parse(readFileSync(new URL("../../../apps/worker/runtime-lock.json", import.meta.url), "utf8")) as {
  fallbackFonts: { sha256: Record<string, string> };
};
const faceByAssName = new Map(CAPTION_FALLBACK_FONTS.map((font) => [font.assName, font]));

describe("script font manifest", () => {
  test("pins every vendored script face by version, checksum, source and licence", () => {
    expect(manifest.fonts).toHaveLength(18);
    for (const entry of manifest.fonts) {
      const bytes = readFileSync(captionFallbackFontPath({ file: entry.file } as never));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
      expect(bytes.length).toBe(entry.bytes);
      expect(lock.fallbackFonts.sha256[entry.file]).toBe(entry.sha256);
      expect(entry.license).toBe("OFL-1.1");
      expect(entry.source.archive).toStartWith("https://");
      expect(entry.source.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
      const face = create(bytes) as unknown as { fullName: string; familyName: string; version: string };
      expect(face.fullName).toBe(entry.assName);
      expect(face.familyName).toBe(entry.family);
      expect(face.version).toContain(entry.version);
      const registered = CAPTION_FALLBACK_FONTS.find((font) => font.file === entry.file);
      expect(registered?.assName).toBe(entry.assName);
      expect(registered && "languages" in registered ? [...registered.languages!] : undefined).toEqual(entry.languages);
    }
  });

  test("language-aware faces are the three ticket 10 selects by language", () => {
    const aware = CAPTION_FALLBACK_FONTS.filter((font) => "languages" in font).map((font) => [font.file, font.languages]);
    expect(aware).toEqual([
      ["NotoSansJP-Regular.otf", ["ja"]],
      ["NotoSansTC-Regular.otf", ["yue"]],
      ["NotoNastaliqUrdu-Regular.ttf", ["ur"]],
    ]);
    // They follow every default face, so the chain order for every other language is unchanged.
    const firstAware = CAPTION_FALLBACK_FONTS.findIndex((font) => "languages" in font);
    expect(CAPTION_FALLBACK_FONTS.slice(firstAware).filter((font) => font.role === "script" && !("languages" in font))).toEqual([]);
  });

  test("Indic, Southeast Asian and Arabic-script faces take no caption letter spacing", () => {
    const disabled = ["Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Lao", "Khmer", "Myanmar", "Nastaliq"];
    for (const name of disabled) {
      const font = CAPTION_FALLBACK_FONTS.find((candidate) => candidate.file.includes(name));
      expect(font?.letterSpacing).toBe("disabled");
    }
  });
});

describe("script coverage of the Scribe catalog", () => {
  test("every script a catalog language is written in has a specimen the pinned chain draws without a missing glyph", () => {
    const scripts = new Set(SCRIBE_LANGUAGES.map((language) => language.script));
    for (const script of scripts) {
      const specimens = SCRIPT_SPECIMENS.filter((specimen) => specimen.script === script);
      expect(specimens.length).toBeGreaterThan(0);
    }
    for (const specimen of SCRIPT_SPECIMENS) {
      const face = faceByAssName.get(specimen.face);
      expect(face).toBeDefined();
      expect(fontFileCovers(captionFallbackFontPath(face!), specimen.text.replaceAll(" ", ""))).toBe(true);
    }
  });

  test("specimens that need shaping collapse code points into fewer glyphs", () => {
    for (const specimen of SCRIPT_SPECIMENS.filter((candidate) => candidate.shaped)) {
      const path = captionFallbackFontPath(faceByAssName.get(specimen.face)!);
      if (path.endsWith("NotoNastaliqUrdu-Regular.ttf")) continue; // fontkit's layout() never returns here; HarfBuzz judges it below.
      const font = create(readFileSync(path)) as unknown as { layout(text: string): { glyphs: unknown[] } };
      const collapsed = specimen.text.split(" ").some((word) => {
        try {
          return font.layout(word).glyphs.length < [...word].length;
        } catch {
          return false; // fontkit 2.0.4 cannot position this word; the libass render judges it.
        }
      });
      expect(collapsed).toBe(true);
    }
  });

  test("HarfBuzz shapes the faces fontkit cannot: Nastaliq Urdu returns, joined into fewer glyphs", () => {
    const path = captionFallbackFontPath(faceByAssName.get("Noto Nastaliq Urdu Regular")!);
    expect(fontFileCovers(path, "اردو زبان")).toBe(true);
    const run = shapeCaptionRun(path, "زبان", true);
    expect(run.notdef).toBe(false);
    expect(run.advanceEm).toBeGreaterThan(1);
    expect(run.inkBottomEm).toBeGreaterThan(0.3);
  });

  test("a face fontkit cannot position still reports its cmap coverage instead of throwing", () => {
    for (const [name, text] of [["Noto Sans Gurmukhi Regular", "ਪੰਜਾਬੀ ਸ੍ਰੀ"], ["Noto Sans Telugu Regular", "క్షత్రియ"]] as const) {
      expect(fontFileCovers(captionFallbackFontPath(faceByAssName.get(name)!), text.replaceAll(" ", ""))).toBe(true);
    }
  });

  test("language-aware languages are drawn by their own face and Mongolian needs only Cyrillic", () => {
    const aware = new Map(CAPTION_FALLBACK_FONTS.flatMap((font) => ("languages" in font ? font.languages!.map((code) => [code, font] as const) : [])));
    for (const code of ["ja", "yue", "ur"]) {
      const specimen = SCRIPT_SPECIMENS.find((candidate) => candidate.language === code)!;
      expect(aware.get(code)!.assName).toBe(specimen.face);
    }
    expect(SCRIBE_LANGUAGES.find((language) => language.code === "mn")?.script).toBe("Cyrillic");
    expect(fontFileCovers(captionFallbackFontPath(faceByAssName.get("Noto Sans Regular")!), "Монгол хэл Өө Үү")).toBe(true);
  });
});
