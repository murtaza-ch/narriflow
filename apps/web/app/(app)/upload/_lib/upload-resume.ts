export const UPLOAD_RESUME_VERSION = 2;
export const UPLOAD_RESUME_STORAGE_KEY = "narriflow.upload.session.v2";
export const LEGACY_UPLOAD_RESUME_STORAGE_KEYS = [
  "narriflow.upload.session.v1",
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MULTIPART_PARTS = 10_000;

export interface UploadResumeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UploadResumeSession {
  version: typeof UPLOAD_RESUME_VERSION;
  fingerprint: string;
  projectId: string;
  uploadId: string;
  key: string;
  fileName: string;
  title: string;
  partCount: number;
  expiresAt: string;
}

export type UploadResumeDiscardReason =
  | "legacy"
  | "corrupt"
  | "other_file";

export type UploadResumeParseResult =
  | { kind: "resume"; session: UploadResumeSession }
  | { kind: "discard"; reason: UploadResumeDiscardReason }
  | { kind: "none" };

export type UploadInitialization =
  | {
      outcome: "completed";
      projectId: string;
    }
  | {
      outcome: "active";
      projectId: string;
      uploadId: string;
      key: string;
      partCount: number;
      uploadUrls: Array<{ partNumber: number; url: string }>;
      alreadyUploadedPartNumbers: number[];
      alreadyUploadedParts: Array<{ partNumber: number; etag: string }>;
      expiresAt: string;
    };

type ActiveUploadInitialization = Extract<
  UploadInitialization,
  { outcome: "active" }
>;

export type UploadInitializationDecision =
  | { kind: "active"; initialization: ActiveUploadInitialization }
  | { kind: "completed"; projectId: string }
  | { kind: "fresh" }
  | { kind: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isValidPartNumber(value: unknown, partCount: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= partCount
  );
}

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? value : null;
}

function isValidUploadUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function createUploadFileFingerprint(file: {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}): string {
  return JSON.stringify([file.name, file.size, file.type, file.lastModified]);
}

export function parseStoredUploadResume(
  raw: string | null,
  expectedFingerprint: string,
): UploadResumeParseResult {
  if (raw === null) return { kind: "none" };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "discard", reason: "corrupt" };
  }

  if (isRecord(value) && value.version !== UPLOAD_RESUME_VERSION) {
    return { kind: "discard", reason: "legacy" };
  }

  if (!isRecord(value)) {
    return { kind: "discard", reason: "corrupt" };
  }

  // Validate the server timestamp's shape, but never let the client clock
  // discard the only IDs that can reconcile a lost completion response.
  const expiresAt = parseIsoDate(value.expiresAt);
  const partCount = value.partCount;
  if (
    value.version !== UPLOAD_RESUME_VERSION ||
    !isNonEmptyString(value.fingerprint) ||
    !isUuid(value.projectId) ||
    !isUuid(value.uploadId) ||
    !isNonEmptyString(value.key) ||
    !isNonEmptyString(value.fileName) ||
    !isNonEmptyString(value.title) ||
    typeof partCount !== "number" ||
    !Number.isInteger(partCount) ||
    partCount < 1 ||
    partCount > MAX_MULTIPART_PARTS ||
    expiresAt === null
  ) {
    return { kind: "discard", reason: "corrupt" };
  }

  if (value.fingerprint !== expectedFingerprint) {
    return { kind: "discard", reason: "other_file" };
  }

  return {
    kind: "resume",
    session: {
      version: UPLOAD_RESUME_VERSION,
      fingerprint: value.fingerprint,
      projectId: value.projectId,
      uploadId: value.uploadId,
      key: value.key,
      fileName: value.fileName,
      title: value.title,
      partCount,
      expiresAt,
    },
  };
}

export function safelyGetUploadResumeStorage(
  getStorage: () => UploadResumeStorage,
): UploadResumeStorage | null {
  try {
    return getStorage();
  } catch {
    return null;
  }
}

function removeStorageItem(storage: UploadResumeStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Resume is an optimization. Storage privacy/quota failures must not block upload.
  }
}

export function loadUploadResume(
  storage: UploadResumeStorage,
  expectedFingerprint: string,
): UploadResumeSession | null {
  for (const key of LEGACY_UPLOAD_RESUME_STORAGE_KEYS) {
    removeStorageItem(storage, key);
  }

  let raw: string | null;
  try {
    raw = storage.getItem(UPLOAD_RESUME_STORAGE_KEY);
  } catch {
    return null;
  }

  const result = parseStoredUploadResume(raw, expectedFingerprint);
  if (result.kind === "resume") return result.session;

  if (result.kind === "discard") {
    removeStorageItem(storage, UPLOAD_RESUME_STORAGE_KEY);
  }
  return null;
}

export function saveUploadResume(
  storage: UploadResumeStorage,
  session: UploadResumeSession | null,
) {
  try {
    if (session === null) {
      storage.removeItem(UPLOAD_RESUME_STORAGE_KEY);
      return;
    }
    const serialized = JSON.stringify(session);
    const parsed = parseStoredUploadResume(serialized, session.fingerprint);
    if (parsed.kind !== "resume") {
      storage.removeItem(UPLOAD_RESUME_STORAGE_KEY);
      return;
    }
    storage.setItem(
      UPLOAD_RESUME_STORAGE_KEY,
      JSON.stringify(parsed.session),
    );
  } catch {
    // Resume is best-effort and cannot be allowed to fail the upload itself.
  }
}

