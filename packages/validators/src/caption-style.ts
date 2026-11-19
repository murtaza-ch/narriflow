/**
 * The caption look specification, shared by the Studio preview
 * (caption-style-engine.tsx, CSS + Web Animations) and the worker burn-in
 * (caption-ass.ts, libass). Both renderers derive every motion and every
 * decoration from these numbers — never fork them in a renderer.
 *
 * Units: `*Em` values are multiples of the caption font size; `at` values are
 * milliseconds from the moment a word becomes active (or a cue appears).
 */

export type CaptionEase = "linear" | "out" | "in";

/**
 * One keyframe of a word entrance. A property animates between the keyframes
 * that set it; `ease` shapes the segment that ENDS at this keyframe. libass
 * renders an ease as a `\t` acceleration (out = 0.5, in = 2); the preview
 * samples the same power curve, so both follow one curve.
 * `offsetXEm` and `offsetYEm` move through one `\move` per event, which
 * libass interpolates linearly, so keep their segments linear and give x and
 * y travel the same window. `offsetXEm` is multiplied by the word's
 * `motionSign` (Caption Blocks, caption-block.ts), so a staggered row can
 * enter from either side. `rotateZDeg` is clockwise, about the word's centre.
 */
export interface CaptionKeyframe {
  readonly at: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly opacity?: number;
  readonly offsetXEm?: number;
  readonly offsetYEm?: number;
  readonly blurEm?: number;
  readonly rotateXDeg?: number;
  readonly rotateZDeg?: number;
  readonly ease?: CaptionEase;
}

export type CaptionKeyframeProperty = Exclude<keyof CaptionKeyframe, "at" | "ease">;

export const CAPTION_EASE_ACCEL: Record<CaptionEase, number> = {
  linear: 1,
  out: 0.5,
  in: 2,
};

/** Progress through a segment under the libass power curve. */
export function captionEaseProgress(ease: CaptionEase | undefined, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped ** CAPTION_EASE_ACCEL[ease ?? "linear"];
}

export interface CaptionMotionSpec {
  readonly label: string;
  /** "cue": the whole cue shows at once; "word": words appear as spoken. */
  readonly reveal: "cue" | "word";
  /** Entrance of the active word, played when it becomes active. */
  readonly word: readonly CaptionKeyframe[];
  /** Entrance of a Caption Block's hero words; other block words use `word`. Absent = `word`. */
  readonly hero?: readonly CaptionKeyframe[];
  /** Fade-in of a new cue (cue-reveal motions). */
  readonly cueFadeMs: number;
  /** Opacity of not-yet-spoken words in cue-reveal motions. */
  readonly upcomingOpacity: number;
  /** Tilt every cue by `CAPTION_CUE_TILTS_DEG` (playful styles). */
  readonly tilt: boolean;
  /** Cue opacity steps played when a cue appears (neon sign flicker). */
  readonly flicker?: readonly { readonly at: number; readonly opacity: number }[];
  /** Effects with their own renderer path in both engines. */
  readonly effect?: "karaoke" | "typewriter" | "glitch";
}

const scale = (at: number, value: number, ease?: CaptionEase): CaptionKeyframe => ({
  at,
  scaleX: value,
  scaleY: value,
  ...(ease ? { ease } : {}),
});

