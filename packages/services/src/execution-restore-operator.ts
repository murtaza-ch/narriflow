import { executionDispatchReferenceSchema } from "@narriflow/validators/execution";
import { executionDispatchIdentity, type ExecutionDispatchScheduler } from "./execution-dispatch";

export const RESTORE_CLOUDFLARE_ACCOUNT_ID = "5359f28d385b8632c3abee12d1f5b011";
export interface RestoreInstanceProof { id: string; status: string }
export class ExecutionRestoreOperatorError extends Error {
  constructor(readonly code: "restore_operator_arguments_invalid" | "restore_operator_configuration_invalid" | "restore_operator_dispatch_invalid" |
    "restore_operator_registration_unconfirmed" | "restore_operator_completed_without_receipt" | "restore_operator_restart_unconfirmed",
    readonly proof?: { before: RestoreInstanceProof; after: RestoreInstanceProof }) { super(code); }
}
type Common = { configPath?: string; environment?: string };
export type ExecutionRestoreOperatorInput = Common & ({ command: "help" } | { command: "inspect"; dispatchId?: string } |
  { command: "fence"; expectedEpoch: number } | { command: "attest"; snapshotPath: string; quiescencePath: string; quiescenceEvidencePath: string; proofOutputPath: string } |
  { command: "begin"; expectedEpoch: number; fenceAboveEpoch: number; proofPath: string; snapshotPath: string } | { command: "resume"; dispatchId: string });
const invalid = () => new ExecutionRestoreOperatorError("restore_operator_arguments_invalid");
const hasControl = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const uuid = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
export function parseExecutionRestoreOperatorArgs(argv: readonly string[]): ExecutionRestoreOperatorInput {
  const command = argv[0] ?? "inspect";
  if (argv.length === 1 && ["--help", "help"].includes(command)) return { command: "help" };
  if (!["inspect", "fence", "attest", "begin", "resume"].includes(command)) throw invalid();
  const specific = command === "begin" ? ["--expected-epoch", "--fence-above-epoch", "--proof", "--snapshot"] : command === "fence" ? ["--expected-epoch"] : command === "attest" ? ["--snapshot", "--quiescence", "--quiescence-evidence", "--proof-out"] : ["--dispatch-id"];
  const allowed = new Set(["--config", "--env", ...specific]), flags = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!, value = argv[index + 1];
    if (!allowed.has(name) || flags.has(name) || !value || value.startsWith("--") || hasControl(value)) throw invalid();
    flags.set(name, value);
  }
  const common: Common = {};
  if (flags.has("--config")) common.configPath = flags.get("--config")!;
  if (flags.has("--env")) {
    common.environment = flags.get("--env")!;
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(common.environment)) throw invalid();
  }
  const required = (name: string) => { const value = flags.get(name); if (!value) throw invalid(); return value; };
  const epoch = (name: string) => {
    const value = required(name);
    if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) >= 2_147_483_647) throw invalid();
    return Number(value);
  };
  if (command === "fence") return { command, expectedEpoch: epoch("--expected-epoch"), ...common };
  if (command === "attest") return { command, snapshotPath: required("--snapshot"), quiescencePath: required("--quiescence"), quiescenceEvidencePath: required("--quiescence-evidence"), proofOutputPath: required("--proof-out"), ...common };
  if (command === "begin") return { command, expectedEpoch: epoch("--expected-epoch"), fenceAboveEpoch: epoch("--fence-above-epoch"), proofPath: required("--proof"), snapshotPath: required("--snapshot"), ...common };
  const dispatchId = flags.get("--dispatch-id");
  if ((dispatchId && !uuid(dispatchId)) || (command === "resume" && !dispatchId)) throw invalid();
  return command === "resume" ? { command, dispatchId: dispatchId!, ...common } : { command: "inspect", ...(dispatchId ? { dispatchId } : {}), ...common };
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
export function restoreWorkflowTarget(value: unknown, environment?: string) {
  const bad = () => new ExecutionRestoreOperatorError("restore_operator_configuration_invalid");
  if (!object(value)) throw bad();
  let selected = value;
  if (environment) {
    if (!object(value.env) || !Object.hasOwn(value.env, environment) || !object(value.env[environment])) throw bad();
    selected = value.env[environment];
  }
  const accountId = selected.account_id ?? value.account_id;
  const workflows = selected.workflows;
  if (accountId !== RESTORE_CLOUDFLARE_ACCOUNT_ID || !Array.isArray(workflows)) throw bad();
  const bindings = workflows.filter(item => object(item) && item.binding === "MAINTENANCE");
  const binding = bindings[0];
  if (bindings.length !== 1 || !object(binding) || binding.class_name !== "Maintenance" || typeof binding.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(binding.name)) throw bad();
  return { accountId: RESTORE_CLOUDFLARE_ACCOUNT_ID, workflowName: binding.name };
}
const REGISTERED = new Set(["queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause"]);
const instanceId = (id: string) => /^nf_[a-f0-9]{64}$/.test(id);
/** The runner executes the repository's pinned Wrangler with raw argv, never a
 * shell or a credential-reader. Only fixed restore metadata reaches Cloudflare. */
