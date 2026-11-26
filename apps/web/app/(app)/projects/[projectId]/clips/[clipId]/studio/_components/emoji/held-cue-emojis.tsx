"use client";

import { memo } from "react";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import type { CaptionTimeSource } from "../caption-block-painter";
import { CueEmojiLayer } from "./cue-caption-emojis";
import { heldEmojiCues } from "./held-cue-boxes";

/**
 * The emojis of classic and Dynamic cues that have just ended, drawn from the input each was placed
 * from while on screen (so they stay where they were, and the layer built then paints at once): an
 * emoji whose word ended its cue holds past the cue's end and leaves, in the export too. Mounted
 * beside the caption overlay, which shows only the cue under the playhead.
 */
export const HeldCueEmojis = memo(function HeldCueEmojis({ layers, timeSec, previewWidth, timeSource, fps }: {
  readonly layers: readonly CompositionCaptionVisualLayer[];
  readonly timeSec: number;
  /** The preview's width, display px. */
  readonly previewWidth: number;
  readonly timeSource: CaptionTimeSource;
  readonly fps: number;
}) {
  const held = heldEmojiCues(layers, timeSec);
  if (held.length === 0 || previewWidth <= 0) return null;
  return held.map(({ layer, input }) => (
    <CueEmojiLayer key={layer.id} layer={layer} input={input} scale={previewWidth / layer.destination.width} timeSource={timeSource} fps={fps} />
  ));
});
