import { layoutCaptionLine } from "@narriflow/caption-fonts";
import { CAPTION_RTL_MARK } from "@narriflow/caption-fonts/caption-block";
import {
  type CaptionScene,
  type Measure,
  type Piece,
  type PiecePose,
  type SceneInput,
  type TextMeasure,
  buildCaptionScene,
  evaluatePiece,
  pathBounds,
  pathToAss,
  retracePath,
  sceneCuesFromLayers,
  sceneInputFromPreset,
} from "@narriflow/caption-scene";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
  type CaptionFontName,
  type CaptionSceneName,
  captionFontFace,
  languageDirection,
  textDirection,
} from "@narriflow/validators";
import { ASS_BLUR_PER_SIGMA, type AssEvent, alphaByte, assColor, assText, num } from "./ass-format";
import { wordParts } from "./caption-block-geometry";
import {
  CaptionGlyphPlanner,
  type CaptionGlyphNotice,
  type CaptionFace,
  type OmittedGlyph,
  type PlannedCluster,
  catalogCaptionFace,
} from "./caption-glyphs";

/**
 * Scene Style burn-in (ADR 0021, spec 3.3). The shared program turns a target's cues into pieces
 * with keyframe tracks; this file measures text with HarfBuzz, asks the program for the scene, and
 * writes every piece as ASS events so that, at every rendered frame, libass draws what
 * `evaluatePiece` says (the same function the Studio paints from).
 *
 * How a piece becomes events. libass renders at integer milliseconds, so the writer samples the
 * piece at those times (`frameTimes`) and cuts its life into spans: each span is one event per paint
 * layer (shadows, then the fill with its outline), its tags built from the span's samples.
 *  - Position is one `\move` per event, so a span ends where the position stops being linear
 *    (error over 0.5 px at a frame) or where a turn about a moving pivot would drift (`\org` is
 *    fixed per event).
 *  - Scale, turn, shear, blur, opacity, colour and clip animate through `\t` chains between the
 *    span's samples, merged while the line through them stays within a tolerance of every sample.
 *  - libass scales about the point `\pos` names, not about the pivot, so `\pos` is the pivot plus
 *    the scaled offset of that point from it: `S(t) = P(t) + diag(sx, sy) * (m - o)`.
 *  - Frames where a piece draws nothing (opacity 0, scale 0, clip empty) are left out.
 * Event times are centiseconds; tag times are integer ms from the event's own start, so a span's
 * first frame always falls at or after its start and before the previous span's end.
 */

/** Calibrated against libass in the primitives sheet (`bun apps/media/scripts/caption-scene-sheet.ts`). */
export const SCENE_ASS = {
  /** `\frx` is the CSS `rotateX` degrees times this. */
  rxSign: 1,
  /** `\fry` is the CSS `rotateY` degrees times this. */
  rySign: 1,
  /** `\fax` shear per tangent of the CSS `skewX` angle. */
  faxSign: 1,
} as const;

/** The tolerances of "the tags imply the evaluator's value at every frame" (spec 5.4). */
export const SCENE_TOLERANCE = { px: 0.5, position: 0.25, scalePercent: 0.5, degrees: 0.05, alphaByte: 1, blur: 0.1, colour: 1, bord: 0.05 } as const;

/** Sampling rate of a piece's tracks; libass interpolates linearly between samples at the real frame rate. */
const MAX_SAMPLE_FPS = 60;

const SUB = { shadow: 0, fill: 5, stroke: 6 } as const;

// ─── Measurement ─────────────────────────────────────────────────────────────

/** Everything the writer needs of a measured run of text. */
export interface SceneTextMetrics {
  readonly text: string;
  readonly clusters: readonly PlannedCluster[];
  readonly requested: CaptionFace;
  readonly direction: "ltr" | "rtl";
  readonly advanceEm: number;
  readonly bboxCenterEm: number;
  readonly inkTopEm: number;
  readonly inkBottomEm: number;
  readonly ascentEm: number;
  readonly descentEm: number;
}

export interface SceneGlyphReport {
  readonly notices: Map<string, CaptionGlyphNotice>;
  readonly omitted: Map<string, OmittedGlyph>;
}

/** HarfBuzz measurement of scene text, faces and fallbacks planned as every caption word is. */
export class SceneMeasurer {
  private readonly planners = new Map<CaptionFontName, CaptionGlyphPlanner>();
  private readonly cache = new Map<string, SceneTextMetrics>();

