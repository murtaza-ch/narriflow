import type { SceneLayoutPreset } from "@narriflow/validators";

export interface SceneLayoutNormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type SceneLayoutLayerMask =
  | { readonly kind: "circle" }
  | { readonly kind: "rounded"; readonly radiusPx: number };

type SceneLayoutTemplateMask =
  | { readonly kind: "circle" }
  | { readonly kind: "rounded"; readonly radiusRatio: number };

export interface SceneLayoutTemplateLayer {
  readonly kind: "source" | "speaker";
  readonly subjectIndex?: 0 | 1 | 2 | 3;
  readonly frame: SceneLayoutNormalizedRect;
  readonly fit: "cover" | "contain";
  readonly mask?: SceneLayoutTemplateMask;
}

export interface SceneLayoutPresetDefinition {
  readonly id: SceneLayoutPreset;
  readonly label: string;
  readonly category: "automatic" | "speaker-source" | "speaker-only" | "source-only";
  readonly minimumSpeakers: 0 | 1 | 2 | 3 | 4;
  readonly referenceId: number | null;
  readonly showsBackground: boolean;
  readonly template: { readonly layers: readonly SceneLayoutTemplateLayer[] };
}

export interface ResolvedSceneLayoutTemplateLayer {
  readonly kind: "source" | "speaker";
  readonly subjectIndex?: 0 | 1 | 2 | 3;
  readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly fit: "cover" | "contain";
  readonly mask?: SceneLayoutLayerMask;
}

const frame = (
  x: number,
  y: number,
  width: number,
  height: number,
): SceneLayoutNormalizedRect => ({ x, y, width, height });

const source = (
  allocation: SceneLayoutNormalizedRect,
  fit: "cover" | "contain" = "contain",
): SceneLayoutTemplateLayer => ({ kind: "source", frame: allocation, fit });

const speaker = (
  subjectIndex: 0 | 1 | 2 | 3,
  allocation: SceneLayoutNormalizedRect,
  mask?: SceneLayoutTemplateMask,
): SceneLayoutTemplateLayer => ({
  kind: "speaker",
  subjectIndex,
  frame: allocation,
  fit: "cover",
  ...(mask ? { mask } : {}),
});

const rounded = { kind: "rounded", radiusRatio: 0.1 } as const;
const circle = { kind: "circle" } as const;

function splitTemplate(input: {
  sourcePosition: "top" | "bottom";
  sourceShare: number;
  speakers: 1 | 2;
  padding?: number;
  gap?: number;
  mask?: SceneLayoutTemplateMask;
}): { readonly layers: readonly SceneLayoutTemplateLayer[] } {
  const padding = input.padding ?? 0;
  const gap = input.gap ?? 0;
  const usableHeight = 1 - padding * 2 - gap;
  const sourceHeight = usableHeight * input.sourceShare;
  const speakerHeight = usableHeight - sourceHeight;
  const sourceY = input.sourcePosition === "top" ? padding : padding + speakerHeight + gap;
  const speakerY = input.sourcePosition === "top" ? padding + sourceHeight + gap : padding;
  const speakerGap = input.speakers === 2 ? gap : 0;
  const speakerWidth =
    (1 - padding * 2 - speakerGap * (input.speakers - 1)) / input.speakers;
  const layers: SceneLayoutTemplateLayer[] = [
    source(frame(padding, sourceY, 1 - padding * 2, sourceHeight)),
  ];
  for (let index = 0; index < input.speakers; index += 1) {
    layers.push(
      speaker(
        index as 0 | 1,
        frame(
          padding + index * (speakerWidth + speakerGap),
          speakerY,
          speakerWidth,
          speakerHeight,
        ),
        input.mask,
      ),
    );
  }
  return { layers };
}

function speakerGridTemplate(input: {
  frames: readonly SceneLayoutNormalizedRect[];
  mask?: SceneLayoutTemplateMask;
}): { readonly layers: readonly SceneLayoutTemplateLayer[] } {
  return {
    layers: input.frames.map((allocation, index) =>
      speaker(index as 0 | 1 | 2 | 3, allocation, input.mask),
    ),
  };
}

const full = frame(0, 0, 1, 1);

