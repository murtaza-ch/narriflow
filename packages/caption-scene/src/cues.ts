import type { SceneCue } from "./input";

/** How long a cue stays after its last word when nothing follows within that time, ms. */
export const SCENE_CUE_TAIL_MS = 650;

/** The least a cue stays after its last word starts when the next cue starts earlier (overlapping speakers), ms. */
export const SCENE_CUE_MIN_LAST_WORD_MS = 100;

/** The part of a plan caption layer a scene reads (structural, so this package never imports the plan). */
export interface SceneLayerLike {
  readonly activeRange: { readonly startSec: number; readonly endSec: number };
  readonly cueIndex: number;
  readonly language: string | null;
  readonly words: readonly { readonly text: string; readonly startSec: number; readonly endSec: number }[];
  /** Present only for a Scene Style preset's layers. */
  readonly scene?: {
    readonly roles: readonly ("hero" | "body" | "minor")[];
    readonly keys: readonly (string | null)[];
    readonly speaker: number | null;
  };
}

/**
 * The cues a scene is built from: a caption target's layers, in order. A cue leaves when the next
 * one starts, or a short tail after its last word when the pause before the next one is longer
 * (a long pause is not captioned with a frozen cue). When the next cue starts before this one's last
 * word ends (overlapping speakers), this one still leaves at the next start, so its exit is over
 * before the next cue enters; it never leaves before its own last word has started and read for
 * `SCENE_CUE_MIN_LAST_WORD_MS`.
 */
export function sceneCuesFromLayers(layers: readonly SceneLayerLike[]): SceneCue[] {
  const sorted = [...layers].sort((a, b) => a.activeRange.startSec - b.activeRange.startSec);
  return sorted.map((layer, at) => {
    const next = sorted[at + 1];
    const startMs = layer.activeRange.startSec * 1000;
    const lastEndMs = layer.activeRange.endSec * 1000;
    const tailEndMs = lastEndMs + SCENE_CUE_TAIL_MS;
    const nextStartMs = next ? next.activeRange.startSec * 1000 : Number.POSITIVE_INFINITY;
    const lastWordStartMs = layer.words.length > 0 ? layer.words[layer.words.length - 1]!.startSec * 1000 : startMs;
    const earliestEndMs = Math.min(lastEndMs, Math.max(startMs, lastWordStartMs) + SCENE_CUE_MIN_LAST_WORD_MS);
    return {
      index: layer.cueIndex,
      startMs,
      endMs: Math.max(earliestEndMs, Math.min(tailEndMs, nextStartMs)),
      speaker: layer.scene?.speaker ?? null,
      language: layer.language,
      words: layer.words.map((word, index) => ({
        text: word.text,
        startMs: word.startSec * 1000,
        endMs: word.endSec * 1000,
        role: layer.scene?.roles[index] ?? "body",
        key: layer.scene?.keys[index] ?? null,
      })),
    };
  });
}
