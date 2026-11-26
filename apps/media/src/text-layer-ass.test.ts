import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { layoutTextLayer, type Piece } from "@narriflow/caption-scene";
import type { CompositionTextVisualLayer } from "@narriflow/composition-plan";
import { DEFAULT_TITLE_STYLE, type StudioTextLayer, studioTextLayerSchema } from "@narriflow/validators";
import { type RawFrame, renderAssRaw } from "../scripts/caption-scene-probe";
import { SceneMeasurer, sceneEvents } from "./caption-scene-ass";
import { renderTextLayerTrack } from "./text-layer-ass";

/**
 * The Text Layer writer: the constant-pose fast path, literal braces and backslashes, and a shear
 * italic over a mixed-face line, all checked against real libass where it matters.
 */

const hasLibass = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout?.includes(" ass ") ?? false;
const CANVAS = { width: 1080, height: 1920 };
const measurer = () => new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), null, true);

const make = (text: string, style: Partial<StudioTextLayer["style"]> = {}, place: Partial<StudioTextLayer> = {}): StudioTextLayer =>
  studioTextLayerSchema.parse({ id: "t", role: "title", text, positionY: 30, ...place, style: { ...DEFAULT_TITLE_STYLE, ...style } });

const planLayer = (layer: StudioTextLayer, startSec = 0, endSec = 1): CompositionTextVisualLayer => ({
  id: `layer:text:${layer.id}:t`,
  kind: "text",
  activeRange: { startSec, endSec },
  anchor: { xPct: layer.positionX, yPct: layer.positionY },
  destination: { x: 0, y: 0, ...CANVAS },
  rotationDeg: 0,
  opacity: 1,
  zIndex: 30,
  value: layer,
});

describe("the constant-pose fast path", () => {
  test("a static piece that lives 5 minutes is one event per paint layer, on the frame grid", () => {
    const piece: Piece = {
      id: "static",
      kind: "text",
      z: 0,
      fromMs: 1000,
      toMs: 301_000,
      track: { x: [[1000, 540]], y: [[1000, 960]], skx: [[1000, -12]] },
      text: "A five minute title",
      face: "Inter",
      sizePx: 48,
      letterSpacingEm: 0,
      fill: "#FFFFFF",
      stroke: { widthPx: 3, colour: "#000000" },
      shadows: [{ dx: 0, dy: 4, blur: 8, colour: "#000000", alpha: 0.6 }],
      anchor: "baseline-center",
    };
    const events = sceneEvents({ pieces: [piece] }, measurer(), { canvas: CANVAS, fps: 30 });
    expect(events).toHaveLength(2);
    expect(events.map((event) => [event.startSec, event.endSec])).toEqual([[1, 301], [1, 301]]);
  });

  test("the fast path writes exactly what the sampled path writes for the same still piece", () => {
    for (const layer of [make("Two lines\nof title", { underline: true, italic: true, shadow: { color: "#000000", opacity: 0.5, blur: 6, offsetX: 2, offsetY: 4 } }), make("Faux bold", { font: "Anton", stroke: { color: "#000000", width: 4 } })]) {
      const { pieces } = layoutTextLayer(layer, CANVAS, measurer().measure, { fromMs: 333, toMs: 5_333 }, 0);
      // A second key with the same value keeps the pose still but takes the sampled path.
      const sampled = pieces.map((piece) => ({ ...piece, track: { ...piece.track, x: [...piece.track.x!, [piece.toMs, piece.track.x![0]![1]]] } }) as Piece);
      for (const fps of [24, 30, 29.97, 60]) {
        expect(sceneEvents({ pieces }, measurer(), { canvas: CANVAS, fps })).toEqual(sceneEvents({ pieces: sampled }, measurer(), { canvas: CANVAS, fps }));
      }
    }
  });
});

describe("text and windows", () => {
  test("a layer at 0.7 s starts on the 700 ms frame", () => {
    const track = renderTextLayerTrack({ layers: [planLayer(make("Late"), 0.7, 2.3)], canvas: CANVAS, fps: 30 });
    expect(track.ass).toMatch(/Dialogue: \d+,0:00:00\.70,0:00:02\.30,/);
  });

  test("braces are escaped and every backslash is followed by a word joiner", () => {
    const track = renderTextLayerTrack({ layers: [planLayer(make("a {b} \\N c\\"))], canvas: CANVAS });
    expect(track.ass).toContain("a \\{b\\} \\⁠N c\\⁠");
    expect(track.omitted).toEqual([]);
  });

  test("an omitted code point is reported by its layer and the script stays valid", () => {
    const track = renderTextLayerTrack({ layers: [planLayer(make("x")), planLayer({ ...make("\u{10FFFD}"), id: "second" })], canvas: CANVAS });
    expect(track.omitted.map((glyph) => glyph.layerId)).toEqual(["second"]);
    expect(track.ass).toContain("[Events]");
  });
});

