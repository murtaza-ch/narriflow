import {
  CLIP_COMPOSITION_PLAN_VERSION,
  COMPOSITION_MOTION_VERSION,
  SCENE_CONTINUITY_EPSILON_SEC,
  assertCompositionSceneTextRender,
  sampleCompositionMotion,
  type ClipCompositionPlan,
  type ClipCompositionPlanResult,
  type CompositionBrollAvailability,
  type CompositionAudioSchedule,
  type CompositionLayer,
  type CompositionMode,
  type CompositionNotice,
  type CompositionSceneTextRender,
  type CompositionVisualLayer,
  type CompositionMotionPlan,
} from "@narriflow/composition-plan";
import { duckingGainMultiplierAt } from "@narriflow/validators";

export function plannedSceneTextPreview(
  render: CompositionSceneTextRender,
  canvas: { width: number; height: number },
  previewWidth: number,
) {
  assertCompositionSceneTextRender(render, canvas);
  if (!Number.isFinite(previewWidth) || previewWidth <= 0) {
    throw new Error("invalid_clip_composition_scene_text");
  }
  const scale = previewWidth / canvas.width;
  return {
    text: render.lines.join("\n"),
    fontSizePx: render.fontSizePx * scale,
    lineHeightPx: render.lineHeightPx * scale,
    maxWidthPx: render.maxWidthPx * scale,
  };
}

export function adoptCompositionMotion(
  motion: CompositionMotionPlan,
  editedTimeSec: number,
  reducedMotion: boolean,
) {
  if (motion.version !== COMPOSITION_MOTION_VERSION) {
    throw new Error("unsupported_composition_motion_version");
  }
  return sampleCompositionMotion(motion, editedTimeSec, { reducedMotion });
}

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
  const activeCensor = schedule.censors.find(
    (censor) => timeSec >= censor.startSec && timeSec < censor.endSec,
  );
  const sourceEnvelopeGain = activeCensor ? 0 : outputGain;
  const beep = activeCensor?.treatment === "beep"
    ? {
        frequencyHz: activeCensor.frequencyHz,
        volume:
          activeCensor.gain *
          outputGain *
          fadeEnvelopeAt(
            {
              fadeIn: {
                startSec: activeCensor.startSec,
                endSec: activeCensor.startSec + activeCensor.fadeInSec,
              },
              fadeOut: {
                startSec: activeCensor.endSec - activeCensor.fadeOutSec,
                endSec: activeCensor.endSec,
              },
            },
            timeSec,
          ),
      }
    : null;
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
  const soundEffects = schedule.soundEffects
    .filter((effect) => rangeContains(effect.activeRange, timeSec))
    .map((effect) => ({
      id: effect.id,
      sourceRef: effect.sourceRef,
      localTimeSec: timeSec - effect.activeRange.startSec,
      volume: effect.gain * outputGain,
    }));
  const peakGainSum =
    sourceEnvelopeGain * schedule.source.gain +
    (beep?.volume ?? 0) +
    (plannedMusic?.volume ?? 0) +
    soundEffects.reduce((sum, effect) => sum + effect.volume, 0);
  // The browser plays media elements and the oscillator through separate
  // output nodes, so it cannot share FFmpeg's final limiter. While a beep is
  // active, apply conservative shared headroom across every audible branch;
  // an isolated tone remains at its exact configured level.
  const mixGain = beep && peakGainSum > 0.95 ? 0.95 / peakGainSum : 1;
  return {
    scheduleFingerprint: schedule.fingerprint,
    mixGain,
    source: {
      muted: schedule.source.muted || !schedule.source.available,
      volume: schedule.source.gain * sourceEnvelopeGain * mixGain,
      outputGain,
      envelopeGain: sourceEnvelopeGain * mixGain,
    },
    beep: beep ? { ...beep, volume: beep.volume * mixGain } : null,
    music: plannedMusic ? { ...plannedMusic, volume: plannedMusic.volume * mixGain } : null,
    soundEffects: soundEffects.map((effect) => ({
      ...effect,
      volume: effect.volume * mixGain,
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
        startSec: input.window.startSec,
        endSec: input.window.endSec,
      },
    ],
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
  scene_motion_entrance_suppressed_by_transition:
    "The clip transition owns this opening. The Scene entrance is paused.",
  scene_motion_exit_suppressed_by_transition:
    "The clip transition owns this ending. The Scene exit is paused.",
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
  if (code === "text_scene_unfit") {
    return "This Scene has too much text for this format. Shorten the copy or choose another format before exporting.";
  }
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
      layer.activeRange.endSec >
        durationSec + SCENE_CONTINUITY_EPSILON_SEC ||
      layer.zIndex < previousZIndex
    ) {
      throw new Error("invalid_clip_composition_visual_layers");
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
      Math.abs(candidate.startSec - cursor) >
        SCENE_CONTINUITY_EPSILON_SEC ||
      candidate.endSec <= candidate.startSec ||
      (index === target.scenes.length - 1 &&
        Math.abs(candidate.endSec - plan.editedDurationSec) >
          SCENE_CONTINUITY_EPSILON_SEC)
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
          time <= candidate.endSec + SCENE_CONTINUITY_EPSILON_SEC)),
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
          SCENE_CONTINUITY_EPSILON_SEC &&
          time <= layer.activeRange.endSec + SCENE_CONTINUITY_EPSILON_SEC)),
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
