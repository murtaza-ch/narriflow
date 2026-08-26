import {
  CLIP_COMPOSITION_PLAN_VERSION,
  type ClipCompositionPlan,
  type CompositionBrollVideoLayer,
  type CompositionRect,
  type CompositionTargetPlan,
} from "@narriflow/composition-plan";

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
