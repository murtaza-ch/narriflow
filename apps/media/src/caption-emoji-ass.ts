import { type CaptionEmojiArt, loadCaptionEmojiArt } from "@narriflow/caption-emoji/art";
import {
  type CaptionEmojiCueBox,
  type CaptionEmojiOutcome,
  captionEmojiLayerEmojis,
  captionEmojiLayerStyle,
  captionEmojiNextAtMs,
  placeCaptionEmojis,
} from "@narriflow/caption-scene";
import type { ClipCompositionPlan, CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import type { AssEvent } from "./ass-format";
import { SceneMeasurer, sceneEvents } from "./caption-scene-ass";

/**
 * The emoji layer of a caption target's burn-in (spec D3 to D5): the shared builder
 * (`@narriflow/caption-scene` emoji) places each plan emoji next to its cue's box and returns
 * ordinary shape pieces, which the Scene writer (`sceneEvents`) turns into `\p1` drawings. The
 * three caption paths differ only in how a cue box is found: caption-ass.ts calls the shared
 * helper for the path it drew (`classicLineCueBox`, `captionBlockCueBox`,
 * `captionSceneEmojiCueBoxes`) with its own measurements. The style, the emojis and every default
 * come from the shared derivation (`captionEmojiLayerStyle`, `captionEmojiLayerEmojis`), as in the
 * Studio.
 *
 * Emoji pieces sit at `CAPTION_EMOJI_Z`, so their events land on ASS layers above every caption
 * event of the target; logo and transition stages come after the caption stage in the filter
 * graph and stay above them. An emoji with no art or no room is left out, never an error: the
 * track counts what was dropped and why.
 */

export type CaptionEmojiArtMap = ReadonlyMap<string, CaptionEmojiArt>;

/** What became of a target's emojis: how many were drawn, how many left out by reason. */
export interface CaptionEmojiLayerSummary {
  readonly placed: number;
  readonly dropped: Readonly<Partial<Record<Extract<CaptionEmojiOutcome, { placed: false }>["reason"], number>>>;
}

export const NO_CAPTION_EMOJIS: CaptionEmojiLayerSummary = Object.freeze({ placed: 0, dropped: Object.freeze({}) });

/** The art every caption emoji of a plan draws, loaded once before the synchronous build. */
export function loadPlanCaptionEmojiArt(plan: ClipCompositionPlan): Promise<Map<string, CaptionEmojiArt>> {
  const ids = new Set<string>();
  for (const target of plan.targets) {
    for (const layer of target.visualLayers) if (layer.kind === "caption") for (const emoji of layer.emojis) ids.add(emoji.id);
  }
  return ids.size === 0 ? Promise.resolve(new Map()) : loadCaptionEmojiArt(ids);
}

/** A target draws emojis when any of its caption layers carries one (the plan leaves them empty when the switch is off). */
export function hasCaptionEmojis(layers: readonly CompositionCaptionVisualLayer[]): boolean {
  return layers.some((layer) => layer.emojis.length > 0);
}

/**
 * Emojis placed together, with the function that finds their cue boxes: a Scene Style's cues (one
 * scene), or one classic line or Caption Block (its box, then the next cue's as a held emoji sees it).
 * The Studio builds one layer per such group (it draws a classic or Dynamic cue alone, and a Scene
 * Style's cues as one scene), so the export places them the same way and the two put every emoji at
 * the same place.
 */
export interface CaptionEmojiGroup {
  readonly layers: readonly CompositionCaptionVisualLayer[];
  readonly cueBoxes: () => readonly CaptionEmojiCueBox[];
}

/** Measures nothing: emoji pieces are shapes, so the Scene writer never asks it for text. */
const SHAPES_ONLY = new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), null);

/**
 * The emoji layer's events for one caption target. Each group is placed with its first layer's
 * style and anchor height (auto places below a caption in the top 30%): a target's layers share its
 * preset, and a Scene Style is built at its first layer's anchor (`sceneInputForLayers`). `fps` is
 * the render's rate: the scene was planned for it, and placement and the writer use its frame grid,
 * as the Studio does with the clip's `renderFrameRate`.
 *
 * Cue boxes are found here, inside the layer's own guard: an emoji problem (a cue box, placement or
 * the writer that throws) logs `caption_emoji_layer_failed` once and draws no emoji. It never
 * changes the captions or fails the render. `layers` are the target's caption layers: a group's held
 * emojis yield to the first emoji of a cue after it (`captionEmojiNextAtMs`), as in the Studio.
 */
export function captionEmojiEvents(input: {
  readonly groups: readonly CaptionEmojiGroup[];
  readonly layers: readonly CompositionCaptionVisualLayer[];
  readonly art: CaptionEmojiArtMap;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly fps?: number;
  /** Where the target ends, clip ms (the plan's edited duration): no emoji shows past it (`CaptionEmojiLayerInput.endMs`). */
  readonly endMs?: number;
}): { readonly events: AssEvent[]; readonly summary: CaptionEmojiLayerSummary } {
  try {
    const outcomes = input.groups.flatMap((group) => {
      const first = group.layers[0];
      const emojis = captionEmojiLayerEmojis(group.layers);
      if (!first || emojis.length === 0) return [];
      const nextEmojiAtMs = captionEmojiNextAtMs(input.layers, Math.max(...group.layers.map((layer) => layer.cueIndex)));
      return placeCaptionEmojis({
        cueBoxes: group.cueBoxes(),
        emojis,
        art: input.art,
        style: captionEmojiLayerStyle(first.preset),
        canvas: input.canvas,
        anchorYPct: first.anchor.yPct,
        ...(nextEmojiAtMs === undefined ? {} : { nextEmojiAtMs }),
        ...(input.fps ? { fps: input.fps } : {}),
        ...(input.endMs === undefined ? {} : { endMs: input.endMs }),
      });
    });
    if (outcomes.length === 0) return { events: [], summary: NO_CAPTION_EMOJIS };
    const pieces = outcomes.flatMap((outcome) => (outcome.placed ? outcome.pieces : []));
    const dropped: Partial<Record<Extract<CaptionEmojiOutcome, { placed: false }>["reason"], number>> = {};
    for (const outcome of outcomes) if (!outcome.placed) dropped[outcome.reason] = (dropped[outcome.reason] ?? 0) + 1;
    const events = pieces.length === 0 ? [] : sceneEvents({ pieces }, SHAPES_ONLY, { canvas: input.canvas, ...(input.fps ? { fps: input.fps } : {}) });
    return { events, summary: { placed: outcomes.length - Object.values(dropped).reduce((sum, count) => sum + count, 0), dropped } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ level: "warn", message: "caption_emoji_layer_failed", error: message }));
    return { events: [], summary: NO_CAPTION_EMOJIS };
  }
}
