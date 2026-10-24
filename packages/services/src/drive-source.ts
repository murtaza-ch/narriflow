import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  MAX_UPLOAD_SIZE_BYTES,
  userErrorMessage,
} from "@narriflow/validators";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureKind,
} from "./expected-domain-failure";
import {
  guardedFetch,
  readResponseTextBounded,
  type GuardedFetchOptions,
} from "./url-guard";

/**
 * Google Drive Picker intake. The browser holds a short-lived `drive.file`
 * access token for the one file the person chose. Intake reads that file's
 * metadata, seals the token on the Ingest Job, and the worker downloads with it.
 * No token appears in an error message, log, or response.
 */

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const METADATA_FIELDS = "id,name,mimeType,size,trashed,capabilities/canDownload,videoMediaMetadata/durationMillis";
const METADATA_TIMEOUT_MS = 15_000;
const MAX_METADATA_BYTES = 64 * 1024;

const driveFailureKinds = {
  drive_token_expired: "forbidden",
  drive_token_invalid: "forbidden",
  drive_file_unavailable: "unprocessable",
  drive_file_not_video: "unprocessable",
  remote_media_too_large: "unprocessable",
} as const satisfies Record<string, ExpectedDomainFailureKind>;

export type DriveSourceFailureCode = keyof typeof driveFailureKinds;

/** Carries a fixed, user-facing message only; never the response or the token. */
export class DriveSourceError extends ExpectedDomainFailureError<DriveSourceFailureCode> {
  constructor(code: DriveSourceFailureCode) {
    super({ code, kind: driveFailureKinds[code], message: userErrorMessage(code) ?? code });
    this.name = "DriveSourceError";
  }
}

export interface DriveFileMetadata {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  /** From Drive's video metadata, which can lag a fresh upload. */
  durationSeconds: number | null;
}

/** Reads what Drive knows about the chosen file. Intake takes the port so
 * tests can replace the network. */
export interface DriveFileReader {
  read(input: { fileId: string; accessToken: string }): Promise<DriveFileMetadata>;
}

/** Drive reports sizes and durations as decimal strings. */
function decimal(value: unknown): number | null {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function driveFileMediaUrl(fileId: string) {
  return `${DRIVE_FILES_URL}/${fileId}?alt=media&supportsAllDrives=true`;
}

/** Maps a Drive API status to what the person can do about it. */
function driveStatusFailure(status: number): DriveSourceError {
  return new DriveSourceError(status === 401 ? "drive_token_expired" : "drive_file_unavailable");
}

/** Drive answers 403 for a rate limit as well as for a file it won't serve. */
const RETRYABLE_DRIVE_REASONS = new Set(["userRateLimitExceeded", "rateLimitExceeded"]);

/**
 * Classifies a refused Drive download. An expired token or an unreadable file
 * is final. A rate limit (403 with a rate-limit reason) is transient, while
 * `downloadQuotaExceeded`, `cannotDownloadAbusiveFile` and every other 403
 * stay final. `body` is Drive's JSON error body, if any was read.
 */
export function driveDownloadRefusal(status: number, body: string): DriveSourceError | "transient" {
  if (status === 403) {
    try {
      const errors = record(record(JSON.parse(body))?.error)?.errors;
      if (
        Array.isArray(errors) &&
        errors.some((entry) => RETRYABLE_DRIVE_REASONS.has(String(record(entry)?.reason)))
      )
        return "transient";
    } catch {
      // An unreadable body is treated as a final refusal.
    }
  }
  return driveStatusFailure(status);
}

/**
 * Confirms the token was issued to this app's own client and carries
 * `drive.file`, so a token minted for another app can't be used to ask the
 * server to fetch files. The token travels in a POST body, never a URL.
 */
export async function verifyDriveAccessToken(
  accessToken: string,
  expected: { clientId: string },
  options: Pick<GuardedFetchOptions, "transport" | "resolver" | "signal"> = {},
): Promise<void> {
  let body: string;
  try {
    const response = await guardedFetch(TOKENINFO_URL, {
      ...options,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ access_token: accessToken }).toString(),
      timeoutMs: METADATA_TIMEOUT_MS,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // Google answers 400 for a token it doesn't recognize or that has lapsed.
      throw new DriveSourceError(response.status === 400 ? "drive_token_expired" : "drive_file_unavailable");
    }
    body = await readResponseTextBounded(response, MAX_METADATA_BYTES);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof DriveSourceError) throw error;
    throw new DriveSourceError("drive_file_unavailable");
  }
  let info: Record<string, unknown> | null;
  try {
    info = record(JSON.parse(body));
  } catch {
    throw new DriveSourceError("drive_file_unavailable");
  }
  const scopes = typeof info?.scope === "string" ? info.scope.split(" ") : [];
  if (info?.aud !== expected.clientId || !scopes.includes(GOOGLE_DRIVE_FILE_SCOPE))
    throw new DriveSourceError("drive_token_invalid");
}

