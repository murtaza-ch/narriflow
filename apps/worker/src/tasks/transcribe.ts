import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  downloadObjectToFile,
  normalizeAssemblyAiTranscript,
  presignDownloadUrl,
  putJson,
  getWorkflowRunLifecycle,
  projectService,
  rethrowWorkflowAttemptLost,
  WorkflowAttemptLost,
  WorkflowFailure,
  workflowFailureFromUnknown,
  workflowHttpFailureDisposition,
  type ClaimedWorkflowAttempt,
  type WorkflowAttemptContext,
  type WorkflowAttemptRef,
} from "@narriflow/services";
import { isR2Configured } from "@narriflow/services/r2-storage";
import {
  ASSEMBLYAI_SPEECH_MODEL_CHAIN,
  sourceLanguageCodeSchema,
} from "@narriflow/validators";
import { notifyWorkflowFailureAfterSettlement } from "../notifications";

interface WorkflowRunJob {
  id: string;
  projectId: string;
  project: {
    title: string;
    sourceStorageKey: string | null;
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

const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com";
// Per-request timeouts so a hung connection doesn't stall a workflow run until
// the overall polling deadline (assemblyai_transcription_timeout) fires.
const ASSEMBLYAI_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const ASSEMBLYAI_SUBMIT_TIMEOUT_MS = 30 * 1000;
const ASSEMBLYAI_POLL_TIMEOUT_MS = 30 * 1000;

function isAbortOrTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
const ASSEMBLYAI_KEYTERM_LIMIT = 200;
const ASSEMBLYAI_KEYTERM_MAX_WORDS = 6;
const DEFAULT_ASSEMBLYAI_POLL_INTERVAL_MS = 5000;
const DEFAULT_ASSEMBLYAI_POLL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// A hung socket or a 5xx/429 from AssemblyAI used to fail the whole workflow
// run outright (attemptCount is tracked at the job level, but nothing here
// ever retried within a single attempt). Bounded retry with backoff for
// transient failures only — a genuinely bad request (4xx other than 429)
// still fails fast.
const ASSEMBLYAI_FETCH_MAX_RETRIES = 3;
const ASSEMBLYAI_FETCH_RETRY_BASE_DELAY_MS = 1000;
const RETRYABLE_NETWORK_ERROR_PATTERN =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|socket connection was closed|network|fetch failed/i;

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

/** Fetch wrapper with bounded retry + exponential backoff (jittered) for
 *  transient network errors and 429/5xx responses. Permanent failures (4xx
 *  other than 429) are returned immediately so callers still fail fast.
 *
 *  `timeoutMs` is used to build a *fresh* `AbortSignal.timeout()` for every
 *  attempt (rather than the caller passing one `signal` that would otherwise
 *  be shared/stale across retries — an earlier attempt's elapsed time would
 *  eat into, or already exhaust, a later attempt's budget). */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: {
    label: string;
    timeoutMs: number;
    maxRetries?: number;
    baseDelayMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<Response> {
  const maxRetries = options.maxRetries ?? ASSEMBLYAI_FETCH_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? ASSEMBLYAI_FETCH_RETRY_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (attempt >= maxRetries || !isRetryableStatus(response.status)) {
        return response;
      }
      log("info", "assemblyai_fetch_retry", {
        label: options.label,
        attempt: attempt + 1,
        maxRetries,
        status: response.status,
      });
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableFetchError(error)) {
        throw error;
      }
      log("info", "assemblyai_fetch_retry", {
        label: options.label,
        attempt: attempt + 1,
        maxRetries,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
    await sleep(jitter(baseDelayMs * 2 ** attempt));
  }
}

function sanitizeFileName(name: string) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
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

async function execCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new WorkflowWorkerError(
            "worker_command_missing",
            `${command} is not installed`,
            "permanent",
          ),
        );
        return;
      }

      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new WorkflowWorkerError(
          "worker_command_failed",
          `${command} failed with code ${code}: ${stderr}`,
        ),
      );
    });
  });
}

function getRequiredAssemblyAiApiKey() {
  const apiKey = process.env.ASSEMBLYAI_API_KEY?.trim();

  if (!apiKey) {
    throw new WorkflowWorkerError(
      "assemblyai_api_key_missing",
      "ASSEMBLYAI_API_KEY is not configured",
      "permanent",
    );
  }

  return apiKey;
}

function getAssemblyAiPollIntervalMs() {
  const value = Number(process.env.ASSEMBLYAI_POLL_INTERVAL_MS);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_ASSEMBLYAI_POLL_INTERVAL_MS;
}

