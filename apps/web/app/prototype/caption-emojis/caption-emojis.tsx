"use client";

// Emoji layer harness (Add Emojis ticket 07): fixed cues with Caption Emojis, planned by the real
// composition plan and drawn by the real Studio painters and emoji layer for a classic, a Dynamic and
// several Scene presets, LTR and RTL, on one scrubbed clock.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { sceneCuesFromLayers } from "@narriflow/caption-scene";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { CaptionCue } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine";
import {
  CaptionBlockWords,
  staticTimeSource,
  useCaptionBlockPaint,
  type CaptionBlockCueInput,
  type CaptionTimeSource,
} from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-block-painter";
import { captionCueWordsAt } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-cue-at";
import { CaptionSceneLayers, useCaptionScene, type MeasuredScene } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-scene-painter";
import { buildCaptionEmojiLayer } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/caption-emoji-layer";
import { emojiFixtureLayers } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/caption-emoji-fixture";
import { BlockCaptionEmojis, ClassicCaptionEmojis, useClassicLineFace } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/cue-caption-emojis";
import { SceneCaptionEmojis, sceneEmojiCueSource, sceneEmojiGeometry } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/scene-caption-emojis";
import { useCaptionEmojiArt } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/use-caption-emoji-art";
import { type CaptionEmojiCueBox, captionEmojiLayerEmojis, captionEmojiLayerStyle, placeCaptionEmojis } from "@narriflow/caption-scene";
import { blockEmojiCueBox, classicLineEmojiCueBox } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/cue-emoji-boxes";
import { EMOJI_FRAMES, type EmojiFrameSpec, emojiFrameId } from "./frames";

const CANVAS = { width: 1080, height: 1920 } as const;

