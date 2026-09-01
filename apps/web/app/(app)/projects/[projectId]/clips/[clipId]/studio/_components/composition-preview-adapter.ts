import {
  CLIP_COMPOSITION_PLAN_VERSION,
	compositionAssetRef,
  evaluateCompositionMotion,
  type ClipCompositionPlan,
  type ClipCompositionPlanResult,
  type CompositionBrollAvailability,
  type CompositionAudioSchedule,
  type CompositionLayer,
  type CompositionMode,
  type CompositionNotice,
  type CompositionResolvedMotion,
  type CompositionTransitionVisualLayer,
  type CompositionVisualLayer,
} from "@narriflow/composition-plan";
import {
  censorBeepEnvelopeAt,
  duckingGainMultiplierAt,
	type BrollPlacement,
	type SceneBlock,
} from "@narriflow/validators";

function rangeContains(
  range: { startSec: number; endSec: number },
  timeSec: number,
): boolean {
  return timeSec >= range.startSec && timeSec <= range.endSec;
}

function fadeEnvelopeAt(
  fades: {
    fadeIn: { startSec: number; endSec: number };
    fadeOut: { startSec: number; endSec: number };
  },
  timeSec: number,
): number {
  let gain = 1;
  const fadeInDuration = fades.fadeIn.endSec - fades.fadeIn.startSec;
  if (fadeInDuration > 0 && timeSec < fades.fadeIn.endSec) {
    gain = Math.min(
      gain,
      Math.max(0, Math.min(1, (timeSec - fades.fadeIn.startSec) / fadeInDuration)),
    );
  }
  const fadeOutDuration = fades.fadeOut.endSec - fades.fadeOut.startSec;
  if (fadeOutDuration > 0 && timeSec > fades.fadeOut.startSec) {
    gain = Math.min(
      gain,
      Math.max(0, Math.min(1, (fades.fadeOut.endSec - timeSec) / fadeOutDuration)),
    );
  }
  return gain;
}

export function plannedCompositionAudioState(
  schedule: CompositionAudioSchedule,
  editedTimeSec: number,
) {
  const timeSec = Math.max(0, editedTimeSec);
  const outputGain = fadeEnvelopeAt(schedule.outputFades, timeSec);
  const dialogueTreatment = schedule.dialogueTreatments.find(
    (treatment) =>
      timeSec >= treatment.activeRange.startSec &&
      timeSec < treatment.activeRange.endSec,
  );
  const sourceEnvelope = outputGain * (dialogueTreatment === undefined ? 1 : 0);
  const music = schedule.music;
  let plannedMusic: {
    sourceRef: string;
    timelineTimeSec: number;
    loop: true;
    volume: number;
  } | null = null;
  if (music && rangeContains(music.activeRange, timeSec)) {
    let volume = music.gain;
    const fadeInDuration = music.fades.fadeIn.endSec - music.fades.fadeIn.startSec;
    if (fadeInDuration > 0 && timeSec < music.fades.fadeIn.endSec) {
      volume *= Math.max(
        0,
        Math.min(1, (timeSec - music.fades.fadeIn.startSec) / fadeInDuration),
      );
    }
    const fadeOutDuration =
      music.fades.fadeOut.endSec - music.fades.fadeOut.startSec;
    if (fadeOutDuration > 0 && timeSec > music.fades.fadeOut.startSec) {
      volume = Math.min(
        volume,
        music.gain *
          Math.max(
            0,
            Math.min(1, (music.fades.fadeOut.endSec - timeSec) / fadeOutDuration),
          ),
      );
    }
    if (music.ducking.enabled) {
      volume *= duckingGainMultiplierAt(timeSec, [...music.ducking.windows], {
        duckedGainFraction: music.ducking.duckedGainFraction,
        attackSec: music.ducking.attackSec,
        releaseSec: music.ducking.releaseSec,
      });
    }
    plannedMusic = {
      sourceRef: music.sourceRef,
      timelineTimeSec:
        music.sourceDurationSec && music.sourceDurationSec > 0
          ? (music.startOffsetSec + timeSec) % music.sourceDurationSec
          : music.startOffsetSec + timeSec,
      loop: true,
      volume: Math.max(0, Math.min(1, volume * outputGain)),
    };
  }
  return {
    scheduleFingerprint: schedule.fingerprint,
    source: {
      muted:
        schedule.source.muted ||
        !schedule.source.available ||
        dialogueTreatment !== undefined,
      volume:
        schedule.source.gain * sourceEnvelope,
      outputGain,
      envelope: sourceEnvelope,
    },
    beep:
      dialogueTreatment?.kind === "beep"
        ? {
            frequencyHz: dialogueTreatment.frequencyHz,
            volume:
              dialogueTreatment.gain *
              censorBeepEnvelopeAt(dialogueTreatment, timeSec) *
              outputGain,
          }
        : null,
    music: plannedMusic,
    soundEffects: schedule.soundEffects
      .filter((effect) => rangeContains(effect.activeRange, timeSec))
      .map((effect) => ({
        id: effect.id,
        sourceRef: effect.sourceRef,
        localTimeSec: timeSec - effect.activeRange.startSec,
        volume: effect.gain * outputGain,
      })),
  };
}

