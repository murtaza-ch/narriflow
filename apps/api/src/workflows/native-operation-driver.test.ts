import { expect, test } from "bun:test";
import { createNativeOperationDriver } from "./native-operation-driver";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";

const now = Date.parse("2026-10-31T00:00:00Z");
const reference: ExecutionDispatchReference = { dispatchId: crypto.randomUUID(), kind: "operation_driver", subject: { kind: "native_validation", id: crypto.randomUUID() }, deploymentEpoch: 1, generation: 1, inputHash: "a".repeat(64) };
const deadline = { reference: { ...reference, dispatchId: crypto.randomUUID(), kind: "modal_execution" as const }, attemptToken: crypto.randomUUID(), kind: "operation" as const, observedDeadlineAt: new Date(now + 600_000).toISOString() };
const deliveryId = crypto.randomUUID();

test("a known failed spawn sleeps to its persisted retry, without parking until the absolute deadline", async () => {
  const run = createNativeOperationDriver({ now: () => now,
    prepare: async () => ({ kind: "waiting", deadline, deliveryId, dispatchIds: [deadline.reference.dispatchId] }),
    expire: async () => { throw new Error("Not due"); },
    deliver: async () => [{ status: "pending", dispatchId: deadline.reference.dispatchId, reason: "delivery_failed", retryAt: new Date(now + 1_000) }],
  });
  expect(await run({ reference, wake: { type: "start" } })).toEqual({ type: "sleep", until: new Date(now + 1_000).toISOString() });
});

test("a fresh renewal observation controls the next wait and terminal domains never construct storage work", async () => {
  let delivered = 0;
  const run = createNativeOperationDriver({ now: () => now,
    prepare: async () => ({ kind: "waiting", deadline: { ...deadline, kind: "lease", observedDeadlineAt: new Date(now - 1_000).toISOString() }, deliveryId, dispatchIds: [] }),
    expire: async () => ({ kind: "sleep", dueAt: new Date(now + 90_000) }), deliver: async () => { delivered++; return []; },
  });
  expect(await run({ reference, wake: { type: "start" } })).toMatchObject({ type: "wait", until: new Date(now + 90_000).toISOString() });
  const terminal = createNativeOperationDriver({ now: () => now, prepare: async () => ({ kind: "terminal" }),
    expire: async () => { throw new Error("Unexpected expiry"); }, deliver: async () => { throw new Error("Unexpected storage/provider work"); } });
  expect(await terminal({ reference, wake: { type: "start" } })).toEqual({ type: "complete", disposition: "terminal" });
  expect(delivered).toBe(1);
});