export async function readDriveFileMetadata(
  input: { fileId: string; accessToken: string },
  options: Pick<GuardedFetchOptions, "transport" | "resolver" | "signal"> = {},
): Promise<DriveFileMetadata> {
  const url = new URL(`${DRIVE_FILES_URL}/${input.fileId}`);
  url.searchParams.set("fields", METADATA_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  let body: string;
  try {
    const response = await guardedFetch(url, {
      ...options,
      headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" },
      timeoutMs: METADATA_TIMEOUT_MS,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw driveStatusFailure(response.status);
    }
    body = await readResponseTextBounded(response, MAX_METADATA_BYTES);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof DriveSourceError) throw error;
    throw new DriveSourceError("drive_file_unavailable");
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new DriveSourceError("drive_file_unavailable");
  }
  const file = record(json);
  if (!file || typeof file.id !== "string" || typeof file.name !== "string" || typeof file.mimeType !== "string")
    throw new DriveSourceError("drive_file_unavailable");
  if (file.trashed === true || record(file.capabilities)?.canDownload === false)
    throw new DriveSourceError("drive_file_unavailable");
  if (!file.mimeType.startsWith("video/")) throw new DriveSourceError("drive_file_not_video");
  const sizeBytes = decimal(file.size);
  if (sizeBytes !== null && sizeBytes > MAX_UPLOAD_SIZE_BYTES) throw new DriveSourceError("remote_media_too_large");
  const durationMillis = decimal(record(file.videoMediaMetadata)?.durationMillis);
  return {
    fileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes,
    durationSeconds: durationMillis ? Math.ceil(durationMillis / 1000) : null,
  };
}

/** Verifies the token's origin, then reads the file. The client ID is the
 * public one the browser used (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`), read at call
 * time; without it nothing is admitted. */
export function createGoogleDriveFileReader(
  options: { clientId?: string } & Pick<GuardedFetchOptions, "transport" | "resolver"> = {},
): DriveFileReader {
  const { clientId, ...fetchOptions } = options;
  return {
    async read(input) {
      const expected = clientId ?? process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim();
      if (!expected) throw new DriveSourceError("drive_token_invalid");
      await verifyDriveAccessToken(input.accessToken, { clientId: expected }, fetchOptions);
      return readDriveFileMetadata(input, fetchOptions);
    },
  };
}

export const googleDriveFileReader = createGoogleDriveFileReader();

function tokenKey(material: string) {
  if (!material.trim()) throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY is required for Google Drive intake");
  return Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), "narriflow-drive-intake-token-v1", 32));
}

/** Seals the Drive access token with a purpose-bound key derived from the
 * existing data encryption key material, as Completion Callback URLs are. */
export function createDriveTokenCipher(material = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY ?? "") {
  const key = tokenKey(material);
  return {
    seal(token: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
    },
    open(sealed: string) {
      const [version, iv, tag, ciphertext] = sealed.split(":");
      if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported sealed Drive credential");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

export type DriveTokenCipher = ReturnType<typeof createDriveTokenCipher>;
