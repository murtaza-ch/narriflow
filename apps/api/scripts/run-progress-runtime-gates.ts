import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { unstable_dev } from "wrangler";

const key = randomBytes(32);
const worker = await unstable_dev(fileURLToPath(new URL("./gates/progress-runtime-probe.ts", import.meta.url)), {
  config: fileURLToPath(new URL("./gates/wrangler.progress-runtime-probe.jsonc", import.meta.url)),
  local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, persist: false, logLevel: "error",
  vars: { API_ORIGIN: "https://api.narriflow.test", PROGRESS_CONNECT_KEY_ID: "gate", PROGRESS_CONNECT_KEYS_JSON: JSON.stringify({ gate: key.toString("base64url") }) },
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
});
const origin = "https://web.narriflow.test";
const workspaceId = "gate-workspace";
const actorUserId = "gate-actor";
const checks: string[] = [];
const sockets: WebSocket[] = [];
type Frame = { type: string; cursor?: number; event?: { seq: number }; control?: { error: string } };
function ticket(projectId: string, over: Record<string, unknown> = {}) {
  const authorizedAt = Date.now();
  const body = Buffer.from(JSON.stringify({ version: 1, actorUserId, workspaceId, projectId, origin, audience: "https://api.narriflow.test/api/progress", authorizedAt, ticketExpiresAt: authorizedAt + 30_000, subscriptionExpiresAt: authorizedAt + 60_000, nonce: randomBytes(16).toString("hex"), ...over })).toString("base64url");
  const input = `progress1.gate.${body}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}
function event(projectId: string, seq: number) { return { event: "workflow.stage.updated", projectId, workflowRunId: "60000000-0000-4000-8000-000000000001", seq, stage: "clip_rendering", status: "running", progress: 10, errorCode: null, emittedAt: "2026-10-31T00:00:00.000Z" }; }
async function control(path: string, input: unknown) {
  const response = await worker.fetch(`/control/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(response.status, 200, await response.text());
}
function connect(projectId: string, signed = ticket(projectId), extra: { origin?: string; sinceSeq?: number } = {}) {
  const socket = new WebSocket(`ws://${worker.address}:${worker.port}/api/progress/${projectId}?ticket=${encodeURIComponent(signed)}&sinceSeq=${extra.sinceSeq ?? 0}`, { headers: { Origin: extra.origin ?? origin } });
  sockets.push(socket);
  const frames: Frame[] = [];
  let ended = false;
  socket.on("message", (value) => { if (value.toString() !== "pong") frames.push(JSON.parse(value.toString())); });
  socket.on("close", () => { ended = true; });
  const opened = new Promise<number>((resolve, reject) => {
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); socket.terminate(); });
    socket.once("error", (error) => { if (!ended) reject(error); });
  });
  async function until(predicate: () => boolean, timeout = 3_000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Socket expectation timed out ready=${socket.readyState}: ${JSON.stringify(frames)}`); await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  return { socket, frames, opened, until, get closing() { return ended || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED; } };
}
try {
  const project = randomUUID();
  assert.equal(await connect(project, "bad").opened, 401);
  assert.equal(await connect(project, ticket(project), { origin: "https://wrong.test" }).opened, 403);
  assert.equal(await connect(randomUUID(), ticket(project)).opened, 403);
  assert.equal(await connect(project, ticket(project, { audience: "https://wrong.test/api/progress" })).opened, 401);
  checks.push("ticket_origin_audience_and_project_scope");
  await control(`replay/${project}`, { highWater: 2, events: [event(project, 1), event(project, 2)], reset: false, delayMs: 250 });
  const signed = ticket(project);
  const live = connect(project, signed);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await control(`publish/${project}`, { scope: { projectId: project, workspaceId }, event: event(project, 3) });
  assert.equal(await live.opened, 101);
  await live.until(() => live.frames.some((frame) => frame.type === "connected"));
  assert.deepEqual(live.frames.filter((frame) => frame.type === "event").map((frame) => frame.event?.seq), [1, 2, 3]);
  checks.push("subscribe_before_replay_merges_live_tail");
  assert.equal(await connect(project, signed).opened, 409);
  checks.push("connect_nonce_one_use");
  await control(`publish/${project}`, { scope: { projectId: project, workspaceId }, event: event(project, 3) });
  const reads = await (await worker.fetch("/control/stats")).json();
  const pong = new Promise((resolve) => live.socket.once("message", (value) => resolve(value.toString())));
  live.socket.send("ping");
  assert.equal(await pong, "pong");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(await (await worker.fetch("/control/stats")).json(), reads);
  assert.equal(live.frames.filter((frame) => frame.type === "event").length, 3);
  checks.push("hibernation_auto_ping_zero_replay_and_deduplication");
  await control(`publish/${project}`, { scope: { projectId: project, workspaceId }, event: event(project, 5) });
  await live.until(() => live.closing);
  assert.ok(live.frames.some((frame) => frame.type === "resync"));
  await control(`replay/${project}`, { highWater: 5, events: [event(project, 4), event(project, 5)], reset: false });
  const caughtUp = connect(project, ticket(project), { sinceSeq: 3 });
  assert.equal(await caughtUp.opened, 101);
  await caughtUp.until(() => caughtUp.frames.some((frame) => frame.type === "connected"));
  assert.deepEqual(caughtUp.frames.filter((frame) => frame.type === "event").map((frame) => frame.event?.seq), [4, 5]);
  checks.push("gap_reconnect_resumes_last_applied_cursor");
  const cutoff = Date.now();
  const stale = ticket(project, { authorizedAt: cutoff - 1, ticketExpiresAt: cutoff + 5_000, subscriptionExpiresAt: cutoff + 10_000 });
  await control(`revoke/${project}`, { projectId: project, workspaceId, actorUserId, authorizedBefore: cutoff, error: "workspace_membership_required" });
  await caughtUp.until(() => caughtUp.closing);
  assert.ok(caughtUp.frames.some((frame) => frame.control?.error === "workspace_membership_required"));
  assert.equal(await connect(project, stale).opened, 403);
  checks.push("membership_push_and_stale_ticket_cutoff");
  for (const error of ["workspace_restricted", "project_inaccessible"]) {
    const id = randomUUID();
    const socket = connect(id);
    assert.equal(await socket.opened, 101);
    await socket.until(() => socket.frames.some((frame) => frame.type === "connected"));
    await control(`revoke/${id}`, { projectId: id, workspaceId, authorizedBefore: Date.now(), error });
    await socket.until(() => socket.closing);
    assert.ok(socket.frames.some((frame) => frame.control?.error === error));
  }
  checks.push("restriction_and_deletion_push");
  const expiringProject = randomUUID();
  const authorizedAt = Date.now();
  const expiring = connect(expiringProject, ticket(expiringProject, { authorizedAt, ticketExpiresAt: authorizedAt + 750, subscriptionExpiresAt: authorizedAt + 750 }));
  assert.equal(await expiring.opened, 101);
  await expiring.until(() => expiring.closing);
  assert.ok(expiring.frames.some((frame) => frame.control?.error === "authentication_required"));
  checks.push("earliest_expiry_alarm_closes_idle_socket");
  const resetProject = randomUUID();
  await control(`replay/${resetProject}`, { highWater: 99, events: [], reset: true });
  const reset = connect(resetProject);
  assert.equal(await reset.opened, 101);
  await reset.until(() => reset.frames.some((frame) => frame.type === "connected"));
  assert.ok(reset.frames.some((frame) => frame.type === "reset" && frame.cursor === 99));
  checks.push("retention_reset_to_snapshot");
  process.stdout.write(`${JSON.stringify({ runtime: "workerd", checks, passed: checks.length })}\n`);
} finally { for (const socket of sockets) socket.terminate(); await worker.stop(); }
