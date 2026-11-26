import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CaptionEmojiArt, loadCaptionEmojiArt } from "@narriflow/caption-emoji/art";
import {
  CAPTION_EMOJI_AI_BADGES,
  CAPTION_EMOJI_AI_GLYPHS,
  CAPTION_EMOJI_COUNT,
  CAPTION_EMOJI_GROUPS,
  CAPTION_EMOJI_INDEX,
  type CaptionEmojiEntry,
  emojiRefForGlyph,
  resolveCaptionEmojiColour,
} from "@narriflow/caption-emoji/index";
import { CAPTION_EMOJI_PIECE_CAP, captionEmojiLayerStyle, placeCaptionEmojis } from "@narriflow/caption-scene";
import { planClipComposition } from "@narriflow/composition-plan";
import { EMOJI_TAGGING_SYSTEM_PROMPT } from "@narriflow/services/clip-emoji-tagging";
import { captionPresetSchema, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import {
  buildEmojiSearch,
  captionEmojiPickerGroups,
  captionEmojiQueryTone,
  pickedEmojiRef,
  searchCaptionEmojis,
} from "../../web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/emoji-picker-model";
import { SceneMeasurer, sceneEvents } from "./caption-scene-ass";

/**
 * Every emoji works, read from the catalog (2,317 rows: the owner's pack, 1,008 single designs, 400
 * phrase badges and 900 skin-tone variants of 180 designs, plus four single designs drawn for
 * Narriflow later, the handshake with five tones): each row resolves to a ref by
 * its glyph and by its name, its art loads and every layer has a colour at its tone, the picker lists
 * it in its group and stores it at that tone, and the export's emoji writer draws it within the cap.
 * The AI is offered every single design and every badge, and every design with skin takes the
 * preset's Skin tone when the AI places it. The variants' SVG files are not committed; their pixels
 * are checked by `caption-emoji verify` against the extracted pack (the handshake's tones are the
 * plain skin swap and have no file).
 */

interface CatalogRow {
  readonly name: string;
  readonly fallback: string;
  readonly design?: string;
  readonly skinTone?: string;
}

const ROWS = JSON.parse(readFileSync(join(import.meta.dir, "../../../packages/caption-emoji/source/catalog.json"), "utf8")) as CatalogRow[];
const TONES = ["light", "medium-light", "medium", "medium-dark", "dark"];
const BY_NAME = new Map(CAPTION_EMOJI_INDEX.map((entry) => [entry.name, entry]));

/** The design and tone a catalog row is: a variant is its base design in its tone. */
function expected(row: CatalogRow): { entry: CaptionEmojiEntry; tone: number } {
  const entry = BY_NAME.get(row.design ?? row.name);
  if (!entry) throw new Error(`no design for ${row.name}`);
  return { entry, tone: row.skinTone === undefined ? 0 : TONES.indexOf(row.skinTone) + 1 };
}

/** Each walk covers all 2,317 rows; the export walk takes about 3 s alone and more when the suite runs in parallel. */
const WALK_MS = 30_000;

const CANVAS = { width: 1080, height: 1920 };
const CUE = { cueIndex: 0, box: { x1: 240, y1: 1300, x2: 840, y2: 1400 }, fromMs: 0, toMs: 2000, bodyPx: 80, tiltDeg: 0, direction: "ltr" as const };
const STYLE = captionEmojiLayerStyle(getCaptionPresetById("bold-pop")!.preset);
const SHAPES_ONLY = new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), null);

let art: Map<string, CaptionEmojiArt>;
beforeAll(async () => {
  art = await loadCaptionEmojiArt(CAPTION_EMOJI_INDEX.map((entry) => entry.id));
});

/** The export's events for one emoji alone on a cue, through the shared builder and the Scene writer. */
function exportEvents(id: string, tone: number, style = STYLE) {
  const [outcome] = placeCaptionEmojis({ cueBoxes: [CUE], emojis: [{ cueIndex: 0, id, ...(tone ? { tone } : {}), atMs: 0 }], art, style, canvas: CANVAS, anchorYPct: 72 });
  if (!outcome?.placed) return { placed: false as const, reason: outcome && !outcome.placed ? outcome.reason : "none" };
  return { placed: true as const, pieces: outcome.pieces.length, events: sceneEvents({ pieces: outcome.pieces }, SHAPES_ONLY, { canvas: CANVAS }).map((event) => event.text) };
}

