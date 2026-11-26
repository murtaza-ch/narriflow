import { describe, expect, test } from "bun:test";
import {
  CAPTION_EMOJI_BOX,
  CAPTION_EMOJI_GRID,
  CAPTION_EMOJI_OUTLINE_GRID,
  type CaptionEmojiArt,
  loadCaptionEmojiArt,
  parseCaptionEmojiPath,
} from "./art";
import { CAPTION_EMOJI_KEPT_HOLE_GRID } from "./geometry";
import { CAPTION_EMOJI_INDEX, type CaptionEmojiColour } from "./index";

const arts = await loadCaptionEmojiArt(CAPTION_EMOJI_INDEX.map((entry) => entry.id));
const ROLES = new Set(["a", "b", "c", "ink", "skin"]);

const BOX = CAPTION_EMOJI_BOX;

function contours(d: string, onCurveReach = 0) {
  const commands = parseCaptionEmojiPath(d);
  expect(commands.length).toBeGreaterThan(0);
  expect(commands[0]![0]).toBe("M");
  let open = false;
  for (const command of commands) {
    if (command[0] === "M") {
      expect(open).toBe(false);
      open = true;
    } else if (command[0] === "Z") {
      open = false;
    } else {
      expect(open).toBe(true);
    }
    const values = command.slice(1) as number[];
    values.forEach((value, i) => {
      // On-curve points stay on the grid (the outline reaches past it); every point, control
      // points too, stays inside the drawing box, because libass sizes a drawing by all of them.
      const onCurve = command[0] !== "C" || i >= 4;
      if (onCurve) {
        expect(value).toBeGreaterThanOrEqual(-onCurveReach);
        expect(value).toBeLessThanOrEqual(CAPTION_EMOJI_GRID + onCurveReach);
      }
      expect(value).toBeGreaterThanOrEqual(i % 2 === 0 ? BOX.x : BOX.y);
      expect(value).toBeLessThanOrEqual(i % 2 === 0 ? BOX.x + BOX.width : BOX.y + BOX.height);
      expect(Math.round(value * 100) / 100).toBe(value);
    });
  }
  // Every contour is a closed fill.
  expect(open).toBe(false);
  return commands;
}

