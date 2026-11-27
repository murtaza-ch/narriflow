import { describe, expect, test } from "bun:test";
import { captionGraphemes } from "@narriflow/caption-fonts/graphemes";
import { DEFAULT_TEXT_SHADOW, DEFAULT_TITLE_STYLE, type StudioTextLayer, captionFontFace, studioTextLayerSchema } from "@narriflow/validators";
import { type Measure, type PathCmd, type Piece, type ShapePiece, type TextPiece, evaluatePiece, visiblePieces } from "../scene";
import { TEXT_LAYER_Z_BAND, buildTextLayerScene, layoutTextLayer, lineBoxCorners, wrapTextLayer } from "./layout";
import { TEXT_LAYER_SAMPLES } from "./samples";

/** Every grapheme is half an em wide: line widths are exact and predictable. */
const measure: Measure = (text, _face, sizePx) => ({
  advance: captionGraphemes(text).length * sizePx * 0.5,
  inkTop: -0.7 * sizePx,
  inkBottom: 0.2 * sizePx,
  ascent: 1.1 * sizePx,
  descent: 0.3 * sizePx,
});

/** 1080 square: one style unit is one px. */
const SQUARE = { width: 1080, height: 1080 };
const WINDOW = { fromMs: 1000, toMs: 6000 };
const SIZE = 40;
const CHAR = SIZE * 0.5;
const PAD = 0.32 * SIZE;
const INTER_CAP = captionFontFace("Inter").capHeight * SIZE;
/** Faux bold outline, em (review round 2: 0.035 closed up heavy single-weight faces such as Anton). */
const FAUX = 0.02;

const make = (text: string, style: Partial<StudioTextLayer["style"]> = {}, place: Partial<StudioTextLayer> = {}): StudioTextLayer =>
  studioTextLayerSchema.parse({ id: "t", text, positionX: 50, positionY: 50, widthPct: 50, ...place, style: { ...DEFAULT_TITLE_STYLE, fontSize: SIZE, ...style } });

const layout = (layer: StudioTextLayer, canvas = SQUARE) => layoutTextLayer(layer, canvas, measure, WINDOW, 0);
const texts = (pieces: readonly Piece[]) => pieces.filter((piece): piece is TextPiece => piece.kind === "text");
const shapes = (pieces: readonly Piece[], id: string) => pieces.filter((piece): piece is ShapePiece => piece.kind === "shape" && piece.id.includes(id));
/** The subpaths of a shape (each starts at an `M`), as their own command lists. */
const subpaths = (piece: ShapePiece): PathCmd[][] => {
  const result: PathCmd[][] = [];
  for (const command of piece.path) {
    if (command[0] === "M") result.push([]);
    result[result.length - 1]!.push(command);
  }
  return result;
};
/** Canvas box of each subpath of a shape (one per line box in `line` display). */
const boxesOf = (piece: ShapePiece) => {
  const pose = evaluatePiece(piece, WINDOW.fromMs);
  return subpaths(piece).map((path) => {
    const xs = path.flatMap((command) => (command[0] === "Z" ? [] : command.slice(1).filter((_, index) => index % 2 === 0) as number[]));
    const ys = path.flatMap((command) => (command[0] === "Z" ? [] : command.slice(1).filter((_, index) => index % 2 === 1) as number[]));
    return { x1: pose.x + Math.min(...xs), y1: pose.y + Math.min(...ys), x2: pose.x + Math.max(...xs), y2: pose.y + Math.max(...ys) };
  });
};
/** Signed area of a subpath's polygon of end points (shoelace); its sign is the winding. */
const signedArea = (path: readonly PathCmd[]) => {
  const points = path.flatMap((command) => (command[0] === "Z" ? [] : [[command[command.length - 2] as number, command[command.length - 1] as number] as const]));
  return points.reduce((sum, [x, y], index) => {
    const [nx, ny] = points[(index + 1) % points.length]!;
    return sum + x * ny - nx * y;
  }, 0) / 2;
};
const plates = (pieces: readonly Piece[]) => {
  const found = shapes(pieces, "plate");
  return found.length === 0 ? [] : boxesOf(found[0]!);
};