export function manualBrollAvailabilityForPlan(input: {
  url: string | null;
  ref: string | null;
  window: { startSec: number; endSec: number } | null;
  mediaState: "missing" | "pending" | "available" | "failed";
}): CompositionBrollAvailability | undefined {
  if (!input.url) return undefined;
  if (input.mediaState === "failed" || !input.window || !input.ref) {
    return { state: "failed" };
  }
  if (input.mediaState !== "available") return { state: "pending" };
  return {
    state: "available",
    placements: [
      {
        id: "manual",
        ref: input.ref,
				mediaKind: "video",
        startSec: input.window.startSec,
        endSec: input.window.endSec,
				sourceStartSec: 0,
				sourceEndSec: input.window.endSec - input.window.startSec,
      },
    ],
  };
}

export type PreviewBrollAssetResolution = {
	assetId: string;
	fingerprint: string;
	state:
		| "pending"
		| "available"
		| "deleted"
		| "missing"
		| "fingerprint_stale"
		| "storage_unavailable";
	accessUrl?: string | null;
};

export type PreviewFrozenVisualReference = {
	assetId: string;
	fingerprint: string;
	mediaKind: "image" | "video";
};

function frozenVisualKey(reference: { id: string; fingerprint: string }) {
	return `${reference.id}:${reference.fingerprint}`;
}

export function frozenVisualReferencesForPreview(
	placements: readonly BrollPlacement[],
	scenes: readonly SceneBlock[],
): PreviewFrozenVisualReference[] {
	const references = new Map<string, PreviewFrozenVisualReference>();
	for (const placement of placements) {
		const key = frozenVisualKey(placement.asset);
		references.set(key, {
			assetId: placement.asset.id,
			fingerprint: placement.asset.fingerprint,
			mediaKind: placement.mediaKind,
		});
	}
	for (const scene of scenes) {
		if (scene.content.kind !== "image" && scene.content.kind !== "video") continue;
		const key = frozenVisualKey(scene.content.asset);
		references.set(key, {
			assetId: scene.content.asset.id,
			fingerprint: scene.content.asset.fingerprint,
			mediaKind: scene.content.kind,
		});
	}
	return [...references.values()];
}

