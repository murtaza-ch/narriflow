"use client";

import { useMemo } from "react";
import { censorWordsToScan, detectAutoCensorSuggestions, type AutoCensorSuggestion } from "@narriflow/validators";
import type { UpgradePrompt } from "@/app/(app)/_components/upgrade";
import { useStudio, type StudioAutoCensorPolicy } from "../studio-shell";
import type { StudioUpgradePrompts } from "../studio-upgrade";

/** Audio padding around a censored word, in seconds (a caption mask follows its words). */
export const AUTO_CENSOR_PADDING_SEC = 0.06;

/** The upgrade prompt when this plan can scan but not apply Auto-censor; null when it can apply. */
export function autoCensorApplyLock(policy: Pick<StudioAutoCensorPolicy, "canApply">, prompts: Pick<StudioUpgradePrompts, "censoring">): UpgradePrompt | null {
  return policy.canApply ? null : prompts.censoring;
}

/**
 * The free Auto-censor scan of the corrected transcript against the Workspace, Brand and Project
 * words. It edits nothing. The Censor panel and the AI tools panel read the same scan.
 */
export function useAutoCensorSuggestions(): AutoCensorSuggestion[] {
  const { editorDocument, editorRevision, utterances, clipWindow, autoCensorPolicy, censorWords } = useStudio(
    "editorDocument",
    "editorRevision",
    "utterances",
    "clipWindow",
    "autoCensorPolicy",
    "censorWords",
  );
  // Until the list is edited, the scan uses the English defaults plus this clip's language.
  const workspaceWords = useMemo(() => censorWordsToScan(censorWords.workspace, autoCensorPolicy.locale), [autoCensorPolicy.locale, censorWords.workspace]);
  const deletedRanges = editorDocument.deletedRanges;
  return useMemo(
    () =>
      detectAutoCensorSuggestions({
        documentRevision: editorRevision,
        locale: autoCensorPolicy.locale,
        clipWindow,
        deletedRanges,
        transcript: utterances,
        workspaceTerms: workspaceWords,
        brandTerms: autoCensorPolicy.brandTerms,
        projectTerms: censorWords.project,
        paddingSec: AUTO_CENSOR_PADDING_SEC,
      }),
    [autoCensorPolicy.brandTerms, autoCensorPolicy.locale, clipWindow, deletedRanges, editorRevision, censorWords.project, utterances, workspaceWords],
  );
}
