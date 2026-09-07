export type StudioCompositionPlanStatus =
  | "unresolved"
  | "ready"
  | "pending"
  | "blocked"
  | "invalid";

export type StudioExportState = "idle" | "exporting" | "queued";

export function studioExportBlockReason(
  compositionPlanStatus: StudioCompositionPlanStatus,
): string | null {
  if (compositionPlanStatus === "invalid") return "Fix the invalid composition before exporting.";
  if (compositionPlanStatus === "blocked") return "Replace or remove the unavailable Scene asset or Brand font before exporting.";
  return null;
}

export function canSubmitStudioExport(input: {
  compositionPlanStatus: StudioCompositionPlanStatus;
  exportState: StudioExportState;
  selectedVariantCount: number;
}): boolean {
  return (
    input.compositionPlanStatus !== "invalid" &&
    input.compositionPlanStatus !== "blocked" &&
    input.exportState === "idle" &&
    input.selectedVariantCount > 0
  );
}