/** Bounds of the drawn curve (each cubic sampled), not of its control points. */
function curveBounds(d: string) {
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  const add = (x: number, y: number) => {
    bounds.left = Math.min(bounds.left, x);
    bounds.top = Math.min(bounds.top, y);
    bounds.right = Math.max(bounds.right, x);
    bounds.bottom = Math.max(bounds.bottom, y);
  };
  let [x, y] = [0, 0];
  for (const command of parseCaptionEmojiPath(d)) {
    if (command[0] === "C") {
      const [, x1, y1, x2, y2, x3, y3] = command;
      for (let k = 1; k <= 16; k += 1) {
        const t = k / 16;
        const u = 1 - t;
        add(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
      [x, y] = [x3, y3];
    } else if (command[0] !== "Z") {
      [x, y] = [command[1], command[2]];
      add(x, y);
    }
  }
  return bounds;
}

function colourIsValid(colour: CaptionEmojiColour) {
  if ("role" in colour) return ROLES.has(colour.role);
  if ("hex" in colour) return /^#[0-9a-f]{6}$/.test(colour.hex);
  return colour.tone.length === 6 && colour.tone.every((c) => c === null || /^#[0-9a-f]{6}$/.test(c));
}

describe("caption emoji art", () => {
  test("loads every design", () => {
    expect(arts.size).toBe(CAPTION_EMOJI_INDEX.length);
  });

  test("every design is closed M/L/C/Z fills inside the 64 grid", () => {
    for (const art of arts.values()) {
      expect(art.layers.length).toBeGreaterThanOrEqual(1);
      // The renderers cap an emoji at 24 pieces: the sticker shadow, the outline and at most 22 layers.
      expect(art.layers.length).toBeLessThanOrEqual(22);
      for (const layer of art.layers) {
        contours(layer.d);
        expect(colourIsValid(layer.colour)).toBe(true);
        if (layer.alpha !== undefined) {
          expect(layer.alpha).toBeGreaterThan(0);
          expect(layer.alpha).toBeLessThan(1);
        }
      }
    }
  });

  test("every outline is one fill round the silhouette, inside the drawing box; only large holes stay open", () => {
    const reach = CAPTION_EMOJI_OUTLINE_GRID;
    const open: string[] = [];
    for (const art of arts.values()) {
      // Outer contours wind as fills. A kept hole winds the other way and holds a disc of the kept radius, so its area is at
      // least that disc's (the compiler measures the radius exactly; area is the check a test can make on path data).
      const areas: number[] = [];
      let start: [number, number] = [0, 0];
      let last: [number, number] = [0, 0];
      for (const command of contours(art.outline, reach)) {
        if (command[0] === "M") {
          areas.push(0);
          start = last = [command[1], command[2]];
          continue;
        }
        const next: [number, number] = command[0] === "Z" ? start : command[0] === "L" ? [command[1], command[2]] : [command[5], command[6]];
        areas[areas.length - 1]! += last[0] * next[1] - next[0] * last[1];
        last = next;
      }
      expect(areas.filter((area) => area > 0).length).toBeGreaterThanOrEqual(1);
      const holes = areas.filter((area) => area < 0);
      for (const area of holes) expect(-area / 2).toBeGreaterThan(Math.PI * CAPTION_EMOJI_KEPT_HOLE_GRID ** 2);
      if (holes.length > 0) open.push(art.id);
      const outline = curveBounds(art.outline);
      const bounds = art.layers.map((layer) => curveBounds(layer.d));
      const silhouette = {
        left: Math.min(...bounds.map((each) => each.left)),
        top: Math.min(...bounds.map((each) => each.top)),
        right: Math.max(...bounds.map((each) => each.right)),
        bottom: Math.max(...bounds.map((each) => each.bottom)),
      };
      // The band reaches the outline width past the silhouette on every side (within the
      // outline's 0.05 rounding and the sampling of curves).
      expect(outline.left).toBeLessThanOrEqual(silhouette.left - reach + 0.1);
      expect(outline.top).toBeLessThanOrEqual(silhouette.top - reach + 0.1);
      expect(outline.right).toBeGreaterThanOrEqual(silhouette.right + reach - 0.1);
      expect(outline.bottom).toBeGreaterThanOrEqual(silhouette.bottom + reach - 0.1);
    }
    // The cut-outs that carry the design stay open; the snowflake's and the 100's small holes stay filled.
    for (const id of ["heart-hands", "link", "chains", "safety-pin"]) expect(open).toContain(id);
    for (const id of ["snowflake", "hundred", "roller-coaster", "flame"]) expect(open).not.toContain(id);
    expect(open.length).toBe(26);
  });

  test("the drawing box is the grid grown by the outline, centred on the grid", () => {
    expect(BOX.x + BOX.width / 2).toBeCloseTo(CAPTION_EMOJI_GRID / 2, 9);
    expect(BOX.y + BOX.height / 2).toBeCloseTo(CAPTION_EMOJI_GRID / 2, 9);
    expect(BOX.x).toBeLessThanOrEqual(-CAPTION_EMOJI_OUTLINE_GRID);
    expect(BOX.x).toBeGreaterThan(-CAPTION_EMOJI_OUTLINE_GRID - 0.5);
  });

  test("skin and per-tone colours appear only on designs with tones", () => {
    for (const entry of CAPTION_EMOJI_INDEX) {
      const art = arts.get(entry.id) as CaptionEmojiArt;
      const toned = art.layers.some((l) => ("role" in l.colour && l.colour.role === "skin") || "tone" in l.colour);
      expect(toned).toBe(entry.hasTones);
    }
  });

  test("art carries no palette exception: every design is its outline and layers", () => {
    // Under Match template every design takes the template palette, round faces included (owner, ticket 26).
    for (const id of ["grin", "heart-eyes", "sun-with-face", "grinning-cat", "rocket"]) expect(Object.keys(arts.get(id)!).sort()).toEqual(["badge", "id", "layers", "outline"]);
  });

  test("phrase badges keep their disc", () => {
    // Every phrase but Fresh start (drawn as one emoji in the pack) is a badge.
    const phrases = CAPTION_EMOJI_INDEX.filter((e) => e.kind === "phrase");
    const withDisc = phrases.filter((e) => arts.get(e.id)!.layers.some((l) => "hex" in l.colour && l.colour.hex === "#33283e"));
    expect(phrases.length - withDisc.length).toBe(1);
    expect(withDisc.some((e) => e.id === "fresh-start")).toBe(false);
  });

  test("unknown ids are left out and repeated loads share objects", async () => {
    const again = await loadCaptionEmojiArt(["grin", "no-such-emoji", "grin"]);
    expect([...again.keys()]).toEqual(["grin"]);
    expect(again.get("grin")).toBe(arts.get("grin")!);
  });

  test("the path parser reads implicit repeats and rejects other commands", () => {
    expect(parseCaptionEmojiPath("M1 2L3 4 5-6C1 2 3 4 5 6Z")).toEqual([
      ["M", 1, 2],
      ["L", 3, 4],
      ["L", 5, -6],
      ["C", 1, 2, 3, 4, 5, 6],
      ["Z"],
    ]);
    expect(parseCaptionEmojiPath("M.5.25L1.5.5")).toEqual([
      ["M", 0.5, 0.25],
      ["L", 1.5, 0.5],
    ]);
    expect(() => parseCaptionEmojiPath("M1 2Q3 4 5 6")).toThrow();
    expect(() => parseCaptionEmojiPath("M1 2L3")).toThrow();
  });
});
