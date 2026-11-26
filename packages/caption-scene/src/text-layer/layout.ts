import { captionGraphemes } from "@narriflow/caption-fonts/graphemes";
import { type StudioTextLayer, applyCaptionTextTransform, captionFontFace, resolveTextLayerFace } from "@narriflow/validators";
import type { Box, CaptionScene, Measure, Piece, SceneWindow, Shadow, ShapePiece, TextPiece } from "../scene";
import { rectPath, roundedRectPath } from "../shapes";

/**
 * The Text Layer layout (title-text spec section 4, ADR 0021). A layer is a static Caption Scene:
 * this module turns it into pieces in full target-canvas px, and the Studio's painter and the
 * worker's ASS writer only measure and paint them. Every layout number of a Text Layer lives here.
 *
 * Lines: the text (case applied) splits on newlines; each paragraph wraps greedily at the layer's
 * width, measuring whole candidate lines; a word wider than the width breaks at grapheme
 * boundaries. A blank line keeps its pitch and draws nothing.
 *
 * Boxes are em-based: a line's box is `PLATE_HEIGHT_EM` tall, centred on the middle of the face's
 * cap height, and reaches `PLATE_PAD_X_EM` past the line's advance on each side. With the default
 * line pitch (1.2) adjacent line boxes overlap a little, so a stacked title reads as one label.
 */

/** Em-based constants of the layout. */
const PLATE_HEIGHT_EM = 1.3;
const PLATE_PAD_X_EM = 0.32;
const PLATE_RADIUS_EM = 0.28;
const UNDERLINE_OFFSET_EM = 0.12;
const UNDERLINE_THICKNESS_EM = 0.065;
/** Faux bold: a fill-coloured outline this far outside the glyph. */
const FAUX_BOLD_EM = 0.035;

/** `z` values one layer uses: plates, underline, the text's under piece, the text. */
export const TEXT_LAYER_Z_BAND = 4;
const Z = { plate: 0, underline: 1, under: 2, text: 3 } as const;

export interface TextLayerCanvas {
  readonly width: number;
  readonly height: number;
}

/** What the layout reads of a layer. */
export type TextLayerInput = Pick<StudioTextLayer, "id" | "text" | "positionX" | "positionY" | "widthPct" | "style">;

/** One laid-out line, canvas px. A blank line has empty text and a zero-width extent at its anchor. */
export interface TextLayerLine {
  readonly text: string;
  readonly blank: boolean;
  /** Baseline y. */
  readonly baselineY: number;
  /** Left and right edge of the line's measured advance. */
  readonly x1: number;
  readonly x2: number;
}

export interface TextLayerLayout {
  readonly pieces: Piece[];
  /** The wrap box: `widthPct` of the canvas wide, as tall as the text block with its boxes, centred on the layer's position. */
  readonly frame: Box;
  readonly lines: readonly TextLayerLine[];
}

/**
 * A layer's pieces for `window` (clip ms), its frame and its lines. `zBase` is the first `z` of
 * the layer's band (`TEXT_LAYER_Z_BAND` values), so a later layer's boxes cover an earlier layer's text.
 */
