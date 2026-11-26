"use client";

import { type MotionValue, motion } from "framer-motion";
import { memo, useEffect, useMemo } from "react";
import { type CaptionEmojiCueBox, captionEmojiLayerEmojis, captionEmojiLayerStyle, classicLineReachBox } from "@narriflow/caption-scene";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { type CaptionPreset, captionFontFace } from "@narriflow/validators";
import { useBrandFont } from "@/app/(app)/brand-kit/_components/brand-fonts";
import { CAPTION_FACE_OWN_SCRIPTS } from "@/app/caption-script-fonts";
import { type CaptionBlockCueInput, type CaptionBlockPaint, type CaptionTimeSource, useCaptionBlockPaint } from "../caption-block-painter";
import { PREVIEW_Z } from "../preview-stacking";
import { CaptionEmojiLayer, type CaptionEmojiCueSource } from "./caption-emoji-layer";
import { type ClassicLineFace, type ClassicLineSize, blockEmojiCueBox, classicLineBoxEm, classicLineEmojiCueBox, oneCueSourceKey } from "./cue-emoji-boxes";
import { type EmojiFollowingCue, NO_FOLLOWING_CUE, type OneCueEmojiInput, rememberHeldCue } from "./held-cue-boxes";

/**
 * The emojis of the one cue a classic line or a Caption Block draws. Each cue mounts its own line, so
 * the layer is built per cue, from the box measured when the cue (or the preview size) changed, and
 * the next cue's box as an emoji held over it sees it, as the export places it. The input is
 * remembered for `HeldCueEmojis`, which keeps drawing the cue's emojis after the cue ends.
 */

export interface OneCueProps {
  readonly layer: CompositionCaptionVisualLayer;
  /** Display px per canvas px. */
  readonly scale: number;
  readonly timeSource: CaptionTimeSource;
  /** The clip's render rate (`ClipInfo.renderFrameRate`): placement runs on the export's frame grid. */
  readonly fps?: number | undefined;
  /** The caption's drag offset, display px: the emojis move with the caption while it is dragged, with no React state per frame. */
  readonly dragOffset?: { readonly x: MotionValue<number>; readonly y: MotionValue<number> };
}

/** The cue on screen's props: and the cue after it, whose text and emoji a held emoji gives way to (`emojiFollowingCue`). */
export interface OnScreenCueProps extends OneCueProps {
  readonly following?: EmojiFollowingCue;
}

function useOneCueSource(boxes: readonly CaptionEmojiCueBox[] | null): CaptionEmojiCueSource | null {
  const key = boxes ? JSON.stringify(boxes.map(oneCueSourceKey)) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the boxes
  return useMemo(() => (boxes && key ? { key, cueBoxes: () => boxes } : null), [key]);
}

function OneCueEmojis({ layer, box, next, nextEmojiAtMs, ...props }: OneCueProps & { readonly box: CaptionEmojiCueBox | null; readonly next: CaptionEmojiCueBox | null; readonly nextEmojiAtMs: number | undefined }) {
  const key = box ? JSON.stringify([oneCueSourceKey(box), next ? oneCueSourceKey(next) : null]) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the boxes
  const input = useMemo((): OneCueEmojiInput | null => (box ? { boxes: next ? [box, next] : [box], nextEmojiAtMs } : null), [key, nextEmojiAtMs]);
  useEffect(() => {
    if (input) rememberHeldCue(layer, input);
  }, [layer, input]);
  return <CueEmojiLayer {...props} layer={layer} input={input} />;
}

/** One cue's emoji layer from its input: the cue on screen, or one `HeldCueEmojis` keeps after it ends. */
export function CueEmojiLayer({ layer, scale, timeSource, fps, dragOffset, input }: OneCueProps & { readonly input: OneCueEmojiInput | null }) {
  const source = useOneCueSource(input?.boxes ?? null);
  const emojis = useMemo(() => captionEmojiLayerEmojis([layer]), [layer]);
  const style = useMemo(() => captionEmojiLayerStyle(layer.preset), [layer.preset]);
  const { width, height } = layer.destination;
  const canvas = useMemo(() => ({ width, height }), [width, height]);
  if (emojis.length === 0) return null;
  return (
    <motion.div style={{ x: dragOffset?.x ?? 0, y: dragOffset?.y ?? 0, position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: PREVIEW_Z.captionEmoji, pointerEvents: "none" }}>
      <CaptionEmojiLayer source={source} emojis={emojis} style={style} canvas={canvas} anchorYPct={layer.anchor.yPct} fps={fps} nextEmojiAtMs={input?.nextEmojiAtMs} scale={scale} timeSource={timeSource} />
    </motion.div>
  );
}

/** The face that draws a classic line's letters, as `CaptionCue` resolves it: the brand font once loaded, else the catalog face. */
export function useClassicLineFace(preset: Pick<CaptionPreset, "fontName" | "fontAsset">): ClassicLineFace {
  const customFont = useBrandFont(preset.fontAsset);
  const face = customFont?.face ?? captionFontFace(preset.fontName);
  // A brand font's coverage is unknown: only its Latin counts as drawn (as in `CaptionCue`).
  const ownScripts = customFont ? undefined : CAPTION_FACE_OWN_SCRIPTS[preset.fontName];
  return useMemo(() => ({ ascent: face.ascent, descent: face.descent, ...(ownScripts ? { ownScripts } : {}) }), [face.ascent, face.descent, ownScripts]);
}

/**
 * A classic line's emojis; `line` is the width `CaptionCue` reported for this cue, null until it has.
 * The next line is not laid out yet: its box is the most it can cover (`classicLineReachBox`), the
 * one the export uses too.
 */
export const ClassicCaptionEmojis = memo(function ClassicCaptionEmojis({ line, following = NO_FOLLOWING_CUE, ...props }: OnScreenCueProps & { readonly line: ClassicLineSize | null }) {
  const face = useClassicLineFace(props.layer.preset);
  const box = line ? classicLineEmojiCueBox(props.layer, line, face) : null;
  const nextLayer = following.layer;
  const { width, height } = props.layer.destination;
  const next = nextLayer ? classicLineReachBox(nextLayer, classicLineBoxEm(nextLayer.words, face, nextLayer.language), { width, height }) : null;
  return <OneCueEmojis {...props} box={box} next={next} nextEmojiAtMs={following.emojiAtMs} />;
});

/**
 * A Caption Block's emojis, from the layout its painter drew, and the next block's from the same
 * painter's layout (it measures once its faces load: until then the emoji is placed without it).
 */
export const BlockCaptionEmojis = memo(function BlockCaptionEmojis({ paint, following = NO_FOLLOWING_CUE, ...props }: OnScreenCueProps & { readonly paint: CaptionBlockPaint }) {
  const box = useMemo(() => blockEmojiCueBox(paint, props.layer.cueIndex), [paint, props.layer.cueIndex]);
  const nextLayer = following.layer?.block ? following.layer : null;
  const { width, height } = props.layer.destination;
  const canvas = useMemo(() => ({ width, height }), [width, height]);
  const nextPaint = useCaptionBlockPaint(nextLayer as CaptionBlockCueInput | null, canvas);
  const next = useMemo(() => (nextPaint && nextLayer ? blockEmojiCueBox(nextPaint, nextLayer.cueIndex) : null), [nextPaint, nextLayer]);
  return <OneCueEmojis {...props} box={box} next={next} nextEmojiAtMs={following.emojiAtMs} />;
});