function getAssemblyAiPollTimeoutMs() {
  const value = Number(process.env.ASSEMBLYAI_POLL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_ASSEMBLYAI_POLL_TIMEOUT_MS;
}

const ASSEMBLYAI_PRESIGN_BUFFER_MS = 30 * 60 * 1000;
const MAX_PRESIGN_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60; // S3/R2 SigV4 ceiling

/** The presigned source URL must stay valid for as long as AssemblyAI might
 *  take to fetch + transcribe it. We bound our own wait by the poll timeout,
 *  so give the URL that plus a comfortable buffer (clamped to the presign
 *  scheme's own 7-day ceiling). */
function getAssemblyAiPresignExpiresInSeconds() {
  const seconds = Math.ceil(
    (getAssemblyAiPollTimeoutMs() + ASSEMBLYAI_PRESIGN_BUFFER_MS) / 1000,
  );
  return Math.min(seconds, MAX_PRESIGN_EXPIRES_IN_SECONDS);
}

/** Applies ±20% jitter (90%–110%) so concurrent workers don't poll the
 *  provider in lockstep. Runtime code, so Math.random() is fine here. */
function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

function getAssemblyAiKeytermsPrompt() {
  const terms =
    process.env.ASSEMBLYAI_KEYTERMS_PROMPT?.split(",")
      .map((term) => term.trim())
      .filter(
        (term) =>
          term.length > 0 &&
          term.split(/\s+/).length <= ASSEMBLYAI_KEYTERM_MAX_WORDS,
      ) ?? [];
  const uniqueTerms = new Map<string, string>();
  for (const term of terms) {
    const key = term.toLowerCase();
    if (!uniqueTerms.has(key)) uniqueTerms.set(key, term);
  }
  return [...uniqueTerms.values()].slice(0, ASSEMBLYAI_KEYTERM_LIMIT);
}

async function parseJsonResponse(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

function getResponseMessage(
  payload: unknown,
  fallback: string,
) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const error = record.error ?? record.message;

    if (typeof error === "string" && error.trim()) {
      return error;
    }
  }

  return fallback;
}

