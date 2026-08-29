import {
  createPendingUploadResume,
  createUploadFileFingerprint,
  loadUploadResume,
  saveUploadResume,
  type UploadResumeRecord,
  type UploadResumeStorage,
} from "./upload-resume";
import { authenticatedRequestFailureMessage } from "@/lib/authenticated-request-browser";

type UploadProgress = {
  stage: "prepare" | "upload" | "finalize";
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond?: number;
  etaSeconds?: number | null;
};

export type UploadSessionBrowserPhase =
  | "idle"
  | "preparing"
  | "uploading"
  | "paused"
  | "verifying"
  | "queued"
  | "failed";

export interface UploadSessionBrowserSnapshot {
  phase: UploadSessionBrowserPhase;
  progressPercent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  message: string;
  failureCode: string | null;
  canPause: boolean;
  canResume: boolean;
  canDiscard: boolean;
  canStartFresh: boolean;
}

export interface UploadSessionBrowserStartInput {
  file: File;
  title: string;
  brandTemplateId: string | null;
  generationContext: unknown;
}

export interface UploadSessionBrowserAdapterDependencies {
  storage: UploadResumeStorage | null;
  navigate(projectId: string): void;
  fetcher?: typeof fetch;
  createClientKey?: () => string;
  waitBeforeRetry?: (attempt: number) => Promise<void>;
  waitBeforePoll?: (delayMs: number) => Promise<void>;
  now?: () => number;
  progressClock?: () => number;
  random?: () => number;
  uploadTransport?: RunUploadSessionTransferInput["uploadTransport"];
}

export interface UploadSessionBrowserAdapter {
  snapshot(): UploadSessionBrowserSnapshot;
  subscribe(listener: () => void): () => void;
  start(input: UploadSessionBrowserStartInput): Promise<void>;
  pause(): Promise<void>;
  discard(): Promise<void>;
  startFresh(): Promise<void>;
  shouldConfirmUnload(): boolean;
  dispose(): void;
}

interface RunUploadSessionTransferInput {
  file: File;
  title: string;
  brandTemplateId: string | null;
  generationContext: unknown;
  storage: UploadResumeStorage | null;
  fetcher?: typeof fetch;
  createClientKey?: () => string;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  waitBeforeRetry?: (attempt: number) => Promise<void>;
  now?: () => number;
  progressClock?: () => number;
  random?: () => number;
  uploadTransport?: (input: {
    url: string;
    body: Blob;
    contentType?: string;
    signal?: AbortSignal;
    onProgress(loadedBytes: number): void;
  }) => Promise<{ etag: string | null }>;
}

type OpenOutcome =
  | {
      outcome: "terminal";
      sessionId: string;
      state: "aborted" | "expired" | "failed";
      failureCode: string | null;
      freshUploadAllowed: boolean;
    }
  | {
      outcome: "queued_for_ingest";
      sessionId: string;
      projectId: string;
    }
  | {
      outcome: "reconciling";
      sessionId: string;
      projectId: string;
      retryAfterSeconds: number;
    }
  | {
      outcome: "uploading";
      sessionId: string;
      projectId: string;
      transfer:
        | {
            kind: "single";
            contentType: string;
            grant: { url: string; contentType: string };
          }
        | {
            kind: "multipart";
            partSizeBytes: number;
            partCount: number;
            concurrency: number;
            grants: Array<{ partNumber: number; url: string }>;
            grantExpiresAt: string;
            completedParts: Array<{ partNumber: number; etag: string }>;
          };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function uploadUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function parseParts(
  value: unknown,
  partCount: number,
  requireUrl: boolean,
): Array<{ partNumber: number; url?: string; etag?: string }> | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<number>();
  const parts: Array<{ partNumber: number; url?: string; etag?: string }> = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.partNumber !== "number" ||
      !Number.isInteger(item.partNumber) ||
      item.partNumber < 1 ||
      item.partNumber > partCount ||
      seen.has(item.partNumber)
    ) {
      return null;
    }
    if (requireUrl && !uploadUrl(item.url)) return null;
    if (!requireUrl && typeof item.etag !== "string") return null;
    seen.add(item.partNumber);
    parts.push({
      partNumber: item.partNumber,
      ...(requireUrl ? { url: item.url as string } : { etag: item.etag as string }),
    });
  }
  return parts;
}

