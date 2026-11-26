import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Measure, type SceneCue, buildCaptionScene, captionSceneEmojiCueBoxes, sceneInputFromPreset } from "@narriflow/caption-scene";
import { type CaptionFontName, captionFontFace, getCaptionPresetById } from "@narriflow/validators";
import { SceneMeasurer } from "./caption-scene-ass";

/**
 * Bubble and Wonky set their words in Rubik, which has the Arabic letters but not Urdu's ہ ے ھ ٹ, so an Urdu word is
 * drawn by Rubik and Noto Nastaliq Urdu together. Chrome and libass shape each face's run inside the word, so the letters
 * keep their joining forms across the change; the worker's HarfBuzz measure has to do the same, or it reserves the
 * isolated forms' width (`کے`: 2.332 em against the 0.892 em both renderers draw) and the export spreads the words.
 *
 * The Studio side is its `canvasMeasure` replayed from a table: the Canvas advance and ink headless Chrome measured for
 * every text these scenes measure (`normal 400 100px` and the face's fallback stack for the language, the letter-spacing
 * runs `measureWord` uses), with the catalog ascent and descent `canvasMeasure` returns. Cues: the emoji fixture's four
 * sentences in Urdu, and the same clip in Arabic (Rubik draws every letter of it).
 */
interface CanvasEntry {
  readonly language: "ur" | "ar";
  readonly text: string;
  readonly face: CaptionFontName;
  readonly letterSpacingEm: number;
  readonly advanceEm: number;
  readonly inkTopEm: number;
  readonly inkBottomEm: number;
}
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__/scene-urdu-studio-canvas.json"), "utf8")) as {
  readonly cues: Record<"ur" | "ar", SceneCue[]>;
  readonly canvas: readonly CanvasEntry[];
};
const canvas = { width: 1080, height: 1920 };

function studioMeasure(language: "ur" | "ar"): Measure {
  const table = new Map(fixture.canvas.filter((entry) => entry.language === language).map((entry) => [`${entry.text}\0${entry.face}\0${entry.letterSpacingEm}`, entry]));
  return (text, face, sizePx, letterSpacingEm) => {
    const entry = table.get(`${text}\0${face}\0${letterSpacingEm}`);
    if (!entry) throw new Error(`no Canvas measurement of ${JSON.stringify(text)} in ${face}`);
    const metrics = captionFontFace(face);
    return { advance: entry.advanceEm * sizePx, inkTop: -entry.inkTopEm * sizePx, inkBottom: entry.inkBottomEm * sizePx, ascent: metrics.ascent * sizePx, descent: metrics.descent * sizePx };
  };
}

function cueBoxes(style: "bubble" | "wonky", language: "ur" | "ar", measure: Measure) {
  const preset = getCaptionPresetById(style)!.preset;
  const input = sceneInputFromPreset(preset, { cues: fixture.cues[language], canvas, measure, fps: 30 });
  return captionSceneEmojiCueBoxes(buildCaptionScene(style, input), { ...input, preset }, measure);
}

describe("Rubik's Urdu and Arabic words measure as the Studio does", () => {
  for (const language of ["ur", "ar"] as const) {
    test(`every text Bubble and Wonky measure in ${language}: the same advance`, () => {
      const worker = new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), language);
      const entries = fixture.canvas.filter((entry) => entry.language === language);
      expect(entries.length).toBeGreaterThan(40);
      const apart = entries
        .map((entry) => ({ text: entry.text, face: entry.face, em: worker.metrics(entry.text, entry.face, entry.letterSpacingEm).advanceEm - entry.advanceEm }))
        .filter(({ em }) => Math.abs(em) > 1e-4);
      expect(apart).toEqual([]);
    });

    for (const style of ["bubble", "wonky"] as const) {
      test(`${style} in ${language}: Studio and export cue boxes within 1 px`, () => {
        const worker = new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), language);
        const exported = cueBoxes(style, language, worker.measure);
        const studio = cueBoxes(style, language, studioMeasure(language));
        expect(studio.length).toBe(fixture.cues[language].length);
        expect(exported.map((cue) => cue.cueIndex)).toEqual(studio.map((cue) => cue.cueIndex));
        const worst = Math.max(...studio.flatMap((cue, at) => (["x1", "y1", "x2", "y2"] as const).map((side) => Math.abs(cue.box[side] - exported[at]!.box[side]))));
        expect(worst).toBeLessThanOrEqual(1);
      });
    }
  }
});
