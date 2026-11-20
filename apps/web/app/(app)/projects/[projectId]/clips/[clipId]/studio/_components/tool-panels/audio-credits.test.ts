import { describe, expect, test } from "bun:test";
import { audioCreditAssetIds, audioCreditLines, joinAudioCredits } from "./audio-credits";

const CREDIT_A = '"Sneaky Snitch" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0\nhttps://creativecommons.org/licenses/by/4.0/';
const CREDIT_B = '"Monkeys Spinning Monkeys" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0\nhttps://creativecommons.org/licenses/by/4.0/';

const attributions = new Map<string, string | null>([
  ["a", CREDIT_A],
  ["b", CREDIT_B],
  ["free", null],
]);

const edits = (music: (string | null)[], sfx: (string | null)[] = []) => ({
  music: { blocks: music.map((assetId) => ({ assetId })) },
  sfx: sfx.map((assetId) => ({ assetId })),
});

describe("audioCreditLines", () => {
  test("lists each credit once, in the order tracks appear", () => {
    expect(audioCreditLines(edits(["b", "a", "b"]), attributions)).toEqual([CREDIT_B, CREDIT_A]);
  });

  test("music comes before sound effects", () => {
    expect(audioCreditLines(edits(["a"], ["b"]), attributions)).toEqual([CREDIT_A, CREDIT_B]);
  });

  test("CC0, pasted-link and unknown assets owe nothing", () => {
    expect(audioCreditLines(edits(["free", null, "uncached"], [null]), attributions)).toEqual([]);
  });

  test("two assets sharing one credit line list it once", () => {
    const shared = new Map<string, string | null>([["a", CREDIT_A], ["a2", CREDIT_A]]);
    expect(audioCreditLines(edits(["a", "a2"]), shared)).toEqual([CREDIT_A]);
  });
});

describe("audioCreditAssetIds", () => {
  test("lists each used asset once, music before sound effects, skipping empty ids", () => {
    expect(audioCreditAssetIds(edits(["b", null, "a", "b"], ["c", "a", null]))).toEqual(["b", "a", "c"]);
    expect(audioCreditAssetIds(edits([]))).toEqual([]);
  });
});

describe("joinAudioCredits", () => {
  test("separates tracks with a blank line", () => {
    expect(joinAudioCredits([CREDIT_A, CREDIT_B])).toBe(`${CREDIT_A}\n\n${CREDIT_B}`);
    expect(joinAudioCredits([])).toBe("");
  });
});
