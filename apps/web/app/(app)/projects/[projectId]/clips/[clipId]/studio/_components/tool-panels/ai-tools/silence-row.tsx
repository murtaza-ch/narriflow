"use client";

import { useMemo } from "react";
import { AudioLines } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import { useStudio } from "../../studio-shell";
import { silenceCuts } from "../../cleanup-cuts";
import { cleanupCutsDescription, type AiToolRowState } from "./ai-tools-model";

const SILENCES = { one: "silence", many: "silences" };

/** Remove silences with the timeline popover's default settings, as one undo step. */
export function useSilenceToolRow(): AiToolRowState {
  const { utterances, clipWindow, deletedRanges, quietRanges, applyDetectedCuts } = useStudio("utterances", "clipWindow", "deletedRanges", "quietRanges", "applyDetectedCuts");
  const cuts = useMemo(() => silenceCuts({ utterances, clipWindow, deletedRanges, quietRanges }), [utterances, clipWindow, deletedRanges, quietRanges]);
  const description = cleanupCutsDescription(cuts, SILENCES, "No silences found");
  return {
    id: "silences",
    icon: <AudioLines size={18} strokeWidth={1.75} />,
    title: "Remove silences",
    description,
    control:
      cuts.count === 0
        ? { kind: "none" }
        : {
            kind: "apply",
            onApply: () => {
              if (applyDetectedCuts(cuts.ranges)) toaster.create({ type: "success", title: `Removed ${cuts.count} ${cuts.count === 1 ? SILENCES.one : SILENCES.many}`, description: "Undo restores them in one step." });
            },
          },
  };
}
