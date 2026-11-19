import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import type { CompositionCaptionBlock, CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
  CAPTION_MOTIONS,
  captionBlockAnimation,
  captionDynamicStyle,
  captionEntranceKeyframes,
  captionPresetSchema,
  getCaptionPresetById,
} from "@narriflow/validators";
import { CANVAS, dynamicCaptionFixtures, dynamicCaptionLayers } from "../scripts/dynamic-caption-fixtures";
import { brandFontRenderer } from "./brand-font-parser";
import { brandFontKey, type RenderBrandFonts } from "./brand-font-resolution";
import { captionBlockGeometry, renderCaptionTrack } from "./caption-ass";

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

/** Block paint layers in caption-ass.ts (`LAYER.shadow`, `LAYER.text`): Headline draws no outline or glow. */
const SHADOW_LAYER = 1;
const TEXT_LAYER = 5;
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
        cue.words.forEach((word, index) => {
          const placed = geometry.layout.words[index]!;
          const own = cueEvents.filter((event) => event.start === assTime(word.startSec));
          expect(own.map((event) => event.layer).sort()).toEqual([SHADOW_LAYER, TEXT_LAYER]);
          for (const event of own) {
            expect(event.end).toBe(end);
            expect(event.text.startsWith("{\\an5")).toBe(true);
            expect(numbers("org", event.text)).toEqual([Number(num(placed.centerX)), Number(num(placed.centerY))]);
            expect(event.text.replace(/\{[^}]*\}/g, "")).toBe(geometry.words[index]!.text);
          }
        });
      }
    });
  }

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
    expect(drawn).toHaveLength(2 * (cue!.words.length - 1));
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