export const CAPTION_MOTIONS = {
  none: { label: "Static", reveal: "cue", word: [], cueFadeMs: 0, upcomingOpacity: 1, tilt: false },
  pop: {
    label: "Pop",
    reveal: "cue",
    word: [scale(0, 1), scale(90, 1.14, "out"), scale(220, 1)],
    cueFadeMs: 100,
    upcomingOpacity: 1,
    tilt: false,
  },
  focus: { label: "Focus", reveal: "cue", word: [], cueFadeMs: 100, upcomingOpacity: 0.45, tilt: false },
  karaoke: {
    label: "Sweep",
    reveal: "cue",
    word: [],
    cueFadeMs: 100,
    upcomingOpacity: 1,
    tilt: false,
    effect: "karaoke",
  },
  neon: {
    label: "Flicker",
    reveal: "cue",
    word: [],
    cueFadeMs: 0,
    upcomingOpacity: 1,
    tilt: false,
    flicker: [
      { at: 0, opacity: 0 },
      { at: 55, opacity: 1 },
      { at: 92, opacity: 0.15 },
      { at: 156, opacity: 1 },
      { at: 230, opacity: 0.45 },
      { at: 285, opacity: 1 },
    ],
  },
  rise: {
    label: "Rise",
    reveal: "word",
    word: [
      { at: 0, offsetYEm: 0.32, opacity: 0 },
      { at: 140, opacity: 1 },
      { at: 200, offsetYEm: 0 },
    ],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: false,
  },
  blur: {
    label: "Blur",
    reveal: "word",
    word: [
      { at: 0, blurEm: 0.12, opacity: 0 },
      { at: 280, blurEm: 0, opacity: 1, ease: "out" },
    ],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: false,
  },
  punch: {
    label: "Punch",
    reveal: "word",
    word: [
      { at: 0, scaleX: 1.45, scaleY: 1.45, opacity: 0 },
      { at: 60, opacity: 1 },
      { at: 170, scaleX: 1, scaleY: 1, ease: "out" },
    ],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: false,
  },
  bounce: {
    label: "Bounce",
    reveal: "word",
    word: [
      { at: 0, scaleX: 0.4, scaleY: 0.4, opacity: 0 },
      { at: 165, scaleX: 1.18, scaleY: 1.18, opacity: 1, ease: "out" },
      scale(240, 0.96),
      scale(300, 1),
    ],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: true,
  },
  jelly: {
    label: "Jelly",
    reveal: "word",
    word: [
      { at: 0, scaleX: 1.4, scaleY: 0.55, opacity: 0 },
      { at: 115, scaleX: 0.82, scaleY: 1.22, opacity: 1, ease: "out" },
      { at: 210, scaleX: 1.1, scaleY: 0.92 },
      { at: 296, scaleX: 0.97, scaleY: 1.03 },
      { at: 380, scaleX: 1, scaleY: 1 },
    ],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: true,
  },
  flip: {
    label: "Flip",
    reveal: "word",
    word: [
      { at: 0, rotateXDeg: -95, opacity: 0 },
      { at: 65, opacity: 1 },
      { at: 260, rotateXDeg: 0, ease: "out" },
    ],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: false,
  },
  glitch: {
    label: "Glitch",
    reveal: "word",
    word: [],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: false,
    effect: "glitch",
  },
  fade: {
    label: "Fade",
    reveal: "word",
    word: [
      { at: 0, opacity: 0 },
      { at: 140, opacity: 1 },
    ],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: false,
  },
  slide: {
    label: "Slide",
    reveal: "word",
    word: [
      { at: 0, offsetXEm: -0.18, opacity: 0 },
      { at: 40, opacity: 1 },
      { at: 90, offsetXEm: 0 },
    ],
    hero: [
      { at: 0, offsetYEm: 0.12, blurEm: 0.04, opacity: 0 },
      { at: 40, opacity: 1 },
      { at: 100, blurEm: 0, ease: "out" },
      { at: 150, offsetYEm: 0 },
    ],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: false,
  },
  slam: {
    label: "Slam",
    reveal: "word",
    word: [
      { at: 0, scaleX: 1.08, scaleY: 1.08, opacity: 0 },
      { at: 40, opacity: 1 },
      { at: 80, scaleX: 1, scaleY: 1, ease: "out" },
    ],
    hero: [
      { at: 0, scaleX: 1.25, scaleY: 1.25, opacity: 0 },
      { at: 40, opacity: 1 },
      { at: 110, scaleX: 0.98, scaleY: 0.98, ease: "out" },
      scale(160, 1),
    ],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: false,
  },
  drop: {
    label: "Drop",
    reveal: "word",
    // The hero drops the same way (no `hero` track).
    word: [
      { at: 0, offsetYEm: -0.2, rotateZDeg: -4, opacity: 0 },
      { at: 40, opacity: 1 },
      // 90 ms: supporting words settle within spec 6 rule 6 (ticket 06b; was 120).
      { at: 90, offsetYEm: 0, rotateZDeg: 0 },
    ],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: false,
  },
  typewriter: {
    label: "Typewriter",
    reveal: "word",
    word: [],
    cueFadeMs: 0,
    upcomingOpacity: 0,
    tilt: false,
    effect: "typewriter",
  },
} as const satisfies Record<string, CaptionMotionSpec>;

export type CaptionAnimationName = keyof typeof CAPTION_MOTIONS;

export const CAPTION_ANIMATION_NAMES = Object.keys(CAPTION_MOTIONS) as [
  CaptionAnimationName,
  ...CaptionAnimationName[],
];

export function captionMotion(animation: CaptionAnimationName): CaptionMotionSpec {
  return CAPTION_MOTIONS[animation];
}

/** Rotation (degrees, clockwise) of cue N in tilting styles: cue N uses entry N % 4. */
export const CAPTION_CUE_TILTS_DEG = [-2.5, 2, -1.5, 2.5] as const;

/** A cue wider than this fraction of the frame is scaled down to fit. */
export const CAPTION_FIT_WIDTH_FRACTION = 0.88;

