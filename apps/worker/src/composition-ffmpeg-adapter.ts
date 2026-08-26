import {
  CLIP_COMPOSITION_PLAN_VERSION,
  type ClipCompositionPlan,
  type CompositionRect,
} from "@narriflow/composition-plan";

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
}): {
  filterParts: string[];
  backgroundImageInputRequired: boolean;
} {
  if (input.plan.version !== CLIP_COMPOSITION_PLAN_VERSION) {
    throw new Error("unsupported_clip_composition_plan_version");
  }
  const target = input.plan.targets.find(
    (candidate) => candidate.id === input.targetId,
  );
  if (!target) throw new Error("clip_composition_target_missing");
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

    const suffix = input.trailingChain ? `,${input.trailingChain}` : "";
    if (sceneOutputs.length === 1) {
      parts.push(`${sceneOutputs[0]}format=yuv420p${suffix}${input.outputLabel}`);
    } else {
      parts.push(
        `${sceneOutputs.join("")}concat=n=${sceneOutputs.length}:v=1:a=0,` +
          `format=yuv420p${suffix}${input.outputLabel}`,
      );
    }
    return { filterParts: parts, backgroundImageInputRequired: false };
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
  const suffix = input.trailingChain ? `,${input.trailingChain}` : "";
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
      return {
        filterParts: [
          `[${input.backgroundImageInputIndex}:v]scale=${target.canvas.width}:${target.canvas.height}:` +
            `force_original_aspect_ratio=increase,crop=${target.canvas.width}:${target.canvas.height},` +
            `fps=${fps}[composition_bg]`,
          `${sourceChain}[composition_source]`,
          `[composition_bg][composition_source]overlay=${sourceLayer.destination.x}:` +
            `${sourceLayer.destination.y},format=yuv420p${suffix}${input.outputLabel}`,
        ],
        backgroundImageInputRequired: true,
      };
    }
    return {
      filterParts: [
        `${sourceChain},pad=${target.canvas.width}:${target.canvas.height}:` +
          `${sourceLayer.destination.x}:${sourceLayer.destination.y}:` +
          `color=${backgroundLayer.color.replace("#", "0x")},` +
          `format=yuv420p${suffix}${input.outputLabel}`,
      ],
      backgroundImageInputRequired: false,
    };
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
  // Center plans always carry the resolved x/y for preview parity, while the
  // established FFmpeg command intentionally leaves x/y at crop's centered
  // defaults. Keeping that spelling preserves byte-for-byte output during
  // the Center cutover; the adapter is not choosing geometry here.
  return {
    filterParts: [
      `${input.videoInputLabel}crop=${crop.width}:${crop.height},` +
        `scale=${target.canvas.width}:${target.canvas.height},format=yuv420p${suffix}${input.outputLabel}`,
    ],
    backgroundImageInputRequired: false,
  };
}
