import type { AuthenticatedRequestResult } from "../../http/request-policy";

export type ReauthorizationResult =
  | { ok: true }
  | { ok: false; error: string; requestId?: string };

/** The stable failure code and request ID of a refused re-check; nothing else about the refusal is exposed. */
export function reauthorizationResult(
  result: AuthenticatedRequestResult<unknown>,
): ReauthorizationResult {
  return result.ok
    ? { ok: true }
    : { ok: false, error: result.failure.code, requestId: result.requestId };
}

export interface ReauthorizationControl {
  error: string;
  requestId?: string;
}

/**
 * Serializes the stream's periodic access checks. A check in flight absorbs
 * further calls; the first refusal (or unexpected failure) sends exactly one
 * control event, cleans up and closes, and every later call is a no-op.
 */
export function createReauthorizationGuard(dependencies: {
  authorize(): Promise<ReauthorizationResult>;
  onAuthorized(): void;
  onRevoked(control: ReauthorizationControl): void;
  cleanup(): void;
  close(): void;
  unexpectedControl(error: unknown): ReauthorizationControl;
}) {
  let active = true;
  let inFlight: Promise<void> | null = null;

  function revoke(control: ReauthorizationControl) {
    if (!active) return;
    active = false;
    try {
      dependencies.onRevoked(control);
    } finally {
      dependencies.cleanup();
      dependencies.close();
    }
  }

  return {
    check(): Promise<void> {
      if (!active) return Promise.resolve();
      if (inFlight) return inFlight;
      inFlight = dependencies
        .authorize()
        .then((result) => {
          if (!active) return;
          if (!result.ok) {
            revoke({
              error: result.error,
              ...(result.requestId ? { requestId: result.requestId } : {}),
            });
            return;
          }
          dependencies.onAuthorized();
        })
        .catch((error) => revoke(dependencies.unexpectedControl(error)))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    stop() {
      active = false;
    },
  };
}
