import type { CaptionFontName } from "@narriflow/validators";
import { ease, type Ease, type Frames, kf } from "./ease";
import { livePieceIndexes } from "./piece-index";
import { pathBounds, roundedRectPath } from "./shapes";

/**
 * The Caption Scene model (spec section 3.1, ADR 0021). A Scene Style is a program that turns all
 * the cues of a caption target into pieces with keyframe tracks, in canvas px and clip ms. Both
 * renderers only measure text and paint pieces; `evaluatePiece` is the one function that says
 * where a piece is at a time, so playback, scrubbing, pause and export agree.
 *
 * Model of a piece at time t. Its text (or path) is laid out at rest with its anchor point at
 * `(x - origin.dx, y - origin.dy)`; the pivot is `(x, y)`. The pose then acts about the pivot,
 * in the order of the sample player's `pose()`: scale, shear X, rotate Z, rotate Y, rotate X
 * (with perspective), and the pivot stays at `(x, y)`.
 */

export type { Ease, Frames };

/** Fill colour over time, `#RRGGBB`. Same segment semantics as `Frames`. */
export type ColourFrames = readonly (readonly [number, string, Ease?])[];

export interface Track {
  /** Pivot position, canvas px (absolute, not offsets). */
  x?: Frames;
  y?: Frames;
  /** Scale, 1 = rest. */
  sx?: Frames;
  sy?: Frames;
  /** Degrees. `rx` and `ry` foreshorten with the renderers' shared perspective. */
  rz?: Frames;
  rx?: Frames;
  ry?: Frames;
  /** Shear X, degrees. */
  skx?: Frames;
  /** Opacity 0..1 of the whole piece. */
  o?: Frames;
  /** Gaussian sigma, px, of the whole piece. */
  blur?: Frames;
  colour?: ColourFrames;
}

/** A clip in canvas px, or a rounded rectangle relative to the piece's pivot when radius is set. */
export interface Clip {
  x1: Frames;
  y1: Frames;
  x2: Frames;
  y2: Frames;
  /** A local corner radius in px. The rounded clip follows the piece's scale and Z rotation. */
  radius?: number;
  /** Keep what is outside the rectangle (`\iclip`). */
  inverse?: boolean;
}

export type PathCmd =
  | readonly ["M", number, number]
  | readonly ["L", number, number]
  | readonly ["C", number, number, number, number, number, number]
  | readonly ["Z"];

export interface Shadow {
  dx: number;
  dy: number;
  /** Gaussian sigma, px. */
  blur: number;
  colour: string;
  alpha: number;
}

export interface PieceBase {
  id: string;
  /** Paint order, low first; ties keep array order. */
  z: number;
  /** Visible window, clip ms: from inclusive, to exclusive. */
  fromMs: number;
  toMs: number;
  track: Track;
  clip?: Clip;
  /** Pivot offset from the piece's anchor point, px (default 0, 0). */
  origin?: { dx: number; dy: number };
  /**
   * Runs off the canvas on purpose (a tape, a bar, a marquee): `sceneBoundsAt` leaves it out, so the
   * safe-area shift and the selection box follow the rest of the cue. Painters ignore it.
   */
  bleed?: boolean;
}

export interface TextPiece extends PieceBase {
  kind: "text";
  text: string;
  /** The requested face; a word the face cannot draw falls back as every caption word does. */
  face: CaptionFontName;
  sizePx: number;
  letterSpacingEm: number;
  fill: string;
  /** 0 draws no fill at all: outline only (hollow). */
  fillAlpha?: number;
  /**
   * Outline outside the glyph, drawn under the fill. `widthPx` is the distance from the contour
   * (`\bord`, CSS `-webkit-text-stroke` of twice that with `paint-order: stroke fill`). With
   * `fillAlpha: 0` (hollow) the glyph's own area is left empty, so the outline is that band alone,
   * as libass draws it; the Studio masks the glyph out of the stroke.
   */
  stroke?: { widthPx: number; colour: string; alpha?: number };
  shadows?: readonly Shadow[];
  /** `x, y` is this point of the text: the middle of its advance, or its left edge, on the baseline. */
  anchor: "baseline-center" | "baseline-left";
  /** The cue's language: picks the fallback face for a script the face lacks. */
  language?: string | null;
}

export interface ShapePiece extends PieceBase {
  kind: "shape";
  /** Local px; (0, 0) is the anchor point. */
  path: readonly PathCmd[];
  fill?: { colour: string; alpha?: number };
  /** Round caps and joins. */
  stroke?: { widthPx: number; colour: string; alpha?: number };
  shadows?: readonly Shadow[];
}

export type Piece = TextPiece | ShapePiece;

export interface CaptionScene {
  readonly pieces: readonly Piece[];
}

