export type StudioCompositionPlanStatus =
  | "unresolved"
  | "ready"
  | "pending"
  | "invalid";

export type StudioExportState = "idle" | "exporting" | "queued";

export function studioExportBlockReason(
  compositionPlanStatus: StudioCompositionPlanStatus,
): string | null {
  return compositionPlanStatus === "invalid"
    ? "Fix the invalid composition before exporting."
    : null;
}

export function canSubmitStudioExport(input: {
  compositionPlanStatus: StudioCompositionPlanStatus;
  exportState: StudioExportState;
  selectedVariantCount: number;
}): boolean {
  return (
    input.compositionPlanStatus !== "invalid" &&
    input.exportState === "idle" &&
    input.selectedVariantCount > 0
  );
}
