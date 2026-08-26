import {
  buildEditedTimeMap,
  clipAutoLayoutMatchesInputs,
  resolveEffectiveFramingMode,
  resolveSpeakerLayoutScene,
  type ClipAspectRatio,
  type ClipAutoLayoutAnalysis,
  type EditorDocument,
  type SpeakerLayerRole,
  type SpeakerLayerTransform,
} from "@narriflow/validators";

export const CLIP_COMPOSITION_PLAN_VERSION = 1 as const;
export const CLIP_COMPOSITION_MAX_TARGETS = 4;
export const CLIP_COMPOSITION_MAX_SERIALIZED_BYTES = 512 * 1024;

export type CompositionMode = "auto" | "center" | "fit" | "split" | "screen";

export interface CompositionSourceFacts {
  readonly identity: string;
  readonly kind: "video" | "audio";
  readonly width: number;
  readonly height: number;
}

export interface CompositionTarget {
  readonly id: string;
  readonly aspectRatio: ClipAspectRatio;
  readonly width: number;
  readonly height: number;
}

export type CompositionAssetAvailability =
  | { readonly state: "missing" | "pending" | "failed" }
  | { readonly state: "available"; readonly ref: string };

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

export interface ClipCompositionPlanInput {
  readonly document: EditorDocument;
  readonly source: CompositionSourceFacts;
  readonly evidence: {
    readonly automaticLayout: AutomaticLayoutEvidenceAvailability;
  };
  readonly assets: {
    readonly backgroundImage: CompositionAssetAvailability;
  };
  readonly capabilities: {
    readonly automaticSpeakerLayout: boolean;
    readonly automaticSpeakerEngineVersion: string;
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

export type CompositionLayer =
  | CompositionSourceVideoLayer
  | CompositionBackgroundLayer;

export interface CompositionScene {
  readonly id: string;
  readonly startSec: number;
  readonly endSec: number;
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
  readonly scenes: readonly CompositionScene[];
}

export interface CompositionEvidenceRequest {
  readonly key: string;
  readonly kind: "automatic-speaker-layout";
  readonly engineVersion: string;
}

export interface CompositionNotice {
  readonly code: string;
  readonly fidelity: "provisional" | "degraded";
  readonly targetId: string;
  readonly sceneId: string | null;
  readonly effectiveFallback: CompositionMode;
  readonly userActionPossible: boolean;
}

export interface ClipCompositionPlan {
  readonly version: typeof CLIP_COMPOSITION_PLAN_VERSION;
  readonly fingerprint: string;
  readonly inputFingerprint: string;
  readonly editedDurationSec: number;
  readonly source: {
    readonly ref: string;
    readonly width: number;
    readonly height: number;
  };
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
          | "unsupported_mode"
          | "plan_size_exceeded";
        readonly targetId?: string;
      };
    }
  | {
      readonly status: "ready" | "provisional";
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
  return hashString(JSON.stringify(input));
}

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
  const tileRatio = target.width / Math.round(target.height / 2);
  const cropWidth =
    source.width / source.height >= tileRatio
      ? Math.round(source.height * tileRatio)
      : source.width;
  return cropWidth < source.width;
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

function validateInput(
  input: ClipCompositionPlanInput,
): Extract<ClipCompositionPlanResult, { status: "invalid" }> | null {
  if (
    input.source.kind !== "video" ||
    input.source.identity.length === 0 ||
    !Number.isInteger(input.source.width) ||
    !Number.isInteger(input.source.height) ||
    input.source.width <= 0 ||
    input.source.height <= 0
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

  const requestedMode = resolveEffectiveFramingMode(input.document.studioEdits);
  if (
    requestedMode !== "center" &&
    requestedMode !== "fit" &&
    requestedMode !== "auto"
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
      assets: input.assets,
      evidence:
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
    requestedMode === "auto" && input.capabilities.automaticSpeakerLayout
      ? validAutomaticLayoutEvidence(
          input.evidence.automaticLayout,
          input,
          editedTimeMap.editedDurationSec,
        )
      : null;
  const automaticEvidenceIsProvisional =
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

  const targets: CompositionTargetPlan[] = input.targets.map((target) => {
    const canvas = {
      width: target.width,
      height: target.height,
      divisibleBy: 2 as const,
    };
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
        fidelity: provisional ? "provisional" : "degraded",
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
    backgroundWantsImage &&
    input.assets.backgroundImage.state === "pending"
  ) {
    notices.push(
      ...input.targets.map((target) => ({
        code: "background_image_pending",
        fidelity: "provisional" as const,
        targetId: target.id,
        sceneId: null,
        effectiveFallback: "fit" as const,
        userActionPossible: false,
      })),
    );
  }

  const withoutFingerprint = {
    version: CLIP_COMPOSITION_PLAN_VERSION,
    inputFingerprint,
    editedDurationSec: editedTimeMap.editedDurationSec,
    source: {
      ref: input.source.identity,
      width: input.source.width,
      height: input.source.height,
    },
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
    status: notices.some((notice) => notice.fidelity === "provisional")
      ? "provisional"
      : "ready",
    plan,
  };
}
