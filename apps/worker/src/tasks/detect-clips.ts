import { setTimeout as sleep } from "node:timers/promises";
import {
  clipService,
  computeDurationOptimality,
  computePacingScore,
  computePlatformScore,
  computeViralityScore,
  projectService,
  rethrowWorkflowAttemptLost,
  WorkflowFailure,
  workflowFailureFromUnknown,
  workflowHttpFailureDisposition,
} from "@narriflow/services";
import {
  clipDetectionLlmResponseSchema,
  parseStoredContentPack,
  getEffectiveClipTiming,
  normalizeTranscriptSliceForClip,
  splitUtterancesIntoSentences,
  type BrollCue,
  type ClipCategory,
  type ClipPlatformTarget,
  type ContentPack,
  type TranscriptUtterance,
} from "@narriflow/validators";
import {
  notifyTerminalOutcome,
  notifyWorkflowFailureAfterSettlement,
} from "../notifications";

interface WorkflowRunJob {
  id: string;
  projectId: string;
  contentPackId?: string | null;
  project: {
    title: string;
    sourceStorageKey: string | null;
    sourceDurationSeconds: number | null;
  };
}

export function buildCaptionOnlyTranscriptSlice(
  utterances: TranscriptUtterance[],
  startSec: number,
  endSec: number,
): TranscriptUtterance[] {
  return normalizeTranscriptSliceForClip(utterances, startSec, endSec);
}

class WorkflowWorkerError extends WorkflowFailure {
  constructor(
    code: string,
    message: string,
    disposition: "retryable" | "permanent" = "retryable",
  ) {
    super(code, disposition, message);
  }
}

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      level,
      message,
      ts: new Date().toISOString(),
      ...context,
    }),
  );
}

function getRequiredOpenAIApiKey() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new WorkflowWorkerError(
      "openai_api_key_missing",
      "OPENAI_API_KEY is not configured",
      "permanent",
    );
  }

  return apiKey;
}

export const CLIP_DURATION_POLICY = {
  minDurationSec: 15,
  preferredMinDurationSec: 30,
  preferredMaxDurationSec: 60,
  maxDurationSec: 90,
} as const;

// Absolute floor a clip's duration can never fall below, regardless of what a
// content pack's duration policy requests — production has emitted 1.43s and
// 2.79s clips (from a 24-minute source) when the effective policy allowed it.
// Matches the content-pack schema's own minDurationSec floor
// (packages/validators/src/content-pack.ts, z.number().min(5)), so this only
// changes behavior for a policy that somehow gets below that floor (a bug
// elsewhere, stale data, or a future schema relaxation) rather than
// second-guessing the schema's normal 5-120s range.
const ABSOLUTE_MIN_CLIP_DURATION_SEC = 5;

const MIN_CANDIDATE_MULTIPLIER = 3;
const MAX_CANDIDATE_COUNT_TARGET = 90;

