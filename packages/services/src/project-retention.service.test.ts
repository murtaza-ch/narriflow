import { describe, expect, test } from "bun:test";
import {
  RETENTION_POLICIES,
  ProjectRetentionService,
  deleteProjectPrefixObjects,
  isProjectAccessible,
  projectDeletionHash,
  retentionAssignmentForNewProject,
  retentionTransitionForTierChange,
} from "./project-retention.service";

const ACTIVATION = new Date("2026-08-20T00:00:00.000Z");

describe("project retention policy", () => {
  test("observe mode never persists a deadline", () => {
    expect(
      retentionAssignmentForNewProject({
        tier: "free",
        createdAt: new Date("2026-08-21T00:00:00.000Z"),
        config: { mode: "observe", activationAt: ACTIVATION },
      }),
    ).toBeNull();
  });

  test("grandfathers projects created before activation", () => {
    expect(
      retentionAssignmentForNewProject({
        tier: "free",
        createdAt: new Date(ACTIVATION.getTime() - 1),
        config: { mode: "enforce", activationAt: ACTIVATION },
      }),
    ).toBeNull();
  });

  test("persists an exact 72-hour deadline for a post-activation Free project", () => {
    const createdAt = new Date("2026-08-21T05:06:07.008Z");
    const assignment = retentionAssignmentForNewProject({
      tier: "free",
      createdAt,
      config: { mode: "enforce", activationAt: ACTIVATION },
    });
    expect(assignment?.retentionPolicyKey).toBe("free_project_v1");
    expect(assignment?.expiresAt.getTime()).toBe(
      createdAt.getTime() + RETENTION_POLICIES.free_project_v1.durationMs,
    );
  });

  test("paid projects never receive the Free deadline", () => {
    expect(
      retentionAssignmentForNewProject({
        tier: "creator",
        createdAt: new Date("2026-08-21T00:00:00.000Z"),
        config: { mode: "enforce", activationAt: ACTIVATION },
      }),
    ).toBeNull();
  });

  test("paid-to-Free transition assigns an exact 28-day grace deadline", () => {
    const effectiveAt = new Date("2026-08-25T10:00:00.000Z");
    const transition = retentionTransitionForTierChange({
      previousTier: "creator",
      nextTier: "free",
      effectiveAt,
      config: { mode: "enforce", activationAt: ACTIVATION },
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
  });

  test("an upgrade clears still-unexpired project deadlines", () => {
    expect(
      retentionTransitionForTierChange({
        previousTier: "free",
        nextTier: "starter",
        effectiveAt: new Date("2026-08-25T10:00:00.000Z"),
        config: { mode: "enforce", activationAt: ACTIVATION },
      }),
    ).toEqual({ kind: "clear_unexpired" });
  });

  test("upgrade persistence uses a strict greater-than deadline boundary", async () => {
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
  });

  test("Workspace recovery cannot clear a deadline that passed before verification", async () => {
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
  });

  test("observe mode does not assign downgrade deadlines", () => {
    expect(
      retentionTransitionForTierChange({
        previousTier: "pro",
        nextTier: "free",
        effectiveAt: new Date("2026-08-25T10:00:00.000Z"),
        config: { mode: "observe", activationAt: ACTIVATION },
      }),
    ).toEqual({ kind: "none" });
  });

  test("access locks at the exact deadline and when purge is fenced", () => {
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
  });

  test("deletion identity is a stable content-free SHA-256 hash", () => {
    const hash = projectDeletionHash("0beec7b5-ea3f-4b61-8c8b-35c7f34af830");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(
      projectDeletionHash("0beec7b5-ea3f-4b61-8c8b-35c7f34af830"),
    );
  });
});

describe("project prefix deletion", () => {
  test("deletes more than 1,000 objects in bounded batches until the prefix is empty", async () => {
    const objects = new Map(
      Array.from({ length: 1_250 }, (_, index) => [
        `projects/project-1/object-${index}`,
        index + 1,
      ]),
    );
    const batchSizes: number[] = [];
    const result = await deleteProjectPrefixObjects("project-1", {
      list: async (prefix, limit) =>
        [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .slice(0, limit)
          .map(([key, sizeBytes]) => ({ key, sizeBytes })),
      deleteBatch: async (keys) => {
        batchSizes.push(keys.length);
        for (const key of keys) objects.delete(key);
      },
    });

    expect(batchSizes).toEqual([1000, 250]);
    expect(result.objectCount).toBe(1_250);
    expect(result.totalBytes).toBe((1_250 * 1_251) / 2);
    expect(objects.size).toBe(0);
  });

  test("a retry continues safely after a completed earlier batch", async () => {
    const objects = new Map(
      Array.from({ length: 1_005 }, (_, index) => [
        `projects/project-2/object-${index}`,
        1,
      ]),
    );
    let calls = 0;
    const dependencies = {
      list: async (prefix: string, limit: number) =>
        [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .slice(0, limit)
          .map(([key, sizeBytes]) => ({ key, sizeBytes })),
      deleteBatch: async (keys: string[]) => {
        calls += 1;
        if (calls === 2) throw new Error("temporary R2 failure");
        for (const key of keys) objects.delete(key);
      },
    };

    await expect(
      deleteProjectPrefixObjects("project-2", dependencies),
    ).rejects.toThrow("temporary R2 failure");
    expect(objects.size).toBe(5);

    const retried = await deleteProjectPrefixObjects("project-2", {
      ...dependencies,
      deleteBatch: async (keys) => {
        for (const key of keys) objects.delete(key);
      },
    });
    expect(retried.objectCount).toBe(5);
    expect(objects.size).toBe(0);
  });
});
