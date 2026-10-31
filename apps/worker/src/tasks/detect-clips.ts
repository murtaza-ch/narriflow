import { classifyOpenAiHttpFailure } from "@narriflow/services/clip-selection-provider";
export { classifyOpenAiHttpFailure } from "@narriflow/services/clip-selection-provider";
import { buildCaptionOnlyTranscriptSlice, buildMarketCompliantClipCandidates, buildUserPrompt, chunkUtterances, CLIP_DETECTION_JSON_SCHEMA,
  deduplicateClipCandidates, extractResponseText, formatTranscriptForLlm, normalizeLlmClip, resolveCandidateCountTarget, resolveClipCountTarget, resolveDurationPolicy,
  roundSeconds, selectDiverseClipCandidates, summarizeDurations, SYSTEM_PROMPT, type FinalDetectedClip, type RawDetectedClip } from "@narriflow/services/clip-selection-policy";
export { buildCaptionOnlyTranscriptSlice, buildMarketCompliantClipCandidates, buildUserPrompt, CLIP_DURATION_POLICY, formatTimestamp, formatTranscriptForLlm,
  normalizeLlmClip, resolveCandidateCountTarget, resolveClipCountTarget, resolveDefaultClipCountTarget } from "@narriflow/services/clip-selection-policy";