const definition = (
  id: SceneLayoutPreset,
  label: string,
  category: SceneLayoutPresetDefinition["category"],
  minimumSpeakers: SceneLayoutPresetDefinition["minimumSpeakers"],
  referenceId: number | null,
  layers: readonly SceneLayoutTemplateLayer[],
): SceneLayoutPresetDefinition => ({
  id,
  label,
  category,
  minimumSpeakers,
  referenceId,
  showsBackground:
    layers.length > 0 &&
    (layers.some((layer) => layer.fit === "contain" || layer.mask !== undefined) ||
      layers.reduce(
        (area, layer) => area + layer.frame.width * layer.frame.height,
        0,
      ) <
        1 - Number.EPSILON),
  template: { layers },
});

const split = (
  id: SceneLayoutPreset,
  label: string,
  referenceId: number,
  input: Parameters<typeof splitTemplate>[0],
): SceneLayoutPresetDefinition =>
  definition(
    id,
    label,
    "speaker-source",
    input.speakers,
    referenceId,
    splitTemplate(input).layers,
  );

/** Gallery order follows the inspected Vizard 9:16 layout picker. Auto and
 * Center are Narriflow additions that keep their existing persisted IDs. */
export const SCENE_LAYOUT_PRESET_CATALOG: readonly SceneLayoutPresetDefinition[] = [
  definition("auto", "Auto", "automatic", 1, null, []),
  split("screen-bottom", "Source bottom", 153, { sourcePosition: "bottom", sourceShare: 0.64, speakers: 1 }),
  split("screen-top", "Source top", 154, { sourcePosition: "top", sourceShare: 0.64, speakers: 1 }),
  split("speaker-top", "Speaker top", 155, { sourcePosition: "bottom", sourceShare: 0.4, speakers: 1 }),
  split("speaker-bottom", "Speaker bottom", 156, { sourcePosition: "top", sourceShare: 0.4, speakers: 1 }),
  split("screen-bottom-two", "Source bottom, two speakers", 157, { sourcePosition: "bottom", sourceShare: 0.64, speakers: 2, gap: 0.02 }),
  split("screen-top-two", "Source top, two speakers", 158, { sourcePosition: "top", sourceShare: 0.64, speakers: 2, gap: 0.02 }),
  split("speakers-top", "Two speakers top", 159, { sourcePosition: "bottom", sourceShare: 0.4, speakers: 2, gap: 0.02 }),
  split("speakers-bottom", "Two speakers bottom", 160, { sourcePosition: "top", sourceShare: 0.4, speakers: 2, gap: 0.02 }),
  split("screen-bottom-circle", "Source bottom, circle", 161, { sourcePosition: "bottom", sourceShare: 0.64, speakers: 1, padding: 0.03, gap: 0.02, mask: circle }),
  split("screen-top-circle", "Source top, circle", 162, { sourcePosition: "top", sourceShare: 0.64, speakers: 1, padding: 0.03, gap: 0.02, mask: circle }),
  split("speaker-top-circle", "Circle top", 163, { sourcePosition: "bottom", sourceShare: 0.4, speakers: 1, padding: 0.03, gap: 0.02, mask: circle }),
  split("speaker-bottom-circle", "Circle bottom", 164, { sourcePosition: "top", sourceShare: 0.4, speakers: 1, padding: 0.03, gap: 0.02, mask: circle }),
  split("screen-bottom-two-circle", "Source bottom, two circles", 165, { sourcePosition: "bottom", sourceShare: 0.64, speakers: 2, padding: 0.03, gap: 0.02, mask: circle }),
  split("screen-top-two-circle", "Source top, two circles", 166, { sourcePosition: "top", sourceShare: 0.64, speakers: 2, padding: 0.03, gap: 0.02, mask: circle }),
  split("speakers-top-circle", "Two circles top", 167, { sourcePosition: "bottom", sourceShare: 0.4, speakers: 2, padding: 0.03, gap: 0.02, mask: circle }),
  split("speakers-bottom-circle", "Two circles bottom", 168, { sourcePosition: "top", sourceShare: 0.4, speakers: 2, padding: 0.03, gap: 0.02, mask: circle }),
  split("source-speaker-cards", "Source and speaker cards", 277, { sourcePosition: "top", sourceShare: 0.52, speakers: 1, padding: 0.1, gap: 0.06 }),
  split("source-top-card", "Source top card", 169, { sourcePosition: "top", sourceShare: 0.64, speakers: 1, padding: 0.08, gap: 0.04 }),
  split("source-bottom-card", "Source bottom card", 170, { sourcePosition: "bottom", sourceShare: 0.64, speakers: 1, padding: 0.08, gap: 0.04 }),
  split("speaker-top-card", "Speaker top card", 171, { sourcePosition: "bottom", sourceShare: 0.4, speakers: 1, padding: 0.08, gap: 0.04 }),
  split("speaker-bottom-card", "Speaker bottom card", 172, { sourcePosition: "top", sourceShare: 0.4, speakers: 1, padding: 0.08, gap: 0.04 }),
  split("source-top-two-cards", "Source top, two speaker cards", 173, { sourcePosition: "top", sourceShare: 0.64, speakers: 2, padding: 0.08, gap: 0.04 }),
  split("source-bottom-two-cards", "Source bottom, two speaker cards", 174, { sourcePosition: "bottom", sourceShare: 0.64, speakers: 2, padding: 0.08, gap: 0.04 }),
  split("speakers-top-cards", "Two speaker cards top", 175, { sourcePosition: "bottom", sourceShare: 0.4, speakers: 2, padding: 0.08, gap: 0.04 }),
  split("speakers-bottom-cards", "Two speaker cards bottom", 176, { sourcePosition: "top", sourceShare: 0.4, speakers: 2, padding: 0.08, gap: 0.04 }),
  split("screen-top-rounded", "Source top, rounded card", 177, { sourcePosition: "top", sourceShare: 0.64, speakers: 1, padding: 0.04, gap: 0.025, mask: rounded }),
  split("screen-bottom-rounded", "Source bottom, rounded card", 178, { sourcePosition: "bottom", sourceShare: 0.64, speakers: 1, padding: 0.04, gap: 0.025, mask: rounded }),
  split("speaker-top-rounded", "Rounded speaker top", 179, { sourcePosition: "bottom", sourceShare: 0.4, speakers: 1, padding: 0.04, gap: 0.025, mask: rounded }),
  split("speaker-bottom-rounded", "Rounded speaker bottom", 180, { sourcePosition: "top", sourceShare: 0.4, speakers: 1, padding: 0.04, gap: 0.025, mask: rounded }),
  split("screen-top-two-rounded", "Source top, two rounded cards", 181, { sourcePosition: "top", sourceShare: 0.64, speakers: 2, padding: 0.04, gap: 0.025, mask: rounded }),
  split("screen-bottom-two-rounded", "Source bottom, two rounded cards", 182, { sourcePosition: "bottom", sourceShare: 0.64, speakers: 2, padding: 0.04, gap: 0.025, mask: rounded }),
  split("speakers-top-rounded", "Two rounded speakers top", 183, { sourcePosition: "bottom", sourceShare: 0.4, speakers: 2, padding: 0.04, gap: 0.025, mask: rounded }),
  split("speakers-bottom-rounded", "Two rounded speakers bottom", 184, { sourcePosition: "top", sourceShare: 0.4, speakers: 2, padding: 0.04, gap: 0.025, mask: rounded }),
  definition("inset", "Inset right", "speaker-source", 1, null, [source(full), speaker(0, frame(0.62, 0.69, 0.34, 0.27))]),
  definition("inset-left", "Inset left", "speaker-source", 1, null, [source(full), speaker(0, frame(0.04, 0.69, 0.34, 0.27))]),
  definition("inset-rounded", "Rounded inset right", "speaker-source", 1, null, [source(full), speaker(0, frame(0.62, 0.69, 0.34, 0.27), rounded)]),
  definition("inset-rounded-left", "Rounded inset left", "speaker-source", 1, null, [source(full), speaker(0, frame(0.04, 0.69, 0.34, 0.27), rounded)]),
  definition("side-by-side", "Side by side", "speaker-only", 2, null, speakerGridTemplate({ frames: [frame(0, 0, 0.5, 1), frame(0.5, 0, 0.5, 1)] }).layers),
  definition("full", "Full speaker", "speaker-only", 1, 185, [speaker(0, full)]),
  definition("speaker-fit-large", "Fit speaker large", "speaker-only", 1, 186, [speaker(0, frame(0.06, 0.06, 0.88, 0.88))]),
  definition("speaker-fit-small", "Fit speaker small", "speaker-only", 1, 187, [speaker(0, frame(0.14, 0.14, 0.72, 0.72))]),
  definition("stacked", "Stacked", "speaker-only", 2, 188, speakerGridTemplate({ frames: [frame(0, 0, 1, 0.5), frame(0, 0.5, 1, 0.5)] }).layers),
  definition("three-top", "Three, one above", "speaker-only", 3, 274, speakerGridTemplate({ frames: [frame(0, 0, 1, 0.5), frame(0, 0.5, 0.5, 0.5), frame(0.5, 0.5, 0.5, 0.5)] }).layers),
  definition("three-bottom", "Three, one below", "speaker-only", 3, 189, speakerGridTemplate({ frames: [frame(0, 0, 0.5, 0.5), frame(0.5, 0, 0.5, 0.5), frame(0, 0.5, 1, 0.5)] }).layers),
  definition("four-grid", "Four grid", "speaker-only", 4, 279, speakerGridTemplate({ frames: [frame(0, 0, 0.5, 0.5), frame(0.5, 0, 0.5, 0.5), frame(0, 0.5, 0.5, 0.5), frame(0.5, 0.5, 0.5, 0.5)] }).layers),
  definition("four-grid-padded", "Four grid padded", "speaker-only", 4, 190, speakerGridTemplate({ frames: [frame(0.04, 0.04, 0.45, 0.45), frame(0.51, 0.04, 0.45, 0.45), frame(0.04, 0.51, 0.45, 0.45), frame(0.51, 0.51, 0.45, 0.45)], mask: rounded }).layers),
  definition("fit", "Fit source", "source-only", 0, 191, [source(full)]),
  definition("fit-small", "Fit source small", "source-only", 0, 192, [source(frame(0.12, 0.12, 0.76, 0.76))]),
  definition("center", "Center source", "source-only", 0, null, [source(full, "cover")]),
] as const;

