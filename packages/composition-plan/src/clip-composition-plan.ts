import {
  applyCaptionTextTransform,
  assignCaptionRoles,
  captionBlockRows,
  captionBlockSeed,
  captionBlockWordsPerCue,
  captionDynamicStyle,
  captionSceneDefaultPositionY,
  captionSceneMeta,
  type CaptionWordRole,
  captionRoleLook,
  captionSoftBreaks,
  captionWordIsMinor,
  captionWordKey,
  CAPTION_POSITION_Y_DEFAULTS,
  CLIP_AUTO_LAYOUT_MAX_SEGMENTS,
  CLIP_AUTO_LAYOUT_VERSION,
  CLIP_SPLIT_LAYOUT_MAX_SEGMENTS,
  DUCKING_DEFAULTS,
  buildClipCutPlan,
  capDuckingWindows,
  clipAutoLayoutMatchesInputs,
  computeSpeechWindows,
  extractSpeechWordIntervals,
  formatCaptionWord,
  groupCaptionTokens,
  isNoSpaceScriptChar,
  joinTranscriptWords,
  autoCensorWordId,
  censoredCaptionWordText,
  normalizeCensorAudioSchedule,
  resolveMusicFadeWindows,
  resolveEffectiveFramingMode,
  resolveSpeakerLayoutScene,
  sceneLayoutPresetNeedsAutomaticEvidence,
  sceneLayoutSelectionAt,
  SCENE_LAYOUT_MIN_DURATION_SEC,
  SCREEN_LAYOUT_ENGINE_VERSION,
  sourceRangeToEdited,
  sourceWordToEdited,
  type CaptionBlock,
  type CaptionCueRoles,
  type CaptionEmojiRef,
  type CaptionEmphasisWord,
  type CaptionPreset,
  type ClipAspectRatio,
  type ClipAutoLayoutAnalysis,
  type ClipAutoLayoutSegment,
  type ClipAutoLayoutSubject,
  type ClipSplitLayoutSegment,
  type EditorDocument,
  type EditedTimeMap,
  type SceneBlock,
  type SceneContent,
  type EffectiveLogoSettings,
  type LogoPosition,
  type SpeakerLayerRole,
  type SpeakerLayerTransform,
  type SceneLayoutPreset,
  type StudioSceneLayoutSelection,
  type StudioTextLayer,
  type TranscriptWord,
} from "@narriflow/validators";
import {
  attachCaptionEmojis,
  captionEmojisByWord,
  captionEmojiWordId,
  dubCaptionEmojis,
  type PendingCaptionEmoji,
} from "./caption-emoji-plan";
import {
  planMediaMotion,
  planTransitionMotion,
  type CompositionMotionPlan,
} from "./motion-plan";
import {
  resolveSceneLayoutPresetTemplate,
  sceneLayoutPresetDefinition,
  sceneLayoutPresetShowsBackground,
  type SceneLayoutLayerMask,
} from "./scene-layout-presets";

export { SCENE_LAYOUT_PRESET_CATALOG } from "./scene-layout-presets";

export const CLIP_COMPOSITION_PLAN_VERSION = 1 as const;
export const CLIP_COMPOSITION_MAX_TARGETS = 4;
export const CLIP_COMPOSITION_MAX_SERIALIZED_BYTES = 1024 * 1024;
export const CLIP_AUDIO_FADE_IN_SEC = 0.04;
export const CLIP_AUDIO_FADE_OUT_SEC = 0.12;
export const SCENE_CONTINUITY_EPSILON_SEC = 0.075;

export type CompositionMode =
  | "auto"
  | "center"
  | "fit"
  | "split"
  | "screen"
  | "audiogram";

export interface CompositionSourceFacts {
  readonly identity: string;
  readonly kind: "video" | "audio";
  readonly width: number;
  readonly height: number;
  readonly hasAudio?: boolean;
}

export interface CompositionTarget {
  readonly id: string;
  readonly aspectRatio: ClipAspectRatio;
  readonly width: number;
  readonly height: number;
  readonly outputTreatment?: {
    readonly resolution: "720p" | "1080p";
    readonly watermark: boolean;
  };
}

export type CompositionAssetAvailability =
  | { readonly state: "missing" | "pending" | "failed" }
  | {
      readonly state: "available";
      readonly ref: string;
      /** Known decoded duration for audio assets. Visual assets omit it. */
      readonly durationSec?: number;
    };

export type CompositionSoundEffectAvailability =
  | { readonly state: "missing" | "pending" | "failed" }
  | {
      readonly state: "available";
      readonly ref: string;
      /** Required decoded duration keeps the planned stop authoritative. */
      readonly durationSec: number;
    };

export type CompositionLogoAvailability =
  | { readonly state: "missing" | "pending" | "failed" }
  | {
      readonly state: "available";
      readonly ref: string;
      readonly settings: EffectiveLogoSettings;
    };

export interface CompositionBrollPlacement {
  readonly id: string;
  readonly ref: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly kind?: "video" | "image";
}

export type CompositionBrollAvailability =
  | { readonly state: "missing" | "pending" | "failed" }
  | {
      readonly state: "available";
      readonly placements: readonly CompositionBrollPlacement[];
    };

export type AutomaticLayoutEvidenceAvailability =
  | { readonly state: "missing" | "pending" | "failed" | "disabled" }
  | {
      readonly state: "available";
      readonly value: AutomaticLayoutEvidence;
    };

export interface AutomaticLayoutEvidence {
  readonly sourceIdentity: string;
  readonly inputFingerprint: string;
  readonly engineVersion: string;
  readonly analysis: ClipAutoLayoutAnalysis;
}

export type CompositionEvidenceAvailability<T, TFailureReason extends string = string> =
  | { readonly state: "missing" | "pending" | "disabled" }
  | { readonly state: "failed"; readonly reason?: TFailureReason }
  | { readonly state: "available"; readonly value: T };

export type SplitLayoutFailureReason =
  | "disabled"
  | "broll_conflict"
  | "detection_unavailable"
  | "insufficient_clusters"
  | "empty_plan"
  | "no_two_up_segments"
  | "tiles_not_distinct";

export type ScreenLayoutFailureReason =
  | "disabled"
  | "broll_conflict"
  | "analysis_unavailable"
  | "detection_unavailable"
  | "no_face_detected"
  | "no_trustworthy_faces";

export interface SplitLayoutEvidence {
  readonly sourceIdentity: string;
  readonly inputFingerprint: string;
  readonly engineVersion: string;
  readonly source:
    | "explicit-detector"
    | "durable-explicit"
    | "automatic-layout";
  readonly segments: readonly ClipSplitLayoutSegment[];
  readonly fallbackSegments: readonly ClipSplitLayoutSegment[];
}

export interface ScreenLayoutEvidence {
  readonly sourceIdentity: string;
  readonly inputFingerprint: string;
  readonly engineVersion: string;
  readonly source: "durable-pip" | "analysis";
  readonly pictureInPicture:
    | {
        readonly state: "confirmed";
        readonly rect: {
          readonly x: number;
          readonly y: number;
          readonly width: number;
          readonly height: number;
        };
      }
    | { readonly state: "unavailable" };
  readonly faceBand:
    | {
      readonly state: "available";
      readonly segments: readonly ClipSplitLayoutSegment[];
      }
    | { readonly state: "unavailable" };
}

/** Words on the edited timeline (before inserted scene blocks) that replace
 * the transcript as the caption and ducking source, one array per sentence.
 * A dub supplies its target-language words; cues never straddle a sentence. */
export interface CaptionOverride {
  readonly language: string;
  readonly segments: readonly (readonly {
    readonly text: string;
    readonly spaceBefore?: boolean;
    readonly startSec: number;
    readonly endSec: number;
  }[])[];
}

export interface ClipCompositionPlanInput {
  readonly document: EditorDocument;
  /** Effective caption language: the transcript's language, else the project's
   * requested one. Carried onto every caption layer. */
  readonly captionLanguage?: string | null;
  /** Target-language caption words in edited time. When present they replace
   * the transcript for captions (censor masks do not apply) and music ducking,
   * and their language replaces `captionLanguage`. */
  readonly captionOverride?: CaptionOverride;
  readonly source: CompositionSourceFacts;
  readonly evidence: {
    readonly framingDegraded?: {
      readonly attempts: number;
      readonly causeCode: string;
      readonly modes: readonly ("auto" | "screen" | "split")[];
    };
    readonly automaticLayout: AutomaticLayoutEvidenceAvailability;
    readonly splitLayout?: CompositionEvidenceAvailability<
      SplitLayoutEvidence,
      SplitLayoutFailureReason
    >;
    readonly screenLayout?: CompositionEvidenceAvailability<
      ScreenLayoutEvidence,
      ScreenLayoutFailureReason
    >;
  };
  readonly assets: {
    readonly backgroundImage: CompositionAssetAvailability;
    /** Omitted when the document has no requested or automatically selected
     * B-roll. A present non-available value means optional B-roll was
     * requested but could not yet be resolved. */
    readonly broll?: CompositionBrollAvailability;
    readonly logo?: CompositionLogoAvailability;
    /** Keyed by Music Block id, like `soundEffects` by placement id. */
    readonly music?: Readonly<Record<string, CompositionAssetAvailability>>;
    readonly soundEffects?: Readonly<
      Record<string, CompositionSoundEffectAvailability>
    >;
		readonly sceneVisuals?: Readonly<Record<string, CompositionAssetAvailability>>;
		readonly sceneFonts?: Readonly<Record<string, CompositionAssetAvailability>>;
  };
  readonly capabilities: {
    readonly automaticSpeakerLayout: boolean;
    readonly automaticSpeakerEngineVersion: string;
    readonly explicitSplitLayout?: boolean;
    readonly splitEngineVersion?: string;
    readonly screenLayout?: boolean;
    readonly screenEngineVersion?: string;
  };
  readonly targets: readonly CompositionTarget[];
}

export interface CompositionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CompositionCropKeyframe extends CompositionRect {
  readonly timeSec: number;
}

export interface CompositionSourceVideoLayer {
  readonly id: string;
  readonly kind: "source-video";
  readonly sourceRef: string;
  readonly sourceCrop: CompositionRect;
  /** Present only for automatic, non-overridden within-shot tracking. */
  readonly sourceCropTrack?: readonly CompositionCropKeyframe[];
  readonly destination: CompositionRect;
  readonly fit: "cover" | "contain";
  readonly rotationDeg: number;
  readonly opacity: number;
  readonly zIndex: number;
  readonly mask?: SceneLayoutLayerMask;
  readonly speaker?: {
    readonly role: SpeakerLayerRole;
    readonly transform: SpeakerLayerTransform;
    readonly defaultTransform: SpeakerLayerTransform;
    readonly overrideId: string | null;
    readonly subjectId?: string;
  };
}

/** Preview and FFmpeg use this same linear interpolation. Tracks never cross
 * scene boundaries, so a source cut remains an instant cut. */
export function interpolateCompositionCropTrack(
  crop: CompositionRect,
  track: readonly CompositionCropKeyframe[] | undefined,
  timeSec: number,
): CompositionRect {
  if (!track || track.length === 0) return crop;
  if (timeSec <= track[0]!.timeSec) return track[0]!;
  const last = track[track.length - 1]!;
  if (timeSec >= last.timeSec) return last;
  const rightIndex = track.findIndex((keyframe) => keyframe.timeSec >= timeSec);
  const right = track[rightIndex]!;
  const left = track[rightIndex - 1]!;
  const fraction = (timeSec - left.timeSec) / (right.timeSec - left.timeSec);
  const lerp = (a: number, b: number) => a + (b - a) * fraction;
  return {
    x: lerp(left.x, right.x),
    y: lerp(left.y, right.y),
    width: lerp(left.width, right.width),
    height: lerp(left.height, right.height),
  };
}

export interface CompositionBackgroundLayer {
  readonly id: string;
  readonly kind: "background";
  readonly color: string;
  readonly imageRef: string | null;
  readonly destination: CompositionRect;
  readonly fit: "cover";
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: number;
}

export interface CompositionBrollVideoLayer {
  readonly id: string;
  readonly kind: "broll-video";
  readonly sourceRef: string;
  readonly activeRange: {
    readonly startSec: number;
    readonly endSec: number;
  };
  readonly destination: CompositionRect;
  readonly fit: "cover";
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: number;
  readonly motion: CompositionMotionPlan | null;
  /** Existing Narriflow behavior keeps dialogue from the source and discards
   * B-roll audio. The plan states that choice so neither adapter decides it. */
  readonly audio: "source";
}

export interface CompositionBrollImageLayer {
  readonly id: string;
  readonly kind: "broll-image";
  readonly sourceRef: string;
  readonly activeRange: {
    readonly startSec: number;
    readonly endSec: number;
  };
  readonly destination: CompositionRect;
  readonly fit: "cover";
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: number;
  readonly motion: CompositionMotionPlan | null;
}

export interface CompositionAudiogramLayer {
  readonly id: string;
  readonly kind: "audiogram";
  readonly sourceRef: string;
  readonly destination: CompositionRect;
  readonly backgroundColor: "#0F172A";
  readonly waveformColor: string;
  readonly waveformHeightRatio: 0.42;
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: 0;
}

export interface CompositionInsertedSceneLayer {
  readonly id: string;
  readonly kind: "inserted-scene";
  readonly sceneBlockId: string;
  readonly content: SceneContent;
  readonly textRender: CompositionSceneTextRender | null;
  readonly motion: CompositionMotionPlan | null;
  readonly sourceRef: string | null;
  readonly destination: CompositionRect;
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: 25;
}

export interface CompositionSceneTextRender {
  readonly lines: readonly string[];
  readonly fontSizePx: number;
  readonly lineHeightPx: number;
  readonly maxWidthPx: number;
}

export function assertCompositionSceneTextRender(
  render: unknown,
  canvas: { readonly width: number; readonly height: number },
): asserts render is CompositionSceneTextRender {
  if (!render || typeof render !== "object") {
    throw new Error("invalid_clip_composition_scene_text");
  }
  const candidate = render as Partial<CompositionSceneTextRender>;
  if (
    !Array.isArray(candidate.lines) ||
    candidate.lines.length === 0 ||
    candidate.lines.some(
      (line) => typeof line !== "string" || line.length === 0 || /[\r\n]/u.test(line),
    ) ||
    !Number.isInteger(candidate.fontSizePx) ||
    !Number.isInteger(candidate.lineHeightPx) ||
    !Number.isInteger(candidate.maxWidthPx) ||
    candidate.fontSizePx! <= 0 ||
    candidate.lineHeightPx! < candidate.fontSizePx! ||
    candidate.maxWidthPx! <= 0 ||
    candidate.maxWidthPx! > canvas.width ||
    candidate.lines.length * candidate.lineHeightPx! > canvas.height
  ) {
    throw new Error("invalid_clip_composition_scene_text");
  }
}

export type CompositionLayer =
  | CompositionSourceVideoLayer
  | CompositionBackgroundLayer
  | CompositionBrollVideoLayer
  | CompositionBrollImageLayer
  | CompositionAudiogramLayer
  | CompositionInsertedSceneLayer;

export interface CompositionActiveRange {
  readonly startSec: number;
  readonly endSec: number;
}

export interface CompositionTextVisualLayer {
  readonly id: string;
  readonly kind: "text";
  readonly activeRange: CompositionActiveRange;
  readonly anchor: { readonly xPct: number; readonly yPct: number };
  readonly destination: CompositionRect;
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: 30;
  readonly value: StudioTextLayer;
}

export interface CompositionCaptionWord {
  readonly text: string;
  /** The provider's spacing before this word; absent when unknown. */
  readonly spaceBefore?: boolean;
  readonly startSec: number;
  readonly endSec: number;
}

/** A Caption Emoji on a cue: the catalog id, the skin tone, and when it appears (edited seconds). */
export interface CompositionCaptionEmoji {
  readonly id: string;
  readonly tone?: number;
  readonly atSec: number;
  /**
   * Its place among the target's emojis in time order, from 0. The sticker's tilt alternates by
   * it, so a renderer that places one cue's emojis at a time turns each as the whole target does.
   */
  readonly order: number;
}

/** A cue laid out as rows of role-typed words (Dynamic Styles); see `CaptionBlock`. */
export type CompositionCaptionBlock = CaptionBlock;

export interface CompositionCaptionVisualLayer {
  readonly id: string;
  readonly kind: "caption";
  readonly activeRange: CompositionActiveRange;
  readonly anchor: { readonly xPct: number; readonly yPct: number };
  readonly destination: CompositionRect;
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: 40;
  readonly cueIndex: number;
  readonly words: readonly CompositionCaptionWord[];
  /**
   * The cue's Caption Emojis in time order, for every preset kind; empty when the preset's
   * `emojis` is off. An emoji's word decides its cue; a cue that already shows a typed emoji
   * takes none. Subtitles never read them.
   */
  readonly emojis: readonly CompositionCaptionEmoji[];
  readonly preset: CaptionPreset;
  /** Effective caption language (transcript language, else the requested one):
   * casing, fonts and direction read it. Null when neither is known. */
  readonly language: string | null;
  /** Present only for a Dynamic Style preset and a timed cue. Subtitles and the
   * clip timeline read `words[].text`, never `block.texts`. */
  readonly block?: CompositionCaptionBlock;
  /** Present only for a Scene Style preset and a timed cue: what the scene program reads of this cue. */
  readonly scene?: CompositionCaptionScene;
}

/** A cue of a Scene Style: roles parallel to `words`, Word Keys, and the utterance's diarized speaker. */
export interface CompositionCaptionScene {
  readonly roles: readonly CaptionWordRole[];
  /** Word Keys parallel to `words`; null for dub captions. */
  readonly keys: readonly (string | null)[];
  /** The utterance's speaker; null for dubs and when diarization is off. */
  readonly speaker: number | null;
}

export interface CompositionLogoVisualLayer {
  readonly id: string;
  readonly kind: "logo";
  readonly sourceRef: string;
  readonly activeRange: CompositionActiveRange;
  readonly destination: CompositionRect;
  readonly position: LogoPosition;
  readonly marginPx: 24;
  readonly widthPx: number;
  readonly rotationDeg: 0;
  readonly opacity: number;
  readonly zIndex: 50;
}

export interface CompositionTransitionVisualLayer {
  readonly id: string;
  readonly kind: "transition";
  readonly activeRange: CompositionActiveRange;
  readonly destination: CompositionRect;
  readonly transition: EditorDocument["studioEdits"]["transition"]["type"];
  readonly application: "overlay" | "source";
  readonly color: "black" | "white";
  readonly motion: CompositionMotionPlan;
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: 60;
}

/** The one committed Free-plan badge (`assets/watermark-badge.png`). The
 * index never imports the image itself, so this stays safe for the browser
 * and the Worker; each adapter loads the file and checks it against these. */
export const NARRIFLOW_WATERMARK_ART = {
  id: "narriflow-badge-1",
  width: 940,
  height: 446,
  sha256: "e5ede2c73284d6e487fb3a1376d5362c9d955115e1e29a864a956f9badf4143c",
} as const;