function parseOpenOutcome(value: unknown): OpenOutcome | null {
  if (!isRecord(value) || !isUuid(value.sessionId)) {
    return null;
  }
  if (
    value.outcome === "terminal" &&
    (value.state === "aborted" ||
      value.state === "expired" ||
      value.state === "failed") &&
    (value.failureCode === null || typeof value.failureCode === "string") &&
    typeof value.freshUploadAllowed === "boolean"
  ) {
    return {
      outcome: "terminal",
      sessionId: value.sessionId,
      state: value.state,
      failureCode: value.failureCode,
      freshUploadAllowed: value.freshUploadAllowed,
    };
  }
  if (!isUuid(value.projectId)) return null;
  if (value.outcome === "queued_for_ingest") {
    return {
      outcome: "queued_for_ingest",
      sessionId: value.sessionId,
      projectId: value.projectId,
    };
  }
  if (
    value.outcome === "reconciling" &&
    typeof value.retryAfterSeconds === "number" &&
    Number.isInteger(value.retryAfterSeconds) &&
    value.retryAfterSeconds > 0
  ) {
    return {
      outcome: "reconciling",
      sessionId: value.sessionId,
      projectId: value.projectId,
      retryAfterSeconds: value.retryAfterSeconds,
    };
  }
  if (value.outcome !== "uploading" || !isRecord(value.transfer)) return null;
  if (
    value.transfer.kind === "single" &&
    typeof value.transfer.contentType === "string" &&
    isRecord(value.transfer.grant) &&
    uploadUrl(value.transfer.grant.url) &&
    value.transfer.grant.contentType === value.transfer.contentType
  ) {
    return {
      outcome: "uploading",
      sessionId: value.sessionId,
      projectId: value.projectId,
      transfer: {
        kind: "single",
        contentType: value.transfer.contentType,
        grant: {
          url: value.transfer.grant.url,
          contentType: value.transfer.grant.contentType,
        },
      },
    };
  }
  const partCount = value.transfer.partCount;
  const partSizeBytes = value.transfer.partSizeBytes;
  const concurrency = value.transfer.concurrency;
  if (
    value.transfer.kind !== "multipart" ||
    typeof partCount !== "number" ||
    !Number.isInteger(partCount) ||
    partCount < 1 ||
    typeof partSizeBytes !== "number" ||
    !Number.isInteger(partSizeBytes) ||
    partSizeBytes < 1 ||
    typeof concurrency !== "number" ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 16
    || typeof value.transfer.grantExpiresAt !== "string"
    || !Number.isFinite(Date.parse(value.transfer.grantExpiresAt))
  ) {
    return null;
  }
  const grants = parseParts(value.transfer.grants, partCount, true);
  const completed = parseParts(value.transfer.completedParts, partCount, false);
  if (!grants || !completed) return null;
  return {
    outcome: "uploading",
    sessionId: value.sessionId,
    projectId: value.projectId,
    transfer: {
      kind: "multipart",
      partSizeBytes,
      partCount,
      concurrency,
      grants: grants as Array<{ partNumber: number; url: string }>,
      grantExpiresAt: value.transfer.grantExpiresAt,
      completedParts: completed as Array<{ partNumber: number; etag: string }>,
    },
  };
}

