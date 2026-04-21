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
  getEffectiveClipTiming,
  type ClipCategory,
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
  preferredMaxDurationSec: 75,
  maxDurationSec: 90,
} as const;

const MIN_CANDIDATE_MULTIPLIER = 2;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
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
- Precise start and end timestamps (in seconds)
- A hook text: the compelling first sentence or headline for the clip
- Why this moment is engaging (reasoning)
- A category classifying the type of moment
- Hook strength score (1-100): how compelling the opening is
- Emotional intensity score (1-100): how emotionally resonant the content is

Respond with a JSON object containing a "clips" array. Each clip object must have these exact fields:
- start_time: number (seconds)
- end_time: number (seconds)
- hook_text: string
- reasoning: string
- category: one of "hook", "insight", "story", "humor", "controversy", "emotional", "tutorial", "quote", "debate", "surprise"
- hook_strength: integer 1-100
- emotional_intensity: integer 1-100

Important constraints:
- Each returned clip must be between 15 and 90 seconds long.
- Prefer complete clips between 30 and 75 seconds.
- Use the transcript's start_sec and end_sec values as absolute seconds.
- Clips should have natural start and end points (complete thoughts).
- Avoid starting mid-sentence.
- Prioritize quality over quantity.`;

function buildUserPrompt(
  title: string,
  formattedTranscript: string,
  candidateCountTarget: number,
  finalClipCountTarget: number,
  clipDurationSecTarget: number,
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
Required duration window: ${CLIP_DURATION_POLICY.minDurationSec}-${CLIP_DURATION_POLICY.maxDurationSec} seconds
Preferred duration window: ${CLIP_DURATION_POLICY.preferredMinDurationSec}-${CLIP_DURATION_POLICY.preferredMaxDurationSec} seconds${toneNote}

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
  hookText: string;
  reasoning: string;
  category: string;
  hookStrength: number;
  emotionalIntensity: number;
}

interface FinalDetectedClip {
  startSec: number;
  endSec: number;
  hookText: string;
  reasoning: string;
  category: ClipCategory;
  hookStrengthScore: number;
  emotionalIntensityScore: number;
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

export function resolveClipCountTarget(
  requestedTarget: number,
  sourceDurationSec: number,
) {
  const requested = Number.isFinite(requestedTarget)
    ? Math.max(1, Math.round(requestedTarget))
    : 5;

  if (sourceDurationSec >= 45 * 60) {
    return clamp(Math.max(requested, 5), 5, 8);
  }

  if (sourceDurationSec >= 15 * 60) {
    return clamp(Math.max(requested, 4), 4, 6);
  }

  return clamp(Math.max(requested, 2), 2, 4);
}

export function resolveCandidateCountTarget(finalClipCountTarget: number) {
  return Math.min(
    20,
    Math.max(finalClipCountTarget + 3, finalClipCountTarget * MIN_CANDIDATE_MULTIPLIER),
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

function getRankingScore(clip: {
  viralityScore: number;
  durationOptimalityScore: number;
  hookStrengthScore: number;
}) {
  return (
    clip.viralityScore * 0.7 +
    clip.durationOptimalityScore * 0.2 +
    clip.hookStrengthScore * 0.1
  );
}

function normalizeLlmClip(clip: {
  start_time: number;
  end_time: number;
  hook_text: string;
  reasoning: string;
  category: ClipCategory;
  hook_strength: number;
  emotional_intensity: number;
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
    hookText: clip.hook_text,
    reasoning: clip.reasoning,
    category: clip.category,
    hookStrength: clip.hook_strength,
    emotionalIntensity: clip.emotional_intensity,
  };
}

export function buildMarketCompliantClipCandidates(input: {
  rawClips: RawDetectedClip[];
  utterances: TranscriptUtterance[];
  sourceDurationSec: number | null;
}) {
  const candidates: ClipCandidate[] = [];
  const dropped: DroppedClipCandidate[] = [];

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
      ...CLIP_DURATION_POLICY,
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
      durationSec < CLIP_DURATION_POLICY.minDurationSec ||
      durationSec > CLIP_DURATION_POLICY.maxDurationSec
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
    const pacingScore = computePacingScore(clipUtterances, durationSec);
    const durationOptimalityScore = computeDurationOptimality(durationSec);

    const viralityScore = computeViralityScore({
      hookStrength: hookStrengthScore,
      emotionalIntensity: emotionalIntensityScore,
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
      hookText: raw.hookText,
      reasoning: raw.reasoning,
      category: raw.category as ClipCategory,
      hookStrengthScore,
      emotionalIntensityScore,
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
          "start_time",
          "end_time",
          "hook_text",
          "reasoning",
          "category",
          "hook_strength",
          "emotional_intensity",
        ],
        properties: {
          start_time: { type: "number", minimum: 0 },
          end_time: { type: "number", minimum: 0 },
          hook_text: { type: "string", minLength: 1 },
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
          hook_strength: { type: "integer", minimum: 1, maximum: 100 },
          emotional_intensity: { type: "integer", minimum: 1, maximum: 100 },
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
    const contentPack = await projectService.getLatestContentPack(
      run.projectId,
    );

    const requestedClipCountTarget = contentPack?.clipCountTarget ?? 5;
    const finalClipCountTarget = resolveClipCountTarget(
      requestedClipCountTarget,
      totalDurationSec,
    );
    const candidateCountTarget =
      resolveCandidateCountTarget(finalClipCountTarget);
    const clipDurationSecTarget = contentPack?.clipDurationSecTarget ?? 30;
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
      durationPolicy: CLIP_DURATION_POLICY,
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
    });

    for (const droppedClip of dropped) {
      log("info", "clip_candidate_dropped", {
        workflowRunId: run.id,
        projectId: run.projectId,
        ...droppedClip,
      });
    }

    const dedupedCandidates = deduplicateClipCandidates(candidates);
    const selectedCandidates = [...dedupedCandidates]
      .sort((a, b) => b.rankingScore - a.rankingScore)
      .slice(0, finalClipCountTarget)
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

    // Auto-queue 9:16 default render for all detected clips
    try {
      await clipService.autoQueueDefaultRenders(run.projectId, run.id);
    } catch (error) {
      log("error", "auto_render_queue_failed", {
        workflowRunId: run.id,
        projectId: run.projectId,
        message: error instanceof Error ? error.message : String(error),
      });
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
