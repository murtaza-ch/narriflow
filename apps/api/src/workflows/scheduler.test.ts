import { expect, test } from "bun:test";
import { executionDispatchIdentity } from "@narriflow/services/execution-dispatch";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { ApiWorkerBindings } from "../worker-bindings";
import { dispatchContinuationInstanceId } from "./protocol";
import { createWorkerExecutionScheduler } from "./scheduler";
import { canRunWhileFenced } from "./execution-fence";
import { EXECUTION_RESTORE_PHASES } from "@narriflow/services/execution-restore";

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

test("local development confirms the canonical cloud scheduler instead of creating local instances", async () => {
  let called = 0;
  const bindings = { DEV_CLOUD: { dispatch: async (input: ExecutionDispatchReference) => {
    called++; expect(input).toEqual(reference); return { status: "confirmed_notified" as const, destinationId: dispatchContinuationInstanceId(input) };
  } }, OPERATION_DRIVER: { get() { throw new Error("Local workflow must not be used"); } } } as unknown as ApiWorkerBindings;
  expect((await createWorkerExecutionScheduler(bindings).deliver(await delivery())).destinationId).toBe(dispatchContinuationInstanceId(reference));
  expect(called).toBe(1);
});

test("restore fencing defers every product consumer before local RPC, storage or database work", async () => {
  let remoteCalls = 0;
  const bindings = { ADMISSION_STATE: "fenced", DEV_CLOUD: { dispatch: async () => { remoteCalls++; throw Error("Forbidden delivery"); } } } as unknown as ApiWorkerBindings;
  for (const kind of ["modal_execution", "local_fetch", "operation_driver", "import_pipeline", "render_run", "project_progress"] as const) {
    const input = { ...await delivery(), reference: { ...reference, kind } };
    await expect(createWorkerExecutionScheduler(bindings).deliver(input)).rejects.toMatchObject({ code: "scheduler_unavailable" });
  }
  expect(remoteCalls).toBe(0);
});

test("restore metadata registration remains available while product consumers are fenced", async () => {
  let commands=0;
  const bindings={ADMISSION_STATE:"fenced",MAINTENANCE:{create:async({id}:{id:string})=>{commands++;return{id};}}} as unknown as ApiWorkerBindings;
  const input={...await delivery(),mode:"registration" as const,wakeKind:null,reference:{...reference,deploymentEpoch:4,kind:"maintenance" as const,subject:{kind:"maintenance" as const,id:"rs2.3.3.4.1793440800000.attempts"}}};
  expect((await createWorkerExecutionScheduler(bindings).deliver(input)).status).toBe("confirmed_created");expect(commands).toBe(1);
});

test("the restore metadata boundary refuses every redispatch page before remote registration or SQL-capable execution",async()=>{
 let remoteCalls=0;
 const bindings={ADMISSION_STATE:"fenced",DEV_CLOUD:{dispatch:async()=>{remoteCalls++;throw Error("Redispatch reached remote consumer");}}} as unknown as ApiWorkerBindings;
 for(const phase of EXECUTION_RESTORE_PHASES){
  const ref={...reference,kind:"maintenance" as const,deploymentEpoch:4,subject:{kind:"maintenance" as const,id:`rs2.3.3.4.1793440800000.${phase}`}};
  expect(canRunWhileFenced(ref)).toBe(!phase.startsWith("redispatch"));
  if(phase.startsWith("redispatch"))await expect(createWorkerExecutionScheduler(bindings).deliver({...await delivery(),reference:ref})).rejects.toMatchObject({code:"scheduler_unavailable"});
 }
 expect(remoteCalls).toBe(0);
 for(const id of ["rs2.not-a-page","rs2.3.3.4.1793440800000.unknown","rs2.3.2.4.1793440800000.attempts","rs2.3.3.5.1793440800000.attempts"]){expect(canRunWhileFenced({...reference,deploymentEpoch:4,kind:"maintenance",subject:{kind:"maintenance",id}})).toBe(false);}
});
