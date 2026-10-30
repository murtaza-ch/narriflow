import { openAsBlob } from "node:fs";
import { extname, join } from "node:path";
import {
  downloadObjectToFile,
  finalizeScribeTranscript,
  getWorkflowRunLifecycle,
  presignDownloadUrl,
  projectService,
  rethrowWorkflowAttemptLost,
  WorkflowAttemptLost,
  WorkflowFailure,
  workflowFailureFromUnknown,
  type ClaimedWorkflowAttempt,
  type CompleteTranscriptInput,
  type ProviderAttemptKey,
  type ProviderSettlementResult,
  type WaitingWorkflowAttempt,
  type WorkflowAttemptContext,
  type WorkflowAttemptRef,
} from "@narriflow/services";
import { isR2Configured } from "@narriflow/services/r2-storage";
import {
  fitSuppliedUtterances,
  SCRIBE_MODEL_ID,
  toProviderLanguageCode,
  type TranscriptPlan,
} from "@narriflow/validators";
import { probeSourceLanguage } from "../language-probe";
import { notifyWorkflowFailureAfterSettlement } from "../notifications";
import { productionWorkerProcessModule, type WorkerProcessModule } from "../worker-process";

const SCRIBE_BASE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const SCRIBE_TRANSCRIPTS_URL = `${SCRIBE_BASE_URL}/transcripts`;

const TRANSCRIPTION_FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;
/** The submission deadline (D1): past it a run with no recorded acceptance is failed and resubmitted. */
const SUBMISSION_DEADLINE_MS = 10 * 60 * 1000;
/** A URL submission is a small JSON-sized request; Scribe fetches the media itself. */
const URL_SUBMIT_TIMEOUT_MS = 60 * 1000;
/** An audio upload must finish well inside the submission deadline. */
const FILE_SUBMIT_TIMEOUT_MS = 8 * 60 * 1000;
const RESULT_GET_TIMEOUT_MS = 30 * 1000;
/** First result check after acceptance; the webhook is the fast path. */
const FIRST_RESULT_CHECK_DELAY_MS = 30 * 1000;
const DEFAULT_RESULT_POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_RESULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RESULT_POLL_BATCH_SIZE = 10;

/**
 * The remote-URL path hands Scribe a presigned link. The vendor guarantees
 * `source_url` fetches only up to 2 GiB; larger sources upload extracted audio.
 * The link outlives the submission deadline, a retried fetch and the result
 * window.
 */
const SOURCE_URL_MAX_BYTES = 2 * 1024 ** 3;
const SOURCE_URL_LIFETIME_SECONDS = 4 * 60 * 60;

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

function positiveNumberFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getResultPollIntervalMs() {
  return positiveNumberFromEnv("ELEVENLABS_RESULT_POLL_INTERVAL_MS", DEFAULT_RESULT_POLL_INTERVAL_MS);
}

function getResultTimeoutMs() {
  return positiveNumberFromEnv("ELEVENLABS_RESULT_TIMEOUT_MS", DEFAULT_RESULT_TIMEOUT_MS);
}

function getResultPollBatchSize() {
  return Math.round(positiveNumberFromEnv("STT_RESULT_POLL_BATCH_SIZE", DEFAULT_RESULT_POLL_BATCH_SIZE));
}

function getScribeSubmitConfig() {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    throw new WorkflowWorkerError(
      "elevenlabs_api_key_missing",
      "ELEVENLABS_API_KEY is not configured",
      "permanent",
    );
  }
  const webhookId = process.env.ELEVENLABS_WEBHOOK_ID?.trim();
  if (!webhookId) {
    throw new WorkflowWorkerError(
      "elevenlabs_webhook_not_configured",
      "ELEVENLABS_WEBHOOK_ID is not configured",
      "permanent",
    );
  }
  return { apiKey, webhookId };
}

// ---------------------------------------------------------------------------
// Provider error classification (D13)
// ---------------------------------------------------------------------------

interface ScribeErrorDetail {
  type: string | null;
  code: string | null;
  status: string | null;
}

