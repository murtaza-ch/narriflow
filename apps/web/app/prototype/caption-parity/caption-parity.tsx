"use client";

// Studio caption parity harness (spec section 9). The classic mode renders
// the same transcript and timing as the worker-side libass harness at half
// export scale (540 x 960). The fixture mode renders a Dynamic Style case
// through the real composition plan and the block painter at export scale.
import { useCallback, useEffect, useMemo, useState } from "react";
import { SHEET_CANVAS, primitivesSheet, sceneCuesFromLayers, type SceneEdgeDemo, captionSceneDemo, sceneEdgeDemo } from "@narriflow/caption-scene";
import { planClipComposition, type CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
  CAPTION_POSITION_Y_DEFAULTS,
  CAPTION_PRESETS,
  type CaptionPreset,
  type CaptionSceneName,
  applyCaptionPresetLook,
  captionPresetSchema,
  editorDocumentSchema,
  getCaptionPresetById,
  studioEditsSchema,
} from "@narriflow/validators";
import { CaptionCue } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine";
import {
  CaptionBlockFrame,
  loopTimeSource,
  staticTimeSource,
  type CaptionBlockCueInput,
  type CaptionBlockPaint,
} from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-block-painter";
import { CaptionSceneFrame, CaptionSceneLayers, captionSceneBoundsAt, useFixtureScene, type CaptionSceneBuildInput, type MeasuredScene } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-scene-painter";

const SCRIPT = [
  "The biggest mistake people make is waiting until they feel ready.",
  "Nobody feels ready.",
  "You start, you learn fast, and momentum does the rest.",
];

function cuesFor(wordsPerCue: number) {
  let t = 0.4;
  const cues: { words: { text: string; start: number; end: number }[]; index: number }[] = [];
  for (const sentence of SCRIPT) {
    const words = sentence.split(" ").map((text) => {
      const duration = 0.16 + 0.04 * text.replace(/[^a-z]/gi, "").length;
      const word = { text, start: t, end: t + duration };
      t += duration + (/,$/.test(text) ? 0.18 : 0.03);
      return word;
    });
    for (let index = 0; index < words.length; index += wordsPerCue) {
      cues.push({ words: words.slice(index, index + wordsPerCue), index: cues.length });
    }
    t += 0.35;
  }
  return cues;
}

export function CaptionParity({ presetId, time }: { presetId: string; time: number }) {
  const named = CAPTION_PRESETS.find((candidate) => candidate.id === presetId) ?? CAPTION_PRESETS[0];
  const preset = { ...named.preset, punctuation: false };
  const cues = cuesFor(preset.wordsPerCue);
  const cue = cues.find((candidate, index) => time >= candidate.words[0]!.start && time < (cues[index + 1]?.words[0]?.start ?? Number.POSITIVE_INFINITY));
  const width = 540;
  return (
    <div style={{ position: "relative", width, height: 960, background: "#2a3346", overflow: "hidden" }} data-parity-frame>
      {cue && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: `${CAPTION_POSITION_Y_DEFAULTS[preset.position]}%`,
            transform: "translate(-50%, -50%)",
            width: "max-content",
          }}
        >
          <CaptionCue
            preset={preset}
            words={cue.words.map((word, index) => ({
              word: word.text,
              isActive: time >= word.start && time < (cue.words[index + 1]?.start ?? Number.POSITIVE_INFINITY),
              durationMs: 400,
            }))}
            scale={width / 1080}
            frameWidth={width}
            cueKey={cue.index}
            cueIndex={cue.index}
            reducedMotion
          />
        </div>
      )}
    </div>
  );
}

/** One case of `packages/composition-plan/src/__fixtures__/dynamic-captions/manifest.json`. */
export interface DynamicCaptionCase {
  readonly id: string;
  readonly presetId: string;
  readonly preset: Record<string, unknown>;
  readonly language: string;
  readonly words: readonly { readonly word: string; readonly key: string; readonly startSec: number; readonly endSec: number; readonly spaceBefore?: boolean }[];
  readonly overrides: Record<string, "hero" | "pair" | "plain">;
}

const CANVAS = { width: 1080, height: 1920 } as const;

