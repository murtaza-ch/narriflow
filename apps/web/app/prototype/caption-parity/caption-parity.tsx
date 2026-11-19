"use client";

// Studio caption parity harness (spec section 9). The classic mode renders
// the same transcript and timing as the worker-side libass harness at half
// export scale (540 x 960). The fixture mode renders a Dynamic Style case
// through the real composition plan and the block painter at export scale.
import { useCallback, useMemo, useState } from "react";
import { planClipComposition, type CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
  CAPTION_POSITION_Y_DEFAULTS,
  CAPTION_PRESETS,
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
    assets: { backgroundImage: { state: "missing" }, music: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: CANVAS.width, height: CANVAS.height }],
  });
  if (result.status === "invalid") return null;
  return result.plan.targets[0]!.visualLayers.find((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption") ?? null;
}

/**
 * A fixture case frozen at `time` (edited seconds), on a 1080x1920 canvas
 * drawn at `scale` display px per canvas px over the green-studio backdrop.
 * The page reports the layout (each word's size, baseline and centre in
 * canvas px) in `<script id="metrics">` and sets `data-ready` once painted.
 * With `play`, the playhead loops instead, for per-frame cost checks.
 */
export function DynamicCaptionParity({
  fixture,
  time,
  scale,
  play = false,
}: {
  fixture: DynamicCaptionCase;
  time: number;
  scale: number;
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
        })),
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
        background: "#000 url(/images/caption-backdrops/green-studio.webp) center / cover no-repeat",
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
