import { splitUtterancesIntoSentences, wholeSourceWindow, wholeSourceWindowFault, USER_ERROR_MESSAGES, type ContentPack, type TranscriptUtterance } from "@narriflow/validators";
import { WorkflowFailure } from "./workflow-attempt-contract";
import { buildCaptionOnlyTranscriptSlice, buildUserPrompt, resolveClipCountTarget, resolveCandidateCountTarget, resolveDurationPolicy, buildMarketCompliantClipCandidates,
  deduplicateClipCandidates, selectDiverseClipCandidates, formatTranscriptForLlm, CLIP_SELECTION_WINDOW_SECONDS, CLIP_SELECTION_OVERLAP_SECONDS,
  type ClipDurationPolicy, type RawDetectedClip, type FinalDetectedClip } from "./clip-selection-policy";

/** Private-object builder input. This content never enters Workflow parameters or step results. */
export interface ClipSelectionPlanInput {
  projectTitle: string;
  contentPack: ContentPack;
  sourceDurationSec: number | null;
  sourceProbeDurationSec: number | null;
  utterances: TranscriptUtterance[];
  fullText: string;
  speakerCount: number | null;
  sourceLanguageCode: string | null;
  audienceDataLine: string | null;
}
export interface PlannedClipSelectionWindow {
  windowIndex: number; startSec: number; endSec: number;
  utterances: TranscriptUtterance[];
  /** Null means a deterministic empty result, requiring no provider permit. */
  userPrompt: string | null;
}
export interface ParallelClipSelectionPlan {
  kind: "selection";
  utterances: TranscriptUtterance[];
  sourceDurationSec: number | null;
  totalDurationSec: number;
  finalClipCountTarget: number;
  candidateCountTarget: number;
  durationPolicy: ClipDurationPolicy;
  windows: PlannedClipSelectionWindow[];
}

export function buildClipSelectionPlan(input: ClipSelectionPlanInput): ParallelClipSelectionPlan | { kind: "caption_only"; clips: FinalDetectedClip[] } {
  const pack = input.contentPack, all = splitUtterancesIntoSentences(input.utterances);
  const measuredEnd = all.reduce((end, utterance) => Math.max(end, utterance.endSec), 0);
  const sourceDurationSec = input.sourceDurationSec || measuredEnd || null;
  const start = pack.processingStartSec ?? 0, end = pack.processingEndSec ?? sourceDurationSec ?? 0;
  if (pack.mode === "caption_only") {
    const window = wholeSourceWindow(pack, { durationSec: Math.max(1, sourceDurationSec ?? measuredEnd), probeDurationSec: input.sourceProbeDurationSec });
    const fault = wholeSourceWindowFault(window);
    if (fault) throw new WorkflowFailure(fault, "permanent", USER_ERROR_MESSAGES[fault]!);
    return { kind: "caption_only", clips: [{ startSec: window.startSec, endSec: window.endSec, title: input.projectTitle, hookText: input.projectTitle, payoffText: null,
      reasoning: "Caption-only mode: full-length captioned render", category: "story", platformFit: pack.platformTargets, hookStrengthScore: 1, emotionalIntensityScore: 1,
      storyCompletenessScore: 100, pacingScore: 1, durationOptimalityScore: 1, viralityScore: 1, tiktokScore: 1, youtubeScore: 1, instagramScore: 1,
      transcriptSlice: buildCaptionOnlyTranscriptSlice(all, window.startSec, window.endSec) }] };
  }
  if (!all.length && !input.fullText.length) throw new WorkflowFailure("source_has_no_speech", "permanent", USER_ERROR_MESSAGES.source_has_no_speech!);
  const utterances = pack.processingStartSec !== null || pack.processingEndSec !== null ? all.filter(utterance =>
    (pack.processingStartSec === null || utterance.endSec > pack.processingStartSec) && (pack.processingEndSec === null || utterance.startSec < pack.processingEndSec)) : all;
  if (!utterances.length || !Number.isFinite(end - start) || end <= start) throw new WorkflowFailure("transcript_processing_window_empty", "permanent", "Processing window contains no transcript content");
  const totalDurationSec = end - start, count = Math.ceil(totalDurationSec / CLIP_SELECTION_WINDOW_SECONDS);
  if (count > 6) throw new WorkflowFailure("clip_selection_window_limit", "permanent", "The processing window exceeds the supported source duration");
  const finalClipCountTarget = resolveClipCountTarget(pack.clipCountTarget, totalDurationSec);
  const candidateCountTarget = resolveCandidateCountTarget(finalClipCountTarget, totalDurationSec), durationPolicy = resolveDurationPolicy(pack);
  const windows: PlannedClipSelectionWindow[] = Array.from({ length: count }, (_, windowIndex) => {
    const startSec = start + windowIndex * CLIP_SELECTION_WINDOW_SECONDS, endSec = Math.min(end, startSec + CLIP_SELECTION_WINDOW_SECONDS + CLIP_SELECTION_OVERLAP_SECONDS);
    return { windowIndex, startSec, endSec, utterances: utterances.filter(utterance => (windowIndex === 0 ? utterance.endSec > startSec : utterance.startSec >= startSec) && utterance.startSec < endSec), userPrompt: null };
  });
  const activeCount = windows.filter(window => window.utterances.length).length;
  const candidatesPerWindow = activeCount > 1 ? Math.max(4, Math.ceil(candidateCountTarget / activeCount)) : candidateCountTarget;
  for (const window of windows) if (window.utterances.length) window.userPrompt = buildUserPrompt(input.projectTitle, formatTranscriptForLlm(window.utterances), candidatesPerWindow,
    finalClipCountTarget, pack.clipDurationSecTarget, durationPolicy, pack.platformTargets, pack.toneConstraints, input.speakerCount ?? 1, Math.round(totalDurationSec / 60), {
      autoHook: pack.autoHook, specificMoments: pack.specificMoments, processingStartSec: pack.processingStartSec, processingEndSec: pack.processingEndSec,
      sourceLanguageCode: input.sourceLanguageCode, audienceDataLine: input.audienceDataLine,
    });
  return { kind: "selection", utterances, sourceDurationSec, totalDurationSec, finalClipCountTarget, candidateCountTarget, durationPolicy, windows };
}

/** Called once over every committed window, never once per individual window. */
export function finalizeClipSelectionCandidates(plan: ParallelClipSelectionPlan, rawClips: RawDetectedClip[]) {
  if (!rawClips.length) throw new WorkflowFailure("no_clips_detected", "permanent", "LLM did not detect any valid clips");
  const { candidates, dropped } = buildMarketCompliantClipCandidates({ rawClips, utterances: plan.utterances, sourceDurationSec: plan.sourceDurationSec, durationPolicy: plan.durationPolicy });
  const deduped = deduplicateClipCandidates(candidates);
  const selected = selectDiverseClipCandidates(deduped, plan.finalClipCountTarget, plan.sourceDurationSec).sort((left, right) => left.startSec - right.startSec);
  const clips: FinalDetectedClip[] = selected.map(({ rawStartSec: _rawStartSec, rawEndSec: _rawEndSec, rawDurationSec: _rawDurationSec, durationSec: _durationSec,
    rankingScore: _rankingScore, ...clip }) => clip);
  if (!clips.length) throw new WorkflowFailure("no_clips_detected", "permanent", "Detected clips did not contain valid market-duration transcript ranges after timing normalization");
  return { clips, dropped, rawClipCount: rawClips.length, repairedCandidateCount: candidates.length, dedupedCandidateCount: deduped.length };
}
