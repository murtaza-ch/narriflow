export type WorkflowStreamReauthorizationResult =
  | { ok: true }
  | { ok: false; error: string; requestId?: string };

export function workflowStreamAuthorizationResult(
  result: AuthenticatedRequestResult<unknown>,
): WorkflowStreamReauthorizationResult {
  return result.ok
    ? { ok: true }
    : {
        ok: false,
        error: result.failure.code,
        requestId: result.requestId,
      };
}

export function createWorkflowStreamReauthorizationGuard(dependencies: {
  authorize(): Promise<WorkflowStreamReauthorizationResult>;
  onAuthorized(): void;
  onRevoked(control: { error: string; requestId?: string }): void;
  cleanup(): void;
  close(): void;
  unexpectedControl(error: unknown): { error: string; requestId?: string };
}) {
  let active = true;
  let inFlight: Promise<void> | null = null;

  function revoke(control: { error: string; requestId?: string }) {
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
import type { AuthenticatedRequestResult } from "./authenticated-request-policy";
