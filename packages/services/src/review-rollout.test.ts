import { describe, expect, test } from "bun:test";
import {
  ReviewRolloutConfigurationError,
  createReviewApprovalRolloutPolicy,
  createReviewRolloutPolicy,
} from "./review-rollout";

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("Review rollout policy", () => {
  test("keeps creation, guest reads, feedback, and notifications independent", () => {
    const policy = createReviewRolloutPolicy({
      NARRIFLOW_WRITES_REVIEW_ROOMS: "1",
      NARRIFLOW_READS_REVIEW_GUEST: "1",
      NARRIFLOW_WRITES_REVIEW_FEEDBACK: "0",
      NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS: "1",
    });

    expect(policy.isEnabled("creation")).toBe(true);
    expect(policy.isEnabled("guest_read")).toBe(true);
    expect(policy.isEnabled("feedback_mutation")).toBe(false);
    expect(policy.isEnabled("notification_admission")).toBe(true);
  });

  test("fails closed when a control is absent", () => {
    const policy = createReviewRolloutPolicy({});

    expect(policy.isEnabled("creation")).toBe(false);
    expect(policy.isEnabled("guest_read")).toBe(false);
    expect(policy.isEnabled("feedback_mutation")).toBe(false);
    expect(policy.isEnabled("notification_admission")).toBe(false);
  });
});

describe("Review approval rollout policy", () => {
  test("enforces globally by default", () => {
    const policy = createReviewApprovalRolloutPolicy({});

    expect(
      policy.modeFor({ workspaceId: id(1), projectId: id(2) }),
    ).toBe("enforce");
  });

  test("supports a global warn-only stage", () => {
    const policy = createReviewApprovalRolloutPolicy({
      NARRIFLOW_REVIEW_APPROVAL_MODE: "warn",
    });

    expect(
      policy.modeFor({ workspaceId: id(1), projectId: id(2) }),
    ).toBe("warn");
  });

  test("enforces only eligible workspaces or projects when cohorts are set", () => {
    const policy = createReviewApprovalRolloutPolicy({
      NARRIFLOW_REVIEW_APPROVAL_MODE: "enforce",
      NARRIFLOW_REVIEW_APPROVAL_ENFORCE_WORKSPACE_IDS: `${id(1)},${id(3)}`,
      NARRIFLOW_REVIEW_APPROVAL_ENFORCE_PROJECT_IDS: id(5),
    });

    expect(
      policy.modeFor({ workspaceId: id(1), projectId: id(2) }),
    ).toBe("enforce");
    expect(
      policy.modeFor({ workspaceId: id(9), projectId: id(5) }),
    ).toBe("enforce");
    expect(
      policy.modeFor({ workspaceId: id(9), projectId: id(8) }),
    ).toBe("warn");
  });

  test("fails closed on malformed cohort configuration", () => {
    const policy = createReviewApprovalRolloutPolicy({
      NARRIFLOW_REVIEW_APPROVAL_MODE: "enforce",
      NARRIFLOW_REVIEW_APPROVAL_ENFORCE_PROJECT_IDS: "not-a-project-id",
    });

    expect(() =>
      policy.modeFor({ workspaceId: id(1), projectId: id(2) }),
    ).toThrow(ReviewRolloutConfigurationError);
  });
});
