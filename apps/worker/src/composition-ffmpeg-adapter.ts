import {
  CLIP_COMPOSITION_PLAN_VERSION,
  type ClipCompositionPlan,
  type CompositionBrollVideoLayer,
  type CompositionRect,
  type CompositionTargetPlan,
  type CompositionVisualLayer,
} from "@narriflow/composition-plan";

export function compileCompositionPlanAudiogram(
  plan: ClipCompositionPlan,
  targetId: string,
) {
  if (plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const target = plan.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("clip_composition_target_missing");
  if (target.effectiveMode !== "audiogram" || target.scenes.length !== 1) {
    throw new Error("clip_composition_audiogram_missing");
  }
  const scene = target.scenes[0]!;
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
  return {
    scheduleFingerprint: schedule.fingerprint,
    source: {
      available: schedule.source.available,
      gain: schedule.source.gain,
      muted: schedule.source.muted,
    },
    music: music
      ? {
          sourceRef: music.sourceRef,
          gain: music.gain,
          startOffsetSec: music.startOffsetSec,
          loop: music.loop,
          fadeInSec: music.fades.fadeIn.endSec - music.fades.fadeIn.startSec,
          fadeOutSec:
            music.fades.fadeOut.endSec - music.fades.fadeOut.startSec,
          duckingWindows: music.ducking.enabled
            ? [...music.ducking.windows]
            : [],
        }
      : null,
    soundEffects: schedule.soundEffects.map((effect) => ({
      id: effect.id,
      sourceRef: effect.sourceRef,
      startSec: effect.activeRange.startSec,
      endSec: effect.activeRange.endSec,
      gain: effect.gain,
    })),
  };
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
      layer.activeRange.endSec > input.plan.editedDurationSec + 0.075
    ) {
      throw new Error("invalid_clip_composition_visual_layers");
    }
    if (layer.kind === "transition") {
      const { fadeIn, fadeOut } = layer.windows;
      const validWindow = (window: typeof fadeIn) =>
        window.startSec >= layer.activeRange.startSec &&
        window.endSec > window.startSec &&
        window.endSec <= layer.activeRange.endSec &&
        window.endSec <= input.plan.editedDurationSec;
      if (
        !validWindow(fadeIn) ||
        !validWindow(fadeOut) ||
        fadeIn.endSec > fadeOut.startSec
      ) {
        throw new Error("invalid_clip_composition_transition_windows");
      }
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
        const duration = layer.windows.fadeIn.endSec - layer.windows.fadeIn.startSec;
        return {
          parts: [
            `${source}fade=t=in:st=${layer.windows.fadeIn.startSec.toFixed(3)}:d=${duration.toFixed(3)}:color=${layer.color},` +
              `fade=t=out:st=${layer.windows.fadeOut.startSec.toFixed(3)}:d=${(layer.windows.fadeOut.endSec - layer.windows.fadeOut.startSec).toFixed(3)}:color=${layer.color}${output}`,
          ],
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
      Math.abs(previous.endSec - scene.startSec) <= 0.075 &&
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
}> {
  if (plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const target = plan.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("clip_composition_target_missing");

  const fragments = new Map<
    string,
    { layer: CompositionBrollVideoLayer; ranges: Array<[number, number]> }
  >();
  for (const scene of target.scenes) {
    const active = scene.layers.filter(
      (layer): layer is CompositionBrollVideoLayer =>
        layer.kind === "broll-video",
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
        layer.audio !== "source" ||
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
        if (Math.abs(startSec - cursor) > 0.075) {
          throw new Error("invalid_clip_composition_broll_layer");
        }
        cursor = endSec;
      }
      if (Math.abs(cursor - layer.activeRange.endSec) > 0.075) {
        throw new Error("invalid_clip_composition_broll_layer");
      }
      return {
        id: layer.id,
        sourceRef: layer.sourceRef,
        startSec: layer.activeRange.startSec,
        endSec: layer.activeRange.endSec,
        audio: layer.audio,
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
}): {
  filterParts: string[];
  backgroundImageInputRequired: boolean;
  brollInputs: Array<{
    sourceRef: string;
    path: string;
    inputIndex: number;
    startSec: number;
    endSec: number;
  }>;
} {
  if (input.plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const plannedTarget = input.plan.targets.find(
    (candidate) => candidate.id === input.targetId,
  );
  if (!plannedTarget) throw new Error("clip_composition_target_missing");
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
      return { ...result, brollInputs };
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
          `${plannedTarget.canvas.height},setpts=PTS-STARTPTS+${asset.startSec}/TB,` +
          `format=yuv420p${layer}`,
        `${current}${layer}overlay=0:0:enable='between(t,${asset.startSec},${asset.endSec})'` +
          `${index === brollInputs.length - 1 ? trailingSuffix : ""}${next}`,
      );
      current = next;
    });
    return { ...result, brollInputs };
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
        Math.abs(scene.startSec - cursor) > 0.075 ||
        scene.endSec <= scene.startSec ||
        (sceneIndex === target.scenes.length - 1 &&
          Math.abs(scene.endSec - input.plan.editedDurationSec) > 0.075)
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
