"use client";

import { memo } from "react";
import { Box } from "@chakra-ui/react";
import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { CAPTION_EMOJI_BOX, resolveCaptionEmojiColour, type CaptionEmojiPalette } from "@narriflow/caption-emoji/draw";
import { useCaptionEmojiArt } from "./use-caption-emoji-art";

/**
 * How a clip draws its emojis in the Studio's controls: its palette, and the Skin tone (the
 * preset's `emojiTone`) an emoji with no tone of its own takes, as the plan draws it
 * (`captionEmojiDrawnTone`). Controls pass it through as the palette, so every chip and the picker
 * draw the same tone the video does.
 */
export type CaptionEmojiLook = CaptionEmojiPalette & { readonly tone?: number };

const VIEW_BOX = `${CAPTION_EMOJI_BOX.x} ${CAPTION_EMOJI_BOX.y} ${CAPTION_EMOJI_BOX.width} ${CAPTION_EMOJI_BOX.height}`;

/**
 * One design drawn from its compiled layers in a palette and tone, over its white sticker outline
 * so ink edges stay readable on the Studio's graphite. Never the system emoji font.
 */
export const EmojiArtSvg = memo(function EmojiArtSvg({ art, palette, tone = 0, size }: { art: CaptionEmojiArt; palette: CaptionEmojiPalette; tone?: number; size: number }) {
  return (
    <svg width={size} height={size} viewBox={VIEW_BOX} aria-hidden="true" focusable="false" style={{ display: "block", flexShrink: 0, overflow: "visible" }}>
      <path d={art.outline} fill="#ffffff" />
      {art.layers.map((layer, index) => {
        const fill = resolveCaptionEmojiColour(layer.colour, palette, tone);
        return fill === null ? null : <path key={index} d={layer.d} fill={fill} fillOpacity={layer.alpha} />;
      })}
    </svg>
  );
});

const HEX = /^#[0-9a-f]{6}$/i;
const markupCache = new WeakMap<CaptionEmojiArt, Map<string, string>>();

/**
 * The same drawing as `EmojiArtSvg` as SVG markup, cached per design, palette and tone. The picker's
 * grid mounts a few hundred glyph elements per scroll or query; one string per cell keeps React's
 * share of that small. Path data is the compiled art; colours are checked to be plain hex.
 */
export function captionEmojiSvgMarkup(art: CaptionEmojiArt, palette: CaptionEmojiPalette, tone: number, size: number): string {
  const key = `${palette.a}${palette.b}${palette.c}${tone}:${size}`;
  let byKey = markupCache.get(art);
  if (!byKey) {
    byKey = new Map();
    markupCache.set(art, byKey);
  }
  let markup = byKey.get(key);
  if (markup === undefined) {
    const layers = art.layers
      .map((layer) => {
        const fill = resolveCaptionEmojiColour(layer.colour, palette, tone);
        if (fill === null || !HEX.test(fill)) return "";
        return `<path d="${layer.d}" fill="${fill}"${layer.alpha === undefined ? "" : ` fill-opacity="${Number(layer.alpha)}"`}/>`;
      })
      .join("");
    markup = `<svg width="${size}" height="${size}" viewBox="${VIEW_BOX}" aria-hidden="true" focusable="false" style="display:block;flex-shrink:0;overflow:visible"><path d="${art.outline}" fill="#ffffff"/>${layers}</svg>`;
    byKey.set(key, markup);
  }
  return markup;
}

/** An empty box the glyph's size while its art loads: nothing drawn (never a placeholder disc), the layout kept. */
export function EmojiGlyphSpace({ size }: { size: number }) {
  return <Box w={`${size}px`} h={`${size}px`} flexShrink={0} aria-hidden />;
}

/**
 * Loads one design's art (session cache, its shard only) and draws it; an empty box until it
 * arrives. `tone` is the stored emoji's own; without it the emoji takes the look's Skin tone.
 */
export function EmojiGlyph({ id, tone, palette, size }: { id: string; tone?: number; palette: CaptionEmojiLook; size: number }) {
  const { art } = useCaptionEmojiArt([id]);
  const entry = art.get(id);
  return entry ? <EmojiArtSvg art={entry} palette={palette} tone={tone ?? palette.tone ?? 0} size={size} /> : <EmojiGlyphSpace size={size} />;
}
