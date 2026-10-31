import { expect, test } from "bun:test";
import { createPublicationDriver } from "./publication-driver";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";

const now = Date.parse("2026-10-31T00:00:00Z");
const reference: ExecutionDispatchReference = { dispatchId: crypto.randomUUID(), kind: "operation_driver", subject: { kind: "social_publication", id: crypto.randomUUID() }, deploymentEpoch: 1, generation: 1, inputHash: "a".repeat(64) };
test("an external grant or export wait parks without inventing an attempt or a product expiry", async () => {
  for (const kind of ["waiting_export", "waiting_grant"] as const) {
    const run = createPublicationDriver({ now: () => now, prepare: async () => ({ kind }),
      expire: async () => { throw Error("No executor exists"); }, deliver: async () => { throw Error("No heavy work exists"); } });
    expect(await run({ reference, wake: { type: "start" } })).toEqual({ type: "wait", until: new Date(now + 365*86_400_000).toISOString(), deliveryId: reference.dispatchId });
  }
});
test("a publication native invocation confirms its exact watchdog before dispatch", async () => {
  const watchdog = crypto.randomUUID(), native = { ...reference, kind: "modal_execution" as const, dispatchId: crypto.randomUUID() };
  const batches: string[][] = [];
  const run = createPublicationDriver({ now: () => now, prepare: async () => ({ kind: "waiting", deadline: { reference: native, attemptToken: crypto.randomUUID(), kind: "operation", observedDeadlineAt: new Date(now+60_000).toISOString() }, deliveryId: watchdog, dispatchIds: [watchdog,native.dispatchId] }),
    expire: async () => { throw Error("Not due"); }, deliver: async ids => { batches.push([...ids]); return ids.map(dispatchId => ({ status: "acknowledged", dispatchId, destinationId: "fixture" })); } });
  expect((await run({ reference, wake: { type: "start" } })).type).toBe("wait");
  expect(batches).toEqual([[watchdog],[native.dispatchId]]);
});
