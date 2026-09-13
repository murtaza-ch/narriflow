import { z } from "zod";
import type { ClipAspectRatio } from "./clip";

export const SCENE_LAYOUT_MIN_DURATION_SEC = 0.075;

export const SCENE_LAYOUT_PRESETS = [
  "auto",
  "full",
  "fit",
  "center",
  "stacked",
  "side-by-side",
  "screen-top",
  "screen-bottom",
  "inset",
  "speaker-top",
  "speaker-bottom",
  "screen-top-two",
  "screen-bottom-two",
  "speakers-top",
  "speakers-bottom",
  "screen-top-circle",
  "screen-bottom-circle",
  "speaker-top-circle",
  "speaker-bottom-circle",
  "screen-top-two-circle",
  "screen-bottom-two-circle",
  "speakers-top-circle",
  "speakers-bottom-circle",
  "inset-left",
  "inset-rounded",
  "inset-rounded-left",
  "source-speaker-cards",
  "source-top-card",
  "source-bottom-card",
  "speaker-top-card",
  "speaker-bottom-card",
  "source-top-two-cards",
  "source-bottom-two-cards",
  "speakers-top-cards",
  "speakers-bottom-cards",
  "screen-top-rounded",
  "screen-bottom-rounded",
  "speaker-top-rounded",
  "speaker-bottom-rounded",
  "screen-top-two-rounded",
  "screen-bottom-two-rounded",
  "speakers-top-rounded",
  "speakers-bottom-rounded",
  "speaker-fit-large",
  "speaker-fit-small",
  "three-top",
  "three-bottom",
  "four-grid",
  "four-grid-padded",
  "fit-small",
] as const;

export const sceneLayoutPresetSchema = z.enum(SCENE_LAYOUT_PRESETS);

export const studioSceneLayoutSelectionSchema = z
  .strictObject({
    id: z.string().min(1).max(100),
    aspectRatio: z.enum(["9:16", "1:1", "16:9", "4:5"]),
    startSec: z.number().finite().min(0),
    endSec: z.number().finite().gt(0),
    preset: sceneLayoutPresetSchema,
  })
  .refine(
    (selection) =>
      selection.endSec - selection.startSec >= SCENE_LAYOUT_MIN_DURATION_SEC,
    {
      path: ["endSec"],
      message: `scene layouts must be at least ${SCENE_LAYOUT_MIN_DURATION_SEC} seconds`,
    },
  );

export const studioSceneLayoutSelectionsSchema = z
  .array(studioSceneLayoutSelectionSchema)
  .max(64)
  .superRefine((selections, context) => {
    if (new Set(selections.map((selection) => selection.id)).size !== selections.length) {
      context.addIssue({ code: "custom", message: "scene layout ids must be unique" });
    }
    const ordered = [...selections].sort(
      (left, right) =>
        left.aspectRatio.localeCompare(right.aspectRatio) ||
        left.startSec - right.startSec ||
        left.endSec - right.endSec,
    );
    ordered.forEach((selection, index) => {
      const previous = ordered[index - 1];
      if (
        previous?.aspectRatio === selection.aspectRatio &&
        selection.startSec < previous.endSec
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "startSec"],
          message: "scene layout windows cannot overlap for one aspect ratio",
        });
      }
    });
  })
  .default([]);

export type SceneLayoutPreset = z.infer<typeof sceneLayoutPresetSchema>;
export type StudioSceneLayoutSelection = z.infer<
  typeof studioSceneLayoutSelectionSchema
>;

export function sceneLayoutPresetNeedsAutomaticEvidence(
  preset: SceneLayoutPreset,
): boolean {
  return preset !== "fit" && preset !== "fit-small" && preset !== "center";
}

export function sceneLayoutSelectionAt(
  selections: readonly StudioSceneLayoutSelection[],
  aspectRatio: ClipAspectRatio,
  editedTimeSec: number,
): StudioSceneLayoutSelection | null {
  return (
    selections.find(
      (selection) =>
        selection.aspectRatio === aspectRatio &&
        selection.startSec <= editedTimeSec &&
        editedTimeSec < selection.endSec,
    ) ?? null
  );
}

function fragmentId(
  selection: StudioSceneLayoutSelection,
  side: "left" | "right",
  boundarySec: number,
): string {
  const seed = `${selection.id}:${side}:${boundarySec.toFixed(6)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${selection.id.slice(0, 86)}:${side[0]}:${(hash >>> 0).toString(16)}`;
}

function removeSceneLayoutRange(
  selections: readonly StudioSceneLayoutSelection[],
  range: Pick<StudioSceneLayoutSelection, "aspectRatio" | "startSec" | "endSec">,
): StudioSceneLayoutSelection[] {
  const output: StudioSceneLayoutSelection[] = [];
  for (const selection of selections) {
    if (
      selection.aspectRatio !== range.aspectRatio ||
      selection.endSec <= range.startSec ||
      selection.startSec >= range.endSec
    ) {
      output.push(selection);
      continue;
    }
    if (
      range.startSec - selection.startSec >= SCENE_LAYOUT_MIN_DURATION_SEC
    ) {
      output.push({
        ...selection,
        id: fragmentId(selection, "left", range.startSec),
        endSec: range.startSec,
      });
    }
    if (selection.endSec - range.endSec >= SCENE_LAYOUT_MIN_DURATION_SEC) {
      output.push({
        ...selection,
        id: fragmentId(selection, "right", range.endSec),
        startSec: range.endSec,
      });
    }
  }
  return output.sort(
    (left, right) =>
      left.aspectRatio.localeCompare(right.aspectRatio) ||
      left.startSec - right.startSec ||
      left.endSec - right.endSec,
  );
}

/** Replaces one edited-time range while preserving unaffected remainders. */
export function replaceSceneLayoutSelection(
  selections: readonly StudioSceneLayoutSelection[],
  replacement: StudioSceneLayoutSelection,
): StudioSceneLayoutSelection[] {
  return [
    ...removeSceneLayoutRange(selections, replacement),
    replacement,
  ].sort(
    (left, right) =>
      left.aspectRatio.localeCompare(right.aspectRatio) ||
      left.startSec - right.startSec ||
      left.endSec - right.endSec,
  );
}

/** Removes a selected range so the clip-wide automatic/default layout shows. */
export function removeSceneLayoutSelection(
  selections: readonly StudioSceneLayoutSelection[],
  range: Pick<StudioSceneLayoutSelection, "aspectRatio" | "startSec" | "endSec">,
): StudioSceneLayoutSelection[] {
  return removeSceneLayoutRange(selections, range);
}

export function sceneLayoutSelectionsEqual(
  left: readonly StudioSceneLayoutSelection[],
  right: readonly StudioSceneLayoutSelection[],
): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}
