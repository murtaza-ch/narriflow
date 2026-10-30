import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { measureCaptionFallbackInkEm } from "./caption-script-fonts";

/**
 * The browser's Canvas and FontFaceSet, stubbed: Canvas reports the ink of whichever faces have loaded, and
 * FontFaceSet.check says whether a face covering the text is still on its way (a lazy script face).
 */
const NASTALIQ = "Noto Nastaliq Urdu";
const loaded = new Set<string>(['"Uploaded"']);
let measures = 0;

const globals = globalThis as { document?: unknown };
const originalDocument = globals.document;

beforeAll(() => {
  const context = {
    font: "",
    measureText: () => {
      measures += 1;
      // Until Nastaliq loads, the browser draws Urdu in a stand-in: short ink. Afterwards, tall swashes.
      return loaded.has(`"${NASTALIQ}"`)
        ? { actualBoundingBoxAscent: 163, actualBoundingBoxDescent: 34 }
        : { actualBoundingBoxAscent: 72, actualBoundingBoxDescent: 0 };
    },
  };
  const check = (font: string, text?: string) => {
    const family = /px (.*)$/.exec(font)![1]!;
    // Nastaliq covers only Arabic-script text; every other family in the stack is loaded.
    return family !== `"${NASTALIQ}"` || !/\p{Script=Arabic}/u.test(text ?? "") || loaded.has(family);
  };
  globals.document = { createElement: () => ({ getContext: () => context }), fonts: { check } };
});
afterAll(() => {
  globals.document = originalDocument;
});

const face = { requestedFamily: '"Uploaded"', weight: 400, style: "normal", language: "ur" } as const;

describe("fallback ink while lazy faces load", () => {
  test("a reading taken before the script face loaded is not kept: the next call measures the new ink", () => {
    const before = measureCaptionFallbackInkEm("مُحَبَّتُوں", face);
    expect(before).toEqual({ topEm: 0.72, bottomEm: 0 });
    const afterFirst = measures;

    loaded.add(`"${NASTALIQ}"`);
    const after = measureCaptionFallbackInkEm("مُحَبَّتُوں", face);
    expect(after).toEqual({ topEm: 1.63, bottomEm: 0.34 });
    expect(measures).toBeGreaterThan(afterFirst);
  });

  test("once every face is loaded the reading is cached", () => {
    measureCaptionFallbackInkEm("مُحَبَّتُوں", face);
    const settled = measures;
    expect(measureCaptionFallbackInkEm("مُحَبَّتُوں", face)).toEqual({ topEm: 1.63, bottomEm: 0.34 });
    expect(measures).toBe(settled);
  });

  test("Latin text in the requested face has no ink to measure", () => {
    const settled = measures;
    expect(measureCaptionFallbackInkEm("Hello", face)).toEqual({ topEm: 0, bottomEm: 0 });
    expect(measures).toBe(settled);
  });
});
