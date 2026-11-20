import type { Ease, Frames } from "./ease";
import type { CaptionScene, Piece, ShapePiece, TextPiece, Track } from "./scene";
import { bracketPath, centredRect, ellipsePath, polylinePath, roundedRectPath, starPath } from "./shapes";

/**
 * The primitives sheet (spec 5.1): one scene exercising every primitive of the model, for the
 * worker's libass and the Studio's painter to draw and be compared cell by cell
 * (`apps/media/scripts/caption-scene-sheet.ts`). Static cells hold from 0; animated rows play over
 * `SHEET_DURATION_MS`. Every text piece is anchored on its baseline's left end so measurement
 * differences between the two renderers cannot move it.
 */

export const SHEET_CANVAS = { width: 1080, height: 2400 } as const;
export const SHEET_DURATION_MS = 1000;
/** The times the sheet is compared at: 30 fps frame times (the export renders at those only). */
export const SHEET_TIMES_MS = [0, 133, 333, 600, 833, 1000] as const;

export interface SheetCell {
  readonly id: string;
  /** The cell's rectangle in canvas px: where its piece draws and where the two frames are compared. */
  readonly rect: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };
  /** Known to differ between libass and the painter by a documented amount, not part of the threshold. */
  readonly note?: string;
}

const TO = 10_000;
const WHITE = "#FFFFFF";
const FACE = "Inter Tight Bold" as const;
const SIZE = 60;
const COLUMNS = [30, 390, 750] as const;
const CELL = { w: 330, h: 120 } as const;

const hold = (value: number): Frames => [[0, value]];

function text(id: string, cell: number, extra: Partial<TextPiece> & { track?: TextPiece["track"] } = {}, label = "Hamburg"): { piece: TextPiece; cell: SheetCell } {
  const column = cell % 3;
  const row = Math.floor(cell / 3);
  const x = COLUMNS[column]!;
  const y = 100 + row * CELL.h + 70;
  const { track, ...rest } = extra;
  return {
    piece: {
      id,
      kind: "text",
      z: 1,
      fromMs: 0,
      toMs: TO,
      text: label,
      face: FACE,
      sizePx: SIZE,
      letterSpacingEm: 0,
      fill: WHITE,
      anchor: "baseline-left",
      origin: { dx: 100, dy: -22 },
      ...rest,
      track: { x: hold(x + 100), y: hold(y - 22), ...track },
    },
    cell: { id, rect: { x1: x - 30, y1: y - 100, x2: x + 300, y2: y + 40 } },
  };
}

function shape(id: string, cell: number, path: ShapePiece["path"], extra: Partial<ShapePiece> = {}): { piece: ShapePiece; cell: SheetCell } {
  const column = cell % 3;
  const row = Math.floor(cell / 3);
  const cx = COLUMNS[column]! + 140;
  const cy = 100 + row * CELL.h + 45;
  const { track, ...rest } = extra;
  return {
    piece: { id, kind: "shape", z: 1, fromMs: 0, toMs: TO, path, fill: { colour: WHITE }, ...rest, track: { x: hold(cx), y: hold(cy), ...track } },
    cell: { id, rect: { x1: cx - 160, y1: cy - 70, x2: cx + 160, y2: cy + 60 } },
  };
}

const STATIC_CELLS = 30;

/** The animated rows below the static grid: one piece per ease, then one per animated property. */
const EASES: readonly Ease[] = ["linear", "out", "outQuint", "outExpo", "in", "inOut", "outBack", "spring"];
const ROW_TOP = 100 + Math.ceil(STATIC_CELLS / 3) * CELL.h + 40;
const ROW_H = 66;

function animatedRow(index: number, id: string, build: (x: number, y: number) => Track, extra: Partial<TextPiece> = {}): { piece: TextPiece; cell: SheetCell } {
  const y = ROW_TOP + index * ROW_H + 46;
  const x = 60;
  return {
    piece: {
      id,
      kind: "text",
      z: 1,
      fromMs: 0,
      toMs: TO,
      text: "Ease",
      face: FACE,
      sizePx: 44,
      letterSpacingEm: 0,
      fill: WHITE,
      anchor: "baseline-left",
      origin: { dx: 50, dy: -15 },
      ...extra,
      track: build(x, y),
    },
    cell: { id, rect: { x1: 0, y1: y - 56, x2: 1080, y2: y + 20 } },
  };
}

