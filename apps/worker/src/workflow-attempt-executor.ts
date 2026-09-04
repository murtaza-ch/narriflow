import type {
  ClaimedWorkflowAttempt,
  WorkflowAttemptContext,
  WorkflowAttemptRef,
} from "@narriflow/services";
import { WorkflowAttemptLost } from "@narriflow/services";

interface WorkflowAttemptRunner {
  runAttempt<T>(
    attempt: WorkflowAttemptRef,
    handler: (context: WorkflowAttemptContext) => Promise<T>,
  ): Promise<T>;
}

type ClaimedAttemptFor<TStage extends WorkflowAttemptRef["stage"]> =
  ClaimedWorkflowAttempt & { stage: TStage };

interface WorkflowAttemptClaimer extends WorkflowAttemptRunner {
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
}): Promise<0 | 1> {
  const claimed = await input.lifecycle.claim(input.stage);
  if (!claimed) return 0;
  const attempt = claimed;
  const startedAtMs = Date.now();
  await executeClaimedWorkflowAttempt({
    attempt,
    lifecycle: input.lifecycle,
    process: input.process,
    onAttemptLost: (error) =>
      input.onAttemptLost?.(attempt, error, startedAtMs),
  });
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
}): Promise<"completed" | "lost"> {
  try {
    await input.lifecycle.runAttempt(input.attempt, (context) =>
      input.process(input.attempt, context),
    );
    return "completed";
  } catch (error) {
    if (!(error instanceof WorkflowAttemptLost)) throw error;
    input.onAttemptLost?.(error);
    return "lost";
  }
}
