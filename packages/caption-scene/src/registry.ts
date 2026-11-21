import { type CaptionPreset, type CaptionSceneName, captionSceneDefaultPositionY, captionSceneMeta } from "@narriflow/validators";
import { type DemoScript, demoCues } from "./demo";
import { memoMeasure } from "./measure-memo";
import type { CaptionScene, Measure } from "./scene";
import type { SceneCue, SceneInput, SceneProgram } from "./input";
import { BOOM_DEMO, boomProgram } from "./templates/boom";
import { BULLETIN_DEMO, bulletinProgram } from "./templates/bulletin";
import { CHROME_DEMO, chromeProgram } from "./templates/chrome";
import { DIALOGUE_DEMO, dialogueProgram } from "./templates/dialogue";
import { DOODLE_DEMO, doodleProgram } from "./templates/doodle";
import { DOSSIER_DEMO, dossierProgram } from "./templates/dossier";
import { FLAP_DEMO, flapProgram } from "./templates/flap";
import { HOLLOW_DEMO, hollowProgram } from "./templates/hollow";
import { INDEX_DEMO, indexProgram } from "./templates/index";
import { LYRICS_DEMO, lyricsProgram } from "./templates/lyrics";
import { PUNCHLINE_DEMO, punchlineProgram } from "./templates/punchline";
import { REVEAL_DEMO, revealProgram } from "./templates/reveal";
import { SIGNAL_DEMO, signalProgram } from "./templates/signal";
import { SPINE_DEMO, spineProgram } from "./templates/spine";
import { TICKER_DEMO, tickerProgram } from "./templates/ticker";
import { TRACK_DEMO, trackProgram } from "./templates/track";
import { VELOCITY_DEMO, velocityProgram } from "./templates/velocity";
import { WORDFORM_DEMO, wordformProgram } from "./templates/wordform";
import { POPUP_DEMO, popupProgram } from "./templates/popup";
import { TRAIL_DEMO, trailProgram } from "./templates/trail";
import { RANSOM_DEMO, ransomProgram } from "./templates/ransom";
import { LEDGE_DEMO, ledgeProgram } from "./templates/ledge";
import { CASCADE_DEMO, cascadeProgram } from "./templates/cascade";
import { HEFT_DEMO, heftProgram } from "./templates/heft";
import { ARTHOUSE_DEMO, arthouseProgram } from "./templates/arthouse";
import { SLICE_DEMO, sliceProgram } from "./templates/slice";
import { WALLPAPER_DEMO, wallpaperProgram } from "./templates/wallpaper";
import { HYPE_DEMO, hypeProgram } from "./templates/hype";
import { STRETCH_DEMO, stretchProgram } from "./templates/stretch";
import { BEAT_DEMO, beatProgram } from "./templates/beat";
import { TAPE_DEMO, tapeProgram } from "./templates/tape";
import { PREMIERE_DEMO, premiereProgram } from "./templates/premiere";
import { CURSOR_DEMO, cursorProgram } from "./templates/cursor";
import { VERIFIED_DEMO, verifiedProgram } from "./templates/verified";
import { WONKY_DEMO, wonkyProgram } from "./templates/wonky";
import { AURA_DEMO, auraProgram } from "./templates/aura";

/** One Scene Style: the program that draws it and the sample script its thumbnail and fixtures play. */
export interface SceneDefinition {
  readonly program: SceneProgram;
  readonly demo: DemoScript;
}

export const CAPTION_SCENE_PROGRAMS: Readonly<Record<CaptionSceneName, SceneDefinition>> = {
  lyrics: { program: lyricsProgram, demo: LYRICS_DEMO },
  dialogue: { program: dialogueProgram, demo: DIALOGUE_DEMO },
  dossier: { program: dossierProgram, demo: DOSSIER_DEMO },
  hollow: { program: hollowProgram, demo: HOLLOW_DEMO },
  signal: { program: signalProgram, demo: SIGNAL_DEMO },
  track: { program: trackProgram, demo: TRACK_DEMO },
  bulletin: { program: bulletinProgram, demo: BULLETIN_DEMO },
  ticker: { program: tickerProgram, demo: TICKER_DEMO },
  flap: { program: flapProgram, demo: FLAP_DEMO },
  index: { program: indexProgram, demo: INDEX_DEMO },
  punchline: { program: punchlineProgram, demo: PUNCHLINE_DEMO },
  doodle: { program: doodleProgram, demo: DOODLE_DEMO },
  velocity: { program: velocityProgram, demo: VELOCITY_DEMO },
  wordform: { program: wordformProgram, demo: WORDFORM_DEMO },
  chrome: { program: chromeProgram, demo: CHROME_DEMO },
  reveal: { program: revealProgram, demo: REVEAL_DEMO },
  spine: { program: spineProgram, demo: SPINE_DEMO },
  boom: { program: boomProgram, demo: BOOM_DEMO },
  aura: { program: auraProgram, demo: AURA_DEMO },
  wonky: { program: wonkyProgram, demo: WONKY_DEMO },
  verified: { program: verifiedProgram, demo: VERIFIED_DEMO },
  cursor: { program: cursorProgram, demo: CURSOR_DEMO },
  premiere: { program: premiereProgram, demo: PREMIERE_DEMO },
  tape: { program: tapeProgram, demo: TAPE_DEMO },
  beat: { program: beatProgram, demo: BEAT_DEMO },
  stretch: { program: stretchProgram, demo: STRETCH_DEMO },
  hype: { program: hypeProgram, demo: HYPE_DEMO },
  wallpaper: { program: wallpaperProgram, demo: WALLPAPER_DEMO },
  slice: { program: sliceProgram, demo: SLICE_DEMO },
  arthouse: { program: arthouseProgram, demo: ARTHOUSE_DEMO },
  heft: { program: heftProgram, demo: HEFT_DEMO },
  popup: { program: popupProgram, demo: POPUP_DEMO },
  trail: { program: trailProgram, demo: TRAIL_DEMO },
  ransom: { program: ransomProgram, demo: RANSOM_DEMO },
  ledge: { program: ledgeProgram, demo: LEDGE_DEMO },
  cascade: { program: cascadeProgram, demo: CASCADE_DEMO },
};

