import { editorDocumentUsesMotion, type EditorDocument } from "@narriflow/validators";

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

/**
 * Mirrors the export admission check (`assertClipExportDocumentAllowed`): a
 * document with active motion exports only on a plan with motion. Reachable
 * after a downgrade, since a locked plan never saves new motion.
 */
export function studioExportMotionLocked(
  document: Pick<EditorDocument, "studioEdits" | "sceneBlocks" | "mediaMotions">,
  canPersistMotion: boolean,
): boolean {
  return !canPersistMotion && editorDocumentUsesMotion(document as EditorDocument);
}

export function canSubmitStudioExport(input: {
  compositionPlanStatus: StudioCompositionPlanStatus;
  exportState: StudioExportState;
  selectedVariantCount: number;
  motionLocked?: boolean;
}): boolean {
  return (
    !input.motionLocked &&
    input.compositionPlanStatus !== "invalid" &&
    input.compositionPlanStatus !== "blocked" &&
    input.exportState === "idle" &&
    input.selectedVariantCount > 0
  );
}