async function responsePayload(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

class UploadSessionBrowserFailure extends Error {
  constructor(readonly code: string, message: string,
  ) {
    super(message);
    this.name = "UploadSessionBrowserFailure";
  }
}

const UPLOAD_FAILURE_MESSAGES: Record<string, string> = {
  quota_exceeded:
    "Your workspace has reached its processing limit. Review usage before retrying.",
  upload_session_idempotency_conflict:
    "This saved upload belongs to different frozen settings. Discard it or re-select the original file.",
  upload_session_not_found:
    "Narriflow could not find this saved Upload Session.",
  upload_session_invalid_state:
    "This Upload Session changed state. Check its status before retrying.",
  upload_session_integrity_failed:
    "The stored object did not match the selected file. Start a fresh upload.",
  rate_limited: "Too many upload requests. Wait a moment, then retry.",
  upload_session_unavailable:
    "Upload storage is temporarily unavailable. Your saved session is unchanged.",
};

function responseError(
  response: Response,
  payload: unknown,
  fallback: string) {
  const payloadCode =
    isRecord(payload) && typeof payload.error === "string"
      ? payload.error
      : null;
  const code =
    payloadCode ??
    (response.status === 401
      ? "authentication_required"
      : response.status === 403
      ? "capability_denied"
      : response.status === 429
        ? "rate_limited"
        : response.status >= 500
          ? "upload_session_unavailable"
          : "upload_failed");
  const message =
    UPLOAD_FAILURE_MESSAGES[code] ??
    authenticatedRequestFailureMessage(
      isRecord(payload)
        ? {
            error: code,
            message:
              typeof payload.message === "string" ? payload.message : undefined,
            requestId:
              typeof payload.requestId === "string"
                ? payload.requestId
                : undefined,
            details: isRecord(payload.details) ? payload.details : undefined,
            retryAfterSeconds:
              Number(response.headers.get("Retry-After")) || undefined,
          }
        : { error: code },
      typeof window === "undefined"
      ? "/upload"
      : `${window.location.pathname}${window.location.search}`,
      fallback,
    );
  return new UploadSessionBrowserFailure(code, message);
}

class UploadHttpError extends Error {
  constructor(readonly status: number) {
    super(`Upload failed with HTTP ${status}`);
    this.name = "UploadHttpError";
  }
}

function stableBrowserFailure(error: unknown) {
  if (error instanceof UploadSessionBrowserFailure) return error;
  if (error instanceof UploadHttpError) {
    return new UploadSessionBrowserFailure(
      "upload_transfer_rejected",
      "Secure storage rejected this transfer. Re-select the exact file and try again.",
    );
  }
  if (error instanceof TypeError) {
    return new UploadSessionBrowserFailure(
      "upload_session_unavailable",
      UPLOAD_FAILURE_MESSAGES.upload_session_unavailable!,
    );
  }
  return new UploadSessionBrowserFailure(
    "upload_failed",
    "Narriflow could not continue this upload. Your saved session is unchanged.",
  );
}

export function uploadRetryDelayMs(
  failedAttempt: number,
  random: () => number = Math.random,
) {
  const exponentialMs = 500 * 2 ** Math.max(0, failedAttempt - 1);
  return Math.round(exponentialMs * (0.5 + random()));
}

function browserUploadTransport(input: {
  url: string;
  body: Blob;
  contentType?: string;
  signal?: AbortSignal;
  onProgress(loadedBytes: number): void;
}) {
  return new Promise<{ etag: string | null }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const removeAbortListener = () =>
      input.signal?.removeEventListener("abort", abortRequest);
    const settle = (
      callback: () => void) => {
      removeAbortListener();
      callback();
    };
    const abortRequest = () => request.abort();
    request.open("PUT", input.url);
    if (input.contentType) {
      request.setRequestHeader("Content-Type", input.contentType);
    }
    request.upload.addEventListener("progress", (event) => {
      input.onProgress(event.loaded);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        settle(() => resolve({ etag: request.getResponseHeader("ETag") }));
      } else {
        settle(() => reject(new UploadHttpError(request.status)));
      }
    });
    request.addEventListener("error", () => {
      settle(() => reject(new TypeError("Upload request failed")));
    });
    request.addEventListener("abort", () => {
      settle(() => reject(new DOMException("Upload paused", "AbortError")));
    });
    if (input.signal?.aborted) {
      request.abort();
      return;
    }
    input.signal?.addEventListener("abort", abortRequest, { once: true });
    request.send(input.body);
  });
}

