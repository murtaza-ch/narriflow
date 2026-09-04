import type {
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