/** Scribe errors arrive as `{detail: {type, code, message, status}}`; validation
 * failures (422) carry a `detail` array and some gateways a bare string. Only
 * the machine-readable tokens are read: the provider's prose is never reused. */
export function scribeErrorDetail(payload: unknown): ScribeErrorDetail {
  const detail = (payload as { detail?: unknown } | null)?.detail;
  const record = detail && typeof detail === "object" && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : {};
  const token = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
  return { type: token(record.type), code: token(record.code), status: token(record.status) };
}

export type ScribeCallStage = "submit" | "result";

/**
 * Maps a failed HTTP response to a workflow failure. Permanent: missing
 * webhook configuration, authentication, exhausted quota, unsupported language,
 * and rejected media/requests. Retryable (bounded by the attempt policy): 408,
 * 429, concurrency/busy codes and 5xx.
 */
export function scribeHttpFailure(
  stage: ScribeCallStage,
  status: number,
  payload: unknown,
): WorkflowFailure {
  const detail = scribeErrorDetail(payload);
  const tokens = [detail.code, detail.status, detail.type].filter(Boolean).join(" ");
  const label = `Scribe ${stage} failed with status ${status}${detail.code ? ` (${detail.code})` : ""}`;
  const permanent = (code: string) => new WorkflowWorkerError(code, label, "permanent");

  if (/no_webhooks_configured|webhook/.test(tokens) && status >= 400 && status < 500) {
    return permanent("elevenlabs_webhook_not_configured");
  }
  if (/quota|insufficient|credits|billing|payment/.test(tokens)) {
    return permanent("elevenlabs_quota_exhausted");
  }
  if (
    status === 429 ||
    status === 408 ||
    /too_many|concurrent|system_busy|rate_limit|overload/.test(tokens)
  ) {
    return new WorkflowWorkerError(retryableCode(stage), label, "retryable");
  }
  if (status === 401 || status === 403 || /api_key|unauthorized|forbidden|permission/.test(tokens)) {
    return permanent("elevenlabs_auth_failed");
  }
  if (status >= 500) {
    return new WorkflowWorkerError(retryableCode(stage), label, "retryable");
  }
  if (/language/.test(tokens)) {
    return permanent("elevenlabs_invalid_language");
  }
  // A result GET answering 404 with any other code means the id is not ours to
  // read (wrong account or key), which is configuration, not media.
  if (stage === "result" && status === 404) return permanent("elevenlabs_auth_failed");
  return permanent("elevenlabs_invalid_media");
}

function retryableCode(stage: ScribeCallStage) {
  return stage === "submit" ? "elevenlabs_transcription_submit_failed" : "elevenlabs_transcript_fetch_failed";
}

