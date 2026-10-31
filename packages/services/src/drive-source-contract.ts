import { userErrorMessage } from "@narriflow/validators";
import { ExpectedDomainFailureError,type ExpectedDomainFailureKind } from "./expected-domain-failure";

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

function record(value: unknown):Record<string,unknown>|null {
 return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;
}

/** Maps a Drive API status to what the person can do about it. */
export function driveStatusFailure(status: number): DriveSourceError {
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

