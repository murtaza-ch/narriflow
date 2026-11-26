"use client";

import { ShieldCheck } from "lucide-react";
import { useStudio } from "../../studio-shell";
import { groupAppliedCensorSegments } from "../../auto-censor-review-model";
import { autoCensorApplyLock, useAutoCensorSuggestions } from "../auto-censor-scan";
import { censorRowDescription, type AiToolRowState } from "./ai-tools-model";

/** Auto-censor: the free scan's count, and the Censor panel (where effects are chosen and applied). */
export function useCensorToolRow(): AiToolRowState {
  const { editorDocument, autoCensorPolicy, upgradePrompts, openTool } = useStudio("editorDocument", "autoCensorPolicy", "upgradePrompts", "openTool");
  const suggestions = useAutoCensorSuggestions();
  const censored = groupAppliedCensorSegments(editorDocument.censorSegments).length;
  return {
    id: "censor",
    icon: <ShieldCheck size={18} strokeWidth={1.75} />,
    title: "Auto-censor",
    description: censorRowDescription(suggestions.length, censored),
    control: { kind: "open", onOpen: () => openTool("censor") },
    gem: autoCensorApplyLock(autoCensorPolicy, upgradePrompts)?.tier ?? null,
  };
}
