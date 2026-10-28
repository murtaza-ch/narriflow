import { type ApiError, isApiError } from "@narriflow/api-client/core";
import { hasUserErrorMessage, userErrorMessage } from "@narriflow/validators";
import {
  authenticatedRequestFailureMessage,
  type BrowserRequestFailure,
} from "@/lib/authenticated-request-browser";

/**
 * A Processing Usage refusal states the exact credits, length or wait the plan
 * catalog derived; that text is the user-facing copy, not a code lookup.
 */
const USAGE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "credits_exhausted",
  "upload_too_long",
  "workspace_processing_capacity_reached",
  "credits_reservation_released",
]);

/** The failure facts the upgrade and recovery helpers read, from a typed API failure. */
export function failureFromApiError(error: ApiError): BrowserRequestFailure {
  return {
    error: error.code,
    code: error.code,
    message: error.message,
    ...(error.requestId ? { requestId: error.requestId } : {}),
    ...(error.details ? { details: { ...error.details } } : {}),
    ...(error.issues.length > 0
      ? { issues: error.issues.map((issue) => ({ path: [...issue.path], code: issue.code, message: issue.message })) }
      : {}),
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  };
}

/**
 * The sentence an intake form shows for a failed command: the server's own text for a
 * usage refusal, the catalog copy for a known domain code, otherwise the shared recovery
 * wording (sign in again, switch Workspace, wait) around `fallback`.
 */
export function intakeFailureMessage(error: unknown, fallback: string, destination = "/upload"): string {
  if (!isApiError(error)) return error instanceof Error && error.message ? error.message : fallback;
  if (USAGE_REFUSAL_CODES.has(error.code) && error.message) return error.message;
  if (hasUserErrorMessage(error.code)) return userErrorMessage(error.code) ?? fallback;
  return authenticatedRequestFailureMessage(failureFromApiError(error), destination, fallback);
}
