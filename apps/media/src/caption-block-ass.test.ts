import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import { CAPTION_RTL_MARK, type PlacedGradient } from "@narriflow/caption-fonts/caption-block";
import type { CompositionCaptionBlock, CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
  CAPTION_DECORATION,
  CAPTION_MOTIONS,
  CAPTION_SHAPES,
  CAPTION_SOFT_SHADOW,
  captionBlockAnimation,
  captionDynamicStyle,
  captionEntranceKeyframes,
  captionPresetSchema,
  captionShapeAssDrawing,
  getCaptionPresetById,
} from "@narriflow/validators";
import { CANVAS, dynamicCaptionFixtures, dynamicCaptionLayers } from "../scripts/dynamic-caption-fixtures";
import { brandFontRenderer } from "./brand-font-parser";
import { brandFontKey, type RenderBrandFonts } from "./brand-font-resolution";
import { CAPTION_GRADIENT_BANDS, captionBlockGeometry, captionGradientBands, renderCaptionTrack } from "./caption-ass";

/**
 * The Caption Block painter's ASS (spec 5.6 painting, 5.7): one event per word
 * per paint layer, from the word's first spoken time to the cue's end, placed
 * and timed by the shared geometry. caption-block-render.test.ts checks the
 * same events against real libass pixels.
 */
type BlockLayer = CompositionCaptionVisualLayer & { readonly block: CompositionCaptionBlock };

interface Dialogue {
  readonly layer: number;
  readonly start: string;
  readonly end: string;
  readonly text: string;
}

function dialogues(ass: string): Dialogue[] {
  return ass
    .split("\n")
    .filter((line) => line.startsWith("Dialogue:"))
    .map((line) => {
      const fields = line.slice("Dialogue: ".length).split(",");
      return { layer: Number(fields[0]), start: fields[1]!, end: fields[2]!, text: fields.slice(9).join(",") };
    });
}

