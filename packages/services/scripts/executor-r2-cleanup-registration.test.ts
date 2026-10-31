import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { executionDispatchIdentity, type ExecutionDispatchDelivery } from "../src/execution-dispatch";
import { cleanupWorkflowTarget, createGateCleanupScheduler } from "./executor-r2-cleanup-registration";

const config = { name: "narriflow-api-candidate", account_id: "5359f28d385b8632c3abee12d1f5b011", vars: { ADMISSION_STATE: "closed" }, triggers: { crons: [] },
  workflows: [{ binding: "MAINTENANCE", class_name: "Maintenance", name: "narriflow-maintenance-candidate" }] };
const target = cleanupWorkflowTarget(config, "/private/candidate-closed.jsonc");
async function fixture() {
  const point = `1793500000000.${randomUUID().replaceAll("-", "")}`;
  const reference = { dispatchId: randomUUID(), deploymentEpoch: 3, kind: "maintenance" as const, subject: { kind: "maintenance" as const, id: `mc1.${point}.${point}` }, generation: 1, inputHash: "a".repeat(64) };
  const delivery: ExecutionDispatchDelivery = { reference, ...await executionDispatchIdentity(reference), mode: "registration", dueAt: new Date(0), wakeKind: null, deadlineKind: null, observedDeadlineAt: null };
  return { reference, delivery };
}

test("cleanup gate requires the isolated closed candidate and exact Maintenance binding", () => {
  expect(target.workflowName).toBe("narriflow-maintenance-candidate");
  for (const value of [{ ...config, name: "narriflow-api-dev" }, { ...config, vars: { ADMISSION_STATE: "fenced" } },
    { ...config, triggers: { crons: ["0 * * * *"] } }, { ...config, account_id: "foreign-account" }]) expect(() => cleanupWorkflowTarget(value, "candidate.jsonc")).toThrow();
});

test("an exact single-row cleanup drain receives confirmed deployed registration", async () => {
  const { reference, delivery } = await fixture(); const calls: string[][] = [];
  const scheduler = createGateCleanupScheduler({ target, references: [reference], async run(args) {
    calls.push([...args]); return { id: delivery.instanceId };
  } });
  expect(await scheduler.deliver(delivery)).toEqual({ status: "confirmed_created", destinationId: delivery.instanceId });
  expect(calls).toEqual([["workflows", "trigger", target.workflowName, JSON.stringify(reference), "--id", delivery.instanceId, "--config", target.configPath, "--json"]]);
});

test("a lost trigger acknowledgement is confirmed only by the same deployed instance identity", async () => {
  const { reference, delivery } = await fixture(); let calls = 0;
  const scheduler = createGateCleanupScheduler({ target, references: [reference], async run(args) {
    if (++calls === 1) throw Error("controlled lost acknowledgement");
    expect(args.slice(0, 5)).toEqual(["workflows", "instances", "describe", target.workflowName, delivery.instanceId]); return { id: delivery.instanceId, status: "running" };
  } });
  expect(await scheduler.deliver(delivery)).toEqual({ status: "confirmed_existing", destinationId: delivery.instanceId }); expect(calls).toBe(2);
});

test("foreign or unknown instance confirmation cannot acknowledge cleanup", async () => {
  const { reference, delivery } = await fixture();
  for (const response of [{ id: "foreign", status: "running" }, { id: delivery.instanceId, status: "unknown" }, {}]) {
    const scheduler = createGateCleanupScheduler({ target, references: [reference], async run(args) { return args[1] === "trigger" ? {} : response; } });
    await expect(scheduler.deliver(delivery)).rejects.toThrow("gate_cleanup_registration_unconfirmed");
  }
});

test("unknown references, broad ranges, wakes and changed hashes send no Wrangler command", async () => {
  const { reference, delivery } = await fixture(); let calls = 0;
  const scheduler = createGateCleanupScheduler({ target, references: [reference], async run() { calls++; return {}; } });
  for (const value of [{ ...delivery, reference: { ...reference, dispatchId: randomUUID() } }, { ...delivery, reference: { ...reference, inputHash: "b".repeat(64) } },
    { ...delivery, mode: "wake" as const, wakeKind: "cleanup_claimed" }, { ...delivery, instanceId: "foreign" }]) await expect(scheduler.deliver(value)).rejects.toThrow();
  const broad = { ...reference, subject: { kind: "maintenance" as const, id: `${reference.subject.id.slice(0, -32)}${randomUUID().replaceAll("-", "")}` } };
  const broader = createGateCleanupScheduler({ target, references: [broad], async run() { calls++; return {}; } });
  await expect(broader.deliver({ ...delivery, reference: broad, ...await executionDispatchIdentity(broad) })).rejects.toThrow();
  expect(calls).toBe(0);
});
