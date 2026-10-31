import { expect, test } from "bun:test";
import { parseExecutionRestoreOperatorArgs, restoreWorkflowTarget, createWranglerRestoreCommands } from "./execution-restore-operator";
import { executionDispatchIdentity, type ExecutionDispatchDelivery } from "./execution-dispatch";

const configPath = "/workspace/path with spaces/wrangler.jsonc";
test("restore commands require concrete proof files and resume names one exact dispatch", () => {
  expect(parseExecutionRestoreOperatorArgs(["inspect", "--config", configPath])).toEqual({ command: "inspect", configPath });
  expect(parseExecutionRestoreOperatorArgs(["begin", "--expected-epoch", "7", "--fence-above-epoch", "7", "--proof", "/private/proof.json", "--snapshot", "/private/snapshot.dump", "--config", configPath, "--env", "dev"])).toEqual({ command: "begin", expectedEpoch: 7, fenceAboveEpoch: 7, proofPath: "/private/proof.json", snapshotPath: "/private/snapshot.dump", configPath, environment: "dev" });
  expect(parseExecutionRestoreOperatorArgs(["fence", "--expected-epoch", "6"])).toEqual({ command: "fence", expectedEpoch: 6 });
  expect(parseExecutionRestoreOperatorArgs(["attest", "--snapshot", "/snapshot", "--quiescence", "/record", "--quiescence-evidence", "/evidence", "--proof-out", "/proof"])).toEqual({ command: "attest", snapshotPath: "/snapshot", quiescencePath: "/record", quiescenceEvidencePath: "/evidence", proofOutputPath: "/proof" });
  const id = crypto.randomUUID();
  expect(parseExecutionRestoreOperatorArgs(["resume", "--dispatch-id", id])).toEqual({ command: "resume", dispatchId: id });
  for (const args of [["begin", "--expected-epoch", "7"], ["begin", "--expected-epoch", "07", "--fence-above-epoch", "8"], ["resume", "--dispatch-id", "latest"], ["inspect", "--expected-epoch", "1"], ["begin", "--expected-epoch", "2", "--expected-epoch", "3", "--fence-above-epoch", "4"]]) expect(() => parseExecutionRestoreOperatorArgs(args)).toThrow("restore_operator_arguments_invalid");
});
test("the selected Wrangler configuration must be this account's explicit Maintenance binding", () => {
  const config = { account_id: "5359f28d385b8632c3abee12d1f5b011", workflows: [{ binding: "MAINTENANCE", name: "narriflow-maintenance-candidate", class_name: "Maintenance" }] };
  expect(restoreWorkflowTarget(config)).toEqual({ accountId: config.account_id, workflowName: "narriflow-maintenance-candidate" });
  expect(() => restoreWorkflowTarget({ ...config, account_id: "a".repeat(32) })).toThrow("restore_operator_configuration_invalid");
  expect(() => restoreWorkflowTarget(config, "dev")).toThrow("restore_operator_configuration_invalid");
});
async function delivery(): Promise<ExecutionDispatchDelivery> {
  const reference = { dispatchId: crypto.randomUUID(), kind: "maintenance" as const, subject: { kind: "maintenance" as const, id: "rs2.7.7.8.1793440800000.attempts" }, deploymentEpoch: 8, generation: 1, inputHash: "a".repeat(64) };
  return { reference, ...await executionDispatchIdentity(reference), dueAt: new Date("2026-10-31T10:00:00Z"), mode: "registration", wakeKind: null, deadlineKind: null, observedDeadlineAt: null };
}
test("initial registration passes only the exact reference and deterministic instance ID as raw argv", async () => {
  const row = await delivery(), calls: readonly string[][] = [];
  const commands = createWranglerRestoreCommands({ workflowName: "narriflow-maintenance-candidate", configPath,
    run: async args => { (calls as string[][]).push([...args]); return { id: row.instanceId, status: "queued" }; } });
  expect(await commands.scheduler.deliver(row)).toEqual({ status: "confirmed_created", destinationId: row.instanceId });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.slice(0, 3)).toEqual(["workflows", "trigger", "narriflow-maintenance-candidate"]);
  expect(JSON.parse(calls[0]![3]!)).toEqual(row.reference);
  expect(calls[0]!.slice(4)).toEqual(["--id", row.instanceId, "--config", configPath, "--json"]);
});
test("a lost create response is confirmed independently, while an unrelated ID cannot acknowledge", async () => {
  const row = await delivery(); let calls = 0;
  const commands = createWranglerRestoreCommands({ workflowName: "narriflow-maintenance-candidate", configPath,
    run: async args => { calls++; if (args[1] === "trigger") throw new Error("Lost response"); return { id: row.instanceId, status: "running" }; } });
  expect(await commands.scheduler.deliver(row)).toEqual({ status: "confirmed_existing", destinationId: row.instanceId });
  expect(calls).toBe(2);
  const wrong = createWranglerRestoreCommands({ workflowName: "narriflow-maintenance-candidate", configPath, run: async () => ({ id: "unrelated", status: "running" }) });
  await expect(wrong.scheduler.deliver(row)).rejects.toThrow("restore_operator_registration_unconfirmed");
});
test("resume restarts only a known failed instance or a completed instance with its exact committed page receipt", async () => {
  const row = await delivery(), calls: string[][] = [];
  let state = "errored";
  const commands = createWranglerRestoreCommands({ workflowName: "narriflow-maintenance-candidate", configPath,
    run: async args => { calls.push([...args]); if (args[2] === "restart") { state = "queued"; return {}; } return { id: row.instanceId, status: state }; } });
  expect(await commands.resume(row.instanceId, { hasCommittedPage: false })).toEqual({ kind: "restarted", before: { id: row.instanceId, status: "errored" }, after: { id: row.instanceId, status: "queued" } });
  expect(calls[1]).toEqual(["workflows", "instances", "restart", "narriflow-maintenance-candidate", row.instanceId, "--config", configPath, "--json"]);
  state = "complete"; calls.length = 0;
  await expect(commands.resume(row.instanceId, { hasCommittedPage: false })).rejects.toThrow("restore_operator_completed_without_receipt");
  expect(calls).toHaveLength(1);
  expect(await commands.resume(row.instanceId, { hasCommittedPage: true })).toMatchObject({ kind: "restarted", before: { status: "complete" }, after: { status: "queued" } });
});
test("a fresh authority refusal after describe prevents restart and wake delivery cannot use the operator registration port", async () => {
  const row = await delivery(); let calls = 0;
  const commands = createWranglerRestoreCommands({ workflowName: "narriflow-maintenance-candidate", configPath, run: async () => { calls++; return { id: row.instanceId, status: "errored" }; } });
  await expect(commands.scheduler.deliver({ ...row, mode: "wake", wakeKind: "changed" })).rejects.toThrow("restore_operator_dispatch_invalid");
  expect(calls).toBe(0);
  await expect(commands.resume(row.instanceId, { hasCommittedPage: false, beforeRestart: async () => { throw new Error("epoch changed"); } })).rejects.toThrow("epoch changed");
  expect(calls).toBe(1);
});