export function sceneVisualAssetsForPlan(
	scenes: readonly SceneBlock[],
	resolutions: Readonly<Record<string, PreviewBrollAssetResolution>>,
) {
	const availability: Record<
		string,
		| { state: "pending" | "failed" }
		| { state: "available"; ref: string }
	> = {};
	const mediaByRef: Record<
		string,
		{
			assetKey: string;
			accessUrl: string;
			mediaKind: "image" | "video";
		}
	> = {};
	for (const scene of scenes) {
		if (scene.content.kind !== "image" && scene.content.kind !== "video") continue;
		const key = frozenVisualKey(scene.content.asset);
		const resolution = resolutions[key];
		if (!resolution || resolution.state === "pending") {
			availability[scene.id] = { state: "pending" };
			continue;
		}
		if (
			resolution.assetId !== scene.content.asset.id ||
			resolution.fingerprint !== scene.content.asset.fingerprint ||
			!resolution.accessUrl ||
			(resolution.state !== "available" && resolution.state !== "deleted")
		) {
			availability[scene.id] = { state: "failed" };
			continue;
		}
		const ref = compositionAssetRef("visual_asset", key);
		availability[scene.id] = { state: "available", ref };
		mediaByRef[ref] = {
			assetKey: key,
			accessUrl: resolution.accessUrl,
			mediaKind: scene.content.kind,
		};
	}
	return { availability, mediaByRef };
}

export function assetBackedBrollForPlan(
	placements: readonly BrollPlacement[],
	resolutions: Readonly<Record<string, PreviewBrollAssetResolution>>,
) {
  const available: Array<{
    placement: BrollPlacement;
		assetKey: string;
    ref: string;
		accessUrl: string;
	}> = [];
	const unavailablePlacements: Array<{
		id: string;
		reason:
			| "pending"
			| "missing"
			| "fingerprint_stale"
			| "storage_unavailable";
	}> = [];
	for (const placement of placements) {
		const key = `${placement.asset.id}:${placement.asset.fingerprint}`;
		const resolution = resolutions[key];
		if (!resolution || resolution.state === "pending") {
			unavailablePlacements.push({ id: placement.id, reason: "pending" });
			continue;
		}
		if (
			resolution.assetId !== placement.asset.id ||
			resolution.fingerprint !== placement.asset.fingerprint
		) {
			unavailablePlacements.push({
				id: placement.id,
				reason: "fingerprint_stale",
			});
			continue;
		}
		if (
			(resolution.state === "available" || resolution.state === "deleted") &&
			resolution.accessUrl
		) {
      available.push({
        placement,
				assetKey: key,
        ref: compositionAssetRef("visual_asset", key),
				accessUrl: resolution.accessUrl,
			});
			continue;
		}
    unavailablePlacements.push({
      id: placement.id,
      reason:
        resolution.state === "deleted" || resolution.state === "available"
          ? "storage_unavailable"
          : resolution.state,
    });
	}
	return {
		availability: placements.length === 0
			? undefined
			: {
					state: "available" as const,
					placements: available.map(({ placement, ref }) => ({
						id: placement.id,
						ref,
						mediaKind: placement.mediaKind,
						startSec: placement.startSec,
						endSec: placement.endSec,
						sourceStartSec: placement.sourceStartSec,
						sourceEndSec: placement.sourceEndSec,
					})),
					unavailablePlacements,
				},
		mediaByRef: Object.fromEntries(
			available.map(({ placement, assetKey, ref, accessUrl }) => [
        ref,
        {
					assetKey,
          accessUrl,
					mediaKind: placement.mediaKind,
					sourceStartSec: placement.sourceStartSec,
					sourceEndSec: placement.sourceEndSec,
				},
			]),
		),
	};
}