async function putWithRetry(input: {
  fetcher: typeof fetch;
  url: string;
  body: Blob;
  contentType?: string;
  signal?: AbortSignal;
  waitBeforeRetry: (attempt: number) => Promise<void>;
  uploadTransport?: RunUploadSessionTransferInput["uploadTransport"];
  onProgress?: (loadedBytes: number) => void;
  refreshUrlAfterFailure?: (error: unknown) => Promise<string | null>;
}) {
  let lastError: unknown;
  let attempt = 1;
  let currentUrl = input.url;
  let refreshedAfterFailure = false;
  while (attempt <= 3) {
    try {
      if (input.uploadTransport) {
        return await input.uploadTransport({
          url: currentUrl,
          body: input.body,
          contentType: input.contentType,
          signal: input.signal,
          onProgress: input.onProgress ?? (() => {}),
        });
      }
      const response = await input.fetcher(currentUrl, {
        method: "PUT",
        ...(input.contentType
          ? { headers: { "Content-Type": input.contentType } }
          : {}),
        body: input.body,
        signal: input.signal,
      });
      if (!response.ok) throw new UploadHttpError(response.status);
      input.onProgress?.(input.body.size);
      return {
        etag: response.headers.get("ETag") ?? response.headers.get("etag"),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (!refreshedAfterFailure && input.refreshUrlAfterFailure) {
        const refreshedUrl = await input.refreshUrlAfterFailure(error);
        if (refreshedUrl) {
          currentUrl = refreshedUrl;
          refreshedAfterFailure = true;
          continue;
        }
      }
      if (
        error instanceof UploadHttpError &&
        error.status !== 408 &&
        error.status !== 429 &&
        error.status < 500
      ) {
        throw error;
      }
      lastError = error;
      if (attempt < 3) await input.waitBeforeRetry(attempt);
      attempt += 1;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Upload failed");
}

async function runUploadSessionTransfer(
  input: RunUploadSessionTransferInput) {
  const fetcher = input.fetcher ?? fetch;
  const uploadTransport =
    input.uploadTransport ?? (input.fetcher ? undefined : browserUploadTransport);
  const waitBeforeRetry =
    input.waitBeforeRetry ??
    ((attempt: number) =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, uploadRetryDelayMs(attempt, input.random)),
      ));
  const fingerprint = createUploadFileFingerprint(input.file);
  const existing = input.storage
    ? loadUploadResume(input.storage, fingerprint)
    : null;
  let resume: UploadResumeRecord =
    existing ??
    createPendingUploadResume({
      clientIdempotencyKey:
        input.createClientKey?.() ?? globalThis.crypto.randomUUID(),
      fingerprint,
      fileName: input.file.name,
      title: input.title,
    });
  if (input.storage) saveUploadResume(input.storage, resume);
  input.onProgress?.({
    stage: "prepare",
    percent: 0,
    transferredBytes: 0,
    totalBytes: input.file.size,
  });

  const contentType = input.file.type || "video/mp4";
  const openedResponse = await fetcher(
    existing
      ? "/api/upload-sessions/status"
      : "/api/upload-sessions/open",
    {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      existing
        ? {
            clientIdempotencyKey: resume.clientIdempotencyKey,
            sessionId: resume.sessionId,
            browserFingerprint: fingerprint,
          }
        : {
            clientIdempotencyKey: resume.clientIdempotencyKey,
            title: input.title,
            source: {
              fileName: input.file.name,
              sizeBytes: input.file.size,
              contentType,
              browserFingerprint: fingerprint,
            },
            brandTemplateId: input.brandTemplateId,
            generationContext: input.generationContext,
          },
    ),
    signal: input.signal,
    },
  );
  const openedPayload = await responsePayload(openedResponse);
  if (!openedResponse.ok) {
    throw responseError(
      openedResponse,
      openedPayload,
      "Failed to open Upload Session.",
    );
  }
  const opened = parseOpenOutcome(openedPayload);
  if (!opened) throw new Error("The upload service returned an invalid contract.");
  if (opened.outcome === "terminal") return opened;
  if (opened.outcome === "queued_for_ingest") {
    if (input.storage) saveUploadResume(input.storage, null);
    return { projectId: opened.projectId };
  }
  if (opened.outcome === "reconciling") {
    return opened;
  }

  resume = {
    ...resume,
    sessionId: opened.sessionId,
    projectId: opened.projectId,
  };
  if (input.storage) saveUploadResume(input.storage, resume);

  let completedParts: Array<{ partNumber: number; etag: string }> = [];
  if (opened.transfer.kind === "single") {
    input.onProgress?.({
      stage: "upload",
      percent: 0,
      transferredBytes: 0,
      totalBytes: input.file.size,
    });
    await putWithRetry({
      fetcher,
      url: opened.transfer.grant.url,
      body: input.file,
      contentType: opened.transfer.grant.contentType,
      signal: input.signal,
      waitBeforeRetry,
      uploadTransport,
    });
    input.onProgress?.({
      stage: "upload",
      percent: 100,
      transferredBytes: input.file.size,
      totalBytes: input.file.size,
    });
  } else {
    const transfer = opened.transfer;
    const completedByPartNumber = new Map(
      transfer.completedParts.map((part) => [part.partNumber, part.etag]),
    );
    const completedNumbers = new Set(
      completedByPartNumber.keys());
    let storedBytes = Array.from(completedNumbers).reduce(
      (total, partNumber) => {
        const start = (partNumber - 1) * transfer.partSizeBytes;
        return (
          total +
          Math.max(
            0,
            Math.min(start + transfer.partSizeBytes, input.file.size) -
              start,
          )
        );
      },
      0,
    );
    const activeBytes = new Map<number, number>();
    const initialStoredBytes = storedBytes;
    const progressClock = input.progressClock ?? Date.now;
    const progressStartedAt = progressClock();
    const reportProgress = () => {
      const transferredBytes = Math.min(
        input.file.size,
        storedBytes +
          Array.from(activeBytes.values()).reduce(
            (total, loadedBytes) => total + loadedBytes,
            0,
          ),
      );
      const elapsedSeconds = Math.max(
        0,
        (progressClock() - progressStartedAt) / 1_000,
      );
      const bytesTransferredThisRun = Math.max(
        0,
        transferredBytes - initialStoredBytes,
      );
      const bytesPerSecond =
        elapsedSeconds > 0 ? bytesTransferredThisRun / elapsedSeconds : 0;
      input.onProgress?.({
        stage: "upload",
        percent: Math.round((transferredBytes / input.file.size) * 100),
        transferredBytes,
        totalBytes: input.file.size,
        ...(bytesPerSecond > 0
          ? {
              bytesPerSecond,
              etaSeconds: Math.max(
                0,
                Math.round(
                  (input.file.size - transferredBytes) / bytesPerSecond,
                ),
              ),
            }
          : { etaSeconds: null }),
      });
    };
    reportProgress();
    type ActiveGrant = {
      partNumber: number;
      url: string;
      expiresAtMs: number;
    };
    let pending: ActiveGrant[] = transfer.grants
      .filter((grant) => !completedNumbers.has(grant.partNumber))
      .map((grant) => ({
        ...grant,
        expiresAtMs: Date.parse(transfer.grantExpiresAt),
      }));
    const requestGrantWindow = async (partNumbers: number[]) => {
      const grantResponse = await fetcher("/api/upload-sessions/grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: opened.sessionId,
          partNumbers,
        }),
        signal: input.signal,
      });
      const grantPayload = await responsePayload(grantResponse);
      if (!grantResponse.ok) {
        throw responseError(
          grantResponse,
          grantPayload,
          "Failed to refresh upload grants.",
        );
      }
      if (
        !isRecord(grantPayload) ||
        grantPayload.outcome !== "granted" ||
        grantPayload.sessionId !== opened.sessionId ||
        typeof grantPayload.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(grantPayload.expiresAt))
      ) {
        throw new Error("The upload service returned an invalid grant contract.",
        );
      }
      const parsedGrants = parseParts(
        grantPayload.grants,
        transfer.partCount,
        true,
      );
      if (
        !parsedGrants ||
        parsedGrants.length !== partNumbers.length ||
        !partNumbers.every((partNumber) =>
          parsedGrants.some((grant) => grant.partNumber === partNumber),
        )
      ) {
        throw new Error("The upload service returned an invalid grant contract.",
        );
      }
      const expiresAtMs = Date.parse(grantPayload.expiresAt);
      return parsedGrants.map((grant) => ({ ...grant, expiresAtMs,
      })) as ActiveGrant[];
    };
    if (
      pending.length > 0 &&
      pending.some(
        (grant) =>
          grant.expiresAtMs - (input.now?.() ?? Date.now()) <= 60_000,
      )
    ) {
      pending = await requestGrantWindow(
        pending.map((grant) => grant.partNumber),
      );
    }
    while (completedByPartNumber.size < transfer.partCount) {
      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          let grant = pending[cursor++]!;
          if (grant.expiresAtMs - (input.now?.() ?? Date.now()) <= 60_000) {
            const [freshGrant] = await requestGrantWindow([grant.partNumber]);
            if (!freshGrant) {
              throw new Error(`Upload part ${grant.partNumber} omitted a grant.`,
              );
            }
            grant = freshGrant;
          }
        const start = (grant.partNumber - 1) * transfer.partSizeBytes;
        const end = Math.min(
          start + transfer.partSizeBytes,
          input.file.size);
        const blob = input.file.slice(start, end);
        const response = await putWithRetry({
          fetcher,
          url: grant.url,
          body: blob,
          signal: input.signal,
          waitBeforeRetry,
          uploadTransport,
          onProgress: (loadedBytes) => {
            activeBytes.set(
              grant.partNumber,
              Math.max(0, Math.min(blob.size, loadedBytes)),
            );
            reportProgress();
          },
          refreshUrlAfterFailure: async (error) => {
            if (
              !(
                error instanceof TypeError ||
                (error instanceof UploadHttpError && error.status === 403)
              ) ||
              grant.expiresAtMs - (input.now?.() ?? Date.now()) > 60_000
            ) {
              return null;
            }
            const [freshGrant] = await requestGrantWindow([grant.partNumber]);
            return freshGrant?.url ?? null;
          },
        });
        const etag = response.etag;
        if (!etag) throw new Error(`Upload part ${grant.partNumber} omitted ETag.`);
          completedByPartNumber.set(grant.partNumber, etag.replaceAll('"', ""));
          activeBytes.delete(grant.partNumber);
          storedBytes += blob.size;
          reportProgress();
        }
      };
      const workerResults = await Promise.allSettled(
        Array.from(
          { length: Math.min(transfer.concurrency, pending.length) },
          () => worker(),
        ),
      );
      const failedWorker = workerResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failedWorker) throw failedWorker.reason;
      if (completedByPartNumber.size === transfer.partCount) break;
      const missingPartNumbers = Array.from(
        { length: transfer.partCount },
        (_, index) => index + 1,
      )
        .filter((partNumber) => !completedByPartNumber.has(partNumber))
        .slice(0, 16);
      pending = await requestGrantWindow(missingPartNumbers);
    }
    completedParts = Array.from(
      completedByPartNumber,
      ([partNumber, etag]) => ({ partNumber, etag }),
    ).sort((left, right) => left.partNumber - right.partNumber);
  }

  input.onProgress?.({
    stage: "finalize",
    percent: 100,
    transferredBytes: input.file.size,
    totalBytes: input.file.size,
  });
  const finalizedResponse = await fetcher("/api/upload-sessions/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: opened.sessionId,
      parts: completedParts,
    }),
    signal: input.signal,
  });
  const finalized = await responsePayload(finalizedResponse);
  if (!finalizedResponse.ok) {
    throw responseError(
      finalizedResponse,
      finalized,
      "Failed to verify upload.",
    );
  }
  if (
    isRecord(finalized) &&
    finalized.outcome === "reconciling" &&
    finalized.sessionId === opened.sessionId &&
    typeof finalized.retryAfterSeconds === "number" &&
    Number.isInteger(finalized.retryAfterSeconds) &&
    finalized.retryAfterSeconds > 0
  ) {
    return {
      outcome: "reconciling" as const,
      projectId: opened.projectId,
      sessionId: opened.sessionId,
      retryAfterSeconds: finalized.retryAfterSeconds,
    };
  }
  if (
    !isRecord(finalized) ||
    finalized.outcome !== "queued_for_ingest" ||
    finalized.sessionId !== opened.sessionId ||
    finalized.projectId !== opened.projectId
  ) {
    throw new Error("The upload service returned an invalid finalization contract.",
    );
  }
  if (input.storage) saveUploadResume(input.storage, null);
  return { projectId: opened.projectId };
}

