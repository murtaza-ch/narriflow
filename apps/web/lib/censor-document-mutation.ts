import { hasFeature, isProgramWriteEnabled } from "@narriflow/services";
import type { CensorSegment, EditorDocument } from "@narriflow/validators";

export function censorDocumentMutationError(
  pricingTier: string,
  current: EditorDocument,
  next: EditorDocument,
) {
  const currentById = new Map(current.censorSegments.map((segment) => [segment.id, segment]));
  const changedNext = next.censorSegments.filter(
    (segment) => JSON.stringify(currentById.get(segment.id)) !== JSON.stringify(segment),
  );
  const requiresEntitlement = changedNext.some((segment) => {
    const previous = currentById.get(segment.id);
    return !previous || segment.enabled;
  });
  if (!requiresEntitlement) return null;
  if (!hasFeature(pricingTier, "editor.censoring")) {
    return { status: 403 as const, error: "censor_feature_unavailable", message: "Auto Censor is available on Creator and above" };
  }
  const disabled = changedNext
    .filter((segment) => segment.enabled)
    .find((segment) => !isCensorTreatmentWriteEnabled(segment));
  return disabled
    ? { status: 503 as const, error: "program_write_disabled", message: "This Auto Censor treatment is temporarily read-only" }
    : null;
}

function isCensorTreatmentWriteEnabled(segment: CensorSegment): boolean {
  const group = segment.treatment === "caption_mask"
    ? "auto_censor_caption_masks"
    : segment.treatment === "mute"
      ? "auto_censor_mute"
      : "auto_censor_beep";
  return isProgramWriteEnabled(group);
}