/**
 * The camera distance, canvas px, of `rx` and `ry`: the Studio's CSS `perspective()` of a turned
 * piece. libass has no setting for it, so this is libass's own, measured in the primitives sheet
 * (`.scratch/motion-captions/spec.md` section 5, "Calibration"), and the Studio follows it.
 */
export const SCENE_PERSPECTIVE_PX = 326;

/** Pieces one cue may draw (shadow copies count once per shadow layer). */
export const SCENE_PIECE_BUDGET = 150;

/** Everything a renderer paints from at one instant. */
export interface PiecePose {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly sx: number;
  readonly sy: number;
  readonly rz: number;
  readonly rx: number;
  readonly ry: number;
  readonly skx: number;
  readonly o: number;
  readonly blur: number;
  /** `#RRGGBB` fill now (the track's, else the piece's own fill). */
  readonly colour: string;
  readonly clip: (Box & { readonly inverse: boolean; readonly radius?: number }) | null;
}

const channel = (hex: string, at: number) => Number.parseInt(hex.slice(1 + 2 * at, 3 + 2 * at), 16);
const toHex = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");

/** `#RRGGBB` mixed in sRGB, as the samples' CSS colour transitions are. */
export function mixColour(from: string, to: string, p: number): string {
  return `#${[0, 1, 2].map((at) => toHex(channel(from, at) + (channel(to, at) - channel(from, at)) * p)).join("").toUpperCase()}`;
}

/** A colour track at `t`: the first colour before the first frame, the last after the last. */
export function colourAt(frames: ColourFrames, t: number): string {
  const count = frames.length;
  if (count === 0) throw new Error("colourAt needs at least one frame");
  // Indexed, not destructured, for the reason `kf` gives.
  let previous = frames[0]!;
  if (t <= previous[0]) return previous[1];
  for (let index = 1; index < count; index++) {
    const frame = frames[index]!;
    const at = frame[0];
    if (t <= at) {
      const previousAt = previous[0];
      return mixColour(previous[1], frame[1], ease(frame[2], (t - previousAt) / (at - previousAt || 1)));
    }
    previous = frame;
  }
  return previous[1];
}

/** The piece's own fill: text fill, or a shape's fill colour. */
export function pieceFillColour(piece: Piece): string {
  return piece.kind === "text" ? piece.fill : (piece.fill?.colour ?? "#FFFFFF");
}

/** The one evaluator both renderers use (spec 3.1). */
export function evaluatePiece(piece: Piece, ms: number): PiecePose {
  const { track } = piece;
  const at = (frames: Frames | undefined, rest: number) => (frames ? kf(ms, frames) : rest);
  const clip = piece.clip
    ? { x1: kf(ms, piece.clip.x1), y1: kf(ms, piece.clip.y1), x2: kf(ms, piece.clip.x2), y2: kf(ms, piece.clip.y2), inverse: piece.clip.inverse === true, ...(piece.clip.radius !== undefined ? { radius: piece.clip.radius } : {}) }
    : null;
  return {
    visible: ms >= piece.fromMs && ms < piece.toMs,
    x: at(track.x, 0),
    y: at(track.y, 0),
    sx: at(track.sx, 1),
    sy: at(track.sy, 1),
    rz: at(track.rz, 0),
    rx: at(track.rx, 0),
    ry: at(track.ry, 0),
    skx: at(track.skx, 0),
    o: Math.min(1, Math.max(0, at(track.o, 1))),
    blur: Math.max(0, at(track.blur, 0)),
    colour: track.colour ? colourAt(track.colour, ms) : pieceFillColour(piece),
    clip,
  };
}

