import { type CaptionScene, type SceneCue, buildCaptionScene, captionSceneDemo, sceneInputFromPreset } from "@narriflow/caption-scene";
import { type CaptionSceneName, getCaptionPresetById } from "@narriflow/validators";
import { type AssEvent } from "../src/ass-format";
import { SceneMeasurer, sceneEvents } from "../src/caption-scene-ass";
import { assScript } from "../src/caption-ass";

/**
 * A Scene Style's own sample script, built and written the way an export writes a scene:
 * HarfBuzz measurement, the shared program, the real ASS writer. Shared by the frame tool
 * (`caption-scene-frames.ts`), the primitives sheet and the tests.
 */

export interface SceneDemoOptions {
  readonly canvas?: { width: number; height: number };
  /** Replaces the sample's cues (edge demos). */
  readonly cues?: readonly SceneCue[];
  readonly language?: string | null;
  readonly fps?: number;
  /** Preset fields to override (colours, size, position). */
  readonly preset?: Record<string, unknown>;
}

export interface SceneDemo {
  readonly name: CaptionSceneName;
  readonly canvas: { width: number; height: number };
  readonly cues: readonly SceneCue[];
  readonly durationMs: number;
  readonly scene: CaptionScene;
  readonly events: AssEvent[];
  readonly ass: string;
  readonly measurer: SceneMeasurer;
}

export function sceneDemo(name: CaptionSceneName, options: SceneDemoOptions = {}): SceneDemo {
  const canvas = options.canvas ?? { width: 1080, height: 1920 };
  const named = getCaptionPresetById(name);
  if (!named) throw new Error(`unknown scene ${name}`);
  const preset = { ...named.preset, ...(options.preset ?? {}) } as typeof named.preset;
  const demo = captionSceneDemo(name);
  const cues = options.cues ?? demo.cues.map((cue) => ({ ...cue, language: options.language === undefined ? cue.language : options.language }));
  const measurer = new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), cues[0]?.language ?? null);
  const input = sceneInputFromPreset(preset, { cues, canvas, measure: measurer.measure });
  const scene = buildCaptionScene(name, input);
  const events = sceneEvents(scene, measurer, { canvas, ...(options.fps ? { fps: options.fps } : {}) });
  return { name, canvas, cues, durationMs: demo.duration, scene, events, ass: assScript(events, canvas, preset), measurer };
}
