import {
  CAPTION_EMPHASIS_OVERRIDE_LIMIT,
  CAPTION_MOTIONS,
  captionBlockAnimation,
  captionDynamicStyle,
  isDynamicOnlyMotion,
  type CaptionAnimation,
  type CaptionDynamicStyle,
  type CaptionEmphasisOverride,
  type CaptionPreset,
} from "@narriflow/validators";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import type { CaptionEmphasisChange } from "../studio-shell";

// Pure decisions behind the Captions panel's Customize tab (spec section 7):
// which motions a preset may pick, and the Emphasis row for the cue under the
// playhead.

/** The Dynamic Style of `preset`, or null for a classic preset. */
export function captionPanelStyle(preset: Pick<CaptionPreset, "dynamic">): CaptionDynamicStyle | null {
  return preset.dynamic ? captionDynamicStyle(preset.dynamic) : null;
}

/**
 * Motions the Animation picker lists. A Dynamic Style lists the word-reveal
 * motions a block can enter with (no renderer effect, no jelly), including the
 * dynamic-only ones. A classic preset never lists a dynamic-only motion.
 */
export function captionPanelAnimations(style: CaptionDynamicStyle | null): CaptionAnimation[] {
  const ids = Object.keys(CAPTION_MOTIONS) as CaptionAnimation[];
  return style
    ? ids.filter((id) => captionBlockAnimation({ animation: id }, style) === id)
    : ids.filter((id) => !isDynamicOnlyMotion(CAPTION_MOTIONS[id]));
}

/** "auto": no override in the cue; "none": every word is plain; "custom": a chosen hero. */
export type CaptionEmphasisMode = "auto" | "none" | "custom";

export interface CaptionEmphasisChip {
  /** Indices into the layer's words: one word, or two for a joined hero. */
  readonly indices: readonly number[];
  readonly text: string;
  readonly hero: boolean;
}

export interface CaptionEmphasisRow {
  /** One chip per word; a 2-word hero is one chip. */
  readonly chips: readonly CaptionEmphasisChip[];
  /** False for dub captions (no Word Keys): they use automatic emphasis only. */
  readonly editable: boolean;
  readonly mode: CaptionEmphasisMode;
  /** The hero is one word with a next word in the cue, so "Join next" can pair them. */
  readonly canJoin: boolean;
  /** The hero spans two words. */
  readonly joined: boolean;
}

type EmphasisLayer = Pick<CompositionCaptionVisualLayer, "block" | "words">;

function heroSpan(roles: readonly string[]): readonly [number, number] | null {
  const first = roles.indexOf("hero");
  return first < 0 ? null : [first, roles.lastIndexOf("hero")];
}

/** The Emphasis row for a block cue, or null when the layer is not a block. */
export function captionEmphasisRow(
  layer: EmphasisLayer,
  overrides: Readonly<Record<string, CaptionEmphasisOverride>> | undefined,
): CaptionEmphasisRow | null {
  const block = layer.block;
  if (!block || block.texts.length === 0) return null;
  const span = heroSpan(block.roles);
  const chips: CaptionEmphasisChip[] = [];
  for (let index = 0; index < block.texts.length; index++) {
    if (span && index === span[0] && span[1] > span[0]) {
      chips.push({ indices: [span[0], span[1]], text: `${block.texts[span[0]]} ${block.texts[span[1]]}`, hero: true });
      index = span[1];
      continue;
    }
    chips.push({ indices: [index], text: block.texts[index]!, hero: span !== null && index === span[0] });
  }
  const keys = cueKeys(layer);
  const editable = keys.length === block.keys.length && keys.length > 0;
  const values = keys.map((key) => overrides?.[key]);
  const mode: CaptionEmphasisMode = values.every((value) => value === undefined)
    ? "auto"
    : values.every((value) => value === "plain")
      ? "none"
      : "custom";
  const joined = span !== null && span[1] > span[0];
  return {
    chips,
    editable,
    mode,
    joined,
    canJoin: editable && span !== null && !joined && span[0] < block.texts.length - 1,
  };
}

/** The cue's distinct Word Keys (none for dub captions). */
function cueKeys(layer: EmphasisLayer): string[] {
  const keys = layer.block?.keys ?? [];
  return [...new Set(keys.filter((key): key is string => key !== null))];
}

export type CaptionEmphasisIntent =
  | { readonly kind: "hero"; readonly index: number }
  | { readonly kind: "join" }
  | { readonly kind: "unjoin" }
  | { readonly kind: "none" }
  | { readonly kind: "auto" };

/**
 * The `setCaptionEmphasis` actions for one gesture on a cue. A hero pick
 * clears the cue's other overrides first: with two overridden heroes the
 * scorer keeps the higher-scoring one, not the latest tap.
 */
export function captionEmphasisChanges(layer: EmphasisLayer, intent: CaptionEmphasisIntent): CaptionEmphasisChange[] {
  const block = layer.block;
  const keys = cueKeys(layer);
  if (!block || keys.length === 0 || keys.length !== block.keys.length) return [];
  const clear: CaptionEmphasisChange = { keys, value: null };
  const span = heroSpan(block.roles);
  const pick = (index: number, value: CaptionEmphasisOverride): CaptionEmphasisChange[] => {
    const key = block.keys[index];
    return key ? [clear, { keys: [key], value }] : [];
  };
  switch (intent.kind) {
    case "hero":
      return pick(intent.index, "hero");
    case "join":
      return span ? pick(span[0], "pair") : [];
    case "unjoin":
      return span ? pick(span[0], "hero") : [];
    case "none":
      return [{ keys, value: "plain" }];
    case "auto":
      return [clear];
  }
}

/** False when the changes would take the clip past the override cap (the editor refuses them). */
export function captionEmphasisFits(
  overrides: Readonly<Record<string, CaptionEmphasisOverride>> | undefined,
  changes: readonly CaptionEmphasisChange[],
): boolean {
  const next = new Set(Object.keys(overrides ?? {}));
  for (const change of changes) {
    for (const key of change.keys) {
      if (change.value === null) next.delete(key);
      else next.add(key);
    }
  }
  return next.size <= CAPTION_EMPHASIS_OVERRIDE_LIMIT;
}