const assTime = (seconds: number) => {
  const cs = Math.round(seconds * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, "0")}:${String(Math.floor((cs % 6000) / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const num = (value: number) => String(Math.round(value * 100) / 100);
const numbers = (tag: string, text: string) => {
  const match = new RegExp(`\\\\${tag}\\(([^)]*)\\)`).exec(text);
  return match ? match[1]!.split(",").map(Number) : null;
};

/** Block paint layers in caption-ass.ts (`LAYER.plate`, `LAYER.shadow`, `LAYER.text`): no catalog style draws an outline or glow. */
const TILE_LAYER = 0;
const SHADOW_LAYER = 1;
const TEXT_LAYER = 5;
/** Decorations (`LAYER.decorationShadow`, `LAYER.decoration`). */
const DECORATION_SHADOW_LAYER = 14;
const DECORATION_LAYER = 15;
const clipOf = (text: string) => numbers("clip", text);
/**
 * An sfnt wrapped as an uncompressed WOFF 1: fontkit (the glyph planner) reads it, HarfBuzz refuses it,
 * which is exactly a face the block painter cannot measure.
 */
function woff1(sfnt: Buffer): Buffer {
  const count = sfnt.readUInt16BE(4);
  const tables = Array.from({ length: count }, (_, index) => {
    const record = 12 + 16 * index;
    return { tag: sfnt.readUInt32BE(record), checksum: sfnt.readUInt32BE(record + 4), offset: sfnt.readUInt32BE(record + 8), length: sfnt.readUInt32BE(record + 12) };
  });
  const pad = (length: number) => (length + 3) & ~3;
  const header = Buffer.alloc(44 + 20 * count);
  let offset = header.length;
  const bodies = tables.map((table, index) => {
    const entry = 44 + 20 * index;
    header.writeUInt32BE(table.tag, entry);
    header.writeUInt32BE(offset, entry + 4);
    header.writeUInt32BE(table.length, entry + 8);
    header.writeUInt32BE(table.length, entry + 12);
    header.writeUInt32BE(table.checksum, entry + 16);
    offset += pad(table.length);
    return Buffer.concat([sfnt.subarray(table.offset, table.offset + table.length), Buffer.alloc(pad(table.length) - table.length)]);
  });
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(sfnt.readUInt32BE(0), 4);
  header.writeUInt32BE(offset, 8);
  header.writeUInt16BE(count, 12);
  header.writeUInt32BE(12 + 16 * count + tables.reduce((total, table) => total + pad(table.length), 0), 16);
  header.writeUInt16BE(1, 20);
  return Buffer.concat([header, ...bodies]);
}

const fixtures = dynamicCaptionFixtures();
const fixture = (id: string) => fixtures.find((candidate) => candidate.id === id)!;
const blockLayers = (id: string) => dynamicCaptionLayers(fixture(id)) as BlockLayer[];

describe("Caption Block ASS", () => {
  test("every script asks libass to kern, classic and block alike", () => {
    const classic: CompositionCaptionVisualLayer = { ...blockLayers("headline-en")[0]!, preset: getCaptionPresetById("bold-pop")!.preset };
    delete (classic as { block?: unknown }).block;
    for (const layers of [blockLayers("headline-en"), [classic]]) {
      const { ass } = renderCaptionTrack({ layers, canvas: CANVAS });
      const info = ass.slice(0, ass.indexOf("[V4+ Styles]"));
      expect(info).toContain("\nKerning: yes\n");
    }
  });

  for (const { id } of fixtures) {
    test(`${id}: one event per word per paint layer, from its onset to the cue's end, at the geometry's centre`, () => {
      const layers = blockLayers(id);
      const { ass, geometryUnavailable } = renderCaptionTrack({ layers, canvas: CANVAS });
      expect(geometryUnavailable).toEqual([]);
      const events = dialogues(ass);
      for (const cue of layers) {
        expect(cue.block).toBeDefined();
        const geometry = captionBlockGeometry({ cue, canvas: CANVAS });
        const end = assTime(cue.activeRange.endSec);
        const cueEvents = events.filter((event) => cue.words.some((word) => assTime(word.startSec) === event.start));
        // Spec section 8 budget.
        expect(cueEvents.length).toBeLessThanOrEqual(120);
        const style = captionDynamicStyle(cue.block.style);
        cue.words.forEach((word, index) => {
          const placed = geometry.layout.words[index]!;
          const own = cueEvents.filter((event) => event.start === assTime(word.startSec) && event.layer < DECORATION_SHADOW_LAYER);
          // One event per soft shadow layer, then the text (one per band for a gradient hero); a tile and its hard shadow below them.
          const shadows = cue.preset.shadow === "soft" ? (style.softShadow?.length ?? 1) : cue.preset.shadow === "none" ? 0 : 1;
          const tiles = placed.tile ? (placed.tile.shadowOffset > 0 ? 2 : 1) : 0;
          const banded = geometry.layout.gradient !== null && cue.block.roles[index] === "hero";
          const texts = own.filter((event) => event.layer === TEXT_LAYER).length;
          if (banded) expect(texts).toBeGreaterThan(1);
          expect(own.map((event) => event.layer).sort((a, b) => a - b)).toEqual([
            ...Array<number>(tiles).fill(TILE_LAYER),
            ...Array<number>(shadows).fill(SHADOW_LAYER),
            ...Array<number>(banded ? texts : 1).fill(TEXT_LAYER),
          ]);
          // Only the fill is banded: every text event of a gradient hero is clipped, nothing else is.
          for (const event of own) expect(clipOf(event.text) !== null).toBe(banded && event.layer === TEXT_LAYER);
          const turn = /\\frz(-?[\d.]+)/.exec(own.find((event) => event.layer === TEXT_LAYER)!.text)?.[1];
          for (const event of own) {
            expect(event.end).toBe(end);
            expect(event.text.startsWith("{\\an5")).toBe(true);
            // Tiles share the word's pivot and turn, so they enter and settle with it.
            expect(numbers("org", event.text)).toEqual([Number(num(placed.centerX)), Number(num(placed.centerY))]);
            expect(/\\frz(-?[\d.]+)/.exec(event.text)?.[1]).toBe(turn);
            if (event.layer === TILE_LAYER) expect(event.text).toContain("\\p1}m ");
            // An RTL word's events start with the bidi mark, so libass orders it as the Studio does.
            else expect(event.text.replace(/\{[^}]*\}/g, "")).toBe((geometry.words[index]!.direction === "rtl" ? CAPTION_RTL_MARK : "") + geometry.words[index]!.text);
          }
        });
        // Decorations: the shared shape on its own layers, from the hero's onset to the cue's end.
        const decorated = cueEvents.filter((event) => event.layer >= DECORATION_SHADOW_LAYER);
        const shadowLayers = cue.preset.shadow === "soft" ? (style.softShadow ?? [CAPTION_SOFT_SHADOW]).length : cue.preset.shadow === "none" ? 0 : 1;
        expect(decorated).toHaveLength(geometry.layout.decorations.length * (shadowLayers + 1));
        for (const decoration of geometry.layout.decorations) {
          const drawing = captionShapeAssDrawing(CAPTION_SHAPES[decoration.shape], decoration.bounds.width, decoration.bounds.height);
          const own = decorated.filter((event) =>
            event.text.endsWith(`\\p1}${drawing}{\\p0}`) &&
            Math.abs(numbers("pos", event.text)![0]! - (decoration.bounds.x + decoration.bounds.width / 2)) < 0.01 &&
            // Shadows sit a little lower; another star of the same size is far away.
            Math.abs(numbers("pos", event.text)![1]! - (decoration.bounds.y + decoration.bounds.height / 2)) < decoration.bounds.height / 2);
          expect(own.map((event) => event.layer)).toEqual([...Array<number>(shadowLayers).fill(DECORATION_SHADOW_LAYER), DECORATION_LAYER]);
          for (const event of own) {
            expect(event.start).toBe(assTime(decoration.startSec));
            expect(event.end).toBe(end);
            expect(numbers("pos", event.text)![0]).toBeCloseTo(decoration.bounds.x + decoration.bounds.width / 2, 1);
          }
        }
      }
    });
  }

  test("gradient bands: whole even rows, at most 8 px, at most 48 per hero word, mint at the top to green at the bottom", () => {
    for (const id of ["headline-en", "headline-number-unit", "headline-short-words", "headline-long-hero-fit"]) {
      const [cue] = blockLayers(id);
      const geometry = captionBlockGeometry({ cue: cue!, canvas: CANVAS });
      expect(geometry.layout.gradient, id).not.toBeNull();
      const events = dialogues(renderCaptionTrack({ layers: [cue!], canvas: CANVAS }).ass);
      cue!.block.roles.forEach((role, index) => {
        if (role !== "hero") return;
        const placed = geometry.layout.words[index]!;
        const bands = events.filter((event) => event.layer === TEXT_LAYER && event.start === assTime(cue!.words[index]!.startSec)).map((event) => {
          const [left, top, right, bottom] = clipOf(event.text)!;
          return { left: left!, top: top!, right: right!, bottom: bottom!, color: /\\1c&H([0-9A-F]{6})&/.exec(event.text)![1]! };
        });
        expect(bands.length).toBeLessThanOrEqual(CAPTION_GRADIENT_BANDS.maxPerWord);
        bands.forEach((band, at) => {
          expect(band.top % 2).toBe(0);
          expect(band.bottom % 2).toBe(0);
          expect(band.bottom - band.top).toBeLessThanOrEqual(CAPTION_GRADIENT_BANDS.maxHeightPx);
          expect([band.left, band.right]).toEqual([0, CANVAS.width]);
          // Contiguous, top to bottom.
          if (at > 0) expect(band.top).toBe(bands[at - 1]!.bottom);
        });
        // They cover the rest ink, the hero's rise from 0.12 em below and two sigmas of its blur.
        const word = geometry.words[index]!;
        expect(bands[0]!.top).toBeLessThanOrEqual(placed.baselineY - word.measured.inkTopEm * placed.px - 2 * 0.04 * placed.px);
        expect(bands.at(-1)!.bottom).toBeGreaterThanOrEqual(placed.baselineY + word.measured.inkBottomEm * placed.px + (0.12 + 2 * 0.04) * placed.px);
        // ASS colours are BGR: mint (#A5EBC5) above, green (#36B780) below.
        expect(bands[0]!.color).toBe("C5EBA5");
        expect(bands.at(-1)!.color).toBe("80B736");
      });
      expect(events.length, id).toBeLessThanOrEqual(120);
    }
  });

  test("bands grow past 8 px only when 48 of them could not cover the span", () => {
    const gradient: PlacedGradient = { top: 1000, bottom: 1300, topColor: "#A5EBC5", bottomColor: "#36B780" };
    const fits = captionGradientBands({ top: 951, bottom: 1330, left: 0, right: 1080, gradient });
    expect(fits.every((band) => band.bottom - band.top === 8)).toBe(true);
    expect(fits[0]!.top).toBe(950);
    expect(fits.length).toBe(Math.ceil((1330 - 950) / 8));
    const huge = captionGradientBands({ top: 800, bottom: 1400, left: 0, right: 1080, gradient });
    expect(huge.length).toBeLessThanOrEqual(48);
    expect(huge.every((band) => (band.bottom - band.top) % 2 === 0 && band.top % 2 === 0)).toBe(true);
    expect(huge.at(-1)!.bottom).toBeGreaterThanOrEqual(1400);
    // Held flat beyond the gradient box, interpolated inside it.
    expect(fits[0]!.color).toBe("#A5EBC5");
    expect(fits.at(-1)!.color).toBe("#36B780");
    // Middle row 1146: 146 of 300 px into the box.
    expect(fits.find((band) => band.top === 1142)!.color).toBe("#6FD2A3");
  });

  test("a scaling or turning motion falls back to the flat hero colour: one unclipped text event", () => {
    for (const animation of ["slam", "drop"] as const) {
      const [cue] = blockLayers("headline-en");
      const posed: BlockLayer = { ...cue!, preset: captionPresetSchema.parse({ ...cue!.preset, animation }) };
      expect(captionBlockGeometry({ cue: posed, canvas: CANVAS }).layout.gradient).toBeNull();
      const hero = cue!.block.roles.indexOf("hero");
      const text = dialogues(renderCaptionTrack({ layers: [posed], canvas: CANVAS }).ass)
        .filter((event) => event.layer === TEXT_LAYER && event.start === assTime(cue!.words[hero]!.startSec));
      expect(text).toHaveLength(1);
      expect(clipOf(text[0]!.text)).toBeNull();
      expect(text[0]!.text).toContain("\\1c&H80B736&");
    }
  });

  test("the underline is wiped in from the left by a growing clip; stars pop 40 ms apart", () => {
    const [marker] = blockLayers("marker-en");
    const underline = captionBlockGeometry({ cue: marker!, canvas: CANVAS }).layout.decorations[0]!;
    const fill = dialogues(renderCaptionTrack({ layers: [marker!], canvas: CANVAS }).ass).find((event) => event.layer === DECORATION_LAYER)!;
    const { x, y, width, height } = underline.wipe!.clip;
    expect(fill.text).toContain(`\\clip(${x},${y},${x},${y + height})\\t(60,180,\\clip(${x},${y},${x + width},${y + height}))`);
    expect(fill.text).toContain("\\1c&HFFFFFF&");

    const [stack] = blockLayers("stack-en");
    const stars = dialogues(renderCaptionTrack({ layers: [stack!], canvas: CANVAS }).ass).filter((event) => event.layer === DECORATION_LAYER);
    expect(stars).toHaveLength(CAPTION_DECORATION.stars.sizesEm.length);
    stars.forEach((star, at) => {
      const delay = CAPTION_DECORATION.stars.delayMs + at * CAPTION_DECORATION.stars.staggerMs;
      expect(star.text).toContain(`\\fscx0\\t(${delay},${delay + 80},0.5,\\fscx110)\\t(${delay + 80},${delay + 120},1,\\fscx100)`);
      expect(clipOf(star.text)).toBeNull();
    });
  });

  test("drop rule: a hero with under 300 ms of cue left gets no decoration events", () => {
    for (const id of ["marker-en", "stack-en"]) {
      const [cue] = blockLayers(id);
      const hero = cue!.block.roles.indexOf("hero");
      const short: BlockLayer = { ...cue!, activeRange: { ...cue!.activeRange, endSec: cue!.words[hero]!.startSec + 0.29 } };
      expect(captionBlockGeometry({ cue: short, canvas: CANVAS }).layout.decorations).toEqual([]);
      expect(dialogues(renderCaptionTrack({ layers: [short], canvas: CANVAS }).ass).some((event) => event.layer >= DECORATION_SHADOW_LAYER)).toBe(false);
    }
  });

  test("a neutral word in an RTL cue takes the cue's direction; its events start with U+200F in one of its own faces", () => {
    const [cue] = blockLayers("headline-urdu-punctuation");
    const geometry = captionBlockGeometry({ cue: cue!, canvas: CANVAS });
    const hero = geometry.words.find((word) => word.text === "50،")!;
    expect(hero.direction).toBe("rtl");
    // The mark is drawn by a face that has it and that already draws the word, so the line box is the word's own.
    const mark = hero.parts[0]!;
    expect(mark.text).toBe(CAPTION_RTL_MARK);
    expect(hero.parts.slice(1).some((part) => part.face === mark.face)).toBe(true);
    const text = dialogues(renderCaptionTrack({ layers: [cue!], canvas: CANVAS }).ass).find((event) => event.layer === TEXT_LAYER && event.start === assTime(cue!.words[1]!.startSec))!;
    expect(text.text).toContain(`\\fn${mark.face.assName}\\fs`);
    expect(text.text.replace(/\{[^}]*\}/g, "")).toBe(`${CAPTION_RTL_MARK}50،`);
    // A word with no face of its own that has the mark ("50" in Inter) takes the one that grows its line box least, here none.
    const [urdu] = blockLayers("headline-urdu");
    const digits = captionBlockGeometry({ cue: urdu!, canvas: CANVAS }).words.find((word) => word.text === "50")!;
    const inter = digits.parts[1]!.face;
    expect(digits.parts[0]!.face).not.toBe(inter);
    expect(digits.parts[0]!.face.ascentEm).toBeLessThanOrEqual(inter.ascentEm);
    expect(digits.parts[0]!.face.descentEm).toBeLessThanOrEqual(inter.descentEm);
    expect(digits.ascentEm).toBe(inter.ascentEm);
    expect(digits.descentEm).toBe(inter.descentEm);
    // Latin words keep no mark, in any cue.
    const [latin] = blockLayers("headline-en");
    expect(captionBlockGeometry({ cue: latin!, canvas: CANVAS }).words.every((word) => word.direction === "ltr" && word.parts[0]!.text !== CAPTION_RTL_MARK)).toBe(true);
  });

  test("motion: body words slide sideways by the row's sign, the hero rises with its own track, both on the shared time scale", () => {
    const [cue] = blockLayers("headline-en");
    const geometry = captionBlockGeometry({ cue: cue!, canvas: CANVAS });
    const motion = CAPTION_MOTIONS[captionBlockAnimation(cue!.preset, captionDynamicStyle(cue!.block.style))];
    const text = dialogues(renderCaptionTrack({ layers: [cue!], canvas: CANVAS }).ass).filter((event) => event.layer === TEXT_LAYER);
    cue!.words.forEach((word, index) => {
      const placed = geometry.layout.words[index]!;
      const hero = cue!.block.roles[index] === "hero";
      const keyframes = captionEntranceKeyframes(motion, hero);
      const event = text.find((candidate) => candidate.start === assTime(word.startSec))!;
      const [x1, y1, x2, y2, t1, t2] = numbers("move", event.text)!;
      const offsetX = keyframes.find((frame) => frame.offsetXEm !== undefined)?.offsetXEm ?? 0;
      const offsetY = keyframes.find((frame) => frame.offsetYEm !== undefined)?.offsetYEm ?? 0;
      const travelMs = Math.max(...keyframes.filter((frame) => frame.offsetXEm !== undefined || frame.offsetYEm !== undefined).map((frame) => frame.at));
      expect(x1! - x2!).toBeCloseTo(offsetX * placed.px * placed.motionSign, 1);
      expect(y1! - y2!).toBeCloseTo(offsetY * placed.px, 1);
      expect(t1).toBe(0);
      expect(t2).toBe(Math.round(travelMs * placed.entranceTimeScale));
      // Only the hero carries a blur entrance.
      expect(/\\t\([^)]*\\blur/.test(event.text)).toBe(hero);
    });
  });

  test("a word with too little cue left appears settled, and a word spoken after the cue's end is not drawn", () => {
    const [cue] = blockLayers("headline-en");
    const last = cue!.words[cue!.words.length - 1]!;
    const short: BlockLayer = { ...cue!, activeRange: { ...cue!.activeRange, endSec: last.startSec + 0.05 } };
    const geometry = captionBlockGeometry({ cue: short, canvas: CANVAS });
    expect(geometry.layout.words[cue!.words.length - 1]!.entranceTimeScale).toBe(0);
    const settled = dialogues(renderCaptionTrack({ layers: [short], canvas: CANVAS }).ass).filter((event) => event.start === assTime(last.startSec));
    expect(settled).toHaveLength(2);
    for (const event of settled) {
      expect(event.text).toContain("\\pos(");
      expect(event.text).not.toContain("\\move(");
      expect(event.text).not.toContain("\\fade(");
    }
    const cut: BlockLayer = { ...cue!, activeRange: { ...cue!.activeRange, endSec: last.startSec } };
    const drawn = dialogues(renderCaptionTrack({ layers: [cut], canvas: CANVAS }).ass);
    expect(drawn.some((event) => event.start === assTime(last.startSec))).toBe(false);
    expect(drawn.filter((event) => event.layer === SHADOW_LAYER)).toHaveLength(cue!.words.length - 1);
  });

  test("a letter-spaced word keeps one \\fsp: with Encoding -1 and Kerning: yes libass kerns it as HarfBuzz does", () => {
    const [cue] = blockLayers("headline-en");
    const geometry = captionBlockGeometry({ cue: cue!, canvas: CANVAS });
    const hero = cue!.block.roles.indexOf("hero");
    expect(geometry.words[hero]!.look.letterSpacing).not.toBe(0);
    const { ass } = renderCaptionTrack({ layers: [cue!], canvas: CANVAS });
    expect(ass).toMatch(/^Style: Caption,.*,-1$/m);
    const event = dialogues(ass).find((candidate) => candidate.layer === TEXT_LAYER && candidate.start === assTime(cue!.words[hero]!.startSec))!;
    const spacing = [...event.text.matchAll(/\\fsp(-?[\d.]+)/g)].map((match) => Number(match[1]));
    expect(new Set(spacing)).toEqual(new Set([Number(num(geometry.words[hero]!.look.letterSpacing * geometry.layout.words[hero]!.px))]));
  });

  test("typed degradation: a text face HarfBuzz cannot shape draws the cue as the classic line and records caption_geometry_unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "caption-block-font-"));
    try {
      const unshapeable = join(directory, "upload.woff");
      writeFileSync(unshapeable, woff1(readFileSync(join(CAPTION_FONTS_DIRECTORY, "Inter-SemiBold.ttf"))));
      const reference = { kind: "brand_font" as const, id: "10000000-0000-4000-8000-0000000000b1", fingerprint: "c".repeat(64) };
      const fonts: RenderBrandFonts = new Map([
        [brandFontKey(reference), { ...brandFontRenderer(readFileSync(join(CAPTION_FONTS_DIRECTORY, "Inter-SemiBold.ttf"))), path: unshapeable }],
      ]);
      const [cue] = blockLayers("headline-en");
      const branded: BlockLayer = { ...cue!, preset: captionPresetSchema.parse({ ...cue!.preset, fontAsset: reference }) };
      const { ass, geometryUnavailable } = renderCaptionTrack({ layers: [branded], canvas: CANVAS, fonts });
      expect(geometryUnavailable).toEqual([{ code: "caption_geometry_unavailable", cueIndex: cue!.cueIndex, fontPath: unshapeable }]);
      // The classic line: some event draws every word together, and no event carries a block word's own pivot.
      const events = dialogues(ass);
      expect(events.some((event) => cue!.words.every((word) => event.text.includes(word.text)))).toBe(true);
      const geometry = captionBlockGeometry({ cue: cue!, canvas: CANVAS });
      for (const placed of geometry.layout.words) expect(ass).not.toContain(`\\org(${num(placed.centerX)},${num(placed.centerY)})`);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  test("a classic preset holding a dynamic-only motion draws it as fade", () => {
    const [cue] = blockLayers("headline-en");
    const classic = (animation: "slide" | "fade"): CompositionCaptionVisualLayer => {
      const { block: _block, ...rest } = cue!;
      return { ...rest, preset: captionPresetSchema.parse({ ...getCaptionPresetById("bold-pop")!.preset, animation }) };
    };
    expect(renderCaptionTrack({ layers: [classic("slide")], canvas: CANVAS }).ass).toBe(renderCaptionTrack({ layers: [classic("fade")], canvas: CANVAS }).ass);
  });
});
