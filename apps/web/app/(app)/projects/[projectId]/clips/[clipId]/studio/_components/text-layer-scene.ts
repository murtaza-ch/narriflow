"use client";

/**
 * Text Layers in the Studio (title-text spec section 6, ADR 0021). The shared layout
 * (`buildTextLayerScene` in `@narriflow/caption-scene`) turns a target's layers into a static
 * Caption Scene from Canvas measurement; the Scene painter (`CaptionSceneLayers`) paints it from the
 * playback clock, the same pieces the worker writes as ASS. Nothing here computes a layout number:
 * the frame, the boxes and the line breaks all come from the builder.
 *
 * Text Layers have no language (their paragraph direction comes from the text) and draw braces and
 * backslashes as typed, as the worker's literal measurer does: `canvasMeasure` measures the text as
 * given, so the two agree.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Measure, type TextLayerEntry, type TextLayerLayout, buildTextLayerScene, memoMeasure } from "@narriflow/caption-scene";
import { canvasMeasure, type MeasuredScene } from "./caption-scene-painter";

export interface TextLayerCanvasSize {
  readonly width: number;
  readonly height: number;
}

/** A built Text Layer scene: what the painter draws, and each entry's layout (its frame and lines). */
export interface BuiltTextLayers {
  readonly built: MeasuredScene;
  /** Each entry's layout by layer id (a build kept up while the next one loads may not hold every id). */
  readonly layouts: ReadonlyMap<string, TextLayerLayout>;
}

type BuildResult =
  | { readonly status: "ready"; readonly value: BuiltTextLayers }
  | { readonly status: "pending"; readonly load: () => Promise<unknown> };

/** What a build is a function of: the layers (their text, place, width, style), their windows and the canvas. */
export function textLayerSceneKey(entries: readonly TextLayerEntry[], canvas: TextLayerCanvasSize): string {
  return JSON.stringify([canvas.width, canvas.height, entries.map((entry) => [entry.layer, entry.window.fromMs, entry.window.toMs])]);
}

/**
 * Builds the scene. While a face is still loading (`force` false) the measurement comes from a
 * fallback, so the result is `pending` with the loads to wait for; once they have settled the build
 * is forced and measures what loaded.
 */
export function buildTextLayers(entries: readonly TextLayerEntry[], canvas: TextLayerCanvasSize, force: boolean): BuildResult {
  const wanted = force ? null : new Map<string, () => Promise<unknown>>();
  const measure: Measure = wanted ? canvasMeasure(null, wanted) : memoMeasure(canvasMeasure(null, null));
  const { scene, layouts } = buildTextLayerScene(entries, canvas, measure);
  if (wanted && wanted.size > 0) return { status: "pending", load: () => Promise.all([...wanted.values()].map((load) => load())) };
  return { status: "ready", value: { built: { scene, measure, language: null }, layouts: new Map(entries.map((entry, index) => [entry.layer.id, layouts[index]!])) } };
}

// Builds by key and mode, the most recent few: a drag rebuilds per move and a discarded render
// must not build twice.
const builds = new Map<string, BuildResult>();
const BUILDS_KEPT = 48;

function buildOnce(key: string, entries: readonly TextLayerEntry[], canvas: TextLayerCanvasSize, force: boolean): BuildResult {
  const cacheKey = `${force ? 1 : 0}${key}`;
  let result = builds.get(cacheKey);
  if (!result) {
    result = buildTextLayers(entries, canvas, force);
    builds.set(cacheKey, result);
    if (builds.size > BUILDS_KEPT) builds.delete(builds.keys().next().value!);
  }
  return result;
}

const subscribeNothing = () => () => undefined;

/**
 * The built scene of `entries` on `canvas`, once the faces it draws have loaded. Null before the
 * first build is ready (and during server rendering); while a new build waits for a face, the last
 * one stays up. A build is synchronous and cheap (a few lines of text), so it is not deferred: a
 * dragged layer moves on the frame it was dragged.
 */
export function useTextLayerScene(entries: readonly TextLayerEntry[], canvas: TextLayerCanvasSize): BuiltTextLayers | null {
  const client = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const key = useMemo(() => textLayerSceneKey(entries, canvas), [entries, canvas]);
  const [settled, setSettled] = useState<string | null>(null);
  const empty = entries.length === 0 || canvas.width <= 0 || canvas.height <= 0;
  // `key` names everything the build reads; `entries` and `canvas` are read through it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key covers entries and canvas.
  const result = useMemo(() => (client && !empty ? buildOnce(key, entries, canvas, settled === key) : null), [client, empty, key, settled]);
  useEffect(() => {
    if (result?.status !== "pending") return;
    let live = true;
    void result.load().catch(() => undefined).then(() => {
      if (live) setSettled(key);
    });
    return () => {
      live = false;
    };
  }, [result, key]);
  const last = useRef<BuiltTextLayers | null>(null);
  if (result?.status === "ready") last.current = result.value;
  else if (empty) last.current = null;
  return result?.status === "ready" ? result.value : last.current;
}
