"use client";

/**
 * The Studio's Scene Style painter (ADR 0021, spec 3.3).
 *
 * The shared program (`@narriflow/caption-scene`) builds the Caption Scene of a target's cues from
 * Canvas `measureText` once the scene's faces have loaded; this file only paints. Every piece is a
 * transformed container at its pivot holding its paint layers (shadows, then the fill and outline),
 * the layers the worker writes as ASS events. On each tick of the time source the pose comes from
 * `evaluatePiece`, the evaluator the worker's tags are written to agree with, and goes straight to
 * the elements' transform, opacity, filter, colour and clip: no React state per frame, so playback,
 * pause and scrubbing show what the export shows at that time.
 *
 * All colour values are USER caption colours (they feed the burn-in) and intentionally stay literal,
 * never theme tokens.
 */

import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  type CaptionScene,
  type Measure,
  type Piece,
  type PiecePose,
  type SceneCue,
  type ShapePiece,
  type TextMeasure,
  type TextPiece,
  SCENE_PERSPECTIVE_PX,
  buildCaptionScene,
  evaluatePiece,
  memoMeasure,
  pathToSvg,
  pieceIndexesBetween,
  sceneBoundsAt,
  sceneBuildKey,
  sceneInputFromPreset,
} from "@narriflow/caption-scene";
import { type CaptionFontName, type CaptionPreset, languageDirection, textDirection } from "@narriflow/validators";
import { CaptionText, hexToRgba } from "./caption-style-engine";
import {
  type CaptionTimeSource,
  type WordFace,
  baselineCache,
  baselineOffsetPx,
  facesLoaded,
  loadFaces,
  measureWord,
  probeBaselineOffsets,
  wordFace,
} from "./caption-block-painter";

// ─── Building the scene ──────────────────────────────────────────────────────

export interface CaptionSceneBuildInput {
  readonly preset: CaptionPreset;
  readonly cues: readonly SceneCue[];
  readonly canvas: { readonly width: number; readonly height: number };
  readonly anchor?: { readonly xPct: number; readonly yPct: number };
  readonly language: string | null;
}

/** A scene with the measurement that built it (the selection box and the painter read the same). */
export interface MeasuredScene {
  readonly scene: CaptionScene;
  readonly measure: Measure;
  readonly language: string | null;
}

type SceneResult =
  | { readonly status: "ready"; readonly built: MeasuredScene }
  | { readonly status: "pending"; readonly load: () => Promise<unknown> };

/**
 * Canvas `measureText` of scene text at 100 px, as `measureWord` does for Caption Blocks. A word whose faces have
 * loaded is cached (the browser-wide cache of `measureWord`); while faces are still loading (`wanted` collects them) the
 * answer comes from a fallback face and must not be remembered.
 */
export function canvasMeasure(language: string | null, wanted: Map<string, () => Promise<unknown>> | null): Measure {
  return (text, fontName, sizePx, letterSpacingEm): TextMeasure => {
    const face = wordFace("text", fontName, null, language);
    if (!face) return { advance: text.length * sizePx * 0.55, inkTop: -sizePx * 0.72, inkBottom: sizePx * 0.2, ascent: sizePx, descent: sizePx * 0.3 };
    const loaded = !wanted || facesLoaded(text, face, language);
    if (wanted && !loaded) wanted.set(`${fontName}\0${text}`, () => loadFaces(text, face, language));
    const direction = textDirection(text, languageDirection(language));
    const m = measureWord(text, face, letterSpacingEm, direction, language, loaded);
    return { advance: m.advanceEm * sizePx, inkTop: -m.inkTopEm * sizePx, inkBottom: m.inkBottomEm * sizePx, ascent: face.ascent * sizePx, descent: face.descent * sizePx };
  };
}

