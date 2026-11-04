export const UPLOAD_RESUME_VERSION = 3;
export const UPLOAD_RESUME_STORAGE_KEY = "narriflow.upload.sessions";
/** A transfer that reported this recently belongs to a live tab, whichever tab that is. */
export const UPLOAD_ACTIVE_WINDOW_MS = 2 * 60_000;

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
  /** The open request while no session is known, so an unanswered open can be replayed under its key. */
  openRequest: Record<string, unknown> | null;
  /** When a tab last vouched for this transfer. Null when no tab is running it. */
  transferActiveAt: number | null;
}

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
  openRequest?: Record<string, unknown>;
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
    openRequest: input.openRequest ?? null,
    transferActiveAt: null,
  };
}

function parseRecord(value: unknown): UploadResumeRecord | null {
  if (
    !isRecord(value) ||
    value.version !== UPLOAD_RESUME_VERSION ||
    !isUuid(value.clientIdempotencyKey) ||
    !isNullableUuid(value.sessionId) ||
    !isNullableUuid(value.projectId) ||
    (value.sessionId === null) !== (value.projectId === null) ||
    !isNonEmptyString(value.fingerprint) ||
    !isNonEmptyString(value.fileName) ||
    !isNonEmptyString(value.title) ||
    !(value.openRequest === null || isRecord(value.openRequest)) ||
    !(value.transferActiveAt === null || typeof value.transferActiveAt === "number")
  ) {
    return null;
  }
  return {
    version: UPLOAD_RESUME_VERSION,
    clientIdempotencyKey: value.clientIdempotencyKey,
    sessionId: value.sessionId,
    projectId: value.projectId,
    fingerprint: value.fingerprint,
    fileName: value.fileName,
    title: value.title,
    openRequest: value.openRequest,
    transferActiveAt: value.transferActiveAt,
  };
}

/** One record per file. Anything unreadable is dropped, so provider details never survive here. */
export function parseStoredUploadResumes(raw: string | null): UploadResumeRecord[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => parseRecord(item) ?? []);
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

function readRecords(storage: UploadResumeStorage) {
  try {
    return parseStoredUploadResumes(storage.getItem(UPLOAD_RESUME_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeRecords(storage: UploadResumeStorage, records: UploadResumeRecord[]) {
  try {
    if (records.length === 0) storage.removeItem(UPLOAD_RESUME_STORAGE_KEY);
    else storage.setItem(UPLOAD_RESUME_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Browser storage is optional; upload correctness stays server-owned.
  }
}

export function loadUploadResume(storage: UploadResumeStorage, fingerprint: string) {
  return readRecords(storage).find((record) => record.fingerprint === fingerprint) ?? null;
}

export function saveUploadResume(storage: UploadResumeStorage, record: UploadResumeRecord) {
  const parsed = parseRecord(record);
  if (!parsed) return;
  writeRecords(storage, [
    ...readRecords(storage).filter((item) => item.fingerprint !== parsed.fingerprint),
    parsed,
  ]);
}

export function clearUploadResume(storage: UploadResumeStorage, fingerprint: string) {
  writeRecords(storage, readRecords(storage).filter((record) => record.fingerprint !== fingerprint));
}

/** The transfer has stopped, so this file is no longer held by a live tab. */
export function markUploadResumeIdle(storage: UploadResumeStorage, fingerprint: string) {
  const record = loadUploadResume(storage, fingerprint);
  if (record?.transferActiveAt != null) saveUploadResume(storage, { ...record, transferActiveAt: null });
}

/**
 * Stamps this file's record on a timer until the returned function stops it. A finalize,
 * a grant refresh or a retry backoff can outlast the window without moving a byte.
 */
export function keepUploadResumeActive(storage: UploadResumeStorage, fingerprint: string, now: () => number) {
  const stamp = () => {
    const record = loadUploadResume(storage, fingerprint);
    if (record) saveUploadResume(storage, { ...record, transferActiveAt: now() });
  };
  stamp();
  const timer = setInterval(stamp, UPLOAD_ACTIVE_WINDOW_MS / 4);
  return () => clearInterval(timer);
}

/**
 * Saved uploads of other files that no live tab is transferring. A person who moved on
 * from one still holds its credits and a processing slot until the session expires.
 */
export function abandonedUploadResumes(storage: UploadResumeStorage, fingerprint: string, now: number) {
  return readRecords(storage).filter(
    (record) =>
      record.fingerprint !== fingerprint &&
      (record.transferActiveAt === null || now - record.transferActiveAt > UPLOAD_ACTIVE_WINDOW_MS),
  );
}
