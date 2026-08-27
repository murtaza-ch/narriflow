import {
  createPendingUploadResume,
  createUploadFileFingerprint,
  loadUploadResume,
  saveUploadResume,
  type UploadResumeRecord,
  type UploadResumeStorage,
} from "./upload-resume";

type UploadProgress = {
  stage: "prepare" | "upload" | "finalize";
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond?: number;
  etaSeconds?: number | null;
};

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
  if (
    !isRecord(value) ||
    !isUuid(value.sessionId) ||
    !isUuid(value.projectId)
  ) {
    return null;
  }
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

function responseError(payload: unknown, fallback: string) {
  if (!isRecord(payload)) return new Error(fallback);
  if (typeof payload.message === "string") return new Error(payload.message);
  if (typeof payload.error === "string") return new Error(payload.error);
  return new Error(fallback);
}

class UploadHttpError extends Error {
  constructor(readonly status: number) {
    super(`Upload failed with HTTP ${status}`);
    this.name = "UploadHttpError";
  }
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
      callback: () => void,
    ) => {
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

export async function runUploadSessionTransfer(
  input: RunUploadSessionTransferInput,
) {
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
  const openedResponse = await fetcher("/api/upload-sessions/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
    }),
    signal: input.signal,
  });
  const openedPayload = await responsePayload(openedResponse);
  if (!openedResponse.ok) {
    throw responseError(openedPayload, "Failed to open Upload Session.");
  }
  const opened = parseOpenOutcome(openedPayload);
  if (!opened) throw new Error("The upload service returned an invalid contract.");
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
      completedByPartNumber.keys(),
    );
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
        throw responseError(grantPayload, "Failed to refresh upload grants.");
      }
      if (
        !isRecord(grantPayload) ||
        grantPayload.outcome !== "granted" ||
        grantPayload.sessionId !== opened.sessionId ||
        typeof grantPayload.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(grantPayload.expiresAt))
      ) {
        throw new Error("The upload service returned an invalid grant contract.");
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
        throw new Error("The upload service returned an invalid grant contract.");
      }
      const expiresAtMs = Date.parse(grantPayload.expiresAt);
      return parsedGrants.map((grant) => ({ ...grant, expiresAtMs })) as ActiveGrant[];
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
              throw new Error(`Upload part ${grant.partNumber} omitted a grant.`);
            }
            grant = freshGrant;
          }
        const start = (grant.partNumber - 1) * transfer.partSizeBytes;
        const end = Math.min(
          start + transfer.partSizeBytes,
          input.file.size,
        );
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
    throw responseError(finalized, "Failed to verify upload.");
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
    throw new Error("The upload service returned an invalid finalization contract.");
  }
  if (input.storage) saveUploadResume(input.storage, null);
  return { projectId: opened.projectId };
}