import { setTimeout as sleep } from "node:timers/promises";
import {
  clipExportService,
  clipService,
  getPerformanceGuidance,
  getWorkflowRunLifecycle,
  projectService,
  rethrowWorkflowAttemptLost,
  WorkflowFailure,
  workflowFailureFromUnknown,
  type ClaimedWorkflowAttempt,
  type WorkflowAttemptContext,
} from "@narriflow/services";
import {
  clipDetectionLlmResponseSchema,
  parseStoredContentPack,
  splitUtterancesIntoSentences,
  USER_ERROR_MESSAGES,
  wholeSourceWindow,
  wholeSourceWindowFault,
  type ContentPack,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { notifyWorkflowFailureAfterSettlement } from "../notifications";

interface WorkflowRunJob {
  id: string;
  projectId: string;
  contentPackId: string | null;
  project: {
    title: string;
    sourceStorageKey: string | null;
    sourceDurationSeconds: number | null;
  };
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

interface ClipDetectionPersistence {
  project: Pick<typeof projectService, "getTranscriptForWorker" | "getContentPackForRun" | "getSourceProbeDurationForWorker">;
  clips: Pick<typeof clipService, "persistDetectedClips" | "autoQueueDefaultRenders">;
  exports: Pick<typeof clipExportService, "captionedExportWrite">;
  lifecycle: Pick<ReturnType<typeof getWorkflowRunLifecycle>, "completeMomentDetection" | "failAttempt">;
  notifyFailure: typeof notifyWorkflowFailureAfterSettlement;
  /** The Workspace's Performance Guidance line, when it has qualifying data and the setting is on. */
  guidance: Pick<ReturnType<typeof getPerformanceGuidance>, "promptLine">;
}

export async function processClipDetectionRun(
  attempt: ClaimedWorkflowAttempt,
  context: WorkflowAttemptContext,
  persistence?: ClipDetectionPersistence,
) {
  const adapters = persistence ?? {
    project: projectService, clips: clipService, exports: clipExportService, lifecycle: getWorkflowRunLifecycle(),
    notifyFailure: notifyWorkflowFailureAfterSettlement,
    guidance: getPerformanceGuidance(),
  };
  const run: WorkflowRunJob = { ...attempt, id: attempt.workflowRunId };
  const { signal } = context;
  signal?.throwIfAborted();
  log("info", "clip_detection_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
  });

  try {
    const contentPackRow = await adapters.project.getContentPackForRun({
      projectId: run.projectId, contentPackId: run.contentPackId,
    });
    signal.throwIfAborted();
    if (!contentPackRow) {
      throw new WorkflowWorkerError("workflow_content_pack_invalid", "The Workflow Run has no valid committed Content Pack", "permanent");
    }
    let contentPack: ContentPack;
    try { contentPack = parseStoredContentPack(contentPackRow); }
    catch {
      throw new WorkflowWorkerError("workflow_content_pack_invalid", "The bound Content Pack contains invalid settings", "permanent");
    }

    // Load transcript from DB via service layer
    const transcriptRow = await adapters.project.getTranscriptForWorker(
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

    // A caption-only generation needs no speech: a silent source, or one
    // captioned by the caller, has an empty transcript.
    if (contentPack.mode !== "caption_only" && allUtterances.length === 0 && fullText.length === 0) {
      throw new WorkflowWorkerError(
        "source_has_no_speech",
        USER_ERROR_MESSAGES.source_has_no_speech!,
        "permanent",
      );
    }

    const sourceDurationSec =
      (run.project.sourceDurationSeconds ?? fullDurationSec) || null;
    const processingStartSec = contentPack.processingStartSec ?? null;
    const processingEndSec = contentPack.processingEndSec ?? null;
    const windowStart = processingStartSec ?? 0;
    const windowEnd =
      processingEndSec ?? sourceDurationSec ?? fullDurationSec ?? 0;

    if (contentPack.mode === "caption_only") {
      // The clip is the processing window, or the whole source. The probed
      // duration is exact where the stored duration is rounded; when neither
      // is known, the transcript's last word bounds it.
      const transcriptEndSec = allUtterances.reduce(
        (max, utterance) => Math.max(max, utterance.endSec),
        0,
      );
      const knownDurationSec = (sourceDurationSec ?? fullDurationSec) || transcriptEndSec;
      const captionWindow = wholeSourceWindow(contentPack, {
        durationSec: Math.max(1, knownDurationSec),
        probeDurationSec: await adapters.project.getSourceProbeDurationForWorker(run.projectId),
      });
      signal?.throwIfAborted();
      const windowFault = wholeSourceWindowFault(captionWindow);
      if (windowFault) {
        throw new WorkflowWorkerError(windowFault, USER_ERROR_MESSAGES[windowFault]!, "permanent");
      }
      log("info", "clip_detection_caption_only_short_circuit", {
        workflowRunId: run.id,
        projectId: run.projectId,
        windowStart: captionWindow.startSec,
        windowEnd: captionWindow.endSec,
      });

      const captionClip: FinalDetectedClip = {
        startSec: captionWindow.startSec,
        endSec: captionWindow.endSec,
        title: run.project.title,
        hookText: run.project.title,
        payoffText: null,
        reasoning: "Caption-only mode: full-length captioned render",
        category: "story",
        platformFit: contentPack.platformTargets,
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
          captionWindow.startSec,
          captionWindow.endSec,
        ),
      };

      signal?.throwIfAborted();
      await adapters.clips.persistDetectedClips(
        attempt,
        [captionClip],
        { provider: "openai", model: "caption-only", totalTokensUsed: 0 },
        contentPack,
      );

      try {
        if (contentPack.captionedVideo) {
          // A captioned video ends with its export at the requested formats. The
          // export is admitted by the transaction that completes detection, so a
          // retry of this run can never leave one behind or render a second.
          await adapters.lifecycle.completeMomentDetection(attempt, {
            admit: adapters.exports.captionedExportWrite(attempt, contentPack.captionedVideo),
          });
          return;
        }
        // Any other caption-only run queues the usual preview render.
        await adapters.clips.autoQueueDefaultRenders(
          attempt,
          contentPack.defaultAspectRatio,
        );
      } catch (error) {
        rethrowWorkflowAttemptLost(error);
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

      await adapters.lifecycle.completeMomentDetection(attempt);
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

    const requestedClipCountTarget = contentPack.clipCountTarget;
    const finalClipCountTarget = resolveClipCountTarget(
      requestedClipCountTarget,
      totalDurationSec,
    );
    const candidateCountTarget =
      resolveCandidateCountTarget(finalClipCountTarget, totalDurationSec);
    const durationPolicy = resolveDurationPolicy(contentPack);
    const clipDurationSecTarget =
      contentPack.clipDurationSecTarget;
    const platformTargets =
      contentPack.platformTargets;
    const toneConstraints = contentPack.toneConstraints;
    const autoHook = contentPack.autoHook;
    const specificMoments = contentPack.specificMoments;

    // The Workspace's audience data is a hint, never a requirement: a failed
    // read detects moments exactly as before.
    let audienceDataLine: string | null = null;
    try {
      audienceDataLine = await adapters.guidance.promptLine(attempt.project.workspaceId);
    } catch (error) {
      log("error", "performance_guidance_unavailable", {
        workflowRunId: run.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    signal.throwIfAborted();

    const apiKey = getRequiredOpenAIApiKey();
    const model = process.env.OPENAI_CLIP_MODEL ?? "gpt-5.4-mini";

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
      performanceGuidance: audienceDataLine !== null,
    });

    // Update progress
    await context.reportProgress(20);

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
          audienceDataLine,
        },
      );

      const inFlightProgress = 20 + Math.round((i / chunks.length) * 60);
      const heartbeat = setInterval(() => {
        void context.reportProgress(inFlightProgress).catch(() => {});
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
      await context.reportProgress(chunkProgress);
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
    await adapters.clips.persistDetectedClips(
      attempt,
      finalClips,
      {
        provider: "openai",
        model,
        totalTokensUsed,
      },
      contentPack,
    );

    try {
      await adapters.clips.autoQueueDefaultRenders(
        attempt,
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

    // Complete workflow run
    await adapters.lifecycle.completeMomentDetection(attempt);

    log("info", "clip_detection_run_completed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      clipCount: finalClips.length,
      tokensUsed: totalTokensUsed,
    });
  } catch (error) {
    rethrowWorkflowAttemptLost(error);
    const failure = workflowFailureFromUnknown(error);
    const code = failure.code;
    const message =
      error instanceof Error ? error.message : "Unknown worker error";
    await adapters.lifecycle.failAttempt(attempt, failure);
    log("error", "clip_detection_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      code,
      message,
    });
    await adapters.notifyFailure({
      workflowRunId: run.id,
      projectId: run.projectId,
      errorCode: code,
      reason: message,
    });
  }
}
