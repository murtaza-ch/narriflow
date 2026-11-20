import { captionWordSegmentEnd, type CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import type { CaptionCueWord } from "./caption-style-engine";

/**
 * Readers of the composition plan's caption layers. The plan is the one cue
 * derivation (spec section 7): the on-video overlay and the Captions panel
 * preview both pick their cue here instead of grouping words themselves.
 */

/** The caption layer on screen at `timeSec` (edited time), as the preview adapter selects it. */
export function captionLayerAt(
  layers: readonly CompositionCaptionVisualLayer[],
  timeSec: number,
): CompositionCaptionVisualLayer | null {
  return layers.find((layer) => timeSec >= layer.activeRange.startSec && timeSec < layer.activeRange.endSec) ?? null;
}

/**
 * The classic caption line among the layers live at one time: a caption layer without scene facts. For a Dynamic or classic
 * preset that is its one cue; for a Scene Style it is an untimed utterance, which the worker burns as the classic line
 * while the scene draws the timed cues (`isSceneLayer`), so the Studio draws it too.
 */
export function classicCaptionLayerOf(layers: readonly { readonly kind: string }[]): CompositionCaptionVisualLayer | undefined {
  return layers.find((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption" && (layer as CompositionCaptionVisualLayer).scene === undefined);
}

/** Index of the word active at `timeSec`, or -1: the classic engine's active-word state. */
export function captionActiveWordIndex(layer: Pick<CompositionCaptionVisualLayer, "words">, timeSec: number): number {
  return layer.words.findIndex(
    (word, index) =>
      timeSec >= word.startSec &&
      (timeSec < word.endSec || (index === layer.words.length - 1 && timeSec <= word.endSec)),
  );
}

/** A classic caption layer's words for `CaptionCue` at `timeSec`. */
export function captionCueWordsAt(layer: Pick<CompositionCaptionVisualLayer, "words">, timeSec: number): CaptionCueWord[] {
  const active = captionActiveWordIndex(layer, timeSec);
  return layer.words.map((word, index) => ({
    word: word.text,
    emoji: word.emoji,
    ...(word.spaceBefore === undefined ? {} : { spaceBefore: word.spaceBefore }),
    durationMs: Math.max(50, Math.round((word.endSec - word.startSec) * 1000)),
    // The export's own window for this word's emoji: through the next word's start.
    emojiWindow: { startSec: word.startSec, endSec: captionWordSegmentEnd(layer.words, index) },
    isActive: index === active,
  }));
}

/** Where a Caption Block is drawn and stored, for dragging it on the canvas. */
export interface CaptionBlockPlacement {
  /** The stored anchor: block centre, or the left edge for a left style (right edge, mirrored, for RTL). */
  readonly anchor: { readonly xPct: number; readonly yPct: number };
  /** The layout's safe-area shift, canvas px. */
  readonly shift: { readonly x: number; readonly y: number };
  readonly canvas: { readonly width: number; readonly height: number };
  /** A left style drawing an RTL cue: its anchor is the right edge, at `100 − xPct`. */
  readonly mirrored: boolean;
}

/**
 * The point a drag moves, in frame percent: the drawn block's centre, or its
 * left (mirrored: right) edge, including the safe-area shift.
 */
export function captionBlockDragPoint(placement: CaptionBlockPlacement): { xPct: number; yPct: number } {
  const edge = placement.mirrored ? 100 - placement.anchor.xPct : placement.anchor.xPct;
  return {
    xPct: edge + (placement.shift.x / placement.canvas.width) * 100,
    yPct: placement.anchor.yPct + (placement.shift.y / placement.canvas.height) * 100,
  };
}

/**
 * The stored position for a block dropped with its drag point at `point`:
 * where the user put it. Rendering shifts it again only if that place is
 * outside the safe area; the stored value never includes the shift.
 */
export function captionBlockDroppedPosition(
  point: { readonly xPct: number; readonly yPct: number },
  mirrored: boolean,
): { positionX: number; positionY: number } {
  const xPct = Math.max(0, Math.min(100, point.xPct));
  return { positionX: mirrored ? 100 - xPct : xPct, positionY: Math.max(0, Math.min(100, point.yPct)) };
}