function buildScene(input: CaptionSceneBuildInput, force: boolean): SceneResult | null {
  const { preset } = input;
  if (!preset.scene || input.canvas.width <= 0 || input.canvas.height <= 0) return null;
  const wanted = force ? null : new Map<string, () => Promise<unknown>>();
  // Once the faces have loaded, one memo serves the build and then the selection box and the painter (every tick asks the
  // bounds of the live pieces, and each ask is a measurement).
  const measure = wanted ? canvasMeasure(input.language, wanted) : memoMeasure(canvasMeasure(input.language, null));
  const scene = buildCaptionScene(
    preset.scene,
    sceneInputFromPreset(preset, { cues: input.cues, canvas: input.canvas, measure, ...(input.anchor ? { anchor: input.anchor } : {}) }),
  );
  if (wanted && wanted.size > 0) return { status: "pending", load: () => Promise.all([...wanted.values()].map((load) => load())) };
  return { status: "ready", built: { scene, measure: wanted ? memoMeasure(canvasMeasure(input.language, null)) : measure, language: input.language } };
}

const unusedMeasure: Measure = () => {
  throw new Error("the build key never measures");
};

/**
 * What a scene is built from, as a string (`sceneBuildKey`): the cues, the canvas, the anchor, the colours and size the
 * template reads, the language. Null for a preset that is not a Scene Style. Two inputs with the same key build the same scene.
 */
export function captionSceneInputKey(input: CaptionSceneBuildInput): string | null {
  const { preset } = input;
  if (!preset.scene) return null;
  return sceneBuildKey(preset.scene, sceneInputFromPreset(preset, { cues: input.cues, canvas: input.canvas, measure: unusedMeasure, ...(input.anchor ? { anchor: input.anchor } : {}) }), input.language);
}

/**
 * Hands back the same input object while `key` stays the same. The editor derives new layer objects on every document
 * change (a volume, a logo drag); the scene is rebuilt only when what it is built from changes.
 */
export function stableByKey<T>(previous: { readonly key: string; readonly value: T } | null, key: string | null, value: T | null): { readonly key: string; readonly value: T } | null {
  if (key === null || value === null) return null;
  return previous?.key === key ? previous : { key, value };
}

const subscribeNothing = () => () => undefined;

/**
 * Builds the scene of `input`'s cues on its canvas, once its faces have loaded. Null until then (and
 * during server rendering and hydration). It changes only when what the scene is built from changes (its
 * content key: cues, canvas, anchor, colours, size, language) or a face loads, never per frame and never because the
 * editor handed over equal inputs in new objects.
 */
export function useCaptionScene(rawInput: CaptionSceneBuildInput | null): MeasuredScene | null {
  const client = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const stable = useRef<{ readonly key: string; readonly value: CaptionSceneBuildInput } | null>(null);
  stable.current = stableByKey(stable.current, rawInput ? captionSceneInputKey(rawInput) : null, rawInput);
  const input = stable.current?.value ?? null;
  const [settledFor, setSettledFor] = useState<CaptionSceneBuildInput | null>(null);
  const result = useMemo(() => (client && input ? buildScene(input, settledFor === input) : null), [client, input, settledFor]);
  useEffect(() => {
    if (result?.status !== "pending" || !input) return;
    let live = true;
    void result.load().catch(() => undefined).then(() => {
      if (live) setSettledFor(input);
    });
    return () => {
      live = false;
    };
  }, [result, input]);
  return result?.status === "ready" ? result.built : null;
}

