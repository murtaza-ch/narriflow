import { describe, expect, test } from "bun:test";
import { executionDispatchIdentity, createExecutionDispatch, type ExecutionDispatchDatabase } from "./execution-dispatch";

const registration = {
  deploymentEpoch: 1, kind: "import_pipeline" as const,
  subject: { kind: "ingest_job" as const, id: "477b7dc3-0584-44db-8ae7-e9269e8d37af" }, generation: 1,
};

describe("Execution Dispatch identity", () => {
  test("separates wake/deadline delivery identities from their stable Workflow instance", async () => {
    const initial = await executionDispatchIdentity(registration);
    const audio = await executionDispatchIdentity({ ...registration, wakeKind: "audio_ready" });
    const video = await executionDispatchIdentity({ ...registration, wakeKind: "video_ready" });
    const deadline = await executionDispatchIdentity({ ...registration, deadlineKind: "lease", observedDeadlineAt: new Date("2026-10-31T00:02:00.000Z") });
    expect(new Set([initial.deliveryKey, audio.deliveryKey, video.deliveryKey, deadline.deliveryKey]).size).toBe(4);
    expect([audio.instanceId, video.instanceId, deadline.instanceId]).toEqual([initial.instanceId, initial.instanceId, initial.instanceId]);
    expect(initial.deliveryKey.length).toBeLessThanOrEqual(100);
    expect(initial.instanceId.length).toBeLessThanOrEqual(100);
    expect(await executionDispatchIdentity(registration)).toEqual(initial);
    expect((await executionDispatchIdentity({ ...registration, deploymentEpoch: 2 })).instanceId).not.toBe(initial.instanceId);
  });
});


describe("Execution Dispatch admission boundaries", () => {
  test("rejects invalid authority and incomplete observed deadlines", async () => {
    for (const changes of [
      { deploymentEpoch: 0 }, { generation: 2147483648 }, { wakeKind: "private/unsafe" },
      { deadlineKind: "lease" as const }, { observedDeadlineAt: new Date() },
      { deadlineKind: "lease" as const, observedDeadlineAt: new Date(Number.NaN) },
    ]) {
      await expect(executionDispatchIdentity({ ...registration, ...changes })).rejects.toMatchObject({ code: "invalid_dispatch" });
    }
  });

  test("keeps the exact committed receipt when registration cannot reach the database", async () => {
    const database = { $transaction: async () => { throw new Error("injected database unavailable"); } } as unknown as ExecutionDispatchDatabase;
    const dispatch = createExecutionDispatch({ database, scheduler: { deliver: async () => { throw new Error("scheduler must not be called"); } } });
    const receipt = { id: "existing-operation-receipt", projectId: registration.subject.id };
    const result = await dispatch.confirmAccepted(["d66ad223-9e95-4cbe-8838-43ec01aa6df0"], receipt);
    expect(result).toEqual({ accepted: false, receipt, retryable: true, code: "scheduler_registration_pending", retryAfterSeconds: 1 });
    expect(result.receipt).toBe(receipt);
  });
});
