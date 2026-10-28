import { isApiError } from "@narriflow/api-client";
import { hasUserErrorMessage, userErrorMessage } from "@narriflow/validators";

/**
 * Resolves action feedback for a failed API call without allowing provider
 * details to override the bounded product copy for a known error code. A
 * failure that never reached the API (offline, scope change) gets the caller's
 * fallback, never the transport's message.
 */
export function clipActionErrorCopy(failure: unknown, fallback: string): string {
  if (!isApiError(failure) || failure.status === 0) return fallback;
  if (hasUserErrorMessage(failure.code)) return userErrorMessage(failure.code) ?? fallback;
  return failure.message.length > 0 ? failure.message : fallback;
}

/**
 * Whether a failed command may have been accepted or may have lost a race:
 * no response, a server fault, or a conflict. The screen then refetches the
 * domain state instead of guessing; a plain 400/403/404/422 refusal changed
 * nothing and needs no refetch.
 */
export function failureNeedsStateRefetch(failure: unknown): boolean {
  if (!isApiError(failure)) return true;
  return failure.status === 0 || failure.status === 409 || failure.status >= 500;
}
