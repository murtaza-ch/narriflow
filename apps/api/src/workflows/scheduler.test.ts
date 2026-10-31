import { expect, test } from "bun:test";
import { executionDispatchIdentity } from "@narriflow/services/execution-dispatch";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ApiWorkerBindings } from "../worker-bindings";
import { dispatchContinuationInstanceId } from "./protocol";
import { createWorkerExecutionScheduler } from "./scheduler";

const reference: ExecutionDispatchReference = { dispatchId: crypto.randomUUID(), kind: "operation_driver", subject: { kind: "native_validation", id: crypto.randomUUID() }, deploymentEpoch: 1, generation: 1, inputHash: "a".repeat(64) };
async function delivery() { return { reference, ...await executionDispatchIdentity(reference), dueAt: new Date(), mode: "wake" as const, wakeKind: "native.completed", deadlineKind: null, observedDeadlineAt: null }; }

test("registration requires creation or an independently confirmed existing instance", async () => {
  let exists = false;
  const bindings = { OPERATION_DRIVER: { create: async ({ id }: { id: string }) => { if (exists) throw new Error("Existing"); exists = true; return { id }; }, get: async (id: string) => ({ id, status: async () => ({ status: exists ? "running" : "unknown" }) }) } } as unknown as ApiWorkerBindings;
  const scheduler = createWorkerExecutionScheduler(bindings);
  const input = { ...await delivery(), mode: "registration" as const, wakeKind: null };
  expect((await scheduler.deliver(input)).status).toBe("confirmed_created");
  expect((await scheduler.deliver(input)).status).toBe("confirmed_existing");
  exists = false;
  bindings.OPERATION_DRIVER = { create: async () => { throw new Error("Transport failed"); }, get: bindings.OPERATION_DRIVER.get } as Workflow;
  await expect(scheduler.deliver(input)).rejects.toThrow("Transport failed");
});

test("an accepted event still requires a separately confirmed durable command", async () => {
  let events = 0, commands = 0;
  const bindings = { OPERATION_DRIVER: { get: async () => ({ sendEvent: async () => { events++; } }) }, MAINTENANCE: { create: async (input: { id: string; params: unknown }) => { commands++; expect(input.params).toEqual(reference); return { id: input.id }; } } } as unknown as ApiWorkerBindings;
  const result = await createWorkerExecutionScheduler(bindings).deliver(await delivery());
  expect(result).toEqual({ status: "confirmed_notified", destinationId: dispatchContinuationInstanceId(reference) });
  expect([events, commands]).toEqual([1, 1]);
});

test("lost continuation creation acknowledgement confirms the same dispatch identity independently", async () => {
  const identities: string[] = [];
  const bindings = { OPERATION_DRIVER: { get: async () => { throw new Error("Closed"); } }, MAINTENANCE: { create: async (input: { id: string }) => { identities.push(input.id); throw new Error("Lost ACK"); }, get: async (id: string) => ({ id, status: async () => ({ status: "complete" }) }) } } as unknown as ApiWorkerBindings;
  const result = await createWorkerExecutionScheduler(bindings).deliver(await delivery());
  expect(result.destinationId).toBe(dispatchContinuationInstanceId(reference));
  expect(identities).toEqual([dispatchContinuationInstanceId(reference)]);
});

test("an event acknowledgement cannot hide unconfirmed continuation registration", async () => {
  const bindings = { OPERATION_DRIVER: { get: async () => ({ sendEvent: async () => {} }) }, MAINTENANCE: { create: async () => { throw new Error("Unavailable"); }, get: async () => { throw new Error("Absent"); } } } as unknown as ApiWorkerBindings;
  await expect(createWorkerExecutionScheduler(bindings).deliver(await delivery())).rejects.toThrow("Unavailable");
});
