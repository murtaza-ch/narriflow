import { CAPTION_EMOJI_LATE_HOLD_MS, type CaptionEmojiCueBox, captionEmojiNextAtMs } from "@narriflow/caption-scene";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";

// A classic or Dynamic cue's emoji may hold past the cue's end (its word ended the cue: the emoji
// layer's `CAPTION_EMOJI_LATE_HOLD_MS`), but the Studio mounts one cue's line, and its emojis, at a
// time. Each mounted cue leaves what its emoji layer was placed from here, by plan layer, so
// `HeldCueEmojis` keeps drawing the cue's emojis from the same input after the next cue takes the
// screen: the same placement, so the held emoji does not move.

/** What a one-cue emoji layer is placed from besides the cue's own emojis and style. */
export interface OneCueEmojiInput {
  /** The cue's own box, then the next cue's as a held emoji sees it (`classicLineReachBox`, or the next block's box). */
  readonly boxes: readonly CaptionEmojiCueBox[];
  /** Where the cue's held emojis yield: the first emoji of a later cue (`captionEmojiNextAtMs`). */
  readonly nextEmojiAtMs: number | undefined;
}

/** What a one-cue emoji layer needs of the cues after it: the next cue (its box) and the first later emoji's time. */
export interface EmojiFollowingCue {
  readonly layer: CompositionCaptionVisualLayer | null;
  readonly emojiAtMs: number | undefined;
}

export const NO_FOLLOWING_CUE: EmojiFollowingCue = Object.freeze({ layer: null, emojiAtMs: undefined });

/** The cue after `layer` among the target's caption layers, and where its held emojis yield; as the export reads them. */
export function emojiFollowingCue(layers: readonly CompositionCaptionVisualLayer[], layer: CompositionCaptionVisualLayer): EmojiFollowingCue {
  if (layer.emojis.length === 0) return NO_FOLLOWING_CUE;
  return { layer: layers.find((other) => other.cueIndex === layer.cueIndex + 1) ?? null, emojiAtMs: captionEmojiNextAtMs(layers, layer.cueIndex) };
}

const inputs = new WeakMap<CompositionCaptionVisualLayer, OneCueEmojiInput>();

export function rememberHeldCue(layer: CompositionCaptionVisualLayer, input: OneCueEmojiInput): void {
  inputs.set(layer, input);
}

/**
 * The classic and Dynamic cues whose emojis may still show at `timeSec` though the cue has ended,
 * each with the input it was drawn from. A cue never drawn in this session is left out.
 */
export function heldEmojiCues(
  layers: readonly CompositionCaptionVisualLayer[],
  timeSec: number,
): { readonly layer: CompositionCaptionVisualLayer; readonly input: OneCueEmojiInput }[] {
  return layers.flatMap((layer) => {
    if (layer.scene !== undefined || layer.emojis.length === 0) return [];
    const endSec = layer.activeRange.endSec;
    if (timeSec < endSec || timeSec >= endSec + CAPTION_EMOJI_LATE_HOLD_MS / 1000) return [];
    const input = inputs.get(layer);
    return input ? [{ layer, input }] : [];
  });
}