/** The case's one caption layer, from the same plan the Studio and the worker build. */
function fixtureCaptionLayer(fixture: DynamicCaptionCase): CompositionCaptionVisualLayer | null {
  const words = fixture.words;
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 20,
    captionPreset: captionPresetSchema.parse({ ...getCaptionPresetById(fixture.presetId)?.preset, ...fixture.preset }),
    transcriptSlice: [
      {
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker 1",
        startSec: words[0]!.startSec,
        endSec: words[words.length - 1]!.endSec,
        text: words.map((word) => word.word).join(" "),
        confidence: 1,
        words: words.map(({ key: _key, ...word }) => ({ ...word, confidence: 1 })),
      },
    ],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionEmphasis: fixture.overrides }),
    brollUrl: null,
    deletedRanges: [],
  });
  const result = planClipComposition({
    document,
    captionLanguage: fixture.language,
    source: { identity: "source:parity", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, music: {} },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: CANVAS.width, height: CANVAS.height }],
  });
  if (result.status === "invalid") return null;
  return result.plan.targets[0]!.visualLayers.find((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption") ?? null;
}

/**
 * A fixture case frozen at `time` (edited seconds), on a 1080x1920 canvas
 * drawn at `scale` display px per canvas px over a preset backdrop (green-studio by default).
 * The page reports the layout (each word's size, baseline and centre in
 * canvas px) in `<script id="metrics">` and sets `data-ready` once painted.
 * With `play`, the playhead loops instead, for per-frame cost checks.
 */
export function DynamicCaptionParity({
  fixture,
  time,
  scale,
  play = false,
  backdrop = "green-studio",
}: {
  fixture: DynamicCaptionCase;
  time: number;
  scale: number;
  /** A file under `public/images/caption-backdrops`, without its extension. */
  backdrop?: string;
  /** Loop the playhead from 0 to 0.3 s past the cue instead of freezing it. */
  play?: boolean;
}) {
  const layer = useMemo(() => fixtureCaptionLayer(fixture), [fixture]);
  const loopSec = (layer?.activeRange.endSec ?? 0) + 0.3;
  const timeSource = useMemo(() => (play ? loopTimeSource(loopSec) : staticTimeSource(time)), [play, loopSec, time]);
  const [paint, setPaint] = useState<CaptionBlockPaint | null>(null);
  const onPaint = useCallback((next: CaptionBlockPaint) => setPaint(next), []);
  const width = CANVAS.width * scale;
  const height = CANVAS.height * scale;
  const metrics = paint
    ? {
        case: fixture.id,
        t: time,
        scale,
        canvas: CANVAS,
        activeRange: paint.cue.activeRange,
        blockScale: paint.layout.scale,
        bounds: paint.layout.bounds,
        words: paint.words.map((word, index) => ({
          text: word.text,
          role: paint.cue.block.roles[index],
          startSec: word.startSec,
          visible: time >= word.startSec && time <= paint.cue.activeRange.endSec,
          ...word.placed,
          measured: word.measured,
        })),
        decorations: paint.layout.decorations,
        gradient: paint.layout.gradient,
      }
    : null;
  return (
    <div
      data-parity-frame
      data-scale={scale}
      data-ready={paint ? "1" : undefined}
      style={{
        position: "relative",
        width,
        height,
        overflow: "hidden",
        background: `#000 url(/images/caption-backdrops/${backdrop}.webp) center / cover no-repeat`,
      }}
    >
      {layer?.block ? (
        <CaptionBlockFrame cue={layer as CaptionBlockCueInput} canvas={CANVAS} scale={scale} timeSource={timeSource} onPaint={onPaint} />
      ) : (
        <p style={{ color: "#fff", padding: 16, font: "16px system-ui" }}>Case {fixture.id} has no Caption Block.</p>
      )}
      {metrics ? (
        <script type="application/json" id="metrics">{JSON.stringify(metrics)}</script>
      ) : null}
    </div>
  );
}

const SCENE_BACKDROPS: Record<string, string | null> = { dark: "dark-studio", bright: "bright-room", busy: "brick-street", flat: null };

/**
 * A Scene Style's sample (or an edge demo) frozen at `timeMs`, on a canvas drawn at `scale` display
 * px per canvas px over a backdrop (`flat` is a plain grey the diff tools compare on). It reports the
 * scene's bounds at that time in `<script id="metrics">` and sets `data-ready` once painted.
 */
export function SceneParity({
  scene,
  timeMs,
  scale,
  bg,
  edge,
  size,
}: {
  scene: CaptionSceneName;
  timeMs: number;
  scale: number;
  bg: string;
  edge?: SceneEdgeDemo;
  size?: { width: number; height: number };
}) {
  const canvas = size ?? SCENE_CANVAS;
  const named = CAPTION_PRESETS.find((candidate) => candidate.id === scene)!;
  const cues = useMemo(() => (edge ? sceneEdgeDemo(edge) : captionSceneDemo(scene)).cues, [scene, edge]);
  const input = useMemo(
    () => ({ preset: named.preset, cues, canvas, language: cues[0]?.language ?? null }),
    [named, cues, canvas],
  );
  const backdrop = SCENE_BACKDROPS[bg] ?? null;
  return (
    <ParityScene
      input={input}
      scene={scene}
      timeMs={timeMs}
      scale={scale}
      background={backdrop ? `#000 url(/images/caption-backdrops/${backdrop}.webp) center / cover no-repeat` : "#707070"}
    />
  );
}

/** A built Scene Style frozen at `timeMs` over a CSS `background`; reports bounds in `<script id="metrics">`, `data-ready` once painted. */
function ParityScene({
  input,
  scene,
  timeMs,
  scale,
  background,
}: {
  input: CaptionSceneBuildInput;
  scene: CaptionSceneName;
  timeMs: number;
  scale: number;
  background: string;
}) {
  const { canvas } = input;
  const timeSource = useMemo(() => staticTimeSource(timeMs / 1000), [timeMs]);
  const [built, setBuilt] = useState<MeasuredScene | null>(null);
  const [ready, setReady] = useState(false);
  const onBuilt = useCallback((next: MeasuredScene) => setBuilt(next), []);
  // Two frames after the scene exists, the baselines are probed and every element is painted.
  useEffect(() => {
    if (!built) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [built]);
  const metrics = built ? { scene, t: timeMs, scale, canvas, bounds: captionSceneBoundsAt(built, timeMs), pieces: built.scene.pieces.length, cues: input.cues.slice(0, 4).map((cue) => [cue.index, cue.startMs, cue.endMs]) } : null;
  return (
    <div
      data-parity-frame
      data-scale={scale}
      data-ready={ready ? "1" : undefined}
      style={{
        position: "relative",
        width: canvas.width * scale,
        height: canvas.height * scale,
        overflow: "hidden",
        background,
      }}
    >
      <CaptionSceneFrame input={input} scale={scale} timeSource={timeSource} onBuilt={onBuilt} />
      {metrics ? <script type="application/json" id="metrics">{JSON.stringify(metrics)}</script> : null}
    </div>
  );
}

/**
 * A REAL clip's Scene Style frozen at `timeMs` (output time): the clip's editor document (`out/real/<clip>/document.json`,
 * private, read by the dev-only page) with the preset swapped as the Studio does, planned by the real composition plan,
 * its caption layers turned into scene cues by the Studio overlay's own `sceneCuesFromLayers`, drawn by the real scene
 * painter. `backdropUrl` is a frame of the clip rendered without captions (or null for the flat grey the diff tools use).
 */
export function RealSceneParity({
  document: stored,
  presetId,
  timeMs,
  scale,
  backdropUrl,
}: {
  document: unknown;
  presetId: string;
  timeMs: number;
  scale: number;
  backdropUrl: string | null;
}) {
  const named = CAPTION_PRESETS.find((candidate) => candidate.id === presetId);
  const input = useMemo(() => {
    if (!named) return null;
    const parsed = editorDocumentSchema.parse(stored);
    const document = editorDocumentSchema.parse({ ...parsed, captionPreset: applyCaptionPresetLook(parsed.captionPreset as CaptionPreset, named) });
    const result = planClipComposition({
      document,
      source: { identity: "source:real-parity", kind: "video", width: 1920, height: 1080 },
      evidence: { automaticLayout: { state: "missing" } },
      assets: { backgroundImage: { state: "missing" }, music: {} },
      capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: CANVAS.width, height: CANVAS.height }],
    });
    if (result.status === "invalid") return null;
    const layers = result.plan.targets[0]!.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption");
    const first = layers[0];
    if (!first) return null;
    return { preset: first.preset, cues: sceneCuesFromLayers(layers), canvas: CANVAS, anchor: first.anchor, language: first.language };
  }, [stored, named]);
  if (!input) return <p style={{ font: "16px system-ui" }}>No scene for {presetId}.</p>;
  return (
    <ParityScene
      input={input}
      scene={presetId as CaptionSceneName}
      timeMs={timeMs}
      scale={scale}
      background={backdropUrl ? `#000 url(${backdropUrl}) center / 100% 100% no-repeat` : "#707070"}
    />
  );
}

const SCENE_CANVAS = { width: 1080, height: 1920 } as const;

/**
 * The primitives sheet (`primitivesSheet`) frozen at `timeMs` on its own canvas, over the flat grey the
 * worker's sheet frames are compared on. `data-ready` is set once every face has loaded and painted.
 */
export function SheetParity({ timeMs }: { timeMs: number }) {
  const sheet = useMemo(() => primitivesSheet(), []);
  const built = useFixtureScene(sheet.scene);
  const timeSource = useMemo(() => staticTimeSource(timeMs / 1000), [timeMs]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!built) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [built]);
  return (
    <div data-parity-frame data-ready={ready ? "1" : undefined} style={{ position: "relative", width: SHEET_CANVAS.width, height: SHEET_CANVAS.height, overflow: "hidden", background: "#707070" }}>
      {built ? <CaptionSceneLayers built={built} canvas={SHEET_CANVAS} scale={1} timeSource={timeSource} /> : null}
    </div>
  );
}