describe("the whole emoji catalog", () => {
  test("the catalog is 2,317 emojis, and the index counts the same", () => {
    expect(ROWS).toHaveLength(2317);
    expect(ROWS.filter((row) => row.design === undefined && BY_NAME.get(row.name)?.kind === "single")).toHaveLength(1012);
    expect(ROWS.filter((row) => row.design === undefined && BY_NAME.get(row.name)?.kind === "phrase")).toHaveLength(400);
    expect(ROWS.filter((row) => row.design !== undefined)).toHaveLength(905);
    expect(CAPTION_EMOJI_COUNT).toBe(ROWS.length);
  });

  test("every emoji resolves by its glyph and by its name, to its design at its tone", () => {
    const search = buildEmojiSearch(CAPTION_EMOJI_INDEX, CAPTION_EMOJI_GROUPS);
    let checked = 0;
    for (const row of ROWS) {
      const { entry, tone } = expected(row);
      expect(emojiRefForGlyph(row.fallback)).toEqual(tone ? { id: entry.id, tone: tone as 1 | 2 | 3 | 4 | 5 } : { id: entry.id });
      // The picker's search, as a person types the pack's name ("Waving hand: dark skin tone").
      expect(searchCaptionEmojis(search, row.name, emojiRefForGlyph)[0]?.id).toBe(entry.id);
      expect(captionEmojiQueryTone(row.name, emojiRefForGlyph)).toBe(tone || null);
      // And as a pasted glyph.
      expect(searchCaptionEmojis(search, row.fallback, emojiRefForGlyph)[0]?.id).toBe(entry.id);
      checked++;
    }
    console.log(`caption emoji catalog: ${checked} emojis resolved by glyph and by name`);
    expect(checked).toBe(2317);
  }, WALK_MS);

  test("every emoji's art loads and every layer has a colour at its tone; a tone changes only designs with skin", () => {
    let checked = 0;
    for (const row of ROWS) {
      const { entry, tone } = expected(row);
      const design = art.get(entry.id);
      expect(design).toBeDefined();
      const colours = design!.layers.map((layer) => resolveCaptionEmojiColour(layer.colour, STYLE.palette, tone));
      for (const colour of colours) if (colour !== null) expect(colour).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(colours.filter((colour) => colour !== null).length).toBeGreaterThan(0);
      const plain = design!.layers.map((layer) => resolveCaptionEmojiColour(layer.colour, STYLE.palette, 0));
      if (tone > 0) expect(colours).not.toEqual(plain);
      // The Skin tone reaches every emoji; a design without skin must look the same in all six.
      if (!entry.hasTones) for (const other of [1, 2, 3, 4, 5]) expect(design!.layers.map((layer) => resolveCaptionEmojiColour(layer.colour, STYLE.palette, other))).toEqual(plain);
      checked++;
    }
    expect(checked).toBe(2317);
  }, WALK_MS);

  test("the picker lists every emoji in its group, and a pick at the emoji's tone stores that tone", () => {
    const groups = captionEmojiPickerGroups(CAPTION_EMOJI_INDEX, CAPTION_EMOJI_GROUPS);
    const groupOf = new Map(groups.flatMap((group) => group.items.map((item) => [item.id, group.id] as const)));
    let checked = 0;
    for (const row of ROWS) {
      const { entry, tone } = expected(row);
      expect(groupOf.get(entry.id)).toBe(entry.group);
      // A variant's design is drawn in the tone choice (the grid draws `hasTones ? tone : 0`).
      if (tone > 0) expect(entry.hasTones).toBe(true);
      expect(pickedEmojiRef(entry, tone)).toEqual(entry.hasTones ? { id: entry.id, tone } : { id: entry.id });
      checked++;
    }
    expect(checked).toBe(2317);
  }, WALK_MS);

  test("the export's emoji writer draws every emoji, within the piece cap, its tone in the events", () => {
    const plainEvents = new Map<string, readonly string[]>();
    let checked = 0;
    for (const row of ROWS) {
      const { entry, tone } = expected(row);
      const drawn = exportEvents(entry.id, tone);
      expect(drawn).toMatchObject({ placed: true });
      if (!drawn.placed) continue;
      expect(drawn.pieces).toBeLessThanOrEqual(CAPTION_EMOJI_PIECE_CAP);
      expect(drawn.events).toHaveLength(drawn.pieces);
      for (const text of drawn.events) expect(text).toContain("\\p1");
      if (tone === 0) plainEvents.set(entry.id, drawn.events);
      else expect(drawn.events).not.toEqual(plainEvents.get(entry.id));
      checked++;
    }
    console.log(`caption emoji catalog: ${checked} emojis drawn by the export writer`);
    expect(checked).toBe(2317);
  }, WALK_MS);

  test("the export draws a face in the template's colours, like every design", () => {
    const headline = captionEmojiLayerStyle(getCaptionPresetById("headline")!.preset);
    const ass = (hex: string) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();
    for (const id of ["heart-eyes", "sun-with-face", "grinning-cat"]) {
      const drawn = exportEvents(id, 0, headline);
      if (!drawn.placed) throw new Error(`${id} not placed`);
      const text = drawn.events.join("\n").toUpperCase();
      expect(text).toContain(ass(headline.palette.a));
      expect(text).not.toContain(ass("#ffe45c"));
    }
  });

  test("the AI is offered every single design and every badge", () => {
    const singles = CAPTION_EMOJI_INDEX.filter((entry) => entry.kind === "single");
    const badges = CAPTION_EMOJI_INDEX.filter((entry) => entry.kind === "phrase");
    expect(CAPTION_EMOJI_AI_GLYPHS).toEqual(singles.map((entry) => entry.glyph));
    expect(CAPTION_EMOJI_AI_BADGES.map((badge) => badge.glyph)).toEqual(badges.map((entry) => entry.glyph));
    const emojiLine = EMOJI_TAGGING_SYSTEM_PROMPT.split("\n").find((line) => line.startsWith("Emojis: "))!.slice("Emojis: ".length).split(" ");
    expect(emojiLine).toEqual(singles.map((entry) => entry.glyph));
    const badgeLine = EMOJI_TAGGING_SYSTEM_PROMPT.split("\n").find((line) => line.startsWith("Badges: "))!.slice("Badges: ".length).split("; ");
    expect(badgeLine).toEqual(badges.map((entry) => `${entry.glyph} ${entry.name}`));
    console.log(`caption emoji catalog: AI vocabulary ${emojiLine.length} single designs + ${badgeLine.length} badges; tones from the Skin tone setting`);
  });

  test("every design with skin that the AI places takes the preset's Skin tone; a tone picked by hand keeps its own", () => {
    const toned = CAPTION_EMOJI_INDEX.filter((entry) => entry.hasTones);
    expect(toned).toHaveLength(181);
    const pitch = 0.6;
    const drawn = (entries: Record<string, { id: string; tone?: number }>, emojiTone?: number) => {
      const spans = toned.map((_, index) => ({ word: `word${index}`, startSec: 0.2 + index * pitch, endSec: 0.5 + index * pitch, confidence: 1 }));
      const document = editorDocumentSchema.parse({
        version: 1,
        clipStartSec: 0,
        clipEndSec: 1 + toned.length * pitch,
        captionPreset: captionPresetSchema.parse({ ...getCaptionPresetById("bold-pop")!.preset, wordsPerCue: 1, emojis: true, ...(emojiTone ? { emojiTone } : {}) }),
        transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker", startSec: 0.2, endSec: spans.at(-1)!.endSec, text: spans.map((span) => span.word).join(" "), confidence: 1, words: spans }],
        studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis: entries }),
        brollUrl: null,
        deletedRanges: [],
      });
      const result = planClipComposition({
        document,
        source: { identity: "caption-emoji-catalog", kind: "video", width: 1280, height: 720 },
        evidence: { automaticLayout: { state: "missing" } },
        assets: { backgroundImage: { state: "missing" } },
        capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
        targets: [{ id: "vertical", aspectRatio: "9:16", width: CANVAS.width, height: CANVAS.height }],
      });
      if (result.status === "invalid") throw new Error(result.error.code);
      return result.plan.targets[0]!.visualLayers.flatMap((layer) => (layer.kind === "caption" ? layer.emojis : []));
    };
    const keyOf = (index: number) => String(Math.round((0.2 + index * pitch) * 1000));
    // The AI's entries store no tone.
    const ai = Object.fromEntries(toned.map((entry, index) => [keyOf(index), { id: entry.id }]));
    for (const tone of [1, 2, 3, 4, 5]) {
      const emojis = drawn(ai, tone);
      expect(emojis.map((emoji) => emoji.id)).toEqual(toned.map((entry) => entry.id));
      expect(emojis.every((emoji) => emoji.tone === tone)).toBe(true);
    }
    expect(drawn(ai).every((emoji) => emoji.tone === undefined)).toBe(true);
    // Picked by hand in the default yellow: the setting does not move it.
    const hand = Object.fromEntries(toned.map((entry, index) => [keyOf(index), { id: entry.id, tone: 0 }]));
    expect(drawn(hand, 4).every((emoji) => emoji.tone === undefined)).toBe(true);
    console.log(`caption emoji catalog: ${toned.length} designs with skin x 5 Skin tones planned`);
  }, WALK_MS);
});
