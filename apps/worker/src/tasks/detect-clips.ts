import {
  clipService,
  computeDurationOptimality,
  computePacingScore,
  computePlatformScore,
  computeViralityScore,
  projectService,
} from "@narriflow/services";
import {
  clipDetectionLlmResponseSchema,
  contentPackSchema,
  getEffectiveClipTiming,
  type ClipCategory,
  type ClipPlatformTarget,
  type ContentPack,
  type TranscriptUtterance,
} from "@narriflow/validators";

interface WorkflowRunJob {
  id: string;
  projectId: string;
  project: {
    title: string;
    sourceStorageKey: string | null;
    sourceDurationSeconds: number | null;
  };
}

class WorkflowWorkerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
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

Important constraints:
- Each returned clip must be between 15 and 90 seconds long.
- Prefer complete clips between 30 and 60 seconds unless a longer story arc is clearly stronger.
- Use the transcript's start_sec and end_sec values as absolute seconds.
- Clips should have natural start and end points (complete thoughts).
- Avoid starting mid-sentence.
- Prioritize quality over quantity, but return the requested number of candidates when the transcript contains enough distinct moments.`;

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
): string {
  const toneNote =
    toneConstraints.length > 0
      ? `\nTone preferences: ${toneConstraints.join(", ")}`
      : "";

  return `Analyze the following transcript and identify ${candidateCountTarget} candidate clip-worthy moments. The system will keep the best ${finalClipCountTarget}.

Content title: "${title}"
Duration: ~${durationMinutes} minutes
Speakers: ${speakerCount}
Target clip duration: ~${clipDurationSecTarget} seconds
Required duration window: ${durationPolicy.minDurationSec}-${durationPolicy.maxDurationSec} seconds
Preferred duration window: ${durationPolicy.preferredMinDurationSec}-${durationPolicy.preferredMaxDurationSec} seconds
Platform targets: ${platformTargets.join(", ")}${toneNote}

Selection guidance:
- Return distinct moments from different story beats or phases of the video.
- Prefer a complete mini-story: setup, escalation, payoff, and clean ending.
- The first 3 seconds must work as a hook without extra context.
- Avoid near-duplicates and avoid clips that only make sense after watching earlier clips.
- For each clip, platform_fit must include every target platform this moment fits naturally.

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
  totalDurationSec: number,
): TranscriptUtterance[][] {
  const formatted = formatTranscriptForLlm(utterances);

  if (formatted.length <= MAX_CHARS_PER_CHUNK) {
    return [utterances];
  }

  // Split into ~30 minute chunks with 2 minute overlap
  const chunkDuration = 30 * 60;
  const chunks: TranscriptUtterance[][] = [];
  let chunkStart = 0;

  while (chunkStart < totalDurationSec) {
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

function normalizeLlmClip(clip: {
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
  };
}

export function buildMarketCompliantClipCandidates(input: {
  rawClips: RawDetectedClip[];
  utterances: TranscriptUtterance[];
  sourceDurationSec: number | null;
  durationPolicy?: ClipDurationPolicy;
}) {
  const candidates: ClipCandidate[] = [];
  const dropped: DroppedClipCandidate[] = [];
  const durationPolicy = input.durationPolicy ?? CLIP_DURATION_POLICY;

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
      rawStartSec: raw.startSec,
      rawEndSec: raw.endSec,
      rawDurationSec,
      durationSec,
      rankingScore: 0,
    } satisfies ClipCandidate;

    candidates.push({
      ...candidate,
      rankingScore: getRankingScore(candidate),
    });
  }

  return { candidates, dropped };
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

async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<{ content: string; tokensUsed: number }> {
  const response = await fetch(
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
      }),
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    usage?: {
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
    error?: { message?: string };
  } | null;

  if (!response.ok || !payload) {
    const message =
      payload?.error?.message ??
      `OpenAI request failed with status ${response.status}`;
    throw new WorkflowWorkerError("openai_request_failed", message);
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

export async function processClipDetectionRun(run: WorkflowRunJob) {
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

    if (!transcriptRow || transcriptRow.status !== "completed") {
      throw new WorkflowWorkerError(
        "transcript_not_ready",
        "Transcript is not completed",
      );
    }

    const utterances = (transcriptRow.utterancesJson ?? []) as unknown as TranscriptUtterance[];
    const fullText = transcriptRow.text ?? "";
    const speakerCount = transcriptRow.speakerCount ?? 1;
    const totalDurationSec = transcriptRow.durationSeconds ?? 0;

    if (utterances.length === 0 && fullText.length === 0) {
      throw new WorkflowWorkerError(
        "transcript_not_ready",
        "Transcript has no content",
      );
    }

    // Load ContentPack for targets
    const contentPackRow = await projectService.getLatestContentPack(
      run.projectId,
    );
    const contentPack = contentPackRow
      ? contentPackSchema.parse(contentPackRow)
      : null;

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
    const sourceDurationSec =
      (run.project.sourceDurationSeconds ?? totalDurationSec) || null;

    // Chunk transcript if needed
    const chunks = chunkUtterances(utterances, totalDurationSec);

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
      );

      const result = await callOpenAI(apiKey, SYSTEM_PROMPT, userPrompt, model);
      totalTokensUsed += result.tokensUsed;

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
    await clipService.persistDetectedClips(run.projectId, run.id, finalClips, {
      provider: "openai",
      model,
      totalTokensUsed,
    });

    if (contentPack?.autoRenderClips) {
      try {
        await clipService.autoQueueDefaultRenders(run.projectId, run.id);
      } catch (error) {
        log("error", "auto_render_queue_failed", {
          workflowRunId: run.id,
          projectId: run.projectId,
          message: error instanceof Error ? error.message : String(error),
        });
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
  } catch (error) {
    const code =
      error instanceof WorkflowWorkerError
        ? error.code
        : "workflow_unhandled_error";
    await projectService.failClipDetectionWorkflowRun(run.id, code);
    log("error", "clip_detection_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      code,
      message:
        error instanceof Error ? error.message : "Unknown worker error",
    });
  }
}