/** The cues a program may see: no word without text, no cue without words (the planner never makes them; a template would write NaN for one). */
export function drawableCues(cues: readonly SceneCue[]): SceneCue[] {
  const drawable: SceneCue[] = [];
  for (const cue of cues) {
    const words = cue.words.filter((word) => word.text.trim() !== "");
    if (words.length === cue.words.length) {
      if (words.length > 0) drawable.push(cue);
    } else if (words.length > 0) drawable.push({ ...cue, words });
  }
  return drawable;
}

/** The scene of `name` over `input`'s cues; its measurements are remembered for the build. */
export function buildCaptionScene(name: CaptionSceneName, input: SceneInput): CaptionScene {
  return CAPTION_SCENE_PROGRAMS[name].program.build({ ...input, cues: drawableCues(input.cues), measure: memoMeasure(input.measure) });
}

/** The cues and length (ms) of a Scene Style's sample script. */
export function captionSceneDemo(name: CaptionSceneName): { cues: SceneCue[]; duration: number } {
  return demoCues(CAPTION_SCENE_PROGRAMS[name].demo);
}

/** The scene input a Scene Style preset implies: its colours, its size over the sample's, and its anchor. */
export function sceneInputFromPreset(
  preset: CaptionPreset,
  args: {
    readonly cues: readonly SceneCue[];
    readonly canvas: { readonly width: number; readonly height: number };
    readonly measure: Measure;
    /** Where the scene is anchored, percent of the frame; the preset's own position by default. */
    readonly anchor?: { readonly xPct: number; readonly yPct: number };
  },
): SceneInput {
  const name = preset.scene;
  if (!name) throw new Error("sceneInputFromPreset needs a Scene Style preset");
  const meta = captionSceneMeta(name);
  return {
    cues: args.cues,
    canvas: args.canvas,
    anchor: args.anchor ?? { xPct: preset.positionX ?? 50, yPct: preset.positionY ?? captionSceneDefaultPositionY(name) },
    colours: { primary: preset.primaryColor, highlight: preset.highlightColor, accent: preset.accentColor ?? meta.colours.accent, shadow: preset.shadowColor },
    scale: preset.fontSize / meta.bodyPx,
    measure: args.measure,
  };
}

/**
 * What a scene is a function of, as a string: the style, its cues (times, texts, roles, keys, speakers), the canvas, the anchor, the
 * colours, the size scale and the language. Two inputs with the same key build the same scene, whatever else about the clip's
 * document changed (a volume, a logo drag), so a renderer rebuilds when the key changes and not when an object does.
 */
export function sceneBuildKey(name: CaptionSceneName, input: Omit<SceneInput, "measure">, language: string | null): string {
  const { canvas, anchor, colours, scale } = input;
  return JSON.stringify([
    name,
    language,
    canvas.width,
    canvas.height,
    anchor.xPct,
    anchor.yPct,
    colours.primary,
    colours.highlight,
    colours.accent,
    colours.shadow,
    scale,
    input.cues.map((cue) => [cue.index, cue.startMs, cue.endMs, cue.speaker, cue.language, cue.words.map((word) => [word.text, word.startMs, word.endMs, word.role, word.key])]),
  ]);
}

/** A time (ms into the sample) at which the still of a Scene Style reads best: its first hero cue once that cue's last word is spoken. */
export function captionSceneStillMs(name: CaptionSceneName): number {
  const { cues } = captionSceneDemo(name);
  const cue = cues.find((candidate) => candidate.words.some((word) => word.role === "hero")) ?? cues[0]!;
  return Math.min(cue.endMs - 60, cue.words[cue.words.length - 1]!.endMs + 450);
}
