import {
  clipService,
  computeDurationOptimality,
  computePacingScore,
  computePlatformScore,
  computeViralityScore,
  projectService,
  sliceTranscriptForClip,
} from "@narriflow/services";
import {
  clipDetectionLlmResponseSchema,
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

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTranscriptForLlm(
  utterances: TranscriptUtterance[],
  offset = 0,
): string {
  return utterances
    .map(
      (u) =>
        `[${formatTimestamp(u.startSec + offset)}] ${u.speakerLabel}: ${u.text}`,
    )
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
- Clips must be between 15 and 90 seconds long
- Clips should have natural start and end points (complete thoughts)
- Avoid starting mid-sentence
- Prioritize quality over quantity`;

function buildUserPrompt(
  title: string,
  formattedTranscript: string,
  clipCountTarget: number,
  clipDurationSecTarget: number,
  toneConstraints: string[],
  speakerCount: number,
  durationMinutes: number,
): string {
  const toneNote =
    toneConstraints.length > 0
      ? `\nTone preferences: ${toneConstraints.join(", ")}`
      : "";

  return `Analyze the following transcript and identify ${clipCountTarget} clip-worthy moments.

Content title: "${title}"
Duration: ~${durationMinutes} minutes
Speakers: ${speakerCount}
Target clip duration: ~${clipDurationSecTarget} seconds${toneNote}

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

function deduplicateClips(clips: RawDetectedClip[]): RawDetectedClip[] {
  // Sort by hookStrength descending, keep higher-scored clips
  const sorted = [...clips].sort((a, b) => b.hookStrength - a.hookStrength);
  const kept: RawDetectedClip[] = [];

  for (const clip of sorted) {
    const overlaps = kept.some((existing) => {
      const overlapStart = Math.max(clip.startSec, existing.startSec);
      const overlapEnd = Math.min(clip.endSec, existing.endSec);
      const overlapDuration = Math.max(0, overlapEnd - overlapStart);
      const clipDuration = clip.endSec - clip.startSec;
      return overlapDuration / clipDuration > 0.5;
    });

    if (!overlaps) {
      kept.push(clip);
    }
  }

  // Sort by start time for final ordering
  return kept.sort((a, b) => a.startSec - b.startSec);
}

async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Promise<{ content: string; tokensUsed: number }> {
  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
      }),
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
    error?: { message?: string };
  } | null;

  if (!response.ok || !payload) {
    const message =
      payload?.error?.message ??
      `OpenAI request failed with status ${response.status}`;
    throw new WorkflowWorkerError("openai_request_failed", message);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new WorkflowWorkerError(
      "openai_request_failed",
      "Empty response from OpenAI",
    );
  }

  return {
    content,
    tokensUsed: payload.usage?.total_tokens ?? 0,
  };
}

export async function processClipDetectionRun(run: WorkflowRunJob) {
  log("info", "clip_detection_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
  });

  try {
    const apiKey = getRequiredOpenAIApiKey();
    const model = process.env.OPENAI_CLIP_MODEL ?? "gpt-4o-mini";

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

    const clipCountTarget = contentPack?.clipCountTarget ?? 5;
    const clipDurationSecTarget = contentPack?.clipDurationSecTarget ?? 30;
    const toneConstraints = (contentPack?.toneConstraints ?? []) as string[];

    // Chunk transcript if needed
    const chunks = chunkUtterances(utterances, totalDurationSec);

    log("info", "clip_detection_processing", {
      workflowRunId: run.id,
      chunks: chunks.length,
      utteranceCount: utterances.length,
      durationSec: totalDurationSec,
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
      3,
      Math.ceil(clipCountTarget / chunks.length),
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const formattedTranscript = formatTranscriptForLlm(chunk);
      const durationMinutes = Math.round(totalDurationSec / 60);

      const userPrompt = buildUserPrompt(
        run.project.title,
        formattedTranscript,
        chunks.length > 1 ? clipsPerChunk : clipCountTarget,
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
            if (clip) {
              allRawClips.push({
                startSec: clip.start_time,
                endSec: clip.end_time,
                hookText: clip.hook_text,
                reasoning: clip.reasoning,
                category: clip.category,
                hookStrength: clip.hook_strength,
                emotionalIntensity: clip.emotional_intensity,
              });
            }
          } catch {
            // Skip invalid clips
          }
        }
      } else {
        for (const clip of validated.data.clips) {
          allRawClips.push({
            startSec: clip.start_time,
            endSec: clip.end_time,
            hookText: clip.hook_text,
            reasoning: clip.reasoning,
            category: clip.category,
            hookStrength: clip.hook_strength,
            emotionalIntensity: clip.emotional_intensity,
          });
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

    // Deduplicate clips from multiple chunks
    const deduped =
      chunks.length > 1 ? deduplicateClips(allRawClips) : allRawClips;

    // Compute heuristic scores and build final clips
    const finalClips = deduped.map((raw) => {
      const durationSec = raw.endSec - raw.startSec;
      const clipUtterances = sliceTranscriptForClip(
        utterances,
        raw.startSec,
        raw.endSec,
      );

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

      return {
        startSec: raw.startSec,
        endSec: raw.endSec,
        hookText: raw.hookText,
        reasoning: raw.reasoning,
        category: raw.category as
          | "hook"
          | "insight"
          | "story"
          | "humor"
          | "controversy"
          | "emotional"
          | "tutorial"
          | "quote"
          | "debate"
          | "surprise",
        hookStrengthScore,
        emotionalIntensityScore,
        pacingScore,
        durationOptimalityScore,
        viralityScore,
        tiktokScore,
        youtubeScore,
        instagramScore,
        transcriptSlice: clipUtterances,
      };
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