/** Axis-aligned rectangle, canvas px. */
export interface Box {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Transform the local rounded clip to canvas coordinates for both renderers. */
export function roundedClipPath(pose: Pick<PiecePose, "x" | "y" | "sx" | "sy" | "rz" | "clip">, scale = 1): PathCmd[] {
  const clip = pose.clip;
  if (!clip || clip.radius === undefined || clip.x2 <= clip.x1 || clip.y2 <= clip.y1) return [];
  const angle = pose.rz * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const point = (x: number, y: number) => [
    (pose.x + x * pose.sx * cos - y * pose.sy * sin) * scale,
    (pose.y + x * pose.sx * sin + y * pose.sy * cos) * scale,
  ] as const;
  return roundedRectPath(clip.x1, clip.y1, clip.x2 - clip.x1, clip.y2 - clip.y1, clip.radius).map((command): PathCmd => {
    switch (command[0]) {
      case "Z": return command;
      case "C": return ["C", ...point(command[1], command[2]), ...point(command[3], command[4]), ...point(command[5], command[6])];
      default: return [command[0], ...point(command[1], command[2])];
    }
  });
}

/** What a renderer measures for a run of text: px, advance excludes the trailing letter spacing. */
export interface TextMeasure {
  readonly advance: number;
  /** y of the ink's top relative to the baseline, negative above it. */
  readonly inkTop: number;
  /** y of the ink's bottom relative to the baseline, positive below it. */
  readonly inkBottom: number;
  /** The face's line box above and below the baseline (win metrics), px, positive. */
  readonly ascent: number;
  readonly descent: number;
}

export type Measure = (text: string, face: CaptionFontName, sizePx: number, letterSpacingEm: number) => TextMeasure;

/** The rest box of a piece's drawing in its own coordinates, relative to its anchor point. */
export function pieceLocalBox(piece: Piece, measure: Measure): Box {
  // A piece's rest box is fixed for one measurement, and bounds sampling asks for it on every sample.
  const cached = localBoxes.get(piece);
  if (cached?.measure === measure) return cached.box;
  const box = restBox(piece, measure);
  localBoxes.set(piece, { measure, box });
  return box;
}

const localBoxes = new WeakMap<Piece, { readonly measure: Measure; readonly box: Box }>();

function restBox(piece: Piece, measure: Measure): Box {
  if (piece.kind === "shape") {
    const bounds = pathBounds(piece.path);
    const reach = piece.stroke ? piece.stroke.widthPx : 0;
    return { x1: bounds.x1 - reach, y1: bounds.y1 - reach, x2: bounds.x2 + reach, y2: bounds.y2 + reach };
  }
  const m = measure(piece.text, piece.face, piece.sizePx, piece.letterSpacingEm);
  const left = piece.anchor === "baseline-center" ? -m.advance / 2 : 0;
  const reach = piece.stroke ? piece.stroke.widthPx : 0;
  return { x1: left - reach, y1: m.inkTop - reach, x2: left + m.advance + reach, y2: m.inkBottom + reach };
}

/**
 * Where the piece's drawing sits on the canvas at `ms`: its rest box moved to the pivot, scaled
 * and turned about it (perspective ignored), cut to its clip. Null when it is not visible or the
 * clip leaves nothing. A bound for the selection box and the safe-area shift, not a render.
 */
export function pieceBounds(piece: Piece, ms: number, measure: Measure): Box | null {
  // The geometry part of `evaluatePiece`, the same numbers: fits and safe-area shifts sample bounds
  // thousands of times per build, and colour, blur and the 3D turns do not move the box.
  if (ms < piece.fromMs || ms >= piece.toMs) return null;
  const { track } = piece;
  if (track.o && kf(ms, track.o) <= 0) return null;
  const clip = piece.clip
    ? { x1: kf(ms, piece.clip.x1), y1: kf(ms, piece.clip.y1), x2: kf(ms, piece.clip.x2), y2: kf(ms, piece.clip.y2), inverse: piece.clip.inverse === true, ...(piece.clip.radius !== undefined ? { radius: piece.clip.radius } : {}) }
    : null;
  const pose = {
    x: track.x ? kf(ms, track.x) : 0,
    y: track.y ? kf(ms, track.y) : 0,
    sx: track.sx ? kf(ms, track.sx) : 1,
    sy: track.sy ? kf(ms, track.sy) : 1,
    rz: track.rz ? kf(ms, track.rz) : 0,
    clip,
  };
  const local = pieceLocalBox(piece, measure);
  const origin = piece.origin ?? { dx: 0, dy: 0 };
  const angle = (pose.rz * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // The four corners relative to the pivot, scaled, then turned (written out: this runs per sample).
  const left = (local.x1 - origin.dx) * pose.sx;
  const right = (local.x2 - origin.dx) * pose.sx;
  const top = (local.y1 - origin.dy) * pose.sy;
  const bottom = (local.y2 - origin.dy) * pose.sy;
  const ax = pose.x + left * cos - top * sin;
  const ay = pose.y + left * sin + top * cos;
  const bx = pose.x + right * cos - top * sin;
  const by = pose.y + right * sin + top * cos;
  const cx = pose.x + right * cos - bottom * sin;
  const cy = pose.y + right * sin + bottom * cos;
  const dx = pose.x + left * cos - bottom * sin;
  const dy = pose.y + left * sin + bottom * cos;
  let box: Box = { x1: Math.min(ax, bx, cx, dx), y1: Math.min(ay, by, cy, dy), x2: Math.max(ax, bx, cx, dx), y2: Math.max(ay, by, cy, dy) };
  if (pose.clip && !pose.clip.inverse) {
    const path = pose.clip.radius === undefined ? undefined : roundedClipPath(pose);
    if (path?.length === 0) return null;
    const clip = path ? pathBounds(path) : pose.clip;
    box = {
      x1: Math.max(box.x1, Math.min(clip.x1, clip.x2)),
      y1: Math.max(box.y1, Math.min(clip.y1, clip.y2)),
      x2: Math.min(box.x2, Math.max(clip.x1, clip.x2)),
      y2: Math.min(box.y2, Math.max(clip.y1, clip.y2)),
    };
    if (box.x2 <= box.x1 || box.y2 <= box.y1) return null;
  }
  return box;
}

/** Union of the boxes of `pieces` visible at `ms` (only the pieces live then are looked at). */
export function sceneBoundsAt(pieces: readonly Piece[], ms: number, measure: Measure): Box | null {
  let found = false;
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (const at of livePieceIndexes(pieces, ms)) {
    const piece = pieces[at]!;
    if (piece.bleed) continue;
    const box = pieceBounds(piece, ms, measure);
    if (!box) continue;
    if (!found) {
      found = true;
      x1 = box.x1;
      y1 = box.y1;
      x2 = box.x2;
      y2 = box.y2;
      continue;
    }
    x1 = Math.min(x1, box.x1);
    y1 = Math.min(y1, box.y1);
    x2 = Math.max(x2, box.x2);
    y2 = Math.max(y2, box.y2);
  }
  return found ? { x1, y1, x2, y2 } : null;
}

/**
 * The union of `sceneBoundsAt` over every time in `times`: the same box, computed piece by piece. A piece's geometry holds one
 * pose up to its first keyframe and another after its last, so each hold is evaluated once instead of once per sample (fits
 * and safe-area checks sample every few ms, and most of a piece's life is a hold).
 */
export function sceneBoundsOver(pieces: readonly Piece[], times: Iterable<number>, measure: Measure): Box | null {
  const sorted = Float64Array.from(times).sort();
  let found = false;
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  const add = (box: Box | null) => {
    if (!box) return;
    if (!found) {
      found = true;
      x1 = box.x1;
      y1 = box.y1;
      x2 = box.x2;
      y2 = box.y2;
      return;
    }
    x1 = Math.min(x1, box.x1);
    y1 = Math.min(y1, box.y1);
    x2 = Math.max(x2, box.x2);
    y2 = Math.max(y2, box.y2);
  };
  for (const piece of pieces) {
    if (piece.bleed) continue;
    const { first, last } = geometryKeyframeSpan(piece);
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (sorted[mid]! < piece.fromMs) low = mid + 1;
      else high = mid;
    }
    let before = false;
    let after = false;
    for (let at = low; at < sorted.length; at++) {
      const t = sorted[at]!;
      if (t >= piece.toMs) break;
      // `kf` answers a track's first value exactly up to its first frame, and its last value exactly after its last.
      if (t <= first) {
        if (!before) add(pieceBounds(piece, t, measure));
        before = true;
      } else if (t > last) {
        if (!after) add(pieceBounds(piece, t, measure));
        after = true;
      } else add(pieceBounds(piece, t, measure));
    }
  }
  return found ? { x1, y1, x2, y2 } : null;
}

/** The earliest first frame and the latest last frame of the tracks `pieceBounds` reads. */
function geometryKeyframeSpan(piece: Piece): { first: number; last: number } {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  const span = (frames: Frames | undefined) => {
    if (!frames || frames.length === 0) return;
    first = Math.min(first, frames[0]![0]);
    last = Math.max(last, frames[frames.length - 1]![0]);
  };
  const { track, clip } = piece;
  span(track.x);
  span(track.y);
  span(track.sx);
  span(track.sy);
  span(track.rz);
  span(track.o);
  if (clip) {
    span(clip.x1);
    span(clip.y1);
    span(clip.x2);
    span(clip.y2);
  }
  return { first, last };
}

/** The time range a scene covers: first piece start to last piece end. */
export function sceneRange(scene: CaptionScene): { fromMs: number; toMs: number } {
  let fromMs = Number.POSITIVE_INFINITY;
  let toMs = Number.NEGATIVE_INFINITY;
  for (const piece of scene.pieces) {
    fromMs = Math.min(fromMs, piece.fromMs);
    toMs = Math.max(toMs, piece.toMs);
  }
  return Number.isFinite(fromMs) ? { fromMs, toMs } : { fromMs: 0, toMs: 0 };
}

/** The pieces visible at `ms`, in paint order (`z`, then array order). */
export function visiblePieces(scene: CaptionScene, ms: number): Piece[] {
  return livePieceIndexes(scene.pieces, ms)
    .sort((a, b) => scene.pieces[a]!.z - scene.pieces[b]!.z || a - b)
    .map((at) => scene.pieces[at]!);
}