/** A clock the scrubber sets and Play advances. */
function createScrubClock(initialSec: number) {
  let time = initialSec;
  const listeners = new Set<() => void>();
  const clock: CaptionTimeSource & { set: (sec: number) => void } = {
    getSnapshot: () => time,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (sec) => {
      time = sec;
      for (const listener of listeners) listener();
    },
  };
  return clock;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * `?debug=1`: the cue boxes a frame hands the emoji layer and where each emoji went (pivot, drawing
 * side, window), as JSON in `data-emoji-debug`, for comparing with the export's emoji events.
 */
function EmojiDebug({ frameId, cueBoxes, layers, anchorYPct }: { frameId: string; cueBoxes: readonly CaptionEmojiCueBox[] | null; layers: readonly CompositionCaptionVisualLayer[]; anchorYPct: number }) {
  const emojis = useMemo(() => captionEmojiLayerEmojis(layers), [layers]);
  const { art, pending } = useCaptionEmojiArt(useMemo(() => emojis.map((emoji) => emoji.id), [emojis]));
  if (pending || !cueBoxes || emojis.length === 0) return null;
  const outcomes = placeCaptionEmojis({ cueBoxes, emojis, art, style: captionEmojiLayerStyle(layers[0]!.preset), canvas: CANVAS, anchorYPct });
  const report = {
    frame: frameId,
    cueBoxes: cueBoxes.map((cue) => ({ cue: cue.cueIndex, x1: round(cue.box.x1), y1: round(cue.box.y1), x2: round(cue.box.x2), y2: round(cue.box.y2), bodyPx: round(cue.bodyPx), tiltDeg: cue.tiltDeg, direction: cue.direction, fromMs: round(cue.fromMs), toMs: round(cue.toMs) })),
    emojis: outcomes.map((outcome) => {
      if (!outcome.placed) return { id: outcome.emoji.id, cue: outcome.emoji.cueIndex, placed: false, reason: outcome.reason };
      const piece = outcome.pieces[0]!;
      return { id: outcome.emoji.id, cue: outcome.emoji.cueIndex, placed: true, side: outcome.side, x: round(piece.track.x![0]![1]), y: round(piece.track.y![0]![1]), size: round(2 * piece.origin!.dx), turnDeg: round(piece.track.rz![0]![1]), fromMs: round(piece.fromMs), toMs: round(piece.toMs) };
    }),
  };
  return <pre data-emoji-debug={frameId} style={{ display: "none" }}>{JSON.stringify(report)}</pre>;
}

function useActiveLayer(layers: readonly CompositionCaptionVisualLayer[], clock: CaptionTimeSource): CompositionCaptionVisualLayer | null {
  const index = useSyncExternalStore(
    clock.subscribe,
    () => layers.findIndex((layer) => clock.getSnapshot() >= layer.activeRange.startSec && clock.getSnapshot() < layer.activeRange.endSec),
    () => -1,
  );
  return index >= 0 ? layers[index]! : null;
}

interface FrameProps {
  layers: readonly CompositionCaptionVisualLayer[];
  clock: CaptionTimeSource;
  scale: number;
  /** Set with `?debug=1`: the frame's id for `EmojiDebug`. */
  debug: string | null;
}

function ClassicFrame({ layers, clock, scale, debug }: FrameProps) {
  const time = useSyncExternalStore(clock.subscribe, clock.getSnapshot, () => 0);
  const layer = useActiveLayer(layers, clock);
  const [line, setLine] = useState<{ cueId: string; width: number; scale: number } | null>(null);
  const face = useClassicLineFace(layers[0]!.preset);
  if (!layer) return null;
  const measured = line?.cueId === layer.id ? line : null;
  return (
    <>
      {debug ? <EmojiDebug frameId={debug} cueBoxes={measured ? [classicLineEmojiCueBox(layer, measured, face)].filter((box) => box !== null) : null} layers={[layer]} anchorYPct={layer.anchor.yPct} /> : null}
      <ClassicCaptionEmojis layer={layer} line={measured} scale={scale} timeSource={clock} />
      <div style={{ position: "absolute", left: `${layer.anchor.xPct}%`, top: `${layer.anchor.yPct}%`, transform: "translate(-50%, -50%)", width: "max-content", zIndex: 5 }}>
        <div style={{ position: "relative", padding: "8px 12px" }}>
          <CaptionCue
            preset={layer.preset}
            words={captionCueWordsAt(layer, time)}
            scale={scale}
            frameWidth={CANVAS.width * scale}
            cueKey={layer.id}
            cueIndex={layer.cueIndex}
            preformatted
            language={layer.language}
            onLineSize={(width) => setLine((previous) => (previous?.cueId === layer.id && previous.width === width && previous.scale === scale ? previous : { cueId: layer.id, width, scale }))}
          />
        </div>
      </div>
    </>
  );
}

function BlockFrame({ layers, clock, scale, debug }: FrameProps) {
  const layer = useActiveLayer(layers, clock);
  const paint = useCaptionBlockPaint(layer?.block ? (layer as CaptionBlockCueInput) : null, CANVAS);
  if (!layer || !paint) return null;
  const bounds = paint.layout.bounds;
  const debugBox = debug ? blockEmojiCueBox(paint, layer.cueIndex) : null;
  return (
    <>
      {debug ? <EmojiDebug frameId={debug} cueBoxes={debugBox ? [debugBox] : []} layers={[layer]} anchorYPct={layer.anchor.yPct} /> : null}
      <BlockCaptionEmojis layer={layer} paint={paint} scale={scale} timeSource={clock} />
      <div style={{ position: "absolute", left: bounds.x * scale, top: bounds.y * scale, width: bounds.width * scale, height: bounds.height * scale, zIndex: 5 }}>
        <CaptionBlockWords paint={paint} scale={scale} origin={{ x: bounds.x, y: bounds.y }} timeSource={clock} reducedMotion={false} />
      </div>
    </>
  );
}

function SceneFrame({ layers, clock, scale, debug }: FrameProps) {
  const first = layers[0]!;
  const input = useMemo(() => ({ preset: first.preset, cues: sceneCuesFromLayers(layers), canvas: CANVAS, anchor: first.anchor, language: first.language }), [first, layers]);
  const built = useCaptionScene(input);
  if (!built) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 5 }}>
      <CaptionSceneLayers built={built} canvas={CANVAS} scale={scale} timeSource={clock} />
      <SceneCaptionEmojis built={built} layers={layers} scale={scale} timeSource={clock} />
      {debug && built.input ? <EmojiDebug frameId={debug} cueBoxes={sceneEmojiCueSource(built)?.cueBoxes() ?? null} layers={layers} anchorYPct={sceneEmojiGeometry(built.input).anchorYPct} /> : null}
    </div>
  );
}

function EmojiFrame({ spec, clock, scale, label, debug, ids }: { spec: EmojiFrameSpec; clock: CaptionTimeSource; scale: number; label: boolean; debug: boolean; ids: readonly string[] | null }) {
  const layers = useMemo(() => emojiFixtureLayers({ presetId: spec.presetId, rtl: spec.rtl, ...(ids ? { emojiIds: ids } : {}) }), [spec, ids]);
  const kind = layers[0]!.scene ? "scene" : layers[0]!.block ? "dynamic" : "classic";
  const Frame = kind === "scene" ? SceneFrame : kind === "dynamic" ? BlockFrame : ClassicFrame;
  return (
    <figure style={{ margin: 0 }}>
      <div
        data-emoji-frame={emojiFrameId(spec)}
        style={{ position: "relative", width: CANVAS.width * scale, height: CANVAS.height * scale, overflow: "hidden", background: "linear-gradient(160deg, #3a4660, #1d2333)" }}
      >
        <Frame layers={layers} clock={clock} scale={scale} debug={debug ? emojiFrameId(spec) : null} />
      </div>
      {label ? (
        <figcaption style={{ font: "12px/1.4 system-ui", color: "#c9cfdb", marginTop: 4 }}>
          {spec.presetId} ({kind}{spec.rtl ? ", Urdu" : ""})
        </figcaption>
      ) : null}
    </figure>
  );
}

