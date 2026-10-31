import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { WebSocket } from "ws";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

const path = process.env.WORKFLOW_GATE_DATABASE_ENV;
if (!path) throw new Error("WORKFLOW_GATE_DATABASE_ENV must identify the isolated database settings");
const settings = Object.fromEntries(readFileSync(path, "utf8").split("\n").filter((line) => line && !line.startsWith("#")).map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1).replace(/^["']|["']$/g, "")]; }));
const connectionString = settings.SERVERLESS_TEST_DATABASE_URL ?? settings.DIRECT_URL;
if (!connectionString || new URL(connectionString).hostname !== "ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech") throw new Error("Workflow gates require the isolated branch host");
const progressKey = randomBytes(32);
const loseProgressAck = process.env.WORKFLOW_GATE_LOST_PROGRESS_ACK === "1";
let fixture: { ownerId: string; workspaceId: string } | undefined;
let socket: WebSocket | undefined;
const database = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 2 }) });
const worker = await unstable_dev(fileURLToPath(new URL("./gates/workflow-runtime-probe.ts", import.meta.url)), {
  config: fileURLToPath(new URL("./gates/wrangler.workflow-runtime-probe.jsonc", import.meta.url)),
  local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, persist: false, logLevel: "error",
  vars: { HYPERDRIVE: { connectionString }, API_ORIGIN: "https://api.narriflow.test", PROGRESS_CONNECT_KEY_ID: "gate", PROGRESS_CONNECT_KEYS_JSON: JSON.stringify({ gate: progressKey.toString("base64url") }) }, experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
});
const checks: string[] = [];
const reference = (name: string, subjectKind = "ingest_job") => ({ dispatchId: randomUUID(), deploymentEpoch: 1, kind: "import_pipeline", subject: { kind: subjectKind, id: `${name}-${randomUUID()}` }, generation: 1, inputHash: "a".repeat(64) });
type Reference = ReturnType<typeof reference>;
type Log = Array<{ kind: string; scope: string; detail: string }>;
async function call(path: string, ref: Reference) { const response = await worker.fetch(`${path}?reference=${encodeURIComponent(JSON.stringify(ref))}`); assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<any>; }
async function until(predicate: () => Promise<boolean>, timeout = 20_000) { const end = Date.now() + timeout; while (!await predicate()) { if (Date.now() > end) throw new Error("Workflow gate timed out"); await new Promise((resolve) => setTimeout(resolve, 50)); } }
function allClosed(log: Log) { const opened = log.filter((row) => row.kind === "open").map((row) => row.scope); const closed = log.filter((row) => row.kind === "close").map((row) => row.scope); assert.deepEqual(closed, opened); assert.equal(new Set(opened).size, opened.length); }
try {
  if (process.env.WORKFLOW_GATE_PROGRESS_ONLY !== "1") {
  const parked = reference("parked");
  assert.equal((await call("/create", parked)).status, "confirmed_created");
  await until(async () => { const status = await call("/status", parked); if (status.status === "errored") throw new Error(`Workflow failed before wait: ${JSON.stringify(status.error)}`); return (await call("/stats", parked) as Log).filter((row) => row.kind === "close").length === 1; });
  const before = await call("/stats", parked) as Log;
  allClosed(before);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(await call("/stats", parked), before);
  assert.equal((await call("/create", parked)).status, "confirmed_existing");
  checks.push("confirmed_creation_and_idle_wait_zero_sql");
  assert.equal((await call("/wake", parked)).status, "confirmed_notified");
  await until(async () => (await call("/status", parked)).status === "complete");
  const after = await call("/stats", parked) as Log;
  allClosed(after); assert.equal(after.filter((row) => row.kind === "query").length, 2);
  checks.push("fresh_sql_scope_after_durable_event_wait");
  const early = reference("early"); await call("/create", early);
  await until(async () => (await call("/stats", early) as Log).filter((row) => row.kind === "query").length === 1);
  await call("/wake", early); await call("/wake", early);
  await until(async () => (await call("/status", early)).status === "complete");
  const earlyLog = await call("/stats", early) as Log; allClosed(earlyLog);
  assert.deepEqual(earlyLog.filter((row) => row.kind === "query").map((row) => row.detail), ["start", "timer", "dispatch"]);
  checks.push("events_before_wait_are_buffered_and_duplicates_do_not_restart_completed_command");
  const timeout = reference("timeout"); await call("/create", timeout);
  await until(async () => (await call("/status", timeout)).status === "complete");
  const timed = await call("/stats", timeout) as Log; allClosed(timed);
  assert.deepEqual(timed.filter((row) => row.kind === "query").map((row) => row.detail), ["start", "deadline"]);
  checks.push("wait_timeout_rereads_ledger_in_fresh_scope");
  const unsupported = reference("unsupported", "clip_preparation"); await call("/create", unsupported);
  await until(async () => (await call("/status", unsupported)).status === "errored");
  assert.deepEqual(await call("/stats", unsupported), []);
  checks.push("unsupported_subject_fails_without_sql_or_fake_completion");
  const mismatch = reference("mismatch"); await call("/create", mismatch);
  await until(async () => (await call("/stats", mismatch) as Log).filter((row) => row.kind === "close").length === 1);
  await call("/scope-mismatch", mismatch);
  await until(async () => (await call("/status", mismatch)).status === "errored");
  assert.equal((await call("/stats", mismatch) as Log).filter((row) => row.kind === "query").length, 1);
  checks.push("cross_subject_wake_rejected_before_next_sql_command");
  }
  const owner = await database.user.create({ data: { clerkId: `workflow-progress-gate:${randomUUID()}` } });
  const workspace = await database.workspace.create({ data: { name: "Workflow progress gate", ownerUserId: owner.id } });
  fixture = { ownerId: owner.id, workspaceId: workspace.id };
  const projectIds = Array.from({ length: loseProgressAck ? 1 : 101 }, () => randomUUID()).sort();
  await database.project.createMany({ data: projectIds.map((id) => ({ id, workspaceId: workspace.id, title: "Workflow gate", sourceMediaUrl: "r2://gate/source" })) });
  const onlineProject = projectIds.at(-1)!;
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ version: 1, actorUserId: owner.id, workspaceId: workspace.id, projectId: onlineProject, origin: "https://web.narriflow.test", audience: "https://api.narriflow.test/api/progress", authorizedAt: now, ticketExpiresAt: now + 30_000, subscriptionExpiresAt: now + 60_000, nonce: randomBytes(16).toString("hex") })).toString("base64url");
  const input = `progress1.gate.${body}`;
  const ticket = `${input}.${createHmac("sha256", progressKey).update(input).digest("base64url")}`;
  const frames: Array<{ type: string; control?: { error: string } }> = [];
  socket = new WebSocket(`ws://${worker.address}:${worker.port}/api/progress/${onlineProject}?ticket=${ticket}&sinceSeq=0`, { headers: { Origin: "https://web.narriflow.test" } });
  socket.on("message", (value) => { frames.push(JSON.parse(value.toString())); });
  await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
  await until(async () => frames.some((frame) => frame.type === "connected"));
  const revoked = await worker.fetch(loseProgressAck ? "/progress-revoke?loseAck=1" : "/progress-revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id }) });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  await until(async () => frames.some((frame) => frame.control?.error === "workspace_restricted"));
  const prefix = `pr1.${Buffer.from(workspace.id.replaceAll("-", ""), "hex").toString("base64url")}.`;
  const { continuationInstances } = await revoked.json() as { continuationInstances: string[] };
  assert.equal(continuationInstances.length, 1);
  await until(async () => {
    const status = await (await worker.fetch(`/maintenance-status?instanceId=${continuationInstances[0]}`)).json() as { status: string; error?: unknown };
    if (status.status === "errored") throw new Error(`Progress continuation failed: ${JSON.stringify(status.error)}`);
    return status.status === "complete";
  });
  const acknowledgements = await database.executionDispatch.findMany({ where: { kind: "project_progress", subjectId: { startsWith: prefix } }, select: { acknowledgedAt: true, errorCode: true } });
  assert.equal(acknowledgements.length, loseProgressAck ? 1 : 2);
  assert.ok(acknowledgements.every((row) => row.acknowledgedAt !== null), JSON.stringify(acknowledgements));
  checks.push(loseProgressAck ? "uncertain_progress_ack_registers_maintenance_retry_and_eventually_checkpoints" : "postcommit_progress_continuation_workflow_revokes_online_second_page");
  process.stdout.write(`${JSON.stringify({ runtime: "workerd-workflows", database: "isolated-direct-neon", checks, passed: checks.length })}\n`);
} finally {
  socket?.terminate();
  await worker.stop();
  if (fixture) {
    const prefix = `pr1.${Buffer.from(fixture.workspaceId.replaceAll("-", ""), "hex").toString("base64url")}.`;
    await database.executionDispatch.deleteMany({ where: { kind: "project_progress", subjectId: { startsWith: prefix } } });
    await database.workspace.delete({ where: { id: fixture.workspaceId } });
    await database.user.delete({ where: { id: fixture.ownerId } });
  }
  await database.$disconnect();
}
