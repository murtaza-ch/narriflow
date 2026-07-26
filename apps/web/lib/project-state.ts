import {
  workflowStageUpdatedEventSchema,
  type WorkflowStageUpdatedEvent,
} from "@narriflow/validators";

export const PROJECT_EVENT_ROW_LIMIT = 20;
export const PROJECT_EVENT_IDENTITY_LIMIT = 100;

export type PipelineStepState = "done" | "active" | "failed" | "todo";

type WorkflowRunLike = {
  stage: string;
  status: string;
};

type RenderVariantLike = {
  status: string;
  hasAsset: boolean;
};

type SocialPostLike = {
  status: string;
};

export function parseWorkflowEventMessage(
  message: string,
): WorkflowStageUpdatedEvent | null {
  try {
    const parsed = workflowStageUpdatedEventSchema.safeParse(JSON.parse(message));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function workflowEventRowIdentity(
  event: Pick<WorkflowStageUpdatedEvent, "projectId" | "seq">,
): string {
  return `${event.projectId}:${event.seq}`;
}

export function workflowTerminalEventIdentity(
  event: Pick<WorkflowStageUpdatedEvent, "workflowRunId" | "seq">,
): string {
  return `${event.workflowRunId}:${event.seq}`;
}

/**
 * Records an identity once while bounding memory. Set iteration order is
 * insertion order, so the oldest identity is evicted first.
 */
export function rememberBoundedIdentity(
  identities: Set<string>,
  identity: string,
  limit = PROJECT_EVENT_IDENTITY_LIMIT,
): boolean {
  if (identities.has(identity)) return false;

  identities.add(identity);
  const boundedLimit = Math.max(1, limit);
  while (identities.size > boundedLimit) {
    const oldest = identities.values().next().value;
    if (typeof oldest !== "string") break;
    identities.delete(oldest);
  }

  return true;
}

export function deriveProjectPipelineStates(input: {
  clipCount: number;
  latestRun: WorkflowRunLike | null;
  renderVariants: readonly RenderVariantLike[];
  socialPosts: readonly SocialPostLike[];
}): {
  detect: PipelineStepState;
  render: PipelineStepState;
  publish: PipelineStepState;
} {
  const detectionRun =
    input.latestRun?.stage === "moment_detection" ? input.latestRun : null;
  const detect: PipelineStepState =
    input.clipCount > 0
      ? "done"
      : detectionRun?.status === "queued" || detectionRun?.status === "running"
        ? "active"
        : detectionRun?.status === "failed"
          ? "failed"
          : "todo";

  const render: PipelineStepState = input.renderVariants.some(
    (variant) => variant.hasAsset,
  )
    ? "done"
    : input.renderVariants.some(
          (variant) =>
            variant.status === "pending" || variant.status === "rendering",
        )
      ? "active"
      : input.renderVariants.length > 0 &&
          input.renderVariants.every((variant) => variant.status === "failed")
        ? "failed"
        : "todo";

  const publish: PipelineStepState = input.socialPosts.some(
    (post) => post.status === "posted",
  )
    ? "done"
    : input.socialPosts.some(
          (post) => post.status === "scheduled" || post.status === "publishing",
        )
      ? "active"
      : input.socialPosts.some((post) => post.status === "failed")
        ? "failed"
        : "todo";

  return { detect, render, publish };
}
