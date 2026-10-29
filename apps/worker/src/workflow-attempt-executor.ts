import type {
  ClaimedWorkflowAttempt,
  WorkflowAttemptContext,
  WorkflowAttemptRef,
} from "@narriflow/services";
import { WorkflowAttemptLost } from "@narriflow/services";
import { executorProcessFailure } from "./worker-process";
import { RenderResourceDeferral } from "./render-resource-budget";
import { renderInterruptionMediaStarted } from "./render-executor-health";

interface WorkflowAttemptRunner {
  runAttempt<T>(
    attempt: WorkflowAttemptRef,
    handler: (context: WorkflowAttemptContext) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
}

type ClaimedAttemptFor<TStage extends WorkflowAttemptRef["stage"]> =
  ClaimedWorkflowAttempt & { stage: TStage };

interface WorkflowAttemptClaimer extends WorkflowAttemptRunner {
  releaseAttempt(attempt: WorkflowAttemptRef, options?: { refundAttempt?: boolean; reason?: string }): Promise<boolean>;
  claim<TStage extends WorkflowAttemptRef["stage"]>(
    stage: TStage,
  ): Promise<ClaimedAttemptFor<TStage> | null>;
}

export async function executeNextWorkflowAttempt<
  TStage extends WorkflowAttemptRef["stage"],
>(input: {
  stage: TStage;
  lifecycle: WorkflowAttemptClaimer;
  process: (
    attempt: ClaimedAttemptFor<TStage>,
    context: WorkflowAttemptContext,
  ) => Promise<void>;
  onAttemptLost?: (
    attempt: ClaimedAttemptFor<TStage>,
    error: WorkflowAttemptLost,
    startedAtMs: number,
  ) => void;
  /** Worker lifetime cancellation stops heartbeats and active subprocesses. */
  signal?: AbortSignal;
  canStart?: () => boolean;
  onExecutorFailure?: (error: unknown) => void;
  /** Wraps the claimed attempt's execution so the caller can tell the lease
   * heartbeat, not a tick budget, is now bounding the work. */
  holdingLease?: <T>(work: () => Promise<T>) => Promise<T>;
}): Promise<0 | 1> {
  if (input.signal?.aborted || input.canStart?.() === false) return 0;
  const claimed = await input.lifecycle.claim(input.stage);
  // Shutdown can arrive while the claim is in flight. Return it without
  // starting its handler or charging a failed execution.
  if (input.signal?.aborted || input.canStart?.() === false) {
    if (claimed) await input.lifecycle.releaseAttempt(claimed);
    return 0;
  }
  if (!claimed) return 0;
  const attempt = claimed;
  const startedAtMs = Date.now();
  const execute = () =>
    executeClaimedWorkflowAttempt({
      attempt,
      lifecycle: input.lifecycle,
      signal: input.signal,
      process: input.process,
      onAttemptLost: (error) =>
        input.onAttemptLost?.(attempt, error, startedAtMs),
    });
  try {
    await (input.holdingLease ? input.holdingLease(execute) : execute());
  } catch (error) {
    const healthFailure = executorProcessFailure(error);
    if (!healthFailure && !(error instanceof RenderResourceDeferral)) throw error;
    if (healthFailure) input.onExecutorFailure?.(healthFailure);
    // runAttempt has stopped its heartbeat before this fenced release.
    await input.lifecycle.releaseAttempt(attempt, {
      refundAttempt: !renderInterruptionMediaStarted(error),
      reason: healthFailure?.code ?? (error as RenderResourceDeferral).code,
    });
    return 0;
  }
  return 1;
}

export async function executeClaimedWorkflowAttempt<
  TAttempt extends WorkflowAttemptRef,
>(input: {
  attempt: TAttempt;
  lifecycle: WorkflowAttemptRunner;
  process: (
    attempt: TAttempt,
    context: WorkflowAttemptContext,
  ) => Promise<void>;
  onAttemptLost?: (error: WorkflowAttemptLost) => void;
  signal?: AbortSignal;
}): Promise<"completed" | "lost" | "interrupted"> {
  try {
    await input.lifecycle.runAttempt(
      input.attempt,
      (context) => input.process(input.attempt, context),
      { signal: input.signal },
    );
    return input.signal?.aborted ? "interrupted" : "completed";
  } catch (error) {
    if (input.signal?.aborted) return "interrupted";
    if (!(error instanceof WorkflowAttemptLost)) throw error;
    input.onAttemptLost?.(error);
    return "lost";
  }
}