interface ClipDurationPolicy {
  minDurationSec: number;
  preferredMinDurationSec: number;
  preferredMaxDurationSec: number;
  maxDurationSec: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

function resolveDurationPolicy(contentPack: ContentPack | null): ClipDurationPolicy {
  return {
    minDurationSec:
      contentPack?.minDurationSec ?? CLIP_DURATION_POLICY.minDurationSec,
    preferredMinDurationSec:
      contentPack?.preferredMinDurationSec ??
      CLIP_DURATION_POLICY.preferredMinDurationSec,
    preferredMaxDurationSec:
      contentPack?.preferredMaxDurationSec ??
      CLIP_DURATION_POLICY.preferredMaxDurationSec,
    maxDurationSec:
      contentPack?.maxDurationSec ?? CLIP_DURATION_POLICY.maxDurationSec,
  };
}

function formatSeconds(seconds: number): string {
  return roundSeconds(seconds).toFixed(3);
}

export function formatTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function formatTranscriptForLlm(
  utterances: TranscriptUtterance[],
  offset = 0,
): string {
  return utterances
    .map((u) => {
      const startSec = u.startSec + offset;
      const endSec = u.endSec + offset;
      return `[start_sec=${formatSeconds(startSec)} end_sec=${formatSeconds(endSec)} time=${formatTimestamp(startSec)}-${formatTimestamp(endSec)}] ${u.speakerLabel}: ${u.text}`;
    })
    .join("\n");
}

const SYSTEM_PROMPT = `You are an expert content strategist and viral clip identifier. You analyze podcast and video transcripts to find the most engaging, clip-worthy moments that will perform well on social media platforms (TikTok, YouTube Shorts, Instagram Reels).

Your task is to identify the best moments that would make compelling short clips. Focus on:
- Strong opening hooks (first sentence grabs attention)
- Emotional peaks (surprise, humor, inspiration, controversy)
- Practical advice or insights people want to share
- Quotable statements or provocative opinions
- Story climaxes or revealing moments
- Question/answer exchanges with strong payoffs

For each clip, provide:
- A concise title for the clip
- Precise start and end timestamps (in seconds)
- A hook text: the compelling first sentence or headline for the clip
- A payoff text: the strongest reveal, punchline, decision, or emotional turn
- Why this moment is engaging (reasoning)
- A category classifying the type of moment
- Platform fit: which requested platforms this clip suits
- Hook strength score (1-100): how compelling the opening is
- Emotional intensity score (1-100): how emotionally resonant the content is
- Story completeness score (1-100): whether the clip has a full setup/escalation/payoff arc
- B-roll cue moments: 2-4 moments within the clip where a brief stock-footage cutaway would strengthen it, each with a timestamp, a visual search query, and a one-line reason (return an empty list only when the clip is a pure talking-head with no good insertion point)

Respond with a JSON object containing a "clips" array. Each clip object must have these exact fields:
- title: string
- start_time: number (seconds)
- end_time: number (seconds)
- hook_text: string
- payoff_text: string
- reasoning: string
- category: one of "hook", "insight", "story", "humor", "controversy", "emotional", "tutorial", "quote", "debate", "surprise"
- platform_fit: array containing one or more of "tiktok", "youtube_shorts", "instagram_reels"
- hook_strength: integer 1-100
- emotional_intensity: integer 1-100
- story_completeness_score: integer 1-100
- broll_cues: array of { at_sec, query, reason } — 2-4 B-roll cue moments, or [] for a pure talking-head clip

B-roll cue guidance:
- at_sec is seconds from the START of this clip (0 = the clip's own start), NOT the video's absolute timeline — unlike start_time/end_time, which are absolute.
- query must be a short (2-5 word), visually concrete stock-footage search term describing something a camera could literally film — e.g. "city skyline at night", "hands typing on laptop", "stock market chart screen". Never restate the clip's title, hook, or wording verbatim, and never use abstract, idiomatic, or hyperbolic phrasing (for example, a clip about "mistakes killing your ad budget" must NOT produce a query like "killing" or "mistakes" — describe the visual scene instead, such as "marketing dashboard declining" or "frustrated person at desk"). A literal reading of the query is what gets searched, so avoid any wording that could match violent, graphic, or otherwise unsafe footage when taken literally.
- reason is a one-line explanation of why a cutaway helps at that moment.

Important constraints:
- Each returned clip must be between 15 and 90 seconds long.
- Prefer complete clips between 30 and 60 seconds unless a longer story arc is clearly stronger.
- Use the transcript's start_sec and end_sec values as absolute seconds.
- Clips should have natural start and end points (complete thoughts).
- Avoid starting mid-sentence.
- Prioritize quality over quantity, but return the requested number of candidates when the transcript contains enough distinct moments.`;

// Byte-identical across every call regardless of video/content-pack, and
// ordered so the one 2-way-variable line (hookGuidance) sits at the very end
// of it. OpenAI's prompt caching only credits the longest unbroken prefix
// match against a prior request, so keeping this block first (right after
// the system prompt, which is already fully static) — and keeping all
// per-request specifics (title, duration, transcript, ...) after it — lets
// caching cover this block on every call instead of none of it.
const CLIP_DETECTION_SELECTION_GUIDANCE = `Identify candidate clip-worthy moments in the transcript below. The system keeps the best subset after scoring.

Selection guidance:
- Return distinct moments from different story beats or phases of the video.
- Prefer a complete mini-story: setup, escalation, payoff, and clean ending.
- Avoid near-duplicates and avoid clips that only make sense after watching earlier clips.
- For each clip, platform_fit must include every target platform this moment fits naturally.
- No target language is supplied. Keep title, hook_text, payoff_text, and reasoning in the transcript's source language.
- Preserve the source script, proper and product names, numbers, quotations, and intentional code-switching exactly where meaning requires it.
- When the source language is unknown, infer it from the transcript and use it consistently across every user-facing field.`;

const HOOK_GUIDANCE_AUTO =
  "- The first 3 seconds must work as a hook without extra context.";
const HOOK_GUIDANCE_MANUAL =
  "- A strong opening hook is preferred but NOT required. Favor clips with high story_completeness_score (full setup/escalation/payoff arc) over clips with the strongest hook.";

function buildUserPrompt(
  title: string,
  formattedTranscript: string,
  candidateCountTarget: number,
  finalClipCountTarget: number,
  clipDurationSecTarget: number,
  durationPolicy: ClipDurationPolicy,
  platformTargets: ClipPlatformTarget[],
  toneConstraints: string[],
  speakerCount: number,
  durationMinutes: number,
  options: {
    autoHook: boolean;
    specificMoments: string;
    processingStartSec: number | null;
    processingEndSec: number | null;
    sourceLanguageCode: string | null;
  },
): string {
  const toneNote =
    toneConstraints.length > 0
      ? `\nTone preferences: ${toneConstraints.join(", ")}`
      : "";

  const windowNote =
    options.processingStartSec !== null || options.processingEndSec !== null
      ? `\nProcessing window: ${options.processingStartSec ?? 0}s to ${options.processingEndSec ?? "end"}s. Only return clips inside this window.`
      : "";

  const hookGuidance = options.autoHook ? HOOK_GUIDANCE_AUTO : HOOK_GUIDANCE_MANUAL;

  const userPriorities = options.specificMoments.trim()
    ? `\n\nUSER-SPECIFIED PRIORITIES (boost moments matching this guidance):\n${options.specificMoments.trim()}`
    : "";

  const sourceLanguage = options.sourceLanguageCode
    ? `provider language code ${options.sourceLanguageCode}`
    : "unknown; infer the source language from the transcript";

  return `${CLIP_DETECTION_SELECTION_GUIDANCE}
${hookGuidance}

Return ${candidateCountTarget} candidates; the system keeps the best ${finalClipCountTarget}.

Content title: "${title}"
Source language: ${sourceLanguage}
Duration: ~${durationMinutes} minutes
Speakers: ${speakerCount}
Target clip duration: ~${clipDurationSecTarget} seconds
Required duration window: ${durationPolicy.minDurationSec}-${durationPolicy.maxDurationSec} seconds
Preferred duration window: ${durationPolicy.preferredMinDurationSec}-${durationPolicy.preferredMaxDurationSec} seconds
Platform targets: ${platformTargets.join(", ")}${toneNote}${windowNote}${userPriorities}

TRANSCRIPT:
${formattedTranscript}

Respond with a JSON object: { "clips": [...] }`;
}

// Rough token estimation: ~4 chars per token
const MAX_TOKENS_PER_CHUNK = 80000;
const CHARS_PER_TOKEN = 4;
const MAX_CHARS_PER_CHUNK = MAX_TOKENS_PER_CHUNK * CHARS_PER_TOKEN;
const OVERLAP_SECONDS = 120; // 2 minutes

function chunkUtterances(
  utterances: TranscriptUtterance[],
): TranscriptUtterance[][] {
  const formatted = formatTranscriptForLlm(utterances);

  if (formatted.length <= MAX_CHARS_PER_CHUNK || utterances.length === 0) {
    return [utterances];
  }

  // Split into ~30 minute chunks with 2 minute overlap. Iterate in ABSOLUTE
  // time over the utterance range so a processing window that starts deep into
  // the source (utterance times are absolute) is chunked correctly instead of
  // collapsing/dropping content past the first chunk.
  const chunkDuration = 30 * 60;
  const chunks: TranscriptUtterance[][] = [];
  const firstStart = utterances[0]!.startSec;
  const lastEnd = utterances[utterances.length - 1]!.endSec;
  let chunkStart = firstStart;

  while (chunkStart < lastEnd) {
    const chunkEnd = chunkStart + chunkDuration + OVERLAP_SECONDS;
    const chunk = utterances.filter(
      (u) => u.startSec >= chunkStart && u.startSec < chunkEnd,
    );

    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    chunkStart += chunkDuration;
  }

  return chunks.length > 0 ? chunks : [utterances];
}

interface RawDetectedClip {
  startSec: number;
  endSec: number;
  title: string;
  hookText: string;
  payoffText: string;
  reasoning: string;
  category: string;
  platformFit: ClipPlatformTarget[];
  hookStrength: number;
  emotionalIntensity: number;
  storyCompleteness: number;
  brollCues?: BrollCue[];
}

interface FinalDetectedClip {
  startSec: number;
  endSec: number;
  title: string | null;
  hookText: string;
  payoffText: string | null;
  reasoning: string;
  category: ClipCategory;
  platformFit: ClipPlatformTarget[];
  hookStrengthScore: number;
  emotionalIntensityScore: number;
  storyCompletenessScore: number;
  pacingScore: number;
  durationOptimalityScore: number;
  viralityScore: number;
  tiktokScore: number;
  youtubeScore: number;
  instagramScore: number;
  transcriptSlice: TranscriptUtterance[];
  brollCues?: BrollCue[];
}

interface ClipCandidate extends FinalDetectedClip {
  rawStartSec: number;
  rawEndSec: number;
  rawDurationSec: number;
  durationSec: number;
  rankingScore: number;
}

interface DroppedClipCandidate {
  rawStartSec: number;
  rawEndSec: number;
  rawDurationSec: number;
  reason: string;
  repairedStartSec?: number;
  repairedEndSec?: number;
  repairedDurationSec?: number;
}

export function resolveDefaultClipCountTarget(sourceDurationSec: number) {
  if (sourceDurationSec >= 45 * 60) {
    return 10;
  }

  if (sourceDurationSec >= 15 * 60) {
    return 6;
  }

  return 4;
}

export function resolveClipCountTarget(
  requestedTarget: number | null | undefined,
  sourceDurationSec: number,
) {
  if (Number.isFinite(requestedTarget)) {
    return clamp(Math.round(requestedTarget as number), 3, 30);
  }

  return resolveDefaultClipCountTarget(sourceDurationSec);
}

export function resolveCandidateCountTarget(
  finalClipCountTarget: number,
  sourceDurationSec = 0,
) {
  const durationScaledLimit = Math.max(
    finalClipCountTarget,
    Math.ceil((sourceDurationSec / 60) * 0.6),
  );

  return Math.min(
    MAX_CANDIDATE_COUNT_TARGET,
    Math.max(
      finalClipCountTarget + 5,
      finalClipCountTarget * MIN_CANDIDATE_MULTIPLIER,
      durationScaledLimit,
    ),
  );
}

function deduplicateClipCandidates<T extends { startSec: number; endSec: number; rankingScore: number }>(
  clips: T[],
): T[] {
  // Sort by ranking score descending, keep higher-scored clips.
  const sorted = [...clips].sort((a, b) => b.rankingScore - a.rankingScore);
  const kept: T[] = [];

  for (const clip of sorted) {
    const overlaps = kept.some((existing) => {
      const overlapStart = Math.max(clip.startSec, existing.startSec);
      const overlapEnd = Math.min(clip.endSec, existing.endSec);
      const overlapDuration = Math.max(0, overlapEnd - overlapStart);
      const shorterDuration = Math.min(
        clip.endSec - clip.startSec,
        existing.endSec - existing.startSec,
      );
      return shorterDuration > 0 && overlapDuration / shorterDuration > 0.5;
    });

    if (!overlaps) {
      kept.push(clip);
    }
  }

  // Sort by start time for final ordering
  return kept.sort((a, b) => a.startSec - b.startSec);
}

function selectDiverseClipCandidates<T extends {
  startSec: number;
  endSec: number;
  rankingScore: number;
}>(
  candidates: T[],
  targetCount: number,
  sourceDurationSec: number | null,
): T[] {
  const ranked = [...candidates].sort((a, b) => b.rankingScore - a.rankingScore);
  const selected: T[] = [];
  const sourceDuration =
    typeof sourceDurationSec === "number" && sourceDurationSec > 0
      ? sourceDurationSec
      : null;
  const preferredSpacingSec = sourceDuration
    ? Math.max(45, sourceDuration / Math.max(targetCount * 2, 1))
    : 45;

  for (const candidate of ranked) {
    if (selected.length >= targetCount) {
      break;
    }

    const center = (candidate.startSec + candidate.endSec) / 2;
    const tooClose = selected.some((existing) => {
      const existingCenter = (existing.startSec + existing.endSec) / 2;
      return Math.abs(existingCenter - center) < preferredSpacingSec;
    });

    if (!tooClose) {
      selected.push(candidate);
    }
  }

  if (selected.length < targetCount) {
    for (const candidate of ranked) {
      if (selected.length >= targetCount) {
        break;
      }

      if (!selected.includes(candidate)) {
        selected.push(candidate);
      }
    }
  }

  return selected;
}

function getRankingScore(clip: {
  viralityScore: number;
  durationOptimalityScore: number;
  hookStrengthScore: number;
  storyCompletenessScore: number;
}) {
  return (
    clip.viralityScore * 0.62 +
    clip.storyCompletenessScore * 0.18 +
    clip.durationOptimalityScore * 0.12 +
    clip.hookStrengthScore * 0.08
  );
}

export function normalizeLlmClip(clip: {
  title: string;
  start_time: number;
  end_time: number;
  hook_text: string;
  payoff_text: string;
  reasoning: string;
  category: ClipCategory;
  platform_fit: ClipPlatformTarget[];
  hook_strength: number;
  emotional_intensity: number;
  story_completeness_score: number;
  broll_cues: Array<{ at_sec: number; query: string; reason: string }>;
}): RawDetectedClip | null {
  if (!Number.isFinite(clip.start_time) || !Number.isFinite(clip.end_time)) {
    return null;
  }

  if (clip.end_time <= clip.start_time) {
    return null;
  }

  return {
    startSec: clip.start_time,
    endSec: clip.end_time,
    title: clip.title,
    hookText: clip.hook_text,
    payoffText: clip.payoff_text,
    reasoning: clip.reasoning,
    category: clip.category,
    platformFit: clip.platform_fit,
    hookStrength: clip.hook_strength,
    emotionalIntensity: clip.emotional_intensity,
    storyCompleteness: clip.story_completeness_score,
    brollCues: (clip.broll_cues ?? []).map((c) => ({
      atSec: c.at_sec,
      query: c.query,
      reason: c.reason,
    })),
  };
}

export function buildMarketCompliantClipCandidates(input: {
  rawClips: RawDetectedClip[];
  utterances: TranscriptUtterance[];
  sourceDurationSec: number | null;
  durationPolicy?: ClipDurationPolicy;
}) {
  const candidates: ClipCandidate[] = [];
  const divergentCandidates: Array<{
    candidate: ClipCandidate;
    droppedEntry: DroppedClipCandidate;
  }> = [];
  const dropped: DroppedClipCandidate[] = [];
  const requestedDurationPolicy = input.durationPolicy ?? CLIP_DURATION_POLICY;
  // Clamp up to the absolute floor — never down, so a stricter caller-supplied
  // policy is always respected as-is.
  const durationPolicy: ClipDurationPolicy = {
    ...requestedDurationPolicy,
    minDurationSec: Math.max(
      ABSOLUTE_MIN_CLIP_DURATION_SEC,
      requestedDurationPolicy.minDurationSec,
    ),
    preferredMinDurationSec: Math.max(
      ABSOLUTE_MIN_CLIP_DURATION_SEC,
      requestedDurationPolicy.minDurationSec,
      requestedDurationPolicy.preferredMinDurationSec,
    ),
  };

  for (const raw of input.rawClips) {
    const rawDurationSec = roundSeconds(raw.endSec - raw.startSec);

    if (!Number.isFinite(raw.startSec) || !Number.isFinite(raw.endSec)) {
      dropped.push({
        rawStartSec: raw.startSec,
        rawEndSec: raw.endSec,
        rawDurationSec,
        reason: "invalid_timestamp",
      });
      continue;
    }

    if (raw.endSec <= raw.startSec) {
      dropped.push({
        rawStartSec: raw.startSec,
        rawEndSec: raw.endSec,
        rawDurationSec,
        reason: "non_positive_duration",
      });
      continue;
    }

    const effective = getEffectiveClipTiming({
      utterances: input.utterances,
      startSec: raw.startSec,
      endSec: raw.endSec,
      sourceDurationSec: input.sourceDurationSec,
      ...durationPolicy,
    });
    const durationSec = effective.durationSec;
    const clipUtterances = effective.transcriptSlice;

    if (clipUtterances.length === 0) {
      dropped.push({
        rawStartSec: raw.startSec,
        rawEndSec: raw.endSec,
        rawDurationSec,
        reason: "empty_transcript_slice",
        repairedStartSec: effective.startSec,
        repairedEndSec: effective.endSec,
        repairedDurationSec: durationSec,
      });
      continue;
    }

    // Containment guard: the title/hook/payoff describe the RAW window the
    // LLM picked. If timing repair kept less than half of that window, the
    // clip would carry metadata about content it no longer contains (e.g. a
    // title quoting a payoff that now sits outside the clip) — prefer better-
    // anchored candidates for the slots. Measured against the smaller of the
    // raw span and the policy max: a raw span longer than the max is always
    // trimmed to at most maxDurationSec, and that trim alone must never read
    // as divergence. Guarded candidates are only dropped when SOME candidate
    // survives — an all-divergent set (e.g. an unpunctuated transcript that
    // degrades every repair) still produces clips instead of failing the run.
    const overlapSec =
      Math.min(raw.endSec, effective.endSec) -
      Math.max(raw.startSec, effective.startSec);
    const containmentBaseSec = Math.min(
      rawDurationSec,
      durationPolicy.maxDurationSec,
    );
    const isDivergent =
      containmentBaseSec > 0 && overlapSec / containmentBaseSec < 0.5;

    if (
      durationSec < durationPolicy.minDurationSec ||
      durationSec > durationPolicy.maxDurationSec
    ) {
      dropped.push({
        rawStartSec: raw.startSec,
        rawEndSec: raw.endSec,
        rawDurationSec,
        reason: "duration_outside_market_window",
        repairedStartSec: effective.startSec,
        repairedEndSec: effective.endSec,
        repairedDurationSec: durationSec,
      });
      continue;
    }

    const hookStrengthScore = Math.min(100, Math.max(1, raw.hookStrength));
    const emotionalIntensityScore = Math.min(
      100,
      Math.max(1, raw.emotionalIntensity),
    );
    const storyCompletenessScore = Math.min(
      100,
      Math.max(1, raw.storyCompleteness),
    );
    const pacingScore = computePacingScore(clipUtterances, durationSec);
    const durationOptimalityScore = computeDurationOptimality(
      durationSec,
      durationPolicy,
    );

    const viralityScore = computeViralityScore({
      hookStrength: hookStrengthScore,
      emotionalIntensity: emotionalIntensityScore,
      storyCompleteness: storyCompletenessScore,
      pacing: pacingScore,
      durationOptimality: durationOptimalityScore,
    });

    const tiktokScore = computePlatformScore(
      viralityScore,
      durationSec,
      "tiktok",
    );
    const youtubeScore = computePlatformScore(
      viralityScore,
      durationSec,
      "youtube",
    );
    const instagramScore = computePlatformScore(
      viralityScore,
      durationSec,
      "instagram",
    );

    const candidate = {
      startSec: effective.startSec,
      endSec: effective.endSec,
      title: raw.title,
      hookText: raw.hookText,
      payoffText: raw.payoffText,
      reasoning: raw.reasoning,
      category: raw.category as ClipCategory,
      platformFit: raw.platformFit,
      hookStrengthScore,
      emotionalIntensityScore,
      storyCompletenessScore,
      pacingScore,
      durationOptimalityScore,
      viralityScore,
      tiktokScore,
      youtubeScore,
      instagramScore,
      transcriptSlice: clipUtterances,
      brollCues: raw.brollCues,
      rawStartSec: raw.startSec,
      rawEndSec: raw.endSec,
      rawDurationSec,
      durationSec,
      rankingScore: 0,
    } satisfies ClipCandidate;

    const scored = {
      ...candidate,
      rankingScore: getRankingScore(candidate),
    };

    if (isDivergent) {
      divergentCandidates.push({
        candidate: scored,
        droppedEntry: {
          rawStartSec: raw.startSec,
          rawEndSec: raw.endSec,
          rawDurationSec,
          reason: "timing_repair_divergent",
          repairedStartSec: effective.startSec,
          repairedEndSec: effective.endSec,
          repairedDurationSec: durationSec,
        },
      });
      continue;
    }

    candidates.push(scored);
  }

  if (candidates.length === 0 && divergentCandidates.length > 0) {
    // Fail-open: divergent metadata beats a failed run with zero clips.
    return {
      candidates: divergentCandidates.map((entry) => entry.candidate),
      dropped: [
        ...dropped,
        ...divergentCandidates.map((entry) => ({
          ...entry.droppedEntry,
          reason: "timing_repair_divergent_kept",
        })),
      ],
    };
  }

  return {
    candidates,
    dropped: [
      ...dropped,
      ...divergentCandidates.map((entry) => entry.droppedEntry),
    ],
  };
}

function summarizeDurations(clips: Array<{ durationSec: number }>) {
  if (clips.length === 0) {
    return {
      minSec: null,
      maxSec: null,
      avgSec: null,
    };
  }

  const durations = clips.map((clip) => clip.durationSec);
  const total = durations.reduce((sum, duration) => sum + duration, 0);

  return {
    minSec: roundSeconds(Math.min(...durations)),
    maxSec: roundSeconds(Math.max(...durations)),
    avgSec: roundSeconds(total / durations.length),
  };
}

const CLIP_DETECTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "start_time",
          "end_time",
          "hook_text",
          "payoff_text",
          "reasoning",
          "category",
          "platform_fit",
          "hook_strength",
          "emotional_intensity",
          "story_completeness_score",
          "broll_cues",
        ],
        properties: {
          title: { type: "string", minLength: 1 },
          start_time: { type: "number", minimum: 0 },
          end_time: { type: "number", minimum: 0 },
          hook_text: { type: "string", minLength: 1 },
          payoff_text: { type: "string", minLength: 1 },
          reasoning: { type: "string", minLength: 1 },
          category: {
            type: "string",
            enum: [
              "hook",
              "insight",
              "story",
              "humor",
              "controversy",
              "emotional",
              "tutorial",
              "quote",
              "debate",
              "surprise",
            ],
          },
          platform_fit: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              enum: ["tiktok", "youtube_shorts", "instagram_reels"],
            },
          },
          hook_strength: { type: "integer", minimum: 1, maximum: 100 },
          emotional_intensity: { type: "integer", minimum: 1, maximum: 100 },
          story_completeness_score: {
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
          broll_cues: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["at_sec", "query", "reason"],
              properties: {
                at_sec: { type: "number", minimum: 0 },
                query: { type: "string", minLength: 1 },
                reason: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;

function extractResponseText(payload: unknown): string | null {
  const response = payload as {
    output_text?: unknown;
    output?: Array<{
      content?: Array<{
        text?: unknown;
        type?: unknown;
      }>;
    }>;
  };

  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const textParts =
    response.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string") ?? [];

  return textParts.length > 0 ? textParts.join("") : null;
}

// callOpenAI used to be the only external call anywhere in the worker with no
// timeout at all — a hung socket would block the entire single-threaded
// worker indefinitely. Bounded retry + jittered backoff for transient
// failures (network errors, 429, 5xx); a genuinely bad request (4xx other
// than 429) still fails fast instead of being retried.
const OPENAI_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const OPENAI_FETCH_MAX_RETRIES = 3;
const OPENAI_FETCH_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_OPENAI_MAX_OUTPUT_TOKENS = 32000;
// Progress publishes double as the reaper's heartbeat (they bump the run's
// updatedAt), and a single-chunk source publishes nothing between the 20% and
// 80% marks while a call that may legitimately run 5 minutes (× 3 retries) is
// in flight. Well under the reap stall timeout.
const OPENAI_CALL_HEARTBEAT_INTERVAL_MS = 60 * 1000;

function getOpenAiMaxOutputTokens(): number {
  const value = Number(process.env.OPENAI_CLIP_MAX_OUTPUT_TOKENS);
  return Number.isFinite(value) && value > 0
    ? Math.round(value)
    : DEFAULT_OPENAI_MAX_OUTPUT_TOKENS;
}
const RETRYABLE_NETWORK_ERROR_PATTERN =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|socket connection was closed|network|fetch failed/i;

function isAbortOrTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function isRetryableFetchError(error: unknown): boolean {
  if (isAbortOrTimeoutError(error)) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_NETWORK_ERROR_PATTERN.test(code)) return true;
  return RETRYABLE_NETWORK_ERROR_PATTERN.test(error.message);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

type OpenAiErrorPayload = {
  error?: {
    code?: string | null;
    message?: string;
    type?: string | null;
  };
};

const OPENAI_QUOTA_ERROR_MARKERS = new Set([
  "credit_balance_exhausted",
  "insufficient_quota",
]);

export function classifyOpenAiHttpFailure(
  status: number,
  payload: OpenAiErrorPayload | null,
): { code: string; disposition: "retryable" | "permanent" } {
  const providerCode = payload?.error?.code ?? null;
  const providerType = payload?.error?.type ?? null;
  const quotaExhausted =
    (providerCode !== null && OPENAI_QUOTA_ERROR_MARKERS.has(providerCode)) ||
    (providerType !== null && OPENAI_QUOTA_ERROR_MARKERS.has(providerType));

  if (status === 429 && quotaExhausted) {
    return { code: "openai_quota_exhausted", disposition: "permanent" };
  }

  return {
    code: "openai_request_failed",
    disposition: workflowHttpFailureDisposition(status),
  };
}

async function isRetryableOpenAiResponse(response: Response): Promise<boolean> {
  if (!isRetryableStatus(response.status)) return false;
  if (response.status !== 429) return true;

  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as OpenAiErrorPayload | null;
  return classifyOpenAiHttpFailure(response.status, payload).disposition === "retryable";
}

/** ±20% jitter so concurrent chunks/workers don't retry in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

/** Fetch wrapper with bounded retry + jittered exponential backoff for
 *  transient network errors and 429/5xx responses. A fresh
 *  `AbortSignal.timeout()` is created for every attempt (rather than reusing
 *  one across retries, which would let an earlier attempt's elapsed time eat
 *  into, or already exhaust, a later attempt's budget). */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; maxRetries?: number; baseDelayMs?: number },
): Promise<Response> {
  const maxRetries = options.maxRetries ?? OPENAI_FETCH_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? OPENAI_FETCH_RETRY_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (attempt >= maxRetries || !(await isRetryableOpenAiResponse(response))) {
        return response;
      }
      log("info", "openai_fetch_retry", {
        attempt: attempt + 1,
        maxRetries,
        status: response.status,
      });
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableFetchError(error)) {
        throw error;
      }
      log("info", "openai_fetch_retry", {
        attempt: attempt + 1,
        maxRetries,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
    await sleep(jitter(baseDelayMs * 2 ** attempt));
  }
}