/** The frame size after the output treatment's scale. For 720p this is
 * exactly what the export's `scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2`
 * produces from the 1080p canvas. */
export function compositionOutputSize(
  canvas: { readonly width: number; readonly height: number },
  resolution: "720p" | "1080p",
): { width: number; height: number } {
  if (resolution === "1080p") return { width: canvas.width, height: canvas.height };
  const side = (n: number) => 2 * Math.floor((n * 2) / 3 / 2);
  return { width: side(canvas.width), height: side(canvas.height) };
}

/** One placement rule for every aspect ratio: sized from the frame's short
 * side, inset from the left, a little under a quarter of the way down. */
function watermarkRect(outputPx: { width: number; height: number }) {
  const even = (n: number) => 2 * Math.round(n / 2);
  const shortSide = Math.min(outputPx.width, outputPx.height);
  const width = even(0.26 * shortSide);
  return {
    x: even(0.07 * shortSide),
    y: even(0.235 * outputPx.height),
    width,
    height: even((width * NARRIFLOW_WATERMARK_ART.height) / NARRIFLOW_WATERMARK_ART.width),
  };
}

export interface CompositionOutputTreatmentVisualLayer {
  readonly id: string;
  readonly kind: "output-treatment";
  readonly activeRange: CompositionActiveRange;
  readonly destination: CompositionRect;
  readonly resolution: "720p" | "1080p";
  readonly scale: { readonly numerator: 1 | 2; readonly denominator: 1 | 3 };
  readonly watermark:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly art: typeof NARRIFLOW_WATERMARK_ART.id;
        /** The frame after the output scale; the badge is placed in these pixels. */
        readonly outputPx: { readonly width: number; readonly height: number };
        readonly rectPx: {
          readonly x: number;
          readonly y: number;
          readonly width: number;
          readonly height: number;
        };
      };
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: 70;
}

export type CompositionVisualLayer =
  | CompositionTextVisualLayer
  | CompositionCaptionVisualLayer
  | CompositionLogoVisualLayer
  | CompositionTransitionVisualLayer
  | CompositionOutputTreatmentVisualLayer;

export interface CompositionScene {
  readonly id: string;
  readonly startSec: number;
  readonly endSec: number;
  /** Position in the pre-insertion edited source timeline. Inserted scenes
   * have no source range; shifted source scenes retain their original range. */
  readonly sourceRange?: CompositionActiveRange | null;
  readonly layoutSelection?: {
    readonly id: string;
    readonly preset: SceneLayoutPreset;
  } | null;
  readonly layers: readonly CompositionLayer[];
}

export interface CompositionTargetPlan {
  readonly id: string;
  readonly aspectRatio: ClipAspectRatio;
  readonly requestedMode: CompositionMode;
  readonly effectiveMode: CompositionMode;
  readonly canvas: {
    readonly width: number;
    readonly height: number;
    readonly divisibleBy: 2;
  };
  readonly visualLayers: readonly CompositionVisualLayer[];
  readonly scenes: readonly CompositionScene[];
}

type CompositionBaseTargetPlan = Omit<CompositionTargetPlan, "visualLayers">;

export interface CompositionEvidenceRequest {
  readonly key: string;
  readonly kind:
    | "automatic-speaker-layout"
    | "split-speaker-layout"
    | "screen-layout";
  readonly engineVersion: string;
}

export interface CompositionNotice {
  readonly attempts?: number;
  readonly causeCode?: string;
  readonly code: string;
  readonly fidelity: "pending" | "degraded";
  readonly targetId: string;
  readonly sceneId: string | null;
  readonly effectiveFallback: CompositionMode;
  readonly userActionPossible: boolean;
  readonly assetId?: string;
}

export interface CompositionAudioSchedule {
  readonly fingerprint: string;
  readonly outputFades: {
    readonly fadeIn: CompositionActiveRange;
    readonly fadeOut: CompositionActiveRange;
  };
  readonly source: {
    readonly sourceRef: string;
    readonly available: boolean;
    readonly activeRange: CompositionActiveRange;
    readonly gain: number;
    readonly muted: boolean;
  };
  /** One entry per playable Music Block, in timeline order. Every range is
   * output (plan) seconds; `fades` are absolute plan ranges inside the
   * block's `activeRange`; ducking windows are clip-wide plan ranges. */
  readonly music: readonly {
    readonly id: string;
    readonly sourceRef: string;
    readonly activeRange: CompositionActiveRange;
    readonly gain: number;
    /** In-point inside the track; playback loops past the track end. */
    readonly sourceStartSec: number;
    readonly sourceDurationSec: number | null;
    readonly loop: true;
    readonly fades: {
      readonly fadeIn: CompositionActiveRange;
      readonly fadeOut: CompositionActiveRange;
    };
    readonly ducking: {
      readonly enabled: boolean;
      readonly windows: readonly { readonly startSec: number; readonly endSec: number }[];
      readonly duckedGainFraction: number;
      readonly attackSec: number;
      readonly releaseSec: number;
    };
  }[];
  readonly soundEffects: readonly {
    readonly id: string;
    readonly sourceRef: string;
    readonly activeRange: CompositionActiveRange;
    readonly gain: number;
  }[];
  readonly censors: ReturnType<typeof normalizeCensorAudioSchedule>;
}

export interface ClipCompositionPlan {
  readonly version: typeof CLIP_COMPOSITION_PLAN_VERSION;
  readonly fingerprint: string;
  readonly inputFingerprint: string;
  readonly fidelity: "exact" | "pending" | "degraded";
  readonly editedDurationSec: number;
  readonly source: {
    readonly ref: string;
    readonly width: number;
    readonly height: number;
  };
  readonly audioSchedule: CompositionAudioSchedule;
  readonly targets: readonly CompositionTargetPlan[];
  readonly notices: readonly CompositionNotice[];
  readonly evidenceRequests: readonly CompositionEvidenceRequest[];
}

export type ClipCompositionPlanResult =
  | {
      readonly status: "invalid";
      readonly error: {
        readonly code:
          | "invalid_source_facts"
          | "invalid_target"
          | "too_many_targets"
          | "empty_edited_timeline"
          | "invalid_broll_placement"
          | "unsupported_mode"
          | "text_scene_unfit"
          | "plan_size_exceeded";
        readonly targetId?: string;
        readonly sceneId?: string;
      };
    }
  | {
      readonly status: "ready" | "pending";
      readonly plan: ClipCompositionPlan;
    };

