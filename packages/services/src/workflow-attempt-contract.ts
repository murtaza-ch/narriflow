import type { WorkflowStage } from "@narriflow/validators";
import { isExpectedDomainFailure } from "./expected-domain-failure";

export const WORKFLOW_LEASE_DURATION_MS = 2 * 60 * 1000;
export const WORKFLOW_HEARTBEAT_INTERVAL_MS = 30 * 1000;

export interface WorkflowAttemptRef {
  workflowRunId: string;
  projectId: string;
  stage: WorkflowStage;
  attemptId: string;
  attemptCount: number;
}

export type WorkflowFailureDisposition = "retryable" | "permanent";

export function workflowHttpFailureDisposition(
  status: number,
): WorkflowFailureDisposition {
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? "retryable"
    : "permanent";
}

export class WorkflowFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly disposition: WorkflowFailureDisposition,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowFailure";
  }
}

export class WorkflowAttemptLost extends Error {
  readonly code = "workflow_attempt_lost";

  constructor(public readonly attempt: WorkflowAttemptRef) {
    super(`Workflow attempt ${attempt.attemptId} no longer owns ${attempt.workflowRunId}`);
    this.name = "WorkflowAttemptLost";
  }
}

export interface WorkflowAttemptContext {
  signal: AbortSignal;
  reportProgress: (progress: number) => Promise<void>;
}


export function workflowFailureFromUnknown(error: unknown): WorkflowFailure {
  if (error instanceof WorkflowFailure) return error;
  const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "workflow_unexpected_error";
  const message =
    typeof candidate.message === "string" ? candidate.message : "Unexpected workflow failure";
  const retryable = isExpectedDomainFailure(error)
    ? error.details?.retryable
    : candidate.retryable;
  return new WorkflowFailure(
    code,
    retryable === false ? "permanent" : "retryable",
    message,
    error instanceof Error ? { cause: error } : undefined,
  );
}

export function rethrowWorkflowAttemptLost(error: unknown): void {
  if (error instanceof WorkflowAttemptLost) throw error;
}