function isAbortOrTimeoutError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** A transport failure (network, timeout) is retryable at the attempt level. */
function scribeTransportFailure(stage: ScribeCallStage, error: unknown): WorkflowFailure {
  const reason = isAbortOrTimeoutError(error) ? "timed out" : "failed";
  return new WorkflowWorkerError(retryableCode(stage), `Scribe ${stage} request ${reason}`, "retryable");
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export type ScribeSubmitInput =
  | { kind: "url"; sourceUrl: string }
  | { kind: "file"; path: string };

export interface ScribeSubmitRequest {
  apiKey: string;
  webhookId: string;
  workflowRunId: string;
  attemptId: string;
  /** Provider (ISO 639-3) code; absent means Scribe auto-detects. */
  languageCode: string | null;
  input: ScribeSubmitInput;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ScribeAcceptance {
  requestId: string;
  transcriptionId: string;
}

/** The multipart field set of the full, webhook-delivered transcription (D3). */
export async function buildScribeSubmitForm(request: Omit<ScribeSubmitRequest, "apiKey" | "signal" | "fetchImpl">) {
  const form = new FormData();
  form.set("model_id", SCRIBE_MODEL_ID);
  form.set("diarize", "true");
  form.set("timestamps_granularity", "word");
  form.set("tag_audio_events", "false");
  form.set("webhook", "true");
  form.set("webhook_id", request.webhookId);
  form.set(
    "webhook_metadata",
    JSON.stringify({ workflowRunId: request.workflowRunId, attemptId: request.attemptId }),
  );
  if (request.languageCode) form.set("language_code", request.languageCode);
  if (request.input.kind === "url") {
    form.set("source_url", request.input.sourceUrl);
  } else {
    // A disk-backed Blob: the body streams from the file instead of being
    // read into memory.
    form.set("file", await openAsBlob(request.input.path, { type: "audio/mpeg" }), "transcription-input.mp3");
  }
  return form;
}

/**
 * One POST, never retried here: a timed-out request may already have started
 * paid work, so the attempt fails and the next attempt resubmits (D1).
 * Throws a classified WorkflowFailure.
 */
export async function submitScribeTranscription(request: ScribeSubmitRequest): Promise<ScribeAcceptance> {
  const timeoutMs = request.input.kind === "url" ? URL_SUBMIT_TIMEOUT_MS : FILE_SUBMIT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await (request.fetchImpl ?? fetch)(SCRIBE_BASE_URL, {
      method: "POST",
      headers: { "xi-api-key": request.apiKey },
      body: await buildScribeSubmitForm(request),
      signal: AbortSignal.any([
        ...(request.signal ? [request.signal] : []),
        AbortSignal.timeout(timeoutMs),
      ]),
    });
  } catch (error) {
    request.signal?.throwIfAborted();
    throw scribeTransportFailure("submit", error);
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw scribeHttpFailure("submit", response.status, payload);

  const requestId = payload?.request_id;
  const transcriptionId = payload?.transcription_id;
  if (typeof requestId !== "string" || !requestId || typeof transcriptionId !== "string" || !transcriptionId) {
    throw new WorkflowWorkerError(
      "elevenlabs_transcription_submit_failed",
      "Scribe accepted the request but returned no transcription id",
    );
  }
  return { requestId, transcriptionId };
}

export type ScribeFetchResult =
  | { kind: "ready"; payload: Record<string, unknown> }
  | { kind: "pending" }
  | { kind: "transient"; failure: WorkflowFailure }
  | { kind: "failed"; failure: WorkflowFailure };

/** GET of a finished transcript. Safe to repeat; the caller decides what each outcome means. */
export async function fetchScribeTranscript(
  transcriptionId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ScribeFetchResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${SCRIBE_TRANSCRIPTS_URL}/${encodeURIComponent(transcriptionId)}`, {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(RESULT_GET_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "transient", failure: scribeTransportFailure("result", error) };
  }

  const payload = await response.json().catch(() => null);
  if (response.ok) {
    return payload && typeof payload === "object"
      ? { kind: "ready", payload: payload as Record<string, unknown> }
      : {
          kind: "transient",
          failure: new WorkflowWorkerError(
            "elevenlabs_transcript_fetch_failed",
            "Scribe returned an unreadable transcript",
          ),
        };
  }
  if (response.status === 404 && scribeErrorDetail(payload).code === "transcript_not_found") {
    return { kind: "pending" };
  }
  const failure = scribeHttpFailure("result", response.status, payload);
  return { kind: failure.disposition === "permanent" ? "failed" : "transient", failure };
}

/** Downloads the source and extracts mono 16 kHz audio into a scratch directory that lives for `use`. */
async function withExtractedAudio<T>(
  request: { sourceStorageKey: string; workerProcess: WorkerProcessModule; signal: AbortSignal },
  use: (audioPath: string) => Promise<T>,
): Promise<T> {
  const { sourceStorageKey, workerProcess, signal } = request;
  return workerProcess.withScratchDirectory("narriflow-stt-", async (tempDir) => {
    const sourcePath = join(tempDir, `source${extname(sourceStorageKey) || ".bin"}`);
    const audioPath = join(tempDir, "transcription-input.mp3");
    await downloadObjectToFile({ key: sourceStorageKey, filePath: sourcePath, signal });
    await workerProcess.execute({
      command: "ffmpeg",
      args: ["-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioPath],
      signal,
      deadlineMs: TRANSCRIPTION_FFMPEG_TIMEOUT_MS,
    });
    return use(audioPath);
  });
}

/** Presigned source URL for the remote-fetch path and the language probe; null when unavailable. */
async function presignSourceUrl(run: WorkflowRunJob, sourceStorageKey: string): Promise<string | null> {
  if (!isR2Configured()) {
    log("info", "scribe_presign_unavailable", { workflowRunId: run.id, reason: "r2_not_configured" });
    return null;
  }
  try {
    return await presignDownloadUrl({ key: sourceStorageKey, expiresIn: SOURCE_URL_LIFETIME_SECONDS });
  } catch (error) {
    log("info", "scribe_presign_unavailable", {
      workflowRunId: run.id,
      reason: "presign_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

/**
 * The source reaches Scribe by URL on a first attempt for a source within the
 * vendor's remote-fetch size; a retry (the URL fetch may be what failed), a
 * larger source, or a failed presign sends extracted audio instead.
 */
export function chooseSubmitInputKind(input: {
  attemptCount: number;
  sourceSizeBytes: bigint | number | null;
  presignedUrl: string | null;
}): "url" | "file" {
  if (!input.presignedUrl || input.attemptCount !== 1) return "file";
  if (input.sourceSizeBytes === null || Number(input.sourceSizeBytes) > SOURCE_URL_MAX_BYTES) return "file";
  return "url";
}

/** The two persistence calls that decide whether speech-to-text runs at all. */
interface TranscriptionSkipAdapters {
  transcriptPlan: typeof projectService.getTranscriptPlanForWorker;
  completeTranscript: (attempt: WorkflowAttemptRef, input: CompleteTranscriptInput) => Promise<void>;
}

const productionSkipAdapters: TranscriptionSkipAdapters = {
  transcriptPlan: (run) => projectService.getTranscriptPlanForWorker(run),
  completeTranscript: (attempt, input) => getWorkflowRunLifecycle().completeTranscript(attempt, input),
};

/** Everything `processTranscriptRun` touches outside the claimed attempt, so tests drive it without a database or network. */
export interface TranscriptSubmitAdapters {
  lifecycle: Pick<
    ReturnType<typeof getWorkflowRunLifecycle>,
    "beginProviderSubmission" | "recordProviderAcceptance" | "failProviderAttempt" | "failAttempt"
  >;
  languageCode: (projectId: string) => Promise<string | null>;
  presign: typeof presignSourceUrl;
  probe: typeof probeSourceLanguage;
  submit: typeof submitScribeTranscription;
  withExtractedAudio: typeof withExtractedAudio;
  notifyFailure: typeof notifyWorkflowFailureAfterSettlement;
  now: () => number;
}

const productionSubmitAdapters: TranscriptSubmitAdapters = {
  get lifecycle() {
    return getWorkflowRunLifecycle();
  },
  languageCode: (projectId) => projectService.getProjectLanguageCodeForWorker(projectId),
  presign: presignSourceUrl,
  probe: probeSourceLanguage,
  submit: submitScribeTranscription,
  withExtractedAudio,
  notifyFailure: notifyWorkflowFailureAfterSettlement,
  now: () => Date.now(),
};

/**
 * Submit-and-release phase: submits the Scribe job and returns as soon as its
 * acceptance is recorded. The transcription itself is delivered by webhook or
 * fetched by `processSubmittedTranscriptResults`, so this claim only holds its
 * slot for the submission round trip.
 *
 * The run turns `waiting` (with a deadline) *before* the POST leaves, so a
 * crash or timeout between the POST and the recorded acceptance is recovered
 * by the deadline instead of stalling or double-billing silently.
 */
export async function processTranscriptRun(
  attempt: ClaimedWorkflowAttempt,
  context: WorkflowAttemptContext,
  workerProcess: WorkerProcessModule = productionWorkerProcessModule,
  skip: TranscriptionSkipAdapters = productionSkipAdapters,
  adapters: TranscriptSubmitAdapters = productionSubmitAdapters,
) {
  const run: WorkflowRunJob = { ...attempt, id: attempt.workflowRunId };
  const { signal } = context;
  signal?.throwIfAborted();
  log("info", "transcription_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
  });

  // After beginProviderSubmission the run is `waiting`: failures settle through the provider path.
  let submissionBegun = false;
  try {
    const sourceStorageKey = run.project.sourceStorageKey;
    if (!sourceStorageKey) {
      throw new WorkflowWorkerError(
        "workflow_source_missing",
        "sourceStorageKey is required for transcription",
        "permanent",
      );
    }

    // Speech-to-text is skipped for supplied or declined captions and for a
    // source with no audio stream; the transcript then completes at once.
    const skipped = await skip.transcriptPlan({
      projectId: run.projectId,
      contentPackId: attempt.contentPackId,
    });
    signal?.throwIfAborted();
    if (skipped.plan.kind !== "speech_to_text") {
      await completeWithoutSpeechToText(run, attempt, { ...skipped, plan: skipped.plan }, skip.completeTranscript);
      return;
    }

    const { apiKey, webhookId } = getScribeSubmitConfig();
    const key: ProviderAttemptKey = { workflowRunId: run.id, attemptId: attempt.attemptId };
    const presignedUrl = await adapters.presign(run, sourceStorageKey);
    signal?.throwIfAborted();

    const requestedLanguage = toProviderLanguageCode(await adapters.languageCode(run.projectId));
    let languageCode = requestedLanguage;
    if (!requestedLanguage) {
      const durationSeconds = attempt.project.sourceDurationSeconds ?? skipped.durationSeconds;
      if (presignedUrl && durationSeconds) {
        const probe = await adapters.probe({
          sourceUrl: presignedUrl,
          durationSeconds,
          signal,
          workerProcess,
          apiKey,
        });
        languageCode = probe.pinned ? (toProviderLanguageCode(probe.pinned) ?? null) : null;
        log("info", "scribe_language_probe", {
          workflowRunId: run.id,
          projectId: run.projectId,
          pinned: probe.pinned,
          detected: probe.detected,
          probability: probe.probability,
          wordCount: probe.wordCount,
          reason: probe.reason,
        });
      }
    }

    const inputKind = chooseSubmitInputKind({
      attemptCount: attempt.attemptCount,
      sourceSizeBytes: attempt.project.sourceSizeBytes,
      presignedUrl,
    });

    const submitStartedAtMs = adapters.now();
    const submitWith = async (input: ScribeSubmitInput) => {
      // The deadline starts only now: preparing the upload can take minutes.
      await adapters.lifecycle.beginProviderSubmission(attempt, {
        deadline: new Date(adapters.now() + SUBMISSION_DEADLINE_MS),
      });
      submissionBegun = true;
      const accepted = await adapters.submit({
        apiKey,
        webhookId,
        workflowRunId: run.id,
        attemptId: attempt.attemptId,
        languageCode,
        input,
        signal,
      });
      const settlement = await adapters.lifecycle.recordProviderAcceptance(key, {
        ...accepted,
        nextPollAt: new Date(adapters.now() + FIRST_RESULT_CHECK_DELAY_MS),
      });
      log("info", "transcription_run_submitted", {
        workflowRunId: run.id,
        projectId: run.projectId,
        requestId: accepted.requestId,
        transcriptionId: accepted.transcriptionId,
        path: input.kind === "url" ? "presigned_source" : "uploaded_audio",
        language: languageCode,
        acceptance: settlement.kind,
        submitMs: adapters.now() - submitStartedAtMs,
      });
    };

    if (inputKind === "url" && presignedUrl) {
      await submitWith({ kind: "url", sourceUrl: presignedUrl });
      return;
    }

    await adapters.withExtractedAudio({ sourceStorageKey, workerProcess, signal }, async (audioPath) => {
      await context.reportProgress(20);
      await submitWith({ kind: "file", path: audioPath });
    });
  } catch (error) {
    signal.throwIfAborted();
    await settleTranscriptRunFailure(run, attempt, error, adapters, submissionBegun);
  }
}

/** Completes the transcript from supplied captions, or empty. An empty
 * transcript is valid here: a caption-only generation needs no speech. */
async function completeWithoutSpeechToText(
  run: { id: string; projectId: string },
  attempt: WorkflowAttemptRef,
  input: { plan: Exclude<TranscriptPlan, { kind: "speech_to_text" }>; durationSeconds: number | null; languageCode: string | null },
  completeTranscript: TranscriptionSkipAdapters["completeTranscript"],
) {
  const utterances = input.plan.kind === "supplied"
    ? fitSuppliedUtterances(input.plan.utterances, input.durationSeconds ?? Number.POSITIVE_INFINITY)
    : [];
  await completeTranscript(attempt, {
    provider: input.plan.kind === "supplied" ? "supplied_captions" : "none",
    providerModel: null,
    providerJobId: null,
    languageCode: input.languageCode,
    languageConfidence: null,
    text: utterances.map((utterance) => utterance.text).join(" "),
    utterances,
    speakerCount: utterances.length > 0 ? 1 : 0,
    durationSeconds: input.durationSeconds,
    rawStorageKey: null,
  });
  log("info", "transcription_run_skipped", {
    workflowRunId: run.id,
    projectId: run.projectId,
    reason: input.plan.kind === "supplied" ? "captions_supplied" : input.plan.reason,
    utteranceCount: utterances.length,
  });
}

/** Fails the attempt with the normal retry policy. A run already `waiting`
 * (submission begun) settles through the provider path, which treats a stale
 * or already-settled attempt as a no-op instead of an error. */
async function settleTranscriptRunFailure(
  run: { id: string; projectId: string },
  attempt: WorkflowAttemptRef,
  error: unknown,
  adapters: Pick<TranscriptSubmitAdapters, "lifecycle" | "notifyFailure">,
  submissionBegun: boolean,
) {
  rethrowWorkflowAttemptLost(error);
  const failure = workflowFailureFromUnknown(error);
  if (submissionBegun) {
    const settlement = await adapters.lifecycle.failProviderAttempt(
      { workflowRunId: run.id, attemptId: attempt.attemptId },
      failure,
    );
    if (settlement.kind !== "applied") {
      log("info", "transcription_failure_not_applied", {
        workflowRunId: run.id,
        projectId: run.projectId,
        code: failure.code,
        settlement: settlement.kind,
      });
      return;
    }
  } else {
    await adapters.lifecycle.failAttempt(attempt, failure);
  }
  log("error", "transcription_run_failed", {
    workflowRunId: run.id,
    projectId: run.projectId,
    code: failure.code,
    message: failure.message,
  });
  await adapters.notifyFailure({
    workflowRunId: run.id,
    projectId: run.projectId,
    errorCode: failure.code,
    reason: failure.message,
  });
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface TranscriptResultAdapters {
  lifecycle: Pick<
    ReturnType<typeof getWorkflowRunLifecycle>,
    | "claimDueWaitingTranscripts"
    | "expireUnconfirmedProviderSubmission"
    | "failProviderAttempt"
    | "reportProgress"
  >;
  finalize: (input: {
    key: ProviderAttemptKey;
    payload: Record<string, unknown>;
    providerIds: { transcriptionId: string };
  }) => Promise<ProviderSettlementResult>;
  fetchTranscript: typeof fetchScribeTranscript;
  notifyFailure: typeof notifyWorkflowFailureAfterSettlement;
  now: () => number;
}

const productionResultAdapters: TranscriptResultAdapters = {
  get lifecycle() {
    return getWorkflowRunLifecycle();
  },
  finalize: finalizeScribeTranscript,
  fetchTranscript: fetchScribeTranscript,
  notifyFailure: notifyWorkflowFailureAfterSettlement,
  now: () => Date.now(),
};

/**
 * Result phase, driven by its own loop in index.ts. The webhook is the fast
 * path (it makes a waiting run due now); this loop is the backstop and the only
 * path when no webhook arrives. Per claimed run:
 *  - no recorded id        -> expire the submission once its deadline passed
 *  - 200                   -> finalize (store raw JSON, normalize, complete)
 *  - 404 transcript_not_found, 429/5xx/network -> try again next tick, until
 *    the result deadline fails the attempt (retryable)
 *  - 401/403/other 404/4xx -> permanent failure
 * A ready transcript is always finalized, even past the deadline.
 * Returns the number of runs settled this tick.
 */
export async function processSubmittedTranscriptResults(
  adapters: TranscriptResultAdapters = productionResultAdapters,
): Promise<number> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return 0;

  const timeoutMs = getResultTimeoutMs();
  const attempts = await adapters.lifecycle.claimDueWaitingTranscripts(
    getResultPollBatchSize(),
    getResultPollIntervalMs(),
  );

  let settled = 0;
  for (const attempt of attempts) {
    try {
      if (await settleWaitingTranscript(attempt, apiKey, timeoutMs, adapters)) settled += 1;
    } catch (error) {
      if (!(error instanceof WorkflowAttemptLost)) throw error;
      log("info", "transcription_stale_poll_discarded", {
        workflowRunId: attempt.workflowRunId,
        projectId: attempt.projectId,
        attemptId: attempt.attemptId,
      });
    }
  }
  return settled;
}

/** One claimed waiting run; true when this call settled it (completed or failed). */
async function settleWaitingTranscript(
  attempt: WaitingWorkflowAttempt,
  apiKey: string,
  timeoutMs: number,
  adapters: TranscriptResultAdapters,
): Promise<boolean> {
  const key: ProviderAttemptKey = { workflowRunId: attempt.workflowRunId, attemptId: attempt.attemptId };
  const run = { id: attempt.workflowRunId, projectId: attempt.projectId };

  if (!attempt.providerJobId) {
    const settlement = await adapters.lifecycle.expireUnconfirmedProviderSubmission(key);
    if (settlement.kind === "applied") {
      log("error", "transcription_submission_unconfirmed", { workflowRunId: run.id, projectId: run.projectId });
    }
    return settlement.kind === "applied";
  }

  const transcriptionId = attempt.providerJobId;
  const elapsedMs = adapters.now() - attempt.submittedAt.getTime();
  const result = await adapters.fetchTranscript(transcriptionId, apiKey);

  if (result.kind === "ready") {
    const settlement = await adapters.finalize({
      key,
      payload: result.payload,
      providerIds: { transcriptionId },
    });
    log("info", "transcription_run_completed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      settlement: settlement.kind,
      providerMs: elapsedMs,
    });
    return settlement.kind === "applied";
  }

  if (result.kind === "failed") {
    return failWaitingTranscript(attempt, result.failure, adapters);
  }

  // Not ready, or a transient provider/network problem: wait for the next tick,
  // but never past the deadline (a revoked key's 5xx would otherwise poll forever).
  if (elapsedMs > timeoutMs) {
    return failWaitingTranscript(
      attempt,
      new WorkflowWorkerError(
        "elevenlabs_transcription_timeout",
        "Scribe transcription did not complete before the result deadline",
      ),
      adapters,
    );
  }
  if (result.kind === "transient") {
    log("info", "transcription_result_poll_transient", {
      workflowRunId: run.id,
      projectId: run.projectId,
      code: result.failure.code,
    });
    return false;
  }
  await adapters.lifecycle.reportProgress(attempt, Math.min(90, 40 + Math.round(Math.min(1, elapsedMs / timeoutMs) * 45)));
  return false;
}

async function failWaitingTranscript(
  attempt: WaitingWorkflowAttempt,
  failure: WorkflowFailure,
  adapters: TranscriptResultAdapters,
): Promise<boolean> {
  const settlement = await adapters.lifecycle.failProviderAttempt(
    { workflowRunId: attempt.workflowRunId, attemptId: attempt.attemptId },
    failure,
    { transcriptionId: attempt.providerJobId },
  );
  if (settlement.kind !== "applied") return false;
  log("error", "transcription_run_failed", {
    workflowRunId: attempt.workflowRunId,
    projectId: attempt.projectId,
    code: failure.code,
    message: failure.message,
  });
  await adapters.notifyFailure({
    workflowRunId: attempt.workflowRunId,
    projectId: attempt.projectId,
    errorCode: failure.code,
    reason: failure.message,
  });
  return true;
}