function hashString(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/** Converts a caller-owned storage key or URL into a bounded logical asset
 *  identity. The raw access location never enters a plan or diagnostic. */
export function compositionAssetRef(kind: string, identity: string): string {
  return `${kind}:${hashString(identity)}`;
}

export function automaticLayoutInputFingerprint(input: {
  sourceIdentity: string;
  clipStartSec: number;
  clipEndSec: number;
  deletedRanges: EditorDocument["deletedRanges"];
  engineVersion: string;
}): string {
  return hashString(
    JSON.stringify({
      sourceIdentity: input.sourceIdentity,
      clipStartSec: input.clipStartSec,
      clipEndSec: input.clipEndSec,
      deletedRanges: input.deletedRanges
        .map((range) => ({
          startSec: range.startSec,
          endSec: range.endSec,
        }))
        .sort(
          (left, right) =>
            left.startSec - right.startSec || left.endSec - right.endSec,
        ),
      engineVersion: input.engineVersion,
    }),
  );
}

export const splitLayoutInputFingerprint = automaticLayoutInputFingerprint;
export const screenLayoutInputFingerprint = automaticLayoutInputFingerprint;

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function resolveRequestedAudioAssets(
  input: ClipCompositionPlanInput,
  editedDurationSec: number,
) {
  const musicSettings = input.document.studioEdits.music;
  const normalizeSoundEffect = (
    availability: CompositionSoundEffectAvailability | undefined,
  ): CompositionSoundEffectAvailability | undefined =>
    availability?.state === "available" &&
    (!Number.isFinite(availability.durationSec) || availability.durationSec <= 0)
      ? { state: "failed" }
      : availability;
  return {
    // A block that starts at or past the clip end is never played, so it
    // raises no asset notice either.
    music: musicSettings.blocks.flatMap((block) =>
      block.startSec < editedDurationSec
        ? [{ block, availability: input.assets.music?.[block.id] }]
        : [],
    ),
    soundEffects: input.document.studioEdits.sfx.flatMap((placement) =>
      placement.startSec < editedDurationSec
        ? [
            {
              placement,
              availability: normalizeSoundEffect(
                input.assets.soundEffects?.[placement.id],
              ),
            },
          ]
        : [],
    ),
  };
}

type ResolvedAudioAssets = ReturnType<typeof resolveRequestedAudioAssets>;

function buildAudioSchedule(
  input: ClipCompositionPlanInput,
  editedDurationSec: number,
  resolvedAssets: ResolvedAudioAssets,
) {
  const activeRange = { startSec: 0, endSec: editedDurationSec };
  const outputFadeWindows = resolveMusicFadeWindows(
    CLIP_AUDIO_FADE_IN_SEC,
    CLIP_AUDIO_FADE_OUT_SEC,
    editedDurationSec,
  );
  const outputFades = {
    fadeIn: {
      startSec: 0,
      endSec: outputFadeWindows.fadeInSec,
    },
    fadeOut: {
      startSec: outputFadeWindows.fadeOutStartSec,
      endSec: editedDurationSec,
    },
  };
  const sourceAudio = input.document.studioEdits.sourceAudio;
  const musicSettings = input.document.studioEdits.music;
  const editedTimeMap = buildClipCutPlan(input.document.deletedRanges, {
    startSec: input.document.clipStartSec,
    endSec: input.document.clipEndSec,
  }).map;
  const insertionAnchors = insertedBaseAnchors(input.document.sceneBlocks);
  const speechIntervals = input.captionOverride
    ? input.captionOverride.segments.flatMap((segment) =>
        segment.map((word) => ({ startSec: word.startSec, endSec: word.endSec })),
      )
    : extractSpeechWordIntervals(
        input.document.transcriptSlice,
        input.document.clipStartSec,
        editedTimeMap,
      );
  const duckingWindows = musicSettings.ducking
    ? capDuckingWindows(
        computeSpeechWindows(
          speechIntervals.flatMap((range) =>
            sourceRangeSlicesForInsertions(range, insertionAnchors)
              .map((slice) => slice.outputRange),
          ),
          editedDurationSec,
        ),
      )
    : [];
  const musicDucking = {
    enabled: musicSettings.ducking,
    windows: duckingWindows,
    duckedGainFraction: DUCKING_DEFAULTS.duckedGainFraction,
    attackSec: DUCKING_DEFAULTS.attackSec,
    releaseSec: DUCKING_DEFAULTS.releaseSec,
  };
  const music = resolvedAssets.music.flatMap(({ block, availability }) => {
    if (availability?.state !== "available") return [];
    // Blocks are stored on the base edited timeline, but the Studio lane
    // draws them on the composite clock, so a block plays straight through
    // any Scene Block inserted inside it.
    const blockStartSec = Math.min(
      editedDurationSec,
      baseEditedToOutputSec(block.startSec, insertionAnchors, "start"),
    );
    const blockEndSec = Math.min(
      block.endSec === null
        ? editedDurationSec
        : baseEditedToOutputSec(block.endSec, insertionAnchors, "end"),
      editedDurationSec,
    );
    if (!(blockEndSec > blockStartSec)) return [];
    const fadeWindows = resolveMusicFadeWindows(
      block.fadeInSec,
      block.fadeOutSec,
      blockEndSec - blockStartSec,
    );
    return [
      {
        id: block.id,
        sourceRef: availability.ref,
        activeRange: { startSec: blockStartSec, endSec: blockEndSec },
        gain: clampUnit(block.volume / 100),
        sourceStartSec: Math.max(0, block.sourceStartSec),
        sourceDurationSec:
          availability.durationSec &&
          Number.isFinite(availability.durationSec) &&
          availability.durationSec > 0
            ? availability.durationSec
            : null,
        loop: true as const,
        fades: {
          fadeIn: {
            startSec: blockStartSec,
            endSec: blockStartSec + fadeWindows.fadeInSec,
          },
          fadeOut: {
            startSec: blockStartSec + fadeWindows.fadeOutStartSec,
            endSec: blockEndSec,
          },
        },
        ducking: musicDucking,
      },
    ];
  });
  const soundEffects = resolvedAssets.soundEffects.flatMap(
    ({ placement, availability }) => {
    if (availability?.state !== "available") return [];
    const endSec = Math.min(
      editedDurationSec,
      placement.startSec + availability.durationSec,
    );
    return [
      {
        id: placement.id,
        sourceRef: availability.ref,
        activeRange: {
          startSec: placement.startSec,
          endSec,
        },
        gain: clampUnit(placement.volume / 100),
      },
    ];
    },
  );
  const censors = normalizeCensorAudioSchedule({
    clipWindow: {
      startSec: input.document.clipStartSec,
      endSec: input.document.clipEndSec,
    },
    deletedRanges: input.document.deletedRanges,
    segments: input.document.censorSegments,
    sceneBlocks: input.document.sceneBlocks,
  });
  const withoutFingerprint = {
    outputFades,
    source: {
      sourceRef: input.source.identity,
      available: input.source.hasAudio !== false,
      activeRange,
      gain: clampUnit(sourceAudio.volume / 100),
      muted: sourceAudio.muted,
    },
    music,
    soundEffects,
    censors,
  };
  return {
    fingerprint: hashString(JSON.stringify(withoutFingerprint)),
    ...withoutFingerprint,
  } satisfies CompositionAudioSchedule;
}

function centeredCoverCrop(
  source: Pick<CompositionSourceFacts, "width" | "height">,
  target: Pick<CompositionTarget, "width" | "height">,
): CompositionRect {
  const sourceRatio = source.width / source.height;
  const targetRatio = target.width / target.height;
  const width =
    sourceRatio >= targetRatio
      ? Math.round(source.height * targetRatio)
      : source.width;
  const height =
    sourceRatio >= targetRatio
      ? source.height
      : Math.round(source.width / targetRatio);
  return {
    x: Math.max(0, Math.round((source.width - width) / 2)),
    y: Math.max(0, Math.round((source.height - height) / 2)),
    width: Math.min(source.width, width),
    height: Math.min(source.height, height),
  };
}

function evenNearest(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function containedDestination(
  source: Pick<CompositionSourceFacts, "width" | "height">,
  target: Pick<CompositionTarget, "width" | "height">,
): CompositionRect {
  const scale = Math.min(
    target.width / source.width,
    target.height / source.height,
  );
  const width = Math.min(target.width, evenNearest(source.width * scale));
  const height = Math.min(target.height, evenNearest(source.height * scale));
  return {
    x: Math.round((target.width - width) / 2),
    y: Math.round((target.height - height) / 2),
    width,
    height,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function framePixels(
  transform: SpeakerLayerTransform,
  target: CompositionTarget,
): CompositionRect {
  const width = clamp(
    Math.round(transform.frameWidth * target.width),
    2,
    target.width,
  );
  const height = clamp(
    Math.round(transform.frameHeight * target.height),
    2,
    target.height,
  );
  return {
    x: clamp(Math.round(transform.frameX * target.width), 0, target.width - width),
    y: clamp(Math.round(transform.frameY * target.height), 0, target.height - height),
    width,
    height,
  };
}

function cropForSpeakerLayer(
  source: CompositionSourceFacts,
  destination: CompositionRect,
  transform: SpeakerLayerTransform,
): CompositionRect {
  const targetRatio = destination.width / destination.height;
  const sourceRatio = source.width / source.height;
  const baseWidth =
    sourceRatio >= targetRatio
      ? Math.round(source.height * targetRatio)
      : source.width;
  const baseHeight =
    sourceRatio >= targetRatio
      ? source.height
      : Math.round(source.width / targetRatio);
  const zoom = clamp(transform.cropZoom, 1, 4);
  const width = Math.max(2, Math.round(baseWidth / zoom));
  const height = Math.max(2, Math.round(baseHeight / zoom));
  return {
    x: clamp(
      Math.round(transform.cropCxNorm * source.width - width / 2),
      0,
      source.width - width,
    ),
    y: clamp(
      Math.round(transform.cropCyNorm * source.height - height / 2),
      0,
      source.height - height,
    ),
    width: Math.min(source.width, width),
    height: Math.min(source.height, height),
  };
}

function cropTrackForSpeakerLayer(
  source: CompositionSourceFacts,
  destination: CompositionRect,
  transform: SpeakerLayerTransform,
  track: readonly { timeSec: number; cxNorm: number; cyNorm: number }[] | undefined,
): readonly CompositionCropKeyframe[] | undefined {
  if (!track || track.length === 0) return undefined;
  return track.map((keyframe) => ({
    ...cropForSpeakerLayer(source, destination, {
      ...transform,
      cropCxNorm: keyframe.cxNorm,
      cropCyNorm: keyframe.cyNorm,
    }),
    timeSec: keyframe.timeSec,
  }));
}

function targetSupportsTwoUp(
  source: CompositionSourceFacts,
  target: CompositionTarget,
): boolean {
  return evenStackFrames(target).every((frame) => {
    const tileRatio = frame.width / frame.height;
    const cropWidth =
      source.width / source.height >= tileRatio
        ? Math.round(source.height * tileRatio)
        : source.width;
    return cropWidth < source.width;
  });
}

function evenStackFrames(target: CompositionTarget): readonly [CompositionRect, CompositionRect] {
  const bottomHeight = 2 * Math.floor(target.height / 4);
  const topHeight = target.height - bottomHeight;
  return [
    { x: 0, y: 0, width: target.width, height: topHeight },
    { x: 0, y: topHeight, width: target.width, height: bottomHeight },
  ];
}

function cropsAreLaterallyDistinct(
  left: CompositionRect,
  right: CompositionRect,
  sourceWidth: number,
): boolean {
  const leftCenter = left.x + left.width / 2;
  const rightCenter = right.x + right.width / 2;
  return Math.abs(leftCenter - rightCenter) >= Math.max(2, sourceWidth * 0.02);
}

function segmentsAreComplete(
  segments: readonly (ClipAutoLayoutSegment | ClipSplitLayoutSegment)[],
  editedDurationSec: number,
  maxSegments: number,
): boolean {
  if (segments.length === 0 || segments.length > maxSegments) return false;
  let cursor = 0;
  for (const segment of segments) {
    if (
      !Number.isFinite(segment.startSec) ||
      !Number.isFinite(segment.endSec) ||
      Math.abs(segment.startSec - cursor) > SCENE_CONTINUITY_EPSILON_SEC ||
      segment.endSec <= segment.startSec
    ) {
      return false;
    }
    cursor = segment.endSec;
  }
  return Math.abs(cursor - editedDurationSec) <= SCENE_CONTINUITY_EPSILON_SEC;
}

function evidenceMatches(
  value: Pick<
    SplitLayoutEvidence | ScreenLayoutEvidence,
    "sourceIdentity" | "inputFingerprint" | "engineVersion"
  >,
  input: ClipCompositionPlanInput,
  engineVersion: string,
): boolean {
  return (
    value.sourceIdentity === input.source.identity &&
    value.engineVersion === engineVersion &&
    value.inputFingerprint ===
      automaticLayoutInputFingerprint({
        sourceIdentity: input.source.identity,
        clipStartSec: input.document.clipStartSec,
        clipEndSec: input.document.clipEndSec,
        deletedRanges: input.document.deletedRanges,
        engineVersion,
      })
  );
}

function canonicalSplitTransforms(
  segment: ClipAutoLayoutSegment | ClipSplitLayoutSegment,
  target: CompositionTarget,
): readonly SpeakerLayerTransform[] {
  if (segment.layout === "single") {
    return [
      {
        role: "single",
        frameX: 0,
        frameY: 0,
        frameWidth: 1,
        frameHeight: 1,
        rotationDeg: 0,
        cropCxNorm: segment.cxNorm,
        cropCyNorm: segment.cyNorm ?? 0.5,
        cropZoom: segment.zoom ?? 1,
      },
    ];
  }
  const [top, bottom] = evenStackFrames(target);
  return [
    {
      role: "top",
      frameX: 0,
      frameY: 0,
      frameWidth: 1,
      frameHeight: top.height / target.height,
      rotationDeg: 0,
      cropCxNorm: segment.topCxNorm,
      cropCyNorm: segment.topCyNorm ?? 0.5,
      cropZoom: segment.topZoom ?? 1,
    },
    {
      role: "bottom",
      frameX: 0,
      frameY: top.height / target.height,
      frameWidth: 1,
      frameHeight: bottom.height / target.height,
      rotationDeg: 0,
      cropCxNorm: segment.bottomCxNorm,
      cropCyNorm: segment.bottomCyNorm ?? 0.5,
      cropZoom: segment.bottomZoom ?? 1,
    },
  ];
}

function cropTrackForSegmentRole(
  segment: ClipAutoLayoutSegment | ClipSplitLayoutSegment,
  role: SpeakerLayerRole,
) {
  if (!("subjects" in segment)) return undefined;
  const automatic = segment as ClipAutoLayoutSegment;
  if (automatic.layout === "single") return automatic.cropTrack;
  return role === "top" ? automatic.topCropTrack : role === "bottom" ? automatic.bottomCropTrack : undefined;
}

/** The clip's chosen background behind any scene that shows the full source. */
interface SceneBackground {
  readonly color: string;
  readonly imageRef: string | null;
}

function resolveSceneBackground(input: ClipCompositionPlanInput): SceneBackground {
  const background = input.document.studioEdits.background;
  return {
    color: background.mode === "off" ? "#000000" : (background.color ?? "#000000"),
    imageRef:
      background.mode === "image" &&
      background.imageUrl &&
      input.assets.backgroundImage.state === "available"
        ? input.assets.backgroundImage.ref
        : null,
  };
}

function speakerScenes(input: {
  mode: "auto" | "split";
  source: CompositionSourceFacts;
  target: CompositionTarget;
  segments: readonly (ClipAutoLayoutSegment | ClipSplitLayoutSegment)[];
  overrides: EditorDocument["studioEdits"]["speakerLayoutOverrides"];
  background: SceneBackground;
}): CompositionScene[] {
  return input.segments.map((segment, sceneIndex) => {
    const automaticSegment = segment as ClipAutoLayoutSegment;
    const defaults = resolveSpeakerLayoutScene(
      segment,
      [],
      input.target.aspectRatio,
    );
    const resolved = resolveSpeakerLayoutScene(
      segment,
      input.overrides,
      input.target.aspectRatio,
    );
    if (
      input.mode === "auto" &&
      automaticSegment.layout === "single" &&
      automaticSegment.intent === "fit" &&
      !resolved.overrideId
    ) {
      return {
        id: `scene:auto:${input.target.id}:${sceneIndex}`,
        startSec: segment.startSec,
        endSec: segment.endSec,
        layers: [
          {
            id: `layer:background:${input.target.id}:${sceneIndex}`,
            kind: "background",
            color: input.background.color,
            imageRef: input.background.imageRef,
            destination: { x: 0, y: 0, width: input.target.width, height: input.target.height },
            fit: "cover",
            rotationDeg: 0,
            opacity: 1,
            zIndex: 0,
          },
          fullSourceLayer(
            input.source,
            containedDestination(input.source, input.target),
            `layer:source:${input.target.id}:${sceneIndex}`,
            1,
          ),
        ],
      };
    }
    const canonical =
      input.mode === "split"
        ? canonicalSplitTransforms(segment, input.target)
        : defaults.layers;
    const transforms = resolved.overrideId ? resolved.layers : canonical;
    return {
      id: `scene:${input.mode}:${input.target.id}:${sceneIndex}`,
      startSec: segment.startSec,
      endSec: segment.endSec,
      layers: transforms.map((transform, layerIndex) => {
        const defaultTransform = canonical.find(
          (candidate) => candidate.role === transform.role,
        )!;
        const destination = framePixels(transform, input.target);
        const subject = Object.hasOwn(segment, "subjects")
          ? [...(segment as ClipAutoLayoutSegment).subjects].sort(
              (left, right) =>
                Math.hypot(
                  left.cxNorm - transform.cropCxNorm,
                  left.cyNorm - transform.cropCyNorm,
                ) -
                Math.hypot(
                  right.cxNorm - transform.cropCxNorm,
                  right.cyNorm - transform.cropCyNorm,
                ),
            )[0]
          : undefined;
        return {
          id: `layer:speaker:${transform.role}:${input.target.id}:${sceneIndex}`,
          kind: "source-video" as const,
          sourceRef: input.source.identity,
          sourceCrop: cropForSpeakerLayer(
            input.source,
            destination,
            transform,
          ),
          ...(!resolved.overrideId
            ? {
                sourceCropTrack: cropTrackForSpeakerLayer(
                  input.source,
                  destination,
                  transform,
                  cropTrackForSegmentRole(segment, transform.role),
                ),
              }
            : {}),
          destination,
          fit: "cover" as const,
          rotationDeg: transform.rotationDeg,
          opacity: 1,
          zIndex: layerIndex,
          speaker: {
            role: transform.role,
            transform: { ...transform },
            defaultTransform: { ...defaultTransform },
            overrideId: resolved.overrideId,
            ...(subject ? { subjectId: subject.id } : {}),
          },
        };
      }),
    };
  });
}

function screenPipCrop(
  rect: Extract<
    ScreenLayoutEvidence["pictureInPicture"],
    { state: "confirmed" }
  >["rect"],
  target: CompositionTarget,
  source: CompositionSourceFacts,
): CompositionRect | null {
  const [, bottom] = evenStackFrames(target);
  const tileRatio = bottom.width / bottom.height;
  const cx = (rect.x + rect.width / 2) * source.width;
  const cy = (rect.y + rect.height / 2) * source.height;
  let width = rect.width * source.width * 1.16;
  let height = rect.height * source.height * 1.16;
  const ratio = width / height;
  if (ratio < tileRatio) width = height * tileRatio;
  else if (ratio > tileRatio) height = width / tileRatio;
  const shrink = Math.min(1, source.width / width, source.height / height);
  width = Math.round(width * shrink);
  height = Math.round(height * shrink);
  const x = Math.round(clamp(cx - width / 2, 0, source.width - width));
  const y = Math.round(clamp(cy - height / 2, 0, source.height - height));
  return width < target.width * 0.4 ? null : { x, y, width, height };
}

function screenScene(
  source: CompositionSourceFacts,
  target: CompositionTarget,
  sceneIndex: number,
  startSec: number,
  endSec: number,
  bottomCrop: CompositionRect,
): CompositionScene {
  const [top, bottom] = evenStackFrames(target);
  return {
    id: `scene:screen:${target.id}:${sceneIndex}`,
    startSec,
    endSec,
    layers: [
      {
        id: `layer:screen:${target.id}:${sceneIndex}`,
        kind: "source-video",
        sourceRef: source.identity,
        sourceCrop: { x: 0, y: 0, width: source.width, height: source.height },
        destination: top,
        fit: "contain",
        rotationDeg: 0,
        opacity: 1,
        zIndex: 0,
      },
      {
        id: `layer:speaker:bottom:${target.id}:${sceneIndex}`,
        kind: "source-video",
        sourceRef: source.identity,
        sourceCrop: bottomCrop,
        destination: bottom,
        fit: "cover",
        rotationDeg: 0,
        opacity: 1,
        zIndex: 1,
      },
    ],
  };
}

function containedInFrame(
  source: Pick<CompositionSourceFacts, "width" | "height">,
  frame: CompositionRect,
): CompositionRect {
  const local = containedDestination(source, {
    width: frame.width,
    height: frame.height,
  });
  return {
    x: frame.x + local.x,
    y: frame.y + local.y,
    width: local.width,
    height: local.height,
  };
}

function presetSpeakerLayer(
  input: {
    source: CompositionSourceFacts;
    target: CompositionTarget;
    anchor: CompositionSourceVideoLayer;
    destination: CompositionRect;
    mask?: SceneLayoutLayerMask;
    id: string;
    zIndex: number;
  },
): CompositionSourceVideoLayer {
  const anchorTransform = input.anchor.speaker!.transform;
  const anchorDefault = input.anchor.speaker!.defaultTransform;
  const presetFrame = {
    x: input.destination.x / input.target.width,
    y: input.destination.y / input.target.height,
    width: input.destination.width / input.target.width,
    height: input.destination.height / input.target.height,
  };
  let transform: SpeakerLayerTransform = input.anchor.speaker!.overrideId
    ? { ...anchorTransform }
    : {
        ...anchorTransform,
        frameX: presetFrame.x,
        frameY: presetFrame.y,
        frameWidth: presetFrame.width,
        frameHeight: presetFrame.height,
        rotationDeg: 0,
      };
  let defaultTransform: SpeakerLayerTransform = {
    ...anchorDefault,
    frameX: presetFrame.x,
    frameY: presetFrame.y,
    frameWidth: presetFrame.width,
    frameHeight: presetFrame.height,
    rotationDeg: 0,
  };
  if (input.mask?.kind === "circle") {
    const squareTransform = (candidate: SpeakerLayerTransform) => {
      const pixels = framePixels(candidate, input.target);
      const size = Math.min(pixels.width, pixels.height);
      return {
        ...candidate,
        frameX: (pixels.x + (pixels.width - size) / 2) / input.target.width,
        frameY: (pixels.y + (pixels.height - size) / 2) / input.target.height,
        frameWidth: size / input.target.width,
        frameHeight: size / input.target.height,
      };
    };
    transform = squareTransform(transform);
    defaultTransform = squareTransform(defaultTransform);
  }
  const destination = framePixels(transform, input.target);
  return {
    id: input.id,
    kind: "source-video",
    sourceRef: input.source.identity,
    sourceCrop: cropForSpeakerLayer(input.source, destination, transform),
    destination,
    fit: "cover",
    rotationDeg: transform.rotationDeg,
    opacity: 1,
    zIndex: input.zIndex,
    ...(input.mask
      ? {
          mask:
            input.mask.kind === "rounded"
              ? {
                  kind: "rounded" as const,
                  radiusPx: Math.min(
                    input.mask.radiusPx,
                    Math.floor(Math.min(destination.width, destination.height) / 2),
                  ),
                }
              : input.mask,
        }
      : {}),
    speaker: {
      role: transform.role,
      transform,
      defaultTransform,
      overrideId: input.anchor.speaker!.overrideId,
      ...(input.anchor.speaker!.subjectId
        ? { subjectId: input.anchor.speaker!.subjectId }
        : {}),
    },
  };
}

function fullSourceLayer(
  source: CompositionSourceFacts,
  destination: CompositionRect,
  id: string,
  zIndex: number,
  fit: "cover" | "contain" = "contain",
): CompositionSourceVideoLayer {
  return {
    id,
    kind: "source-video",
    sourceRef: source.identity,
    sourceCrop: { x: 0, y: 0, width: source.width, height: source.height },
    destination,
    fit,
    rotationDeg: 0,
    opacity: 1,
    zIndex,
  };
}

function subjectAnchorLayer(input: {
  source: CompositionSourceFacts;
  target: CompositionTarget;
  subject: ClipAutoLayoutSubject;
  role: SpeakerLayerRole;
}): CompositionSourceVideoLayer {
  const transform: SpeakerLayerTransform = {
    role: input.role,
    frameX: 0,
    frameY: 0,
    frameWidth: 1,
    frameHeight: 1,
    rotationDeg: 0,
    cropCxNorm: input.subject.cxNorm,
    cropCyNorm: input.subject.cyNorm,
    cropZoom: input.subject.zoom,
  };
  const destination = framePixels(transform, input.target);
  return {
    id: `layer:subject-anchor:${input.subject.id}`,
    kind: "source-video",
    sourceRef: input.source.identity,
    sourceCrop: cropForSpeakerLayer(input.source, destination, transform),
    destination,
    fit: "cover",
    rotationDeg: 0,
    opacity: 1,
    zIndex: 0,
    speaker: {
      role: input.role,
      transform,
      defaultTransform: { ...transform },
      overrideId: null,
      subjectId: input.subject.id,
    },
  };
}

function sceneLayoutLayers(input: {
  selection: StudioSceneLayoutSelection;
  source: CompositionSourceFacts;
  target: CompositionTarget;
  automaticScene: CompositionScene | null;
  automaticSegment: ClipAutoLayoutSegment | null;
  backgroundImageRef: string | null;
  backgroundColor: string;
}): readonly CompositionLayer[] | null {
  const { selection, source, target } = input;
  const automaticSpeakers =
    input.automaticScene?.layers.filter(
      (layer): layer is CompositionSourceVideoLayer =>
        layer.kind === "source-video" && Boolean(layer.speaker),
    ) ?? [];
  const full = { x: 0, y: 0, width: target.width, height: target.height };

  if (selection.preset === "auto") {
    return input.automaticScene?.layers ?? null;
  }
  const definition = sceneLayoutPresetDefinition(selection.preset);
  const subjects = input.automaticSegment?.subjects ?? [];
  if (subjects.length < definition.minimumSpeakers) return null;
  const resolvedTemplate = resolveSceneLayoutPresetTemplate(selection.preset, target);
  const speakerCount = resolvedTemplate.filter(
    (templateLayer) => templateLayer.kind === "speaker",
  ).length;
  const layers: CompositionLayer[] = [];
  if (definition.showsBackground) {
    layers.push({
      id: `layer:scene-layout:${selection.id}:background`,
      kind: "background",
      color: input.backgroundColor,
      imageRef: input.backgroundImageRef,
      destination: full,
      fit: "cover",
      rotationDeg: 0,
      opacity: 1,
      zIndex: 0,
    });
  }
  const zOffset = layers.length;
  for (const [index, templateLayer] of resolvedTemplate.entries()) {
    if (templateLayer.kind === "source") {
      const destination =
        templateLayer.fit === "contain"
          ? containedInFrame(source, templateLayer.frame)
          : templateLayer.frame;
      const layer = fullSourceLayer(
        source,
        destination,
        `layer:scene-layout:${selection.id}:source:${index}`,
        zOffset + index,
        templateLayer.fit,
      );
      layers.push(
        templateLayer.fit === "cover"
          ? {
              ...layer,
              sourceCrop: centeredCoverCrop(source, destination),
            }
          : layer,
      );
      continue;
    }
    const subjectIndex = templateLayer.subjectIndex ?? 0;
    const subject = subjects[subjectIndex];
    if (!subject) return null;
    const role: SpeakerLayerRole =
      speakerCount === 1
        ? "single"
        : (["top", "bottom", "third", "fourth"] as const)[subjectIndex];
    const observedAnchor = subjectAnchorLayer({ source, target, subject, role });
    const manual = automaticSpeakers.find(
      (candidate) =>
        candidate.speaker?.role === role &&
        candidate.speaker.overrideId !== null,
    );
    const anchor = manual?.speaker
      ? {
          ...observedAnchor,
          speaker: {
            ...manual.speaker,
            role,
            transform: { ...manual.speaker.transform, role },
            defaultTransform: { ...observedAnchor.speaker!.defaultTransform, role },
            subjectId: subject.id,
          },
        }
      : observedAnchor;
    layers.push(
      presetSpeakerLayer({
        source,
        target,
        anchor,
        destination: templateLayer.frame,
        mask: templateLayer.mask,
        id: `layer:scene-layout:${selection.id}:speaker:${subjectIndex}`,
        zIndex: zOffset + index,
      }),
    );
  }
  return layers;
}

function applySceneLayoutSelections(input: {
  target: CompositionBaseTargetPlan;
  targetInput: CompositionTarget;
  source: CompositionSourceFacts;
  selections: readonly StudioSceneLayoutSelection[];
  automaticScenes: readonly CompositionScene[];
  automaticDefaultScenes: readonly CompositionScene[];
  automaticSegments: readonly ClipAutoLayoutSegment[];
  automaticEvidencePending: boolean;
  backgroundImageRef: string | null;
  backgroundColor: string;
}): { target: CompositionBaseTargetPlan; notices: CompositionNotice[] } {
  if (input.source.kind !== "video") return { target: input.target, notices: [] };
  const selections = input.selections.filter(
    (selection) => selection.aspectRatio === input.target.aspectRatio,
  );
  if (selections.length === 0 && input.automaticScenes.length === 0) {
    return { target: input.target, notices: [] };
  }
  const notices: CompositionNotice[] = [];
  const scenes: CompositionScene[] = [];
  for (const base of input.target.scenes) {
    const boundaries = [base.startSec, base.endSec];
    const addBoundary = (value: number, toleranceSec: number) => {
      if (boundaries.some((boundary) => Math.abs(boundary - value) < toleranceSec)) {
        return;
      }
      boundaries.push(value);
    };
    for (const candidate of selections) {
      if (candidate.endSec <= base.startSec || candidate.startSec >= base.endSec) continue;
      addBoundary(Math.max(base.startSec, candidate.startSec), 0.001);
      addBoundary(Math.min(base.endSec, candidate.endSec), 0.001);
    }
    for (const candidate of input.automaticScenes) {
      if (candidate.endSec <= base.startSec || candidate.startSec >= base.endSec) continue;
      addBoundary(
        Math.max(base.startSec, candidate.startSec),
        SCENE_LAYOUT_MIN_DURATION_SEC,
      );
      addBoundary(
        Math.min(base.endSec, candidate.endSec),
        SCENE_LAYOUT_MIN_DURATION_SEC,
      );
    }
    const ordered = boundaries.sort((left, right) => left - right);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const startSec = ordered[index]!;
      const endSec = ordered[index + 1]!;
      if (endSec <= startSec) continue;
      const midpoint = startSec + (endSec - startSec) / 2;
      const selection = sceneLayoutSelectionAt(
        selections,
        input.target.aspectRatio,
        midpoint,
      );
      const automaticScene =
        ((selection &&
        sceneLayoutPresetDefinition(selection.preset).minimumSpeakers >= 2)
          ? input.automaticScenes
          : input.automaticDefaultScenes
        ).find(
          (candidate) =>
            candidate.startSec <= midpoint && midpoint < candidate.endSec,
        ) ?? null;
      const automaticSegment =
        input.automaticSegments.find(
          (candidate) =>
            candidate.startSec <= midpoint && midpoint < candidate.endSec,
        ) ?? null;
      const layers = selection
        ? sceneLayoutLayers({
            selection,
            source: input.source,
            target: input.targetInput,
            automaticScene,
            automaticSegment,
            backgroundImageRef: input.backgroundImageRef,
            backgroundColor: input.backgroundColor,
          })
        : null;
      const id = `${base.id}:layout-slice:${scenes.length}`;
      if (selection && !layers) {
        const awaitingEvidence =
          sceneLayoutPresetNeedsAutomaticEvidence(selection.preset) &&
          input.automaticEvidencePending;
        notices.push({
          code: awaitingEvidence
            ? "scene_layout_analyzing"
            : "scene_layout_subjects_unavailable",
          fidelity: awaitingEvidence ? "pending" : "degraded",
          targetId: input.target.id,
          sceneId: id,
          effectiveFallback: input.target.effectiveMode,
          userActionPossible: true,
        });
      }
      scenes.push({
        ...base,
        id,
        startSec,
        endSec,
        layoutSelection: selection
          ? { id: selection.id, preset: selection.preset }
          : null,
        layers: sourceLayersForRange(layers ?? base.layers, startSec, endSec),
      });
    }
  }
  const customSelectionApplied = scenes.some((scene) => Boolean(scene.layoutSelection));
  return {
    target: {
      ...input.target,
      effectiveMode:
        customSelectionApplied ? "auto" : input.target.effectiveMode,
      scenes,
    },
    notices,
  };
}

function validAutomaticLayoutEvidence(
  evidence: AutomaticLayoutEvidenceAvailability,
  input: ClipCompositionPlanInput,
  editedDurationSec: number,
): ClipAutoLayoutAnalysis | null {
  if (evidence.state !== "available") return null;
  const expectedFingerprint = automaticLayoutInputFingerprint({
    sourceIdentity: input.source.identity,
    clipStartSec: input.document.clipStartSec,
    clipEndSec: input.document.clipEndSec,
    deletedRanges: input.document.deletedRanges,
    engineVersion: input.capabilities.automaticSpeakerEngineVersion,
  });
  const value = evidence.value;
  const analysis = value.analysis;
  if (
    value.sourceIdentity !== input.source.identity ||
    value.inputFingerprint !== expectedFingerprint ||
    value.engineVersion !== input.capabilities.automaticSpeakerEngineVersion ||
    analysis.version !== CLIP_AUTO_LAYOUT_VERSION ||
    analysis.engine !== input.capabilities.automaticSpeakerEngineVersion ||
    analysis.sourceIdentity !== input.source.identity ||
    // Speaker coordinates are normalized. Evidence may have been measured
    // on the source-derived Studio proxy and then applied to the original
    // render dimensions, so pixel dimensions are descriptive rather than
    // part of the evidence invalidation key.
    Math.abs(analysis.editedDurationSec - editedDurationSec) >
      SCENE_CONTINUITY_EPSILON_SEC ||
    !clipAutoLayoutMatchesInputs(analysis, {
      clipStartSec: input.document.clipStartSec,
      clipEndSec: input.document.clipEndSec,
      deletedRanges: input.document.deletedRanges,
    })
  ) {
    return null;
  }

  return analysis;
}

function sourceLayersForRange(
  layers: readonly CompositionLayer[],
  startSec: number,
  endSec: number,
  shiftSec = 0,
): readonly CompositionLayer[] {
  return layers.map((layer) => {
    if (layer.kind !== "source-video" || !layer.sourceCropTrack?.length) return layer;
    const endpoint = (timeSec: number): CompositionCropKeyframe => {
      const crop = interpolateCompositionCropTrack(layer.sourceCrop, layer.sourceCropTrack, timeSec);
      return {
        timeSec: timeSec + shiftSec,
        x: Math.round(crop.x),
        y: Math.round(crop.y),
        width: Math.round(crop.width),
        height: Math.round(crop.height),
      };
    };
    return {
      ...layer,
      sourceCropTrack: [
        endpoint(startSec),
        ...layer.sourceCropTrack
          .filter((frame) => frame.timeSec > startSec + 0.001 && frame.timeSec < endSec - 0.001)
          .map((frame) => ({ ...frame, timeSec: frame.timeSec + shiftSec })),
        endpoint(endSec),
      ],
    };
  });
}

function addBrollLayers(
  target: CompositionBaseTargetPlan,
  placements: readonly CompositionBrollPlacement[],
): CompositionBaseTargetPlan {
  if (placements.length === 0) return target;

  const scenes: CompositionScene[] = [];
  for (const baseScene of target.scenes) {
    const boundaries = new Set<number>([
      baseScene.startSec,
      baseScene.endSec,
    ]);
    for (const placement of placements) {
      if (
        placement.endSec > baseScene.startSec &&
        placement.startSec < baseScene.endSec
      ) {
        boundaries.add(Math.max(baseScene.startSec, placement.startSec));
        boundaries.add(Math.min(baseScene.endSec, placement.endSec));
      }
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const startSec = ordered[index]!;
      const endSec = ordered[index + 1]!;
      if (endSec <= startSec) continue;
      const active = placements.find(
        (placement) =>
          placement.startSec <= startSec && placement.endSec >= endSec,
      );
      const brollLayer: CompositionBrollVideoLayer | CompositionBrollImageLayer | null = !active
        ? null
        : active.kind === "image"
          ? {
              id: `layer:broll:${active.id}:${target.id}`,
              kind: "broll-image",
              sourceRef: active.ref,
              activeRange: { startSec: active.startSec, endSec: active.endSec },
              destination: { x: 0, y: 0, width: target.canvas.width, height: target.canvas.height },
              fit: "cover",
              rotationDeg: 0,
              opacity: 1,
              zIndex: 20,
              motion: null,
            }
          : {
              id: `layer:broll:${active.id}:${target.id}`,
              kind: "broll-video",
              sourceRef: active.ref,
              activeRange: { startSec: active.startSec, endSec: active.endSec },
              destination: { x: 0, y: 0, width: target.canvas.width, height: target.canvas.height },
              fit: "cover",
              rotationDeg: 0,
              opacity: 1,
              zIndex: 20,
              motion: null,
              audio: "source",
            };
      scenes.push({
        ...baseScene,
        id: `${baseScene.id}:slice:${scenes.length}`,
        startSec,
        endSec,
        layers: sourceLayersForRange(brollLayer ? [...baseScene.layers, brollLayer] : baseScene.layers, startSec, endSec),
      });
    }
  }
  return { ...target, scenes };
}

const SCENE_TEXT_WIDTH_SAFETY_FACTOR = 1.08;
const SCENE_TEXT_NARROW_ASCII = /^[ilI1.,'|!:;`]$/u;
const SCENE_TEXT_WIDE_ASCII = /^[MW@#%&]$/u;
const SCENE_TEXT_CJK_OR_FULL_WIDTH =
  /^[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]$/u;
function sceneTextGraphemes(value: string): string[] {
  const clusters: string[] = [];
  for (const codePoint of Array.from(value)) {
    const previous = clusters.at(-1);
    if (!previous) {
      clusters.push(codePoint);
      continue;
    }
    const isCombining = /^\p{M}$/u.test(codePoint);
    const isVariationSelector = /^[\uFE0E\uFE0F]$/u.test(codePoint);
    const isEmojiModifier = /^\p{Emoji_Modifier}$/u.test(codePoint);
    const isEmojiTag = /^[\u{E0020}-\u{E007F}]$/u.test(codePoint);
    const isRegionalIndicator = /^\p{Regional_Indicator}$/u.test(codePoint);
    const previousRegionalIndicators = Array.from(previous).filter((part) =>
      /^\p{Regional_Indicator}$/u.test(part)
    ).length;
    if (
      isCombining ||
      isVariationSelector ||
      isEmojiModifier ||
      isEmojiTag ||
      codePoint === "\u200D" ||
      previous.endsWith("\u200D") ||
      (isRegionalIndicator && previousRegionalIndicators % 2 === 1)
    ) {
      clusters[clusters.length - 1] = previous + codePoint;
    } else {
      clusters.push(codePoint);
    }
  }
  return clusters;
}

function sceneTextGraphemeWidthEm(grapheme: string): number {
  if (/^\s+$/u.test(grapheme)) return 0.35;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 1;
  if (SCENE_TEXT_CJK_OR_FULL_WIDTH.test(grapheme)) return 1;
  if (SCENE_TEXT_NARROW_ASCII.test(grapheme)) return 0.4;
  if (SCENE_TEXT_WIDE_ASCII.test(grapheme)) return 0.9;
  if (/^\p{Lu}$/u.test(grapheme)) return 0.72;
  if (/^[\p{Ll}\p{N}]$/u.test(grapheme)) return 0.62;
  if (/^\p{P}$/u.test(grapheme)) return 0.5;
  return 0.75;
}

interface PreparedSceneTextWord {
  readonly text: string;
  readonly graphemes: readonly {
    readonly text: string;
    readonly widthEm: number;
  }[];
  readonly widthEm: number;
}

function prepareSceneText(text: string): PreparedSceneTextWord[] {
  return text.trim().replace(/\s+/gu, " ").split(" ").map((word) => {
    const graphemes = sceneTextGraphemes(word).map((grapheme) => ({
      text: grapheme,
      widthEm: sceneTextGraphemeWidthEm(grapheme),
    }));
    return {
      text: word,
      graphemes,
      widthEm: graphemes.reduce((width, grapheme) => width + grapheme.widthEm, 0),
    };
  });
}

function breakSceneTextWord(
  word: PreparedSceneTextWord,
  maxWidthEm: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidthEm = 0;
  for (const grapheme of word.graphemes) {
    if (line && lineWidthEm + grapheme.widthEm > maxWidthEm) {
      lines.push(line);
      line = grapheme.text;
      lineWidthEm = grapheme.widthEm;
    } else {
      line += grapheme.text;
      lineWidthEm += grapheme.widthEm;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function wrapSceneText(
  words: readonly PreparedSceneTextWord[],
  fontSizePx: number,
  maxWidthPx: number,
): string[] {
  const maxWidthEm = maxWidthPx /
    (fontSizePx * SCENE_TEXT_WIDTH_SAFETY_FACTOR);
  const lines: string[] = [];
  let line = "";
  let lineWidthEm = 0;
  const spaceWidthEm = sceneTextGraphemeWidthEm(" ");
  for (const word of words) {
    if (word.widthEm > maxWidthEm) {
      if (line) lines.push(line);
      const pieces = breakSceneTextWord(word, maxWidthEm);
      lines.push(...pieces.slice(0, -1));
      line = pieces.at(-1) ?? "";
      lineWidthEm = word.graphemes
        .slice(word.graphemes.length - sceneTextGraphemes(line).length)
        .reduce((width, grapheme) => width + grapheme.widthEm, 0);
      continue;
    }
    if (line && lineWidthEm + spaceWidthEm + word.widthEm > maxWidthEm) {
      lines.push(line);
      line = word.text;
      lineWidthEm = word.widthEm;
    } else {
      line = line ? `${line} ${word.text}` : word.text;
      lineWidthEm += (lineWidthEm > 0 ? spaceWidthEm : 0) + word.widthEm;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitSceneText(
  text: string,
  canvas: { width: number; height: number },
): CompositionSceneTextRender | null {
  const shorterSide = Math.min(canvas.width, canvas.height);
  const maxWidthPx = Math.round(canvas.width * 0.82);
  const maxHeightPx = Math.round(canvas.height * 0.82);
  const maximumFontSizePx = Math.max(1, Math.round(shorterSide * 0.1));
  const minimumFontSizePx = Math.max(
    1,
    Math.round(shorterSide * (24 / 1080)),
  );
  const words = prepareSceneText(text);
  for (
    let fontSizePx = maximumFontSizePx;
    fontSizePx >= minimumFontSizePx;
    fontSizePx -= 1
  ) {
    const lineHeightPx = Math.round(fontSizePx * 1.05);
    const lines = wrapSceneText(words, fontSizePx, maxWidthPx);
    if (
      lines.length > 0 &&
      lines.length * lineHeightPx <= maxHeightPx
    ) {
      return { lines, fontSizePx, lineHeightPx, maxWidthPx };
    }
  }
  return null;
}

function sceneTextRenderKey(targetId: string, sceneBlockId: string): string {
  return `${targetId}:${sceneBlockId}`;
}

function addInsertedSceneBlocks(
  target: CompositionBaseTargetPlan,
  blocks: readonly SceneBlock[],
  textRenders: ReadonlyMap<string, CompositionSceneTextRender>,
): CompositionBaseTargetPlan {
  if (blocks.length === 0) return target;
  let insertedBeforeSec = 0;
  const anchored = [...blocks]
    .sort((left, right) => left.anchorSec - right.anchorSec || left.id.localeCompare(right.id))
    .map((block) => {
      const baseAnchorSec = block.anchorSec - insertedBeforeSec;
      insertedBeforeSec += block.durationSec;
      return { block, baseAnchorSec };
    });
  const boundaries = new Set(target.scenes.flatMap((scene) => [scene.startSec, scene.endSec]));
  anchored.forEach(({ baseAnchorSec }) => {
    boundaries.add(baseAnchorSec);
  });
  const ordered = [...boundaries].sort((left, right) => left - right);
  const sourceScenes: CompositionScene[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const startSec = ordered[index]!;
    const endSec = ordered[index + 1]!;
    if (endSec <= startSec) continue;
    const base = target.scenes.find((scene) => scene.startSec <= startSec && scene.endSec >= endSec);
    if (!base) continue;
    const shift = anchored.filter(({ baseAnchorSec }) => baseAnchorSec <= startSec).reduce((sum, { block }) => sum + block.durationSec, 0);
    sourceScenes.push({
      ...base,
      id: `${base.id}:insert-slice:${index}`,
      startSec: startSec + shift,
      endSec: endSec + shift,
      sourceRange: { startSec, endSec },
      layers: sourceLayersForRange(base.layers, startSec, endSec, shift),
    });
  }
  const insertedScenes: CompositionScene[] = anchored.map(({ block }) => ({
    id: `scene:inserted:${target.id}:${block.id}`,
    startSec: block.anchorSec,
    endSec: block.anchorSec + block.durationSec,
    sourceRange: null,
    layers: [{
      id: `layer:inserted:${target.id}:${block.id}`,
      kind: "inserted-scene",
      sceneBlockId: block.id,
      content: block.content,
      textRender: block.content.kind === "text"
        ? textRenders.get(sceneTextRenderKey(target.id, block.id)) ?? null
        : null,
      motion: null,
      sourceRef: block.content.kind === "image" || block.content.kind === "video"
        ? compositionAssetRef("visual_asset", `${block.content.asset.id}:${block.content.asset.fingerprint}`)
        : null,
      destination: { x: 0, y: 0, width: target.canvas.width, height: target.canvas.height },
      rotationDeg: 0,
      opacity: 1,
      zIndex: 25,
    }],
  }));
  return {
    ...target,
    scenes: [...sourceScenes, ...insertedScenes].sort((left, right) => left.startSec - right.startSec || left.id.localeCompare(right.id)),
  };
}

type MotionProperty = "opacity" | "transform" | "crop" | "clip";
const MOTION_BOUNDARY_EPSILON_SEC = 0.000_001;

function transitionMotionProperty(
  type: EditorDocument["studioEdits"]["transition"]["type"],
): MotionProperty | null {
  if (type === "none") return null;
  if (
    type === "fade" ||
    type === "fade-black" ||
    type === "dip-white"
  ) {
    return "opacity";
  }
  if (type.startsWith("wipe-")) return "clip";
  return "transform";
}

function mediaMotionProperty(family: string): MotionProperty | null {
  if (family === "none") return null;
  if (family === "fade") return "opacity";
  if (family.startsWith("ken-burns-")) return "crop";
  return "transform";
}

function applyTargetMediaMotion(input: {
  readonly target: CompositionTargetPlan;
  readonly document: EditorDocument;
}): {
  readonly target: CompositionTargetPlan;
  readonly notices: readonly CompositionNotice[];
} {
  const transitionProperty = transitionMotionProperty(
    input.document.studioEdits.transition.type,
  );
  const brollRanges = new Map<string, CompositionActiveRange>();
  for (const scene of input.target.scenes) {
    for (const layer of scene.layers) {
      if (layer.kind !== "broll-video" && layer.kind !== "broll-image") continue;
      const current = brollRanges.get(layer.id);
      brollRanges.set(layer.id, {
        startSec: Math.min(current?.startSec ?? scene.startSec, scene.startSec),
        endSec: Math.max(current?.endSec ?? scene.endSec, scene.endSec),
      });
    }
  }
  const notices: CompositionNotice[] = [];
  const noticeKeys = new Set<string>();
  const scenes = input.target.scenes.map((scene) => ({
    ...scene,
    layers: scene.layers.map((layer): CompositionLayer => {
      if (layer.kind === "inserted-scene") {
        const block = input.document.sceneBlocks.find(
          (candidate) => candidate.id === layer.sceneBlockId,
        );
        if (!block) return layer;
        const override = input.document.mediaMotions.find(
          (candidate) =>
            candidate.enabled &&
            candidate.target.kind === "scene_block" &&
            candidate.target.sceneBlockId === block.id,
        );
        const settings = override ?? block.motion;
        const activeRange = override
          ? {
              startSec: Math.max(scene.startSec, override.startSec),
              endSec: Math.min(scene.endSec, override.endSec),
            }
          : { startSec: scene.startSec, endSec: scene.endSec };
        if (activeRange.endSec <= activeRange.startSec) {
          return { ...layer, motion: null };
        }
        let entrance = settings.entrance;
        let exit = settings.exit;
        if (
          transitionProperty &&
          Math.abs(activeRange.startSec) <= MOTION_BOUNDARY_EPSILON_SEC &&
          mediaMotionProperty(entrance) === transitionProperty
        ) {
          entrance = "none";
          const key = `entrance:${input.target.id}:${block.id}`;
          if (!noticeKeys.has(key)) {
            noticeKeys.add(key);
            notices.push({
              code: "scene_motion_entrance_suppressed_by_transition",
              fidelity: "degraded",
              targetId: input.target.id,
              sceneId: block.id,
              effectiveFallback: input.target.effectiveMode,
              userActionPossible: true,
            });
          }
        }
        if (
          transitionProperty &&
          Math.abs(activeRange.endSec - input.target.scenes.at(-1)!.endSec) <=
            MOTION_BOUNDARY_EPSILON_SEC &&
          mediaMotionProperty(exit) === transitionProperty
        ) {
          exit = "none";
          const key = `exit:${input.target.id}:${block.id}`;
          if (!noticeKeys.has(key)) {
            noticeKeys.add(key);
            notices.push({
              code: "scene_motion_exit_suppressed_by_transition",
              fidelity: "degraded",
              targetId: input.target.id,
              sceneId: block.id,
              effectiveFallback: input.target.effectiveMode,
              userActionPossible: true,
            });
          }
        }
        const motion =
          entrance === "none" && exit === "none"
            ? null
            : planMediaMotion({
                entrance,
                exit,
                durationSec: settings.durationSec,
                activeRange,
                canvas: input.target.canvas,
              });
        return { ...layer, motion };
      }
      if (layer.kind !== "broll-video" && layer.kind !== "broll-image") {
        return layer;
      }
      const settings = input.document.mediaMotions.find(
        (candidate) => candidate.enabled && candidate.target.kind === "broll",
      );
      const plannedRange = brollRanges.get(layer.id);
      if (!settings || !plannedRange) {
        return { ...layer, activeRange: plannedRange ?? layer.activeRange, motion: null };
      }
      const activeRange = {
        startSec: Math.max(plannedRange.startSec, settings.startSec),
        endSec: Math.min(plannedRange.endSec, settings.endSec),
      };
      if (activeRange.endSec <= activeRange.startSec) {
        return { ...layer, activeRange: plannedRange, motion: null };
      }
      return {
        ...layer,
        activeRange: plannedRange,
        motion:
          settings.entrance === "none" && settings.exit === "none"
            ? null
            : planMediaMotion({
                entrance: settings.entrance,
                exit: settings.exit,
                durationSec: settings.durationSec,
                activeRange,
                canvas: input.target.canvas,
              }),
      };
    }),
  }));
  return { target: { ...input.target, scenes }, notices };
}

function insertedBaseAnchors(blocks: readonly SceneBlock[]) {
  let insertedBeforeSec = 0;
  return [...blocks]
    .sort((left, right) => left.anchorSec - right.anchorSec || left.id.localeCompare(right.id))
    .map((block) => {
      const baseAnchorSec = block.anchorSec - insertedBeforeSec;
      insertedBeforeSec += block.durationSec;
      return { block, baseAnchorSec };
    });
}

/** Maps a base edited instant onto the composition clock. A Scene Block
 * inserted exactly at the instant comes after a range's start and before a
 * range's end, so a range never swallows a scene that only touches it. */
function baseEditedToOutputSec(
  baseSec: number,
  anchors: ReturnType<typeof insertedBaseAnchors>,
  edge: "start" | "end",
) {
  return anchors.reduce(
    (sum, { baseAnchorSec, block }) =>
      (edge === "start" ? baseAnchorSec <= baseSec : baseAnchorSec < baseSec)
        ? sum + block.durationSec
        : sum,
    baseSec,
  );
}

/** One retained source interval can straddle a Scene Block. Each slice keeps
 * its source range and one constant offset onto the final composition clock. */
function sourceRangeSlicesForInsertions(
  range: CompositionActiveRange,
  anchors: ReturnType<typeof insertedBaseAnchors>,
) {
  const boundaries = [
    range.startSec,
    ...anchors
      .map(({ baseAnchorSec }) => baseAnchorSec)
      .filter((anchor) => anchor > range.startSec && anchor < range.endSec),
    range.endSec,
  ];
  return boundaries.slice(0, -1).flatMap((startSec, index) => {
    const endSec = boundaries[index + 1]!;
    if (endSec <= startSec) return [];
    const shiftSec = anchors
      .filter(({ baseAnchorSec }) => baseAnchorSec <= startSec)
      .reduce((sum, { block }) => sum + block.durationSec, 0);
    return [{
      startSec,
      endSec,
      shiftSec,
      outputRange: { startSec: startSec + shiftSec, endSec: endSec + shiftSec },
    }];
  });
}

function retimeVisualLayersForInsertedScenes(
  layers: readonly CompositionVisualLayer[],
  blocks: readonly SceneBlock[],
  totalDurationSec: number,
): CompositionVisualLayer[] {
  if (blocks.length === 0) return [...layers];
  const anchors = insertedBaseAnchors(blocks);
  const retimed = layers.flatMap((layer): CompositionVisualLayer[] => {
    if (layer.kind === "logo" || layer.kind === "output-treatment") {
      return [{ ...layer, activeRange: { startSec: 0, endSec: totalDurationSec } }];
    }
    if (layer.kind === "transition") {
      const durationSec = layer.motion.entrance
        ? layer.motion.entrance.range.endSec - layer.motion.entrance.range.startSec
        : layer.motion.exit
          ? layer.motion.exit.range.endSec - layer.motion.exit.range.startSec
          : 0;
      return [{
        ...layer,
        activeRange: { startSec: 0, endSec: totalDurationSec },
        motion: planTransitionMotion({
          type: layer.transition,
          durationSec,
          activeRange: { startSec: 0, endSec: totalDurationSec },
          canvas: {
            width: layer.destination.width,
            height: layer.destination.height,
          },
        }),
      }];
    }
    const slices: CompositionVisualLayer[] = [];
    sourceRangeSlicesForInsertions(layer.activeRange, anchors).forEach((slice, index) => {
      const id = `${layer.id}:scene-slice:${index}`;
      if (layer.kind === "caption") {
        const cue = captionCueSlice(layer, slice, id);
        if (cue) slices.push(cue);
        return;
      }
      slices.push({ ...layer, id, activeRange: slice.outputRange });
    });
    return slices;
  });
  return numberCaptionCues(retimed);
}

/**
 * The part of a caption cue on one side of an inserted Scene Block, as a cue of its own: the words
 * it holds (a word spanning the scene only for its own part, so neither side shows it across the
 * scene), the Scene Style roles and keys and the Caption Block roles, texts, keys and rows of those
 * words, and the emojis whose time falls inside it. The block keeps the cue's seed, so both sides
 * keep the cue's look. Null when no word is on this side.
 */
function captionCueSlice(
  layer: CompositionCaptionVisualLayer,
  slice: ReturnType<typeof sourceRangeSlicesForInsertions>[number],
  id: string,
): CompositionCaptionVisualLayer | null {
  const { startSec, endSec, shiftSec, outputRange } = slice;
  const kept = captionCueSliceWords(layer, slice);
  if (kept.length === 0) return null;
  const pick = <T,>(values: readonly T[]) => kept.map((at) => values[at]!);
  const position = new Map(kept.map((at, index) => [at, index]));
  return {
    ...layer,
    id,
    activeRange: outputRange,
    words: pick(layer.words).map((word) => ({
      ...word,
      startSec: Math.max(word.startSec, startSec) + shiftSec,
      endSec: Math.min(word.endSec, endSec) + shiftSec,
    })),
    emojis: layer.emojis
      .filter((emoji) => emoji.atSec >= startSec && emoji.atSec < endSec)
      .map((emoji) => ({ ...emoji, atSec: emoji.atSec + shiftSec })),
    ...(layer.scene ? { scene: { ...layer.scene, roles: pick(layer.scene.roles), keys: pick(layer.scene.keys) } } : {}),
    ...(layer.block
      ? {
          block: {
            ...layer.block,
            roles: pick(layer.block.roles),
            texts: pick(layer.block.texts),
            keys: pick(layer.block.keys),
            rows: layer.block.rows
              .map((row) => row.flatMap((at) => (position.has(at) ? [position.get(at)!] : [])))
              .filter((row) => row.length > 0),
          },
        }
      : {}),
  };
}

/** Indices of a cue's words on one side of an inserted Scene Block. */
function captionCueSliceWords(
  layer: CompositionCaptionVisualLayer,
  { startSec, endSec }: ReturnType<typeof sourceRangeSlicesForInsertions>[number],
): number[] {
  return layer.words.flatMap((word, at) => (word.endSec > startSec && word.startSec < endSec ? [at] : []));
}

/**
 * A target's caption layers in cue order, each `cueIndex` its place in that order: Scene Styles,
 * the emoji layer and the worker key a cue's pieces and boxes by it, so it must be unique.
 */
function numberCaptionCues<T extends CompositionVisualLayer>(layers: T[]): T[] {
  let next = 0;
  return layers.map((layer) => {
    if (layer.kind !== "caption") return layer;
    const cueIndex = next++;
    return layer.cueIndex === cueIndex ? layer : { ...layer, cueIndex };
  });
}

export interface CaptionCue {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly language: string | null;
}

const CAPTION_CUE_TARGET: CompositionTarget = { id: "caption-cues", aspectRatio: "9:16", width: 1080, height: 1920 };

/** The one caption cue derivation. Burn-in plans these cues per target, and
 * subtitle files read them directly: `wordsPerCue` grouping, edited time
 * across cuts and inserted scenes, and censor masks. `ignoreVisibility` serves
 * subtitles for exports whose burned-in captions are turned off. */
export function deriveCaptionCues(
  document: EditorDocument,
  options: {
    readonly ignoreVisibility?: boolean;
    readonly language?: string | null;
    readonly captionOverride?: CaptionOverride;
  } = {},
): CaptionCue[] {
  const editedTimeMap = buildClipCutPlan(document.deletedRanges, {
    startSec: document.clipStartSec,
    endSec: document.clipEndSec,
  }).map;
  const cueDocument = options.ignoreVisibility
    ? { ...document, captionPreset: { ...document.captionPreset, visible: true } }
    : document;
  const totalDurationSec = editedTimeMap.editedDurationSec +
    document.sceneBlocks.reduce((total, block) => total + block.durationSec, 0);
  return retimeVisualLayersForInsertedScenes(
    captionLayersForTarget({
      document: cueDocument,
      target: CAPTION_CUE_TARGET,
      editedTimeMap,
      language: options.language ?? null,
      captionOverride: options.captionOverride,
    }),
    document.sceneBlocks,
    totalDurationSec,
  ).flatMap((layer) => layer.kind === "caption" && layer.words.length > 0
    ? [{ ...captionCueVisibleRange(layer, totalDurationSec), text: captionCueText(layer.words), language: layer.language }]
    : []);
}

/** One caption as it appears on the video, with the transcript words it shows. */
export interface CaptionLine {
  /** Position of the cue's utterance in `transcriptSlice`. */
  readonly utterance: number;
  /** Indices into that utterance's `words` of the words the cue shows, in order; empty for an untimed utterance. */
  readonly words: readonly number[];
  /** The cue's text as drawn: censor masks, punctuation and case applied. */
  readonly text: string;
  /** Composition seconds, the window `deriveCaptionCues` gives the same cue. */
  readonly startSec: number;
  readonly endSec: number;
}

/**
 * The source-language captions of a document, one per cue on the video, for editors that address
 * captions by their transcript words. The grouping, the bounding and the split at inserted scenes
 * are the plan's own, so the list always matches the video; captions turned off still list theirs.
 */
export function deriveCaptionLines(document: EditorDocument, options: { readonly language?: string | null } = {}): CaptionLine[] {
  const editedTimeMap = buildClipCutPlan(document.deletedRanges, {
    startSec: document.clipStartSec,
    endSec: document.clipEndSec,
  }).map;
  const grouped = groupCaptionCues({
    document: { ...document, captionPreset: { ...document.captionPreset, visible: true } },
    target: CAPTION_CUE_TARGET,
    editedTimeMap,
    language: options.language ?? null,
  });
  if (!grouped) return [];
  boundCaptionCues(grouped.layers);
  const totalDurationSec = editedTimeMap.editedDurationSec +
    document.sceneBlocks.reduce((total, block) => total + block.durationSec, 0);
  const anchors = insertedBaseAnchors(document.sceneBlocks);
  return grouped.layers.flatMap((layer, at): CaptionLine[] => {
    const source = grouped.sources[at];
    if (!source || !captionLayerCanShow(layer)) return [];
    const line = (cue: CompositionCaptionVisualLayer, words: readonly number[]): CaptionLine => ({
      utterance: source.utterance,
      words,
      text: captionCueText(cue.words),
      ...captionCueVisibleRange(cue, totalDurationSec),
    });
    if (anchors.length === 0) return [line(layer, source.words)];
    return sourceRangeSlicesForInsertions(layer.activeRange, anchors).flatMap((slice, index) => {
      const cue = captionCueSlice(layer, slice, `${layer.id}:scene-slice:${index}`);
      if (!cue) return [];
      const kept = captionCueSliceWords(layer, slice);
      return [line(cue, source.words.length === 0 ? [] : kept.map((word) => source.words[word]!))];
    });
  });
}

export function captionCueText(words: readonly CompositionCaptionWord[]) {
  return joinTranscriptWords(words.map((word) => ({
    word: word.text,
    ...(word.spaceBefore === undefined ? {} : { spaceBefore: word.spaceBefore }),
  })));
}

/** When a caption word stops being the active word. Burned-in text events
 * and subtitle cue ends both use it, bounded by the cue window when supplied. */
export function captionWordSegmentEnd(words: readonly CompositionCaptionWord[], index: number, cueEndSec = Number.POSITIVE_INFINITY) {
  const word = words[index]!;
  return Math.min(cueEndSec, index + 1 < words.length ? words[index + 1]!.startSec : Math.max(word.endSec, word.startSec + 0.05));
}

/** A cue's text is visible from its first word until its last word's segment
 * ends, bounded by the cue window and the export end. */
export function captionCueVisibleRange(layer: CompositionCaptionVisualLayer, totalDurationSec: number) {
  return {
    startSec: layer.words[0]!.startSec,
    endSec: captionWordSegmentEnd(layer.words, layer.words.length - 1, Math.min(totalDurationSec, layer.activeRange.endSec)),
  };
}

/** When a target plays an inserted Scene Block, on the composition clock, in time order. The clip's own picture, speech
 * and captions stop for each one; a Scene Style's pieces are cut at them (`SceneInput.insertedScenes`). */
export function insertedSceneRanges(target: Pick<CompositionTargetPlan, "scenes">): CompositionActiveRange[] {
  return target.scenes
    .filter((scene) => scene.layers.some((layer) => layer.kind === "inserted-scene"))
    .map((scene) => ({ startSec: scene.startSec, endSec: scene.endSec }))
    .sort((left, right) => left.startSec - right.startSec);
}

/** Caption text for an utterance with no word timings. Text in a no-space
 * script is one token: splitting and re-joining it would only collapse its
 * own spacing. */
function fallbackCaptionText(text: string, punctuation: boolean) {
  if (Array.from(text).some(isNoSpaceScriptChar)) {
    return formatCaptionWord(text.trim().replace(/\s+/g, " "), { punctuation });
  }
  return text
    .split(/\s+/)
    .map((word) => formatCaptionWord(word, { punctuation }))
    .filter(Boolean)
    .join(" ");
}

/** One word of a cue for `captionCueBlock`. */
export interface CaptionCueBlockWord {
  /** Caption text after censoring and punctuation formatting, before any case transform. */
  readonly text: string;
  /** Word Key; null for dub captions and samples without source times. */
  readonly key: string | null;
}

/**
 * The one Caption Block builder, shared by the plan and by previews that
 * render sample cues (preset thumbnails, brand-kit previews). `roles` comes
 * from `assignCaptionRoles` over the cue's words. Null for a classic preset.
 */
export function captionCueBlock(
  words: readonly CaptionCueBlockWord[],
  preset: CaptionPreset,
  language: string | null,
  cueIndex: number,
  roles: CaptionCueRoles,
): CompositionCaptionBlock | null {
  if (!preset.dynamic || words.length === 0) return null;
  const style = captionDynamicStyle(preset.dynamic);
  const seed = captionBlockSeed(words[0]!.key, cueIndex);
  return {
    style: preset.dynamic,
    roles: [...roles.roles],
    texts: words.map((word, index) =>
      applyCaptionTextTransform(word.text, captionRoleLook(preset, style, roles.roles[index]!, seed, word.text).transform, language)),
    keys: words.map((word) => word.key),
    rows: captionBlockRows(roles.roles, roles.heroSpan, style),
    seed,
  };
}

/**
 * The raw text each visible token contributes to `captionSoftBreaks`. A token
 * the Punctuation toggle left empty (a lone dash or full stop) is not drawn,
 * but it still ends a phrase, so its text joins the visible token before it.
 * Shared by the transcript and dub caption paths.
 */
function captionBreakRaws(tokens: readonly { readonly raw: string; readonly visible: boolean }[]): string[] {
  const raws: string[] = [];
  for (const token of tokens) {
    if (token.visible) raws.push(token.raw);
    else if (raws.length > 0) raws[raws.length - 1] += token.raw;
  }
  return raws;
}

/** A grouped cue waiting for its roles: the scorer runs once over all of a target's cues. */
interface PendingCaptionCue {
  /** Index into the target's caption layers, or null for an untimed utterance (scored, never a block). */
  readonly layerIndex: number | null;
  readonly emphasis: readonly CaptionEmphasisWord[];
  readonly blockWords: readonly CaptionCueBlockWord[];
  /** The utterance's diarized speaker (Scene Styles); null for dub captions. */
  readonly speaker: number | null;
}

interface CaptionCuesInput {
  document: EditorDocument;
  target: CompositionTarget;
  editedTimeMap: EditedTimeMap;
  language: string | null;
  captionOverride?: CaptionOverride | undefined;
}

/** A target's cues as grouped, before `finalizeCaptionLayers` bounds them and attaches emojis and roles. */
interface GroupedCaptionCues {
  readonly layers: CompositionCaptionVisualLayer[];
  /** Parallel to `layers`: the transcript words each cue shows; null for a dub cue. */
  readonly sources: (CaptionLineSource | null)[];
  readonly pending: PendingCaptionCue[];
  readonly emojis: readonly PendingCaptionEmoji[];
  readonly language: string | null;
  readonly emphasisWords: readonly string[] | undefined;
}

/** Where a transcript cue's words come from: an utterance's position in the slice and its word indices. */
interface CaptionLineSource {
  readonly utterance: number;
  readonly words: readonly number[];
}

/**
 * The visible-word ranges of one utterance that the owner merged into one caption
 * (`studioEdits.captionMerges`), in order and never overlapping. An entry whose first or last word
 * is not in this utterance is ignored, so a merge whose words were edited away regroups on its own.
 */
function mergedCaptionRanges(
  merges: Readonly<Record<string, string>> | undefined,
  words: readonly TranscriptWord[],
  visibleWords: readonly { readonly wordIndex: number }[],
): { start: number; end: number }[] {
  if (!merges || visibleWords.length < 2) return [];
  const indexByKey = new Map(words.map((word, index) => [captionWordKey(word.startSec), index]));
  const ranges: { start: number; end: number }[] = [];
  for (const [firstKey, lastKey] of Object.entries(merges)) {
    const first = indexByKey.get(firstKey);
    const last = indexByKey.get(lastKey);
    if (first === undefined || last === undefined || last <= first) continue;
    const start = visibleWords.findIndex((entry) => entry.wordIndex >= first);
    let end = start;
    while (end >= 0 && end < visibleWords.length && visibleWords[end]!.wordIndex <= last) end++;
    if (start >= 0 && end - start >= 2) ranges.push({ start, end });
  }
  ranges.sort((left, right) => left.start - right.start);
  return ranges.filter((range, index) => index === 0 || range.start >= ranges[index - 1]!.end);
}

/**
 * `groupCaptionTokens`, with each merged range one cue and every other cue keeping the words it had.
 * Before a range the grouping's own breaks stand. After it, they stand too when the range ends on one
 * of them (a merge inside one utterance: grouping anew would lose the minor words a cue carried over
 * from the one before); otherwise (a merge that joined two utterances) the rest groups from a fresh
 * start, as it did when it began its own utterance.
 */
function groupCaptionTokensWithMerges(
  texts: readonly string[],
  wordsPerCue: number,
  softBreakAfter: readonly boolean[],
  minor: readonly boolean[],
  merged: readonly { start: number; end: number }[],
): { start: number; end: number }[] {
  const whole = groupCaptionTokens(texts, wordsPerCue, softBreakAfter, minor);
  if (merged.length === 0) return whole;
  const groups: { start: number; end: number }[] = [];
  let at = 0;
  let own = whole;
  const take = (end: number) => {
    // Groups of `own` from `at` up to `end`; one crossing `end` is cut there.
    for (const group of own) {
      if (group.end <= at || group.start >= end) continue;
      groups.push({ start: Math.max(group.start, at), end: Math.min(group.end, end) });
    }
    at = end;
  };
  for (const range of merged) {
    take(range.start);
    groups.push(range);
    at = range.end;
    if (!own.some((group) => group.end === range.end)) {
      own = groupCaptionTokens(texts.slice(at), wordsPerCue, softBreakAfter.slice(at), minor.slice(at)).map((group) => ({ start: group.start + at, end: group.end + at }));
    }
  }
  take(texts.length);
  return groups;
}

function captionLayersForTarget(input: CaptionCuesInput): CompositionCaptionVisualLayer[] {
  const grouped = groupCaptionCues(input);
  return grouped
    ? finalizeCaptionLayers(grouped.layers, grouped.pending, grouped.emojis, input.document, grouped.language, grouped.emphasisWords)
    : [];
}

/** The one grouping of words into cues (`groupCaptionTokens` per utterance or dub segment); null when captions are off. */
function groupCaptionCues(input: CaptionCuesInput): GroupedCaptionCues | null {
  const { document, target, editedTimeMap, captionOverride } = input;
  const language = captionOverride ? captionOverride.language : input.language;
  const preset = document.captionPreset;
  if (preset.visible === false) return null;
  const dynamicStyle = preset.dynamic ? captionDynamicStyle(preset.dynamic) : null;
  // A Scene Style groups by its own cue length; only a Dynamic Style bounds it for its rows.
  const wordsPerCue = dynamicStyle ? captionBlockWordsPerCue(preset.wordsPerCue) : preset.wordsPerCue;
  const destination = { x: 0, y: 0, width: target.width, height: target.height };
  const anchor = {
    xPct: preset.positionX ?? (dynamicStyle?.align === "left" ? dynamicStyle.leftGuidePct ?? 50 : 50),
    yPct:
      preset.positionY ??
      (preset.scene ? captionSceneDefaultPositionY(preset.scene) : CAPTION_POSITION_Y_DEFAULTS[preset.position ?? "bottom"]),
  };
  const punctuation = preset.punctuation !== false;
  const layers: CompositionCaptionVisualLayer[] = [];
  const sources: (CaptionLineSource | null)[] = [];
  const pending: PendingCaptionCue[] = [];
  const pendingEmojis: PendingCaptionEmoji[] = [];
  let previousEndSec: number | null = null;
  const pauseBefore = (startSec: number, endSec: number) => {
    const pause = previousEndSec === null ? 0 : Math.max(0, startSec - previousEndSec);
    previousEndSec = endSec;
    return pause;
  };

  if (captionOverride) {
    for (const [segmentIndex, segment] of captionOverride.segments.entries()) {
      const hidden: { raw: string; visible: boolean }[] = [];
      const visibleWords = segment.flatMap((word) => {
        const text = formatCaptionWord(word.text, { punctuation });
        const formatted = applyCaptionTextTransform(text, preset.textTransform, language);
        hidden.push({ raw: word.text, visible: formatted !== "" });
        return formatted ? [{ word, text, formatted }] : [];
      });
      const breakRaws = captionBreakRaws(hidden);
      const emphasis = visibleWords.map((entry, index): CaptionEmphasisWord => ({
        key: null,
        raw: entry.word.text,
        sourceStartSec: entry.word.startSec,
        sourceEndSec: entry.word.endSec,
        utteranceIndex: segmentIndex,
        utteranceFinal: index === visibleWords.length - 1,
        pauseBeforeSec: pauseBefore(entry.word.startSec, entry.word.endSec),
        masked: false,
      }));
      const groups = groupCaptionTokens(
        visibleWords.map((entry) => entry.formatted),
        wordsPerCue,
        captionSoftBreaks(visibleWords.map((entry, index) => ({ raw: breakRaws[index]!, startSec: entry.word.startSec, endSec: entry.word.endSec }))),
        visibleWords.map((entry) => captionWordIsMinor(entry.word.text, language)),
      );
      for (const [groupIndex, range] of groups.entries()) {
        const group = visibleWords.slice(range.start, range.end);
        const startSec = group[0]!.word.startSec;
        const endSec = Math.max(
          startSec + 0.1,
          group[group.length - 1]!.word.endSec,
        );
        pending.push({
          layerIndex: layers.length,
          emphasis: emphasis.slice(range.start, range.end),
          blockWords: group.map((entry) => ({ text: entry.text, key: null })),
          speaker: null,
        });
        sources.push(null);
        layers.push({
          id: `layer:caption:dub:${segmentIndex}:${groupIndex}:${target.id}`,
          kind: "caption",
          activeRange: { startSec, endSec },
          anchor,
          destination,
          rotationDeg: 0,
          opacity: 1,
          zIndex: 40,
          cueIndex: layers.length,
          words: group.map((entry, index) => ({
            text: entry.formatted,
            ...(entry.word.spaceBefore === undefined ? {} : { spaceBefore: entry.word.spaceBefore }),
            startSec: entry.word.startSec,
            endSec:
              index + 1 < group.length
                ? Math.max(entry.word.startSec + 0.05, group[index + 1]!.word.startSec)
                : Math.max(entry.word.startSec + 0.1, entry.word.endSec),
          })),
          emojis: [],
          preset,
          language,
        });
      }
    }
    // Dub captions are in another language: Clip Emphasis Words do not apply.
    return { layers, sources, pending, emojis: dubCaptionEmojis(document, editedTimeMap), language, emphasisWords: undefined };
  }

  const emojisByWord = captionEmojisByWord(document);
  for (const [utterancePosition, utterance] of document.transcriptSlice.entries()) {
    const visibleWords: {
      word: (typeof utterance.words)[number];
      wordIndex: number;
      range: { startSec: number; endSec: number };
      text: string;
      formatted: string;
      masked: boolean;
      /** A censored word takes no emoji. */
      emoji: CaptionEmojiRef | undefined;
    }[] = [];
    const breakTokens: { raw: string; visible: boolean }[] = [];
    for (const [wordIndex, word] of utterance.words.entries()) {
      const range = sourceWordToEdited(editedTimeMap, word);
      if (!range) continue;
      const wordId = autoCensorWordId({
        utteranceIndex: utterance.index,
        wordIndex,
        word,
      });
      const maskSegment = [...document.censorSegments]
        .filter((segment) =>
          segment.enabled &&
          segment.treatment === "caption_mask" &&
          segment.captionMaskPolicy !== null &&
          segment.sourceWordIds.includes(wordId),
        )
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      // Strip punctuation, then mask, then case: see censoredCaptionWordText.
      const text = censoredCaptionWordText(word.word, maskSegment?.captionMaskPolicy ?? null, { punctuation });
      const formatted = applyCaptionTextTransform(text, preset.textTransform, language);
      // A punctuation-only token hidden by the Punctuation toggle still ends a phrase.
      breakTokens.push({ raw: word.word, visible: formatted !== "" });
      if (!formatted) continue;
      const masked = maskSegment !== undefined;
      const emoji = masked ? undefined : emojisByWord.get(captionEmojiWordId(utterancePosition, wordIndex));
      visibleWords.push({ word, wordIndex, range, text, formatted, masked, emoji });
    }
    const breakRaws = captionBreakRaws(breakTokens);

    if (utterance.words.length > 0) {
      const emphasis = visibleWords.map((entry, index): CaptionEmphasisWord => ({
        key: captionWordKey(entry.word.startSec),
        raw: entry.word.word,
        sourceStartSec: entry.word.startSec,
        sourceEndSec: entry.word.endSec,
        utteranceIndex: utterance.index,
        utteranceFinal: index === visibleWords.length - 1,
        pauseBeforeSec: pauseBefore(entry.range.startSec, entry.range.endSec),
        masked: entry.masked,
      }));
      const groups = groupCaptionTokensWithMerges(
        visibleWords.map((entry) => entry.formatted),
        wordsPerCue,
        captionSoftBreaks(visibleWords.map((entry, index) => ({ raw: breakRaws[index]!, ...entry.range }))),
        visibleWords.map((entry) => captionWordIsMinor(entry.word.word, language)),
        mergedCaptionRanges(document.studioEdits.captionMerges, utterance.words, visibleWords),
      );
      for (const [groupIndex, range] of groups.entries()) {
        const group = visibleWords.slice(range.start, range.end);
        const cueIndex = layers.length;
        const startSec = group[0]!.range.startSec;
        const endSec = Math.max(
          startSec + 0.1,
          group[group.length - 1]!.range.endSec,
        );
        group.forEach((entry, wordIndex) => {
          if (entry.emoji) pendingEmojis.push({ layerIndex: cueIndex, wordIndex, ref: entry.emoji });
        });
        pending.push({
          layerIndex: cueIndex,
          emphasis: emphasis.slice(range.start, range.end),
          blockWords: group.map((entry) => ({ text: entry.text, key: captionWordKey(entry.word.startSec) })),
          speaker: utterance.speaker,
        });
        sources.push({ utterance: utterancePosition, words: group.map((entry) => entry.wordIndex) });
        layers.push({
          id: `layer:caption:${utterance.index}:${groupIndex}:${target.id}`,
          kind: "caption",
          activeRange: { startSec, endSec },
          anchor,
          destination,
          rotationDeg: 0,
          opacity: 1,
          zIndex: 40,
          cueIndex,
          words: group.map((entry, index) => ({
            text: entry.formatted,
            ...(entry.word.spaceBefore === undefined ? {} : { spaceBefore: entry.word.spaceBefore }),
            startSec: entry.range.startSec,
            endSec:
              index + 1 < group.length
                ? Math.max(entry.range.startSec + 0.05, group[index + 1]!.range.startSec)
                : Math.max(entry.range.startSec + 0.1, entry.range.endSec),
          })),
          emojis: [],
          preset,
          language,
        });
      }
      continue;
    }

    const range = sourceRangeToEdited(editedTimeMap, utterance);
    if (!range) continue;
    const text = applyCaptionTextTransform(
      fallbackCaptionText(utterance.text, punctuation),
      preset.textTransform,
      language,
    );
    if (!text) continue;
    const untimedEmoji = emojisByWord.get(captionEmojiWordId(utterancePosition, -1));
    if (untimedEmoji) pendingEmojis.push({ layerIndex: layers.length, wordIndex: 0, ref: untimedEmoji });
    // Untimed utterances render as the classic line. They still take part in
    // scoring, so the repeat penalty restarts after them as it does for G1.
    pending.push({
      layerIndex: null,
      emphasis: [{
        key: captionWordKey(utterance.startSec),
        raw: utterance.text,
        sourceStartSec: utterance.startSec,
        sourceEndSec: utterance.endSec,
        utteranceIndex: utterance.index,
        utteranceFinal: true,
        pauseBeforeSec: pauseBefore(range.startSec, range.endSec),
        masked: false,
        untimed: true,
      }],
      blockWords: [],
      speaker: utterance.speaker,
    });
    sources.push({ utterance: utterancePosition, words: [] });
    layers.push({
      id: `layer:caption:${utterance.index}:0:${target.id}`,
      kind: "caption",
      activeRange: range,
      anchor,
      destination,
      rotationDeg: 0,
      opacity: 1,
      zIndex: 40,
      cueIndex: layers.length,
      words: [
        {
          text,
          startSec: range.startSec,
          endSec: range.endSec,
        },
      ],
      emojis: [],
      preset,
      language,
    });
  }

  return { layers, sources, pending, emojis: pendingEmojis, language, emphasisWords: document.emphasisWords };
}

/** Bounds each cue to its successor, in place: one caption line owns each instant in both preview and export. */
function boundCaptionCues(layers: CompositionCaptionVisualLayer[]): void {
  // Provider word windows and the minimum cue duration may overlap the next utterance.
  for (let index = 0; index + 1 < layers.length; index++) {
    const layer = layers[index]!;
    const next = layers[index + 1]!;
    if (layer.activeRange.endSec > next.activeRange.startSec) {
      layers[index] = { ...layer, activeRange: { ...layer.activeRange, endSec: Math.max(layer.activeRange.startSec, next.activeRange.startSec) } };
    }
  }
  for (let index = 0; index < layers.length; index++) {
    const layer = layers[index]!;
    let before = layer.activeRange.endSec;
    // A provider can put a zero-duration final word exactly on the next
    // utterance's onset. Reserve its minimum display window before that
    // handoff instead of dropping the word or painting two cues together.
    const words = [...layer.words];
    for (let at = words.length - 1; at >= 0; at--) {
      const word = words[at]!;
      if (word.startSec >= before) {
        words[at] = { ...word, startSec: Math.max(layer.activeRange.startSec, before - 0.05) };
      }
      before = words[at]!.startSec;
    }
    layers[index] = { ...layer, words };
  }
}

/** Bound each cue to its successor, then attach emojis, roles and a Caption Block or Scene Style facts.
 * A cue its successor bounds to zero length (a zero-length word, or two utterances that start together)
 * can never show and is not returned; its emojis go with it, and the cues after it are numbered on. */
function finalizeCaptionLayers(
  layers: CompositionCaptionVisualLayer[],
  pending: readonly PendingCaptionCue[],
  emojis: readonly PendingCaptionEmoji[],
  document: EditorDocument,
  language: string | null,
  emphasisWords: readonly string[] | undefined,
): CompositionCaptionVisualLayer[] {
  boundCaptionCues(layers);
  const emojiWords = attachCaptionEmojis(layers, emojis);
  const preset = document.captionPreset;
  if ((!preset.dynamic && !preset.scene) || pending.length === 0) return numberCaptionCues(layers.filter(captionLayerCanShow));
  const roles = assignCaptionRoles({
    // A word whose emoji is drawn is its cue's hero, so the highlighted word is the one the emoji shows.
    cues: pending.map((cue) => {
      const marked = cue.layerIndex === null ? undefined : emojiWords.get(cue.layerIndex);
      return marked ? cue.emphasis.map((word, index) => (marked.has(index) ? { ...word, emoji: true } : word)) : cue.emphasis;
    }),
    language,
    overrides: document.studioEdits.captionEmphasis ?? {},
    // A style without a hero (a Dynamic tile style like Cutout) never picks one, whatever the overrides say. Every Scene Style
    // draws a hero (`emphasis` is "auto" for all sixteen, Dialogue included: its hero word gets a marker), so none passes "never".
    policy: (preset.scene ? captionSceneMeta(preset.scene).emphasis : captionDynamicStyle(preset.dynamic!).emphasis) ?? "auto",
    ...(emphasisWords ? { emphasisWords } : {}),
  });
  pending.forEach((cue, index) => {
    if (cue.layerIndex === null) return;
    const layer = layers[cue.layerIndex]!;
    if (preset.scene) {
      layers[cue.layerIndex] = { ...layer, scene: { roles: [...roles[index]!.roles], keys: cue.blockWords.map((word) => word.key), speaker: cue.speaker } };
      return;
    }
    const block = captionCueBlock(cue.blockWords, preset, language, layer.cueIndex, roles[index]!);
    if (block) layers[cue.layerIndex] = { ...layer, block };
  });
  return numberCaptionCues(layers.filter(captionLayerCanShow));
}

function captionLayerCanShow(layer: CompositionCaptionVisualLayer) {
  return layer.activeRange.endSec > layer.activeRange.startSec;
}

function visualLayersForTarget(input: {
  document: EditorDocument;
  target: CompositionTarget;
  scenes: readonly CompositionScene[];
  editedTimeMap: EditedTimeMap;
  logo: CompositionLogoAvailability | undefined;
  captionLanguage: string | null;
  captionOverride?: CaptionOverride | undefined;
}): CompositionVisualLayer[] {
  const { document, target, editedTimeMap, logo, captionLanguage, captionOverride } = input;
  const duration = editedTimeMap.editedDurationSec;
  const destination = { x: 0, y: 0, width: target.width, height: target.height };
  const visualLayers: CompositionVisualLayer[] = [];

  for (const layer of document.studioEdits.textLayers) {
    const startSec = Math.max(0, Math.min(duration, layer.startSec));
    const endSec = Math.max(
      startSec,
      Math.min(duration, layer.endSec ?? duration),
    );
    if (endSec <= startSec) continue;
    const value = { ...layer, startSec, endSec };
    visualLayers.push({
      id: `layer:text:${layer.id}:${target.id}`,
      kind: "text",
      activeRange: { startSec, endSec },
      anchor: { xPct: layer.positionX ?? 50, yPct: layer.positionY ?? 18 },
      destination,
      rotationDeg: 0,
      opacity: 1,
      zIndex: 30,
      value,
    });
  }

  const captions = captionLayersForTarget({
    document,
    target,
    editedTimeMap,
    language: captionLanguage,
    captionOverride,
  });
  const useSpeakerSeam = document.studioEdits.framing.mode === "auto" &&
    document.captionPreset.position === "bottom" &&
    document.captionPreset.positionY === undefined;
  for (const caption of captions) {
    // A bottom speaker's face sits near 71% of the full canvas, directly
    // behind the default bottom captions. Keep the canonical cue intact and
    // use the tile seam whenever it overlaps a stacked camera scene.
    const stackedScene = useSpeakerSeam ? input.scenes.find((scene) =>
      scene.startSec < caption.activeRange.endSec &&
      scene.endSec > caption.activeRange.startSec &&
      scene.layers.some((layer) => layer.kind === "source-video" && layer.speaker?.role === "top") &&
      scene.layers.some((layer) => layer.kind === "source-video" && layer.speaker?.role === "bottom"),
    ) : undefined;
    const top = stackedScene?.layers.find((layer) => layer.kind === "source-video" && layer.speaker?.role === "top");
    const bottom = stackedScene?.layers.find((layer) => layer.kind === "source-video" && layer.speaker?.role === "bottom");
    const seam = top && bottom &&
      Math.abs(top.destination.y + top.destination.height - bottom.destination.y) <= 2
      ? (top.destination.y + top.destination.height + bottom.destination.y) / 2
      : null;
    visualLayers.push(seam === null ? caption : {
      ...caption,
      anchor: { ...caption.anchor, yPct: seam / target.height * 100 },
    });
  }

  if (logo?.state === "available" && logo.settings.enabled) {
    visualLayers.push({
      id: `layer:logo:${target.id}`,
      kind: "logo",
      sourceRef: logo.ref,
      activeRange: { startSec: 0, endSec: duration },
      destination,
      position: logo.settings.position,
      marginPx: 24,
      widthPx: Math.max(
        40,
        Math.round(target.width * (logo.settings.scalePct / 100)),
      ),
      rotationDeg: 0,
      opacity: Math.max(0.1, Math.min(1, logo.settings.opacity / 100)),
      zIndex: 50,
    });
  }

  const transition = document.studioEdits.transition;
  if (transition.type !== "none") {
    const transitionDuration = Math.min(transition.durationSec, duration / 2);
    if (transitionDuration > 0) {
      visualLayers.push({
        id: `layer:transition:${target.id}`,
        kind: "transition",
        activeRange: { startSec: 0, endSec: duration },
        destination,
        transition: transition.type,
        application:
          transition.type === "fade" ||
          transition.type === "fade-black" ||
          transition.type === "dip-white"
            ? "overlay"
            : "source",
        color: transition.type === "dip-white" ? "white" : "black",
        motion: planTransitionMotion({
          type: transition.type,
          durationSec: transitionDuration,
          activeRange: { startSec: 0, endSec: duration },
          canvas: { width: target.width, height: target.height },
        }),
        rotationDeg: 0,
        opacity: 1,
        zIndex: 60,
      });
    }
  }

  if (target.outputTreatment) {
    const outputPx = compositionOutputSize(
      { width: target.width, height: target.height },
      target.outputTreatment.resolution,
    );
    visualLayers.push({
      id: `layer:output-treatment:${target.id}`,
      kind: "output-treatment",
      activeRange: { startSec: 0, endSec: duration },
      destination,
      resolution: target.outputTreatment.resolution,
      scale:
        target.outputTreatment.resolution === "720p"
          ? { numerator: 2, denominator: 3 }
          : { numerator: 1, denominator: 1 },
      watermark: target.outputTreatment.watermark
        ? {
            enabled: true,
            art: NARRIFLOW_WATERMARK_ART.id,
            outputPx,
            rectPx: watermarkRect(outputPx),
          }
        : { enabled: false },
      rotationDeg: 0,
      opacity: 1,
      zIndex: 70,
    });
  }

  return visualLayers;
}

function validateInput(
  input: ClipCompositionPlanInput,
): Extract<ClipCompositionPlanResult, { status: "invalid" }> | null {
  if (
    input.source.identity.length === 0 ||
    !Number.isInteger(input.source.width) ||
    !Number.isInteger(input.source.height) ||
    (input.source.kind === "video" &&
      (input.source.width <= 0 || input.source.height <= 0)) ||
    (input.source.kind === "audio" &&
      (input.source.width !== 0 || input.source.height !== 0))
  ) {
    return { status: "invalid", error: { code: "invalid_source_facts" } };
  }
  if (input.targets.length > CLIP_COMPOSITION_MAX_TARGETS) {
    return { status: "invalid", error: { code: "too_many_targets" } };
  }
  if (
    input.targets.length === 0 ||
    new Set(input.targets.map((target) => target.id)).size !== input.targets.length
  ) {
    return { status: "invalid", error: { code: "invalid_target" } };
  }
  for (const target of input.targets) {
    if (
      target.id.length === 0 ||
      !Number.isInteger(target.width) ||
      !Number.isInteger(target.height) ||
      target.width <= 0 ||
      target.height <= 0 ||
      target.width % 2 !== 0 ||
      target.height % 2 !== 0
    ) {
      return {
        status: "invalid",
        error: { code: "invalid_target", targetId: target.id },
      };
    }
  }
  return null;
}

export function planClipComposition(
  input: ClipCompositionPlanInput,
): ClipCompositionPlanResult {
  const invalid = validateInput(input);
  if (invalid) return invalid;
  const sceneBackground = resolveSceneBackground(input);

  const sceneTextRenders = new Map<string, CompositionSceneTextRender>();
  for (const target of input.targets) {
    for (const scene of input.document.sceneBlocks) {
      if (scene.content.kind !== "text") continue;
      const textRender = fitSceneText(scene.content.text, target);
      if (!textRender) {
        return {
          status: "invalid",
          error: {
            code: "text_scene_unfit",
            targetId: target.id,
            sceneId: scene.id,
          },
        };
      }
      sceneTextRenders.set(sceneTextRenderKey(target.id, scene.id), textRender);
    }
  }

  const editedTimeMap = buildClipCutPlan(input.document.deletedRanges, {
    startSec: input.document.clipStartSec,
    endSec: input.document.clipEndSec,
  }).map;
  if (editedTimeMap.editedDurationSec <= 0) {
    return { status: "invalid", error: { code: "empty_edited_timeline" } };
  }
  const resolvedAudioAssets = resolveRequestedAudioAssets(
    input,
    editedTimeMap.editedDurationSec,
  );

  const brollAvailability = input.assets.broll;
  const brollPlacements =
    brollAvailability?.state === "available"
      ? [...brollAvailability.placements].sort(
          (left, right) => left.startSec - right.startSec,
        )
      : [];
  for (const [index, placement] of brollPlacements.entries()) {
    const previous = brollPlacements[index - 1];
    if (
      placement.id.length === 0 ||
      placement.ref.length === 0 ||
      !Number.isFinite(placement.startSec) ||
      !Number.isFinite(placement.endSec) ||
      placement.startSec < 0 ||
      placement.endSec <= placement.startSec ||
      placement.endSec > editedTimeMap.editedDurationSec ||
      (previous !== undefined && placement.startSec < previous.endSec)
    ) {
      return {
        status: "invalid",
        error: { code: "invalid_broll_placement" },
      };
    }
  }
  const hasActiveBroll = brollPlacements.length > 0;

  const requestedMode = resolveEffectiveFramingMode(input.document.studioEdits);
  const targetAspectRatios = new Set(input.targets.map((target) => target.aspectRatio));
  const activeSceneLayouts = input.document.studioEdits.sceneLayouts.filter(
    (selection) => targetAspectRatios.has(selection.aspectRatio),
  );
  const sceneLayoutsNeedAutomaticEvidence = activeSceneLayouts.some((selection) =>
    sceneLayoutPresetNeedsAutomaticEvidence(selection.preset),
  );
  if (
    requestedMode !== "center" &&
    requestedMode !== "fit" &&
    requestedMode !== "auto" &&
    requestedMode !== "split" &&
    requestedMode !== "screen"
  ) {
    return { status: "invalid", error: { code: "unsupported_mode" } };
  }

  const inputFingerprint = hashString(
    JSON.stringify({
      source: input.source,
      window: {
        startSec: input.document.clipStartSec,
        endSec: input.document.clipEndSec,
        deletedRanges: input.document.deletedRanges,
      },
      mode: requestedMode,
      background: {
        mode: input.document.studioEdits.background.mode,
        color: input.document.studioEdits.background.color,
      },
      speakerLayoutOverrides:
        input.document.studioEdits.speakerLayoutOverrides,
      sceneLayouts: input.document.studioEdits.sceneLayouts,
      visualLayers: {
        captionPreset: input.document.captionPreset,
        transcriptSlice: input.document.transcriptSlice,
        textLayers: input.document.studioEdits.textLayers,
        transition: input.document.studioEdits.transition,
      },
      ...(input.document.sceneBlocks.length > 0
        ? { sceneBlocks: input.document.sceneBlocks }
        : {}),
      ...(input.captionOverride ? { captionOverride: input.captionOverride } : {}),
      assets: input.assets,
      evidence:
        {
          automatic:
            input.evidence.automaticLayout.state === "available"
              ? {
                  state: "available",
                  sourceIdentity:
                    input.evidence.automaticLayout.value.sourceIdentity,
                  inputFingerprint:
                    input.evidence.automaticLayout.value.inputFingerprint,
                  engineVersion:
                    input.evidence.automaticLayout.value.engineVersion,
                }
              : { state: input.evidence.automaticLayout.state },
          split:
            input.evidence.splitLayout?.state === "available"
              ? {
                  state: "available",
                  sourceIdentity: input.evidence.splitLayout.value.sourceIdentity,
                  inputFingerprint:
                    input.evidence.splitLayout.value.inputFingerprint,
                  engineVersion: input.evidence.splitLayout.value.engineVersion,
                  source: input.evidence.splitLayout.value.source,
                }
              : { state: input.evidence.splitLayout?.state ?? "missing" },
          screen:
            input.evidence.screenLayout?.state === "available"
              ? {
                  state: "available",
                  sourceIdentity: input.evidence.screenLayout.value.sourceIdentity,
                  inputFingerprint:
                    input.evidence.screenLayout.value.inputFingerprint,
                  engineVersion: input.evidence.screenLayout.value.engineVersion,
                  source: input.evidence.screenLayout.value.source,
                }
              : { state: input.evidence.screenLayout?.state ?? "missing" },
        },
      ...(input.evidence.framingDegraded ? { framingDegraded: input.evidence.framingDegraded } : {}),
      capabilities: input.capabilities,
      targets: input.targets,
    }),
  );

  const notices: CompositionNotice[] = [];
  const evidenceRequests: CompositionEvidenceRequest[] = [];
  const automaticEvidenceFingerprint = automaticLayoutInputFingerprint({
    sourceIdentity: input.source.identity,
    clipStartSec: input.document.clipStartSec,
    clipEndSec: input.document.clipEndSec,
    deletedRanges: input.document.deletedRanges,
    engineVersion: input.capabilities.automaticSpeakerEngineVersion,
  });
  const automaticAnalysis =
    input.source.kind === "video" &&
    input.capabilities.automaticSpeakerLayout
      ? validAutomaticLayoutEvidence(
          input.evidence.automaticLayout,
          input,
          editedTimeMap.editedDurationSec,
        )
      : null;
  const automaticEvidenceIsProvisional =
    input.source.kind === "video" &&
    (requestedMode === "auto" ||
      sceneLayoutsNeedAutomaticEvidence ||
      (hasActiveBroll &&
        (requestedMode === "split" || requestedMode === "screen"))) &&
    input.capabilities.automaticSpeakerLayout &&
    !automaticAnalysis &&
    input.evidence.automaticLayout.state !== "failed" &&
    input.evidence.automaticLayout.state !== "disabled";
  if (automaticEvidenceIsProvisional) {
    evidenceRequests.push({
      key: `automatic-speaker-layout:${automaticEvidenceFingerprint}`,
      kind: "automatic-speaker-layout",
      engineVersion: input.capabilities.automaticSpeakerEngineVersion,
    });
  }

  const splitEngineVersion = input.capabilities.splitEngineVersion ?? "explicit-split-v1";
  const splitAvailability = input.evidence.splitLayout ?? { state: "missing" as const };
  const splitEvidence =
    requestedMode === "split" &&
    input.capabilities.explicitSplitLayout !== false &&
    splitAvailability.state === "available" &&
    evidenceMatches(splitAvailability.value, input, splitEngineVersion) &&
    segmentsAreComplete(
      splitAvailability.value.segments,
      editedTimeMap.editedDurationSec,
      CLIP_SPLIT_LAYOUT_MAX_SEGMENTS,
    ) &&
    segmentsAreComplete(
      splitAvailability.value.fallbackSegments,
      editedTimeMap.editedDurationSec,
      CLIP_SPLIT_LAYOUT_MAX_SEGMENTS,
    )
      ? splitAvailability.value
      : null;
  const splitEvidenceIsProvisional =
    input.source.kind === "video" &&
    requestedMode === "split" &&
    input.capabilities.explicitSplitLayout !== false &&
    !hasActiveBroll &&
    !splitEvidence &&
    splitAvailability.state !== "failed" &&
    splitAvailability.state !== "disabled";
  if (splitEvidenceIsProvisional) {
    evidenceRequests.push({
      key: `split-speaker-layout:${splitLayoutInputFingerprint({
        sourceIdentity: input.source.identity,
        clipStartSec: input.document.clipStartSec,
        clipEndSec: input.document.clipEndSec,
        deletedRanges: input.document.deletedRanges,
        engineVersion: splitEngineVersion,
      })}`,
      kind: "split-speaker-layout",
      engineVersion: splitEngineVersion,
    });
  }

  const screenEngineVersion =
    input.capabilities.screenEngineVersion ?? SCREEN_LAYOUT_ENGINE_VERSION;
  const screenAvailability = input.evidence.screenLayout ?? { state: "missing" as const };
  const screenEvidence =
    requestedMode === "screen" &&
    input.capabilities.screenLayout !== false &&
    screenAvailability.state === "available" &&
    evidenceMatches(screenAvailability.value, input, screenEngineVersion) &&
    (screenAvailability.value.faceBand.state !== "available" ||
      segmentsAreComplete(
        screenAvailability.value.faceBand.segments,
        editedTimeMap.editedDurationSec,
        CLIP_AUTO_LAYOUT_MAX_SEGMENTS,
      ))
      ? screenAvailability.value
      : null;
  const screenEvidenceIsProvisional =
    input.source.kind === "video" &&
    requestedMode === "screen" &&
    input.capabilities.screenLayout !== false &&
    !hasActiveBroll &&
    !screenEvidence &&
    screenAvailability.state !== "failed" &&
    screenAvailability.state !== "disabled";
  if (screenEvidenceIsProvisional) {
    evidenceRequests.push({
      key: `screen-layout:${screenLayoutInputFingerprint({
        sourceIdentity: input.source.identity,
        clipStartSec: input.document.clipStartSec,
        clipEndSec: input.document.clipEndSec,
        deletedRanges: input.document.deletedRanges,
        engineVersion: screenEngineVersion,
      })}`,
      kind: "screen-layout",
      engineVersion: screenEngineVersion,
    });
  }

  const initialBaseTargets: CompositionBaseTargetPlan[] = input.targets.map((target) => {
    const canvas = {
      width: target.width,
      height: target.height,
      divisibleBy: 2 as const,
    };
    if (input.source.kind === "audio") {
      return {
        id: target.id,
        aspectRatio: target.aspectRatio,
        requestedMode,
        effectiveMode: "audiogram",
        canvas,
        scenes: [
          {
            id: `scene:audiogram:${target.id}:0`,
            startSec: 0,
            endSec: editedTimeMap.editedDurationSec,
            layers: [
              {
                id: `layer:audiogram:${target.id}:0`,
                kind: "audiogram",
                sourceRef: input.source.identity,
                destination: {
                  x: 0,
                  y: 0,
                  width: target.width,
                  height: target.height,
                },
                backgroundColor: "#0F172A",
                waveformColor:
                  input.document.captionPreset.highlightColor ?? "#00FF88",
                waveformHeightRatio: 0.42,
                rotationDeg: 0,
                opacity: 1,
                zIndex: 0,
              },
            ],
          },
        ],
      };
    }
    const degraded = input.evidence.framingDegraded;
    if (degraded && degraded.modes.some((mode) => mode === requestedMode)) {
      notices.push({ code: "framing_degraded", fidelity: "degraded", targetId: target.id, sceneId: null, effectiveFallback: "center", userActionPossible: false, attempts: degraded.attempts, causeCode: degraded.causeCode });
      return {
        id: target.id, aspectRatio: target.aspectRatio, requestedMode, effectiveMode: "center", canvas,
        scenes: [{ id: `scene:framing-degraded:${target.id}:0`, startSec: 0, endSec: editedTimeMap.editedDurationSec, layers: [{
          id: `layer:source:${target.id}:0`, kind: "source-video", sourceRef: input.source.identity,
          sourceCrop: centeredCoverCrop(input.source, target), destination: { x: 0, y: 0, width: target.width, height: target.height },
          fit: "cover", rotationDeg: 0, opacity: 1, zIndex: 0,
        }] }],
      };
    }
    if (requestedMode === "split") {
      const fallbackSegments =
        splitEvidence?.fallbackSegments ?? automaticAnalysis?.noSplitSegments ?? null;
      const centerFallback = (effectiveMode: "center" | "auto") => ({
        id: target.id,
        aspectRatio: target.aspectRatio,
        requestedMode,
        effectiveMode,
        canvas,
        scenes:
          effectiveMode === "auto" && fallbackSegments
            ? speakerScenes({
                mode: "auto",
                source: input.source,
                target,
                segments: fallbackSegments,
                overrides: input.document.studioEdits.speakerLayoutOverrides,
                background: sceneBackground,
              })
            : [
                {
                  id: `scene:split-fallback:${target.id}:0`,
                  startSec: 0,
                  endSec: editedTimeMap.editedDurationSec,
                  layers: [
                    {
                      id: `layer:source:${target.id}:0`,
                      kind: "source-video" as const,
                      sourceRef: input.source.identity,
                      sourceCrop: centeredCoverCrop(input.source, target),
                      destination: {
                        x: 0,
                        y: 0,
                        width: target.width,
                        height: target.height,
                      },
                      fit: "cover" as const,
                      rotationDeg: 0,
                      opacity: 1,
                      zIndex: 0,
                    },
                  ],
                },
              ],
      });
      const brollConflict = hasActiveBroll;
      const disabled = input.capabilities.explicitSplitLayout === false;
      if (brollConflict || disabled || !splitEvidence) {
        const provisional = splitEvidenceIsProvisional;
        const effectiveFallback =
          brollConflict && fallbackSegments ? "auto" : "center";
        notices.push({
          code: brollConflict
            ? "split_broll_conflict"
            : provisional
              ? "split_layout_analyzing"
              : disabled || splitAvailability.state === "disabled"
                ? "split_layout_disabled"
                : splitAvailability.state === "failed" && splitAvailability.reason
                  ? `split_${splitAvailability.reason}`
                  : "split_layout_unavailable",
          fidelity: provisional ? "pending" : "degraded",
          targetId: target.id,
          sceneId: null,
          effectiveFallback,
          userActionPossible: false,
        });
        return centerFallback(effectiveFallback);
      }
      if (!splitEvidence.segments.some((segment) => segment.layout === "two-up")) {
        notices.push({
          code: "split_no_two_up_scenes",
          fidelity: "degraded",
          targetId: target.id,
          sceneId: null,
          effectiveFallback: "auto",
          userActionPossible: false,
        });
        return centerFallback("auto");
      }
      if (!targetSupportsTwoUp(input.source, target)) {
        notices.push({
          code: "split_target_ineligible",
          fidelity: "degraded",
          targetId: target.id,
          sceneId: null,
          effectiveFallback: "auto",
          userActionPossible: false,
        });
        return centerFallback("auto");
      }
      const scenes = speakerScenes({
        mode: "split",
        source: input.source,
        target,
        segments: splitEvidence.segments,
        overrides: input.document.studioEdits.speakerLayoutOverrides,
        background: sceneBackground,
      });
      const resolvedScenes = scenes.flatMap((scene) => {
        const layers = scene.layers.filter(
          (layer) => layer.kind === "source-video",
        );
        const duplicated =
          layers.length === 2 &&
          !cropsAreLaterallyDistinct(
            layers[0]!.sourceCrop,
            layers[1]!.sourceCrop,
            input.source.width,
          );
        if (!duplicated) return [scene];
        notices.push({
          code: "split_tiles_not_distinct",
          fidelity: "degraded",
          targetId: target.id,
          sceneId: scene.id,
          effectiveFallback: "auto",
          userActionPossible: false,
        });
        const fallbackSegments = splitEvidence.fallbackSegments
          .filter(
            (segment) =>
              segment.endSec > scene.startSec && segment.startSec < scene.endSec,
          )
          .map((segment) => ({
            ...segment,
            startSec: Math.max(segment.startSec, scene.startSec),
            endSec: Math.min(segment.endSec, scene.endSec),
          }));
        return speakerScenes({
          mode: "auto",
          source: input.source,
          target,
          segments: fallbackSegments,
          overrides: input.document.studioEdits.speakerLayoutOverrides,
          background: sceneBackground,
        }).map((fallbackScene, index) => ({
          ...fallbackScene,
          id: `${scene.id}:fallback:${index}`,
        }));
      });
      const hasUsableTwoUpScene = resolvedScenes.some(
        (scene) =>
          scene.layers.filter((layer) => layer.kind === "source-video").length ===
          2,
      );
      return {
        id: target.id,
        aspectRatio: target.aspectRatio,
        requestedMode,
        effectiveMode: hasUsableTwoUpScene ? "split" : "auto",
        canvas,
        scenes: resolvedScenes,
      };
    }
    if (requestedMode === "screen") {
      const screenFallbackSegments = automaticAnalysis?.noSplitSegments ?? null;
      const wholeClipFallback = (effectiveMode: "center" | "auto") => ({
        id: target.id,
        aspectRatio: target.aspectRatio,
        requestedMode,
        effectiveMode,
        canvas,
        scenes:
          effectiveMode === "auto" && screenFallbackSegments
            ? speakerScenes({
                mode: "auto",
                source: input.source,
                target,
                segments: screenFallbackSegments,
                overrides: input.document.studioEdits.speakerLayoutOverrides,
                background: sceneBackground,
              })
            : [
                {
                  id: `scene:screen-fallback:${target.id}:0`,
                  startSec: 0,
                  endSec: editedTimeMap.editedDurationSec,
                  layers: [
                    {
                      id: `layer:source:${target.id}:0`,
                      kind: "source-video" as const,
                      sourceRef: input.source.identity,
                      sourceCrop: centeredCoverCrop(input.source, target),
                      destination: {
                        x: 0,
                        y: 0,
                        width: target.width,
                        height: target.height,
                      },
                      fit: "cover" as const,
                      rotationDeg: 0,
                      opacity: 1,
                      zIndex: 0,
                    },
                  ],
                },
              ],
      });
      const brollConflict = hasActiveBroll;
      const disabled = input.capabilities.screenLayout === false;
      if (brollConflict || disabled) {
        const effectiveFallback =
          brollConflict && screenFallbackSegments ? "auto" : "center";
        notices.push({
          code: brollConflict ? "screen_broll_conflict" : "screen_layout_disabled",
          fidelity: "degraded",
          targetId: target.id,
          sceneId: null,
          effectiveFallback,
          userActionPossible: false,
        });
        return wholeClipFallback(effectiveFallback);
      }

      const pipCrop =
        screenEvidence?.pictureInPicture.state === "confirmed"
          ? screenPipCrop(
              screenEvidence.pictureInPicture.rect,
              target,
              input.source,
            )
          : null;
      let scenes: CompositionScene[];
      if (pipCrop) {
        scenes = [
          screenScene(
            input.source,
            target,
            0,
            0,
            editedTimeMap.editedDurationSec,
            pipCrop,
          ),
        ];
      } else if (
        screenEvidence?.faceBand.state === "available" &&
        targetSupportsTwoUp(input.source, target)
      ) {
        const [, bottom] = evenStackFrames(target);
        scenes = screenEvidence.faceBand.segments.map((segment, sceneIndex) => {
          const single =
            segment.layout === "single"
              ? segment
              : {
                  startSec: segment.startSec,
                  endSec: segment.endSec,
                  layout: "single" as const,
                  cxNorm: (segment.topCxNorm + segment.bottomCxNorm) / 2,
                  cyNorm: 0.5,
                  zoom: 1,
                };
          const transform = canonicalSplitTransforms(single, target)[0]!;
          return screenScene(
            input.source,
            target,
            sceneIndex,
            segment.startSec,
            segment.endSec,
            cropForSpeakerLayer(input.source, bottom, transform),
          );
        });
      } else {
        const [, bottom] = evenStackFrames(target);
        scenes = [
          screenScene(
            input.source,
            target,
            0,
            0,
            editedTimeMap.editedDurationSec,
            centeredCoverCrop(input.source, bottom),
          ),
        ];
      }

      const provisional = screenEvidenceIsProvisional;
      if (!screenEvidence || !pipCrop) {
        notices.push({
          code: provisional
            ? "screen_layout_analyzing"
            : screenAvailability.state === "failed" && screenAvailability.reason
              ? `screen_${screenAvailability.reason}`
              : pipCrop === null && screenEvidence?.pictureInPicture.state === "confirmed"
                ? "screen_pip_too_small"
                : screenEvidence?.faceBand.state === "available" &&
                    targetSupportsTwoUp(input.source, target)
                  ? "screen_face_band_fallback"
                  : "screen_static_center_fallback",
          fidelity: provisional ? "pending" : "degraded",
          targetId: target.id,
          sceneId: null,
          effectiveFallback: "screen",
          userActionPossible: false,
        });
      }
      return {
        id: target.id,
        aspectRatio: target.aspectRatio,
        requestedMode,
        effectiveMode: "screen",
        canvas,
        scenes,
      };
    }
    if (requestedMode === "auto") {
      if (automaticAnalysis) {
        const segments = targetSupportsTwoUp(input.source, target)
          ? automaticAnalysis.segments
          : automaticAnalysis.noSplitSegments;
        if (segments.length > 0) {
          return {
            id: target.id,
            aspectRatio: target.aspectRatio,
            requestedMode,
            effectiveMode: "auto",
            canvas,
            scenes: speakerScenes({
              mode: "auto",
              source: input.source,
              target,
              segments,
              overrides: input.document.studioEdits.speakerLayoutOverrides,
              background: sceneBackground,
            }),
          };
        }
      }

      const provisional = automaticEvidenceIsProvisional;
      const disabled =
        !input.capabilities.automaticSpeakerLayout ||
        input.evidence.automaticLayout.state === "disabled";
      notices.push({
        code: provisional
          ? "automatic_layout_analyzing"
          : disabled
            ? "automatic_layout_disabled"
            : "automatic_layout_unavailable",
        fidelity: provisional ? "pending" : "degraded",
        targetId: target.id,
        sceneId: null,
        effectiveFallback: "center",
        userActionPossible: false,
      });
      return {
        id: target.id,
        aspectRatio: target.aspectRatio,
        requestedMode,
        effectiveMode: "center",
        canvas,
        scenes: [
          {
            id: `scene:auto-fallback:${target.id}:0`,
            startSec: 0,
            endSec: editedTimeMap.editedDurationSec,
            layers: [
              {
                id: `layer:source:${target.id}:0`,
                kind: "source-video",
                sourceRef: input.source.identity,
                sourceCrop: centeredCoverCrop(input.source, target),
                destination: {
                  x: 0,
                  y: 0,
                  width: target.width,
                  height: target.height,
                },
                fit: "cover",
                rotationDeg: 0,
                opacity: 1,
                zIndex: 0,
              },
            ],
          },
        ],
      };
    }
    if (requestedMode === "fit") {
      const imageRef =
        input.document.studioEdits.background.mode === "image" &&
        input.assets.backgroundImage.state === "available"
          ? input.assets.backgroundImage.ref
          : null;
      return {
        id: target.id,
        aspectRatio: target.aspectRatio,
        requestedMode,
        effectiveMode: "fit",
        canvas,
        scenes: [
          {
            id: `scene:fit:${target.id}:0`,
            startSec: 0,
            endSec: editedTimeMap.editedDurationSec,
            layers: [
              {
                id: `layer:background:${target.id}:0`,
                kind: "background",
                color: input.document.studioEdits.background.color ?? "#000000",
                imageRef,
                destination: {
                  x: 0,
                  y: 0,
                  width: target.width,
                  height: target.height,
                },
                fit: "cover",
                rotationDeg: 0,
                opacity: 1,
                zIndex: 0,
              },
              {
                id: `layer:source:${target.id}:0`,
                kind: "source-video",
                sourceRef: input.source.identity,
                sourceCrop: {
                  x: 0,
                  y: 0,
                  width: input.source.width,
                  height: input.source.height,
                },
                destination: containedDestination(input.source, target),
                fit: "contain",
                rotationDeg: 0,
                opacity: 1,
                zIndex: 1,
              },
            ],
          },
        ],
      };
    }
    return {
      id: target.id,
      aspectRatio: target.aspectRatio,
      requestedMode,
      effectiveMode: "center",
      canvas,
      scenes: [
        {
          id: `scene:center:${target.id}:0`,
          startSec: 0,
          endSec: editedTimeMap.editedDurationSec,
          layers: [
            {
              id: `layer:source:${target.id}:0`,
              kind: "source-video",
              sourceRef: input.source.identity,
              sourceCrop: centeredCoverCrop(input.source, target),
              destination: { x: 0, y: 0, width: target.width, height: target.height },
              fit: "cover",
              rotationDeg: 0,
              opacity: 1,
              zIndex: 0,
            },
          ],
        },
      ],
    };
  });

  const sceneLayoutWantsImage =
    activeSceneLayouts.some((selection) =>
      sceneLayoutPresetShowsBackground(selection.preset),
    ) &&
    input.document.studioEdits.background.mode === "image" &&
    Boolean(input.document.studioEdits.background.imageUrl);
  const backgroundWantsImage =
    (requestedMode === "fit" &&
      input.document.studioEdits.background.mode === "image") ||
    sceneLayoutWantsImage;

  const baseTargets: CompositionBaseTargetPlan[] = initialBaseTargets.map(
    (baseTarget) => {
      const targetInput = input.targets.find((candidate) => candidate.id === baseTarget.id)!;
      const automaticScenes = automaticAnalysis
        ? speakerScenes({
            mode: "auto",
            source: input.source,
            target: targetInput,
            segments: automaticAnalysis.segments,
            overrides: input.document.studioEdits.speakerLayoutOverrides,
            background: sceneBackground,
          })
        : [];
      const automaticDefaultScenes = automaticAnalysis
        ? speakerScenes({
            mode: "auto",
            source: input.source,
            target: targetInput,
            segments: targetSupportsTwoUp(input.source, targetInput)
              ? automaticAnalysis.segments
              : automaticAnalysis.noSplitSegments,
            overrides: input.document.studioEdits.speakerLayoutOverrides,
            background: sceneBackground,
          })
        : [];
      const degraded = input.evidence.framingDegraded;
      const sceneLayouts = degraded?.modes.includes("auto")
        ? activeSceneLayouts.map((selection) => {
            if (selection.aspectRatio !== baseTarget.aspectRatio || !sceneLayoutPresetNeedsAutomaticEvidence(selection.preset)) return selection;
            notices.push({ code: "framing_degraded", fidelity: "degraded", targetId: baseTarget.id, sceneId: selection.id, effectiveFallback: "center", userActionPossible: false, attempts: degraded.attempts, causeCode: degraded.causeCode });
            return { ...selection, preset: "center" as const };
          })
        : activeSceneLayouts;
      const applied = applySceneLayoutSelections({
        target: baseTarget,
        targetInput,
        source: input.source,
        selections: sceneLayouts,
        automaticScenes,
        automaticDefaultScenes,
        automaticSegments: automaticAnalysis?.segments ?? [],
        automaticEvidencePending: automaticEvidenceIsProvisional,
        backgroundImageRef: sceneBackground.imageRef,
        backgroundColor: sceneBackground.color,
      });
      notices.push(...applied.notices);
      return applied.target;
    },
  );
  if (
    input.source.kind === "audio" &&
    input.document.studioEdits.background.mode !== "off"
  ) {
    notices.push(
      ...input.targets.map((target) => ({
        code: "audio_only_background_unsupported",
        fidelity: "degraded" as const,
        targetId: target.id,
        sceneId: null,
        effectiveFallback: "audiogram" as const,
        userActionPossible: true,
      })),
    );
  }
  if (
    input.source.kind === "video" &&
    backgroundWantsImage &&
    input.assets.backgroundImage.state !== "available" &&
    input.assets.backgroundImage.state !== "pending"
  ) {
    notices.push(
      ...input.targets.map((target) => ({
        code: "background_image_unavailable",
        fidelity: "degraded" as const,
        targetId: target.id,
        sceneId: null,
        effectiveFallback: "fit" as const,
        userActionPossible: true,
      })),
    );
  } else if (
    input.source.kind === "video" &&
    backgroundWantsImage &&
    input.assets.backgroundImage.state === "pending"
  ) {
    notices.push(
      ...input.targets.map((target) => ({
        code: "background_image_pending",
        fidelity: "pending" as const,
        targetId: target.id,
        sceneId: null,
        effectiveFallback: "fit" as const,
        userActionPossible: false,
      })),
    );
  }

  if (brollAvailability && brollAvailability.state !== "available") {
    const pending = brollAvailability.state === "pending";
    notices.push(
      ...baseTargets.map((target) => ({
        code: pending ? "broll_asset_pending" : "broll_asset_unavailable",
        fidelity: pending ? ("pending" as const) : ("degraded" as const),
        targetId: target.id,
        sceneId: null,
        effectiveFallback: target.effectiveMode,
        userActionPossible: !pending,
      })),
    );
  }

  const totalEditedDurationSec = editedTimeMap.editedDurationSec +
    input.document.sceneBlocks.reduce((total, block) => total + block.durationSec, 0);
  const mediaMotionNotices: CompositionNotice[] = [];
  const targets = baseTargets.map((baseTarget) => {
    const targetInput = input.targets.find(
      (candidate) => candidate.id === baseTarget.id,
    )!;
    const target = {
      ...addInsertedSceneBlocks(
        addBrollLayers(baseTarget, brollPlacements),
        input.document.sceneBlocks,
        sceneTextRenders,
      ),
      visualLayers: retimeVisualLayersForInsertedScenes(
        visualLayersForTarget({
          document: input.document,
          target: targetInput,
          scenes: baseTarget.scenes,
          editedTimeMap,
          logo: input.assets.logo,
          captionLanguage: input.captionLanguage ?? null,
          captionOverride: input.captionOverride,
        }),
        input.document.sceneBlocks,
        totalEditedDurationSec,
      ),
    } satisfies CompositionTargetPlan;
    const planned = applyTargetMediaMotion({
      target,
      document: input.document,
    });
    mediaMotionNotices.push(...planned.notices);
    return planned.target;
  });
  notices.push(...mediaMotionNotices);

  for (const scene of input.document.sceneBlocks) {
    if (scene.content.kind === "image" || scene.content.kind === "video") {
      const assetId = scene.content.asset.id;
      const availability = input.assets.sceneVisuals?.[scene.id] ?? {
        state: "missing" as const,
      };
      if (availability.state !== "available") {
        const pending = availability.state === "pending";
        notices.push(...targets.map((target) => ({
          code: pending ? "scene_asset_pending" : "scene_asset_unavailable",
          fidelity: pending ? ("pending" as const) : ("degraded" as const),
          targetId: target.id,
          sceneId: scene.id,
          effectiveFallback: target.effectiveMode,
          userActionPossible: !pending,
          assetId,
        })));
      }
    }
    if (scene.content.kind === "text" && scene.content.fontAsset) {
      const assetId = scene.content.fontAsset.id;
      const availability = input.assets.sceneFonts?.[scene.id] ?? {
        state: "missing" as const,
      };
      if (availability.state !== "available") {
        const pending = availability.state === "pending";
        notices.push(...targets.map((target) => ({
          code: pending ? "scene_font_pending" : "scene_font_unavailable",
          fidelity: pending ? ("pending" as const) : ("degraded" as const),
          targetId: target.id,
          sceneId: scene.id,
          effectiveFallback: target.effectiveMode,
          userActionPossible: !pending,
          assetId,
        })));
      }
    }
  }

  if (input.assets.logo && input.assets.logo.state !== "available") {
    const pending = input.assets.logo.state === "pending";
    notices.push(
      ...targets.map((target) => ({
        code: pending ? "logo_asset_pending" : "logo_asset_unavailable",
        fidelity: pending ? ("pending" as const) : ("degraded" as const),
        targetId: target.id,
        sceneId: null,
        effectiveFallback: target.effectiveMode,
        userActionPossible: !pending,
      })),
    );
  }

  for (const { block, availability } of resolvedAudioAssets.music) {
    if (availability?.state === "available") continue;
    const pending = availability?.state === "pending";
    notices.push(
      ...targets.map((target) => ({
        code: pending ? "music_asset_pending" : "music_asset_unavailable",
        fidelity: pending ? ("pending" as const) : ("degraded" as const),
        targetId: target.id,
        sceneId: null,
        effectiveFallback: target.effectiveMode,
        userActionPossible: !pending,
        assetId: block.id,
      })),
    );
  }

  for (const { placement, availability } of resolvedAudioAssets.soundEffects) {
    if (availability?.state === "available") continue;
    const pending = availability?.state === "pending";
    notices.push(
      ...targets.map((target) => ({
        code: pending
          ? "sound_effect_asset_pending"
          : "sound_effect_asset_unavailable",
        fidelity: pending ? ("pending" as const) : ("degraded" as const),
        targetId: target.id,
        sceneId: null,
        effectiveFallback: target.effectiveMode,
        userActionPossible: !pending,
        assetId: placement.id,
      })),
    );
  }

  const audioSchedule = buildAudioSchedule(
    input,
    totalEditedDurationSec,
    resolvedAudioAssets,
  );

  const fidelity = notices.some(
    (notice) => notice.fidelity === "pending",
  )
    ? ("pending" as const)
    : notices.some((notice) => notice.fidelity === "degraded")
      ? ("degraded" as const)
      : ("exact" as const);
  const withoutFingerprint = {
    version: CLIP_COMPOSITION_PLAN_VERSION,
    inputFingerprint,
    fidelity,
    editedDurationSec: totalEditedDurationSec,
    source: {
      ref: input.source.identity,
      width: input.source.width,
      height: input.source.height,
    },
    audioSchedule,
    targets,
    notices,
    evidenceRequests,
  };
  const serialized = JSON.stringify(withoutFingerprint);
  if (
    new TextEncoder().encode(serialized).byteLength >
    CLIP_COMPOSITION_MAX_SERIALIZED_BYTES
  ) {
    return { status: "invalid", error: { code: "plan_size_exceeded" } };
  }
  const plan = deepFreeze({
    ...withoutFingerprint,
    fingerprint: hashString(serialized),
  }) as ClipCompositionPlan;
  return {
    status: notices.some((notice) => notice.fidelity === "pending")
      ? "pending"
      : "ready",
    plan,
  };
}
