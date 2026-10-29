import { isApiError } from "@narriflow/api-client";
import { apiErrorMessage } from "@/app/_components/query-mutation-form";

/** Failures whose recovery wording (sign in, switch, wait) is the shared one, not the server's sentence. */
const SHARED_WORDING = new Set(["authentication_required", "active_workspace_mismatch", "workspace_restricted", "rate_limited"]);

/**
 * What to tell the person about a refused developer command. These routes refuse with
 * a specific, safe sentence (a webhook that already exists, a missing signing secret,
 * a key that was already issued), so an ordinary refusal shows it; anything else gets
 * the shared recovery wording. `null` when the result no longer belongs to this screen.
 */
export function developerFailureMessage(error: unknown, fallback: string): string | null {
  const shared = apiErrorMessage(error, fallback);
  if (shared === null) return null;
  const specific =
    isApiError(error) && error.status >= 400 && error.status < 500 && !SHARED_WORDING.has(error.code) && error.message;
  return specific || shared;
}
