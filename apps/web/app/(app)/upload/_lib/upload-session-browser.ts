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
}

type OpenOutcome =
  | {
      outcome: "queued_for_ingest";
      sessionId: string;
      projectId: string;
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

async function putWithRetry(input: {
  fetcher: typeof fetch;
  url: string;
  body: Blob;
  contentType?: string;
  signal?: AbortSignal;
  waitBeforeRetry: (attempt: number) => Promise<void>;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await input.fetcher(input.url, {
        method: "PUT",
        ...(input.contentType
          ? { headers: { "Content-Type": input.contentType } }
          : {}),
        body: input.body,
        signal: input.signal,
      });
      if (!response.ok) throw new Error(`Upload failed with HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      lastError = error;
      if (attempt < 3) await input.waitBeforeRetry(attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Upload failed");
}

export async function runUploadSessionTransfer(
  input: RunUploadSessionTransferInput,
) {
  const fetcher = input.fetcher ?? fetch;
  const waitBeforeRetry =
    input.waitBeforeRetry ??
    ((attempt: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, attempt * 500)));
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

  resume = {
    ...resume,
    sessionId: opened.sessionId,
    projectId: opened.projectId,
  };
  if (input.storage) saveUploadResume(input.storage, resume);

  const completedParts: Array<{ partNumber: number; etag: string }> = [];
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
    });
    input.onProgress?.({
      stage: "upload",
      percent: 100,
      transferredBytes: input.file.size,
      totalBytes: input.file.size,
    });
  } else {
    const transfer = opened.transfer;
    completedParts.push(...transfer.completedParts);
    const completedNumbers = new Set(
      completedParts.map((part) => part.partNumber),
    );
    let transferredBytes = Array.from(completedNumbers).reduce(
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
    const pending = transfer.grants.filter(
      (grant) => !completedNumbers.has(grant.partNumber),
    );
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const grant = pending[cursor++]!;
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
        });
        const etag = response.headers.get("ETag") ?? response.headers.get("etag");
        if (!etag) throw new Error(`Upload part ${grant.partNumber} omitted ETag.`);
        completedParts.push({
          partNumber: grant.partNumber,
          etag: etag.replaceAll('"', ""),
        });
        transferredBytes += blob.size;
        input.onProgress?.({
          stage: "upload",
          percent: Math.round((transferredBytes / input.file.size) * 100),
          transferredBytes,
          totalBytes: input.file.size,
        });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(transfer.concurrency, pending.length) },
        () => worker(),
      ),
    );
    completedParts.sort((left, right) => left.partNumber - right.partNumber);
    if (completedParts.length !== opened.transfer.partCount) {
      throw new Error("Upload parts are incomplete.");
    }
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