/** A ready-made scene (a fixture) with its faces loaded: null until they have. For harnesses, not for plan cues. */
export function useFixtureScene(scene: CaptionScene): MeasuredScene | null {
  const client = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const loads = scene.pieces.flatMap((piece) => {
      if (piece.kind !== "text") return [];
      const face = wordFace("text", piece.face, null, null);
      return face ? [loadFaces(piece.text, face, null)] : [];
    });
    void Promise.all(loads).catch(() => undefined).then(() => {
      if (live) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [client, scene]);
  return useMemo(() => (loaded ? { scene, measure: canvasMeasure(null, null), language: null } : null), [loaded, scene]);
}

// ─── Painting ────────────────────────────────────────────────────────────────

/** One paint layer of a piece. */
interface LayerSpec {
  readonly kind: "shadow" | "main" | "stroke";
  readonly shadowIndex?: number;
  /** Opacity the layer has at piece opacity 1. */
  readonly alpha: number;
  /** The layer's own Gaussian sigma, canvas px. */
  readonly blur: number;
}

function layersOf(piece: Piece): LayerSpec[] {
  const layers: LayerSpec[] = (piece.shadows ?? []).map((shadow, shadowIndex) => ({ kind: "shadow", shadowIndex, alpha: shadow.alpha, blur: shadow.blur }));
  if (piece.kind === "shape") {
    if (piece.fill) layers.push({ kind: "main", alpha: piece.fill.alpha ?? 1, blur: 0 });
    if (piece.stroke) layers.push({ kind: "stroke", alpha: piece.stroke.alpha ?? 1, blur: 0 });
  } else layers.push({ kind: "main", alpha: 1, blur: 0 });
  return layers;
}

const px = (value: number) => `${Math.round(value * 1000) / 1000}px`;

/** The CSS transform of a pose about the pivot (the element's origin): the sample player's `pose()` order. */
export function sceneTransform(pose: Pick<PiecePose, "x" | "y" | "sx" | "sy" | "rz" | "rx" | "ry" | "skx">, scale: number): string {
  let transform = `translate(${px(pose.x * scale)}, ${px(pose.y * scale)})`;
  if (pose.rx !== 0 || pose.ry !== 0) transform += ` perspective(${px(SCENE_PERSPECTIVE_PX * scale)})`;
  if (pose.rx !== 0) transform += ` rotateX(${pose.rx}deg)`;
  if (pose.ry !== 0) transform += ` rotateY(${pose.ry}deg)`;
  if (pose.rz !== 0) transform += ` rotate(${pose.rz}deg)`;
  if (pose.skx !== 0) transform += ` skewX(${pose.skx}deg)`;
  if (pose.sx !== 1 || pose.sy !== 1) transform += ` scale(${pose.sx}, ${pose.sy})`;
  return transform;
}

/** `clip-path` of a clip rectangle in canvas px on a wrapper that covers the canvas at `scale`. */
export function sceneClipPath(clip: NonNullable<PiecePose["clip"]>, canvas: { width: number; height: number }, scale: number): string {
  const x1 = Math.min(clip.x1, clip.x2) * scale;
  const x2 = Math.max(clip.x1, clip.x2) * scale;
  const y1 = Math.min(clip.y1, clip.y2) * scale;
  const y2 = Math.max(clip.y1, clip.y2) * scale;
  if (!clip.inverse) return `inset(${px(y1)} ${px(canvas.width * scale - x2)} ${px(canvas.height * scale - y2)} ${px(x1)})`;
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  return `polygon(evenodd, 0 0, ${px(w)} 0, ${px(w)} ${px(h)}, 0 ${px(h)}, 0 0, ${px(x1)} ${px(y1)}, ${px(x2)} ${px(y1)}, ${px(x2)} ${px(y2)}, ${px(x1)} ${px(y2)}, ${px(x1)} ${px(y1)})`;
}

interface TextLayerProps {
  readonly piece: TextPiece;
  readonly layer: LayerSpec;
  readonly face: WordFace;
  readonly advance: number;
  readonly scale: number;
  readonly language: string | null;
  readonly direction: "ltr" | "rtl";
  readonly layerIndex: number;
}

/** One paint layer of a text piece, positioned from the pivot (the container's origin). */
function TextLayer({ piece, layer, face, advance, scale, language, direction, layerIndex }: TextLayerProps) {
  const origin = piece.origin ?? { dx: 0, dy: 0 };
  const fontPx = piece.sizePx * scale;
  const shadow = layer.kind === "shadow" ? piece.shadows![layer.shadowIndex!]! : null;
  const stroke = piece.stroke;
  // The anchor point relative to the pivot, then the span's top-left from the baseline.
  const baselineX = -origin.dx * scale - (piece.anchor === "baseline-center" ? (advance * scale) / 2 : 0) + (shadow ? shadow.dx * scale : 0);
  const baselineY = -origin.dy * scale + (shadow ? shadow.dy * scale : 0);
  const top = baselineY - (baselineOffsetPx(face, fontPx) ?? face.ascent * fontPx);
  const colour = shadow ? shadow.colour : piece.fill;
  const fillAlpha = piece.fillAlpha ?? 1;
  const strokeColour = shadow ? shadow.colour : stroke?.colour;
  const style: CSSProperties = {
    position: "absolute",
    left: px(baselineX),
    top: px(top),
    whiteSpace: "pre",
    lineHeight: face.ascent + face.descent,
    fontSize: px(fontPx),
    letterSpacing: `${piece.letterSpacingEm}em`,
    ...face.css,
    // The app's body sets `cv11` (single-storey a); libass draws the face's default glyphs.
    fontFeatureSettings: "normal",
    color: fillAlpha <= 0 ? "transparent" : fillAlpha < 1 ? hexToRgba(colour, fillAlpha) : colour,
    paintOrder: "stroke fill",
    pointerEvents: "none",
    ...(stroke && strokeColour ? { WebkitTextStroke: `${px(stroke.widthPx * 2 * scale)} ${hexToRgba(strokeColour, shadow ? 1 : (stroke.alpha ?? 1))}` } : {}),
  };
  return (
    <span aria-hidden data-scene-layer={layerIndex} dir={direction} lang={language ?? undefined} style={style}>
      <CaptionText text={piece.text} />
    </span>
  );
}

/**
 * Hollow text (`fillAlpha: 0`): the outline band outside the glyph only, as libass draws `\bord` around
 * transparent text. A centred stroke of twice the width, with the glyphs themselves masked out of it
 * (which also removes the stroke's overlaps inside a glyph), drawn as SVG text so the baseline is exact.
 */
function HollowTextLayer({ piece, layer, face, advance, scale, language, direction, layerIndex }: TextLayerProps) {
  const id = useId();
  const origin = piece.origin ?? { dx: 0, dy: 0 };
  const fontPx = piece.sizePx * scale;
  const stroke = piece.stroke!;
  const shadow = layer.kind === "shadow" ? piece.shadows![layer.shadowIndex!]! : null;
  const baselineX = -origin.dx * scale - (piece.anchor === "baseline-center" ? (advance * scale) / 2 : 0) + (shadow ? shadow.dx * scale : 0);
  const baselineY = -origin.dy * scale + (shadow ? shadow.dy * scale : 0);
  const colour = shadow ? shadow.colour : stroke.colour;
  const font: CSSProperties = {
    ...face.css,
    fontSize: px(fontPx),
    letterSpacing: `${piece.letterSpacingEm}em`,
    whiteSpace: "pre",
    fontFeatureSettings: "normal",
    direction,
  };
  // SVG text starts at its anchor and a right-to-left run starts at its right edge: put that edge at the end of the advance.
  const textX = direction === "rtl" ? advance * scale : 0;
  const reach = stroke.widthPx * 2 * scale + fontPx;
  const box = { x: -reach, y: -fontPx * 1.6 - reach, width: advance * scale + 2 * reach, height: fontPx * 2.6 + 2 * reach };
  return (
    <svg
      aria-hidden="true"
      data-scene-layer={layerIndex}
      width={1}
      height={1}
      // Chrome paints nothing for an SVG mask under an ancestor's `clip-path` (the wrapper's clip) unless the
      // masked layer is composited on its own: Hollow's clipped echoes vanished without this.
      style={{ position: "absolute", left: px(baselineX), top: px(baselineY), overflow: "visible", pointerEvents: "none", ...(piece.clip ? { willChange: "transform" } : {}) }}
    >
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" {...box}>
          <rect {...box} fill="white" />
          <text x={textX} y={0} fill="black" style={font} lang={language ?? undefined}>{piece.text}</text>
        </mask>
      </defs>
      <text x={textX} y={0} fill="none" stroke={colour} strokeWidth={stroke.widthPx * 2 * scale} strokeLinejoin="round" mask={`url(#${id})`} style={font} lang={language ?? undefined}>
        {piece.text}
      </text>
    </svg>
  );
}

function ShapeLayer({ piece, layer, scale, layerIndex }: { piece: ShapePiece; layer: LayerSpec; scale: number; layerIndex: number }) {
  const origin = piece.origin ?? { dx: 0, dy: 0 };
  const shadow = layer.kind === "shadow" ? piece.shadows![layer.shadowIndex!]! : null;
  // A shape's fill and its stroke are separate layers; a shadow follows the fill, or the stroke of a shape that has no fill.
  const stroking = layer.kind === "stroke" || (shadow !== null && !piece.fill && piece.stroke !== undefined);
  const colour = shadow ? shadow.colour : stroking ? piece.stroke!.colour : (piece.fill?.colour ?? "#FFFFFF");
  return (
    <svg
      aria-hidden="true"
      data-scene-layer={layerIndex}
      width={1}
      height={1}
      style={{ position: "absolute", left: px((-origin.dx + (shadow?.dx ?? 0)) * scale), top: px((-origin.dy + (shadow?.dy ?? 0)) * scale), overflow: "visible", pointerEvents: "none" }}
    >
      <g transform={`scale(${scale})`}>
        <path
          d={pathToSvg(piece.path)}
          fill={stroking ? "none" : colour}
          {...(stroking ? { stroke: colour, strokeWidth: piece.stroke!.widthPx, strokeLinecap: "round" as const, strokeLinejoin: "round" as const } : {})}
        />
      </g>
    </svg>
  );
}

interface PieceHandle {
  readonly piece: Piece;
  readonly wrapper: HTMLElement;
  readonly container: HTMLElement;
  readonly layers: readonly { readonly element: HTMLElement; readonly spec: LayerSpec }[];
  written: string;
}

export interface CaptionSceneLayersProps {
  readonly built: MeasuredScene;
  readonly canvas: { readonly width: number; readonly height: number };
  /** Display px per canvas px. */
  readonly scale: number;
  readonly timeSource: CaptionTimeSource;
}

// A 3-minute clip is thousands of pieces (Wordform: 5 300), almost all of them nowhere near the playhead. Only the pieces
// that touch a window around it have elements; the window moves in steps and is rebuilt at once when time leaves it (a seek,
// a scrub, a loop), so the frame at the playhead is always drawn in full.
const MOUNT_STEP_MS = 2000;
const MOUNT_BEHIND_MS = 2000;
const MOUNT_AHEAD_MS = 8000;

/** Start (ms) of the mounting window that `ms` falls in. */
export function mountWindowStart(ms: number): number {
  return Math.floor(ms / MOUNT_STEP_MS) * MOUNT_STEP_MS;
}

/**
 * Positions in `pieces` of the pieces mounted while the playhead is in the window that starts at `start`: every piece whose
 * visible window touches `[start - 2 s, start + 10 s)`, so every piece live at any time in `[start, start + 2 s)` is among them.
 */
export function mountedPieceIndexes(pieces: readonly Piece[], start: number): number[] {
  return pieceIndexesBetween(pieces, start - MOUNT_BEHIND_MS, start + MOUNT_STEP_MS + MOUNT_AHEAD_MS);
}

interface PieceViewProps {
  readonly piece: Piece;
  readonly index: number;
  readonly face: WordFace | undefined;
  readonly measure: Measure;
  readonly scale: number;
  readonly language: string | null;
  /** Counts the baseline probes: a piece draws from the probed baseline, so a new probe must re-render it despite the memo. */
  readonly probes: number;
}

/** One piece's elements. Memoised: a window step re-renders only the pieces that entered it. */
const PieceView = memo(function PieceView({ piece, index, face, measure, scale, language }: PieceViewProps) {
  const specs = layersOf(piece);
  const text = piece.kind === "text" ? piece : null;
  if (text && !face) return null;
  const advance = text ? measure(text.text, text.face, text.sizePx, text.letterSpacingEm).advance : 0;
  const direction = text ? textDirection(text.text, languageDirection(language)) : "ltr";
  let content: ReactNode;
  if (text) {
    const Layer = (text.fillAlpha ?? 1) <= 0 && text.stroke ? HollowTextLayer : TextLayer;
    content = specs.map((layer, at) => (
      <Layer key={at} piece={text} layer={layer} face={face!} advance={advance} scale={scale} language={language} direction={direction} layerIndex={at} />
    ));
  } else {
    content = specs.map((layer, at) => <ShapeLayer key={at} piece={piece as ShapePiece} layer={layer} scale={scale} layerIndex={at} />);
  }
  return (
    <div data-scene-piece={index} style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", visibility: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, transformOrigin: "0 0" }}>{content}</div>
    </div>
  );
});

/**
 * Draws a built scene over a box of the canvas's size at `scale`: one element per piece near the playhead, all
 * written from `timeSource` (seconds on the clip's edited timeline, as the plan's layers are). A tick looks only at
 * the mounted pieces, and evaluates only those whose window holds the time.
 */
export const CaptionSceneLayers = memo(function CaptionSceneLayers({ built, canvas, scale, timeSource }: CaptionSceneLayersProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [probes, setProbes] = useState(0);
  const [windowStart, setWindowStart] = useState(() => mountWindowStart(timeSource.getSnapshot() * 1000));
  const { scene, measure, language } = built;

  const faces = useMemo(() => {
    const map = new Map<CaptionFontName, WordFace>();
    for (const piece of scene.pieces) {
      if (piece.kind !== "text" || map.has(piece.face)) continue;
      const face = wordFace("text", piece.face, null, language);
      if (face) map.set(piece.face, face);
    }
    return map;
  }, [scene, language]);

  // The mounted pieces, in paint order (`z`, then array order, as the worker's ASS layers are).
  const mounted = useMemo(() => mountedPieceIndexes(scene.pieces, windowStart).sort((a, b) => scene.pieces[a]!.z - scene.pieces[b]!.z || a - b), [scene, windowStart]);

  useLayoutEffect(() => {
    // Every size a face is drawn at, once each: a piece that enters the window later finds its baseline already probed.
    const sizes = new Map<string, { face: WordFace; fontPx: number }>();
    for (const piece of scene.pieces) {
      if (piece.kind !== "text") continue;
      const face = faces.get(piece.face);
      if (face) sizes.set(`${piece.face}|${piece.sizePx}`, { face, fontPx: piece.sizePx * scale });
    }
    const requests = [...sizes.values()];
    if (probeBaselineOffsets(requests)) setProbes((count) => count + 1);
    // A face that loads after the probe (a script fallback) can move the baseline: probe again.
    const reprobe = () => {
      baselineCache.clear();
      probeBaselineOffsets(requests);
      setProbes((count) => count + 1);
    };
    document.fonts.addEventListener("loadingdone", reprobe);
    return () => document.fonts.removeEventListener("loadingdone", reprobe);
  }, [scene, scale, faces]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handles: PieceHandle[] = [];
    root.querySelectorAll<HTMLElement>("[data-scene-piece]").forEach((wrapper) => {
      const piece = scene.pieces[Number(wrapper.dataset.scenePiece)]!;
      const container = wrapper.firstElementChild as HTMLElement;
      const specs = layersOf(piece);
      const layers = [...container.querySelectorAll<HTMLElement>("[data-scene-layer]")].map((element) => ({ element, spec: specs[Number(element.dataset.sceneLayer)]! }));
      handles.push({ piece, wrapper, container, layers, written: "" });
    });
    const hide = (handle: PieceHandle) => {
      if (handle.written === "hidden") return;
      handle.wrapper.style.visibility = "hidden";
      handle.written = "hidden";
    };
    // `inEffect`: called by React (this layout effect), where a synchronous re-render is not allowed; from a tick it is, and the frame must not wait.
    const paint = (inEffect: boolean) => {
      const ms = timeSource.getSnapshot() * 1000;
      const wanted = mountWindowStart(ms);
      if (wanted !== windowStart) {
        if (inEffect) setWindowStart(wanted);
        else flushSync(() => setWindowStart(wanted));
        return;
      }
      for (const handle of handles) {
        const { piece } = handle;
        // Most mounted pieces are not live now: check the window before evaluating anything.
        if (ms < piece.fromMs || ms >= piece.toMs) {
          hide(handle);
          continue;
        }
        const pose = evaluatePiece(piece, ms);
        if (pose.o <= 0.002) {
          hide(handle);
          continue;
        }
        const transform = sceneTransform(pose, scale);
        const clip = pose.clip ? sceneClipPath(pose.clip, canvas, scale) : "";
        const key = `${transform}|${clip}|${pose.o}|${pose.blur}|${pose.colour}`;
        if (key === handle.written) continue;
        handle.written = key;
        handle.wrapper.style.visibility = "visible";
        handle.wrapper.style.clipPath = clip;
        handle.container.style.transform = transform;
        for (const { element, spec } of handle.layers) {
          element.style.opacity = String(Math.min(1, spec.alpha * pose.o));
          const sigma = Math.hypot(pose.blur, spec.blur) * scale;
          element.style.filter = sigma > 0.01 ? `blur(${sigma}px)` : "none";
          if (spec.kind === "main" && piece.kind === "text" && (piece.fillAlpha ?? 1) > 0) element.style.color = hexToRgba(pose.colour, piece.fillAlpha ?? 1);
          if (spec.kind === "main" && piece.kind === "shape") element.querySelector("path")?.setAttribute("fill", pose.colour);
        }
      }
    };
    paint(true);
    return timeSource.subscribe(() => paint(false));
  }, [scene, scale, canvas, timeSource, windowStart]);

  return (
    <div
      ref={rootRef}
      lang={language ?? undefined}
      style={{ position: "absolute", left: 0, top: 0, width: px(canvas.width * scale), height: px(canvas.height * scale), pointerEvents: "none", userSelect: "none" }}
    >
      {mounted.map((index) => {
        const piece = scene.pieces[index]!;
        return <PieceView key={piece.id} piece={piece} index={index} face={piece.kind === "text" ? faces.get(piece.face) : undefined} measure={measure} scale={scale} language={language} probes={probes} />;
      })}
    </div>
  );
});

// ─── Framed scenes ───────────────────────────────────────────────────────────

/** A scene over a frame whose top-left is canvas (0, 0): the parity harness and the preset thumbnails. */
export function CaptionSceneFrame({
  input,
  scale,
  timeSource,
  onBuilt,
}: {
  input: CaptionSceneBuildInput;
  /** Display px per canvas px. */
  scale: number;
  timeSource: CaptionTimeSource;
  onBuilt?: (built: MeasuredScene) => void;
}) {
  const built = useCaptionScene(input);
  useEffect(() => {
    if (built) onBuilt?.(built);
  }, [built, onBuilt]);
  if (!built) return null;
  return <CaptionSceneLayers built={built} canvas={input.canvas} scale={scale} timeSource={timeSource} />;
}

/** The box (canvas px) the selection frame and hit area cover at `ms`: what the scene draws then. */
export function captionSceneBoundsAt(built: MeasuredScene, ms: number) {
  return sceneBoundsAt(built.scene.pieces, ms, built.measure);
}