describe("wrapping", () => {
  // Frame 540 wide, inner width 540 - 2 * 12.8 = 514.4: 25 graphemes of 20 px fit, 26 do not.
  test("a candidate line wraps only once its measured width passes the inner width", () => {
    expect(layout(make("aaaaaaaaaaaa bbbbbbbbbbbb")).lines.map((line) => line.text)).toEqual(["aaaaaaaaaaaa bbbbbbbbbbbb"]);
    expect(layout(make("aaaaaaaaaaaa bbbbbbbbbbbbb")).lines.map((line) => line.text)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbbb"]);
  });

  test("newlines are hard breaks, a blank line keeps its pitch and draws nothing", () => {
    const result = layout(make("one\n\ntwo"));
    expect(result.lines.map((line) => [line.text, line.blank])).toEqual([["one", false], ["", true], ["two", false]]);
    const pitch = 1.2 * SIZE;
    expect(result.lines[1]!.baselineY - result.lines[0]!.baselineY).toBeCloseTo(pitch, 6);
    expect(result.lines[2]!.baselineY - result.lines[1]!.baselineY).toBeCloseTo(pitch, 6);
    expect(texts(result.pieces).map((piece) => piece.text)).toEqual(["one", "two"]);
    expect(shapes(result.pieces, "plate")).toHaveLength(1);
    expect(plates(result.pieces)).toHaveLength(2);
  });

  test("a word wider than the line breaks at grapheme boundaries and its tail joins the next words", () => {
    expect(wrapTextLayer("abcdefghij kl", 5 * CHAR, (text) => captionGraphemes(text).length * CHAR)).toEqual(["abcde", "fghij", "kl"]);
    expect(wrapTextLayer("abcdefg hi", 5 * CHAR, (text) => captionGraphemes(text).length * CHAR)).toEqual(["abcde", "fg hi"]);
    // A grapheme wider than the line still gets one line, and a family emoji is never split.
    expect(wrapTextLayer("👨‍👩‍👧x", 0.5 * CHAR, (text) => captionGraphemes(text).length * CHAR)).toEqual(["👨‍👩‍👧", "x"]);
  });

  test("controls never reach a renderer: a tab is a space, NUL and other C0/C1 controls are dropped, line breaks stay", () => {
    const result = layout(make("A\u0000B\tC\u0007D\u009F\r\nE\rF\u007F"));
    expect(result.lines.map((line) => line.text)).toEqual(["AB CD", "E", "F"]);
    const stored = make("A\u0000B");
    expect(stored.text).toBe("A\u0000B");
    expect(texts(layout(stored).pieces)[0]!.text).toBe("AB");
  });

  test("only ordinary spaces are wrap points: a no-break space or a word joiner keeps its words on one line", () => {
    const width = (text: string) => captionGraphemes(text).length * CHAR;
    expect(wrapTextLayer("aa\u00A0bb cc", 5 * CHAR, width)).toEqual(["aa\u00A0bb", "cc"]);
    expect(wrapTextLayer("aa\u202Fbb cc", 5 * CHAR, width)).toEqual(["aa\u202Fbb", "cc"]);
    expect(wrapTextLayer("aa\u2060bb cc", 5 * CHAR, width)).toEqual(["aa\u2060bb", "cc"]);
    // A run of ordinary spaces is one break.
    expect(wrapTextLayer("aa    bb", 10 * CHAR, width)).toEqual(["aa bb"]);
  });

  test("uppercase is drawn, the stored text is not rewritten", () => {
    const stored = make("Make it big", { textCase: "uppercase" });
    expect(texts(layout(stored).pieces).map((piece) => piece.text)).toEqual(["MAKE IT BIG"]);
    expect(stored.text).toBe("Make it big");
  });

  test("braces and backslashes are kept as typed", () => {
    expect(texts(layout(make("a {b} \\N c")).pieces)[0]!.text).toBe("a {b} \\N c");
  });
});

describe("placement", () => {
  test("the frame is the wrap box centred on the position, as tall as the boxes of its lines", () => {
    const result = layout(make("one\ntwo\nthree", {}, { positionX: 40, positionY: 30, widthPct: 60 }), { width: 1080, height: 1920 });
    const plate = 1.3 * SIZE;
    const height = plate + 2 * 1.2 * SIZE;
    expect(result.frame.x1).toBeCloseTo(432 - 324, 6);
    expect(result.frame.x2).toBeCloseTo(432 + 324, 6);
    expect((result.frame.y1 + result.frame.y2) / 2).toBeCloseTo(0.3 * 1920, 6);
    expect(result.frame.y2 - result.frame.y1).toBeCloseTo(height, 6);
    // The block's boxes fill the frame's height exactly.
    const boxes = plates(result.pieces);
    expect(boxes[0]!.y1).toBeCloseTo(result.frame.y1, 6);
    expect(boxes[2]!.y2).toBeCloseTo(result.frame.y2, 6);
  });

  test("a line box hugs its own line: unequal widths, centred on the cap height", () => {
    const result = layout(make("a long first line\nshort"));
    const [first, second] = plates(result.pieces);
    expect(first!.x2 - first!.x1).toBeCloseTo(17 * CHAR + 2 * PAD, 6);
    expect(second!.x2 - second!.x1).toBeCloseTo(5 * CHAR + 2 * PAD, 6);
    const line = result.lines[0]!;
    expect((first!.y1 + first!.y2) / 2).toBeCloseTo(line.baselineY - INTER_CAP / 2, 6);
    // With the default pitch adjacent boxes overlap so the stack reads as one label.
    expect(second!.y1).toBeLessThan(first!.y2);
  });

  test("left, centre and right alignment: by the inner edge, the centre, and the measured advance", () => {
    const inner = { x1: 270 + PAD, x2: 810 - PAD };
    const left = layout(make("abc", { align: "left" }));
    expect(left.lines[0]!.x1).toBeCloseTo(inner.x1, 6);
    expect(texts(left.pieces)[0]).toMatchObject({ anchor: "baseline-left" });
    expect(evaluatePiece(texts(left.pieces)[0]!, WINDOW.fromMs).x).toBeCloseTo(inner.x1, 6);
    const right = layout(make("abc", { align: "right" }));
    expect(right.lines[0]!.x2).toBeCloseTo(inner.x2, 6);
    expect(evaluatePiece(texts(right.pieces)[0]!, WINDOW.fromMs).x).toBeCloseTo(inner.x2 - 3 * CHAR, 6);
    const centre = layout(make("abc", { align: "center" }));
    expect(texts(centre.pieces)[0]).toMatchObject({ anchor: "baseline-center" });
    expect(evaluatePiece(texts(centre.pieces)[0]!, WINDOW.fromMs).x).toBeCloseTo(540, 6);
  });

  test("sizes are in units of the canvas's short side over 1080", () => {
    const wide = layout(make("abc"), { width: 1920, height: 1080 });
    const tall = layout(make("abc"), { width: 2160, height: 3840 });
    expect(texts(wide.pieces)[0]!.sizePx).toBeCloseTo(SIZE, 6);
    expect(texts(tall.pieces)[0]!.sizePx).toBeCloseTo(2 * SIZE, 6);
  });
});

describe("boxes", () => {
  test("block display draws one box around every line", () => {
    const result = layout(make("a long first line\nshort", { background: { color: "#FFFFFF", opacity: 1, corners: "rounded", display: "block" } }));
    expect(shapes(result.pieces, "plate")).toHaveLength(1);
    const boxes = plates(result.pieces);
    expect(boxes).toHaveLength(1);
    const box = boxes[0]!;
    expect(box.x2 - box.x1).toBeCloseTo(17 * CHAR + 2 * PAD, 6);
    expect(box.y1).toBeCloseTo(result.frame.y1, 6);
    expect(box.y2).toBeCloseTo(result.frame.y2, 6);
  });

  test("a layer's line boxes are one shape of same-wound rectangles, so overlaps fill once", () => {
    for (const corners of ["rounded", "square"] as const) {
      const result = layout(make("a long first line\nmid\nlonger last line", { background: { color: "#000000", opacity: 0.6, corners, display: "line" } }));
      const found = shapes(result.pieces, "plate");
      expect(found).toHaveLength(1);
      const paths = subpaths(found[0]!);
      expect(paths).toHaveLength(3);
      const areas = paths.map(signedArea);
      expect(areas.every((area) => Math.sign(area) === Math.sign(areas[0]!) && area !== 0)).toBe(true);
      const boxes = boxesOf(found[0]!);
      expect(boxes[1]!.y1).toBeLessThan(boxes[0]!.y2);
      // The anchor is the union's top-left, so the path starts at (0, 0).
      expect(Math.min(...boxes.map((box) => box.x1))).toBeCloseTo(evaluatePiece(found[0]!, WINDOW.fromMs).x, 6);
      expect(found[0]!.fill).toEqual({ colour: "#000000", alpha: 0.6 });
    }
  });

  test("stacked line boxes join into one label: corners round only where they stick out", () => {
    const r = 10;
    const wide = { x1: 0, y1: 0, x2: 200, y2: 26 };
    const narrow = { x1: 40, y1: 24, x2: 160, y2: 50 };
    // The wide line's bottom corners stick out past the narrow line: round. The narrow line's top
    // corners sit under the wide one: square, so no notch shows where the lines meet.
    expect(lineBoxCorners([wide, narrow], 0, r)).toEqual([r, r, r, r]);
    expect(lineBoxCorners([wide, narrow], 1, r)).toEqual([0, 0, r, r]);
    // A step smaller than the radius rounds only as far as the step.
    expect(lineBoxCorners([wide, { ...narrow, x1: 4, x2: 196 }], 0, r)).toEqual([r, r, 4, 4]);
    // Equal widths join with a straight side.
    expect(lineBoxCorners([wide, { ...narrow, x1: 0, x2: 200 }], 1, r)).toEqual([0, 0, r, r]);
    // Boxes that do not touch (a blank line between, or a tall line pitch) stay separate labels.
    expect(lineBoxCorners([wide, { ...narrow, y1: 30, y2: 56 }], 1, r)).toEqual([r, r, r, r]);
  });

  test("a two-line title is one label: the shorter line's corners under the longer one are square", () => {
    const plate = shapes(layout(make("a long first line\nshort")).pieces, "plate")[0]!;
    const [first, second] = subpaths(plate);
    // A square corner is a zero-length curve (control points on its end point).
    const curves = (path: PathCmd[]) => path.filter((command) => command[0] === "C" && (command[1] !== command[5] || command[2] !== command[6])).length;
    expect(curves(first!)).toBe(4);
    expect(curves(second!)).toBe(2);
  });

  test("rounded corners are curves; square corners are straight", () => {
    const rounded = shapes(layout(make("abc")).pieces, "plate")[0]!;
    const square = shapes(layout(make("abc", { background: { color: "#FFFFFF", opacity: 1, corners: "square", display: "line" } })).pieces, "plate")[0]!;
    expect(rounded.path.some((command) => command[0] === "C")).toBe(true);
    expect(square.path.some((command) => command[0] === "C")).toBe(false);
    expect(rounded.fill).toEqual({ colour: "#FFFFFF", alpha: 1 });
  });

  test("no background, or a transparent one, draws no box", () => {
    expect(shapes(layout(make("abc", { background: null })).pieces, "plate")).toHaveLength(0);
    expect(shapes(layout(make("abc", { background: { color: "#FFFFFF", opacity: 0, corners: "square", display: "line" } })).pieces, "plate")).toHaveLength(0);
  });
});

describe("bold, italic, underline, stroke and shadow", () => {
  const STROKE = { color: "#000000", width: 4 };

  test("a real heavier face draws no outline", () => {
    const [piece] = texts(layout(make("abc", { font: "Inter", bold: true, stroke: null })).pieces);
    expect(piece).toMatchObject({ face: "Inter" });
    expect(piece!.stroke).toBeUndefined();
  });

  test("faux bold without a user stroke: one piece outlined in its own fill colour", () => {
    const pieces = texts(layout(make("abc", { font: "Anton", bold: true, stroke: null, color: "#FF0000" })).pieces);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.stroke).toEqual({ widthPx: FAUX * SIZE, colour: "#FF0000" });
  });

  test("faux bold with a user stroke: an under piece outside both, shadows once on it", () => {
    const pieces = texts(layout(make("abc", { font: "Anton", bold: true, stroke: STROKE, color: "#FF0000", shadow: DEFAULT_TEXT_SHADOW })).pieces);
    expect(pieces.map((piece) => piece.id)).toEqual(["t:line:0:under", "t:line:0:text"]);
    expect(pieces[0]!.stroke).toEqual({ widthPx: FAUX * SIZE + 4, colour: "#000000" });
    expect(pieces[1]!.stroke).toEqual({ widthPx: FAUX * SIZE, colour: "#FF0000" });
    expect(pieces[0]!.shadows).toEqual([{ dx: 0, dy: 4, blur: 8, colour: "#000000", alpha: 0.6 }]);
    expect(pieces[1]!.shadows).toBeUndefined();
    expect(pieces[0]!.z).toBeLessThan(pieces[1]!.z);
  });

  test("a user stroke alone is the text's own outline", () => {
    const pieces = texts(layout(make("abc", { font: "Inter", bold: true, stroke: STROKE })).pieces);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.stroke).toEqual({ widthPx: 4, colour: "#000000" });
  });

  test("shear italic leans about the baseline pivot: a constant skx, the line stays put", () => {
    const upright = layout(make("abc", { font: "Inter", italic: false }));
    const leaning = layout(make("abc", { font: "Inter", italic: true }));
    const piece = texts(leaning.pieces)[0]!;
    expect(piece.track.skx).toEqual([[WINDOW.fromMs, -12]]);
    expect(piece.origin).toBeUndefined();
    expect(evaluatePiece(piece, WINDOW.fromMs).y).toBeCloseTo(leaning.lines[0]!.baselineY, 6);
    expect(leaning.lines).toEqual(upright.lines);
  });

  test("a family with a real italic draws it, without a shear", () => {
    const piece = texts(layout(make("abc", { font: "Inter Tight", italic: true, bold: true })).pieces)[0]!;
    expect(piece.face).toBe("Inter Tight ExtraBold Italic");
    expect(piece.track.skx).toBeUndefined();
  });

  test("underline: a bar the line's measured advance wide below the baseline, under the text", () => {
    const result = layout(make("ab cd\nlonger line", { underline: true, background: null, stroke: STROKE, shadow: DEFAULT_TEXT_SHADOW }));
    const bars = shapes(result.pieces, "underline:");
    expect(bars).toHaveLength(2);
    const bar = boxesOf(bars[0]!)[0]!;
    expect(bar.x1).toBeCloseTo(result.lines[0]!.x1, 6);
    expect(bar.x2 - bar.x1).toBeCloseTo(5 * CHAR, 6);
    expect(bar.y1).toBeGreaterThan(result.lines[0]!.baselineY);
    expect(bars[0]!.fill).toEqual({ colour: DEFAULT_TITLE_STYLE.color });
    expect(bars[0]!.stroke).toBeUndefined();
    expect(bars[0]!.shadows).toBeUndefined();
    expect(bars[0]!.z).toBeLessThan(texts(result.pieces)[0]!.z);
    // The outline is a larger bar under it, the stroke's width all round, so the bar keeps the text colour.
    const edges = shapes(result.pieces, "underline-edge:");
    expect(edges).toHaveLength(2);
    const edge = boxesOf(edges[0]!)[0]!;
    expect(edge.x1).toBeCloseTo(bar.x1 - 4, 6);
    expect(edge.y2).toBeCloseTo(bar.y2 + 4, 6);
    expect(edges[0]!.fill).toEqual({ colour: "#000000" });
    expect(edges[0]!.shadows).toHaveLength(1);
    expect(result.pieces.indexOf(edges[0]!)).toBeLessThan(result.pieces.indexOf(bars[0]!));
  });

  test("underline without a stroke: one bar, which carries the shadow", () => {
    const result = layout(make("ab cd", { underline: true, background: null, stroke: null, shadow: DEFAULT_TEXT_SHADOW }));
    expect(shapes(result.pieces, "underline-edge:")).toHaveLength(0);
    expect(shapes(result.pieces, "underline:")[0]!.shadows).toHaveLength(1);
  });
});

