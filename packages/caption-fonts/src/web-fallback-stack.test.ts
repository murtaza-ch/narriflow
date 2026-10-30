import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CAPTION_SCRIPT_FACES } from "../../../apps/web/app/caption-script-fonts";
import { CAPTION_FALLBACK_FONTS } from "./fallback-fonts";

// The Studio loads the worker's own fallback faces (apps/web/app/caption-script-fonts.css)
// and walks them in the worker's order (apps/web/app/caption-script-fonts.ts).
interface ManifestFont {
  file: string;
  family: string;
  languages?: string[];
  unicodeRanges: string[];
}
const manifest = JSON.parse(
  readFileSync(new URL("../script-fonts.manifest.json", import.meta.url), "utf8"),
) as { fonts: ManifestFont[] };
const css = readFileSync(new URL("../../../apps/web/app/caption-script-fonts.css", import.meta.url), "utf8");
const rules = [...css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map((match) => {
  const body = match[1]!;
  return {
    family: /font-family:\s*"([^"]+)"/.exec(body)?.[1],
    file: /([^/"]+)"\) format/.exec(body)?.[1],
    ranges: /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.split(",").map((range) => range.trim()),
  };
});

describe("browser fallback faces", () => {
  test("are the worker's script faces, in the worker's order, with the same letter-spacing and language rules", () => {
    const worker = CAPTION_FALLBACK_FONTS.filter((font) => font.role === "script");
    expect(CAPTION_SCRIPT_FACES.map((face) => face.file)).toEqual(worker.map((font) => font.file));
    for (const [index, face] of CAPTION_SCRIPT_FACES.entries()) {
      const font = worker[index]!;
      expect(face.letterSpacing).toBe(font.letterSpacing);
      expect(face.languages).toEqual("languages" in font ? [...font.languages!] : undefined);
      // The @font-face family is the face's family name: the libass name without its style.
      expect(face.family).toBe(font.assName.replace(/ Regular$/, ""));
      expect(manifest.fonts.find((entry) => entry.file === face.file)?.family ?? face.family).toBe(face.family);
    }
  });

  test("every face, and the symbol faces, has one lazy @font-face over the vendored file", () => {
    const symbols = CAPTION_FALLBACK_FONTS.filter((font) => font.role !== "script").map((font) => font.file);
    expect(rules.map((rule) => rule.file).sort()).toEqual([...CAPTION_SCRIPT_FACES.map((face) => face.file), ...symbols].sort());
    for (const face of CAPTION_SCRIPT_FACES) {
      const rule = rules.find((candidate) => candidate.file === face.file)!;
      expect(rule.family).toBe(face.family);
      // A unicode-range is what keeps an English cue from downloading any of them.
      expect(rule.ranges?.length).toBeGreaterThan(0);
    }
    expect(css.match(/^\s*unicode-range:/gm)).toHaveLength(rules.length);
  });

  test("ranges of the manifest's faces are the manifest's", () => {
    for (const entry of manifest.fonts) {
      const rule = rules.find((candidate) => candidate.file === entry.file)!;
      expect(new Set(rule.ranges)).toEqual(new Set(entry.unicodeRanges));
    }
  });
});