const IDLE_UPLOAD_SNAPSHOT: UploadSessionBrowserSnapshot = Object.freeze({
  phase: "idle",
  progressPercent: 0,
  transferredBytes: 0,
  totalBytes: 0,
  bytesPerSecond: null,
  etaSeconds: null,
  message: "Choose a video or audio file to begin.",
  failureCode: null,
  canPause: false,
  canResume: false,
  canDiscard: false,
  canStartFresh: false,
});

export function createUploadSessionBrowserAdapter(
  dependencies: UploadSessionBrowserAdapterDependencies,
): UploadSessionBrowserAdapter {
  let currentSnapshot = IDLE_UPLOAD_SNAPSHOT;
  let activeController: AbortController | null = null;
  let activeOperation: Promise<void> | null = null;
  let pauseRequested = false;
  let discardRequested = false;
  let freshStartAllowed = false;
  let currentInput: UploadSessionBrowserStartInput | null = null;
  let disposed = false;
  const lifecycleController = new AbortController();
  const listeners = new Set<() => void>();

  const publish = (snapshot: UploadSessionBrowserSnapshot) => {
    if (disposed) return;
    currentSnapshot = Object.freeze(snapshot);
    for (const listener of listeners) listener();
  };

  const finishQueued = (projectId: string, totalBytes: number) => {
    if (disposed) return;
    if (dependencies.storage) saveUploadResume(dependencies.storage, null);
    publish({
      ...currentSnapshot,
      phase: "queued",
      progressPercent: 100,
      transferredBytes: totalBytes,
      totalBytes,
      message: "Upload verified. Opening the queued project.",
      failureCode: null,
      canPause: false,
      canResume: false,
      canDiscard: false,
    });
    dependencies.navigate(projectId);
  };

  const finishTerminal = (
    outcome: Extract<OpenOutcome, { outcome: "terminal" }>,
  ) => {
    if (disposed) return;
    freshStartAllowed = outcome.freshUploadAllowed;
    publish({
      ...currentSnapshot,
      phase: "failed",
      message:
        !outcome.freshUploadAllowed
          ? "Narriflow could not prove storage cleanup. Do not start a fresh upload yet; contact support if this persists."
          : outcome.state === "expired"
          ? "This saved Upload Session expired after safe cleanup. Start a fresh upload when ready."
          : "This saved Upload Session is closed. Start a fresh upload when ready.",
      failureCode: outcome.failureCode,
      canPause: false,
      canResume: false,
      canDiscard: false,
      canStartFresh: outcome.freshUploadAllowed,
    });
  };

  const finishDiscarded = () => {
    if (disposed) return;
    if (dependencies.storage) saveUploadResume(dependencies.storage, null);
    currentInput = null;
    publish({
      ...IDLE_UPLOAD_SNAPSHOT,
      message: "Upload discarded. Choose a file when you are ready.",
    });
  };

  const pollVerification = async (
    input: UploadSessionBrowserStartInput,
    firstRetryAfterSeconds: number,
    purpose: "finalize" | "discard" = "finalize",
  ) => {
    const fetcher = dependencies.fetcher ?? fetch;
    const waitBeforePoll =
      dependencies.waitBeforePoll ??
      ((delayMs: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    const jitter = (delayMs: number) =>
      Math.round(
        Math.min(30_000, Math.max(1_000, delayMs)) *
          (0.8 + (dependencies.random?.() ?? Math.random()) * 0.4),
      );
    let retryAfterSeconds = firstRetryAfterSeconds;
    let transientFailures = 0;
    for (let pollAttempt = 0; pollAttempt < 120; pollAttempt += 1) {
      await waitBeforePoll(jitter(retryAfterSeconds * 1_000));
      if (disposed) return;
      const resume = dependencies.storage
        ? loadUploadResume(
            dependencies.storage,
            createUploadFileFingerprint(input.file),
          )
        : null;
      if (!resume) {
        throw new Error("The saved Upload Session is unavailable.");
      }
      let response: Response;
      try {
        response = await fetcher("/api/upload-sessions/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientIdempotencyKey: resume.clientIdempotencyKey,
            sessionId: resume.sessionId,
            browserFingerprint: resume.fingerprint,
          }),
          signal: lifecycleController.signal,
        });
      } catch (error) {
        if (
          disposed ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        transientFailures += 1;
        if (transientFailures >= 8) break;
        retryAfterSeconds = Math.min(30, 2 ** (transientFailures - 1));
        continue;
      }
      const payload = await responsePayload(response);
      if (response.status === 429 || response.status >= 500) {
        transientFailures += 1;
        if (transientFailures >= 8) break;
        const retryHeader = Number(response.headers.get("Retry-After"));
        retryAfterSeconds =
          Number.isInteger(retryHeader) && retryHeader > 0
            ? Math.min(30, retryHeader)
            : Math.min(30, 2 ** (transientFailures - 1));
        continue;
      }
      if (!response.ok) {
        throw responseError(
          response,
          payload,
          "Upload verification could not continue.",
        );
      }
      const outcome = parseOpenOutcome(payload);
      if (!outcome) {
        throw new Error("The upload service returned an invalid status contract.",
        );
      }
      transientFailures = 0;
      if (outcome.outcome === "queued_for_ingest") {
        finishQueued(outcome.projectId, input.file.size);
        return;
      }
      if (outcome.outcome === "terminal") {
        if (
          purpose === "discard" &&
          outcome.state === "aborted" &&
          outcome.failureCode === "user_discarded" &&
          outcome.freshUploadAllowed
        ) {
          finishDiscarded();
        } else {
          finishTerminal(outcome);
        }
        return;
      }
      if (outcome.outcome !== "reconciling") {
        throw new Error("Upload verification returned to byte transfer unexpectedly.",
        );
      }
      retryAfterSeconds = outcome.retryAfterSeconds;
    }
    throw new Error("Upload verification is taking longer than expected.");
  };

  const start = (input: UploadSessionBrowserStartInput) => {
    if (disposed) return Promise.resolve();
    if (activeOperation) return activeOperation;
    pauseRequested = false;
    discardRequested = false;
    freshStartAllowed = false;
    currentInput = input;
    const controller = new AbortController();
    activeController = controller;
    publish({
      ...IDLE_UPLOAD_SNAPSHOT,
      phase: "preparing",
      totalBytes: input.file.size,
      message: "Preparing a secure upload session.",
    });

    const operation = (async () => {
      try {
        const result = await runUploadSessionTransfer({
          ...input,
          storage: dependencies.storage,
          fetcher: dependencies.fetcher,
          createClientKey: dependencies.createClientKey,
          signal: controller.signal,
          waitBeforeRetry: dependencies.waitBeforeRetry,
          now: dependencies.now,
          progressClock: dependencies.progressClock,
          random: dependencies.random,
          uploadTransport: dependencies.uploadTransport,
          onProgress(progress) {
            const phase =
              progress.stage === "prepare"
                ? "preparing"
                : progress.stage === "upload"
                  ? "uploading"
                  : "verifying";
            publish({
              phase,
              progressPercent: progress.percent,
              transferredBytes: progress.transferredBytes,
              totalBytes: progress.totalBytes,
              bytesPerSecond: progress.bytesPerSecond ?? null,
              etaSeconds: progress.etaSeconds ?? null,
              message:
                phase === "preparing"
                  ? "Preparing a secure upload session."
                  : phase === "uploading"
                    ? "Uploading bytes to secure storage."
                    : "Narriflow is checking your upload. You may leave this page safely.",
              failureCode: null,
              canPause: phase === "uploading",
              canResume: false,
              canDiscard: phase === "uploading",
              canStartFresh: false,
            });
          },
        });
        if ("outcome" in result && result.outcome === "terminal") {
          finishTerminal(result);
          return;
        }
        if ("outcome" in result && result.outcome === "reconciling") {
          publish({
            ...currentSnapshot,
            phase: "verifying",
            message:
              "Narriflow is checking your upload. You may leave this page safely.",
            canPause: false,
            canResume: false,
            canDiscard: false,
            canStartFresh: false,
          });
          await pollVerification(input, result.retryAfterSeconds);
          return;
        }
        finishQueued(result.projectId, input.file.size);
      } catch (error) {
        if (
          discardRequested &&
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }
        if (
          pauseRequested &&
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          publish({
            ...currentSnapshot,
            phase: "paused",
            message:
              "Upload paused. Re-select the exact same file to continue with the saved settings.",
            failureCode: null,
            canPause: false,
            canResume: true,
            canDiscard: true,
          });
          return;
        }
        const failure = stableBrowserFailure(error);
        publish({
          ...currentSnapshot,
          phase: "failed",
          message: failure.message,
          failureCode: failure.code,
          canPause: false,
          canResume: Boolean(
            dependencies.storage &&
              loadUploadResume(
                dependencies.storage,
                createUploadFileFingerprint(input.file),
              ),
          ),
          canDiscard: Boolean(
            currentSnapshot.phase !== "verifying" &&
              dependencies.storage &&
              loadUploadResume(
                dependencies.storage,
                createUploadFileFingerprint(input.file),
              )?.sessionId,
          ),
          canStartFresh: false,
        });
      } finally {
        if (activeController === controller) activeController = null;
        activeOperation = null;
      }
    })();
    activeOperation = operation;
    return operation;
  };

  return {
    snapshot: () => currentSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    async pause() {
      if (currentSnapshot.phase !== "uploading" || !activeController) return;
      pauseRequested = true;
      const operation = activeOperation;
      activeController.abort();
      await operation;
    },
    async discard() {
      if (!currentSnapshot.canDiscard || !currentInput) return;
      discardRequested = true;
      const operation = activeOperation;
      activeController?.abort();
      await operation;

      const resume = dependencies.storage
        ? loadUploadResume(
            dependencies.storage,
            createUploadFileFingerprint(currentInput.file),
          )
        : null;
      if (!resume?.sessionId) {
        publish({
          ...currentSnapshot,
          phase: "failed",
          message: "The saved Upload Session is unavailable.",
          failureCode: "upload_session_unavailable",
          canPause: false,
          canResume: true,
          canDiscard: false,
          canStartFresh: false,
        });
        return;
      }

      const fetcher = dependencies.fetcher ?? fetch;
      let response: Response;
      try {
        response = await fetcher("/api/upload-sessions/discard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: resume.sessionId }),
          signal: lifecycleController.signal,
        });
      } catch (error) {
        if (
          disposed ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        publish({
          ...currentSnapshot,
          phase: "failed",
          message: "Narriflow could not accept Discard yet. Try again.",
          failureCode: "upload_discard_unavailable",
          canPause: false,
          canResume: true,
          canDiscard: true,
          canStartFresh: false,
        });
        return;
      }
      const payload = await responsePayload(response);
      if (
        !response.ok ||
        !isRecord(payload) ||
        payload.sessionId !== resume.sessionId ||
        (payload.outcome !== "discarded" &&
          payload.outcome !== "compensating")
      ) {
        publish({
          ...currentSnapshot,
          phase: "failed",
          message: "Narriflow could not accept Discard yet. Try again.",
          failureCode: "upload_discard_unavailable",
          canPause: false,
          canResume: true,
          canDiscard: true,
          canStartFresh: false,
        });
        return;
      }
      if (payload.outcome === "discarded") {
        finishDiscarded();
        return;
      }
      publish({
        ...currentSnapshot,
        phase: "verifying",
        message:
          "Narriflow is finishing secure cleanup. You may leave this page safely.",
        canPause: false,
        canResume: false,
        canDiscard: false,
        canStartFresh: false,
      });
      await pollVerification(
        currentInput,
        typeof payload.retryAfterSeconds === "number"
          ? payload.retryAfterSeconds
          : 5,
        "discard",
      );
    },
    async startFresh() {
      if (!freshStartAllowed || !currentInput) return;
      if (dependencies.storage) saveUploadResume(dependencies.storage, null);
      freshStartAllowed = false;
      await start(currentInput);
    },
    shouldConfirmUnload: () => currentSnapshot.phase === "uploading",
    dispose() {
      if (disposed) return;
      disposed = true;
      activeController?.abort();
      lifecycleController.abort();
      listeners.clear();
    },
  };
}