export function layoutTextLayer(layer: TextLayerInput, canvas: TextLayerCanvas, measure: Measure, window: SceneWindow, zBase: number): TextLayerLayout {
  const { style } = layer;
  const u = Math.min(canvas.width, canvas.height) / 1080;
  const size = style.fontSize * u;
  const { face, fauxBold, shearDeg } = resolveTextLayerFace(style);
  const cap = captionFontFace(face).capHeight * size;
  const advance = (text: string) => measure(text, face, size, 0).advance;

  const frameWidth = (layer.widthPct / 100) * canvas.width;
  const centreX = (layer.positionX / 100) * canvas.width;
  const padX = PLATE_PAD_X_EM * size;
  const innerX1 = centreX - frameWidth / 2 + padX;
  const innerX2 = centreX + frameWidth / 2 - padX;
  const texts = wrapTextLayer(drawnText(layer.text, style.textCase), Math.max(0, innerX2 - innerX1), advance);

  const pitch = style.lineHeight * size;
  const plateHeight = PLATE_HEIGHT_EM * size;
  const blockHeight = plateHeight + (texts.length - 1) * pitch;
  const top = (layer.positionY / 100) * canvas.height - blockHeight / 2;
  const lines: TextLayerLine[] = texts.map((text, index) => {
    const baselineY = top + plateHeight / 2 + index * pitch + cap / 2;
    if (text === "") return { text, blank: true, baselineY, x1: centreX, x2: centreX };
    const width = advance(text);
    const x1 = style.align === "left" ? innerX1 : style.align === "right" ? innerX2 - width : centreX - width / 2;
    return { text, blank: false, baselineY, x1, x2: x1 + width };
  });
  const frame: Box = { x1: centreX - frameWidth / 2, y1: top, x2: centreX + frameWidth / 2, y2: top + blockHeight };

  const { fromMs, toMs } = window;
  const at = (value: number): readonly (readonly [number, number])[] => [[fromMs, value]];
  const base = (id: string, z: number) => ({ id: `${layer.id}:${id}`, z: zBase + z, fromMs, toMs });
  const pieces: Piece[] = [];
  const drawn = lines.flatMap((line, index) => (line.blank ? [] : [{ line, index }]));

  // Boxes behind every line's text: one shape per layer. In `line` display it is each line's
  // rectangle one after another, all wound the same way, so where neighbours overlap the union is
  // filled once (nonzero in SVG and in libass) and a box that is not opaque shows no darker stripe.
  const background = style.background;
  if (background && background.opacity > 0 && drawn.length > 0) {
    const radius = background.corners === "rounded" ? PLATE_RADIUS_EM * size : 0;
    const plateTop = (line: TextLayerLine) => line.baselineY - cap / 2 - plateHeight / 2;
    const boxes: Box[] = background.display === "line"
      ? drawn.map(({ line }) => ({ x1: line.x1 - padX, y1: plateTop(line), x2: line.x2 + padX, y2: plateTop(line) + plateHeight }))
      : [{
          x1: Math.min(...drawn.map(({ line }) => line.x1)) - padX,
          y1: plateTop(drawn[0]!.line),
          x2: Math.max(...drawn.map(({ line }) => line.x2)) + padX,
          y2: plateTop(drawn[drawn.length - 1]!.line) + plateHeight,
        }];
    // The shape's anchor is the boxes' top-left corner; its path is relative to it.
    const left = Math.min(...boxes.map((box) => box.x1));
    const top = Math.min(...boxes.map((box) => box.y1));
    const path = boxes.flatMap((box) => {
      const [x, y, width, height] = [box.x1 - left, box.y1 - top, box.x2 - box.x1, box.y2 - box.y1];
      return radius > 0 ? roundedRectPath(x, y, width, height, radius) : rectPath(x, y, width, height);
    });
    pieces.push({ ...base("plate", Z.plate), kind: "shape", track: { x: at(left), y: at(top) }, path, fill: { colour: background.color, alpha: background.opacity } } satisfies ShapePiece);
  }

  const userStroke = style.stroke ? { widthPx: style.stroke.width * u, colour: style.stroke.color } : null;
  const fauxWidth = fauxBold ? FAUX_BOLD_EM * size : 0;
  const shadows: Shadow[] = style.shadow
    ? [{ dx: style.shadow.offsetX * u, dy: style.shadow.offsetY * u, blur: style.shadow.blur * u, colour: style.shadow.color, alpha: style.shadow.opacity }]
    : [];

  for (const { line, index } of drawn) {
    const anchor: TextPiece["anchor"] = style.align === "center" ? "baseline-center" : "baseline-left";
    const x = style.align === "center" ? centreX : line.x1;
    const text = (id: string, z: number, stroke: TextPiece["stroke"] | null, withShadows: boolean): TextPiece => ({
      ...base(`line:${index}:${id}`, z),
      kind: "text",
      // Italic by shear leans about the baseline (the pivot), so the line does not move.
      track: { x: at(x), y: at(line.baselineY), ...(shearDeg !== 0 ? { skx: at(-shearDeg) } : {}) },
      text: line.text,
      face,
      sizePx: size,
      letterSpacingEm: 0,
      fill: style.color,
      ...(stroke ? { stroke } : {}),
      ...(withShadows && shadows.length > 0 ? { shadows } : {}),
      anchor,
    });
    // Faux bold is a fill-coloured outline; a user stroke then goes on a piece under it, outside both.
    if (fauxBold && userStroke) {
      pieces.push(text("under", Z.under, { widthPx: fauxWidth + userStroke.widthPx, colour: userStroke.colour }, true));
      pieces.push(text("text", Z.text, { widthPx: fauxWidth, colour: style.color }, false));
    } else {
      const stroke = fauxBold ? { widthPx: fauxWidth, colour: style.color } : userStroke;
      pieces.push(text("text", Z.text, stroke, true));
    }
    if (style.underline) {
      const thickness = UNDERLINE_THICKNESS_EM * size;
      const y = line.baselineY + UNDERLINE_OFFSET_EM * size;
      const bar = (id: string, grow: number, colour: string, withShadows: boolean): ShapePiece => ({
        ...base(`${id}:${index}`, Z.underline),
        kind: "shape",
        track: { x: at(line.x1 - grow), y: at(y - grow) },
        path: rectPath(0, 0, line.x2 - line.x1 + 2 * grow, thickness + 2 * grow),
        fill: { colour },
        ...(withShadows && shadows.length > 0 ? { shadows } : {}),
      });
      // The outline is its own bar, the stroke's width larger all round and under the bar: a stroke
      // on the bar itself is centred on its edge and would cover a bar thinner than the stroke.
      if (userStroke) pieces.push(bar("underline-edge", userStroke.widthPx, userStroke.colour, true));
      pieces.push(bar("underline", 0, style.color, !userStroke));
    }
  }
  return { pieces, frame, lines };
}