export function sceneLayoutPresetDefinition(
  preset: SceneLayoutPreset,
): SceneLayoutPresetDefinition {
  return SCENE_LAYOUT_PRESET_CATALOG.find((definition) => definition.id === preset)!;
}

export function sceneLayoutPresetShowsBackground(
  preset: SceneLayoutPreset,
): boolean {
  return sceneLayoutPresetDefinition(preset).showsBackground;
}

function even(value: number): number {
  return 2 * Math.round(value / 2);
}

/** Resolves the same template used by preview and export. Circle allocations
 * become centered squares, including after target aspect-ratio changes. */
export function resolveSceneLayoutPresetTemplate(
  preset: SceneLayoutPreset,
  canvas: { readonly width: number; readonly height: number },
): readonly ResolvedSceneLayoutTemplateLayer[] {
  return sceneLayoutPresetDefinition(preset).template.layers.map((layer) => {
    let resolvedFrame = {
      x: even(layer.frame.x * canvas.width),
      y: even(layer.frame.y * canvas.height),
      width: Math.max(2, even(layer.frame.width * canvas.width)),
      height: Math.max(2, even(layer.frame.height * canvas.height)),
    };
    if (layer.mask?.kind === "circle") {
      const size = Math.min(resolvedFrame.width, resolvedFrame.height);
      resolvedFrame = {
        x: resolvedFrame.x + even((resolvedFrame.width - size) / 2),
        y: resolvedFrame.y + even((resolvedFrame.height - size) / 2),
        width: size,
        height: size,
      };
    }
    return {
      kind: layer.kind,
      ...(layer.subjectIndex === undefined ? {} : { subjectIndex: layer.subjectIndex }),
      frame: resolvedFrame,
      fit: layer.fit,
      ...(layer.mask?.kind === "circle"
        ? { mask: circle }
        : layer.mask?.kind === "rounded"
          ? {
              mask: {
                kind: "rounded" as const,
                radiusPx: Math.max(
                  2,
                  even(
                    Math.min(resolvedFrame.width, resolvedFrame.height) *
                      layer.mask.radiusRatio,
                  ),
                ),
              },
            }
          : {}),
    };
  });
}
