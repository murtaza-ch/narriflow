import {
  CAPTION_CHUNK_SIZE,
  CAPTION_POSITION_Y_DEFAULTS,
  DUCKING_DEFAULTS,
  buildEditedTimeMap,
  capDuckingWindows,
  clipAutoLayoutMatchesInputs,
  computeSpeechWindows,
  emojiForWord,
  extractSpeechWordIntervals,
  formatCaptionWord,
  resolveMusicFadeWindows,
  resolveEffectiveFramingMode,
  resolveSpeakerLayoutScene,
  SCREEN_LAYOUT_ENGINE_VERSION,
  sourceRangeToEdited,
  type CaptionPreset,
  type ClipAspectRatio,
  type ClipAutoLayoutAnalysis,
  type ClipAutoLayoutSegment,
  type EditorDocument,
  type SceneBlock,
  type SceneContent,
  type EffectiveLogoSettings,
  type LogoPosition,
  type SpeakerLayerRole,
  type SpeakerLayerTransform,
  type StudioTextLayer,
} from "@narriflow/validators";

export const CLIP_COMPOSITION_PLAN_VERSION = 1 as const;
export const CLIP_COMPOSITION_MAX_TARGETS = 4;
export const CLIP_COMPOSITION_MAX_SERIALIZED_BYTES = 512 * 1024;
export const CLIP_AUDIO_FADE_IN_SEC = 0.04;
export const CLIP_AUDIO_FADE_OUT_SEC = 0.12;

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
  readonly segments: readonly ClipAutoLayoutSegment[];
  readonly fallbackSegments: readonly ClipAutoLayoutSegment[];
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
        readonly segments: readonly ClipAutoLayoutSegment[];
      }
    | { readonly state: "unavailable" };
}

