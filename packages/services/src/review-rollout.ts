export type ReviewRolloutControl =
  | "creation"
  | "guest_read"
  | "feedback_mutation"
  | "notification_admission";

export type ReviewApprovalRolloutMode = "warn" | "enforce";

export interface ReviewRolloutPolicy {
  isEnabled(control: ReviewRolloutControl): boolean;
}

export interface ReviewApprovalRolloutPolicy {
  modeFor(input: {
    workspaceId: string;
    projectId: string;
  }): ReviewApprovalRolloutMode;
}

const REVIEW_CONTROL_ENV: Record<ReviewRolloutControl, string> = {
  creation: "NARRIFLOW_WRITES_REVIEW_ROOMS",
  guest_read: "NARRIFLOW_READS_REVIEW_GUEST",
  feedback_mutation: "NARRIFLOW_WRITES_REVIEW_FEEDBACK",
  notification_admission: "NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ReviewRolloutConfigurationError extends Error {
  readonly code = "review_rollout_configuration_invalid";

  constructor() {
    super("Review rollout configuration is invalid");
    this.name = "ReviewRolloutConfigurationError";
  }
}

export function createReviewRolloutPolicy(
  env: Record<string, string | undefined> = process.env,
): ReviewRolloutPolicy {
  return {
    isEnabled(control) {
      return env[REVIEW_CONTROL_ENV[control]] === "1";
    },
  };
}

function parseCohortIds(value: string | undefined) {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.some((entry) => !UUID_PATTERN.test(entry))) {
    throw new ReviewRolloutConfigurationError();
  }
  return new Set(entries);
}

export function createReviewApprovalRolloutPolicy(
  env: Record<string, string | undefined> = process.env,
): ReviewApprovalRolloutPolicy {
  return {
    modeFor(input) {
      const configuredMode =
        env.NARRIFLOW_REVIEW_APPROVAL_MODE?.trim() || "enforce";
      if (configuredMode !== "warn" && configuredMode !== "enforce") {
        throw new ReviewRolloutConfigurationError();
      }
      const workspaceIds = parseCohortIds(
        env.NARRIFLOW_REVIEW_APPROVAL_ENFORCE_WORKSPACE_IDS,
      );
      const projectIds = parseCohortIds(
        env.NARRIFLOW_REVIEW_APPROVAL_ENFORCE_PROJECT_IDS,
      );
      if (configuredMode === "warn") return "warn";
      if (workspaceIds.size === 0 && projectIds.size === 0) return "enforce";
      return workspaceIds.has(input.workspaceId) || projectIds.has(input.projectId)
        ? "enforce"
        : "warn";
    },
  };
}

export const reviewRolloutPolicy = createReviewRolloutPolicy();
export const reviewApprovalRolloutPolicy =
  createReviewApprovalRolloutPolicy();