/** The fixture's emoji anchors (seconds), for jumping to a pop. */
function emojiTimes(spec: EmojiFrameSpec): number[] {
  return captionEmojiLayerEmojis(emojiFixtureLayers({ presetId: spec.presetId, rtl: spec.rtl })).map((emoji) => emoji.atMs / 1000);
}

/** Times the emoji layer build over 60 s with 20 emojis on real browser measurement, median of 7. */
function BuildTiming({ presetId }: { presetId: string }) {
  const layers = useMemo(() => emojiFixtureLayers({ presetId, long: true }), [presetId]);
  const input = useMemo(() => ({ preset: layers[0]!.preset, cues: sceneCuesFromLayers(layers), canvas: CANVAS, anchor: layers[0]!.anchor, language: layers[0]!.language }), [layers]);
  const built = useCaptionScene(input);
  const emojis = useMemo(() => captionEmojiLayerEmojis(layers), [layers]);
  const { art, pending } = useCaptionEmojiArt(useMemo(() => emojis.map((emoji) => emoji.id), [emojis]));
  const [result, setResult] = useState<{ ms: number; pieces: number; placed: number } | null>(null);
  useEffect(() => {
    if (!built || pending) return;
    const runs: number[] = [];
    let pieces = 0;
    let placed = 0;
    for (let run = 0; run < 7; run++) {
      // A fresh source per run: the boxes are part of what a layer build costs.
      const source = sceneEmojiCueSource(built as MeasuredScene)!;
      const started = performance.now();
      const layer = buildCaptionEmojiLayer({ source, input: { emojis, art, style: captionEmojiLayerStyle(input.preset), canvas: CANVAS, anchorYPct: sceneEmojiGeometry(input).anchorYPct } });
      runs.push(performance.now() - started);
      pieces = layer?.scene.pieces.length ?? 0;
      placed = new Set(layer?.scene.pieces.map((piece) => piece.id.split(":").slice(0, 3).join(":"))).size;
    }
    runs.sort((a, b) => a - b);
    setResult({ ms: Math.round(runs[3]! * 10) / 10, pieces, placed });
  }, [built, pending, emojis, art, input]);
  return (
    <li data-emoji-build={presetId} data-emoji-build-ms={result?.ms}>
      {presetId}: {result ? `${result.ms} ms (${built?.scene.pieces.length} scene pieces, ${result.placed} of ${emojis.length} emojis placed, ${result.pieces} emoji pieces)` : "measuring"}
    </li>
  );
}

export function CaptionEmojisHarness({
  timeSec,
  only,
  scale,
  pop,
  debug = false,
  ids = null,
}: {
  timeSec: number;
  only: EmojiFrameSpec | null;
  scale: number;
  pop: { index: number; offsetMs: number } | null;
  debug?: boolean;
  /** Emoji ids that replace the hand-chosen ones in turn, on the same words (a phrase badge, say). */
  ids?: readonly string[] | null;
}) {
  const clock = useMemo(() => createScrubClock(timeSec), [timeSec]);
  const time = useSyncExternalStore(clock.subscribe, clock.getSnapshot, () => timeSec);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      clock.set((clock.getSnapshot() + (now - last) / 1000) % 16);
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, clock]);
  const frames = only ? [only] : EMOJI_FRAMES;
  // `pop`: every frame at its own emoji's anchor plus an offset (the pop's middle, or at rest).
  const frameClock = (spec: EmojiFrameSpec) => {
    if (!pop) return clock;
    const times = emojiTimes(spec);
    return staticTimeSource((times[Math.min(pop.index, times.length - 1)] ?? 0) + pop.offsetMs / 1000);
  };
  return (
    <main style={{ padding: 16, background: "#141823", minHeight: "100vh", color: "#e6e9ef", font: "13px/1.4 system-ui" }}>
      {only || pop ? null : (
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <button type="button" onClick={() => setPlaying((value) => !value)} style={{ padding: "4px 12px", borderRadius: 6, border: 0, background: "#2b3245", color: "inherit" }}>
            {playing ? "Pause" : "Play"}
          </button>
          <input type="range" min={0} max={16} step={0.01} value={time} onChange={(event) => clock.set(Number(event.target.value))} style={{ width: 420 }} aria-label="Time" />
          <span data-emoji-time>{time.toFixed(2)} s</span>
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {frames.map((spec) => (
          <EmojiFrame key={`${spec.presetId}-${spec.rtl}`} spec={spec} clock={frameClock(spec)} scale={scale} label={!only} debug={debug} ids={ids} />
        ))}
      </div>
      {only || pop ? null : (
        <section style={{ marginTop: 16 }}>
          <div>Emoji layer build, 60 s clip, 20 emojis (cue boxes and placement), median of 7:</div>
          <ul>
            <BuildTiming presetId="horizon" />
            <BuildTiming presetId="wordform" />
            <BuildTiming presetId="lyrics" />
          </ul>
        </section>
      )}
    </main>
  );
}
