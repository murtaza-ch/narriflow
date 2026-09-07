import {
  CLIP_COMPOSITION_PLAN_VERSION,
  COMPOSITION_MOTION_VERSION,
  SCENE_CONTINUITY_EPSILON_SEC,
  assertCompositionSceneTextRender,
  compositionAssetRef,
  type ClipCompositionPlan,
  type CompositionBrollVideoLayer,
  type CompositionBrollImageLayer,
  type CompositionInsertedSceneLayer,
  type CompositionMotionPlan,
  type CompositionMotionState,
  type CompositionRect,
  type CompositionTargetPlan,
  type CompositionVisualLayer,
} from "@narriflow/composition-plan";
import { escapeDrawtextText } from "./ffmpeg-text";

export function compileCompositionPlanAudiogram(
  plan: ClipCompositionPlan,
  targetId: string,
) {
  if (plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const target = plan.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("clip_composition_target_missing");
  if (target.effectiveMode !== "audiogram" || target.scenes.length === 0) {
    throw new Error("clip_composition_audiogram_missing");
  }
  const scene = target.scenes.find((candidate) =>
    candidate.layers.some((layer) => layer.kind === "audiogram"));
  if (!scene) throw new Error("clip_composition_audiogram_missing");
  const layer = scene.layers.find(
    (candidate) => candidate.kind === "audiogram",
  );
  if (
    !layer ||
    layer.sourceRef !== plan.source.ref ||
    layer.destination.x !== 0 ||
    layer.destination.y !== 0 ||
    layer.destination.width !== target.canvas.width ||
    layer.destination.height !== target.canvas.height ||
    layer.waveformHeightRatio <= 0 ||
    layer.waveformHeightRatio > 1
  ) {
    throw new Error("invalid_clip_composition_audiogram");
  }
  return {
    sourceRef: layer.sourceRef,
    canvas: target.canvas,
    backgroundColor: layer.backgroundColor,
    waveformColor: layer.waveformColor,
    waveformHeight: Math.round(
      target.canvas.height * layer.waveformHeightRatio,
    ),
  };
}

export function compileCompositionPlanAudioSchedule(plan: ClipCompositionPlan) {
  if (plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const schedule = plan.audioSchedule;
  const validRange = (range: { startSec: number; endSec: number }) =>
    Number.isFinite(range.startSec) &&
    Number.isFinite(range.endSec) &&
    range.startSec >= 0 &&
    range.endSec > range.startSec &&
    range.endSec <= plan.editedDurationSec;
  const validFadeRange = (range: { startSec: number; endSec: number }) =>
    Number.isFinite(range.startSec) &&
    Number.isFinite(range.endSec) &&
    range.startSec >= 0 &&
    range.endSec >= range.startSec &&
    range.endSec <= plan.editedDurationSec;
  if (
    !validFadeRange(schedule.outputFades.fadeIn) ||
    !validFadeRange(schedule.outputFades.fadeOut) ||
    !validRange(schedule.source.activeRange) ||
    !Number.isFinite(schedule.source.gain) ||
    schedule.source.gain < 0 ||
    schedule.source.gain > 1
  ) {
    throw new Error("invalid_clip_composition_audio_schedule");
  }
  const music = schedule.music;
  if (
    music &&
    (!validRange(music.activeRange) ||
      !validFadeRange(music.fades.fadeIn) ||
      !validFadeRange(music.fades.fadeOut) ||
      music.fades.fadeIn.endSec > music.fades.fadeOut.startSec ||
      !Number.isFinite(music.gain) ||
      music.gain < 0 ||
      music.gain > 1 ||
      !Number.isFinite(music.startOffsetSec) ||
      music.startOffsetSec < 0 ||
      music.ducking.windows.some((window) => !validRange(window)))
  ) {
    throw new Error("invalid_clip_composition_audio_schedule");
  }
  if (
    schedule.soundEffects.some(
      (effect) =>
        !validRange(effect.activeRange) ||
        !Number.isFinite(effect.gain) ||
        effect.gain < 0 ||
        effect.gain > 1,
    )
  ) {
    throw new Error("invalid_clip_composition_audio_schedule");
  }
  if (
    schedule.censors.some((censor, index) => {
      if (!validRange(censor)) return true;
      const previous = schedule.censors[index - 1];
      if (previous && previous.endSec > censor.startSec) return true;
      if (censor.treatment === "mute") return false;
      const durationSec = censor.endSec - censor.startSec;
      return (
        !Number.isFinite(censor.frequencyHz) ||
        censor.frequencyHz < 200 ||
        censor.frequencyHz > 2_000 ||
        !Number.isFinite(censor.gain) ||
        censor.gain < 0 ||
        censor.gain > 0.95 ||
        !Number.isFinite(censor.fadeInSec) ||
        !Number.isFinite(censor.fadeOutSec) ||
        censor.fadeInSec < 0 ||
        censor.fadeOutSec < 0 ||
        censor.fadeInSec + censor.fadeOutSec > durationSec
      );
    })
  ) {
    throw new Error("invalid_clip_composition_audio_schedule");
  }
  return {
    scheduleFingerprint: schedule.fingerprint,
    outputFades: schedule.outputFades,
    source: {
      activeRange: schedule.source.activeRange,
      available: schedule.source.available,
      gain: schedule.source.gain,
      muted: schedule.source.muted,
    },
    music: music
      ? {
          sourceRef: music.sourceRef,
          activeRange: music.activeRange,
          gain: music.gain,
          startOffsetSec: music.startOffsetSec,
          sourceDurationSec: music.sourceDurationSec,
          loop: music.loop,
          fades: music.fades,
          ducking: music.ducking,
        }
      : null,
    soundEffects: schedule.soundEffects.map((effect) => ({
      id: effect.id,
      sourceRef: effect.sourceRef,
      activeRange: effect.activeRange,
      gain: effect.gain,
    })),
    censors: schedule.censors.map((censor) => ({ ...censor })),
  };
}

export type CompositionAudioRenderRequest = ReturnType<
  typeof compileCompositionPlanAudioSchedule
>;

export function bindCompositionPlanAudioInputs(
  request: CompositionAudioRenderRequest,
  resolved: {
    music?: { sourceRef: string; path: string } | null;
    soundEffects?: readonly {
      id: string;
      sourceRef: string;
      path: string;
    }[];
  },
) {
  const music = request.music
    ? resolved.music?.sourceRef === request.music.sourceRef
      ? { ...request.music, path: resolved.music.path }
      : null
    : null;
  if (request.music && !music) {
    throw new Error("clip_composition_music_input_missing");
  }
  const soundEffects = request.soundEffects.map((planned) => {
    const input = resolved.soundEffects?.find(
      (candidate) =>
        candidate.id === planned.id &&
        candidate.sourceRef === planned.sourceRef,
    );
    if (!input) throw new Error("clip_composition_sound_effect_input_missing");
    return { ...planned, path: input.path };
  });
  return { ...request, music, soundEffects };
}

export type BoundCompositionAudioRenderRequest = ReturnType<
  typeof bindCompositionPlanAudioInputs
>;

export function compileCompositionPlanSceneAudio(input: {
  plan: ClipCompositionPlan;
  targetId: string;
  sourceAudioLabel: string | null;
  sceneInputs: ReadonlyArray<{ sourceRef: string; inputIndex: number; hasAudio: boolean }>;
}) {
  const target = input.plan.targets.find((candidate) => candidate.id === input.targetId);
  if (!target) throw new Error("clip_composition_target_missing");
  if (!target.scenes.some((scene) => scene.layers.some((layer) => layer.kind === "inserted-scene"))) {
    return { filterParts: [] as string[], outputLabel: input.sourceAudioLabel };
  }
  const sourceScenes = target.scenes.filter((scene) => scene.sourceRange);
  const sourceLabels = sourceScenes.map((_, index) => `[composition_source_audio_${index}]`);
  const parts: string[] = [];
  if (input.sourceAudioLabel && sourceLabels.length > 1) {
    parts.push(`${input.sourceAudioLabel}asplit=${sourceLabels.length}${sourceLabels.join("")}`);
  }
  let sourceIndex = 0;
  const outputs: string[] = [];
  target.scenes.forEach((scene, index) => {
    const duration = scene.endSec - scene.startSec;
    const output = `[composition_scene_audio_${index}]`;
    outputs.push(output);
    const inserted = scene.layers.find(
      (layer): layer is CompositionInsertedSceneLayer => layer.kind === "inserted-scene",
    );
    if (!inserted) {
      if (!input.sourceAudioLabel) {
        parts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration.toFixed(3)}${output}`);
        return;
      }
      const source = sourceLabels.length === 1 ? input.sourceAudioLabel : sourceLabels[sourceIndex]!;
      sourceIndex += 1;
      parts.push(`${source}atrim=start=${scene.sourceRange!.startSec.toFixed(3)}:end=${scene.sourceRange!.endSec.toFixed(3)},asetpts=PTS-STARTPTS${output}`);
      return;
    }
    if (inserted.content.kind === "video" && !inserted.content.muted) {
      const asset = input.sceneInputs.find((candidate) => candidate.sourceRef === inserted.sourceRef);
      if (asset?.hasAudio) {
        parts.push(`[${asset.inputIndex}:a]atrim=start=${inserted.content.sourceStartSec.toFixed(3)}:end=${inserted.content.sourceEndSec.toFixed(3)},asetpts=PTS-STARTPTS,volume=${(inserted.content.volume / 100).toFixed(3)},apad,atrim=duration=${duration.toFixed(3)}${output}`);
        return;
      }
    }
    parts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration.toFixed(3)}${output}`);
  });
  parts.push(`${outputs.join("")}concat=n=${outputs.length}:v=0:a=1[composition_scene_audio]`);
  return { filterParts: parts, outputLabel: "[composition_scene_audio]" };
}

function assertCompositionMotion(
  motion: CompositionMotionPlan,
  canvas: { width: number; height: number },
): void {
  if (motion.version !== COMPOSITION_MOTION_VERSION) {
    throw new Error("unsupported_composition_motion_version");
  }
  const validRange = (range: { startSec: number; endSec: number }) =>
    Number.isFinite(range.startSec) &&
    Number.isFinite(range.endSec) &&
    range.startSec >= motion.activeRange.startSec &&
    range.endSec <= motion.activeRange.endSec &&
    range.endSec > range.startSec;
  const validRect = (rect: CompositionMotionState["crop"], allowEmpty: boolean) =>
    [rect.x, rect.y, rect.width, rect.height].every(
      (value) => Number.isFinite(value) && Number.isInteger(value),
    ) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width >= (allowEmpty ? 0 : 2) &&
    rect.height >= (allowEmpty ? 0 : 2) &&
    rect.x + rect.width <= canvas.width &&
    rect.y + rect.height <= canvas.height;
  const validState = (state: CompositionMotionState) =>
    Number.isFinite(state.opacity) &&
    state.opacity >= 0 &&
    state.opacity <= 1 &&
    Number.isFinite(state.transform.translateX) &&
    Number.isFinite(state.transform.translateY) &&
    Number.isFinite(state.transform.scale) &&
    state.transform.scale > 0 &&
    validRect(state.crop, false) &&
    validRect(state.clip, true);
  const windows = [motion.entrance, motion.exit].filter(
    (window): window is NonNullable<typeof window> => window !== null,
  );
  if (
    motion.activeRange.startSec < 0 ||
    motion.activeRange.endSec <= motion.activeRange.startSec ||
    !validState(motion.restingState) ||
    windows.some(
      (window) =>
        !validRange(window.range) ||
        !validState(window.from) ||
        !validState(window.to),
    ) ||
    (motion.entrance &&
      motion.exit &&
      motion.entrance.range.endSec > motion.exit.range.startSec)
  ) {
    throw new Error("invalid_composition_motion_plan");
  }
}

function motionValueExpression(input: {
  motion: CompositionMotionPlan;
  timeOffsetSec: number;
  resting: number;
  read: (state: CompositionMotionState) => number;
}): string {
  const interpolate = (
    from: number,
    to: number,
    startSec: number,
    endSec: number,
  ) => {
    const start = startSec - input.timeOffsetSec;
    const end = endSec - input.timeOffsetSec;
    const duration = Math.max(0.001, end - start);
    return `${from.toFixed(6)}+${(to - from).toFixed(6)}*clip((t-${start.toFixed(6)})/${duration.toFixed(6)},0,1)`;
  };
  let expression = input.resting.toFixed(6);
  if (input.motion.entrance) {
    const window = input.motion.entrance;
    expression = `if(lt(t,${(window.range.endSec - input.timeOffsetSec).toFixed(6)}),${interpolate(input.read(window.from), input.read(window.to), window.range.startSec, window.range.endSec)},${expression})`;
  }
  if (input.motion.exit) {
    const window = input.motion.exit;
    expression = `if(gte(t,${(window.range.startSec - input.timeOffsetSec).toFixed(6)}),${interpolate(input.read(window.from), input.read(window.to), window.range.startSec, window.range.endSec)},${expression})`;
  }
  return expression;
}

function compositionMotionFilters(input: {
  motion: CompositionMotionPlan | null;
  width: number;
  height: number;
  backgroundColor: string;
  timeOffsetSec?: number;
  alpha?: boolean;
}) {
  if (!input.motion) return "";
  assertCompositionMotion(input.motion, { width: input.width, height: input.height });
  const offset = input.timeOffsetSec ?? 0;
  const states = [
    input.motion.restingState,
    input.motion.entrance?.from,
    input.motion.entrance?.to,
    input.motion.exit?.from,
    input.motion.exit?.to,
  ].filter((state): state is CompositionMotionState => state !== undefined);
  const expr = (resting: number, read: (state: CompositionMotionState) => number) =>
    motionValueExpression({ motion: input.motion!, timeOffsetSec: offset, resting, read });
  const filters: string[] = [];
  const alpha = input.alpha ? ":alpha=1" : "";
  const backgroundColor = input.backgroundColor.startsWith("#")
    ? `0x${input.backgroundColor.slice(1)}`
    : input.backgroundColor;
  for (const window of [input.motion.entrance, input.motion.exit]) {
    if (!window || window.from.opacity === window.to.opacity) continue;
    const type = window.from.opacity < window.to.opacity ? "in" : "out";
    filters.push(
      `fade=t=${type}:st=${(window.range.startSec - offset).toFixed(3)}:d=${(window.range.endSec - window.range.startSec).toFixed(3)}${alpha}`,
    );
  }
  const cropChanged = states.some(
    (state) => JSON.stringify(state.crop) !== JSON.stringify(input.motion!.restingState.crop),
  );
  if (cropChanged) {
    const crop = input.motion.restingState.crop;
    const cropWidth = expr(crop.width, (state) => state.crop.width);
    const cropHeight = expr(crop.height, (state) => state.crop.height);
    const cropX = expr(crop.x, (state) => state.crop.x);
    const cropY = expr(crop.y, (state) => state.crop.y);
    filters.push(
      `scale=w='max(2,round(iw*${input.width}/(${cropWidth})/2)*2)':h='max(2,round(ih*${input.height}/(${cropHeight})/2)*2)':eval=frame`,
      `crop=${input.width}:${input.height}:x='max(0,(${cropX})*${input.width}/(${cropWidth}))':y='max(0,(${cropY})*${input.height}/(${cropHeight}))'`,
    );
  }
  const transformChanged = states.some(
    (state) => JSON.stringify(state.transform) !== JSON.stringify(input.motion!.restingState.transform),
  );
  if (transformChanged) {
    const transform = input.motion.restingState.transform;
    const scale = expr(transform.scale, (state) => state.transform.scale);
    const x = expr(transform.translateX, (state) => state.transform.translateX);
    const y = expr(transform.translateY, (state) => state.transform.translateY);
    const largeTranslation = states.some(
      (state) =>
        Math.abs(state.transform.translateX) >= input.width / 2 ||
        Math.abs(state.transform.translateY) >= input.height / 2,
    );
    if (largeTranslation) {
      filters.push(
        `pad=${input.width * 3}:${input.height * 3}:${input.width}:${input.height}:color=${input.alpha ? "black@0" : backgroundColor}`,
        `crop=${input.width}:${input.height}:x='${input.width}-(${x})':y='${input.height}-(${y})'`,
      );
    } else {
      filters.push(
        `scale=w='max(2,round(iw*(${scale})/2)*2)':h='max(2,round(ih*(${scale})/2)*2)':eval=frame`,
        `crop=w='min(iw,${input.width})':h='min(ih,${input.height})':x='max(0,(iw-${input.width})/2-(${x}))':y='max(0,(ih-${input.height})/2-(${y}))'`,
        `pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2:color=${input.alpha ? "black@0" : backgroundColor}`,
      );
    }
  }
  const clipChanged = states.some(
    (state) => JSON.stringify(state.clip) !== JSON.stringify(input.motion!.restingState.clip),
  );
  if (clipChanged) {
    const clip = input.motion.restingState.clip;
    const clipX = expr(clip.x, (state) => state.clip.x);
    const clipY = expr(clip.y, (state) => state.clip.y);
    const clipWidth = expr(clip.width, (state) => state.clip.width);
    const clipHeight = expr(clip.height, (state) => state.clip.height);
    const color = input.alpha
      ? "black@0"
      : backgroundColor;
    filters.push(
      `drawbox=x=0:y=0:w='max(0,${clipX})':h=${input.height}:color=${color}:t=fill`,
      `drawbox=x='min(${input.width},(${clipX})+(${clipWidth}))':y=0:w='max(0,${input.width}-((${clipX})+(${clipWidth})))':h=${input.height}:color=${color}:t=fill`,
      `drawbox=x=0:y=0:w=${input.width}:h='max(0,${clipY})':color=${color}:t=fill`,
      `drawbox=x=0:y='min(${input.height},(${clipY})+(${clipHeight}))':w=${input.width}:h='max(0,${input.height}-((${clipY})+(${clipHeight})))':color=${color}:t=fill`,
    );
  }
  return filters.length ? `,${filters.join(",")},setsar=1` : "";
}

function escapeDrawtextValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}

function escapeSubtitlePath(filePath: string): string {
  return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function logoOverlayPosition(position: string, marginPx: number) {
  const [vertical, horizontal] = position.split("-");
  const x =
    horizontal === "left"
      ? `${marginPx}`
      : horizontal === "right"
        ? `W-w-${marginPx}`
        : "(W-w)/2";
  const y =
    vertical === "top"
      ? `${marginPx}`
      : vertical === "bot"
        ? `H-h-${marginPx}`
        : "(H-h)/2";
  return { x, y };
}

function textLayerFilter(
  layer: Extract<CompositionVisualLayer, { kind: "text" }>,
): string {
  const value = layer.value;
  const border =
    value.outlineWidth > 0
      ? `:borderw=${value.outlineWidth}:bordercolor=0x${value.outlineColor.slice(1)}`
      : "";
  const box = value.backgroundColor
    ? `:box=1:boxcolor=0x${value.backgroundColor.slice(1)}@${value.backgroundOpacity.toFixed(3)}:boxborderw=10`
    : "";
  return (
    `drawtext=font='${escapeDrawtextValue(value.fontName)}'` +
    `:text='${escapeDrawtextValue(value.text)}'` +
    `:fontsize=${Math.round(value.fontSize)}` +
    `:fontcolor=0x${value.color.slice(1)}` +
    `:x=w*${(layer.anchor.xPct / 100).toFixed(4)}-text_w/2` +
    `:y=h*${(layer.anchor.yPct / 100).toFixed(4)}-text_h/2` +
    `:enable='between(t\\,${layer.activeRange.startSec.toFixed(3)}\\,${layer.activeRange.endSec.toFixed(3)})'` +
    ":shadowcolor=black@0.45:shadowx=0:shadowy=2" +
    border +
    box
  );
}

/** Translates the target's already-ordered visual schedule into FFmpeg syntax.
 * It does not inspect the editor document or select timing, precedence,
 * entitlement, geometry, or optional-media fallbacks. */
export function compileCompositionPlanVisualLayers(input: {
  plan: ClipCompositionPlan;
  targetId: string;
  inputLabel: string;
  outputLabel: string;
  subtitlePath?: string | null;
  logoInputIndex?: number | null;
}): {
  filterParts: string[];
  logoInput: { sourceRef: string; inputIndex: number } | null;
} {
  if (input.plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const target = input.plan.targets.find(
    (candidate) => candidate.id === input.targetId,
  );
  if (!target) throw new Error("clip_composition_target_missing");

  let previousZIndex = -Infinity;
  for (const layer of target.visualLayers) {
    assertRect(
      layer.destination,
      target.canvas,
      "invalid_clip_composition_visual_destination",
    );
    if (
      layer.zIndex < previousZIndex ||
      layer.activeRange.startSec < 0 ||
      layer.activeRange.endSec <= layer.activeRange.startSec ||
      layer.activeRange.endSec >
        input.plan.editedDurationSec + SCENE_CONTINUITY_EPSILON_SEC
    ) {
      throw new Error("invalid_clip_composition_visual_layers");
    }
    if (layer.kind === "transition") {
      assertCompositionMotion(layer.motion, target.canvas);
    }
    previousZIndex = layer.zIndex;
  }

  type Stage = (
    source: string,
    output: string,
    stageIndex: number,
  ) => { parts: string[]; logoInput?: { sourceRef: string; inputIndex: number } };
  const stages: Stage[] = [];
  let captionsAdded = false;
  for (const layer of target.visualLayers) {
    if (layer.kind === "text") {
      stages.push((source, output) => ({
        parts: [`${source}${textLayerFilter(layer)}${output}`],
      }));
    } else if (layer.kind === "caption" && !captionsAdded) {
      captionsAdded = true;
      stages.push((source, output) => {
        if (!input.subtitlePath) {
          throw new Error("clip_composition_caption_asset_missing");
        }
        const filter = input.subtitlePath.endsWith(".ass")
          ? `ass='${escapeSubtitlePath(input.subtitlePath)}'`
          : `subtitles='${escapeSubtitlePath(input.subtitlePath)}'`;
        return { parts: [`${source}${filter}${output}`] };
      });
    } else if (layer.kind === "logo") {
      stages.push((source, output, stageIndex) => {
        if (input.logoInputIndex == null) {
          throw new Error("clip_composition_logo_input_missing");
        }
        const logoLabel = `[composition_logo_${stageIndex}]`;
        const position = logoOverlayPosition(layer.position, layer.marginPx);
        return {
          parts: [
            `[${input.logoInputIndex}:v]scale=${layer.widthPx}:-1,format=rgba,colorchannelmixer=aa=${layer.opacity.toFixed(3)}${logoLabel}`,
            `${source}${logoLabel}overlay=${position.x}:${position.y}${output}`,
          ],
          logoInput: {
            sourceRef: layer.sourceRef,
            inputIndex: input.logoInputIndex,
          },
        };
      });
    } else if (layer.kind === "transition") {
      stages.push((source, output) => {
        if (layer.application === "overlay") {
          const fadeIn = layer.motion.entrance;
          const fadeOut = layer.motion.exit;
          if (!fadeIn || !fadeOut) {
            throw new Error("invalid_composition_motion_plan");
          }
          return {
            parts: [
              `${source}fade=t=in:st=${fadeIn.range.startSec.toFixed(3)}:d=${(fadeIn.range.endSec - fadeIn.range.startSec).toFixed(3)}:color=${layer.color},` +
                `fade=t=out:st=${fadeOut.range.startSec.toFixed(3)}:d=${(fadeOut.range.endSec - fadeOut.range.startSec).toFixed(3)}:color=${layer.color}${output}`,
            ],
          };
        }
        const motion = compositionMotionFilters({
          motion: layer.motion,
          width: target.canvas.width,
          height: target.canvas.height,
          backgroundColor: layer.color,
        });
        const motionChain = motion.startsWith(",") ? motion.slice(1) : motion;
        return {
          parts: [`${source}${motionChain || "null"}${output}`],
        };
      });
    } else if (layer.kind === "output-treatment") {
      if (layer.resolution === "1080p" && !layer.watermark.enabled) continue;
      stages.push((source, output) => {
        const filters = [
          layer.resolution === "720p"
            ? "scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2"
            : "",
          layer.watermark.enabled
            ? `drawtext=text=${escapeDrawtextValue(layer.watermark.text)}` +
              `:font='${escapeDrawtextValue(`${layer.watermark.fontFamily} Bold`)}'` +
              `:fontcolor=0x${layer.watermark.color.slice(1)}@${layer.watermark.opacity.toFixed(2)}` +
              `:borderw=${layer.watermark.outline.widthPx}` +
              `:bordercolor=0x${layer.watermark.outline.color.slice(1)}@${layer.watermark.outline.opacity.toFixed(2)}` +
              `:fontsize=${layer.watermark.fontSizePx}` +
              `:x=w-tw-${layer.watermark.marginPx.x}:y=${layer.watermark.marginPx.y}`
            : "",
        ].filter(Boolean);
        return { parts: [`${source}${filters.join(",")}${output}`] };
      });
    }
  }

  if (stages.length === 0) {
    return {
      filterParts:
        input.inputLabel === input.outputLabel
          ? []
          : [`${input.inputLabel}null${input.outputLabel}`],
      logoInput: null,
    };
  }
  const filterParts: string[] = [];
  let source = input.inputLabel;
  let logoInput: { sourceRef: string; inputIndex: number } | null = null;
  stages.forEach((stage, index) => {
    const output =
      index === stages.length - 1
        ? input.outputLabel
        : `[composition_visual_${index}]`;
    const compiled = stage(source, output, index);
    filterParts.push(...compiled.parts);
    if (compiled.logoInput) logoInput = compiled.logoInput;
    source = output;
  });
  return { filterParts, logoInput };
}

function baseOnlyTarget(target: CompositionTargetPlan): CompositionTargetPlan {
  const scenes = target.scenes.map((scene) => ({
    ...scene,
    layers: scene.layers.filter(
      (layer) => layer.kind === "source-video" || layer.kind === "background",
    ),
  }));
  const coalesced = scenes.reduce<typeof scenes>((result, scene) => {
    const previous = result[result.length - 1];
    if (
      previous &&
      Math.abs(previous.endSec - scene.startSec) <=
        SCENE_CONTINUITY_EPSILON_SEC &&
      JSON.stringify(previous.layers) === JSON.stringify(scene.layers)
    ) {
      result[result.length - 1] = { ...previous, endSec: scene.endSec };
    } else {
      result.push(scene);
    }
    return result;
  }, []);
  return { ...target, scenes: coalesced };
}

function plannedCompositionBrollPlacements(
  plan: ClipCompositionPlan,
  targetId: string,
): Array<{
  id: string;
  sourceRef: string;
  startSec: number;
  endSec: number;
  audio: "source";
  kind: "image" | "video";
  motion: CompositionMotionPlan | null;
}> {
  if (plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const target = plan.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("clip_composition_target_missing");

  const fragments = new Map<
    string,
    { layer: CompositionBrollVideoLayer | CompositionBrollImageLayer; ranges: Array<[number, number]> }
  >();
  for (const scene of target.scenes) {
    const active = scene.layers.filter(
      (layer): layer is CompositionBrollVideoLayer | CompositionBrollImageLayer =>
        layer.kind === "broll-video" || layer.kind === "broll-image",
    );
    if (active.length > 1) {
      throw new Error("invalid_clip_composition_broll_overlap");
    }
    for (const layer of active) {
      assertRect(
        layer.destination,
        target.canvas,
        "invalid_clip_composition_destination",
      );
      if (
        layer.sourceRef.length === 0 ||
        layer.fit !== "cover" ||
        (layer.kind === "broll-video" && layer.audio !== "source") ||
        layer.destination.x !== 0 ||
        layer.destination.y !== 0 ||
        layer.destination.width !== target.canvas.width ||
        layer.destination.height !== target.canvas.height ||
        layer.activeRange.startSec < 0 ||
        layer.activeRange.endSec <= layer.activeRange.startSec ||
        scene.startSec < layer.activeRange.startSec ||
        scene.endSec > layer.activeRange.endSec
      ) {
        throw new Error("invalid_clip_composition_broll_layer");
      }
      const existing = fragments.get(layer.id);
      if (existing) {
        if (
        existing.layer.sourceRef !== layer.sourceRef ||
          existing.layer.kind !== layer.kind ||
          existing.layer.activeRange.startSec !== layer.activeRange.startSec ||
          existing.layer.activeRange.endSec !== layer.activeRange.endSec
        ) {
          throw new Error("invalid_clip_composition_broll_layer");
        }
        existing.ranges.push([scene.startSec, scene.endSec]);
      } else {
        fragments.set(layer.id, {
          layer,
          ranges: [[scene.startSec, scene.endSec]],
        });
      }
    }
  }

  return [...fragments.values()]
    .map(({ layer, ranges }) => {
      const ordered = ranges.sort((left, right) => left[0] - right[0]);
      let cursor = layer.activeRange.startSec;
      for (const [startSec, endSec] of ordered) {
        if (Math.abs(startSec - cursor) > SCENE_CONTINUITY_EPSILON_SEC) {
          throw new Error("invalid_clip_composition_broll_layer");
        }
        cursor = endSec;
      }
      if (
        Math.abs(cursor - layer.activeRange.endSec) >
        SCENE_CONTINUITY_EPSILON_SEC
      ) {
        throw new Error("invalid_clip_composition_broll_layer");
      }
      return {
        id: layer.id,
        sourceRef: layer.sourceRef,
        startSec: layer.activeRange.startSec,
        endSec: layer.activeRange.endSec,
        audio: "source" as const,
        kind: layer.kind === "broll-image" ? "image" as const : "video" as const,
        motion: layer.motion,
      };
    })
    .sort((left, right) => left.startSec - right.startSec);
}

function assertRect(
  rect: CompositionRect,
  bounds: { width: number; height: number } | null,
  code: string,
): void {
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    (bounds !== null &&
      (rect.x + rect.width > bounds.width || rect.y + rect.height > bounds.height))
  ) {
    throw new Error(code);
  }
}

export function compileCompositionPlanInsertedSceneSequence(input: {
  plan: ClipCompositionPlan;
  targetId: string;
  baseVideoLabel: string;
  outputLabel: string;
  trailingChain?: string;
  fps?: number;
  resolvedSceneAssets?: Readonly<Record<string, { path: string; kind: "image" | "video" }>>;
  resolvedSceneFonts?: Readonly<Record<string, string>>;
  sceneInputStartIndex?: number;
}) {
  const target = input.plan.targets.find((candidate) => candidate.id === input.targetId);
  if (!target) throw new Error("clip_composition_target_missing");
  const insertedLayers = target.scenes.flatMap((scene) => scene.layers.filter(
    (layer): layer is CompositionInsertedSceneLayer => layer.kind === "inserted-scene",
  ));
  if (insertedLayers.length === 0) {
    throw new Error("clip_composition_inserted_scenes_missing");
  }
  const uniqueLayers = [...new Map(insertedLayers
    .filter((layer) => layer.sourceRef !== null)
    .map((layer) => [layer.sourceRef!, layer])).values()];
  if (uniqueLayers.length > 0 && input.sceneInputStartIndex == null) {
    throw new Error("clip_composition_scene_input_index_missing");
  }
  const sceneInputs = uniqueLayers.map((layer, index) => {
    const asset = input.resolvedSceneAssets?.[layer.sourceRef!];
    if (!asset || asset.kind !== layer.content.kind) {
      throw new Error("clip_composition_scene_input_missing");
    }
    return { ...asset, sourceRef: layer.sourceRef!, inputIndex: input.sceneInputStartIndex! + index };
  });
  let cursor = 0;
  for (const scene of target.scenes) {
    if (
      Math.abs(scene.startSec - cursor) > SCENE_CONTINUITY_EPSILON_SEC ||
      scene.endSec <= scene.startSec
    ) {
      throw new Error("invalid_clip_composition_scenes");
    }
    cursor = scene.endSec;
  }
  if (
    Math.abs(cursor - input.plan.editedDurationSec) >
    SCENE_CONTINUITY_EPSILON_SEC
  ) {
    throw new Error("invalid_clip_composition_scenes");
  }

  const sourceFragments = target.scenes.filter((scene) => scene.sourceRange);
  if (sourceFragments.length === 0) throw new Error("invalid_clip_composition_source_scenes");
  const sourceLabels = sourceFragments.map((_, index) => `[composition_source_fragment_${index}]`);
  const parts: string[] = [];
  if (sourceLabels.length > 1) {
    parts.push(`${input.baseVideoLabel}split=${sourceLabels.length}${sourceLabels.join("")}`);
  }
  let sourceIndex = 0;
  const outputs: string[] = [];
  const fps = input.fps && input.fps > 0 ? input.fps : 30;
  target.scenes.forEach((scene, sceneIndex) => {
    const output = `[composition_insert_sequence_${sceneIndex}]`;
    outputs.push(output);
    const duration = scene.endSec - scene.startSec;
    const inserted = scene.layers.find(
      (layer): layer is CompositionInsertedSceneLayer => layer.kind === "inserted-scene",
    );
    if (!inserted) {
      const source = sourceLabels.length === 1 ? input.baseVideoLabel : sourceLabels[sourceIndex]!;
      sourceIndex += 1;
      parts.push(`${source}trim=start=${scene.sourceRange!.startSec.toFixed(3)}:end=${scene.sourceRange!.endSec.toFixed(3)},setpts=PTS-STARTPTS,setsar=1${output}`);
      return;
    }
    const color = inserted.content.kind === "color"
      ? inserted.content.color
      : inserted.content.backgroundColor;
    const motionFilters = compositionMotionFilters({
      motion: inserted.motion,
      width: target.canvas.width,
      height: target.canvas.height,
      backgroundColor: color,
      timeOffsetSec: inserted.motion?.activeRange.startSec ?? scene.startSec,
    });
    if (inserted.content.kind === "color") {
      if (inserted.textRender !== null) {
        throw new Error("invalid_clip_composition_scene_text");
      }
      parts.push(`color=c=0x${color.slice(1)}:s=${target.canvas.width}x${target.canvas.height}:r=${fps}:d=${duration.toFixed(3)},format=yuv420p${motionFilters}${output}`);
      return;
    }
    if (inserted.content.kind === "text") {
      assertCompositionSceneTextRender(inserted.textRender, target.canvas);
      const textContent = inserted.content;
      const textRender = inserted.textRender;
      const fontSelector = textContent.fontAsset
        ? (() => {
            const fontPath = input.resolvedSceneFonts?.[
              compositionAssetRef(
                "brand_font",
                `${textContent.fontAsset.id}:${textContent.fontAsset.fingerprint}`,
              )
            ];
            if (!fontPath) throw new Error("clip_composition_scene_font_missing");
            return `fontfile='${escapeDrawtextValue(fontPath)}'`;
          })()
        : `font='${escapeDrawtextValue(textContent.fontFamily)}'`;
      const textBlockHeightPx =
        textRender.lines.length * textRender.lineHeightPx;
      const drawTextFilters = textRender.lines.map((line, index) =>
        `drawtext=${fontSelector}:text=${escapeDrawtextText(line)}` +
          `:fontcolor=0x${textContent.color.slice(1)}` +
          `:fontsize=${textRender.fontSizePx}` +
          ":x=(w-text_w)/2" +
          `:y=(h-${textBlockHeightPx})/2+${index * textRender.lineHeightPx}` +
          `+(${textRender.lineHeightPx}-text_h)/2`,
      ).join(",");
      parts.push(
        `color=c=0x${color.slice(1)}:s=${target.canvas.width}x${target.canvas.height}:r=${fps}:d=${duration.toFixed(3)},` +
          `${drawTextFilters},format=yuv420p${motionFilters}${output}`,
      );
      return;
    }
    if (inserted.textRender !== null) {
      throw new Error("invalid_clip_composition_scene_text");
    }
    const asset = sceneInputs.find((candidate) => candidate.sourceRef === inserted.sourceRef);
    if (!asset) throw new Error("clip_composition_scene_input_missing");
    const fit = inserted.content.fit === "cover"
      ? `scale=${target.canvas.width}:${target.canvas.height}:force_original_aspect_ratio=increase,crop=${target.canvas.width}:${target.canvas.height}`
      : `scale=${target.canvas.width}:${target.canvas.height}:force_original_aspect_ratio=decrease,pad=${target.canvas.width}:${target.canvas.height}:(ow-iw)/2:(oh-ih)/2:color=0x${inserted.content.backgroundColor.slice(1)}`;
    const trim = inserted.content.kind === "video"
      ? `trim=start=${inserted.content.sourceStartSec.toFixed(3)}:end=${inserted.content.sourceEndSec.toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)},trim=duration=${duration.toFixed(3)}`
      : `trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS`;
    parts.push(`[${asset.inputIndex}:v]${trim},${fit},setsar=1,format=yuv420p${motionFilters}${output}`);
  });
  const trailingSuffix = input.trailingChain ? `,${input.trailingChain}` : "";
  parts.push(`${outputs.join("")}concat=n=${outputs.length}:v=1:a=0,format=yuv420p${trailingSuffix}${input.outputLabel}`);
  return { filterParts: parts, sceneInputs };
}

export function compileCompositionPlanVideo(input: {
  plan: ClipCompositionPlan;
  targetId: string;
  videoInputLabel: string;
  outputLabel: string;
  trailingChain?: string;
  backgroundImageInputIndex?: number | null;
  fps?: number;
  resolvedBrollAssets?: Readonly<Record<string, string>>;
  brollInputStartIndex?: number;
  resolvedSceneAssets?: Readonly<Record<string, { path: string; kind: "image" | "video" }>>;
  resolvedSceneFonts?: Readonly<Record<string, string>>;
  sceneInputStartIndex?: number;
}): {
  filterParts: string[];
  backgroundImageInputRequired: boolean;
  brollInputs: Array<{
    sourceRef: string;
    path: string;
    inputIndex: number;
    startSec: number;
    endSec: number;
    kind: "image" | "video";
    motion: CompositionMotionPlan | null;
  }>;
  sceneInputs: Array<{ sourceRef: string; path: string; kind: "image" | "video"; inputIndex: number }>;
} {
  if (input.plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const plannedTarget = input.plan.targets.find(
    (candidate) => candidate.id === input.targetId,
  );
  if (!plannedTarget) throw new Error("clip_composition_target_missing");
  const insertedLayers = plannedTarget.scenes.flatMap((scene) =>
    scene.layers.filter(
      (layer): layer is CompositionInsertedSceneLayer => layer.kind === "inserted-scene",
    ),
  );
  const uniqueSceneLayers = [...new Map(
    insertedLayers
      .filter((layer) => layer.sourceRef !== null)
      .map((layer) => [layer.sourceRef!, layer]),
  ).values()];
  if (uniqueSceneLayers.length > 0 && input.sceneInputStartIndex == null) {
    throw new Error("clip_composition_scene_input_index_missing");
  }
  const sceneInputs = uniqueSceneLayers.map((layer, index) => {
    const asset = input.resolvedSceneAssets?.[layer.sourceRef!];
    if (!asset || asset.kind !== layer.content.kind) {
      throw new Error("clip_composition_scene_input_missing");
    }
    return { ...asset, sourceRef: layer.sourceRef!, inputIndex: input.sceneInputStartIndex! + index };
  });

  if (insertedLayers.length > 0) {
    let cursor = 0;
    for (const scene of plannedTarget.scenes) {
      if (
        Math.abs(scene.startSec - cursor) > SCENE_CONTINUITY_EPSILON_SEC ||
        scene.endSec <= scene.startSec
      ) {
        throw new Error("invalid_clip_composition_scenes");
      }
      cursor = scene.endSec;
    }
    if (
      Math.abs(cursor - input.plan.editedDurationSec) >
      SCENE_CONTINUITY_EPSILON_SEC
    ) {
      throw new Error("invalid_clip_composition_scenes");
    }
    const sourceScenes = plannedTarget.scenes
      .filter((scene) => scene.sourceRange)
      .map((scene) => ({
        ...scene,
        startSec: scene.sourceRange!.startSec,
        endSec: scene.sourceRange!.endSec,
        sourceRange: undefined,
      }));
    const sourceDurationSec = sourceScenes.reduce((max, scene) => Math.max(max, scene.endSec), 0);
    if (sourceScenes.length === 0 || sourceDurationSec <= 0) {
      throw new Error("invalid_clip_composition_source_scenes");
    }
    const brollRanges = new Map<string, { startSec: number; endSec: number }>();
    for (const scene of sourceScenes) {
      for (const layer of scene.layers) {
        if (layer.kind !== "broll-video" && layer.kind !== "broll-image") continue;
        const current = brollRanges.get(layer.id);
        brollRanges.set(layer.id, {
          startSec: Math.min(current?.startSec ?? scene.startSec, scene.startSec),
          endSec: Math.max(current?.endSec ?? scene.endSec, scene.endSec),
        });
      }
    }
    const normalizedSourceScenes = sourceScenes.map((scene) => ({
      ...scene,
      layers: scene.layers.map((layer) =>
        layer.kind === "broll-video" || layer.kind === "broll-image"
          ? (() => {
              const activeRange = brollRanges.get(layer.id)!;
              const delta = activeRange.startSec - layer.activeRange.startSec;
              const shiftRange = (range: { startSec: number; endSec: number }) => ({
                startSec: range.startSec + delta,
                endSec: range.endSec + delta,
              });
              return {
                ...layer,
                activeRange,
                motion: layer.motion
                  ? {
                      ...layer.motion,
                      activeRange,
                      entrance: layer.motion.entrance
                        ? { ...layer.motion.entrance, range: shiftRange(layer.motion.entrance.range) }
                        : null,
                      exit: layer.motion.exit
                        ? { ...layer.motion.exit, range: shiftRange(layer.motion.exit.range) }
                        : null,
                    }
                  : null,
              };
            })()
          : layer,
      ),
    }));
    const sourcePlan: ClipCompositionPlan = {
      ...input.plan,
      editedDurationSec: sourceDurationSec,
      targets: input.plan.targets.map((target) =>
        target.id === plannedTarget.id
          ? { ...target, scenes: normalizedSourceScenes }
          : target,
      ),
    };
    const base = compileCompositionPlanVideo({
      ...input,
      plan: sourcePlan,
      outputLabel: "[composition_without_insertions]",
      trailingChain: undefined,
      resolvedSceneAssets: undefined,
      sceneInputStartIndex: undefined,
    });
    const sequence = compileCompositionPlanInsertedSceneSequence({
      plan: input.plan,
      targetId: input.targetId,
      baseVideoLabel: "[composition_without_insertions]",
      outputLabel: input.outputLabel,
      trailingChain: input.trailingChain,
      fps: input.fps,
      resolvedSceneAssets: input.resolvedSceneAssets,
      resolvedSceneFonts: input.resolvedSceneFonts,
      sceneInputStartIndex: input.sceneInputStartIndex,
    });
    return {
      filterParts: [...base.filterParts, ...sequence.filterParts],
      backgroundImageInputRequired: base.backgroundImageInputRequired,
      brollInputs: base.brollInputs,
      sceneInputs: sequence.sceneInputs,
    };
  }
  const brollPlacements = plannedCompositionBrollPlacements(
    input.plan,
    input.targetId,
  );
  if (brollPlacements.length > 0 && input.brollInputStartIndex == null) {
    throw new Error("clip_composition_broll_input_index_missing");
  }
  const brollInputs = brollPlacements.map((placement, index) => {
    const path = input.resolvedBrollAssets?.[placement.sourceRef];
    if (!path) throw new Error("clip_composition_broll_input_missing");
    return {
      sourceRef: placement.sourceRef,
      path,
      inputIndex: input.brollInputStartIndex! + index,
      startSec: placement.startSec,
      endSec: placement.endSec,
      kind: placement.kind,
      motion: placement.motion,
    };
  });
  const baseOutputLabel =
    brollInputs.length > 0 ? "[composition_base]" : input.outputLabel;
  const trailingSuffix = input.trailingChain ? `,${input.trailingChain}` : "";
  const baseSuffix = brollInputs.length === 0 ? trailingSuffix : "";
  const finalize = (result: {
    filterParts: string[];
    backgroundImageInputRequired: boolean;
  }) => {
    if (brollInputs.length === 0) {
      return { ...result, brollInputs, sceneInputs };
    }
    let current = baseOutputLabel;
    brollInputs.forEach((asset, index) => {
      const layer = `[composition_broll_${index}]`;
      const next =
        index === brollInputs.length - 1
          ? input.outputLabel
          : `[composition_broll_stage_${index}]`;
      result.filterParts.push(
        `[${asset.inputIndex}:v]scale=${plannedTarget.canvas.width}:${plannedTarget.canvas.height}:` +
          `force_original_aspect_ratio=increase,crop=${plannedTarget.canvas.width}:` +
          `${plannedTarget.canvas.height},format=rgba` +
          compositionMotionFilters({
            motion: asset.motion,
            width: plannedTarget.canvas.width,
            height: plannedTarget.canvas.height,
            backgroundColor: "#000000",
            timeOffsetSec: asset.startSec,
            alpha: true,
          }) +
          `,setpts=PTS-STARTPTS+${asset.startSec}/TB${layer}`,
        `${current}${layer}overlay=0:0:enable='between(t,${asset.startSec},${asset.endSec})'` +
          `${index === brollInputs.length - 1 ? trailingSuffix : ""}${next}`,
      );
      current = next;
    });
    return { ...result, brollInputs, sceneInputs };
  };
  const target = baseOnlyTarget(plannedTarget);
  if (
    target.effectiveMode === "auto" ||
    target.effectiveMode === "split" ||
    target.effectiveMode === "screen"
  ) {
    if (target.scenes.length === 0) {
      throw new Error("invalid_clip_composition_scenes");
    }
    const parts: string[] = [];
    const sceneInputs = target.scenes.map((_, index) =>
      target.scenes.length === 1
        ? input.videoInputLabel
        : `[composition_scene_${index}_src]`,
    );
    if (target.scenes.length > 1) {
      parts.push(
        `${input.videoInputLabel}split=${target.scenes.length}${sceneInputs.join("")}`,
      );
    }
    let cursor = 0;
    const sceneOutputs: string[] = [];
    target.scenes.forEach((scene, sceneIndex) => {
      if (
        Math.abs(scene.startSec - cursor) > SCENE_CONTINUITY_EPSILON_SEC ||
        scene.endSec <= scene.startSec ||
        (sceneIndex === target.scenes.length - 1 &&
          Math.abs(scene.endSec - input.plan.editedDurationSec) >
            SCENE_CONTINUITY_EPSILON_SEC)
      ) {
        throw new Error("invalid_clip_composition_scenes");
      }
      cursor = scene.endSec;
      const trimLabel = `[composition_scene_${sceneIndex}_trim]`;
      const sceneOutput = `[composition_scene_${sceneIndex}]`;
      sceneOutputs.push(sceneOutput);
      parts.push(
        `${sceneInputs[sceneIndex]}trim=start=${scene.startSec.toFixed(3)}:` +
          `end=${scene.endSec.toFixed(3)},setpts=PTS-STARTPTS${trimLabel}`,
      );
      const layers = [...scene.layers]
        .filter((layer) => layer.kind === "source-video")
        .sort((left, right) => left.zIndex - right.zIndex);
      if (layers.length === 0 || layers.length > 2) {
        throw new Error("invalid_clip_composition_layers");
      }
      for (const layer of layers) {
        if (layer.sourceRef !== input.plan.source.ref) {
          throw new Error("invalid_clip_composition_source_ref");
        }
        assertRect(
          layer.sourceCrop,
          input.plan.source,
          "invalid_clip_composition_source_crop",
        );
        assertRect(
          layer.destination,
          target.canvas,
          "invalid_clip_composition_destination",
        );
      }

      const isFullCanvasSingle =
        layers.length === 1 &&
        layers[0]!.destination.x === 0 &&
        layers[0]!.destination.y === 0 &&
        layers[0]!.destination.width === target.canvas.width &&
        layers[0]!.destination.height === target.canvas.height &&
        Math.abs(layers[0]!.rotationDeg) < 0.01;
      if (isFullCanvasSingle) {
        const layer = layers[0]!;
        const crop = layer.sourceCrop;
        parts.push(
          `${trimLabel}crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` +
            `scale=${target.canvas.width}:${target.canvas.height},setsar=1,` +
            `format=yuv420p${sceneOutput}`,
        );
        return;
      }

      const isExactStack =
        layers.length === 2 &&
        layers.every(
          (layer) =>
            layer.destination.x === 0 &&
            layer.destination.width === target.canvas.width &&
            Math.abs(layer.rotationDeg) < 0.01,
        ) &&
        layers[0]!.destination.y === 0 &&
        layers[1]!.destination.y === layers[0]!.destination.height &&
        layers[0]!.destination.height + layers[1]!.destination.height ===
          target.canvas.height;
      if (isExactStack) {
        const sourceLabels = layers.map(
          (_, layerIndex) =>
            `[composition_scene_${sceneIndex}_layer_${layerIndex}_src]`,
        );
        const outputLabels = layers.map(
          (_, layerIndex) => `[composition_scene_${sceneIndex}_layer_${layerIndex}]`,
        );
        parts.push(`${trimLabel}split=2${sourceLabels.join("")}`);
        layers.forEach((layer, layerIndex) => {
          const crop = layer.sourceCrop;
          const isFullSource =
            crop.x === 0 &&
            crop.y === 0 &&
            crop.width === input.plan.source.width &&
            crop.height === input.plan.source.height;
          const cropPrefix = isFullSource
            ? ""
            : `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},`;
          const scale =
            layer.fit === "contain"
              ? `scale=${layer.destination.width}:${layer.destination.height}:` +
                "force_original_aspect_ratio=decrease," +
                `pad=${layer.destination.width}:${layer.destination.height}:` +
                "(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
              : `scale=${layer.destination.width}:${layer.destination.height}`;
          parts.push(
            `${sourceLabels[layerIndex]}${cropPrefix}${scale}${outputLabels[layerIndex]}`,
          );
        });
        parts.push(
          `${outputLabels.join("")}vstack=inputs=2,setsar=1,format=yuv420p${sceneOutput}`,
        );
        return;
      }

      const baseSource = `[composition_scene_${sceneIndex}_base_src]`;
      const layerSources = layers.map(
        (_, layerIndex) =>
          `[composition_scene_${sceneIndex}_layer_${layerIndex}_src]`,
      );
      let composite = `[composition_scene_${sceneIndex}_base]`;
      parts.push(
        `${trimLabel}split=${layers.length + 1}${baseSource}${layerSources.join("")}`,
        `${baseSource}scale=${target.canvas.width}:${target.canvas.height},` +
          `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill${composite}`,
      );
      layers.forEach((layer, layerIndex) => {
        const crop = layer.sourceCrop;
        const layerOutput = `[composition_scene_${sceneIndex}_layer_${layerIndex}]`;
        const rotated = Math.abs(layer.rotationDeg) >= 0.01;
        const rotation = rotated
          ? `,format=rgba,rotate=${layer.rotationDeg.toFixed(3)}*PI/180:` +
            "ow=rotw(iw):oh=roth(ih):c=black@0"
          : "";
        parts.push(
          `${layerSources[layerIndex]}crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` +
            `scale=${layer.destination.width}:${layer.destination.height}${rotation}${layerOutput}`,
        );
        const next =
          layerIndex === layers.length - 1
            ? sceneOutput
            : `[composition_scene_${sceneIndex}_composite_${layerIndex}]`;
        const final =
          layerIndex === layers.length - 1 ? ",setsar=1,format=yuv420p" : "";
        const overlayX = rotated
          ? `${layer.destination.x}+(${layer.destination.width}-overlay_w)/2`
          : String(layer.destination.x);
        const overlayY = rotated
          ? `${layer.destination.y}+(${layer.destination.height}-overlay_h)/2`
          : String(layer.destination.y);
        parts.push(
          `${composite}${layerOutput}overlay=${overlayX}:${overlayY}:` +
            `shortest=1:format=auto${final}${next}`,
        );
        composite = next;
      });
    });

    if (sceneOutputs.length === 1) {
      parts.push(`${sceneOutputs[0]}format=yuv420p${baseSuffix}${baseOutputLabel}`);
    } else {
      parts.push(
        `${sceneOutputs.join("")}concat=n=${sceneOutputs.length}:v=1:a=0,` +
          `format=yuv420p${baseSuffix}${baseOutputLabel}`,
      );
    }
    return finalize({ filterParts: parts, backgroundImageInputRequired: false });
  }
  if (target.scenes.length !== 1) {
    throw new Error("unsupported_clip_composition_target");
  }
  const scene = target.scenes[0]!;
  const sourceLayer = scene.layers.find(
    (layer) => layer.kind === "source-video",
  );
  if (!sourceLayer) {
    throw new Error("invalid_clip_composition_layers");
  }
  if (sourceLayer.sourceRef !== input.plan.source.ref) {
    throw new Error("invalid_clip_composition_source_ref");
  }
  assertRect(
    sourceLayer.sourceCrop,
    input.plan.source,
    "invalid_clip_composition_source_crop",
  );
  assertRect(
    sourceLayer.destination,
    target.canvas,
    "invalid_clip_composition_destination",
  );
  const crop = sourceLayer.sourceCrop;
  if (target.effectiveMode === "fit") {
    const backgroundLayer = scene.layers.find(
      (layer) => layer.kind === "background",
    );
    if (!backgroundLayer || scene.layers.length !== 2) {
      throw new Error("invalid_clip_composition_layers");
    }
    assertRect(
      backgroundLayer.destination,
      target.canvas,
      "invalid_clip_composition_destination",
    );
    const sourceChain =
      `${input.videoInputLabel}crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` +
      `scale=${sourceLayer.destination.width}:${sourceLayer.destination.height}`;
    if (backgroundLayer.imageRef) {
      if (input.backgroundImageInputIndex == null) {
        throw new Error("clip_composition_background_input_missing");
      }
      const fps = input.fps && input.fps > 0 ? input.fps : 30;
      return finalize({
        filterParts: [
          `[${input.backgroundImageInputIndex}:v]scale=${target.canvas.width}:${target.canvas.height}:` +
            `force_original_aspect_ratio=increase,crop=${target.canvas.width}:${target.canvas.height},` +
            `fps=${fps}[composition_bg]`,
          `${sourceChain}[composition_source]`,
          `[composition_bg][composition_source]overlay=${sourceLayer.destination.x}:` +
            `${sourceLayer.destination.y},format=yuv420p${baseSuffix}${baseOutputLabel}`,
        ],
        backgroundImageInputRequired: true,
      });
    }
    return finalize({
      filterParts: [
        `${sourceChain},pad=${target.canvas.width}:${target.canvas.height}:` +
          `${sourceLayer.destination.x}:${sourceLayer.destination.y}:` +
          `color=${backgroundLayer.color.replace("#", "0x")},` +
          `format=yuv420p${baseSuffix}${baseOutputLabel}`,
      ],
      backgroundImageInputRequired: false,
    });
  }
  if (target.effectiveMode !== "center" || scene.layers.length !== 1) {
    throw new Error("unsupported_clip_composition_target");
  }
  if (
    sourceLayer.destination.x !== 0 ||
    sourceLayer.destination.y !== 0 ||
    sourceLayer.destination.width !== target.canvas.width ||
    sourceLayer.destination.height !== target.canvas.height
  ) {
    throw new Error("unsupported_clip_composition_destination");
  }
  if (
    crop.x !== Math.max(0, Math.round((input.plan.source.width - crop.width) / 2)) ||
    crop.y !== Math.max(0, Math.round((input.plan.source.height - crop.height) / 2))
  ) {
    throw new Error("unsupported_clip_composition_center_crop");
  }
  return finalize({
    filterParts: [
      `${input.videoInputLabel}crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` +
        `scale=${target.canvas.width}:${target.canvas.height},format=yuv420p${baseSuffix}${baseOutputLabel}`,
    ],
    backgroundImageInputRequired: false,
  });
}
