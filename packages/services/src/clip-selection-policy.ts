import { computeDurationOptimality, computePacingScore, computePlatformScore, computeViralityScore } from "./clip-scoring";
import { getEffectiveClipTiming, normalizeTranscriptSliceForClip, type BrollCue, type ClipCategory, type ClipPlatformTarget, type ContentPack, type TranscriptUtterance } from "@narriflow/validators";

export function buildCaptionOnlyTranscriptSlice(
  utterances: TranscriptUtterance[],
  startSec: number,
  endSec: number,
): TranscriptUtterance[] {
  return normalizeTranscriptSliceForClip(utterances, startSec, endSec);
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

export interface ClipDurationPolicy {
  minDurationSec: number;
  preferredMinDurationSec: number;
  preferredMaxDurationSec: number;
  maxDurationSec: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function resolveDurationPolicy(contentPack: ContentPack | null): ClipDurationPolicy {
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

export const SYSTEM_PROMPT = `You are an expert content strategist and viral clip identifier. You analyze podcast and video transcripts to find the most engaging, clip-worthy moments that will perform well on social media platforms (TikTok, YouTube Shorts, Instagram Reels).

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
- Each returned clip must stay within the request's required duration window.
- Prefer complete clips within the request's preferred duration window unless a longer story arc within the required window is clearly stronger.
- Use the transcript's start_sec and end_sec values as absolute seconds.
- Clips should have natural start and end points (complete thoughts).
- Avoid starting mid-sentence.
- Prioritize quality over quantity, but return the requested number of candidates when the transcript contains enough distinct moments.`;

// Byte-identical across every call regardless of video/content-pack, and
// ordered so the variable guidance lines (hookGuidance, then the optional
// audience-data line) sit at the very end of it. OpenAI's prompt caching only
// credits the longest unbroken prefix match against a prior request, so
// keeping this block first (right after the system prompt, which is already
// fully static) — and keeping all per-request specifics (title, duration,
// transcript, ...) after it — lets caching cover this block on every call
// instead of none of it.
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

/** `audienceDataLine` is the Workspace's one Performance Guidance line, or
 * null; with null the prompt is exactly what it was before guidance existed. */
export function buildUserPrompt(
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
    audienceDataLine?: string | null;
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

  const audienceData = options.audienceDataLine ? `\n${options.audienceDataLine}` : "";

  return `${CLIP_DETECTION_SELECTION_GUIDANCE}
${hookGuidance}${audienceData}

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
export const CLIP_SELECTION_WINDOW_SECONDS = 30 * 60;
export const CLIP_SELECTION_OVERLAP_SECONDS = 120;

export function chunkUtterances(
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
  const chunkDuration = CLIP_SELECTION_WINDOW_SECONDS;
  const chunks: TranscriptUtterance[][] = [];
  const firstStart = utterances[0]!.startSec;
  const lastEnd = utterances[utterances.length - 1]!.endSec;
  let chunkStart = firstStart;

  while (chunkStart < lastEnd) {
    const chunkEnd = chunkStart + chunkDuration + CLIP_SELECTION_OVERLAP_SECONDS;
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

export interface RawDetectedClip {
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

export interface FinalDetectedClip {
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

export interface ClipCandidate extends FinalDetectedClip {
  rawStartSec: number;
  rawEndSec: number;
  rawDurationSec: number;
  durationSec: number;
  rankingScore: number;
}

export interface DroppedClipCandidate {
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

export function deduplicateClipCandidates<T extends { startSec: number; endSec: number; rankingScore: number }>(
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

export function selectDiverseClipCandidates<T extends {
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

export const CLIP_DETECTION_JSON_SCHEMA = {
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
