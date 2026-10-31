import { bindServiceTestEnvironment } from "./runtime-test-support";
import { describe, expect, test } from "bun:test";
import { PAID_ACCESS_ENDED_GRACE_DAYS, planLimits } from "@narriflow/validators";
import {
  RETENTION_POLICIES,
  ProjectRetentionService,
  isProjectAccessible,
  retentionAssignmentForNewProject,
  retentionTransitionForTierChange,
} from "./project-retention.service";

describe("project retention policy", () => {
  test("a new Free project gets the catalog's 72-hour deadline without any configuration", bindServiceTestEnvironment(() => {
    const createdAt = new Date("2026-08-21T05:06:07.008Z");
    const assignment = retentionAssignmentForNewProject({ tier: "free", createdAt });
    expect(assignment?.retentionPolicyKey).toBe("free_project_v1");
    expect(assignment?.expiresAt.getTime()).toBe(createdAt.getTime() + 72 * 60 * 60 * 1000);
    expect(RETENTION_POLICIES.free_project_v1.durationMs).toBe(
      (planLimits("free").projectRetentionHours ?? 0) * 60 * 60 * 1000,
    );
  }));

  test("a Free deadline is assigned even when legacy retention variables say observe", bindServiceTestEnvironment(async () => {
    const prior = process.env.PROJECT_RETENTION_MODE;
    process.env.PROJECT_RETENTION_MODE = "observe";
    try {
      const createdAt = new Date("2026-08-21T00:00:00.000Z");
      expect(await new ProjectRetentionService().assignmentForWorkspace("workspace-1", createdAt)).toEqual({
        retentionPolicyKey: "free_project_v1",
        expiresAt: new Date(createdAt.getTime() + RETENTION_POLICIES.free_project_v1.durationMs),
      });
    } finally {
      if (prior === undefined) delete process.env.PROJECT_RETENTION_MODE;
      else process.env.PROJECT_RETENTION_MODE = prior;
    }
  }));

  test("paid projects never receive the Free deadline", bindServiceTestEnvironment(() => {
    expect(
      retentionAssignmentForNewProject({
        tier: "creator",
        createdAt: new Date("2026-08-21T00:00:00.000Z"),
      }),
    ).toBeNull();
  }));

  test("paid-to-Free transition assigns an exact 28-day grace deadline", bindServiceTestEnvironment(() => {
    const effectiveAt = new Date("2026-08-25T10:00:00.000Z");
    const transition = retentionTransitionForTierChange({
      previousTier: "creator",
      nextTier: "free",
      effectiveAt,
    });
    expect(transition.kind).toBe("assign_downgrade");
    if (transition.kind !== "assign_downgrade") return;
    expect(transition.assignment.retentionPolicyKey).toBe(
      "downgrade_to_free_v1",
    );
    expect(transition.assignment.expiresAt.getTime()).toBe(
      effectiveAt.getTime() +
        RETENTION_POLICIES.downgrade_to_free_v1.durationMs,
    );
  }));

  test("an upgrade clears still-unexpired project deadlines", bindServiceTestEnvironment(() => {
    expect(
      retentionTransitionForTierChange({
        previousTier: "free",
        nextTier: "creator",
        effectiveAt: new Date("2026-08-25T10:00:00.000Z"),
      }),
    ).toEqual({ kind: "clear_unexpired" });
  }));

  test("upgrade persistence uses a strict greater-than deadline boundary", bindServiceTestEnvironment(async () => {
    const calls: Array<Record<string, unknown>> = [];
    const service = new ProjectRetentionService();
    const effectiveAt = new Date("2026-08-25T10:00:00.000Z");
    await service.applyWorkspaceTierTransition(
      {
        project: {
          updateMany: async (input: Record<string, unknown>) => {
            calls.push(input);
            return { count: 1 };
          },
        },
      } as never,
      {
        workspaceId: "workspace-1",
        previousTier: "free",
        nextTier: "creator",
        effectiveAt,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      where: {
        expiresAt: { gt: effectiveAt },
        purgeDeletedObjectCount: 0,
        purgeStorageVerifiedAt: null,
      },
    });
  }));

  test("Workspace recovery cannot clear a deadline that passed before verification", bindServiceTestEnvironment(async () => {
    const calls: Array<Record<string, unknown>> = [];
    const service = new ProjectRetentionService();
    const effectiveAt = new Date("2026-08-25T10:00:00.000Z");
    const observedAt = new Date("2026-08-26T10:00:00.000Z");
    await service.applyWorkspaceTierTransition(
      {
        project: {
          updateMany: async (input: Record<string, unknown>) => {
            calls.push(input);
            return { count: 1 };
          },
        },
      } as never,
      {
        workspaceId: "workspace-1",
        previousTier: "free",
        nextTier: "pro",
        effectiveAt,
        observedAt,
      },
    );

    expect(
      ((calls[0]?.where as { expiresAt: { gt: Date } }).expiresAt.gt),
    ).toEqual(observedAt);
  }));

  test("the paid-to-Free grace is the catalog's 28 days", bindServiceTestEnvironment(() => {
    expect(RETENTION_POLICIES.downgrade_to_free_v1.durationMs).toBe(
      PAID_ACCESS_ENDED_GRACE_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(
      retentionTransitionForTierChange({
        previousTier: "free",
        nextTier: "free",
        effectiveAt: new Date("2026-08-25T10:00:00.000Z"),
      }),
    ).toEqual({ kind: "none" });
  }));

  test("access locks at the exact deadline and when purge is fenced", bindServiceTestEnvironment(() => {
    const deadline = new Date("2026-08-24T00:00:00.000Z");
    expect(
      isProjectAccessible(
        { expiresAt: deadline, purgeStartedAt: null },
        new Date(deadline.getTime() - 1),
      ),
    ).toBe(true);
    expect(
      isProjectAccessible(
        { expiresAt: deadline, purgeStartedAt: null },
        deadline,
      ),
    ).toBe(false);
    expect(
      isProjectAccessible(
        { expiresAt: null, purgeStartedAt: new Date() },
        new Date(0),
      ),
    ).toBe(false);
  }));

});