/** Rounded box behind the active word (`highlightBoxColor`). */
export const CAPTION_PILL = {
  padXEm: 0.13,
  /** Above the cap height. */
  padTopEm: 0.2,
  /** Below the baseline. */
  padBottomEm: 0.22,
  radiusEm: 0.22,
  /** Added to every space so pills never touch their neighbours. */
  extraWordSpacingEm: 0.14,
  enter: [
    { at: 0, scaleX: 0.82, scaleY: 0.82, opacity: 0 },
    { at: 130, scaleX: 1, scaleY: 1, opacity: 1, ease: "out" },
  ] satisfies readonly CaptionKeyframe[],
} as const;

/** Rounded plate behind the whole cue (`backgroundColor`). */
export const CAPTION_PLATE = {
  padXEm: 0.4,
  padTopEm: 0.36,
  padBottomEm: 0.34,
  radiusEm: 0.3,
} as const;

export const CAPTION_SOFT_SHADOW = {
  offsetYEm: 0.035,
  /** Gaussian standard deviation. */
  blurEm: 0.065,
  opacity: 0.92,
} as const;

export const CAPTION_HARD_SHADOW = { offsetXEm: 0.07, offsetYEm: 0.08 } as const;

/** Solid 3D extrusion: `steps` hard copies, each `stepEm` further down-right. */
export const CAPTION_EXTRUDE = { stepEm: 0.016, steps: 6 } as const;

/**
 * Glow is two blurred copies of the glyphs in the glow colour. Their Gaussian
 * standard deviations are these multiples of `glowIntensity` (canvas px).
 */
export const CAPTION_GLOW_SIGMAS = [0.5, 1.1] as const;

/** RGB-split glitch: three jitter steps, then the split holds while active. */
export const CAPTION_GLITCH = {
  stepMs: 80,
  ghostColors: ["#00F0FF", "#FF2A6D"],
  ghostOpacity: 0.9,
  heldGhostOpacity: 0.75,
  /** Ghost A offset (ghost B mirrors it), text x-jitter and shear per step. */
  steps: [
    { ghostEm: [-0.06, 0.012], textDxEm: 0.03, shear: -0.14 },
    { ghostEm: [0.042, -0.024], textDxEm: -0.024, shear: 0.09 },
    { ghostEm: [-0.03, 0.006], textDxEm: 0, shear: 0 },
  ],
  heldGhostEm: [-0.048, 0],
} as const;

/** Typewriter: letters of the active word appear this far apart, at most. */
export const CAPTION_TYPEWRITER_MAX_LETTER_MS = 55;

/** Delay (ms) before each letter of a typewriter word appears. */
export function captionTypewriterLetterDelays(letterCount: number, wordDurationMs: number): number[] {
  if (letterCount <= 0) return [];
  const step = Math.min(CAPTION_TYPEWRITER_MAX_LETTER_MS, wordDurationMs / letterCount);
  return Array.from({ length: letterCount }, (_, index) => Math.round(step * index));
}

/**
 * Value of one keyframed property at `atMs`, holding the first/last values
 * outside the keyframes. Returns `undefined` when no keyframe sets it.
 */
export function captionKeyframeValue(
  keyframes: readonly CaptionKeyframe[],
  property: CaptionKeyframeProperty,
  atMs: number,
): number | undefined {
  const track = keyframes.filter((frame) => frame[property] !== undefined);
  if (track.length === 0) return undefined;
  const first = track[0]!;
  if (atMs <= first.at) return first[property];
  for (let index = 1; index < track.length; index++) {
    const from = track[index - 1]!;
    const to = track[index]!;
    if (atMs <= to.at) {
      const span = Math.max(1, to.at - from.at);
      const progress = captionEaseProgress(to.ease, (atMs - from.at) / span);
      return from[property]! + (to[property]! - from[property]!) * progress;
    }
  }
  return track[track.length - 1]![property];
}

/** A word's entrance pose at one instant: what both painters draw (`captionEntrancePose`). Offsets and blur are em of the word's size. */
export interface CaptionEntrancePose {
  readonly opacity: number;
  readonly offsetXEm: number;
  readonly offsetYEm: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly blurEm: number;
  readonly rotateXDeg: number;
  readonly rotateZDeg: number;
}

export const CAPTION_REST_POSE: CaptionEntrancePose = {
  opacity: 1,
  offsetXEm: 0,
  offsetYEm: 0,
  scaleX: 1,
  scaleY: 1,
  blurEm: 0,
  rotateXDeg: 0,
  rotateZDeg: 0,
};

/**
 * The window of the one `\move` that carries a word's travel: from the earliest first to the
 * latest last keyframe of its offset tracks (a track needs two keyframes to move). Null when
 * nothing travels.
 */
