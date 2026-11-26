import { buildClipCutPlan, type ClipSnapshot, findTitleLayer, type StudioTextLayer, sourceToEdited } from "@narriflow/validators";

/**
 * What a clip card needs to draw the clip's title over the preview proxy (title-text spec section 8):
 * the first `role: "title"` layer, the window it is on screen (edited-timeline ms, clamped to the clip
 * as the composition plan clamps it), and the map from the proxy player's time to edited time.
 *
 * The proxy is raw source footage, so the card plays the clip's source window straight through,
 * cuts included. Text Layers are timed on the edited timeline (cuts removed; inserted Scene Blocks
 * are not in the proxy and do not move a layer's base time), so the player's time goes through the
 * clip's cut plan: an instant inside a cut takes the edited time of the next kept frame.
 */
export interface ClipTitleOverlayModel {
  readonly layer: StudioTextLayer;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  /** Proxy player seconds → edited seconds. */
  readonly editedSecAt: (playerSec: number) => number;
}

export function clipTitleOverlayModel(
  clip: Pick<ClipSnapshot, "startSec" | "endSec" | "studioEdits" | "deletedRanges">,
  /** The proxy's t=0 in source seconds. */
  previewOffsetSec: number,
): ClipTitleOverlayModel | null {
  const layer = findTitleLayer(clip.studioEdits?.textLayers ?? []);
  if (!layer) return null;
  const { map, editedDurationSec } = buildClipCutPlan(clip.deletedRanges ?? [], { startSec: clip.startSec, endSec: clip.endSec });
  const startSec = Math.max(0, Math.min(editedDurationSec, layer.startSec));
  const endSec = Math.max(startSec, Math.min(editedDurationSec, layer.endSec ?? editedDurationSec));
  if (endSec <= startSec) return null;
  return {
    layer,
    window: { fromMs: startSec * 1000, toMs: endSec * 1000 },
    editedSecAt: (playerSec) => sourceToEdited(map, playerSec + previewOffsetSec),
  };
}