async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<{ content: string; tokensUsed: number }> {
  let response: Response;
  try {
    response = await fetchWithRetry(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          reasoning: {
            // Measured directly against the live API (gpt-5.4-mini, 2 runs,
            // ~20-min representative transcript): medium averaged ~18.3s and
            // 9,486 tokens/call, low averaged ~9.8s and 8,265 tokens/call —
            // ~46% less latency, ~12% fewer tokens. There are no clip-quality
            // fixtures in this repo to validate against (detect-clips.test.ts
            // only unit-tests formatting/candidate-selection math, never
            // Kept at "medium" deliberately. Benchmarking showed "low" is ~46%
            // faster (~18.3s -> ~9.8s) and 12% cheaper, but story_completeness
            // scores trended lower under "low" in one of two runs. That trade
            // is bad here: the saving is ~8.5s against a ~800s end-to-end run
            // (~1% of wall clock) on a per-hour LLM spend already under $0.02,
            // while clip *selection* is the core product value and "bad AI clip
            // selection" is one of the most common complaints about
            // competitors. Spend the second, keep the quality. Override per
            // deployment if you have quality data of your own.
            effort: process.env.OPENAI_CLIP_REASONING_EFFORT ?? "medium",
          },
          text: {
            format: {
              type: "json_schema",
              name: "clip_detection",
              strict: true,
              schema: CLIP_DETECTION_JSON_SCHEMA,
            },
          },
          // Includes reasoning tokens on this model family. Long podcasts ask
          // for up to 90 candidates, so the ceiling is generous — its job is
          // to stop a pathological runaway generation, not to trim normal
          // responses. A response cut off by this cap surfaces as
          // status=incomplete below, not as a JSON parse error.
          max_output_tokens: getOpenAiMaxOutputTokens(),
        }),
      },
      { timeoutMs: OPENAI_REQUEST_TIMEOUT_MS },
    );
  } catch (error) {
    if (isAbortOrTimeoutError(error)) {
      throw new WorkflowWorkerError(
        "openai_request_failed",
        "OpenAI request timed out",
      );
    }
    throw error;
  }

  const payload = (await response.json().catch(() => null)) as {
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: {
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
    error?: {
      code?: string | null;
      message?: string;
      type?: string | null;
    };
  } | null;

  if (!response.ok || !payload) {
    const message =
      payload?.error?.message ??
      `OpenAI request failed with status ${response.status}`;
    const failure = classifyOpenAiHttpFailure(response.status, payload);
    throw new WorkflowWorkerError(
      failure.code,
      message,
      failure.disposition,
    );
  }

  if (payload.status === "incomplete") {
    // Distinct from a parse error: the model stopped early (max_output_tokens
    // or content filter), so the JSON is structurally truncated rather than
    // malformed. Fail with the real cause instead of clip_detection_parse_error.
    throw new WorkflowWorkerError(
      "clip_detection_truncated",
      `OpenAI response incomplete: ${payload.incomplete_details?.reason ?? "unknown reason"}`,
    );
  }

  const content = extractResponseText(payload);
  if (!content) {
    throw new WorkflowWorkerError(
      "openai_request_failed",
      "Empty response from OpenAI",
    );
  }

  return {
    content,
    tokensUsed:
      payload.usage?.total_tokens ??
      (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
  };
}

export async function processClipDetectionRun(
  run: WorkflowRunJob,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  log("info", "clip_detection_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
  });

  try {
    const apiKey = getRequiredOpenAIApiKey();
    const model = process.env.OPENAI_CLIP_MODEL ?? "gpt-5.4-mini";

    // Load transcript from DB via service layer
    const transcriptRow = await projectService.getTranscriptForWorker(
      run.projectId,
    );
    signal?.throwIfAborted();

    if (!transcriptRow || transcriptRow.status !== "completed") {
      throw new WorkflowWorkerError(
        "transcript_not_ready",
        "Transcript is not completed",
        "permanent",
      );
    }

    // Defensive re-split for transcripts stored before sentence-level
    // normalization existed (turn-sized utterances give the LLM no usable
    // timestamps); already sentence-sized utterances pass through unchanged.
    const allUtterances = splitUtterancesIntoSentences(
      (transcriptRow.utterancesJson ?? []) as unknown as TranscriptUtterance[],
    );
    const fullText = transcriptRow.text ?? "";
    const speakerCount = transcriptRow.speakerCount ?? 1;
    const fullDurationSec = transcriptRow.durationSeconds ?? 0;
    const sourceLanguageCode = transcriptRow.languageCode ?? null;

    if (allUtterances.length === 0 && fullText.length === 0) {
      throw new WorkflowWorkerError(
        "transcript_not_ready",
        "Transcript has no content",
        "permanent",
      );
    }

    // Load the run's bound ContentPack — never "latest for project", so a
    // draft written mid-run (user reopening Step 2) can't swap settings.
    const contentPackRow = await projectService.getContentPackForRun(run);
    const contentPack = contentPackRow
      ? parseStoredContentPack(contentPackRow)
      : null;

    const sourceDurationSec =
      (run.project.sourceDurationSeconds ?? fullDurationSec) || null;
    const processingStartSec = contentPack?.processingStartSec ?? null;
    const processingEndSec = contentPack?.processingEndSec ?? null;
    const windowStart = processingStartSec ?? 0;
    const windowEnd =
      processingEndSec ?? sourceDurationSec ?? fullDurationSec ?? 0;

    if (contentPack?.mode === "caption_only") {
      log("info", "clip_detection_caption_only_short_circuit", {
        workflowRunId: run.id,
        projectId: run.projectId,
        windowStart,
        windowEnd,
      });

      // Fall back to the last utterance's end when no duration metadata exists
      // (e.g. an RSS import with no declared duration), so caption-only never
      // produces a zero/0.01s render of the whole video.
      const transcriptEndSec = allUtterances.reduce(
        (max, utterance) => Math.max(max, utterance.endSec),
        0,
      );
      const captionEndSec = Math.max(
        windowStart + 1,
        windowEnd > windowStart
          ? windowEnd
          : (sourceDurationSec ?? fullDurationSec) || transcriptEndSec,
      );
      const captionClip: FinalDetectedClip = {
        startSec: windowStart,
        endSec: captionEndSec,
        title: run.project.title,
        hookText: run.project.title,
        payoffText: null,
        reasoning: "Caption-only mode: full-length captioned render",
        category: "story",
        platformFit: contentPack.platformTargets ?? [],
        hookStrengthScore: 1,
        emotionalIntensityScore: 1,
        storyCompletenessScore: 100,
        pacingScore: 1,
        durationOptimalityScore: 1,
        viralityScore: 1,
        tiktokScore: 1,
        youtubeScore: 1,
        instagramScore: 1,
        transcriptSlice: buildCaptionOnlyTranscriptSlice(
          allUtterances,
          windowStart,
          captionEndSec,
        ),
      };

      signal?.throwIfAborted();
      await clipService.persistDetectedClips(
        run.projectId,
        run.id,
        [captionClip],
        { provider: "openai", model: "caption-only", totalTokensUsed: 0 },
        contentPack,
      );

      try {
        await clipService.autoQueueDefaultRenders(
          run.projectId,
          run.id,
          "16:9",
        );
      } catch (error) {
        log("error", "auto_render_queue_failed", {
          workflowRunId: run.id,
          projectId: run.projectId,
          message: error instanceof Error ? error.message : String(error),
        });
        throw new WorkflowWorkerError(
          "auto_render_queue_failed",
          `Failed to queue the mandatory caption render: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      await projectService.completeClipDetectionWorkflowRun(run.id);
      return;
    }

    const utterances =
      processingStartSec !== null || processingEndSec !== null
        ? allUtterances.filter((u) => {
            const startsAfter = processingStartSec === null || u.endSec > processingStartSec;
            const endsBefore = processingEndSec === null || u.startSec < processingEndSec;
            return startsAfter && endsBefore;
          })
        : allUtterances;
    const totalDurationSec =
      processingStartSec !== null || processingEndSec !== null
        ? Math.max(0, windowEnd - windowStart)
        : fullDurationSec;

    if (utterances.length === 0) {
      throw new WorkflowWorkerError(
        "transcript_processing_window_empty",
        "Processing window contains no transcript content",
        "permanent",
      );
    }

    const requestedClipCountTarget = contentPack?.clipCountTarget;
    const finalClipCountTarget = resolveClipCountTarget(
      requestedClipCountTarget,
      totalDurationSec,
    );
    const candidateCountTarget =
      resolveCandidateCountTarget(finalClipCountTarget, totalDurationSec);
    const durationPolicy = resolveDurationPolicy(contentPack);
    const clipDurationSecTarget =
      contentPack?.clipDurationSecTarget ?? durationPolicy.preferredMinDurationSec;
    const platformTargets =
      contentPack?.platformTargets ?? ["tiktok", "youtube_shorts", "instagram_reels"];
    const toneConstraints = (contentPack?.toneConstraints ?? []) as string[];
    const autoHook = contentPack?.autoHook ?? true;
    const specificMoments = contentPack?.specificMoments ?? "";

    // Chunk transcript if needed
    const chunks = chunkUtterances(utterances);

    log("info", "clip_detection_processing", {
      workflowRunId: run.id,
      chunks: chunks.length,
      utteranceCount: utterances.length,
      durationSec: totalDurationSec,
      requestedClipCountTarget,
      finalClipCountTarget,
      candidateCountTarget,
      durationPolicy,
      platformTargets,
      autoRenderClips: contentPack?.autoRenderClips ?? false,
    });

    // Update progress
    await projectService.publishWorkflowProgress({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "moment_detection",
      status: "running",
      progress: 20,
      errorCode: null,
    });

    // Process each chunk
    const allRawClips: RawDetectedClip[] = [];
    let totalTokensUsed = 0;
    const clipsPerChunk = Math.max(
      4,
      Math.ceil(candidateCountTarget / chunks.length),
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const formattedTranscript = formatTranscriptForLlm(chunk);
      const durationMinutes = Math.round(totalDurationSec / 60);

      const userPrompt = buildUserPrompt(
        run.project.title,
        formattedTranscript,
        chunks.length > 1 ? clipsPerChunk : candidateCountTarget,
        finalClipCountTarget,
        clipDurationSecTarget,
        durationPolicy,
        platformTargets,
        toneConstraints,
        speakerCount,
        durationMinutes,
        {
          autoHook,
          specificMoments,
          processingStartSec,
          processingEndSec,
          sourceLanguageCode,
        },
      );

      const inFlightProgress = 20 + Math.round((i / chunks.length) * 60);
      const heartbeat = setInterval(() => {
        void projectService
          .publishWorkflowProgress({
            projectId: run.projectId,
            workflowRunId: run.id,
            stage: "moment_detection",
            status: "running",
            progress: inFlightProgress,
            errorCode: null,
          })
          .catch(() => {});
      }, OPENAI_CALL_HEARTBEAT_INTERVAL_MS);

      const llmCallStartedAtMs = Date.now();
      let result: Awaited<ReturnType<typeof callOpenAI>>;
      try {
        result = await callOpenAI(apiKey, SYSTEM_PROMPT, userPrompt, model);
      } finally {
        clearInterval(heartbeat);
      }
      totalTokensUsed += result.tokensUsed;
      log("info", "clip_detection_llm_call", {
        workflowRunId: run.id,
        chunkIndex: i,
        chunkCount: chunks.length,
        durationMs: Date.now() - llmCallStartedAtMs,
        tokensUsed: result.tokensUsed,
      });

      // Parse LLM response
      let parsed: { clips: Array<Record<string, unknown>> };
      try {
        parsed = JSON.parse(result.content);
      } catch {
        throw new WorkflowWorkerError(
          "clip_detection_parse_error",
          "Failed to parse LLM response as JSON",
        );
      }

      const validated = clipDetectionLlmResponseSchema.safeParse(parsed);

      if (!validated.success) {
        log("error", "clip_detection_validation_warning", {
          workflowRunId: run.id,
          errors: validated.error.issues.map((i) => i.message),
        });
        // Try to salvage individual clips
        const rawClips = Array.isArray(parsed.clips) ? parsed.clips : [];
        for (const raw of rawClips) {
          try {
            const clip = clipDetectionLlmResponseSchema
              .pick({ clips: true })
              .parse({ clips: [raw] }).clips[0];
            const normalized = clip ? normalizeLlmClip(clip) : null;
            if (normalized) {
              allRawClips.push(normalized);
            }
          } catch {
            // Skip invalid clips
          }
        }
      } else {
        for (const clip of validated.data.clips) {
          const normalized = normalizeLlmClip(clip);
          if (normalized) {
            allRawClips.push(normalized);
          }
        }
      }

      // Update progress per chunk
      const chunkProgress = 20 + Math.round(((i + 1) / chunks.length) * 60);
      await projectService.publishWorkflowProgress({
        projectId: run.projectId,
        workflowRunId: run.id,
        stage: "moment_detection",
        status: "running",
        progress: chunkProgress,
        errorCode: null,
      });
    }

    if (allRawClips.length === 0) {
      throw new WorkflowWorkerError(
        "no_clips_detected",
        "LLM did not detect any valid clips",
        "permanent",
      );
    }

    const { candidates, dropped } = buildMarketCompliantClipCandidates({
      rawClips: allRawClips,
      utterances,
      sourceDurationSec,
      durationPolicy,
    });

    for (const droppedClip of dropped) {
      log("info", "clip_candidate_dropped", {
        workflowRunId: run.id,
        projectId: run.projectId,
        ...droppedClip,
      });
    }

    const dedupedCandidates = deduplicateClipCandidates(candidates);
    const selectedCandidates = selectDiverseClipCandidates(
      dedupedCandidates,
      finalClipCountTarget,
      sourceDurationSec,
    )
      .sort((a, b) => a.startSec - b.startSec);
    const finalClips: FinalDetectedClip[] = selectedCandidates.map(
      ({
        rawStartSec: _rawStartSec,
        rawEndSec: _rawEndSec,
        rawDurationSec: _rawDurationSec,
        durationSec: _durationSec,
        rankingScore: _rankingScore,
        ...clip
      }) => clip,
    );

    if (finalClips.length === 0) {
      throw new WorkflowWorkerError(
        "no_clips_detected",
        "Detected clips did not contain valid market-duration transcript ranges after timing normalization",
        "permanent",
      );
    }

    log("info", "clip_detection_candidates_finalized", {
      workflowRunId: run.id,
      projectId: run.projectId,
      rawClipCount: allRawClips.length,
      repairedCandidateCount: candidates.length,
      droppedCandidateCount: dropped.length,
      dedupedCandidateCount: dedupedCandidates.length,
      finalClipCount: finalClips.length,
      finalClipCountTarget,
      durationSummary: summarizeDurations(selectedCandidates),
      selectedClips: selectedCandidates.map((clip) => ({
        rawStartSec: roundSeconds(clip.rawStartSec),
        rawEndSec: roundSeconds(clip.rawEndSec),
        rawDurationSec: clip.rawDurationSec,
        startSec: roundSeconds(clip.startSec),
        endSec: roundSeconds(clip.endSec),
        durationSec: roundSeconds(clip.durationSec),
        rankingScore: Math.round(clip.rankingScore),
      })),
    });

    // Persist clips
    signal?.throwIfAborted();
    await clipService.persistDetectedClips(
      run.projectId,
      run.id,
      finalClips,
      {
        provider: "openai",
        model,
        totalTokensUsed,
      },
      contentPack,
    );

    if (contentPack?.autoRenderClips) {
      try {
        await clipService.autoQueueDefaultRenders(
          run.projectId,
          run.id,
          contentPack.defaultAspectRatio,
        );
      } catch (error) {
        log("error", "auto_render_queue_failed", {
          workflowRunId: run.id,
          projectId: run.projectId,
          message: error instanceof Error ? error.message : String(error),
        });
        throw new WorkflowWorkerError(
          "auto_render_queue_failed",
          `Failed to queue automatic renders: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Complete workflow run
    await projectService.completeClipDetectionWorkflowRun(run.id);

    log("info", "clip_detection_run_completed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      clipCount: finalClips.length,
      tokensUsed: totalTokensUsed,
    });

    if (!contentPack?.autoRenderClips) {
      await notifyTerminalOutcome({
        projectId: run.projectId,
        sourceId: run.id,
        outcome: "clips_ready",
        clipCount: finalClips.length,
      });
    }
  } catch (error) {
    rethrowWorkflowAttemptLost(error);
    const failure = workflowFailureFromUnknown(error);
    const code = failure.code;
    const message =
      error instanceof Error ? error.message : "Unknown worker error";
    await projectService.failClipDetectionWorkflowRun(run.id, failure);
    log("error", "clip_detection_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      code,
      message,
    });
    await notifyWorkflowFailureAfterSettlement({
      workflowRunId: run.id,
      projectId: run.projectId,
      errorCode: code,
      reason: message,
    });
  }
}
