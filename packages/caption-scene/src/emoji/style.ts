import {
  type CaptionPreset,
  captionEmojiTemplateColours,
  captionSceneEmojiSlot,
  captionTextDirection,
  languageDirection,
  resolveCaptionEmojiPalette,
} from "@narriflow/validators";
import type { CaptionEmojiLayerEmoji, CaptionEmojiLayerStyle } from "./layer";

/**
 * What the emoji layer reads of a caption preset and its plan layers, for the Studio and the export
 * alike: one derivation, so the two renderers place and colour the same emojis.
 */

/** The layer's style from the preset, for every preset kind (a Scene Style drawn as a classic line keeps its slot). */
export function captionEmojiLayerStyle(
  preset: Pick<CaptionPreset, "scene" | "dynamic" | "primaryColor" | "highlightColor" | "accentColor" | "shadowColor" | "emojiPalette" | "emojiSize" | "emojiPosition" | "emojiSticker">,
): CaptionEmojiLayerStyle {
  const colours = captionEmojiTemplateColours(preset);
  return {
    palette: resolveCaptionEmojiPalette(preset, colours),
    size: preset.emojiSize ?? 1,
    position: preset.emojiPosition ?? "auto",
    sticker: preset.emojiSticker !== false,
    shadowColour: colours.shadow,
    slot: preset.scene ? captionSceneEmojiSlot(preset.scene) : "above",
  };
}

/** The plan's emojis of a target's caption layers (all, or one cue's), with their cue, clip ms (edited time, as cue boxes are) and order. */
export function captionEmojiLayerEmojis(
  layers: readonly { readonly cueIndex: number; readonly emojis: readonly { readonly id: string; readonly tone?: number; readonly atSec: number; readonly order: number }[] }[],
): CaptionEmojiLayerEmoji[] {
  return layers.flatMap((layer) =>
    layer.emojis.map((emoji) => ({ cueIndex: layer.cueIndex, id: emoji.id, ...(emoji.tone === undefined ? {} : { tone: emoji.tone }), atMs: emoji.atSec * 1000, order: emoji.order })),
  );
}

/**
 * When the first emoji of a cue after `cueIndex` starts, clip ms (its word's edited time, as in
 * `captionEmojiLayerEmojis`), or undefined: the `nextEmojiAtMs` of a one-cue emoji layer, which a held
 * emoji of that cue yields to. `layers` are the target's caption layers.
 */
export function captionEmojiNextAtMs(layers: readonly { readonly cueIndex: number; readonly emojis: readonly { readonly atSec: number }[] }[], cueIndex: number): number | undefined {
  let next = Number.POSITIVE_INFINITY;
  for (const layer of layers) if (layer.cueIndex > cueIndex) for (const emoji of layer.emojis) next = Math.min(next, emoji.atSec * 1000);
  return Number.isFinite(next) ? next : undefined;
}

/** A cue's reading direction from its words and language, as the caption painters resolve the line. */
export function captionEmojiCueDirection(words: readonly { readonly text: string }[], language: string | null): "ltr" | "rtl" {
  return captionTextDirection(words.map((word) => word.text).join(" "), language ? languageDirection(language) : undefined);
}
