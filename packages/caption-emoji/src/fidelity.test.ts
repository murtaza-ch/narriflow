import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCatalog } from "../scripts/catalog";
import { compare, compiledSvg, MAX_WRONG_SHARE, render } from "../scripts/fidelity";
import { scoreOutline } from "../scripts/outline-check";
import { loadCaptionEmojiArt } from "./art";
import { CAPTION_EMOJI_DEFAULT_PALETTE } from "./index";

// The full proof (every design, and the 900 skin-tone files) is `bun run verify`; this keeps the
// constructs that broke or could break in the compiler under test.
const HARD_CASES = [
  "dotted-line-face", // dashed circle
  "roller-coaster", // dashed path, style stroke width
  "fire-engine", // holes between strokes of one path, mirrored group
  "donut", // even-odd fill, opacity
  "triangular-ruler", // even-odd fill
  "office-treats", // even-odd inside a phrase badge
  "anger-symbol", // opacity
  "confetti-ball", // opacity
  "tongue", // opacity, style stroke width
  "stadium", // style stroke width
  "violin", // style stroke width
  "chains", // interlocking same-colour layers
  "heart", // control points outside the grid
  "waving-hand", // skin role, nested rotate and scale
  "student", // per-tone face features
  "woman-astronaut", // a whole face hidden under the helmet
];

// Outlines Skia's stroker got wrong (tiny round shapes in a wide band) or that need the closing.
const OUTLINE_CASES = ["sun-behind-large-cloud", "police-car-light", "person-raising-hand", "dotted-line-face", "snowflake", "musical-score", "roller-coaster"];

// Designs drawn for Narriflow after the pack: no pack file checks them, so this does, in full.
const OWN_DESIGNS = ["kitchen-knife", "bird", "auto-rickshaw", "handshake"];

const catalog = readCatalog(join(import.meta.dir, "..", "source"));
const sample = new Set([...HARD_CASES, ...OWN_DESIGNS, ...catalog.designs.filter((_, i) => i % 25 === 0).map((d) => d.id)]);
const arts = await loadCaptionEmojiArt(sample);

describe("compiled emoji match their source SVG at 128 px", () => {
  for (const id of sample) {
    test(id, () => {
      const design = catalog.designs.find((d) => d.id === id);
      expect(design).toBeDefined();
      const source = render(readFileSync(join(import.meta.dir, "..", "source", design!.file), "utf8"));
      const score = compare(source, render(compiledSvg(arts.get(id)!, CAPTION_EMOJI_DEFAULT_PALETTE)));
      expect(score.wrongShare).toBeLessThanOrEqual(MAX_WRONG_SHARE);
    });
  }
});

describe("sticker outlines are an even band round the silhouette", () => {
  for (const id of [...OUTLINE_CASES, ...HARD_CASES.slice(0, 5), ...OWN_DESIGNS]) {
    test(id, async () => {
      const art = (await loadCaptionEmojiArt([id])).get(id)!;
      const score = scoreOutline(art.layers.map((layer) => layer.d), art.outline);
      expect(score).toMatchObject({ missing: 0, uncovered: 0, slivers: 0, holes: 0 });
    });
  }
});
