import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { create } from "fontkit";
import { CAPTION_FALLBACK_FONTS, captionFallbackFontPath, fontFileMetricsEm } from "./fallback-fonts";
import { captionWordLineBoxEm } from "./fallback-line-boxes";
import { CAPTION_FALLBACK_LINE_BOXES } from "./fallback-line-boxes-data";

const css = readFileSync(new URL("../../../apps/web/app/caption-script-fonts.css", import.meta.url), "utf8");
const cssRanges = new Map(
  [...css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map((match) => [/([^/"]+)"\) format/.exec(match[1]!)![1]!, /unicode-range:\s*([^;]+);/.exec(match[1]!)![1]!] as const),
);
const NEUTRAL = /^[\p{Z}\p{P}\p{N}]$/u;

const INTER = { ascentEm: 0.96875, descentEm: 0.2412 };
const latin = (cluster: string) => /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+$/u.test(cluster);
const box = (file: string) => CAPTION_FALLBACK_LINE_BOXES.find((entry) => entry.file === file)!;
const resolve = (text: string, language: string | null = null) => captionWordLineBoxEm(text, INTER, language, latin);

describe("the pinned fallback line boxes", () => {
  test("are the worker's chain, in the worker's order", () => {
    expect(CAPTION_FALLBACK_LINE_BOXES.map((entry) => [entry.file, entry.role, entry.languages])).toEqual(
      CAPTION_FALLBACK_FONTS.map((font) => [font.file, font.role, "languages" in font ? font.languages : undefined]),
    );
  });

  test("hold the Win ascent and descent libass lays a line out with", () => {
    for (const font of CAPTION_FALLBACK_FONTS) {
      const { ascentEm, descentEm } = fontFileMetricsEm(captionFallbackFontPath(font));
      expect(box(font.file).ascentEm, font.file).toBe(ascentEm);
      expect(box(font.file).descentEm, font.file).toBe(descentEm);
    }
  });

  test("hold the unicode-range the browser walks", () => {
    const expected = (file: string) =>
      cssRanges.get(file)!.split(",").map((part) => {
        const [from, to = from] = part.trim().replace(/^U\+/, "").split("-");
        return [Number.parseInt(from!, 16), Number.parseInt(to!, 16)];
      });
    for (const entry of CAPTION_FALLBACK_LINE_BOXES) expect(entry.ranges, entry.file).toEqual(expected(entry.file));
  });

  test("hold the spaces, punctuation and digits each face draws", () => {
    for (const font of CAPTION_FALLBACK_FONTS) {
      const face = create(readFileSync(captionFallbackFontPath(font))) as unknown as { characterSet: number[] };
      const drawn = face.characterSet.filter((codePoint) => NEUTRAL.test(String.fromCodePoint(codePoint))).sort((left, right) => left - right);
      const inTable = (codePoint: number) => box(font.file).neutral.some(([from, to]) => codePoint >= from && codePoint <= to);
      expect(drawn.every(inTable), font.file).toBe(true);
      const total = box(font.file).neutral.reduce((sum, [from, to]) => sum + to - from + 1, 0);
      expect(total, font.file).toBe(drawn.length);
    }
  });
});

describe("captionWordLineBoxEm", () => {
  test("a word the requested face draws keeps the requested face's box", () => {
    for (const text of ["hello", "BEST", "dollars.", "1,000", "“quoted”", ""]) expect(resolve(text), text).toEqual(INTER);
  });

  test("an Urdu word is Nastaliq's box when the cue is Urdu, Noto Sans Arabic's otherwise", () => {
    const nastaliq = box("NotoNastaliqUrdu-Regular.ttf");
    expect(resolve("فیصد", "ur")).toEqual({ ascentEm: nastaliq.ascentEm, descentEm: nastaliq.descentEm });
    const arabic = box("NotoSansArabic-Regular.ttf");
    expect(resolve("فیصد", "en")).toEqual({ ascentEm: arabic.ascentEm, descentEm: arabic.descentEm });
    expect(resolve("فیصد")).toEqual({ ascentEm: arabic.ascentEm, descentEm: arabic.descentEm });
  });

  test("a Japanese word is Noto Sans JP's box when the cue is Japanese", () => {
    const jp = box("NotoSansJP-Regular.otf");
    expect(resolve("今日は", "ja")).toEqual({ ascentEm: jp.ascentEm, descentEm: jp.descentEm });
    // Han goes to Noto Sans SC otherwise, whose box is the same size.
    const sc = box("NotoSansSC-Regular.otf");
    expect(resolve("今日", "zh")).toEqual({ ascentEm: sc.ascentEm, descentEm: sc.descentEm });
  });

  test("a word of both faces takes the tallest ascent and the deepest descent", () => {
    const nastaliq = box("NotoNastaliqUrdu-Regular.ttf");
    // Digits after the Latin face stay in it; the comma is the Urdu face's, so the line box grows.
    expect(resolve("50،", "ur")).toEqual({ ascentEm: Math.max(INTER.ascentEm, nastaliq.ascentEm), descentEm: Math.max(INTER.descentEm, nastaliq.descentEm) });
    const jp = box("NotoSansJP-Regular.otf");
    expect(resolve("3回", "ja")).toEqual({ ascentEm: Math.max(INTER.ascentEm, jp.ascentEm), descentEm: Math.max(INTER.descentEm, jp.descentEm) });
  });

  test("a neutral cluster stays in the fallback face before it when that face draws it", () => {
    const nastaliq = box("NotoNastaliqUrdu-Regular.ttf");
    // Nastaliq draws the full stop and the digits, so the Latin face adds nothing to these words.
    expect(resolve("اب.", "ur")).toEqual({ ascentEm: nastaliq.ascentEm, descentEm: nastaliq.descentEm });
    expect(resolve("اب50", "ur")).toEqual({ ascentEm: nastaliq.ascentEm, descentEm: nastaliq.descentEm });
    // It does not draw "@": that falls back to the requested face.
    expect(resolve("اب@", "ur").ascentEm).toBe(Math.max(INTER.ascentEm, nastaliq.ascentEm));
    const jp = box("NotoSansJP-Regular.otf");
    expect(resolve("今日は。", "ja")).toEqual({ ascentEm: jp.ascentEm, descentEm: jp.descentEm });
  });

  test("emoji take the monochrome emoji face", () => {
    const emoji = box("NotoEmoji-Regular.ttf");
    expect(resolve("❤️")).toEqual({ ascentEm: emoji.ascentEm, descentEm: emoji.descentEm });
  });
});