export function parseUploadInitialization(
  value: unknown,
  expectedPartCount: number,
): UploadInitialization | null {
  if (
    !Number.isInteger(expectedPartCount) ||
    expectedPartCount < 1 ||
    expectedPartCount > MAX_MULTIPART_PARTS ||
    !isRecord(value) ||
    !isUuid(value.projectId)
  ) {
    return null;
  }

  if (value.outcome === "completed") {
    return { outcome: "completed", projectId: value.projectId };
  }

  // Expiry authority belongs to the server. A client clock ahead of the server
  // must not turn a valid active response into a duplicate fresh project.
  const expiresAt = parseIsoDate(value.expiresAt);
  if (
    value.outcome !== "active" ||
    !isUuid(value.uploadId) ||
    !isNonEmptyString(value.key) ||
    value.partCount !== expectedPartCount ||
    !Number.isInteger(value.partCount) ||
    expiresAt === null ||
    !Array.isArray(value.uploadUrls) ||
    !Array.isArray(value.alreadyUploadedPartNumbers) ||
    !Array.isArray(value.alreadyUploadedParts)
  ) {
    return null;
  }

  const completedNumbers = new Set<number>();
  for (const partNumber of value.alreadyUploadedPartNumbers) {
    if (
      !isValidPartNumber(partNumber, expectedPartCount) ||
      completedNumbers.has(partNumber)
    ) {
      return null;
    }
    completedNumbers.add(partNumber);
  }

  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  const completedEtagNumbers = new Set<number>();
  for (const part of value.alreadyUploadedParts) {
    if (
      !isRecord(part) ||
      !isValidPartNumber(part.partNumber, expectedPartCount) ||
      !isNonEmptyString(part.etag) ||
      completedEtagNumbers.has(part.partNumber)
    ) {
      return null;
    }
    completedEtagNumbers.add(part.partNumber);
    completedParts.push({ partNumber: part.partNumber, etag: part.etag });
  }

  if (
    completedNumbers.size !== completedEtagNumbers.size ||
    Array.from(completedNumbers).some(
      (partNumber) => !completedEtagNumbers.has(partNumber),
    )
  ) {
    return null;
  }

  const pendingParts: Array<{ partNumber: number; url: string }> = [];
  const pendingNumbers = new Set<number>();
  for (const part of value.uploadUrls) {
    if (
      !isRecord(part) ||
      !isValidPartNumber(part.partNumber, expectedPartCount) ||
      !isValidUploadUrl(part.url) ||
      pendingNumbers.has(part.partNumber) ||
      completedNumbers.has(part.partNumber)
    ) {
      return null;
    }
    pendingNumbers.add(part.partNumber);
    pendingParts.push({ partNumber: part.partNumber, url: part.url });
  }

  if (pendingNumbers.size + completedNumbers.size !== expectedPartCount) {
    return null;
  }
  for (let partNumber = 1; partNumber <= expectedPartCount; partNumber += 1) {
    if (!pendingNumbers.has(partNumber) && !completedNumbers.has(partNumber)) {
      return null;
    }
  }

  return {
    outcome: "active",
    projectId: value.projectId,
    uploadId: value.uploadId,
    key: value.key,
    partCount: expectedPartCount,
    uploadUrls: pendingParts.sort((left, right) => left.partNumber - right.partNumber),
    alreadyUploadedPartNumbers: Array.from(completedNumbers).sort(
      (left, right) => left - right,
    ),
    alreadyUploadedParts: completedParts.sort(
      (left, right) => left.partNumber - right.partNumber,
    ),
    expiresAt,
  };
}

export function decideUploadInitialization(input: {
  responseOk: boolean;
  hadResumeSession: boolean;
  payload: unknown;
  expectedPartCount: number;
}): UploadInitializationDecision {
  if (!input.responseOk) {
    const payload = isRecord(input.payload) ? input.payload : null;
    if (
      input.hadResumeSession &&
      payload?.error === "upload_session_unavailable"
    ) {
      return { kind: "fresh" };
    }
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.error === "string"
          ? payload.error
          : "Failed to initialize upload.";
    return { kind: "error", message };
  }

  const initialization = parseUploadInitialization(
    input.payload,
    input.expectedPartCount,
  );
  if (!initialization) {
    return {
      kind: "error",
      message: "The upload service returned invalid resume metadata.",
    };
  }
  if (initialization.outcome === "completed") {
    return { kind: "completed", projectId: initialization.projectId };
  }
  return { kind: "active", initialization };
}

export function validateMultipartEtags(
  value: Iterable<[number, string]>,
  expectedPartCount: number,
): Array<{ partNumber: number; etag: string }> | null {
  const byPartNumber = new Map<number, string>();
  for (const [partNumber, etag] of value) {
    if (
      !isValidPartNumber(partNumber, expectedPartCount) ||
      !isNonEmptyString(etag) ||
      byPartNumber.has(partNumber)
    ) {
      return null;
    }
    byPartNumber.set(partNumber, etag);
  }

  if (byPartNumber.size !== expectedPartCount) return null;

  return Array.from(byPartNumber, ([partNumber, etag]) => ({
    partNumber,
    etag,
  })).sort((left, right) => left.partNumber - right.partNumber);
}
