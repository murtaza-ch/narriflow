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
