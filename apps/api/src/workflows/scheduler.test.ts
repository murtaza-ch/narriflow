import { expect, test } from "bun:test";
import type { ExecutionDispatchDelivery } from "@narriflow/services/execution-dispatch";
import type { ApiWorkerBindings } from "../worker-bindings";
import { createWorkerExecutionScheduler } from "./scheduler";

const reference = { dispatchId: "50000000-0000-4000-8000-000000000001", deploymentEpoch: 1, kind: "import_pipeline" as const, subject: { kind: "ingest_job" as const, id: "60000000-0000-4000-8000-000000000001" }, generation: 1, inputHash: "a".repeat(64) };
const delivery = (over: Partial<ExecutionDispatchDelivery> = {}): ExecutionDispatchDelivery => ({ reference, deliveryKey: "fixture", instanceId: "nf_fixture", dueAt: new Date(), mode: "registration", wakeKind: null, deadlineKind: null, observedDeadlineAt: null, ...over });
test("creation is acknowledged only after actual creation or an independently confirmed existing instance", async () => {
  let exists = false;
  const bindings = { IMPORT_PIPELINE: { create: async ({ id }: { id: string }) => { if (exists) throw new Error("existing"); exists = true; return { id }; }, get: async (id: string) => ({ id, status: async () => ({ status: exists ? "running" : "unknown" }) }) } } as unknown as ApiWorkerBindings;
  const scheduler = createWorkerExecutionScheduler(bindings);
  expect(await scheduler.deliver(delivery())).toEqual({ status: "confirmed_created", destinationId: "nf_fixture" });
  expect(await scheduler.deliver(delivery())).toEqual({ status: "confirmed_existing", destinationId: "nf_fixture" });
  exists = false; (bindings.IMPORT_PIPELINE as unknown as { create: () => Promise<never> }).create = async () => { throw new Error("network failure"); };
  await expect(scheduler.deliver(delivery())).rejects.toThrow();
});
test("wake delivery awaits sendEvent and uses the one buffered dispatch event type", async () => {
  let resume!: () => void; const delivered = new Promise<void>((resolve) => { resume = resolve; }); let event: unknown;
  const bindings = { IMPORT_PIPELINE: { get: async (id: string) => ({ id, sendEvent: async (input: unknown) => { event = input; await delivered; } }) } } as unknown as ApiWorkerBindings;
  let acknowledged = false;
  const result = createWorkerExecutionScheduler(bindings).deliver(delivery({ mode: "wake", wakeKind: "audio.ready" })).then((value) => { acknowledged = true; return value; });
  await Bun.sleep(1); expect(acknowledged).toBe(false); expect(event).toMatchObject({ type: "dispatch", payload: { reference, wakeKind: "audio.ready" } });
  resume(); expect(await result).toEqual({ status: "confirmed_notified", destinationId: "nf_fixture" });
});