describe("scene", () => {
  test("pieces are static and alive for the layer's window only", () => {
    const result = layout(make("one two\nthree", { underline: true, italic: true, shadow: DEFAULT_TEXT_SHADOW, font: "Anton", stroke: { color: "#000000", width: 3 } }));
    for (const piece of result.pieces) {
      expect([piece.fromMs, piece.toMs]).toEqual([WINDOW.fromMs, WINDOW.toMs]);
      for (const frames of Object.values(piece.track)) expect(frames).toHaveLength(1);
    }
    expect(visiblePieces({ pieces: result.pieces }, WINDOW.fromMs - 1)).toHaveLength(0);
    expect(visiblePieces({ pieces: result.pieces }, WINDOW.toMs)).toHaveLength(0);
    expect(visiblePieces({ pieces: result.pieces }, WINDOW.fromMs).length).toBe(result.pieces.length);
  });

  test("each layer has its own z band in document order: a later layer's box covers an earlier layer's text", () => {
    const first = make("under", { background: null, stroke: { color: "#000000", width: 3 } });
    const second = { ...make("over"), id: "second" };
    const { scene, layouts } = buildTextLayerScene([{ layer: first, window: WINDOW }, { layer: second, window: WINDOW }], SQUARE, measure);
    const firstText = Math.max(...layouts[0]!.pieces.map((piece) => piece.z));
    const secondPlate = Math.min(...shapes(layouts[1]!.pieces, "plate").map((piece) => piece.z));
    expect(secondPlate).toBeGreaterThan(firstText);
    expect(secondPlate).toBe(TEXT_LAYER_Z_BAND);
    const order = visiblePieces(scene, WINDOW.fromMs).map((piece) => piece.id);
    expect(order.indexOf("second:plate")).toBeGreaterThan(order.indexOf("t:line:0:text"));
  });

  test("every sample lays out on both canvases", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      for (const sample of TEXT_LAYER_SAMPLES) {
        const { scene } = buildTextLayerScene(sample.layers.map((layer) => ({ layer, window: WINDOW })), canvas, measure);
        expect(scene.pieces.length).toBeGreaterThan(0);
      }
    }
    expect(TEXT_LAYER_SAMPLES.length).toBeGreaterThanOrEqual(20);
  });
});