async function uploadAssemblyAiAudio(audioPath: string, apiKey: string) {
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${ASSEMBLYAI_BASE_URL}/v2/upload`,
      {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/octet-stream",
        },
        body: readFileSync(audioPath),
        duplex: "half",
      } as RequestInit & { duplex: "half" },
      // `body` is a Buffer (read once above), not a stream, so it's safe to
      // resend unchanged across retry attempts. Fewer retries than the other
      // calls since a large upload retry is more expensive to repeat.
      { label: "upload", timeoutMs: ASSEMBLYAI_UPLOAD_TIMEOUT_MS, maxRetries: 2 },
    );
  } catch (error) {
    if (isAbortOrTimeoutError(error)) {
      throw new WorkflowWorkerError(
        "assemblyai_upload_failed",
        "AssemblyAI upload timed out",
      );
    }
    throw error;
  }

  const payload = await parseJsonResponse(response);

  if (!response.ok || !payload || typeof payload !== "object") {
    throw new WorkflowWorkerError(
      "assemblyai_upload_failed",
      getResponseMessage(
        payload,
        `AssemblyAI upload failed with status ${response.status}`,
      ),
      workflowHttpFailureDisposition(response.status),
    );
  }

  const uploadUrl = (payload as Record<string, unknown>).upload_url;

  if (typeof uploadUrl !== "string" || !uploadUrl) {
    throw new WorkflowWorkerError(
      "assemblyai_upload_url_missing",
      "AssemblyAI upload did not return an upload URL",
    );
  }

  return uploadUrl;
}

async function submitAssemblyAiTranscript(
  uploadUrl: string,
  apiKey: string,
  options: {
    languageCode: string | null;
  },
) {
  const languageBranch = options.languageCode
    ? { language_code: sourceLanguageCodeSchema.parse(options.languageCode) }
    : { language_detection: true };

  // Keyterms are opt-in deployment vocabulary only. Use the Universal-2-safe
  // 200-term ceiling because this request can fall back from U3.5 Pro to U2.
  const keyterms = getAssemblyAiKeytermsPrompt();
  const keytermsBranch =
    keyterms.length > 0 ? { keyterms_prompt: keyterms } : {};

  let response: Response;
  try {
    response = await fetchWithRetry(
      `${ASSEMBLYAI_BASE_URL}/v2/transcript`,
      {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio_url: uploadUrl,
          speech_models: ASSEMBLYAI_SPEECH_MODEL_CHAIN,
          speaker_labels: true,
          ...keytermsBranch,
          ...languageBranch,
        }),
      },
      { label: "submit", timeoutMs: ASSEMBLYAI_SUBMIT_TIMEOUT_MS },
    );
  } catch (error) {
    if (isAbortOrTimeoutError(error)) {
      throw new WorkflowWorkerError(
        "assemblyai_transcription_submit_failed",
        "AssemblyAI transcription submit timed out",
      );
    }
    throw error;
  }

  const payload = await parseJsonResponse(response);

  if (!response.ok || !payload || typeof payload !== "object") {
    throw new WorkflowWorkerError(
      "assemblyai_transcription_submit_failed",
      getResponseMessage(
        payload,
        `AssemblyAI transcription submit failed with status ${response.status}`,
      ),
      workflowHttpFailureDisposition(response.status),
    );
  }

  const transcriptId = (payload as Record<string, unknown>).id;

  if (typeof transcriptId !== "string" || !transcriptId) {
    throw new WorkflowWorkerError(
      "assemblyai_transcript_id_missing",
      "AssemblyAI transcription submit did not return a transcript id",
    );
  }

  return transcriptId;
}

export async function getAssemblyAiTranscript(
  transcriptId: string,
  apiKey: string,
  overrides?: {
    fetchImpl?: typeof fetch;
    maxRetries?: number;
    baseDelayMs?: number;
  },
) {
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${ASSEMBLYAI_BASE_URL}/v2/transcript/${transcriptId}`,
      {
        headers: {
          Authorization: apiKey,
        },
      },
      // The outer poll loop already re-calls this every pollIntervalMs, but
      // without this a single transient blip would throw out of the poll
      // loop and fail an otherwise-healthy, possibly near-complete run.
      {
        label: "poll",
        timeoutMs: ASSEMBLYAI_POLL_TIMEOUT_MS,
        ...overrides,
      },
    );
  } catch (error) {
    if (isAbortOrTimeoutError(error)) {
      throw new WorkflowWorkerError(
        "assemblyai_transcription_poll_failed",
        "AssemblyAI transcription poll timed out",
      );
    }
    throw error;
  }

  const payload = await parseJsonResponse(response);

  if (!response.ok || !payload || typeof payload !== "object") {
    throw new WorkflowWorkerError(
      "assemblyai_transcription_poll_failed",
      getResponseMessage(
        payload,
        `AssemblyAI transcription poll failed with status ${response.status}`,
      ),
      workflowHttpFailureDisposition(response.status),
    );
  }

  return payload as Record<string, unknown>;
}

/**
 * Submits the transcription job to AssemblyAI. Fast path: presign a download
 * URL for the source object already sitting in R2 and hand that straight to
 * AssemblyAI as `audio_url` — AssemblyAI accepts a plain HTTPS URL (audio or
 * video) directly, so this skips downloading the whole source, transcoding
 * it locally, and re-uploading the extracted audio (a ~2.5GB GET + ffmpeg +
 * ~28MB PUT round trip for a 60-min 4K source). Falls back to the previous
 * download -> extract -> upload path if presigning isn't available (R2 not
 * configured) or AssemblyAI rejects/can't fetch the presigned URL.
 */