const COMPOSITION_NOTICE_COPY: Readonly<Record<string, string>> = {
  background_image_pending: "Checking background image…",
  background_image_unavailable:
    "Background image unavailable. Using the selected color.",
  automatic_layout_analyzing:
    "Analyzing speakers… Center framing is shown for now.",
  automatic_layout_disabled: "Automatic speaker layout is disabled. Using Center.",
  automatic_layout_unavailable: "Speaker analysis unavailable. Using Center.",
  split_layout_analyzing: "Analyzing speakers… Center framing is shown for now.",
  split_layout_disabled:
    "Split analysis is disabled. Using single-speaker framing.",
  split_target_ineligible:
    "Split is unavailable for this format. Using single-speaker framing.",
  split_detection_unavailable:
    "Split analysis failed. Using single-speaker framing.",
  split_insufficient_clusters:
    "Two stable speakers were not found. Using single-speaker framing.",
  split_empty_plan: "No usable Split scenes were found. Using single-speaker framing.",
  split_no_two_up_segments:
    "Two stable speakers were not found. Using single-speaker framing.",
  split_tiles_not_distinct:
    "The detected speakers cannot be separated for this format. Using single-speaker framing.",
  split_layout_unavailable: "Split analysis is unavailable. Using Center.",
  screen_layout_analyzing:
    "Analyzing screen layout… A centered speaker tile is shown for now.",
  screen_layout_disabled: "Screen layout is disabled. Using Center.",
  screen_analysis_unavailable:
    "Screen analysis failed. Using a centered speaker tile.",
  screen_detection_unavailable:
    "Speaker detection failed. Using a centered speaker tile.",
  screen_no_face_detected:
    "No speaker face was detected. Using a centered speaker tile.",
  screen_no_trustworthy_faces:
    "No stable speaker face was found. Using a centered speaker tile.",
  screen_pip_too_small:
    "The facecam is too small for this format. Using the speaker fallback.",
  screen_face_band_fallback: "Using the detected speaker band.",
  screen_static_center_fallback:
    "Speaker tracking is unavailable. Using a centered speaker tile.",
  split_broll_conflict: "B-roll uses single-speaker framing for this whole clip.",
  screen_broll_conflict: "B-roll uses single-speaker framing for this whole clip.",
  broll_asset_pending: "Checking B-roll media… Showing the base composition for now.",
  broll_asset_unavailable: "B-roll is unavailable. Showing the base composition.",
	broll_asset_deleted: "This B-roll was removed from the library but remains available in this edit.",
	broll_asset_missing: "A B-roll asset is missing. Showing the source for that range.",
	broll_asset_fingerprint_stale: "A B-roll asset changed. Replace it to restore that range.",
	broll_asset_storage_unavailable: "B-roll storage is temporarily unavailable for one range.",
	broll_asset_source_range_invalid: "A B-roll video no longer covers its saved source range.",
  logo_asset_pending: "Checking logo media…",
  logo_asset_unavailable: "Logo media is unavailable. Showing the rest of the composition.",
  music_asset_pending: "Checking music… The clip remains available without it.",
  music_asset_unavailable: "Music is unavailable. Playing the rest of the mix.",
  sound_effect_asset_pending:
    "Checking a sound effect… The clip remains available without it.",
  sound_effect_asset_unavailable:
    "A sound effect is unavailable. Playing the rest of the mix.",
	scene_asset_pending: "Checking the inserted Scene asset… Export is paused until it is available.",
	scene_asset_unavailable: "An inserted Scene asset is unavailable. Replace or remove this Scene before exporting.",
	scene_font_pending: "Checking the inserted Scene font… Export is paused until it is available.",
  scene_font_unavailable: "An inserted Scene font is unavailable. Replace the font or remove this Scene before exporting.",
  motion_scene_transition_conflict:
    "The clip transition controls this boundary, so the conflicting media entrance is omitted.",
  censor_segment_stale:
    "A censor segment no longer matches the corrected transcript. Disable, delete, or scan again before export.",
  audio_only_background_unsupported:
    "Audiograms use the standard waveform background. Remove the background choice to clear this notice.",
};