export interface ClipCompositionPlanInput {
  readonly document: EditorDocument;
  readonly source: CompositionSourceFacts;
  readonly evidence: {
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
    readonly music?: CompositionAssetAvailability;
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

export interface CompositionSourceVideoLayer {
  readonly id: string;
  readonly kind: "source-video";
  readonly sourceRef: string;
  readonly sourceCrop: CompositionRect;
  readonly destination: CompositionRect;
  readonly fit: "cover" | "contain";
  readonly rotationDeg: number;
  readonly opacity: number;
  readonly zIndex: number;
  readonly speaker?: {
    readonly role: SpeakerLayerRole;
    readonly transform: SpeakerLayerTransform;
    readonly defaultTransform: SpeakerLayerTransform;
    readonly overrideId: string | null;
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
  readonly motion: SceneBlock["motion"];
  readonly sourceRef: string | null;
  readonly destination: CompositionRect;
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: 25;
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
  readonly emoji: string | null;
  readonly startSec: number;
  readonly endSec: number;
}

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
  readonly preset: CaptionPreset;
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
  readonly transition: "fade" | "fade-black" | "dip-white";
  readonly color: "black" | "white";
  readonly windows: {
    readonly fadeIn: CompositionActiveRange;
    readonly fadeOut: CompositionActiveRange;
  };
  readonly rotationDeg: 0;
  readonly opacity: 1;
  readonly zIndex: 60;
}

export interface CompositionOutputTreatmentVisualLayer {
  readonly id: string;
  readonly kind: "output-treatment";
  readonly activeRange: CompositionActiveRange;
  readonly destination: CompositionRect;
  readonly resolution: "720p" | "1080p";
  readonly scale: { readonly numerator: 1 | 2; readonly denominator: 1 | 3 };
  readonly watermark: {
    readonly enabled: boolean;
    readonly text: "Made with Narriflow";
    readonly fontSizePx: number;
    readonly fontFamily: "Arial";
    readonly fontWeight: 700;
    readonly color: "#FFFFFF";
    readonly opacity: 0.85;
    readonly marginPx: { readonly x: number; readonly y: number };
    readonly outline: {
      readonly widthPx: 2;
      readonly color: "#000000";
      readonly opacity: 0.6;
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
  readonly music: {
    readonly sourceRef: string;
    readonly activeRange: CompositionActiveRange;
    readonly gain: number;
    readonly startOffsetSec: number;
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
  } | null;
  readonly soundEffects: readonly {
    readonly id: string;
    readonly sourceRef: string;
    readonly activeRange: CompositionActiveRange;
    readonly gain: number;
  }[];
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
          | "plan_size_exceeded";
        readonly targetId?: string;
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
    music: {
      requested: Boolean(musicSettings.assetId || musicSettings.url),
      availability: input.assets.music,
    },
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
  const musicAvailability = resolvedAssets.music.availability;
  const musicSettings = input.document.studioEdits.music;
  const fadeWindows = resolveMusicFadeWindows(
    musicSettings.fadeInSec,
    musicSettings.fadeOutSec,
    editedDurationSec,
  );
  const editedTimeMap = buildEditedTimeMap(input.document.deletedRanges, {
    startSec: input.document.clipStartSec,
    endSec: input.document.clipEndSec,
  });
  const duckingWindows = musicSettings.ducking
    ? capDuckingWindows(
        computeSpeechWindows(
          extractSpeechWordIntervals(
            input.document.transcriptSlice,
            input.document.clipStartSec,
            editedTimeMap,
          ),
          editedDurationSec,
        ),
      )
    : [];
  const music =
    resolvedAssets.music.requested && musicAvailability?.state === "available"
      ? {
          sourceRef: musicAvailability.ref,
          activeRange,
          gain: clampUnit(musicSettings.volume / 100),
          startOffsetSec: Math.max(0, musicSettings.startOffsetSec),
          sourceDurationSec:
            musicAvailability.durationSec &&
            Number.isFinite(musicAvailability.durationSec) &&
            musicAvailability.durationSec > 0
              ? musicAvailability.durationSec
              : null,
          loop: true as const,
          fades: {
            fadeIn: { startSec: 0, endSec: fadeWindows.fadeInSec },
            fadeOut: {
              startSec: fadeWindows.fadeOutStartSec,
              endSec: editedDurationSec,
            },
          },
          ducking: {
            enabled: musicSettings.ducking,
            windows: duckingWindows,
            duckedGainFraction: DUCKING_DEFAULTS.duckedGainFraction,
            attackSec: DUCKING_DEFAULTS.attackSec,
            releaseSec: DUCKING_DEFAULTS.releaseSec,
          },
        }
      : null;
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
  segments: readonly ClipAutoLayoutSegment[],
  editedDurationSec: number,
): boolean {
  if (segments.length === 0 || segments.length > 64) return false;
  let cursor = 0;
  for (const segment of segments) {
    if (
      !Number.isFinite(segment.startSec) ||
      !Number.isFinite(segment.endSec) ||
      Math.abs(segment.startSec - cursor) > 0.075 ||
      segment.endSec <= segment.startSec
    ) {
      return false;
    }
    cursor = segment.endSec;
  }
  return Math.abs(cursor - editedDurationSec) <= 0.075;
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
  segment: ClipAutoLayoutSegment,
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

function speakerScenes(input: {
  mode: "auto" | "split";
  source: CompositionSourceFacts;
  target: CompositionTarget;
  segments: readonly ClipAutoLayoutSegment[];
  overrides: EditorDocument["studioEdits"]["speakerLayoutOverrides"];
}): CompositionScene[] {
  return input.segments.map((segment, sceneIndex) => {
    const resolved = resolveSpeakerLayoutScene(
      segment,
      input.overrides,
      input.target.aspectRatio,
    );
    const canonical =
      input.mode === "split"
        ? canonicalSplitTransforms(segment, input.target)
        : resolved.layers;
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
        return {
          id: `layer:speaker:${transform.role}:${input.target.id}:${sceneIndex}`,
          kind: "source-video" as const,
          sourceRef: input.source.identity,
          sourceCrop: cropForSpeakerLayer(
            input.source,
            destination,
            transform,
          ),
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
    analysis.version !== 1 ||
    analysis.engine !== input.capabilities.automaticSpeakerEngineVersion ||
    analysis.sourceIdentity !== input.source.identity ||
    // Speaker coordinates are normalized. Evidence may have been measured
    // on the source-derived Studio proxy and then applied to the original
    // render dimensions, so pixel dimensions are descriptive rather than
    // part of the evidence invalidation key.
    Math.abs(analysis.editedDurationSec - editedDurationSec) > 0.075 ||
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
              audio: "source",
            };
      scenes.push({
        ...baseScene,
        id: `${baseScene.id}:slice:${scenes.length}`,
        startSec,
        endSec,
        layers: brollLayer ? [...baseScene.layers, brollLayer] : baseScene.layers,
      });
    }
  }
  return { ...target, scenes };
}

function addInsertedSceneBlocks(
  target: CompositionBaseTargetPlan,
  blocks: readonly SceneBlock[],
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
      motion: block.motion,
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

function retimeVisualLayersForInsertedScenes(
  layers: readonly CompositionVisualLayer[],
  blocks: readonly SceneBlock[],
  totalDurationSec: number,
): CompositionVisualLayer[] {
  if (blocks.length === 0) return [...layers];
  const anchors = insertedBaseAnchors(blocks);
  const shift = (timeSec: number) => anchors
    .filter(({ baseAnchorSec }) => baseAnchorSec <= timeSec)
    .reduce((sum, { block }) => sum + block.durationSec, 0);
  return layers.flatMap((layer) => {
    if (layer.kind === "logo" || layer.kind === "output-treatment") {
      return [{ ...layer, activeRange: { startSec: 0, endSec: totalDurationSec } }];
    }
    if (layer.kind === "transition") {
      const fadeInDuration = layer.windows.fadeIn.endSec - layer.windows.fadeIn.startSec;
      const fadeOutDuration = layer.windows.fadeOut.endSec - layer.windows.fadeOut.startSec;
      return [{
        ...layer,
        activeRange: { startSec: 0, endSec: totalDurationSec },
        windows: {
          fadeIn: { startSec: 0, endSec: Math.min(totalDurationSec, fadeInDuration) },
          fadeOut: { startSec: Math.max(0, totalDurationSec - fadeOutDuration), endSec: totalDurationSec },
        },
      }];
    }
    const boundaries = [
      layer.activeRange.startSec,
      ...anchors
        .map(({ baseAnchorSec }) => baseAnchorSec)
        .filter((anchor) => anchor > layer.activeRange.startSec && anchor < layer.activeRange.endSec),
      layer.activeRange.endSec,
    ];
    const slices: CompositionVisualLayer[] = [];
    boundaries.slice(0, -1).forEach((startSec, index) => {
      const endSec = boundaries[index + 1]!;
      const outputRange = {
        startSec: startSec + shift(startSec),
        endSec: endSec + shift(Math.max(startSec, endSec - 0.000_001)),
      };
      if (outputRange.endSec <= outputRange.startSec) return;
      if (layer.kind === "caption") {
        const words = layer.words
          .filter((word) => word.endSec > startSec && word.startSec < endSec)
          .map((word) => ({
            ...word,
            startSec: word.startSec + shift(word.startSec),
            endSec: word.endSec + shift(Math.max(word.startSec, word.endSec - 0.000_001)),
          }));
        if (words.length === 0) return;
        slices.push({ ...layer, id: `${layer.id}:scene-slice:${index}`, activeRange: outputRange, words });
        return;
      }
      slices.push({ ...layer, id: `${layer.id}:scene-slice:${index}`, activeRange: outputRange });
    });
    return slices;
  });
}

function applyCaptionTextTransform(
  text: string,
  transform: CaptionPreset["textTransform"],
): string {
  switch (transform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "capitalize":
      return text.replace(/\b\w/g, (character) => character.toUpperCase());
    default:
      return text;
  }
}

function captionLayersForTarget(input: {
  document: EditorDocument;
  target: CompositionTarget;
  editedTimeMap: ReturnType<typeof buildEditedTimeMap>;
}): CompositionCaptionVisualLayer[] {
  const { document, target, editedTimeMap } = input;
  const preset = document.captionPreset;
  if (preset.visible === false) return [];
  const destination = { x: 0, y: 0, width: target.width, height: target.height };
  const anchor = {
    xPct: preset.positionX ?? 50,
    yPct:
      preset.positionY ??
      CAPTION_POSITION_Y_DEFAULTS[preset.position ?? "bottom"],
  };
  const punctuation = preset.punctuation !== false;
  const layers: CompositionCaptionVisualLayer[] = [];

  for (const utterance of document.transcriptSlice) {
    const visibleWords = utterance.words.flatMap((word) => {
      const range = sourceRangeToEdited(editedTimeMap, word);
      if (!range) return [];
      const formatted = applyCaptionTextTransform(
        formatCaptionWord(word.word, { punctuation }),
        preset.textTransform,
      );
      if (!formatted) return [];
      return [{ word, range, formatted }];
    });

    if (utterance.words.length > 0) {
      for (
        let wordIndex = 0;
        wordIndex < visibleWords.length;
        wordIndex += CAPTION_CHUNK_SIZE
      ) {
        const group = visibleWords.slice(
          wordIndex,
          wordIndex + CAPTION_CHUNK_SIZE,
        );
        if (group.length === 0) continue;
        const cueIndex = layers.length;
        const startSec = group[0]!.range.startSec;
        const endSec = Math.max(
          startSec + 0.1,
          group[group.length - 1]!.range.endSec,
        );
        layers.push({
          id: `layer:caption:${utterance.index}:${Math.floor(wordIndex / CAPTION_CHUNK_SIZE)}:${target.id}`,
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
            emoji: preset.emojis ? emojiForWord(entry.word.word) : null,
            startSec: entry.range.startSec,
            endSec:
              index + 1 < group.length
                ? Math.max(entry.range.startSec + 0.05, group[index + 1]!.range.startSec)
                : Math.max(entry.range.startSec + 0.1, entry.range.endSec),
          })),
          preset,
        });
      }
      continue;
    }

    const range = sourceRangeToEdited(editedTimeMap, utterance);
    if (!range) continue;
    const text = applyCaptionTextTransform(
      utterance.text
        .split(/\s+/)
        .map((word) => formatCaptionWord(word, { punctuation }))
        .filter(Boolean)
        .join(" "),
      preset.textTransform,
    );
    if (!text) continue;
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
          emoji: null,
          startSec: range.startSec,
          endSec: range.endSec,
        },
      ],
      preset,
    });
  }

  return layers;
}