  constructor(
    private readonly report: SceneGlyphReport,
    private readonly forcedOmissions: ReadonlySet<number>,
    private readonly language: string | null,
  ) {}

  private planner(fontName: CaptionFontName): CaptionGlyphPlanner {
    let planner = this.planners.get(fontName);
    if (!planner) {
      planner = new CaptionGlyphPlanner(catalogCaptionFace(captionFontFace(fontName), "requested"), null, this.report, 0, this.forcedOmissions, this.language);
      this.planners.set(fontName, planner);
    }
    return planner;
  }

  metrics(text: string, fontName: CaptionFontName, letterSpacingEm: number): SceneTextMetrics {
    const key = `${fontName}\0${letterSpacingEm}\0${text}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const planner = this.planner(fontName);
    const planned = planner.plan(text);
    const direction = textDirection(text, languageDirection(this.language));
    // An RTL run starts with U+200F so libass orders its neutral characters as the Studio does.
    const markFace = direction === "rtl" ? planner.markFace(CAPTION_RTL_MARK, wordParts(planned).map((part) => part.face)) : null;
    const clusters: readonly PlannedCluster[] = markFace
      ? [{ text: CAPTION_RTL_MARK, parts: [{ text: CAPTION_RTL_MARK, face: markFace, spaced: false }] }, ...planned]
      : planned;
    const parts = wordParts(clusters);
    const line = layoutCaptionLine(
      [{ parts: parts.map((part) => ({ text: part.text, fontPath: part.face.path, spaced: part.spaced, inked: true })), gap: null, gapExtraEm: 0 }],
      letterSpacingEm,
      direction,
    );
    const trailing = parts[parts.length - 1]?.spaced ? letterSpacingEm : 0;
    const faces = parts.length > 0 ? parts.map((part) => part.face) : [planner.requested];
    const metrics: SceneTextMetrics = {
      text,
      clusters,
      requested: planner.requested,
      direction,
      advanceEm: line.widthEm - trailing,
      bboxCenterEm: line.bboxCenterEm,
      inkTopEm: line.inkTopEm,
      inkBottomEm: line.inkBottomEm,
      ascentEm: Math.max(...faces.map((face) => face.ascentEm)),
      descentEm: Math.max(...faces.map((face) => face.descentEm)),
    };
    this.cache.set(key, metrics);
    return metrics;
  }

  /** The `Measure` scene programs call. */
  readonly measure: Measure = (text, face, sizePx, letterSpacingEm): TextMeasure => {
    const m = this.metrics(text, face, letterSpacingEm);
    return {
      advance: m.advanceEm * sizePx,
      inkTop: -m.inkTopEm * sizePx,
      inkBottom: m.inkBottomEm * sizePx,
      ascent: m.ascentEm * sizePx,
      descent: m.descentEm * sizePx,
    };
  };
}

// ─── Scene input from plan layers ───────────────────────────────────────────

/** A scene layer: a Scene Style preset's caption layer with its scene facts. */
export function isSceneLayer(layer: CompositionCaptionVisualLayer): boolean {
  return layer.preset.scene !== undefined && layer.scene !== undefined;
}

/** The input the preset's program is built from, for the scene layers of one caption target. */
export function sceneInputForLayers(
  layers: readonly CompositionCaptionVisualLayer[],
  canvas: { width: number; height: number },
  measure: Measure,
): { name: CaptionSceneName; input: SceneInput } {
  const first = layers[0]!;
  return { name: first.preset.scene!, input: sceneInputFromPreset(first.preset, { cues: sceneCuesFromLayers(layers), canvas, measure, anchor: first.anchor }) };
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface SceneEventOptions {
  readonly canvas: { width: number; height: number };
  /** Sampling frame rate (clamped to 60). */
  readonly fps?: number;
}

/** Render times, integer ms, of the frames inside `[fromMs, toMs)` at `fps` (libass is given rounded ms). */
export function frameTimes(fromMs: number, toMs: number, fps: number): number[] {
  const rate = Math.min(MAX_SAMPLE_FPS, Math.max(1, fps));
  const times: number[] = [];
  for (let frame = Math.max(0, Math.ceil(((fromMs - 0.5) * rate) / 1000)); ; frame++) {
    const t = Math.round((frame * 1000) / rate);
    if (t >= toMs) break;
    if (t >= fromMs) times.push(t);
  }
  return times;
}

/** The first frame time after `t`. */
function nextFrameTime(t: number, fps: number): number {
  const rate = Math.min(MAX_SAMPLE_FPS, Math.max(1, fps));
  let frame = Math.floor((t * rate) / 1000);
  while (Math.round((frame * 1000) / rate) <= t) frame++;
  return Math.round((frame * 1000) / rate);
}

const csFloor = (ms: number) => Math.floor(ms / 10) * 10;

/** A paint layer of a piece: its event text pieces and where it sits relative to the pivot. */
interface PaintLayer {
  readonly sub: number;
  /** Offset of the layer from the piece's own drawing, local px (a shadow's). */
  readonly offset: { dx: number; dy: number };
  /** Everything after the common tags: colour, alpha and blur tags are layer-specific. */
  readonly kind: "shadow" | "fill" | "stroke";
  readonly shadowIndex?: number;
}

/** What the span builder needs to know about one piece. */
interface PieceGeometry {
  /** Vector from the pivot to the point `\pos` names, at rest scale, local px (before the layer offset). */
  readonly toAlignment: { x: number; y: number };
  /** Height of the box libass aligns the event by (a text's line box, a drawing's bounds); `\fax` shears about its top edge. */
  readonly boxHeight: number;
}

function frameDrawn(pose: PiecePose): boolean {
  if (!pose.visible || pose.o <= 0.002) return false;
  if (Math.abs(pose.sx) < 1e-4 || Math.abs(pose.sy) < 1e-4) return false;
  if (pose.clip && !pose.clip.inverse && (pose.clip.x2 <= pose.clip.x1 || pose.clip.y2 <= pose.clip.y1)) return false;
  return true;
}

/** Merge a series of samples into segments: indices where the polyline through the kept samples stays within `tolerance` of every sample. */
function simplify(times: readonly number[], values: readonly number[], tolerance: number): number[] {
  const keep = [0];
  let start = 0;
  while (start < values.length - 1) {
    let end = start + 1;
    while (end + 1 < values.length) {
      const candidate = end + 1;
      let ok = true;
      for (let k = start + 1; k < candidate && ok; k++) {
        const u = (times[k]! - times[start]!) / (times[candidate]! - times[start]! || 1);
        if (Math.abs(values[start]! + (values[candidate]! - values[start]!) * u - values[k]!) > tolerance) ok = false;
      }
      if (!ok) break;
      end = candidate;
    }
    keep.push(end);
    start = end;
  }
  return keep;
}

/** `\tag<first>\t(t1,t2,\tag<v>)...` for a series of values at `times` (relative ms). */
function chain(tag: string, times: readonly number[], values: readonly number[], tolerance: number, format: (value: number) => string): string {
  if (values.length === 0) return "";
  let out = `\\${tag}${format(values[0]!)}`;
  const keep = simplify(times, values, tolerance);
  for (let at = 1; at < keep.length; at++) {
    const a = keep[at - 1]!;
    const b = keep[at]!;
    if (values[b] === values[a]) continue;
    out += `\\t(${times[a]},${times[b]},\\${tag}${format(values[b]!)})`;
  }
  return out;
}

const bgr = (hex: string) => assColor(hex).slice(2, -1);

/** A colour series as `\1c`/`\3c` with `\t` chains: each channel within one level of every sample. */
function colourChain(tag: string, times: readonly number[], colours: readonly string[]): string {
  const channels = [0, 1, 2].map((at) => colours.map((colour) => Number.parseInt(colour.slice(1 + 2 * at, 3 + 2 * at), 16)));
  const keepSets = channels.map((values) => simplify(times, values, SCENE_TOLERANCE.colour));
  const keep = [...new Set(keepSets.flat())].sort((a, b) => a - b);
  let out = `\\${tag}&H${bgr(colours[0]!)}&`;
  for (let at = 1; at < keep.length; at++) {
    const a = keep[at - 1]!;
    const b = keep[at]!;
    if (colours[a] === colours[b]) continue;
    out += `\\t(${times[a]},${times[b]},\\${tag}&H${bgr(colours[b]!)}&)`;
  }
  return out;
}

interface Span {
  readonly from: number;
  readonly to: number;
}

/**
 * The events of one piece. `metrics` is the measured text of a text piece. Returns events in paint
 * order within the piece (shadows, fill, stroke).
 */
function pieceEvents(piece: Piece, metrics: SceneTextMetrics | null, options: SceneEventOptions): AssEvent[] {
  const fps = options.fps ?? 30;
  const times = frameTimes(piece.fromMs, piece.toMs, fps);
  if (times.length === 0) return [];
  const poses = times.map((t) => evaluatePiece(piece, t));
  const drawn = poses.map(frameDrawn);
  const geometry = pieceGeometry(piece, metrics);
  const layers = paintLayers(piece);
  const events: AssEvent[] = [];
  // Runs of consecutive drawn frames.
  let runStart = -1;
  const runs: Span[] = [];
  for (let at = 0; at <= times.length; at++) {
    if (at < times.length && drawn[at]) {
      if (runStart < 0) runStart = at;
    } else if (runStart >= 0) {
      runs.push({ from: runStart, to: at - 1 });
      runStart = -1;
    }
  }
  for (const run of runs) {
    for (const span of cutSpans(run, times, poses, geometry, layers)) {
      const startMs = csFloor(times[span.from]!);
      const endMs = csFloor(span.to + 1 < times.length && drawn[span.to + 1] ? times[span.to + 1]! : nextFrameTime(times[span.to]!, fps));
      for (const layer of layers) events.push(layerEvent(piece, metrics, geometry, layer, span, times, poses, startMs, endMs));
    }
  }
  return events;
}

function paintLayers(piece: Piece): PaintLayer[] {
  const layers: PaintLayer[] = (piece.shadows ?? []).map((shadow, index) => ({ sub: SUB.shadow + Math.min(index, 4), offset: { dx: shadow.dx, dy: shadow.dy }, kind: "shadow", shadowIndex: index }));
  if (piece.kind === "shape") {
    // A shape's fill and its stroke are two events: the stroke is the zero-area retrace's border, centred on the line.
    if (piece.fill) layers.push({ sub: SUB.fill, offset: { dx: 0, dy: 0 }, kind: "fill" });
    if (piece.stroke) layers.push({ sub: SUB.stroke, offset: { dx: 0, dy: 0 }, kind: "stroke" });
  } else layers.push({ sub: SUB.fill, offset: { dx: 0, dy: 0 }, kind: "fill" });
  return layers;
}

function pieceGeometry(piece: Piece, metrics: SceneTextMetrics | null): PieceGeometry {
  const origin = piece.origin ?? { dx: 0, dy: 0 };
  if (piece.kind === "text") {
    const m = metrics!;
    const px = piece.sizePx;
    const advance = m.advanceEm * px;
    const centreX = piece.anchor === "baseline-center" ? 0 : advance / 2;
    // libass puts the middle of its \pos box, not of the advance box, on the anchor; and an `\an5` event is centred on its line box.
    const mx = centreX + (m.bboxCenterEm - m.advanceEm / 2) * px;
    const my = -((m.ascentEm - m.descentEm) / 2) * px;
    return { toAlignment: { x: mx - origin.dx, y: my - origin.dy }, boxHeight: (m.ascentEm + m.descentEm) * px };
  }
  // libass aligns a drawing as a box of its bounding box's size whose top-left is the drawing's own (0, 0):
  // a point q lands at `\pos - (w, h) / 2 + q`, so the alignment point is (w/2, h/2) in drawing coordinates.
  const bounds = pathBounds(piece.path);
  return { toAlignment: { x: (bounds.x2 - bounds.x1) / 2 - origin.dx, y: (bounds.y2 - bounds.y1) / 2 - origin.dy }, boxHeight: bounds.y2 - bounds.y1 };
}

/** `\pos` of a layer at a frame: the pivot plus the scaled vector to the alignment point. */
function alignmentAt(geometry: PieceGeometry, layer: PaintLayer, pose: PiecePose): { x: number; y: number } {
  const dy = geometry.toAlignment.y + layer.offset.dy;
  // libass shears about the top edge of its aligned box, the model about the pivot: the difference is a shift along x.
  const shear = pose.skx === 0 ? 0 : Math.tan((pose.skx * Math.PI) / 180) * pose.sy * (dy - geometry.boxHeight / 2);
  return {
    x: pose.x + pose.sx * (geometry.toAlignment.x + layer.offset.dx) + shear,
    y: pose.y + pose.sy * dy,
  };
}

/** Cuts a run of drawn frames into spans one event can carry (linear position, steady org). */
function cutSpans(run: Span, times: readonly number[], poses: readonly PiecePose[], geometry: PieceGeometry, layers: readonly PaintLayer[]): Span[] {
  const spans: Span[] = [];
  let from = run.from;
  while (from <= run.to) {
    let to = from;
    while (to < run.to) {
      const candidate = to + 1;
      if (!spanFits(from, candidate, times, poses, geometry, layers)) break;
      to = candidate;
    }
    spans.push({ from, to });
    from = to + 1;
  }
  return spans;
}

function spanFits(from: number, to: number, times: readonly number[], poses: readonly PiecePose[], geometry: PieceGeometry, layers: readonly PaintLayer[]): boolean {
  const duration = times[to]! - times[from]!;
  for (const layer of layers) {
    const a = alignmentAt(geometry, layer, poses[from]!);
    const b = alignmentAt(geometry, layer, poses[to]!);
    for (let k = from + 1; k < to; k++) {
      const u = (times[k]! - times[from]!) / duration;
      const at = alignmentAt(geometry, layer, poses[k]!);
      if (Math.hypot(at.x - (a.x + (b.x - a.x) * u), at.y - (a.y + (b.y - a.y) * u)) > SCENE_TOLERANCE.position) return false;
    }
  }
  // `\org` is one fixed point per event: a turn about a pivot that has moved would drift.
  let turn = 0;
  let travel = 0;
  for (let k = from; k <= to; k++) {
    const pose = poses[k]!;
    turn = Math.max(turn, Math.abs(pose.rz), Math.abs(pose.rx), Math.abs(pose.ry), Math.abs(pose.skx));
    travel = Math.max(travel, Math.hypot(pose.x - poses[from]!.x, pose.y - poses[from]!.y));
  }
  return travel * ((turn * Math.PI) / 180) <= SCENE_TOLERANCE.px * 0.8;
}

function layerEvent(
  piece: Piece,
  metrics: SceneTextMetrics | null,
  geometry: PieceGeometry,
  layer: PaintLayer,
  span: Span,
  times: readonly number[],
  poses: readonly PiecePose[],
  startMs: number,
  endMs: number,
): AssEvent {
  const indices = Array.from({ length: span.to - span.from + 1 }, (_, k) => span.from + k);
  const rel = indices.map((k) => times[k]! - startMs);
  const at = <T,>(read: (pose: PiecePose, k: number) => T) => indices.map((k) => read(poses[k]!, k));
  const first = poses[span.from]!;
  const last = poses[span.to]!;

  // Position.
  const a = alignmentAt(geometry, layer, first);
  const b = alignmentAt(geometry, layer, last);
  const still = Math.hypot(b.x - a.x, b.y - a.y) < 0.005 && rel.length > 0;
  const position = still || rel.length < 2 ? `\\pos(${num(a.x)},${num(a.y)})` : `\\move(${num(a.x)},${num(a.y)},${num(b.x)},${num(b.y)},${rel[0]},${rel[rel.length - 1]})`;

  const turned = indices.some((k) => poses[k]!.rz !== 0 || poses[k]!.rx !== 0 || poses[k]!.ry !== 0 || poses[k]!.skx !== 0);
  const org = turned ? `\\org(${num(first.x)},${num(first.y)})` : "";

  // Transform tags.
  const tags: string[] = [];
  const uniform = <V,>(values: readonly V[]) => values.every((value) => value === values[0]);
  const sxs = at((pose) => pose.sx * 100);
  const sys = at((pose) => pose.sy * 100);
  if (!uniform(sxs) || sxs[0] !== 100) tags.push(chain("fscx", rel, sxs, SCENE_TOLERANCE.scalePercent, num));
  if (!uniform(sys) || sys[0] !== 100) tags.push(chain("fscy", rel, sys, SCENE_TOLERANCE.scalePercent, num));
  const rzs = at((pose) => -pose.rz);
  if (!uniform(rzs) || rzs[0] !== 0) tags.push(chain("frz", rel, rzs, SCENE_TOLERANCE.degrees, num));
  const rxs = at((pose) => SCENE_ASS.rxSign * pose.rx);
  if (!uniform(rxs) || rxs[0] !== 0) tags.push(chain("frx", rel, rxs, SCENE_TOLERANCE.degrees, num));
  const rys = at((pose) => SCENE_ASS.rySign * pose.ry);
  if (!uniform(rys) || rys[0] !== 0) tags.push(chain("fry", rel, rys, SCENE_TOLERANCE.degrees, num));
  const faxs = at((pose) => SCENE_ASS.faxSign * Math.tan((pose.skx * Math.PI) / 180));
  if (!uniform(faxs) || faxs[0] !== 0) tags.push(chain("fax", rel, faxs, 0.0005, (value) => String(Math.round(value * 10000) / 10000)));

  // Blur: a layer's own sigma and the piece's add in quadrature (CSS nests the two filters).
  const ownBlur = layer.kind === "shadow" ? piece.shadows![layer.shadowIndex!]!.blur : 0;
  const blurs = at((pose) => Math.hypot(pose.blur, ownBlur) * ASS_BLUR_PER_SIGMA);
  if (!uniform(blurs) || blurs[0]! > 0) tags.push(chain("blur", rel, blurs, SCENE_TOLERANCE.blur, num));

  // Clip, in canvas px, not carried by the piece's own transform.
  if (piece.clip) tags.push(clipTags(piece, rel, at((pose) => pose.clip!)));

  // Colour and alpha per layer.
  const alphaFor = (base: number) => at((pose) => alphaByte(base * pose.o));
  const alphaChain = (tag: string, base: number) => {
    const bytes = alphaFor(base);
    const hex = (value: number) => `&H${Math.round(value).toString(16).toUpperCase().padStart(2, "0")}&`;
    return chain(tag, rel, bytes, SCENE_TOLERANCE.alphaByte, hex);
  };
  // libass draws a border at its own width however the piece is scaled; a CSS stroke scales with its element, so the border follows the scale.
  const bordTags = (width: number) => {
    if (width <= 0) return "\\bord0";
    const xs = at((pose) => width * Math.abs(pose.sx));
    const ys = at((pose) => width * Math.abs(pose.sy));
    if (xs.every((value, k) => Math.abs(value - ys[k]!) < 0.01)) return chain("bord", rel, xs, SCENE_TOLERANCE.bord, num);
    return chain("xbord", rel, xs, SCENE_TOLERANCE.bord, num) + chain("ybord", rel, ys, SCENE_TOLERANCE.bord, num);
  };
  let style: AssEvent["style"] = "Caption";
  let body = "";
  let paint = "";
  if (piece.kind === "text") {
    const m = metrics!;
    const px = piece.sizePx;
    const stroke = piece.stroke;
    let fill: string;
    let outline: string;
    let fillAlpha: number;
    let outlineAlpha: number;
    let bord: number;
    if (layer.kind === "shadow") {
      const shadow = piece.shadows![layer.shadowIndex!]!;
      fill = shadow.colour;
      outline = shadow.colour;
      fillAlpha = shadow.alpha * (piece.fillAlpha ?? 1);
      outlineAlpha = shadow.alpha;
      bord = stroke?.widthPx ?? 0;
    } else {
      fill = first.colour;
      outline = stroke?.colour ?? first.colour;
      fillAlpha = piece.fillAlpha ?? 1;
      outlineAlpha = stroke ? (stroke.alpha ?? 1) : 0;
      bord = stroke?.widthPx ?? 0;
    }
    const fillColours = layer.kind === "shadow" ? null : at((pose) => pose.colour);
    paint =
      (fillColours && !uniform(fillColours) ? colourChain("1c", rel, fillColours) : `\\1c${assColor(fill)}`) +
      `\\3c${assColor(outline)}` +
      alphaChain("1a", fillAlpha) +
      alphaChain("3a", outlineAlpha) +
      `${bordTags(bord)}\\shad0`;
    const face = m.requested;
    body = `{\\an5\\fn${face.assName}${position}${org}\\fs${num(px * face.lineHeightEm)}\\fsp${num(piece.letterSpacingEm * px)}${paint}${tags.join("")}}${assText(m.clusters, face, px, piece.letterSpacingEm)}`;
  } else {
    style = "Shape";
    const shadow = layer.kind === "shadow" ? piece.shadows![layer.shadowIndex!]! : null;
    const stroking = layer.kind === "stroke" || (shadow !== null && !piece.fill && piece.stroke !== undefined);
    const stroke = piece.stroke;
    const colour = shadow ? shadow.colour : stroking ? stroke!.colour : first.colour;
    const alpha = shadow ? shadow.alpha * (stroking ? (stroke!.alpha ?? 1) : (piece.fill?.alpha ?? 1)) : stroking ? (stroke!.alpha ?? 1) : (piece.fill?.alpha ?? 1);
    const colourSeries = layer.kind === "fill" ? at((pose) => pose.colour) : null;
    const fillTag = colourSeries && !uniform(colourSeries) ? colourChain("1c", rel, colourSeries) : `\\1c${assColor(colour)}`;
    paint =
      fillTag +
      `\\3c${assColor(colour)}` +
      (stroking ? "\\1a&HFF&" : alphaChain("1a", alpha)) +
      (stroking ? alphaChain("3a", alpha) : "\\3a&HFF&") +
      `${bordTags(stroking ? stroke!.widthPx / 2 : 0)}\\shad0`;
    const drawing = stroking ? retracePath(piece.path) : piece.path;
    body = `{\\an5${position}${org}${paint}${tags.join("")}\\p1}${pathToAss(drawing)}{\\p0}`;
  }
  return { layer: piece.z * 10 + layer.sub, startSec: startMs / 1000, endSec: endMs / 1000, style, text: body };
}

/** `\clip` (or `\iclip`) with the rectangle's `\t` chain. */
function clipTags(piece: Piece, rel: readonly number[], clips: readonly NonNullable<PiecePose["clip"]>[]): string {
  const tag = piece.clip!.inverse ? "iclip" : "clip";
  const rect = (clip: (typeof clips)[number]) => `\\${tag}(${num(Math.min(clip.x1, clip.x2))},${num(Math.min(clip.y1, clip.y2))},${num(Math.max(clip.x1, clip.x2))},${num(Math.max(clip.y1, clip.y2))})`;
  const series = [clips.map((clip) => Math.min(clip.x1, clip.x2)), clips.map((clip) => Math.min(clip.y1, clip.y2)), clips.map((clip) => Math.max(clip.x1, clip.x2)), clips.map((clip) => Math.max(clip.y1, clip.y2))];
  const keepSets = series.map((values) => simplify(rel, values, SCENE_TOLERANCE.px));
  const keep = [...new Set(keepSets.flat())].sort((a, b) => a - b);
  let out = rect(clips[0]!);
  for (let at = 1; at < keep.length; at++) {
    const a = keep[at - 1]!;
    const b = keep[at]!;
    if (series.every((values) => values[a] === values[b])) continue;
    out += `\\t(${rel[a]},${rel[b]},${rect(clips[b]!)})`;
  }
  return out;
}

/** Every event of a scene, lowest layer first (libass keeps read order inside a layer). */
export function sceneEvents(scene: CaptionScene, measurer: SceneMeasurer, options: SceneEventOptions): AssEvent[] {
  const events: AssEvent[] = [];
  for (const piece of scene.pieces) {
    const metrics = piece.kind === "text" ? measurer.metrics(piece.text, piece.face, piece.letterSpacingEm) : null;
    events.push(...pieceEvents(piece, metrics, options));
  }
  return events.map((event, index) => ({ event, index })).sort((a, b) => a.event.layer - b.event.layer || a.index - b.index).map(({ event }) => event);
}

/** Scene Style layers of a target as ASS events; the program is built from HarfBuzz measurement. */
export function renderCaptionScene(input: {
  readonly layers: readonly CompositionCaptionVisualLayer[];
  readonly canvas: { width: number; height: number };
  readonly report: SceneGlyphReport;
  readonly forcedOmissions: ReadonlySet<number>;
  readonly fps?: number;
}): { events: AssEvent[]; scene: CaptionScene; measurer: SceneMeasurer } {
  const language = input.layers[0]?.language ?? null;
  const measurer = new SceneMeasurer(input.report, input.forcedOmissions, language);
  const { name, input: sceneInput } = sceneInputForLayers(input.layers, input.canvas, measurer.measure);
  const scene = buildCaptionScene(name, sceneInput);
  return { events: sceneEvents(scene, measurer, { canvas: input.canvas, ...(input.fps ? { fps: input.fps } : {}) }), scene, measurer };
}
