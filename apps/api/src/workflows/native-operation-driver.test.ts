import {collectExecutionDispatch,withExecutionDispatches} from "@narriflow/services/execution-dispatch-runtime";
import type {Prisma,PrismaClient} from "@prisma/client";
import {runWorkflowCommand} from "./dispatch-retry";
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
  expect(await runWorkflowCommand(()=>run({ reference, wake: { type: "start" } }))).toEqual({ type: "sleep", until: new Date(now + 1_000).toISOString() });
});

test("a fresh renewal observation controls the next wait and terminal domains never construct storage work", async () => {
  let delivered = 0;
  const run = createNativeOperationDriver({ now: () => now,
    prepare: async () => ({ kind: "waiting", deadline: { ...deadline, kind: "lease", observedDeadlineAt: new Date(now - 1_000).toISOString() }, deliveryId, dispatchIds: [] }),
    expire: async () => ({ kind: "sleep", dueAt: new Date(now + 90_000) }), deliver: async () => { delivered++; return []; },
  });
  expect(await runWorkflowCommand(()=>run({ reference, wake: { type: "start" } }))).toMatchObject({ type: "wait", until: new Date(now + 90_000).toISOString() });
  const terminal = createNativeOperationDriver({ now: () => now, prepare: async () => ({ kind: "terminal" }),
    expire: async () => { throw new Error("Unexpected expiry"); }, deliver: async () => { throw new Error("Unexpected storage/provider work"); } });
  expect(await terminal({ reference, wake: { type: "start" } })).toEqual({ type: "complete", disposition: "terminal" });
  expect(delivered).toBe(2);
});

test("an unconfirmed watchdog never dispatches the heavy operation", async () => {
  const batches: string[][] = [];
  const run = createNativeOperationDriver({ now: () => now,
    prepare: async () => ({ kind: "waiting", deadline, deliveryId, dispatchIds: [deadline.reference.dispatchId, deliveryId] }),
    expire: async () => { throw new Error("Not due"); },
    deliver: async ids => { batches.push([...ids]); return [{ status: "pending", dispatchId: deliveryId, reason: "delivery_failed", retryAt: new Date(now + 1_000) }]; },
  });
  expect(await runWorkflowCommand(()=>run({ reference, wake: { type: "start" } }))).toMatchObject({ type: "sleep" });
  expect(batches).toEqual([[deliveryId]]);
});

test("a preparation dependency confirms its own watchdog and waits without a native attempt", async () => {
  const batches: string[][] = [], preparation = crypto.randomUUID();
  const run = createNativeOperationDriver({ now: () => now,
    prepare: async () => ({ kind: "dependency_wait", dueAt: new Date(now + 600_000), deadlineDispatchId: deliveryId, dispatchIds: [deliveryId, preparation] }),
    expire: async () => { throw new Error("No native attempt exists"); },
    deliver: async ids => { batches.push([...ids]); return ids.map(dispatchId => ({ status: "acknowledged", dispatchId, destinationId: "fixture" })); },
  });
  expect(await runWorkflowCommand(()=>run({ reference, wake: { type: "start" } }))).toEqual({ type: "wait", until: new Date(now + 600_000).toISOString(), deliveryId });
  expect(batches).toEqual([[deliveryId], [preparation]]);
});

test("a pending watchdog cannot be bypassed by the automatic postcommit collector",async()=>{
  const tx={} as Prisma.TransactionClient,batches:string[][]=[];let automatic=0;
  const run=createNativeOperationDriver({now:()=>now,prepare:async()=>{
    collectExecutionDispatch(tx,deliveryId);collectExecutionDispatch(tx,deadline.reference.dispatchId);
    return{kind:"waiting",deadline,deliveryId,dispatchIds:[deliveryId,deadline.reference.dispatchId]};
  },expire:async()=>{throw Error("not_due");},deliver:async ids=>{batches.push([...ids]);return[{status:"pending",dispatchId:deliveryId,reason:"delivery_failed",retryAt:new Date(now+1000)}];}});
  const database={executionDispatch:{findMany:async()=>[{id:deliveryId},{id:deadline.reference.dispatchId}]}} as unknown as PrismaClient;
  expect(await runWorkflowCommand(()=>withExecutionDispatches(()=>run({reference,wake:{type:"start"}}),{database,deliver:async()=>{automatic++;}}))).toEqual({type:"sleep",until:new Date(now+1000).toISOString()});
  expect(batches).toEqual([[deliveryId]]);expect(automatic).toBe(0);
});