export function primitivesSheet(): { scene: CaptionScene; cells: SheetCell[] } {
  const items: { piece: Piece; cell: SheetCell }[] = [];
  const add = (item: { piece: Piece; cell: SheetCell }) => items.push(item);
  let n = 0;
  add(text("text-plain", n++));
  add(text("text-stroke", n++, { stroke: { widthPx: 4, colour: "#000000" }, fill: WHITE }));
  add(text("text-hollow", n++, { fillAlpha: 0, stroke: { widthPx: 3, colour: WHITE } }));
  add(text("text-shadows", n++, { shadows: [{ dx: 0, dy: 6, blur: 6, colour: "#000000", alpha: 0.7 }, { dx: 5, dy: 5, blur: 0, colour: "#FF3B30", alpha: 0.9 }] }));
  add(text("text-spacing-wide", n++, { letterSpacingEm: 0.12 }));
  add(text("text-spacing-tight", n++, { letterSpacingEm: -0.05 }));
  add(text("rotate-20", n++, { track: { rz: hold(20) } }));
  add(text("rotate--35", n++, { track: { rz: hold(-35) } }));
  add(text("scale-1.5x0.7", n++, { track: { sx: hold(1.5), sy: hold(0.7) } }));
  add(text("shear-18", n++, { track: { skx: hold(18) } }));
  add(text("blur-3", n++, { track: { blur: hold(3) } }));
  add(text("opacity-0.5", n++, { track: { o: hold(0.5) } }));
  add(text("colour-static", n++, { fill: "#FF4D4D" }));
  add(text("clip-rect", n++, { clip: { x1: hold(0), y1: hold(0), x2: hold(0), y2: hold(0) } }));
  add(text("clip-inverse", n++, { clip: { x1: hold(0), y1: hold(0), x2: hold(0), y2: hold(0), inverse: true } }));
  add(text("tilt-x-45", n++, { track: { rx: hold(45) } }));
  add(text("tilt-y-45", n++, { track: { ry: hold(45) } }));
  add(text("pivot-rotate-25", n++, { origin: { dx: 0, dy: -22 }, track: { rz: hold(25) } }));
  add(text("pivot-scale-1.4", n++, { origin: { dx: 0, dy: -22 }, track: { sx: hold(1.4), sy: hold(1.4) } }));
  add(text("combo-rotate-stroke-shadow", n++, { stroke: { widthPx: 3, colour: "#1B0B2E" }, shadows: [{ dx: 0, dy: 5, blur: 5, colour: "#000000", alpha: 0.6 }], fill: "#FFD400", track: { rz: hold(-8) } }));
  add(text("serif-italic", n++, { face: "Instrument Serif", sizePx: 84, fill: "#FFE9A8", letterSpacingEm: -0.02 }, "talent"));
  add(shape("shape-rect", n++, centredRect(240, 60)));
  add(shape("shape-rounded-shadow", n++, roundedRectPath(-120, -35, 240, 70, 24), { fill: { colour: "#2F6BFF" }, shadows: [{ dx: 0, dy: 8, blur: 6, colour: "#000000", alpha: 0.5 }] }));
  add(shape("shape-ellipse-stroke", n++, ellipsePath(0, 0, 110, 36), { fill: undefined, stroke: { widthPx: 8, colour: WHITE } }));
  add(shape("shape-star-fill-stroke", n++, starPath(5, 52, 22), { fill: { colour: "#FFD400" }, stroke: { widthPx: 5, colour: "#1B0B2E" } }));
  add(shape("shape-polyline-round", n++, polylinePath([[-110, 24], [-50, -24], [10, 24], [70, -24], [120, 12]]), { fill: undefined, stroke: { widthPx: 12, colour: WHITE } }));
  add(shape("shape-bracket", n++, bracketPath(-100, -40, 60, 40), { fill: undefined, stroke: { widthPx: 7, colour: "#39FF9C" } }));
  add(shape("shape-rotate-30", n++, roundedRectPath(-100, -25, 200, 50, 12), { track: { rz: hold(30) } }));
  add(shape("shape-tilt-x-50", n++, centredRect(240, 80), { track: { rx: hold(50) } }));
  add(shape("shape-tilt-y-50", n++, centredRect(240, 80), { track: { ry: hold(50) } }));
  add(shape("shape-scale-anim", n++, centredRect(160, 40), { track: { sx: [[0, 0.4], [1000, 1.6, "linear"]], sy: [[0, 1.6], [1000, 0.4, "linear"]] } }));

  // Clips are in canvas px: fix them to their cells now that positions are known.
  for (const item of items) {
    if (item.piece.clip) {
      const { rect } = item.cell;
      const inverse = item.piece.clip.inverse === true;
      item.piece = { ...item.piece, clip: { x1: hold(rect.x1 + 120), y1: hold(rect.y1 + 50), x2: hold(rect.x1 + 240), y2: hold(rect.y1 + 105), ...(inverse ? { inverse: true } : {}) } };
    }
  }

  // Animated rows. Every ease moves a word across the canvas; the rest animate one property each.
  let row = 0;
  for (const name of EASES) {
    add(animatedRow(row++, `ease-x-${name}`, (x, y) => ({ x: [[0, x + 50], [SHEET_DURATION_MS, x + 650, name]], y: hold(y - 15) })));
  }
  add(animatedRow(row++, "anim-scale", (x, y) => ({ x: hold(x + 400), y: hold(y - 15), sx: [[0, 0.5], [1000, 1.6, "outBack"]], sy: [[0, 1.6], [1000, 0.5, "outBack"]] })));
  add(animatedRow(row++, "anim-rotate", (x, y) => ({ x: hold(x + 400), y: hold(y - 15), rz: [[0, -60], [1000, 70, "inOut"]] })));
  add(animatedRow(row++, "anim-shear", (x, y) => ({ x: hold(x + 400), y: hold(y - 15), skx: [[0, -25], [1000, 25, "out"]] })));
  add(animatedRow(row++, "anim-blur", (x, y) => ({ x: hold(x + 400), y: hold(y - 15), blur: [[0, 8], [1000, 0, "out"]] })));
  add(animatedRow(row++, "anim-opacity", (x, y) => ({ x: hold(x + 400), y: hold(y - 15), o: [[0, 0.1], [1000, 1, "linear"]] })));
  add(animatedRow(row++, "anim-colour", (x, y) => ({ x: hold(x + 400), y: hold(y - 15), colour: [[0, "#FF3B30"], [1000, "#2F6BFF", "linear"]] })));
  add(animatedRow(row++, "anim-clip-wipe", (x, y) => ({ x: hold(x + 400), y: hold(y - 15) }), {
    clip: { x1: hold(430), y1: hold(0), x2: [[0, 430], [1000, 700, "outExpo"]], y2: hold(9999) },
  }));
  return { scene: { pieces: items.map((item) => item.piece) }, cells: items.map((item) => item.cell) };
}