export function captionTravelWindow(keyframes: readonly CaptionKeyframe[]): { readonly startMs: number; readonly endMs: number } | null {
  const tracks = (["offsetXEm", "offsetYEm"] as const)
    .map((property) => keyframes.filter((frame) => frame[property] !== undefined))
    .filter((track) => track.length >= 2);
  if (tracks.length === 0) return null;
  return {
    startMs: Math.min(...tracks.map((track) => track[0]!.at)),
    endMs: Math.max(...tracks.map((track) => track[track.length - 1]!.at)),
  };
}

const linearBetween = (from: number, to: number, startMs: number, endMs: number, atMs: number) =>
  from + (to - from) * Math.max(0, Math.min(1, (atMs - startMs) / Math.max(1, endMs - startMs)));

/**
 * The pose a word shows `atMs` after its entrance starts, as libass can draw it, so the
 * Studio samples exactly what the worker writes:
 * - opacity is linear from its first to its last keyframe (one `\fade`), whatever the keyframes' ease;
 * - offsets are linear from each track's first to its last value over the shared
 *   `captionTravelWindow` (one `\move` for x and y);
 * - scale, blur and turns follow their keyframes segment by segment with each segment's ease
 *   (one `\t` per segment, the libass power curve).
 * A track with a single keyframe holds its value; a property no keyframe sets is at rest.
 */
export function captionEntrancePose(keyframes: readonly CaptionKeyframe[], atMs: number): CaptionEntrancePose {
  const track = (property: CaptionKeyframeProperty) => keyframes.filter((frame) => frame[property] !== undefined);
  const ends = (property: CaptionKeyframeProperty) => {
    const frames = track(property);
    return frames.length === 0 ? null : { first: frames[0]!, last: frames[frames.length - 1]! };
  };
  const opacity = ends("opacity");
  const window = captionTravelWindow(keyframes);
  const travel = (property: "offsetXEm" | "offsetYEm") => {
    const frames = ends(property);
    if (!frames) return 0;
    if (!window || frames.first === frames.last) return frames.first[property]!;
    return linearBetween(frames.first[property]!, frames.last[property]!, window.startMs, window.endMs, atMs);
  };
  const eased = (property: CaptionKeyframeProperty) => captionKeyframeValue(keyframes, property, atMs) ?? CAPTION_REST_POSE[property];
  return {
    opacity: opacity
      ? linearBetween(opacity.first.opacity!, opacity.last.opacity!, opacity.first.at, opacity.last.at, atMs)
      : 1,
    offsetXEm: travel("offsetXEm"),
    offsetYEm: travel("offsetYEm"),
    scaleX: eased("scaleX"),
    scaleY: eased("scaleY"),
    blurEm: eased("blurEm"),
    rotateXDeg: eased("rotateXDeg"),
    rotateZDeg: eased("rotateZDeg"),
  };
}

/** The keyframes a word of a Caption Block enters with: hero words use `hero ?? word`, others `word`. */
export function captionEntranceKeyframes(motion: CaptionMotionSpec, hero: boolean): readonly CaptionKeyframe[] {
  return hero ? motion.hero ?? motion.word : motion.word;
}

/** Length of an entrance: its last keyframe time, ms. */
export function captionEntranceMs(keyframes: readonly CaptionKeyframe[]): number {
  return keyframes.reduce((longest, frame) => Math.max(longest, frame.at), 0);
}

/** Below this much cue time left at a word's onset, the word appears settled. */
export const CAPTION_ENTRANCE_MIN_REMAINING_MS = 100;

/** An entrance may use at most this fraction of the cue time left at the word's onset. */
export const CAPTION_ENTRANCE_MAX_SHARE = 0.45;

/**
 * Duration cap for Caption Block entrances (spec 5.7): every keyframe time of
 * a word is multiplied by this factor, `min(1, 0.45 × remainingCueMs /
 * entranceMs, gapToNextOnsetMs / entranceMs)`, so an entrance ends before
 * the next word of the cue is spoken. The last word of a cue passes no gap.
 * 0 means "draw the word settled": less than 100 ms of the cue is left, the
 * next word starts with it, or the entrance has no length.
 */
export function captionEntranceTimeScale(remainingCueMs: number, entranceMs: number, gapToNextOnsetMs?: number): number {
  if (remainingCueMs < CAPTION_ENTRANCE_MIN_REMAINING_MS || entranceMs <= 0) return 0;
  const gap = gapToNextOnsetMs === undefined ? Infinity : Math.max(0, gapToNextOnsetMs);
  return Math.min(1, (CAPTION_ENTRANCE_MAX_SHARE * remainingCueMs) / entranceMs, gap / entranceMs);
}