/** A layer and the stretch of clip time it is on screen. */
export interface TextLayerEntry {
  readonly layer: TextLayerInput;
  readonly window: SceneWindow;
}

/** The scene of a target's Text Layers, each in its own `z` band in document order. */
export function buildTextLayerScene(entries: readonly TextLayerEntry[], canvas: TextLayerCanvas, measure: Measure): { scene: CaptionScene; layouts: TextLayerLayout[] } {
  const layouts = entries.map((entry, index) => layoutTextLayer(entry.layer, canvas, measure, entry.window, index * TEXT_LAYER_Z_BAND));
  return { scene: { pieces: layouts.flatMap((layout) => layout.pieces) }, layouts };
}

/** The text as drawn: the layer's case applied, line breaks normalised. */
function drawnText(text: string, textCase: StudioTextLayer["style"]["textCase"]): string {
  const normalised = text.replace(/\r\n?/g, "\n");
  // The captions' case rule; a layer has no language, so no locale-specific casing.
  return textCase === "uppercase" ? applyCaptionTextTransform(normalised, "uppercase", null) : normalised;
}

/**
 * Lines of `text`: newlines are hard breaks; within a paragraph words wrap greedily at `maxWidth`,
 * measured as whole candidate lines; a word wider than `maxWidth` breaks at grapheme boundaries
 * (at least one grapheme per line). An empty paragraph is an empty line.
 */
export function wrapTextLayer(text: string, maxWidth: number, advance: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/[^\S\n]+/u).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (advance(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = "";
      if (advance(word) <= maxWidth) {
        current = word;
        continue;
      }
      // An overlong word: as many graphemes per line as fit; its tail starts the next line.
      let piece = "";
      for (const grapheme of captionGraphemes(word)) {
        if (piece && advance(piece + grapheme) > maxWidth) {
          lines.push(piece);
          piece = "";
        }
        piece += grapheme;
      }
      current = piece;
    }
    lines.push(current);
  }
  return lines;
}
