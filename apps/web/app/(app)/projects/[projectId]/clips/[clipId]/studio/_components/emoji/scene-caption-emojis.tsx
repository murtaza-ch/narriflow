"use client";

import { memo, useMemo } from "react";
import {
  type CaptionEmojiCueBox,
  type CaptionScene,
  type Measure,
  captionEmojiLayerEmojis,
  captionEmojiLayerStyle,
  captionSceneEmojiCueBoxes,
  sceneInputFromPreset,
} from "@narriflow/caption-scene";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import type { CaptionTimeSource } from "../caption-block-painter";
import type { CaptionSceneBuildInput, MeasuredScene } from "../caption-scene-painter";
import { CaptionEmojiLayer, type CaptionEmojiCueSource } from "./caption-emoji-layer";

const sceneIds = new WeakMap<CaptionScene, number>();
let nextSceneId = 0;

/** A built scene's identity: a scene object is built once per scene key (and face load), so its boxes are fixed. */
function sceneIdentity(scene: CaptionScene): number {
  let id = sceneIds.get(scene);
  if (id === undefined) {
    id = nextSceneId++;
    sceneIds.set(scene, id);
  }
  return id;
}

const unusedMeasure: Measure = () => {
  throw new Error("the scene's size and anchor never measure");
};

/** Size scale and anchor height of a Scene Style input, as the scene was built with them. */
export function sceneEmojiGeometry(input: CaptionSceneBuildInput): { readonly scale: number; readonly anchorYPct: number } {
  const scene = sceneInputFromPreset(input.preset, { cues: input.cues, canvas: input.canvas, measure: unusedMeasure, ...(input.anchor ? { anchor: input.anchor } : {}) });
  return { scale: scene.scale, anchorYPct: scene.anchor.yPct };
}

/** Each built scene's cue boxes, computed once: an emoji, palette or size edit places again over the same boxes. */
const sceneBoxes = new WeakMap<MeasuredScene, readonly CaptionEmojiCueBox[]>();

/** The cue boxes of a built scene: from the cues and measurement it was built with, never a newer input's. */
export function sceneEmojiCueSource(built: MeasuredScene): CaptionEmojiCueSource | null {
  const input = built.input;
  if (!input?.preset.scene) return null;
  const { scale } = sceneEmojiGeometry(input);
  return {
    key: `scene:${sceneIdentity(built.scene)}`,
    cueBoxes: () => {
      let boxes = sceneBoxes.get(built);
      if (!boxes) {
        boxes = captionSceneEmojiCueBoxes(built.scene, { ...input, scale }, built.measure);
        sceneBoxes.set(built, boxes);
      }
      return boxes;
    },
  };
}

/**
 * A Scene Style's emojis, over the target's scene. Boxes follow the scene on screen (which lags an
 * edit by a deferred render); the emojis and their style follow the current layers, so a palette or
 * an emoji edit never waits on, or causes, a scene build.
 */
export const SceneCaptionEmojis = memo(function SceneCaptionEmojis({
  built,
  layers,
  scale,
  timeSource,
}: {
  built: MeasuredScene;
  layers: readonly CompositionCaptionVisualLayer[];
  scale: number;
  timeSource: CaptionTimeSource;
}) {
  const emojis = useMemo(() => captionEmojiLayerEmojis(layers), [layers]);
  const preset = layers[0]!.preset;
  const style = useMemo(() => captionEmojiLayerStyle(preset), [preset]);
  const hasEmojis = emojis.length > 0;
  const source = useMemo(() => (hasEmojis ? sceneEmojiCueSource(built) : null), [built, hasEmojis]);
  const input = built.input;
  if (!input || !hasEmojis) return null;
  return <CaptionEmojiLayer source={source} emojis={emojis} style={style} canvas={input.canvas} anchorYPct={sceneEmojiGeometry(input).anchorYPct} fps={input.fps} scale={scale} timeSource={timeSource} />;
});
