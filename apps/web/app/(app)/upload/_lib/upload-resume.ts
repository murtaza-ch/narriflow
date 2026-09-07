export const UPLOAD_RESUME_VERSION = 3;
export const UPLOAD_RESUME_STORAGE_KEY = "narriflow.upload.session.v3";
export const LEGACY_UPLOAD_RESUME_STORAGE_KEYS = [
  "narriflow.upload.session.v1",
  "narriflow.upload.session.v2",
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UploadResumeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UploadResumeRecord {
  version: typeof UPLOAD_RESUME_VERSION;
  clientIdempotencyKey: string;
  sessionId: string | null;
  projectId: string | null;
  fingerprint: string;
  fileName: string;
  title: string;
}

export type UploadResumeParseResult =
  | { kind: "resume"; record: UploadResumeRecord }
  | { kind: "discard"; reason: "legacy" | "corrupt" | "other_file" }
  | { kind: "none" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

export function createUploadFileFingerprint(file: {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}) {
  return JSON.stringify([file.name, file.size, file.type, file.lastModified]);
}

export function createPendingUploadResume(input: {
  clientIdempotencyKey: string;
  fingerprint: string;
  fileName: string;
  title: string;
}): UploadResumeRecord {
  if (!isUuid(input.clientIdempotencyKey)) {
    throw new Error("Upload client key must be a UUID");
  }
  return {
    version: UPLOAD_RESUME_VERSION,
    clientIdempotencyKey: input.clientIdempotencyKey,
    sessionId: null,
    projectId: null,
    fingerprint: input.fingerprint,
    fileName: input.fileName,
    title: input.title,
  };
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
  if (
    !isRecord(value) ||
    value.version !== UPLOAD_RESUME_VERSION ||
    !isUuid(value.clientIdempotencyKey) ||
    !isNullableUuid(value.sessionId) ||
    !isNullableUuid(value.projectId) ||
    (value.sessionId === null) !== (value.projectId === null) ||
    !isNonEmptyString(value.fingerprint) ||
    !isNonEmptyString(value.fileName) ||
    !isNonEmptyString(value.title)
  ) {
    return { kind: "discard", reason: "corrupt" };
  }
  if (value.fingerprint !== expectedFingerprint) {
    return { kind: "discard", reason: "other_file" };
  }
  return {
    kind: "resume",
    record: {
      version: UPLOAD_RESUME_VERSION,
      clientIdempotencyKey: value.clientIdempotencyKey,
      sessionId: value.sessionId,
      projectId: value.projectId,
      fingerprint: value.fingerprint,
      fileName: value.fileName,
      title: value.title,
    },
  };
}

function remove(storage: UploadResumeStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Browser storage is optional; upload correctness stays server-owned.
  }
}

export function safelyGetUploadResumeStorage(
  getStorage: () => UploadResumeStorage,
) {
  try {
    return getStorage();
  } catch {
    return null;
  }
}

export function loadUploadResume(
  storage: UploadResumeStorage,
  expectedFingerprint: string,
) {
  for (const key of LEGACY_UPLOAD_RESUME_STORAGE_KEYS) remove(storage, key);
  let raw: string | null;
  try {
    raw = storage.getItem(UPLOAD_RESUME_STORAGE_KEY);
  } catch {
    return null;
  }
  const parsed = parseStoredUploadResume(raw, expectedFingerprint);
  if (parsed.kind === "resume") return parsed.record;
  if (parsed.kind === "discard") remove(storage, UPLOAD_RESUME_STORAGE_KEY);
  return null;
}

export function saveUploadResume(
  storage: UploadResumeStorage,
  record: UploadResumeRecord | null,
) {
  try {
    if (record === null) {
      storage.removeItem(UPLOAD_RESUME_STORAGE_KEY);
      return;
    }
    const parsed = parseStoredUploadResume(
      JSON.stringify(record),
      record.fingerprint,
    );
    if (parsed.kind !== "resume") {
      storage.removeItem(UPLOAD_RESUME_STORAGE_KEY);
      return;
    }
    storage.setItem(UPLOAD_RESUME_STORAGE_KEY, JSON.stringify(parsed.record));
  } catch {
    // Browser storage is optional; upload correctness stays server-owned.
  }
}
