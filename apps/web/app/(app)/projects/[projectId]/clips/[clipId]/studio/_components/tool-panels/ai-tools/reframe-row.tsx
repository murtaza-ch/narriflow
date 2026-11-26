"use client";

import { ScanFace } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import { SCENE_LAYOUT_MIN_DURATION_SEC } from "@narriflow/validators";
import { useStudio } from "../../studio-shell";
import { refusedEditToast } from "../../edit-refusal";
import { sceneLayoutEdits, wholeClipIsAuto } from "../layout-panel-model";
import { reframeNote, type AiToolRowState } from "./ai-tools-model";

/** Auto reframe: the whole clip to the Auto layout, with the Layout panel's own helper, as one undo step. */
export function useReframeToolRow(): AiToolRowState | null {
  const { studioEdits, aspectRatio, editedTimeMap, autoLayoutAnalysisStatus, clipInfo, setStudioEdits, openTool } = useStudio(
    "studioEdits",
    "aspectRatio",
    "editedTimeMap",
    "autoLayoutAnalysisStatus",
    "clipInfo",
    "setStudioEdits",
    "openTool",
  );
  const durationSec = editedTimeMap.editedDurationSec;
  // No picture to frame, or too short to hold a layout selection.
  if (clipInfo.sourceKind === "audio" || durationSec < SCENE_LAYOUT_MIN_DURATION_SEC) return null;
  const on = wholeClipIsAuto(studioEdits, aspectRatio, durationSec);
  const apply = () => {
    const receipt = setStudioEdits((previous) =>
      sceneLayoutEdits(previous, {
        aspectRatio,
        scene: null,
        applyToAllScenes: true,
        editedDurationSec: durationSec,
        choice: "auto",
        id: `scene-layout-${crypto.randomUUID()}`,
      }),
    );
    if (!receipt.accepted) toaster.create({ type: "error", ...refusedEditToast(receipt) });
  };
  return {
    id: "reframe",
    icon: <ScanFace size={18} strokeWidth={1.75} />,
    title: "Auto reframe",
    description: "Keep the speaker in frame",
    note: reframeNote(autoLayoutAnalysisStatus),
    control: on ? { kind: "open", onOpen: () => openTool("layout"), status: "On" } : { kind: "apply", onApply: apply },
  };
}