/** Ink columns, as an x centroid, of rows `y1..y2` of a frame (white ink on black). */
function inkCentroidX(frame: RawFrame, y1: number, y2: number): number {
  let sum = 0;
  let weight = 0;
  for (let y = Math.max(0, Math.floor(y1)); y < Math.min(frame.height, Math.ceil(y2)); y++) {
    for (let x = 0; x < frame.width; x++) {
      const value = frame.data[(y * frame.width + x) * 3]!;
      sum += x * value;
      weight += value;
    }
  }
  return weight > 0 ? sum / weight : Number.NaN;
}

function rowsWithInk(frame: RawFrame): number {
  let rows = 0;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      if (frame.data[(y * frame.width + x) * 3]! > 60) {
        rows++;
        break;
      }
    }
  }
  return rows;
}

describe.skipIf(!hasLibass)("against real libass", () => {
  const render = (layer: StudioTextLayer) =>
    renderAssRaw({ ass: renderTextLayerTrack({ layers: [planLayer(layer)], canvas: CANVAS }).ass, width: CANVAS.width, height: CANVAS.height, tMs: 0, background: "black" });
  const plain = { color: "#FFFFFF", background: null, stroke: null } as const;

  test("braces and backslashes are measured as libass draws them: the box fits the ink", () => {
    for (const text of ["Literal {braces}", "back\\slash \\N"]) {
      const layer = make(text, plain, { widthPct: 100 });
      const line = layoutTextLayer(layer, CANVAS, measurer().measure, { fromMs: 0, toMs: 1000 }, 0).lines[0]!;
      const frame = render(layer);
      const ink = { x1: CANVAS.width, x2: 0 };
      for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) if (frame.data[(y * frame.width + x) * 3]! > 60) { ink.x1 = Math.min(ink.x1, x); ink.x2 = Math.max(ink.x2, x + 1); }
      // Ink sits inside the measured advance, give or take the side bearings.
      expect(Math.abs(ink.x1 - line.x1)).toBeLessThan(6);
      expect(Math.abs(ink.x2 - line.x2)).toBeLessThan(6);
    }
  });

  test("a backslash draws as typed, never as an escape, also next to a fallback face", () => {
    for (const text of ["back\\Nslash \\h \\{x\\}", "x\\ب y"]) {
      const frame = render(make(text, { ...plain, fontSize: 60 }, { widthPct: 100 }));
      // One line of ink: `\N` did not break the line.
      expect(rowsWithInk(frame)).toBeLessThan(110);
      expect(rowsWithInk(frame)).toBeGreaterThan(30);
    }
  });

  // A shear italic leans about the baseline: ink on the baseline row stays where the upright line has it.
  // A fallback face (Urdu in Nastaliq, much taller than Inter) changes the line box libass aligns and shears by.
  const drift = (text: string) => {
    const layer = make(text, { ...plain, fontSize: 72, bold: true }, { widthPct: 100 });
    const baseline = layoutTextLayer(layer, CANVAS, measurer().measure, { fromMs: 0, toMs: 1000 }, 0).lines[0]!.baselineY;
    const upright = render({ ...layer, style: { ...layer.style, italic: false } });
    const leaning = render({ ...layer, style: { ...layer.style, italic: true } });
    const band = (frame: RawFrame) => inkCentroidX(frame, baseline - 4, baseline);
    // Above the baseline the shear moves ink right by tan(12 deg) * height.
    const high = (frame: RawFrame) => inkCentroidX(frame, baseline - 40, baseline - 36);
    return { atBaseline: band(leaning) - band(upright), at38px: high(leaning) - high(upright), expectedAt38px: Math.tan((12 * Math.PI) / 180) * 38 };
  };

  test("shear italic: single face and mixed faces stay on the baseline (drift recorded in ticket 02)", () => {
    const latin = drift("Hello italic world");
    const mixed = drift("Hello یہ جواب world");
    console.warn(JSON.stringify({ level: "info", message: "text_layer_shear_drift", latin, mixed }));
    // One face: the line leans about its baseline as the model says.
    expect(Math.abs(latin.atBaseline)).toBeLessThan(1.5);
    expect(Math.abs(latin.at38px - latin.expectedAt38px)).toBeLessThan(2);
    // Mixed faces: libass leans the fallback runs about another point, so the line sits ~3.4 px right of
    // the model at 72 units on a 1080 canvas (measured 2026-11-27, ticket 02). Guard it from growing.
    expect(Math.abs(mixed.atBaseline)).toBeLessThan(5);
    expect(Math.abs(mixed.at38px - mixed.expectedAt38px)).toBeLessThan(6);
  });
});
