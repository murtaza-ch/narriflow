import type { CaptionScene, Measure, SceneWindow } from "./scene";

/** One caption cue of a target as a scene program sees it, in clip ms. */
export interface SceneCue {
  readonly index: number;
  readonly startMs: number;
  /** When the cue leaves: the next cue's start, or a short tail after the last word. */
  readonly endMs: number;
  /** The utterance's diarized speaker; null for dubs and unknown. */
  readonly speaker: number | null;
  readonly language: string | null;
  readonly words: readonly SceneWord[];
}

export interface SceneWord {
  /** Display text, case and punctuation as the plan formatted it. */
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly role: "hero" | "body" | "minor";
  /** Word Key; null for dub captions and demos without source times. */
  readonly key: string | null;
}

export interface SceneColours {
  readonly primary: string;
  readonly highlight: string;
  readonly accent: string;
  readonly shadow: string;
}

export interface SceneInput {
  /** Every caption cue of the target, in order. */
  readonly cues: readonly SceneCue[];
  readonly canvas: { readonly width: number; readonly height: number };
  /** The preset position; templates lay out around it. */
  readonly anchor: { readonly xPct: number; readonly yPct: number };
  readonly colours: SceneColours;
  /** The user's size scale: the preset's `fontSize` over the sample's body size. 1 = sample size. */
  readonly scale: number;
  readonly measure: Measure;
  /** The render's frame rate, for programs that plan by painted frames (`frame-grid.ts`). Programs decide timing and
   * layout from it (Trail moves a cue that would meet the next on a painted frame), so the Studio passes the clip's
   * `renderFrameRate` too. Absent, programs plan for `SCENE_DEFAULT_FPS`. */
  readonly fps?: number;
  /**
   * When the clip plays an inserted Scene Block, in time order (`sceneInputFromPreset` sets it only when there is one). The
   * clip's own speech stops there, so no piece paints inside one; programs do not read it, `buildCaptionScene` cuts the
   * pieces after the program has run.
   */
  readonly insertedScenes?: readonly SceneWindow[];
}

export interface SceneProgram {
  build(input: SceneInput): CaptionScene;
}