export function createWranglerRestoreCommands(options: { workflowName: string; configPath: string; environment?: string; run(args: readonly string[]): Promise<unknown> }) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.workflowName) || !options.configPath || hasControl(options.configPath)) throw new ExecutionRestoreOperatorError("restore_operator_configuration_invalid");
  const common = ["--config", options.configPath, "--json", ...(options.environment ? ["--env", options.environment] : [])];
  async function describe(id: string): Promise<RestoreInstanceProof> {
    if (!instanceId(id)) throw new ExecutionRestoreOperatorError("restore_operator_dispatch_invalid");
    let proof: unknown;
    try { proof = await options.run(["workflows", "instances", "describe", options.workflowName, id, ...common]); }
    catch { throw new ExecutionRestoreOperatorError("restore_operator_registration_unconfirmed"); }
    if (!object(proof) || proof.id !== id || typeof proof.status !== "string" || !REGISTERED.has(proof.status)) throw new ExecutionRestoreOperatorError("restore_operator_registration_unconfirmed");
    return { id, status: proof.status };
  }
  const scheduler: ExecutionDispatchScheduler = { async deliver(delivery) {
    const reference = executionDispatchReferenceSchema.parse(delivery.reference), expected = await executionDispatchIdentity(reference);
    if (delivery.mode !== "registration" || delivery.wakeKind || delivery.deadlineKind || reference.kind !== "maintenance" || reference.subject.kind !== "maintenance" || !reference.subject.id.startsWith("rs2.") ||
      delivery.instanceId !== expected.instanceId || delivery.deliveryKey !== expected.deliveryKey) throw new ExecutionRestoreOperatorError("restore_operator_dispatch_invalid");
    try {
      const created = await options.run(["workflows", "trigger", options.workflowName, JSON.stringify(reference), "--id", delivery.instanceId, ...common]);
      if (object(created) && created.id === delivery.instanceId) return { status: "confirmed_created", destinationId: delivery.instanceId };
    } catch { /* The POST may have committed; verify by the exact instance ID. */ }
    const existing = await describe(delivery.instanceId);
    return { status: "confirmed_existing", destinationId: existing.id };
  } };
  return { scheduler, describe, async resume(id: string, input: { hasCommittedPage: boolean; beforeRestart?(): Promise<void> }) {
    const before = await describe(id);
    if (before.status === "complete" && !input.hasCommittedPage) throw new ExecutionRestoreOperatorError("restore_operator_completed_without_receipt");
    if (!["errored", "terminated", "complete"].includes(before.status)) return { kind: "already_running" as const, before, after: before };
    await input.beforeRestart?.();
    let acknowledged = false;
    try { await options.run(["workflows", "instances", "restart", options.workflowName, id, ...common]); acknowledged = true; } catch { /* Inspect independently. */ }
    const after = await describe(id);
    if (["errored", "terminated"].includes(after.status) || (!acknowledged && before.status === after.status)) throw new ExecutionRestoreOperatorError("restore_operator_restart_unconfirmed", { before, after });
    return { kind: "restarted" as const, before, after };
  } };
}
