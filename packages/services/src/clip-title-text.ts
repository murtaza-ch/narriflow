import { STUDIO_EDIT_LIMITS, buildClipCutPlan, cutTitleText, type SourceRange, type StudioEdits, type StudioTextLayer, type TextLayerTitlePatch } from "@narriflow/validators";

/** The shortest title Apply to all clips leaves on a clip, as the editor's own rebase floor. */
const TITLE_MIN_DURATION_SEC = 0.5;

/** A clip's title words: its AI title, else its hook text. Null when neither has usable words. */
export function clipTitleWords(title: string | null | undefined, hookText: string | null | undefined): string | null {
  if (cutTitleText(title ?? "").length > 0) return title!;
  if (cutTitleText(hookText ?? "").length > 0) return hookText!;
  return null;
}

/** The clip's edited duration: its window minus silence and filler cuts, as the render cuts it. */
export function clipEditedDurationSec(window: { startSec: number; endSec: number }, deletedRanges: SourceRange[]): number {
  return buildClipCutPlan(deletedRanges, window).editedDurationSec;
}

/**
 * The patch's timing on a clip `durationSec` long. An interval that fits the clip is kept as is.
 * Otherwise the end comes in to the clip's end and the start leaves at least the minimum before
 * it, so the end is always after the start (for a clip with any duration).
 */
function clampTitleTiming(patch: Pick<TextLayerTitlePatch, "startSec" | "endSec">, durationSec: number): { startSec: number; endSec: number | null } {
  if (patch.startSec < durationSec && (patch.endSec === null || patch.endSec <= durationSec)) return { startSec: patch.startSec, endSec: patch.endSec };
  const endSec = patch.endSec === null ? null : Math.min(patch.endSec, durationSec);
  const startSec = Math.min(patch.startSec, Math.max(0, (endSec ?? durationSec) - TITLE_MIN_DURATION_SEC));
  return { startSec, endSec };
}

/** `restyled` here means the clip had a title layer; the caller counts it only when that layer changed. */
export type TitlePatchOutcome = "restyled" | "created" | "skipped";

/**
 * One clip's Apply to all clips title merge. The clip's first title layer takes the patch's style,
 * placement, width and timing and keeps its own words. A clip without one gets a title from `words`
 * (its title, else its hook text), with the fixed id "title" when free. A clip at the layer limit,
 * without usable words, or with no duration is skipped.
 */
export function applyTitlePatch(studioEdits: StudioEdits, patch: TextLayerTitlePatch,
  clip: { words: string | null; editedDurationSec: number }): { studioEdits: StudioEdits; outcome: TitlePatchOutcome } {
  const skipped = { studioEdits, outcome: "skipped" as const };
  if (!(clip.editedDurationSec > 0)) return skipped;
  const look = { positionX: patch.positionX, positionY: patch.positionY, widthPct: patch.widthPct, style: patch.style, ...clampTitleTiming(patch, clip.editedDurationSec) };
  const index = studioEdits.textLayers.findIndex((layer) => layer.role === "title");
  if (index >= 0) {
    const textLayers = studioEdits.textLayers.map((layer, at) => (at === index ? { ...layer, ...look } : layer));
    return { studioEdits: { ...studioEdits, textLayers }, outcome: "restyled" };
  }
  const text = cutTitleText(clip.words ?? "");
  if (text.length === 0 || studioEdits.textLayers.length >= STUDIO_EDIT_LIMITS.textLayers) return skipped;
  const taken = new Set(studioEdits.textLayers.map((layer) => layer.id));
  let id = "title";
  for (let n = 2; taken.has(id); n += 1) id = `title-${n}`;
  const layer: StudioTextLayer = { id, role: "title", text, ...look };
  return { studioEdits: { ...studioEdits, textLayers: [...studioEdits.textLayers, layer] }, outcome: "created" };
}
