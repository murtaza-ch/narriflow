"use client";

import { useMemo } from "react";
import { MessageCircleOff } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import { useStudio } from "../../studio-shell";
import { fillerCuts } from "../../cleanup-cuts";
import { cleanupCutsDescription, type AiToolRowState } from "./ai-tools-model";

const FILLERS = { one: "filler word", many: "filler words" };

/** Remove filler words where the built-in list knows the clip's language (English), as one undo step. */
export function useFillerToolRow(): AiToolRowState | null {
  const { utterances, clipWindow, deletedRanges, quietRanges, clipInfo, applyDetectedCuts } = useStudio("utterances", "clipWindow", "deletedRanges", "quietRanges", "clipInfo", "applyDetectedCuts");
  const language = clipInfo.captionLanguage;
  const cuts = useMemo(() => fillerCuts({ utterances, clipWindow, deletedRanges, quietRanges }, language), [utterances, clipWindow, deletedRanges, quietRanges, language]);
  if (!cuts) return null;
  return {
    id: "fillers",
    icon: <MessageCircleOff size={18} strokeWidth={1.75} />,
    title: "Remove filler words",
    description: cleanupCutsDescription(cuts, FILLERS, "No filler words found"),
    control:
      cuts.count === 0
        ? { kind: "none" }
        : {
            kind: "apply",
            onApply: () => {
              if (applyDetectedCuts(cuts.ranges)) toaster.create({ type: "success", title: `Removed ${cuts.count} ${cuts.count === 1 ? FILLERS.one : FILLERS.many}`, description: "Undo restores them in one step." });
            },
          },
  };
}
