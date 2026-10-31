import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

const connection = process.env.SERVERLESS_TEST_DATABASE_URL, schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA;
assert(connection && schema && /^serverless_execution_test_[a-z0-9_]+$/.test(schema));
const url = new URL(connection);
assert(["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "55432" && url.pathname.startsWith("/narriflow_serverless_gates_"));
const delivery = JSON.parse(process.env.RESTORE_BOUNDARY_GATE_DELIVERY ?? "{}");
const worker = await unstable_dev(fileURLToPath(new URL("./gates/restore-boundary-probe.ts", import.meta.url)), {
  config: fileURLToPath(new URL("./gates/wrangler.restore-boundary-probe.jsonc", import.meta.url)),
  local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, persist: false, logLevel: "error",
  vars: { ADMISSION_STATE: "fenced", GATE_DATABASE_URL: connection, GATE_DATABASE_SCHEMA: schema },
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
});
try {
  const response = await worker.fetch("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(delivery) });
  assert.equal(response.status, 200);
  const confirmation = await response.json() as { status: string; destinationId: string };
  assert.equal(confirmation.destinationId, delivery.instanceId);
  assert(["confirmed_created", "confirmed_existing"].includes(confirmation.status));
  const end = Date.now() + 30_000; let status = "";
  while (Date.now() < end) {
    const value = await (await worker.fetch(`/status?id=${delivery.instanceId}`)).json() as { status: string; error?: unknown };
    status = value.status;
    if (status === "complete" || status === "errored") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(status, "complete");
  console.log(JSON.stringify({ ...confirmation, metadataWorkflowCompleted: true }));
} finally { await worker.stop(); }