function compositionModeLabel(mode: CompositionMode): string {
  return mode === "audiogram"
    ? "Audiogram"
    : `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
}

function compositionNoticeAction(code: string): string {
  if (code.includes("background")) {
    return "Choose another background or turn it off.";
  }
  if (
    code.startsWith("broll_") ||
    code.startsWith("logo_") ||
    code.startsWith("music_") ||
    code.startsWith("sound_effect_")
  ) {
    return "Replace or remove the affected optional asset.";
  }
	if (code.startsWith("scene_")) return "Replace or remove the affected Scene reference.";
  return "Choose another framing mode to clear this notice.";
}

export function compositionNoticeText(
  code: string | null | undefined,
  context?: {
    notice: CompositionNotice;
    requestedMode: CompositionMode;
    effectiveMode: CompositionMode;
  },
): string | null {
  const detail = code ? COMPOSITION_NOTICE_COPY[code] ?? null : null;
  if (!detail || !context) return detail;
  const scope = context.notice.sceneId
    ? `${context.notice.targetId}, scene ${context.notice.sceneId}`
    : context.notice.targetId;
  const requested = compositionModeLabel(context.requestedMode);
  const effective = compositionModeLabel(context.effectiveMode);
  const fidelity =
    context.notice.fidelity === "pending"
      ? `${requested} requested; previewing ${effective} while this composition update completes.`
      : `${requested} requested; preview and export use ${effective}.`;
  const action = context.notice.userActionPossible
    ? ` ${compositionNoticeAction(context.notice.code)}`
    : "";
  return `${scope} · ${fidelity} ${detail}${action}`;
}

export function compositionNoticeTexts(
  notices: readonly CompositionNotice[],
  context: {
    requestedMode: CompositionMode;
    effectiveMode: CompositionMode;
  },
): string[] {
  return compositionNoticeEntries(notices, context).map((entry) => entry.text);
}

export function compositionNoticeEntries(
  notices: readonly CompositionNotice[],
  context: {
    requestedMode: CompositionMode;
    effectiveMode: CompositionMode;
  },
): Array<{ key: string; text: string }> {
  return notices.flatMap((notice) => {
    const text = compositionNoticeText(notice.code, { ...context, notice });
    return text
      ? [
          {
            key: [
              notice.code,
              notice.targetId,
              notice.sceneId ?? "target",
              notice.assetId ?? "composition",
            ].join(":"),
            text,
          },
        ]
      : [];
  });
}

export function compositionInvalidText(code: string): string {
  if (code === "plan_size_exceeded") {
    return "This composition is too complex to export. Remove some timed elements and try again.";
  }
  return "This composition is invalid for the selected format. Choose another format or adjust the layout before exporting.";
}

export function plannedCompositionSourceDimensions(
  proxy: { width: number; height: number },
  durable: { sourceWidth: number; sourceHeight: number } | null,
): { width: number; height: number } {
  return durable
    ? { width: durable.sourceWidth, height: durable.sourceHeight }
    : proxy;
}

export function plannedCompositionFrameStyle(
  layer: Extract<CompositionLayer, { kind: "source-video" }>,
  canvas: { width: number; height: number },
) {
  return {
    position: "absolute" as const,
    left: `${(layer.destination.x / canvas.width) * 100}%`,
    top: `${(layer.destination.y / canvas.height) * 100}%`,
    width: `${(layer.destination.width / canvas.width) * 100}%`,
    height: `${(layer.destination.height / canvas.height) * 100}%`,
    transform: `rotate(${layer.rotationDeg}deg)`,
    transformOrigin: "center",
  };
}

export function plannedCompositionVideoStyle(
  layer: Extract<CompositionLayer, { kind: "source-video" }>,
  source: { width: number; height: number },
  destinationPixels: { width: number; height: number },
  visible: boolean,
) {
  if (layer.fit === "contain") {
    return {
      position: "absolute" as const,
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "contain" as const,
      display: visible ? "block" : "none",
    };
  }
  const normalized = {
    x: layer.sourceCrop.x / source.width,
    y: layer.sourceCrop.y / source.height,
    width: layer.sourceCrop.width / source.width,
    height: layer.sourceCrop.height / source.height,
  };
  const width = destinationPixels.width / normalized.width;
  const height = destinationPixels.height / normalized.height;
  return {
    position: "absolute" as const,
    left: `${-normalized.x * width}px`,
    top: `${-normalized.y * height}px`,
    width: `${width}px`,
    height: `${height}px`,
    maxWidth: "none" as const,
    display: visible ? "block" : "none",
  };
}

export function plannedCompositionMotionStyle(
  motion: CompositionResolvedMotion,
  editedTimeSec: number,
  reducedMotion: boolean,
) {
  if (motion.version !== 1) {
    throw new Error("unsupported_clip_composition_motion_version");
  }
  const state = evaluateCompositionMotion(motion, editedTimeSec, {
    reducedMotion,
  });
  const width = motion.clippingBounds.width;
  const height = motion.clippingBounds.height;
  if (
    width <= 0 ||
    height <= 0 ||
    ![
      state.opacity,
      state.scale,
      state.translateXPx,
      state.translateYPx,
    ].every(Number.isFinite)
  ) {
    throw new Error("invalid_clip_composition_motion");
  }
  const crop = state.crop ?? motion.clippingBounds;
  const cropScale = Math.max(width / crop.width, height / crop.height);
  const originX = ((crop.x + crop.width / 2 - motion.clippingBounds.x) / width) * 100;
  const originY = ((crop.y + crop.height / 2 - motion.clippingBounds.y) / height) * 100;
  return {
    opacity: state.opacity,
    transform: `translate(${(state.translateXPx / width) * 100}%, ${(state.translateYPx / height) * 100}%) scale(${state.scale * cropScale})`,
    transformOrigin: `${originX}% ${originY}%`,
    overflow: "hidden" as const,
    animated: state.animated,
    reducedMotion,
  };
}

function transitionCoverageAt(
  layer: CompositionTransitionVisualLayer,
  timeSec: number,
): number {
  const { fadeIn, fadeOut } = layer.windows;
  if (timeSec <= fadeIn.endSec) {
    const duration = Math.max(0.000_001, fadeIn.endSec - fadeIn.startSec);
    return Math.max(0, Math.min(1, 1 - (timeSec - fadeIn.startSec) / duration));
  }
  if (timeSec >= fadeOut.startSec) {
    const duration = Math.max(0.000_001, fadeOut.endSec - fadeOut.startSec);
    return Math.max(0, Math.min(1, (timeSec - fadeOut.startSec) / duration));
  }
  return 0;
}

export function plannedCompositionTransitionState(
  layer: CompositionTransitionVisualLayer,
  editedTimeSec: number,
  reducedMotion: boolean,
) {
  if (reducedMotion) {
    return {
      family: layer.effect.family,
      active: false,
      reducedMotion: true,
      overlayOpacity: 0,
      overlayClipPath: "none",
      mediaTransform: "none",
    };
  }
  const coverage = transitionCoverageAt(layer, editedTimeSec);
  const progress = 1 - coverage;
  let overlayOpacity = 0;
  let overlayClipPath = "none";
  let mediaTransform = "none";
  if (layer.effect.family === "fade" || layer.effect.family === "cross-dissolve") {
    overlayOpacity = coverage;
  } else if (layer.effect.family === "wipe") {
    overlayOpacity = coverage > 0 ? 1 : 0;
    const hiddenPct = progress * 100;
    overlayClipPath = layer.effect.direction === "left"
      ? `inset(0 0 0 ${hiddenPct}%)`
      : layer.effect.direction === "right"
        ? `inset(0 ${hiddenPct}% 0 0)`
        : layer.effect.direction === "up"
          ? `inset(${hiddenPct}% 0 0 0)`
          : `inset(0 0 ${hiddenPct}% 0)`;
  } else if (layer.effect.family === "slide") {
    const amount = coverage * 100;
    const x = layer.effect.direction === "left"
      ? amount
      : layer.effect.direction === "right"
        ? -amount
        : 0;
    const y = layer.effect.direction === "up"
      ? amount
      : layer.effect.direction === "down"
        ? -amount
        : 0;
    mediaTransform = `translate(${x}%, ${y}%)`;
  } else {
    const from = layer.effect.direction === "in" ? 0.88 : 1.12;
    mediaTransform = `scale(${from + (1 - from) * progress})`;
  }
  return {
    family: layer.effect.family,
    active: coverage > 0,
    reducedMotion: false,
    overlayOpacity,
    overlayClipPath,
    mediaTransform,
  };
}

export function plannedCompositionUsesStackedStage(
  preview: ReturnType<typeof adoptCompositionPreview>,
): boolean {
  if (
    preview.effectiveMode !== "split" &&
    preview.effectiveMode !== "screen"
  ) {
    return false;
  }
  return (
    preview.layers.filter((layer) => layer.kind === "source-video").length > 1
  );
}

const SCENE_END_EPSILON_SEC = 0.075;

function assertFiniteRect(
  rect: { x: number; y: number; width: number; height: number },
  bounds: { width: number; height: number },
  code: string,
): void {
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > bounds.width ||
    rect.y + rect.height > bounds.height
  ) {
    throw new Error(code);
  }
}

function assertLayerGeometry(
  layer: CompositionLayer,
  canvas: { width: number; height: number },
  source: { width: number; height: number },
): void {
  assertFiniteRect(
    layer.destination,
    canvas,
    "invalid_clip_composition_destination",
  );
  if (layer.kind === "source-video") {
    if (
      ![layer.sourceCrop.x, layer.sourceCrop.y, layer.sourceCrop.width, layer.sourceCrop.height]
        .every(Number.isFinite) ||
      layer.sourceCrop.x < 0 ||
      layer.sourceCrop.y < 0 ||
      layer.sourceCrop.width <= 0 ||
      layer.sourceCrop.height <= 0 ||
      layer.sourceCrop.x + layer.sourceCrop.width > source.width ||
      layer.sourceCrop.y + layer.sourceCrop.height > source.height
    ) {
      throw new Error("invalid_clip_composition_source_crop");
    }
  }
  if (
		(layer.kind === "broll-media" || layer.kind === "inserted-scene") &&
    layer.motion
  ) {
    if (
      layer.motion.clippingBounds.x !== layer.destination.x ||
      layer.motion.clippingBounds.y !== layer.destination.y ||
      layer.motion.clippingBounds.width !== layer.destination.width ||
      layer.motion.clippingBounds.height !== layer.destination.height
    ) {
      throw new Error("invalid_clip_composition_motion");
    }
    plannedCompositionMotionStyle(layer.motion, layer.motion.activeRange.startSec, true);
  }
}

function assertVisualLayers(
  layers: readonly CompositionVisualLayer[],
  canvas: { width: number; height: number },
  durationSec: number,
): void {
  let previousZIndex = -Infinity;
  for (const layer of layers) {
    assertFiniteRect(
      layer.destination,
      canvas,
      "invalid_clip_composition_visual_destination",
    );
    if (
      !Number.isFinite(layer.activeRange.startSec) ||
      !Number.isFinite(layer.activeRange.endSec) ||
      layer.activeRange.startSec < 0 ||
      layer.activeRange.endSec <= layer.activeRange.startSec ||
      layer.activeRange.endSec > durationSec + SCENE_END_EPSILON_SEC ||
      layer.zIndex < previousZIndex
    ) {
      throw new Error("invalid_clip_composition_visual_layers");
    }
    if (
      layer.kind === "transition" &&
      (layer.effect.canvas.width !== canvas.width ||
        layer.effect.canvas.height !== canvas.height)
    ) {
      throw new Error("invalid_clip_composition_transition_geometry");
    }
    previousZIndex = layer.zIndex;
  }
}

export function adoptCompositionPreview(
  plan: ClipCompositionPlan,
  targetId: string,
  editedTimeSec: number,
) {
  if (plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const target = plan.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("clip_composition_target_missing");
  if (
    !Number.isInteger(target.canvas.width) ||
    !Number.isInteger(target.canvas.height) ||
    target.canvas.width <= 0 ||
    target.canvas.height <= 0 ||
    target.canvas.width % target.canvas.divisibleBy !== 0 ||
    target.canvas.height % target.canvas.divisibleBy !== 0
  ) {
    throw new Error("invalid_clip_composition_canvas");
  }
  if (target.scenes.length === 0) {
    throw new Error("invalid_clip_composition_scenes");
  }
  assertVisualLayers(target.visualLayers, target.canvas, plan.editedDurationSec);
  let cursor = 0;
  for (const [index, candidate] of target.scenes.entries()) {
    if (
      Math.abs(candidate.startSec - cursor) > SCENE_END_EPSILON_SEC ||
      candidate.endSec <= candidate.startSec ||
      (index === target.scenes.length - 1 &&
        Math.abs(candidate.endSec - plan.editedDurationSec) >
          SCENE_END_EPSILON_SEC)
    ) {
      throw new Error("invalid_clip_composition_scenes");
    }
    for (const layer of candidate.layers) {
      assertLayerGeometry(layer, target.canvas, plan.source);
      if (
        (layer.kind === "source-video" || layer.kind === "audiogram") &&
        layer.sourceRef !== plan.source.ref
      ) {
        throw new Error("invalid_clip_composition_source_ref");
      }
    }
    cursor = candidate.endSec;
  }

  const time = Math.max(0, Math.min(editedTimeSec, plan.editedDurationSec));
  const scene = target.scenes.find(
    (candidate, index) =>
      time >= candidate.startSec &&
      (time < candidate.endSec ||
        (index === target.scenes.length - 1 &&
          time <= candidate.endSec + SCENE_END_EPSILON_SEC)),
  );
  if (!scene) throw new Error("clip_composition_scene_missing");
  const mainSource = scene.layers.find(
    (
      layer,
    ): layer is Extract<
      CompositionLayer,
      { kind: "source-video" | "audiogram" }
    > => layer.kind === "source-video" || layer.kind === "audiogram",
  );
  const insertedScene = scene.layers.some((layer) => layer.kind === "inserted-scene");
  if (!mainSource && !insertedScene) throw new Error("clip_composition_source_layer_missing");
  const visualLayers = target.visualLayers.filter(
    (layer) =>
      time >= layer.activeRange.startSec &&
      (time < layer.activeRange.endSec ||
        (Math.abs(layer.activeRange.endSec - plan.editedDurationSec) <=
          SCENE_END_EPSILON_SEC &&
          time <= layer.activeRange.endSec + SCENE_END_EPSILON_SEC)),
  );

  return {
    planVersion: plan.version,
    planFingerprint: plan.fingerprint,
    mainMediaKey: mainSource?.sourceRef ?? plan.source.ref,
    canvas: target.canvas,
    sceneId: scene.id,
    sceneStartSec: scene.startSec,
    sceneEndSec: scene.endSec,
    requestedMode: target.requestedMode,
    effectiveMode: target.effectiveMode,
    layers: [...scene.layers, ...visualLayers],
    notices: plan.notices.filter(
      (notice) =>
        notice.targetId === target.id &&
        (notice.sceneId === null || notice.sceneId === scene.id),
    ),
  };
}

export function adoptCompositionPreviewResult(
  result: ClipCompositionPlanResult | null,
  targetId: string,
  editedTimeSec: number,
) {
  if (!result) return null;
  if (result.status === "invalid") {
    throw new Error(`invalid_clip_composition_plan:${result.error.code}`);
  }
  return adoptCompositionPreview(result.plan, targetId, editedTimeSec);
}