function visualLayersForTarget(input: {
  document: EditorDocument;
  target: CompositionTarget;
  editedTimeMap: ReturnType<typeof buildEditedTimeMap>;
  logo: CompositionLogoAvailability | undefined;
}): CompositionVisualLayer[] {
  const { document, target, editedTimeMap, logo } = input;
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

  visualLayers.push(
    ...captionLayersForTarget({ document, target, editedTimeMap }),
  );

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
        color: transition.type === "dip-white" ? "white" : "black",
        windows: {
          fadeIn: { startSec: 0, endSec: transitionDuration },
          fadeOut: {
            startSec: Math.max(0, duration - transitionDuration),
            endSec: duration,
          },
        },
        rotationDeg: 0,
        opacity: 1,
        zIndex: 60,
      });
    }
  }

  if (target.outputTreatment) {
    const outputHeight = Math.round(
      target.height *
        (target.outputTreatment.resolution === "720p" ? 2 / 3 : 1),
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
      watermark: {
        enabled: target.outputTreatment.watermark,
        text: "Made with Narriflow",
        fontSizePx: Math.max(1, Math.round(outputHeight / 28)),
        fontFamily: "Arial",
        fontWeight: 700,
        color: "#FFFFFF",
        opacity: 0.85,
        marginPx: {
          x: Math.max(1, Math.round(outputHeight / 40)),
          y: Math.max(1, Math.round(outputHeight / 40)),
        },
        outline: {
          widthPx: 2,
          color: "#000000",
          opacity: 0.6,
        },
      },
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

  const editedTimeMap = buildEditedTimeMap(input.document.deletedRanges, {
    startSec: input.document.clipStartSec,
    endSec: input.document.clipEndSec,
  });
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
      visualLayers: {
        captionPreset: input.document.captionPreset,
        transcriptSlice: input.document.transcriptSlice,
        textLayers: input.document.studioEdits.textLayers,
        transition: input.document.studioEdits.transition,
      },
      ...(input.document.sceneBlocks.length > 0
        ? { sceneBlocks: input.document.sceneBlocks }
        : {}),
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
    (requestedMode === "auto" ||
      (hasActiveBroll &&
        (requestedMode === "split" || requestedMode === "screen"))) &&
    input.capabilities.automaticSpeakerLayout
      ? validAutomaticLayoutEvidence(
          input.evidence.automaticLayout,
          input,
          editedTimeMap.editedDurationSec,
        )
      : null;
  const automaticEvidenceIsProvisional =
    input.source.kind === "video" &&
    requestedMode === "auto" &&
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
    ) &&
    segmentsAreComplete(
      splitAvailability.value.fallbackSegments,
      editedTimeMap.editedDurationSec,
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

  const baseTargets: CompositionBaseTargetPlan[] = input.targets.map((target) => {
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
            scenes: segments.map((segment, sceneIndex) => {
              const defaults = resolveSpeakerLayoutScene(
                segment,
                [],
                target.aspectRatio,
              );
              const resolved = resolveSpeakerLayoutScene(
                segment,
                input.document.studioEdits.speakerLayoutOverrides,
                target.aspectRatio,
              );
              return {
                id: `scene:auto:${target.id}:${sceneIndex}`,
                startSec: segment.startSec,
                endSec: segment.endSec,
                layers: resolved.layers.map((transform, layerIndex) => {
                  const destination = framePixels(transform, target);
                  return {
                    id: `layer:speaker:${transform.role}:${target.id}:${sceneIndex}`,
                    kind: "source-video" as const,
                    sourceRef: input.source.identity,
                    sourceCrop: cropForSpeakerLayer(
                      input.source,
                      destination,
                      transform,
                    ),
                    destination,
                    fit: "cover" as const,
                    rotationDeg: transform.rotationDeg,
                    opacity: 1,
                    zIndex: layerIndex,
                    speaker: {
                      role: transform.role,
                      transform: { ...transform },
                      defaultTransform: {
                        ...defaults.layers.find(
                          (candidate) => candidate.role === transform.role,
                        )!,
                      },
                      overrideId: resolved.overrideId,
                    },
                  };
                }),
              };
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

  const backgroundWantsImage =
    requestedMode === "fit" &&
    input.document.studioEdits.background.mode === "image";
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
  const targets = baseTargets.map((baseTarget) => {
    const targetInput = input.targets.find(
      (candidate) => candidate.id === baseTarget.id,
    )!;
    return {
      ...addInsertedSceneBlocks(
        addBrollLayers(baseTarget, brollPlacements),
        input.document.sceneBlocks,
      ),
      visualLayers: retimeVisualLayersForInsertedScenes(
        visualLayersForTarget({
          document: input.document,
          target: targetInput,
          editedTimeMap,
          logo: input.assets.logo,
        }),
        input.document.sceneBlocks,
        totalEditedDurationSec,
      ),
    } satisfies CompositionTargetPlan;
  });

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

  if (
    resolvedAudioAssets.music.requested &&
    resolvedAudioAssets.music.availability?.state !== "available"
  ) {
    const pending = resolvedAudioAssets.music.availability?.state === "pending";
    notices.push(
      ...targets.map((target) => ({
        code: pending ? "music_asset_pending" : "music_asset_unavailable",
        fidelity: pending ? ("pending" as const) : ("degraded" as const),
        targetId: target.id,
        sceneId: null,
        effectiveFallback: target.effectiveMode,
        userActionPossible: !pending,
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
