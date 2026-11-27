"use client";

/**
 * The emoji layer above the captions (spec D3), one component for every preset kind. A caption path
 * hands it a cue source (Scene Styles: the built scene; Dynamic Styles: the block layout; classic:
 * the measured line); the layer loads the art, places the emojis with the shared builder
 * (`buildCaptionEmojiPieces`, the one the export calls) and paints the pieces with the Scene painter
 * from the playback clock, so only pieces near the playhead are mounted and no React state changes
 * per frame. It is never part of a template's scene: an emoji edit rebuilds this layer alone, and a
 * scene rebuild reuses the art already loaded.
 */

import { memo, useDeferredValue, useMemo, useRef } from "react";
import {
  type CaptionEmojiCueBox,
  type CaptionEmojiLayerEmoji,
  type CaptionEmojiLayerInput,
  type CaptionEmojiLayerStyle,
  type Measure,
  buildCaptionEmojiPieces,
  captionEmojiLayerKey,
} from "@narriflow/caption-scene";
import type { CaptionTimeSource } from "../caption-block-painter";
import { CaptionSceneLayers, type MeasuredScene, stableByKey } from "../caption-scene-painter";
import { useCaptionEmojiArt } from "./use-caption-emoji-art";

/** Where a path's cue boxes come from. */
export interface CaptionEmojiCueSource {
  /** Names everything the boxes (and their obstacles) are a function of: equal keys give equal boxes. */
  readonly key: string;
  /** The boxes, computed inside the deferred build and kept by the source (a Scene Style's take 10 to 30 ms on a long clip). */
  readonly cueBoxes: () => readonly CaptionEmojiCueBox[];
}

/** One layer build: the placement input less its cue boxes, which the source makes. */
export interface CaptionEmojiLayerPlan {
  readonly source: CaptionEmojiCueSource;
  readonly input: Omit<CaptionEmojiLayerInput, "cueBoxes">;
}

/** The layer's key: what the build is a function of (`captionEmojiLayerKey`, with the source key standing for the boxes). */
export function captionEmojiPlanKey(plan: CaptionEmojiLayerPlan): string {
  return captionEmojiLayerKey(plan.input, plan.source.key);
}

// Emoji pieces are shapes; the painter measures text only.
const noText: Measure = (_text, _face, sizePx) => ({ advance: 0, inkTop: -sizePx, inkBottom: 0, ascent: sizePx, descent: 0 });

/** Places the plan's emojis: the pieces as a paintable scene, or null when none is placed. */
export function buildCaptionEmojiLayer(plan: CaptionEmojiLayerPlan): MeasuredScene | null {
  const pieces = buildCaptionEmojiPieces({ ...plan.input, cueBoxes: plan.source.cueBoxes() });
  return pieces.length > 0 ? { scene: { pieces }, measure: noText, language: null } : null;
}

/**
 * Builds by layer key, the most recent `BUILDS_KEPT`. A deferred render that an urgent update
 * interrupts (every playback tick is one) is thrown away with its memo, and a layer mounted again
 * for an equal plan (a cue's emojis held past its end, `HeldCueEmojis`) finds the build its cue made
 * and paints it at once, with no frame between the two mounts.
 */
const builds = new Map<string, MeasuredScene | null>();
const BUILDS_KEPT = 32;

/** The build of the plan with this key, if one was made: the held layer paints it in its first render. */
export function builtCaptionEmojiLayer(key: string): MeasuredScene | null | undefined {
  return builds.get(key);
}

export function buildCaptionEmojiLayerOnce(stable: { readonly key: string; readonly value: CaptionEmojiLayerPlan }): MeasuredScene | null {
  if (!builds.has(stable.key)) {
    builds.set(stable.key, buildCaptionEmojiLayer(stable.value));
    if (builds.size > BUILDS_KEPT) builds.delete(builds.keys().next().value!);
  }
  return builds.get(stable.key) ?? null;
}

export interface CaptionEmojiLayerProps {
  /** Null while the path has nothing measured yet. */
  readonly source: CaptionEmojiCueSource | null;
  readonly emojis: readonly CaptionEmojiLayerEmoji[];
  readonly style: CaptionEmojiLayerStyle;
  readonly canvas: { readonly width: number; readonly height: number };
  /** The caption anchor's height, percent of the frame. */
  readonly anchorYPct: number;
  /** The clip's render rate: placement runs on the export's frame grid. Absent, `SCENE_DEFAULT_FPS`. */
  readonly fps?: number | undefined;
  /** Where held emojis yield (`CaptionEmojiLayerInput.nextEmojiAtMs`): a one-cue layer's, from the cues after it. */
  readonly nextEmojiAtMs?: number | undefined;
  /** Where the clip ends, ms (`CaptionEmojiLayerInput.endMs`, the plan's edited duration). */
  readonly endMs?: number | undefined;
  /** Display px per canvas px. */
  readonly scale: number;
  readonly timeSource: CaptionTimeSource;
}

/**
 * Paints the emojis over a box of the canvas's size at `scale`, top-left at canvas (0, 0). The build
 * runs once per layer key in a deferred render (the edit paints first; the previous layer stays up
 * meanwhile), never per frame.
 */
export const CaptionEmojiLayer = memo(function CaptionEmojiLayer({ source, emojis, style, canvas, anchorYPct, fps, nextEmojiAtMs, endMs, scale, timeSource }: CaptionEmojiLayerProps) {
  const ids = useMemo(() => emojis.map((emoji) => emoji.id), [emojis]);
  const { art } = useCaptionEmojiArt(ids);
  const plan = useMemo(
    (): CaptionEmojiLayerPlan | null =>
      source && emojis.length > 0 && art.size > 0
        ? { source, input: { emojis, art, style, canvas, anchorYPct, ...(fps ? { fps } : {}), ...(nextEmojiAtMs === undefined ? {} : { nextEmojiAtMs }), ...(endMs === undefined ? {} : { endMs }) } }
        : null,
    [source, emojis, art, style, canvas, anchorYPct, fps, nextEmojiAtMs, endMs],
  );
  const stable = useRef<{ readonly key: string; readonly value: CaptionEmojiLayerPlan } | null>(null);
  stable.current = stableByKey(stable.current, plan ? captionEmojiPlanKey(plan) : null, plan);
  const deferred = useDeferredValue(stable.current, null);
  const deferredBuild = useMemo(() => (deferred ? buildCaptionEmojiLayerOnce(deferred) : null), [deferred]);
  // A plan already built (by this layer or another mount of it) paints now; a new one waits for the deferred build.
  const ready = stable.current ? builtCaptionEmojiLayer(stable.current.key) : undefined;
  const built = ready === undefined ? deferredBuild : ready;
  if (!built) return null;
  return <CaptionSceneLayers built={built} canvas={canvas} scale={scale} timeSource={timeSource} />;
});