async function submitAssemblyAiJob(
  run: WorkflowRunJob,
  apiKey: string,
  reportProgress: WorkflowAttemptContext["reportProgress"],
  options: { languageCode: string | null },
): Promise<{ transcriptId: string; submissionPath: "presigned_source" | "uploaded_audio" }> {
  const sourceStorageKey = run.project.sourceStorageKey;
  if (!sourceStorageKey) {
    throw new WorkflowWorkerError(
      "workflow_source_missing",
      "sourceStorageKey is required for transcription",
      "permanent",
    );
  }

  if (isR2Configured()) {
    try {
      const presignedUrl = await presignDownloadUrl({
        key: sourceStorageKey,
        expiresIn: getAssemblyAiPresignExpiresInSeconds(),
      });
      const transcriptId = await submitAssemblyAiTranscript(
        presignedUrl,
        apiKey,
        options,
      );
      log("info", "assemblyai_submission_path", {
        workflowRunId: run.id,
        projectId: run.projectId,
        path: "presigned_source",
      });
      return { transcriptId, submissionPath: "presigned_source" };
    } catch (error) {
      log("info", "assemblyai_presigned_submit_fallback", {
        workflowRunId: run.id,
        projectId: run.projectId,
        reason: "presign_or_submit_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  } else {
    log("info", "assemblyai_presigned_submit_fallback", {
      workflowRunId: run.id,
      projectId: run.projectId,
      reason: "r2_not_configured",
    });
  }

  // Fallback: download the source, extract a small audio track locally, and
  // upload just that to AssemblyAI.
  const tempDir = await mkdtemp(join(tmpdir(), "narriflow-stt-"));
  try {
    const sourceExt = extname(sourceStorageKey) || ".bin";
    const sourcePath = join(tempDir, `source${sourceExt}`);
    const audioPath = join(tempDir, "transcription-input.mp3");

    await downloadObjectToFile({ key: sourceStorageKey, filePath: sourcePath });
    await extractTranscriptionAudio(sourcePath, audioPath);
    await reportProgress(20);

    const uploadUrl = await uploadAssemblyAiAudio(audioPath, apiKey);
    await reportProgress(30);

    const transcriptId = await submitAssemblyAiTranscript(
      uploadUrl,
      apiKey,
      options,
    );
    log("info", "assemblyai_submission_path", {
      workflowRunId: run.id,
      projectId: run.projectId,
      path: "uploaded_audio",
    });
    return { transcriptId, submissionPath: "uploaded_audio" };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const DEFAULT_STT_RESULT_POLL_BATCH_SIZE = 10;

function getSttResultPollBatchSize(): number {
  const value = Number(process.env.STT_RESULT_POLL_BATCH_SIZE);
  return Number.isFinite(value) && value > 0
    ? Math.round(value)
    : DEFAULT_STT_RESULT_POLL_BATCH_SIZE;
}

async function extractTranscriptionAudio(
  inputPath: string,
  outputPath: string,
) {
  await execCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    outputPath,
  ]);
}

/**
 * Submit-and-release phase: submits the AssemblyAI job and returns as soon as
 * the provider job id is persisted. The transcription itself — 10-40 minutes
 * of provider wall-clock for a podcast — is awaited by
 * processSubmittedTranscriptResults on its own poll loop, so this claim never
 * holds its poll slot for longer than the submission round trip.
 */
export async function processTranscriptRun(
  attempt: ClaimedWorkflowAttempt,
  context: WorkflowAttemptContext,
) {
  const run: WorkflowRunJob = { ...attempt, id: attempt.workflowRunId };
  const { signal } = context;
  signal?.throwIfAborted();
  log("info", "transcription_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
  });

  try {
    if (!run.project.sourceStorageKey) {
      throw new WorkflowWorkerError(
        "workflow_source_missing",
        "sourceStorageKey is required for transcription",
        "permanent",
      );
    }

    const apiKey = getRequiredAssemblyAiApiKey();
    const languageCode = await projectService.getProjectLanguageCode(
      run.projectId,
    );

    const submitStartedAtMs = Date.now();
    const { transcriptId } = await submitAssemblyAiJob(
      run,
      apiKey,
      context.reportProgress,
      { languageCode },
    );
    signal?.throwIfAborted();
    const submitMs = Date.now() - submitStartedAtMs;
    await getWorkflowRunLifecycle().waitForProvider(attempt, {
      providerJobId: transcriptId,
      nextPollAt: new Date(Date.now() + 5_000),
    });
    await context.reportProgress(40);

    log("info", "transcription_run_submitted", {
      workflowRunId: run.id,
      projectId: run.projectId,
      transcriptId,
      submitMs,
    });
  } catch (error) {
    await settleTranscriptRunFailure(run, attempt, error);
  }
}

async function settleTranscriptRunFailure(
  run: { id: string; projectId: string },
  attempt: WorkflowAttemptRef,
  error: unknown,
) {
  rethrowWorkflowAttemptLost(error);
  const failure = workflowFailureFromUnknown(error);
  const code = failure.code;
  const message =
    error instanceof Error ? error.message : "Unknown worker error";
  await getWorkflowRunLifecycle().failAttempt(attempt, failure);
  log("error", "transcription_run_failed", {
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

async function finalizeCompletedTranscript(
  run: { id: string; projectId: string; providerJobId: string },
  attempt: WorkflowAttemptRef,
  assemblyAiPayload: Record<string, unknown>,
) {
  const normalized = normalizeAssemblyAiTranscript(assemblyAiPayload);
  const rawStorageKey = `projects/${run.projectId}/transcripts/${run.id}-assemblyai-${sanitizeFileName(
    normalized.providerModel ?? "unknown-model",
  )}.json`;

  await putJson({
    key: rawStorageKey,
    value: assemblyAiPayload,
    metadata: {
      project_id: run.projectId,
      workflow_run_id: run.id,
      provider: "assemblyai",
      ...(normalized.providerModel ? { model: normalized.providerModel } : {}),
      ...(normalized.providerJobId
        ? { provider_job_id: normalized.providerJobId }
        : {}),
    },
  });

  await getWorkflowRunLifecycle().completeTranscript(attempt, {
      provider: normalized.provider,
      providerModel: normalized.providerModel,
      providerJobId: normalized.providerJobId,
      languageCode: normalized.languageCode,
      languageConfidence: normalized.languageConfidence,
      text: normalized.text,
      utterances: normalized.utterances,
      speakerCount: normalized.speakerCount,
      durationSeconds: normalized.durationSeconds,
      rawStorageKey,
    });

  log("info", "transcription_run_completed", {
    workflowRunId: run.id,
    projectId: run.projectId,
    utteranceCount: normalized.utterances.length,
    providerModel: normalized.providerModel,
    languageCode: normalized.languageCode,
    languageConfidence: normalized.languageConfidence,
  });
}

/**
 * Result-poll phase, driven by its own loop in index.ts. Claims submitted
 * transcripts via a per-tick next-poll claim
 * so replicas never double-poll, checks AssemblyAI once per claim, and settles
 * only on a definitive outcome:
 *  - completed  -> store raw payload + finalize the run (idempotent downstream)
 *  - error      -> fail the run (auto-retry policy applies)
 *  - overall timeout since submission -> fail the run
 * A transient GET failure just skips the run until the next tick — the overall
 * timeout is the backstop, so a permanently broken job id cannot poll forever.
 * Returns the number of runs settled (completed or failed) this tick.
 */
export async function processSubmittedTranscriptResults(): Promise<number> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!apiKey) {
    return 0;
  }

  const pollIntervalMs = getAssemblyAiPollIntervalMs();
  const pollTimeoutMs = getAssemblyAiPollTimeoutMs();
  const attempts = await getWorkflowRunLifecycle().claimDueWaitingTranscripts(
    getSttResultPollBatchSize(),
    pollIntervalMs,
  );

  let settled = 0;

  for (const attempt of attempts) {
    const run = { ...attempt, id: attempt.workflowRunId };
    const pollOne = async () => {
      try {
      // Timeout is checked BEFORE the provider GET so that persistently
      // failing polls (a revoked key, a 404'd job id, a broken finalize) are
      // still bounded by it — every claim refreshes the run's heartbeat, so
      // the reaper alone would never fire for this failure mode.
      const elapsedMs = Date.now() - run.submittedAt.getTime();
      if (elapsedMs > pollTimeoutMs) {
        await settleTranscriptRunFailure(
          run,
          attempt,
          new WorkflowWorkerError(
            "assemblyai_transcription_timeout",
            "AssemblyAI transcription did not complete before the polling timeout",
          ),
        );
        settled += 1;
        return;
      }

      const payload = await getAssemblyAiTranscript(run.providerJobId, apiKey);
      const status = payload.status;

      if (status === "completed") {
        await finalizeCompletedTranscript(run, attempt, payload);
        log("info", "transcription_provider_timing", {
          workflowRunId: run.id,
          projectId: run.projectId,
          providerMs: Date.now() - run.submittedAt.getTime(),
        });
        settled += 1;
        return;
      }

      if (status === "error") {
        await settleTranscriptRunFailure(
          run,
          attempt,
          new WorkflowWorkerError(
            "assemblyai_transcription_failed",
            getResponseMessage(payload, "AssemblyAI transcription failed"),
          ),
        );
        settled += 1;
        return;
      }

      const elapsedRatio = Math.min(1, elapsedMs / pollTimeoutMs);
      await getWorkflowRunLifecycle().reportProgress(
        attempt,
        Math.min(90, 40 + Math.round(elapsedRatio * 45)),
      );
      } catch (error) {
        rethrowWorkflowAttemptLost(error);
        const failure = workflowFailureFromUnknown(error);
        if (failure.disposition === "permanent") {
          await settleTranscriptRunFailure(run, attempt, failure);
          settled += 1;
          return;
        }
        log("info", "assemblyai_result_poll_transient", {
          workflowRunId: run.id,
          projectId: run.projectId,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    };

    try {
      await pollOne();
    } catch (error) {
      if (!(error instanceof WorkflowAttemptLost)) throw error;
      log("info", "transcription_stale_poll_discarded", {
        workflowRunId: run.id,
        projectId: run.projectId,
        attemptId: attempt.attemptId,
      });
    }
  }

  return settled;
}
